// 主程式：登入狀態、路由、版面
import * as api from './api.js';
import { normalize } from './analytics.js';
import { esc } from './util.js';
import { $, toast, modal } from './ui.js';
import { editTxDialog } from './views/edit_tx.js';

// GitHub Pages 無法設定 X-Frame-Options 標頭：被其他網站內嵌時拒絕顯示，防止點擊劫持
if (window.top !== window.self) {
  document.body.textContent = '為了安全，本網站不能在其他網頁中內嵌顯示。';
  throw new Error('framed');
}

const routes = {
  '': () => import('./views/dashboard.js'),
  tx: () => import('./views/transactions.js'),
  reports: () => import('./views/reports.js'),
  report: () => import('./views/report_detail.js'),
  import: () => import('./views/import.js'),
  vendors: () => import('./views/vendors.js'),
  vendor: () => import('./views/vendors.js'),
  repairs: () => import('./views/repairs.js'),
  accounts: () => import('./views/accounts.js'),
  settings: () => import('./views/settings.js'),
  'viewer-password': () => import('./views/viewer_password.js'),
  export: () => import('./views/export.js'),
  audit: () => import('./views/audit.js'),
  help: () => import('./views/help.js'),
};
const ADMIN_ONLY = new Set(['import', 'settings', 'viewer-password', 'export', 'audit']);

const NAV = [
  ['', '財務儀表板'], ['reports', '月報表'], ['tx', '明細搜尋'], ['accounts', '收支科目'],
  ['vendors', '廠商分析'], ['repairs', '修繕分析'], ['help', '使用說明'],
];
const ADMIN_NAV = [['settings', '科目／廠商設定'], ['viewer-password', '瀏覽密碼管理'], ['export', '匯出與備份'], ['audit', '修改紀錄']];

const ctx = {
  raw: null, D: null, admin: false,
  async reload() { ctx.raw = await api.loadData(); ctx.D = normalize(ctx.raw); },
  go(path) { location.hash = '#/' + path; },
  editTx(id) { editTxDialog(ctx, id); },
  rerender() { render(); },
};

function layout() {
  const name = api.state.siteInfo?.community_name || '社區財務透明查詢系統';
  document.title = name;
  const admin = api.state.mode === 'admin';
  $('#app').innerHTML = `
  <header class="topbar">
    <button class="btn-icon nav-toggle" aria-label="選單" aria-expanded="false">☰</button>
    <a class="brand" href="#/">${esc(name)}</a>
    <span class="role-badge ${admin ? 'admin' : ''}">${admin ? '管理者' : '鄰居唯讀'}</span>
    <button class="btn btn-sm" id="logout">登出</button>
  </header>
  <div class="shell">
    <nav class="sidenav" id="sidenav">
      ${NAV.map(([p, l]) => `<a href="#/${p}" data-nav="${p}">${l}</a>`).join('')}
      ${admin ? `<div class="nav-sep">管理功能</div>${ADMIN_NAV.map(([p, l]) => `<a href="#/${p}" data-nav="${p}">${l}</a>`).join('')}` : ''}
    </nav>
    <main id="view" tabindex="-1"></main>
  </div>`;
  $('.nav-toggle').onclick = () => { const n = $('#sidenav'); n.classList.toggle('open'); $('.nav-toggle').setAttribute('aria-expanded', n.classList.contains('open')); };
  $('#sidenav').addEventListener('click', (e) => { if (e.target.closest('a')) $('#sidenav').classList.remove('open'); });
  $('#logout').onclick = async () => {
    if (admin) await api.adminLogout(); else await api.viewerLogout();
    location.hash = '#/';
    await boot();
  };
}

async function render() {
  const [, route = '', ...params] = (location.hash || '#/').replace(/^#/, '').split('/');
  const view = $('#view');
  if (!view) return;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route || (route === 'report' && a.dataset.nav === 'reports') || (route === 'vendor' && a.dataset.nav === 'vendors')));
  if (ADMIN_ONLY.has(route) && !ctx.admin) { view.innerHTML = '<div class="card"><h2>需要管理者權限</h2><p>此頁面只有管理者可以使用。</p></div>'; return; }
  const loader = routes[route];
  if (!loader) { view.innerHTML = '<div class="card"><h2>找不到頁面</h2></div>'; return; }
  view.innerHTML = '<div class="loading">載入中…</div>';
  view.onclick = null;
  window.onbeforeunload = null;
  if (api.state.mode === 'viewer') {
    // 管理者更換密碼後，舊的瀏覽憑證會立即失效；每次換頁都向伺服器確認
    const { data } = await api.state.client.rpc('site_info');
    if (!data?.viewer_ok) { await api.viewerLogout(); await boot(); toast('瀏覽密碼已更換或憑證已過期，請重新輸入密碼。', 'error', 6000); return; }
  }
  try {
    const mod = await loader();
    // 每次換頁使用新的容器；較慢完成的舊頁面只會寫入已移除的容器，不會蓋掉目前頁面
    const el = document.createElement('div');
    view.replaceChildren(el);
    await mod.render(el, ctx, params.map(decodeURIComponent), route);
    view.focus({ preventScroll: true });
  } catch (e) {
    console.error(e);
    if (!document.body.contains(view)) return;
    view.innerHTML = `<div class="card error"><h2>發生錯誤</h2><p class="pre">${esc(e.message)}</p></div>`;
  }
}

function loginScreen() {
  const info = api.state.siteInfo;
  const name = info?.community_name || '社區財務透明查詢系統';
  document.title = name;
  $('#app').innerHTML = `
  <div class="login-wrap">
    <div class="card login-card">
      <h1>${esc(name)}</h1>
      <p class="muted">本網站提供社區收支月報表的查詢與分析。請輸入網站管理者提供的共同瀏覽密碼。</p>
      ${info && info.viewer_configured === false ? '<p class="warn-text">管理者尚未設定共同瀏覽密碼。</p>' : ''}
      <form id="viewer-form" autocomplete="on">
        <label>共同瀏覽密碼<input class="input" type="password" name="password" required autocomplete="current-password" maxlength="200"></label>
        <button class="btn btn-primary btn-block" type="submit">進入查詢</button>
        <p id="viewer-msg" class="form-msg" role="alert"></p>
      </form>
      <details class="admin-login">
        <summary>管理者登入</summary>
        <form id="admin-form">
          <label>Email<input class="input" type="email" name="email" required autocomplete="username"></label>
          <label>密碼<input class="input" type="password" name="password" required autocomplete="current-password"></label>
          <button class="btn btn-block" type="submit">管理者登入</button>
          <p id="admin-msg" class="form-msg" role="alert"></p>
        </form>
      </details>
    </div>
  </div>`;
  $('#viewer-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true;
    const r = await api.viewerLogin(e.target.password.value);
    btn.disabled = false;
    const msg = $('#viewer-msg');
    if (r?.ok) { await boot(); return; }
    msg.textContent = r?.error === 'locked' ? `錯誤次數過多，請 ${r.retry_after_minutes} 分鐘後再試。`
      : r?.error === 'not_configured' ? '管理者尚未設定共同瀏覽密碼。'
      : r?.error === 'invalid' ? `密碼錯誤。${r.remaining !== undefined ? `（再錯 ${r.remaining} 次將暫停 15 分鐘）` : ''}`
      : `無法連線：${r?.message || ''}`;
  };
  $('#admin-form').onsubmit = async (e) => {
    e.preventDefault();
    const r = await api.adminLogin(e.target.email.value, e.target.password.value);
    if (!r.ok) { $('#admin-msg').textContent = '登入失敗：' + r.message; return; }
    await boot();
    if (api.state.mode !== 'admin' && api.state.mode !== 'mfa') {
      await api.adminLogout();
      await boot();
      toast('此帳號不是管理者，已登出。', 'error', 6000);
    }
  };
}

function mfaScreen() {
  $('#app').innerHTML = `<div class="login-wrap"><div class="card login-card">
    <h1>兩步驟驗證</h1><p class="muted">請輸入驗證器 App 顯示的 6 位數代碼。</p>
    <form id="mfa-form"><label>驗證碼<input class="input" name="code" inputmode="numeric" pattern="\\d{6}" required autocomplete="one-time-code"></label>
    <button class="btn btn-primary btn-block">驗證</button><p class="form-msg" id="mfa-msg" role="alert"></p></form>
    <button class="btn btn-block" id="mfa-cancel">取消並登出</button></div></div>`;
  $('#mfa-form').onsubmit = async (e) => {
    e.preventDefault();
    const r = await verifyMfa(e.target.code.value);
    if (!r.ok) { $('#mfa-msg').textContent = r.message; return; }
    await boot();
  };
  $('#mfa-cancel').onclick = async () => { await api.adminLogout(); await boot(); };
}

export async function verifyMfa(code) {
  const { data: f } = await api.adminClient.auth.mfa.listFactors();
  const factor = f?.totp?.find((x) => x.status === 'verified');
  if (!factor) return { ok: false, message: '找不到已啟用的驗證器' };
  const { error } = await api.adminClient.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
  return error ? { ok: false, message: '驗證碼錯誤' } : { ok: true };
}

function notConfigured() {
  $('#app').innerHTML = `<div class="login-wrap"><div class="card login-card"><h1>尚未完成設定</h1>
  <p>找不到 Supabase 連線設定（config.js）。請依照部署說明建立 <code>config.js</code>，填入 Supabase 專案網址與公開金鑰（anon / publishable key）。</p></div></div>`;
}

async function boot() {
  if (!api.configured) { notConfigured(); return; }
  try {
    await api.initSession();
  } catch (e) {
    $('#app').innerHTML = `<div class="login-wrap"><div class="card login-card error"><h1>無法連線</h1><p class="pre">${esc(e.message)}</p></div></div>`;
    return;
  }
  ctx.admin = api.state.mode === 'admin';
  if (api.state.mode === 'mfa') { mfaScreen(); return; }
  if (api.state.mode === 'none') { loginScreen(); return; }
  layout();
  try {
    await ctx.reload();
  } catch (e) {
    // 瀏覽憑證可能已因密碼更換而失效
    if (api.state.mode === 'viewer') { await api.viewerLogout(); await boot(); toast('瀏覽憑證已失效，請重新輸入密碼。', 'error'); return; }
    $('#view').innerHTML = `<div class="card error"><h2>資料載入失敗</h2><p class="pre">${esc(e.message)}</p></div>`;
    return;
  }
  render();
}

window.addEventListener('hashchange', () => {
  if (api.state.mode === 'admin' || api.state.mode === 'viewer') render();
});
api.adminClient?.auth.onAuthStateChange((evt) => {
  if (evt === 'SIGNED_OUT' && api.state.mode === 'admin') boot();
});

boot();
export { ctx, modal };
