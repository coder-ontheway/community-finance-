// 驗收測試：權限、共同瀏覽密碼、匯入核對、備份還原
// 針對「真實」的 Postgres + PostgREST + GoTrue（與 Supabase 相同元件）執行，不使用模擬。
// 需要環境變數：SUPABASE_URL ANON_KEY JWT_SECRET ADMIN_EMAIL ADMIN_PASSWORD OTHER_EMAIL OTHER_PASSWORD IMPORT_JSON
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.ANON_KEY;
const { ADMIN_EMAIL, ADMIN_PASSWORD, OTHER_EMAIL, OTHER_PASSWORD } = process.env;
const importData = JSON.parse(fs.readFileSync(process.env.IMPORT_JSON, 'utf8'));
// 驗收數字一律取自匯入檔（報表印出的數字），儲存庫中不寫入任何真實財務資料
const FIG = Object.fromEntries(importData.rows.filter((r) => !['detail', 'group_subtotal', 'ignore'].includes(r.row_type)).map((r) => [r.row_type, r.amount]));
const DETAIL_COUNT = importData.rows.filter((r) => r.row_type === 'detail').length;
const SUB_COUNT = importData.rows.filter((r) => r.row_type === 'group_subtotal').length;
const FIG_COUNT = Object.keys(FIG).length;
const RY = importData.report.roc_year, RM = importData.report.month;

const client = (headers = {}) => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers } });
const viewer = (token, ip = '10.0.0.1') => client({ 'x-viewer-token': token, 'x-test-client-ip': ip });
async function login(email, password) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email, password });
  assert.equal(error, null, `登入失敗：${error?.message}`);
  return c;
}
function craftedJwt(payload) {
  const b = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const h = b({ alg: 'HS256', typ: 'JWT' }), p = b(payload);
  return `${h}.${p}.${crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
const FIN_TABLES = ['reports', 'transactions', 'report_subtotals', 'vendors', 'accounts', 'analysis_categories', 'repair_categories',
  'repair_items', 'transaction_repair_links', 'app_settings'];
const ADMIN_ONLY_TABLES = ['audit_log', 'import_batches', 'import_rows', 'vendor_aliases', 'account_mappings', 'report_files', 'app_admins'];

let admin, other, reportId, batchId;
const PW1 = 'Neighbor-Pass-2026';
const PW2 = 'New-Neighbor-Pass-2026!';
let tokenOld;

test('01 沒有密碼的訪客讀不到任何財務資料', async () => {
  const anon = client();
  for (const t of [...FIN_TABLES, ...ADMIN_ONLY_TABLES]) {
    const { data, error } = await anon.from(t).select(t === 'transaction_repair_links' ? 'transaction_id' : 'id').limit(5);
    assert.ok(error || data.length === 0, `${t} 不應回傳資料`);
  }
  const { data } = await anon.rpc('site_info');
  assert.equal(data.viewer_ok, false);
  assert.equal(data.is_admin, false);
});

test('02 尚未設定密碼時，鄰居無法登入', async () => {
  const { data } = await client().rpc('viewer_login', { p_password: 'anything' });
  assert.deepEqual(data, { ok: false, error: 'not_configured' });
});

test('03 管理者登入，非管理者帳號無任何權限', async () => {
  admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const { data: info } = await admin.rpc('site_info');
  assert.equal(info.is_admin, true);
  other = await login(OTHER_EMAIL, OTHER_PASSWORD);
  const { data: info2 } = await other.rpc('site_info');
  assert.equal(info2.is_admin, false);
  const ins = await other.from('reports').insert({ roc_year: 115, month: 1 }).select();
  assert.ok(ins.error, '非管理者帳號不應能新增報表');
  const set = await other.rpc('admin_set_viewer_password', { p_new: 'hacker-pass-1', p_confirm: 'hacker-pass-1' });
  assert.ok(set.error && /權限不足/.test(set.error.message), '非管理者不應能設定瀏覽密碼');
});

test('04 管理者超過 5 分鐘未重新驗證，不能更改瀏覽密碼', async () => {
  const { data: { user } } = await admin.auth.getUser();
  const now = Math.floor(Date.now() / 1000);
  const old = craftedJwt({ sub: user.id, role: 'authenticated', aud: 'authenticated', aal: 'aal1', exp: now + 600,
    amr: [{ method: 'password', timestamp: now - 3600 }] });
  const c = createClient(URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${old}` } } });
  const { data } = await c.rpc('admin_set_viewer_password', { p_new: PW1, p_confirm: PW1 });
  assert.equal(data.ok, false);
  assert.equal(data.error, 'reauth_required');
});

test('05 管理者設定共同瀏覽密碼（含確認密碼與長度檢查）', async () => {
  let r = await admin.rpc('admin_set_viewer_password', { p_new: PW1, p_confirm: PW1 + 'x' });
  assert.equal(r.data.error, 'mismatch');
  r = await admin.rpc('admin_set_viewer_password', { p_new: 'short', p_confirm: 'short' });
  assert.equal(r.data.error, 'too_short');
  r = await admin.rpc('admin_set_viewer_password', { p_new: PW1, p_confirm: PW1 });
  assert.equal(r.data.ok, true, JSON.stringify(r));
});

test('06 密碼不會以明文或雜湊形式出現在任何 API', async () => {
  const c = viewer('x');
  for (const t of ['viewer_secret', 'viewer_sessions']) {
    const { error } = await c.from(t).select('*');
    assert.ok(error, `${t} 不應能透過 API 讀取`);
  }
  const { data } = await admin.rpc('admin_viewer_status');
  assert.equal(JSON.stringify(data).includes(PW1), false);
  assert.equal('password_hash' in data, false);
});

test('07 管理者匯入月報表：未核對資料不能寫入正式資料', async () => {
  const { data: rep, error } = await admin.from('reports').insert({ roc_year: RY, month: RM, title: importData.report.title, period_text: importData.report.period_text }).select().single();
  assert.equal(error, null);
  reportId = rep.id;
  const dup = await admin.from('reports').insert({ roc_year: RY, month: RM }).select();
  assert.ok(dup.error, '同年月報表不能重複建立');
  // 分類（依名稱對應）
  const { data: cats } = await admin.from('analysis_categories').select('id,side,name');
  const { data: rcats } = await admin.from('repair_categories').select('id,name');
  const { data: b } = await admin.from('import_batches').insert({ report_id: reportId, method: 'json', source_label: importData.source }).select().single();
  batchId = b.id;
  const rows = importData.rows.map((r, i) => ({
    batch_id: batchId, row_no: i + 1, row_type: r.row_type, side: r.side, original_group: r.original_group ?? null,
    original_account_name: r.original_account_name, original_summary: r.original_summary, amount_raw: r.amount_raw, amount: r.amount,
    counterparty_raw: r.counterparty_raw ?? null, payer_status: r.payer_status || 'not_applicable',
    analysis_category_id: cats.find((c) => c.side === r.side && c.name === r.analysis_category_name)?.id ?? null,
    is_repair: r.is_repair ?? null, repair_category_id: rcats.find((c) => c.name === r.repair_category_name)?.id ?? null,
    is_public: r.is_public !== false, ocr_status: r.ocr_status, uncertain_fields: r.uncertain_fields, note: r.note ?? null,
  }));
  const ins = await admin.from('import_rows').insert(rows);
  assert.equal(ins.error, null, ins.error?.message);
  // 暫存資料不出現在正式交易
  const { count } = await admin.from('transactions').select('id', { count: 'exact', head: true });
  assert.equal(count, 0);
  const c = await admin.rpc('commit_import_batch', { p_batch_id: batchId });
  assert.ok(c.error && /尚未核對/.test(c.error.message), '未核對不應能寫入');
});

test('08 逐筆核對後寫入，加總與報表四項驗收數字一致', async () => {
  const { data: pc } = await admin.rpc('import_precheck', { p_batch_id: batchId });
  assert.equal(Number(pc.detail_income), FIG.income_total);
  assert.equal(Number(pc.detail_expense), FIG.expense_total);
  await admin.from('import_rows').update({ review_status: 'verified' }).eq('batch_id', batchId);
  const c = await admin.rpc('commit_import_batch', { p_batch_id: batchId });
  assert.equal(c.error, null, c.error?.message);
  assert.equal(c.data.transactions, DETAIL_COUNT);
  assert.equal(c.data.subtotals, SUB_COUNT);
  assert.equal(c.data.figures, FIG_COUNT);
  const { data: r } = await admin.from('reports').select('*').eq('id', reportId).single();
  const { data: tx } = await admin.from('transactions').select('side,amount,original_group').eq('report_id', reportId);
  const sum = (side) => tx.filter((t) => t.side === side).reduce((a, t) => a + Math.round(Number(t.amount) * 100), 0) / 100;
  assert.equal(sum('income'), FIG.income_total); assert.equal(Number(r.reported_income_total), FIG.income_total);
  assert.equal(sum('expense'), FIG.expense_total); assert.equal(Number(r.reported_expense_total), FIG.expense_total);
  assert.equal(sum('income') - sum('expense'), FIG.period_balance); assert.equal(Number(r.reported_period_balance), FIG.period_balance);
  assert.equal(Number(r.reported_prior_balance) + sum('income') - sum('expense'), FIG.cumulative_balance); assert.equal(Number(r.reported_cumulative_balance), FIG.cumulative_balance);
  if (importData.rows.some((x) => x.row_type === 'prior_balance' && x.uncertain_fields?.length)) assert.match(r.reported_figures_note, /前期餘絀：待人工核對/);
  const { data: subs } = await admin.from('report_subtotals').select('*').eq('report_id', reportId);
  for (const s of subs) {
    const sys = tx.filter((t) => t.side === s.side && t.original_group === s.original_group).reduce((a, t) => a + Number(t.amount), 0);
    assert.equal(sys, Number(s.reported_amount), s.label);
  }
});

test('09 同一份報表重複匯入會被擋下', async () => {
  const { data: b2 } = await admin.from('import_batches').insert({ report_id: reportId, method: 'json' }).select().single();
  const first = importData.rows.find((r) => r.row_type === 'detail');
  await admin.from('import_rows').insert({ batch_id: b2.id, row_no: 1, row_type: 'detail', side: first.side, original_account_name: first.original_account_name, original_summary: first.original_summary, amount: first.amount, review_status: 'verified' });
  const c = await admin.rpc('commit_import_batch', { p_batch_id: b2.id });
  assert.ok(c.error && /DUPLICATE_IMPORT/.test(c.error.message));
  const { data: pc } = await admin.rpc('import_precheck', { p_batch_id: b2.id });
  assert.equal(pc.possible_duplicates.length, 1);
  await admin.from('import_batches').update({ status: 'discarded' }).eq('id', b2.id);
});

test('10 原始科目與摘要不可直接覆蓋；更正需填理由並留紀錄', async () => {
  const { data: t } = await admin.from('transactions').select('id,original_account_name,original_summary').eq('report_id', reportId).eq('side', 'expense').order('id', { ascending: false }).limit(1).single();
  const u = await admin.from('transactions').update({ original_summary: '改掉' }).eq('id', t.id);
  assert.ok(u.error && /不可直接修改/.test(u.error.message));
  const noReason = await admin.rpc('admin_correct_original', { p_transaction_id: t.id, p_original_account_name: t.original_account_name, p_original_summary: t.original_summary, p_reason: '' });
  assert.ok(noReason.error);
  const { data: logs } = await admin.from('audit_log').select('action').eq('table_name', 'transactions').eq('row_pk', String(t.id));
  assert.ok(logs.some((l) => l.action === 'INSERT'));
});

test('11 鄰居：錯誤密碼無法取得憑證，也看不到資料', async () => {
  const { data } = await client({ 'x-test-client-ip': '10.0.0.2' }).rpc('viewer_login', { p_password: 'wrong-password' });
  assert.equal(data.ok, false); assert.equal(data.error, 'invalid'); assert.equal(data.token, undefined);
  const fake = viewer('0'.repeat(64), '10.0.0.2');
  const { data: rows } = await fake.from('transactions').select('id');
  assert.equal(rows.length, 0);
});

test('12 鄰居：正確密碼可登入，但未公開的報表看不到', async () => {
  const { data } = await client({ 'x-test-client-ip': '10.0.0.3' }).rpc('viewer_login', { p_password: PW1 });
  assert.equal(data.ok, true);
  tokenOld = data.token;
  const v = viewer(tokenOld, '10.0.0.3');
  const { data: info } = await v.rpc('site_info');
  assert.equal(info.viewer_ok, true);
  const { data: reps } = await v.from('reports').select('id');
  assert.equal(reps.length, 0, '未公開報表不應顯示');
});

test('13 有未核對明細的報表不能公開', async () => {
  const { data: t } = await admin.from('transactions').select('id').eq('report_id', reportId).limit(1).single();
  await admin.from('transactions').update({ review_status: 'pending' }).eq('id', t.id);
  const p = await admin.from('reports').update({ is_published: true }).eq('id', reportId);
  assert.ok(p.error && /未核對/.test(p.error.message));
  await admin.from('transactions').update({ review_status: 'verified' }).eq('id', t.id);
});

test('14 公開後，鄰居看得到公開明細；不公開明細只看到彙總，且總額正確', async () => {
  const { data: t } = await admin.from('transactions').select('id,amount').eq('report_id', reportId).eq('side', 'expense').eq('is_public', true).order('id').limit(1).single();
  const alreadyHidden = importData.rows.filter((r) => r.row_type === 'detail' && r.is_public === false).length;
  await admin.from('transactions').update({ is_public: false, admin_note: '私人備註：測試' }).eq('id', t.id);
  const p = await admin.from('reports').update({ is_published: true }).eq('id', reportId);
  assert.equal(p.error, null, p.error?.message);
  const v = viewer(tokenOld, '10.0.0.3');
  const { data: rows, error } = await v.from('transactions').select('id,side,amount');
  assert.equal(error, null);
  assert.equal(rows.length, DETAIL_COUNT - alreadyHidden - 1);
  const { data: hidden } = await v.rpc('hidden_transaction_aggregates');
  const hiddenExp = hidden.filter((h) => h.side === 'expense').reduce((a, h) => a + Number(h.amount), 0);
  assert.ok(hidden.length >= 1); assert.ok(hiddenExp >= Number(t.amount));
  const exp = rows.filter((r) => r.side === 'expense').reduce((a, r) => a + Number(r.amount), 0) + hiddenExp;
  assert.equal(exp, FIG.expense_total);
  // 私人欄位無法讀取
  const priv = await v.from('transactions').select('admin_note').limit(1);
  assert.ok(priv.error, 'admin_note 不應能被鄰居讀取');
  const priv2 = await v.from('reports').select('admin_note,bank_balance_note');
  assert.ok(priv2.error);
  for (const tname of ADMIN_ONLY_TABLES) {
    const { data, error: e } = await v.from(tname).select('*').limit(1);
    assert.ok(e || data.length === 0, `鄰居不應讀到 ${tname}`);
  }
});

test('15 鄰居無法透過 API 新增、修改、刪除任何資料', async () => {
  const v = viewer(tokenOld, '10.0.0.3');
  const { data: one } = await v.from('transactions').select('id,amount').limit(1).single();
  const ins = await v.from('transactions').insert({ report_id: reportId, roc_year: 115, month: 9, side: 'income', original_account_name: 'x', amount: 1 });
  assert.ok(ins.error, '鄰居不應能新增');
  const upd = await v.from('transactions').update({ amount: 1 }).eq('id', one.id).select();
  assert.ok(upd.error || upd.data.length === 0, '鄰居不應能修改');
  const del = await v.from('transactions').delete().eq('id', one.id).select();
  assert.ok(del.error || del.data.length === 0, '鄰居不應能刪除');
  const rep = await v.from('reports').update({ is_published: false }).eq('id', reportId).select();
  assert.ok(rep.error || rep.data.length === 0);
  for (const t of ['vendors', 'accounts', 'analysis_categories', 'app_settings', 'audit_log', 'import_rows']) {
    const r = await v.from(t).insert({}).select();
    assert.ok(r.error, `鄰居不應能寫入 ${t}`);
  }
  const { data: after } = await admin.from('transactions').select('amount').eq('id', one.id).single();
  assert.equal(Number(after.amount), Number(one.amount), '金額不應被改變');
  // 管理功能 RPC
  for (const [fn, args] of [['admin_set_viewer_password', { p_new: 'aaaaaaaa1', p_confirm: 'aaaaaaaa1' }], ['admin_viewer_status', {}],
    ['commit_import_batch', { p_batch_id: batchId }], ['merge_vendors', { p_from: 1, p_into: 2 }], ['restore_backup', { p_backup: {}, p_mode: 'overwrite', p_confirm: '確認覆蓋' }],
    ['admin_revoke_viewer_sessions', {}], ['admin_correct_original', { p_transaction_id: one.id, p_original_account_name: 'x', p_original_summary: 'x', p_reason: 'x' }]]) {
    const r = await v.rpc(fn, args);
    assert.ok(r.error, `鄰居不應能呼叫 ${fn}`);
  }
  // 偽造 JWT 宣稱自己是管理者（沒有簽章金鑰）
  const forged = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.xxxx`;
  const f = createClient(URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${forged}` } } });
  const fr = await f.from('transactions').select('id').limit(1);
  assert.ok(fr.error, '偽造的 JWT 應被拒絕');
});

test('16 鄰居無法讀取或上傳報表原始檔案', async () => {
  const blob = new Blob([Buffer.from('fake image')], { type: 'image/png' });
  const up = await admin.storage.from('report-files').upload('115-09/test.png', blob, { contentType: 'image/png' });
  assert.equal(up.error, null, up.error?.message);
  const v = viewer(tokenOld, '10.0.0.3');
  const d = await v.storage.from('report-files').download('115-09/test.png');
  assert.ok(d.error, '鄰居不應能下載原始報表檔');
  const u = await v.storage.from('report-files').upload('115-09/evil.png', blob);
  assert.ok(u.error, '鄰居不應能上傳');
  const ad = await admin.storage.from('report-files').download('115-09/test.png');
  assert.equal(ad.error, null);
});

test('17 錯誤密碼重複嘗試會被暫停（同一來源 5 次）', async () => {
  const ip = '10.9.9.9';
  for (let i = 0; i < 5; i++) {
    const { data } = await client({ 'x-test-client-ip': ip }).rpc('viewer_login', { p_password: 'guess-' + i });
    assert.equal(data.error, 'invalid');
  }
  const { data } = await client({ 'x-test-client-ip': ip }).rpc('viewer_login', { p_password: PW1 });
  assert.equal(data.error, 'locked', '暫停期間即使密碼正確也不能登入');
  const { data: other } = await client({ 'x-test-client-ip': '10.9.9.10' }).rpc('viewer_login', { p_password: PW1 });
  assert.equal(other.ok, true, '其他來源不受影響');
});

test('18 管理者更改密碼後：舊密碼不能登入、舊工作階段立即失效、新密碼可用', async () => {
  // 重新驗證管理者身分（重新登入取得新的驗證時間）
  admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const r = await admin.rpc('admin_set_viewer_password', { p_new: PW2, p_confirm: PW2 });
  assert.equal(r.data.ok, true);
  const v = viewer(tokenOld, '10.0.0.3');
  const { data: info } = await v.rpc('site_info');
  assert.equal(info.viewer_ok, false, '舊憑證應立即失效');
  const { data: rows } = await v.from('transactions').select('id');
  assert.equal(rows.length, 0, '舊憑證不應再讀到資料');
  const { data: oldLogin } = await client({ 'x-test-client-ip': '10.0.0.4' }).rpc('viewer_login', { p_password: PW1 });
  assert.equal(oldLogin.ok, false, '舊密碼不能登入');
  const { data: newLogin } = await client({ 'x-test-client-ip': '10.0.0.4' }).rpc('viewer_login', { p_password: PW2 });
  assert.equal(newLogin.ok, true);
  const { data: rows2 } = await viewer(newLogin.token, '10.0.0.4').from('transactions').select('id');
  assert.equal(rows2.length, DETAIL_COUNT - importData.rows.filter((r) => r.row_type === 'detail' && r.is_public === false).length - 1);
  const { data: logs } = await admin.from('audit_log').select('action,new_data').eq('table_name', 'viewer_password');
  assert.equal(logs.length, 2);
  assert.equal(JSON.stringify(logs).includes(PW2), false, '稽核紀錄不可含密碼');
});

test('19 廠商別名需管理者確認才歸戶，不自動合併相似名稱', async () => {
  const { data: tx } = await admin.from('transactions').select('id,vendor_id,counterparty_raw').not('counterparty_raw', 'is', null);
  assert.ok(tx.length > 0);
  assert.ok(tx.every((t) => t.vendor_id === null), '匯入時不應自動歸戶');
  const { data: al } = await admin.from('vendor_aliases').select('*');
  assert.ok(al.some((a) => a.alias_name === '西北') && al.some((a) => a.alias_name === '西北保全'));
  assert.ok(al.every((a) => a.status === 'pending'));
  const { data: v } = await admin.from('vendors').insert({ canonical_name: '西北' }).select().single();
  const a = al.find((x) => x.alias_name === '西北');
  const { data: res } = await admin.rpc('confirm_vendor_alias', { p_alias_id: a.id, p_vendor_id: v.id });
  assert.equal(res.transactions_updated, 1);
  const { data: t2 } = await admin.from('transactions').select('vendor_id').eq('counterparty_raw', '西北保全').single();
  assert.equal(t2.vendor_id, null, '相似名稱「西北保全」不應被自動歸到「西北」');
});

test('20 JSON 備份還原：需輸入確認字樣；預設不覆蓋既有資料', async () => {
  const tables = {};
  for (const t of ['app_settings', 'analysis_categories', 'repair_categories', 'accounts', 'account_mappings', 'vendors', 'vendor_aliases', 'reports',
    'report_files', 'report_subtotals', 'import_batches', 'transactions', 'import_rows', 'repair_items', 'transaction_repair_links']) {
    const { data } = await admin.from(t).select('*');
    tables[t] = data;
  }
  const backup = { format: 'community-finance-backup', version: 1, tables };
  const bad = await admin.rpc('restore_backup', { p_backup: backup, p_mode: 'insert_missing', p_confirm: '好' });
  assert.ok(bad.error, '確認字樣錯誤時不應還原');
  // 刪掉一筆（模擬誤刪），並修改一筆金額
  const incs = tables.transactions.filter((t) => t.side === 'income');
  const victim = incs[incs.length - 1];
  const changed = incs.find((t) => Number(t.amount) !== 1 && t.id !== victim.id);
  await admin.from('transactions').delete().eq('id', victim.id);
  await admin.from('reports').update({ is_published: false }).eq('id', reportId);
  await admin.from('transactions').update({ amount: 1 }).eq('id', changed.id);
  const { data: r1, error: e1 } = await admin.rpc('restore_backup', { p_backup: backup, p_mode: 'insert_missing', p_confirm: '確認還原' });
  assert.equal(e1, null, e1?.message);
  assert.equal(r1.tables.transactions.written, 1);
  const { data: back } = await admin.from('transactions').select('id').eq('id', victim.id);
  assert.equal(back.length, 1, '誤刪的資料應被還原');
  const { data: still } = await admin.from('transactions').select('amount').eq('id', changed.id).single();
  assert.equal(Number(still.amount), 1, '預設模式不應覆蓋現有資料');
  const { error: e2 } = await admin.rpc('restore_backup', { p_backup: backup, p_mode: 'overwrite', p_confirm: '確認覆蓋' });
  assert.equal(e2, null, e2?.message);
  const { data: fixed } = await admin.from('transactions').select('amount').eq('id', changed.id).single();
  assert.equal(Number(fixed.amount), Number(changed.amount));
  // 新增資料時 ID 序號不衝突
  const { error: e3 } = await admin.from('analysis_categories').insert({ side: 'expense', name: '還原後新增測試' });
  assert.equal(e3, null, e3?.message);
  await admin.from('analysis_categories').delete().eq('name', '還原後新增測試');
  const p = await admin.from('reports').update({ is_published: true }).eq('id', reportId);
  assert.equal(p.error, null, p.error?.message);
});

test('21 所有修改都有稽核紀錄，鄰居與非管理者讀不到', async () => {
  const { count } = await admin.from('audit_log').select('id', { count: 'exact', head: true });
  assert.ok(count > 50);
  const { data } = await other.from('audit_log').select('id').limit(1);
  assert.equal(data.length, 0);
});
