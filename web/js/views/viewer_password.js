// 共同瀏覽密碼管理（只有管理者能進入；伺服器端再次檢查管理者身分與 5 分鐘內重新驗證）
import { esc, fmtTime } from '../util.js';
import { $, toast, confirmDialog, badge } from '../ui.js';
import { rpc, adminReauth, adminClient } from '../api.js';
import { verifyMfa } from '../app.js';

const statusItems = (st) => `
      <li>共同瀏覽密碼：${st.configured ? badge('已設定', 'ok') : badge('尚未設定（鄰居無法進入）', 'warn')}</li>
      <li>最後更改時間：${fmtTime(st.changed_at)}（第 ${st.version} 版）</li>
      <li>目前有效的鄰居瀏覽工作階段：${st.active_sessions}</li>
      <li>過去 24 小時錯誤嘗試：${st.failed_last_24h} 次；目前被暫停的來源：${st.locked_sources} 個</li>`;

export async function render(view, ctx) {
  let st;
  try { st = await rpc('admin_viewer_status'); } catch (err) { view.innerHTML = `<div class="card error"><h2>無法讀取</h2><p>${esc(err.message)}</p></div>`; return; }
  view.innerHTML = `
  <div class="page-head"><h1>共同瀏覽密碼管理</h1></div>
  <section class="card">
    <h2>目前狀態</h2>
    <ul class="plain" id="pw-status">${statusItems(st)}</ul>
    <p class="sub">密碼只以 bcrypt 雜湊保存在資料庫的私有區，網站、API 及備份檔都讀不到明文。同一來源 15 分鐘內錯誤 5 次會暫停 15 分鐘；全站 15 分鐘內錯誤 50 次也會暫停。</p>
  </section>

  <section class="card">
    <h2>${st.configured ? '更改' : '設定'}共同瀏覽密碼</h2>
    <form id="pw-form" class="form-grid" autocomplete="off">
      <label>新的共同瀏覽密碼（8 個字元以上）<input class="input" type="password" name="p1" minlength="8" maxlength="100" required autocomplete="new-password"></label>
      <label>再次輸入新密碼<input class="input" type="password" name="p2" minlength="8" maxlength="100" required autocomplete="new-password"></label>
      <label class="span2">為了確認是你本人，請再次輸入「管理者登入密碼」<input class="input" type="password" name="admin_pw" required autocomplete="current-password"></label>
      <label class="span2" id="mfa-row" hidden>兩步驟驗證碼<input class="input" name="code" inputmode="numeric" autocomplete="one-time-code"></label>
      <div class="actions span2"><button class="btn btn-primary">確認${st.configured ? '更改' : '設定'}</button></div>
      <div id="pw-result" class="span2" role="status" aria-live="polite"></div>
    </form>
    <p class="sub">更改後，舊密碼立即失效，所有鄰居目前的瀏覽工作階段也會立即失效，鄰居必須使用新密碼重新進入。</p>
  </section>

  <section class="card">
    <h2>其他操作</h2>
    <div class="actions"><button class="btn" id="revoke">讓所有鄰居立即登出（不改密碼）</button><button class="btn" id="unlock">解除錯誤次數暫停</button></div>
  </section>`;

  const { data: f } = await adminClient.auth.mfa.listFactors();
  const hasMfa = (f?.totp || []).some((x) => x.status === 'verified');
  if (hasMfa) $('#mfa-row', view).hidden = false;

  $('#pw-form', view).onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const out = $('#pw-result', view);
    const show = (ok, msg) => { out.innerHTML = `<div class="notice ${ok ? 'ok' : 'warn'}">${esc(msg)}</div>`; };
    if (form.p1.value !== form.p2.value) { show(false, '兩次輸入的新密碼不一致。'); return; }
    if (form.p1.value.length < 8) { show(false, '密碼至少需要 8 個字元。'); return; }
    form.querySelector('button').disabled = true;
    try {
      const re = await adminReauth(form.admin_pw.value);
      if (!re.ok) { show(false, '管理者密碼錯誤，未更改共同瀏覽密碼。'); return; }
      if (hasMfa) {
        const r = await verifyMfa(form.code.value || '');
        if (!r.ok) { show(false, '兩步驟驗證碼錯誤，未更改共同瀏覽密碼。'); return; }
      }
      const res = await rpc('admin_set_viewer_password', { p_new: form.p1.value, p_confirm: form.p2.value });
      if (res.ok) {
        form.reset();
        show(true, `更改成功（第 ${res.version} 版）。舊密碼已失效，所有鄰居需使用新密碼重新進入。請以安全的方式（例如當面或社區公告）通知鄰居新密碼。`);
        toast('共同瀏覽密碼已更新', 'success');
        try { $('#pw-status', view).innerHTML = statusItems(await rpc('admin_viewer_status')); } catch { /* 狀態稍後重新整理即可 */ }
      } else {
        show(false, '更改失敗：' + (res.message || res.error));
      }
    } catch (err) {
      show(false, '更改失敗：' + err.message);
    } finally {
      form.querySelector('button').disabled = false;
    }
  };
  $('#revoke', view).onclick = async () => {
    if (!(await confirmDialog('讓所有鄰居登出', '所有鄰居需重新輸入共同瀏覽密碼。密碼不變。'))) return;
    try { const r = await rpc('admin_revoke_viewer_sessions'); toast(`已讓 ${r.revoked} 個工作階段失效`, 'success'); ctx.rerender(); } catch (err) { toast(err.message, 'error'); }
  };
  $('#unlock', view).onclick = async () => {
    try { await rpc('admin_unlock_viewer_login'); toast('已解除暫停', 'success'); ctx.rerender(); } catch (err) { toast(err.message, 'error'); }
  };
}
