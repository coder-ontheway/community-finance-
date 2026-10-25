// 本機測試用閘道：模擬 Supabase 的 API 入口（/rest/v1、/auth/v1、/storage/v1），並提供靜態網站。
// 僅供開發與驗收測試，正式環境由 supabase.com 提供這些服務。
// 用法：JWT_SECRET=... DATABASE_URL=... node gateway.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const SECRET = process.env.JWT_SECRET;
const WEB_ROOT = process.env.WEB_ROOT;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const b64u = (b) => Buffer.from(b).toString('base64url');
export function signJwt(payload) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
function verifyJwt(tok) {
  const [h, p, s] = String(tok || '').split('.');
  if (!s) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  if (exp.length !== s.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(s))) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (claims.exp && claims.exp < Date.now() / 1000) return null;
  return claims;
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, X-Total-Count');
}

function proxy(req, res, port, prefix, clientIp) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}`, 'x-forwarded-for': clientIp };
  delete headers['x-test-client-ip'];
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url.slice(prefix.length) || '/', headers }, (r) => {
    const h = { ...r.headers };
    delete h['access-control-allow-origin'];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}

const readBody = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });

async function asRole(claims, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const role = ['anon', 'authenticated', 'service_role'].includes(claims.role) ? claims.role : 'anon';
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await fn(client);
    await client.query('commit');
    return r;
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
}

async function storage(req, res, url) {
  const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  const m = url.pathname.match(/^\/storage\/v1\/object\/(sign\/|authenticated\/|public\/)?([^/]+)\/?(.*)$/);
  if (!m) return send(404, { error: 'not found' });
  const [, kind, bucket, rawName] = m;
  const name = decodeURIComponent(rawName);
  try {
    if (kind === 'sign/' && req.method === 'GET') {
      const t = verifyJwt(url.searchParams.get('token'));
      if (!t || t.url !== `${bucket}/${name}`) return send(400, { error: 'invalid signature' });
      const r = await pool.query('select data, metadata from storage.objects where bucket_id=$1 and name=$2', [bucket, name]);
      if (!r.rows.length) return send(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': r.rows[0].metadata?.mimetype || 'application/octet-stream' });
      return res.end(r.rows[0].data);
    }
    const claims = verifyJwt(auth);
    if (!claims) return send(401, { error: 'invalid jwt' });
    if (kind === 'sign/' && req.method === 'POST') {
      const ok = await asRole(claims, (c) => c.query('select 1 from storage.objects where bucket_id=$1 and name=$2', [bucket, name]));
      if (!ok.rows.length) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const tok = signJwt({ url: `${bucket}/${name}`, exp: Math.floor(Date.now() / 1000) + (body.expiresIn || 60) });
      return send(200, { signedURL: `/object/sign/${bucket}/${rawName}?token=${tok}` });
    }
    if ((kind === 'authenticated/' || !kind) && req.method === 'GET') {
      const r = await asRole(claims, (c) => c.query('select data, metadata from storage.objects where bucket_id=$1 and name=$2', [bucket, name]));
      if (!r.rows.length) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      res.writeHead(200, { 'content-type': r.rows[0].metadata?.mimetype || 'application/octet-stream' });
      return res.end(r.rows[0].data);
    }
    if (!kind && req.method === 'POST') {
      let data = await readBody(req);
      let mime = req.headers['content-type'] || 'application/octet-stream';
      if (mime.startsWith('multipart/form-data')) {
        const boundary = '--' + mime.split('boundary=')[1];
        const parts = data.toString('latin1').split(boundary);
        const filePart = parts.find((p) => /filename=/.test(p)) || parts.find((p) => /name=""/.test(p)) || parts[1];
        const idx = filePart.indexOf('\r\n\r\n');
        const head = filePart.slice(0, idx);
        mime = (head.match(/Content-Type: (.*)/i) || [])[1]?.trim() || 'application/octet-stream';
        data = Buffer.from(filePart.slice(idx + 4, filePart.length - 2), 'latin1');
      }
      const r = await asRole(claims, (c) => c.query('insert into storage.objects (bucket_id, name, owner, metadata, data) values ($1,$2,$3,$4,$5) returning id',
        [bucket, name, claims.sub || null, { mimetype: mime, size: data.length }, data]));
      return send(200, { Key: `${bucket}/${name}`, Id: r.rows[0].id });
    }
    if (req.method === 'DELETE') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const r = await asRole(claims, (c) => c.query('delete from storage.objects where bucket_id=$1 and name = any($2) returning name', [bucket, body.prefixes || [name]]));
      return send(200, r.rows);
    }
    return send(405, { error: 'method not allowed' });
  } catch (e) {
    return send(400, { statusCode: '403', error: 'Unauthorized', message: e.message });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serveStatic(req, res) {
  const u = new URL(req.url, 'http://x');
  let p = path.normalize(path.join(WEB_ROOT, decodeURIComponent(u.pathname)));
  if (!p.startsWith(WEB_ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const clientIp = req.headers['x-test-client-ip'] || req.socket.remoteAddress;
  if (!req.headers.apikey && !url.searchParams.get('apikey') && !url.pathname.startsWith('/storage/v1/object/sign/')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'No API key found in request' }));
  }
  if (url.pathname.startsWith('/rest/v1')) return proxy(req, res, 3000, '/rest/v1', clientIp);
  if (url.pathname.startsWith('/auth/v1')) return proxy(req, res, 9999, '/auth/v1', clientIp);
  if (url.pathname.startsWith('/storage/v1')) return storage(req, res, url);
  res.writeHead(404); res.end();
}).listen(8000, '127.0.0.1', () => console.log('gateway on :8000'));

if (WEB_ROOT) http.createServer(serveStatic).listen(8080, '127.0.0.1', () => console.log('web on :8080'));
