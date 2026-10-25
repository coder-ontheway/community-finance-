// 管理者設定：網站設定、兩步驟驗證、分析分類、科目、修繕分類、廠商與別名
import { esc, similarity, fmtMoney } from '../util.js';
import { $, toast, modal, confirmDialog, formData, options, numOrNull, badge } from '../ui.js';
import { q, db, rpc, adminClient } from '../api.js';
import { verifyMfa } from '../app.js';

let tab = 'site';

export async function render(view, ctx) {
  const tabs = [['site', '網站設定'], ['security', '管理者安全'], ['categories', '分析分類'], ['accounts', '科目'], ['repair', '修繕分類'], ['vendors', '廠商與別名']];
  view.innerHTML = `<div class="page-head"><h1>科目／廠商設定</h1></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</nav><div id="tab-body"></div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; ctx.rerender(); }));
  const body = $('#tab-body', view);
  const done = async (msg = '已儲存') => { toast(msg, 'success'); await ctx.reload(); ctx.rerender(); };
  const fail = (err) => toast(err.message, 'error', 8000);
  await ({ site, security, categories, accounts, repair, vendors }[tab])(body, ctx, done, fail);
}

async function site(body, ctx, done, fail) {
  const s = ctx.raw.settings;
  body.innerHTML = `<form class="card form-grid" id="sf">
    <label class="span2">社區名稱（網站標題）<input class="input" name="community_name" value="${esc(s.community_name)}" required></label>
    <label class="span2">首頁公告（鄰居看得到）<textarea class="input" name="public_notice" rows="2">${esc(s.public_notice || '')}</textarea></label>
    <label class="span2">資料限制說明<textarea class="input" name="data_limit_notice" rows="3">${esc(s.data_limit_notice || '')}</textarea></label>
    <h3 class="span2">系統累計結餘的起算點</h3>
    <p class="span2 sub">系統累計結餘＝起算餘額＋起算月份起每月（收入−支出）。起算餘額請取自第一份匯入報表上的「前期餘絀」，並確認數字清楚無誤。</p>
    <label>起算餘額（元）<input class="input" name="opening_balance" inputmode="decimal" value="${esc(s.opening_balance ?? '')}"></label>
    <label>來源說明<input class="input" name="opening_balance_label" value="${esc(s.opening_balance_label || '')}" placeholder="例如：115年9月報表前期餘絀"></label>
    <label>起算民國年<input class="input" type="number" name="opening_roc_year" value="${esc(s.opening_roc_year ?? '')}"></label>
    <label>起算月份（此月份開始累計）<input class="input" type="number" min="1" max="12" name="opening_month" value="${esc(s.opening_month ?? '')}"></label>
    <h3 class="span2">鄰居瀏覽</h3>
    <label>瀏覽憑證有效天數<input class="input" type="number" min="1" max="365" name="viewer_session_days" value="${esc(s.viewer_session_days)}"></label>
    <div class="actions span2"><button class="btn btn-primary">儲存</button></div></form>`;
  $('#sf', body).onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const ob = numOrNull(f.opening_balance);
    if (Number.isNaN(ob)) { toast('起算餘額格式不正確', 'error'); return; }
    try {
      await q(db().from('app_settings').update({
        community_name: f.community_name.trim(), public_notice: f.public_notice || null, data_limit_notice: f.data_limit_notice,
        opening_balance: ob, opening_balance_label: f.opening_balance_label || null,
        opening_roc_year: f.opening_roc_year ? Number(f.opening_roc_year) : null, opening_month: f.opening_month ? Number(f.opening_month) : null,
        viewer_session_days: Number(f.viewer_session_days) || 30,
      }).eq('id', 1));
      done();
    } catch (err) { fail(err); }
  };
}

async function security(body, ctx, done, fail) {
  const s = ctx.raw.settings;
  const { data: f } = await adminClient.auth.mfa.listFactors();
  const totp = (f?.totp || []).filter((x) => x.status === 'verified');
  body.innerHTML = `<section class="card"><h2>兩步驟驗證（強烈建議）</h2>
    <p>啟用後，登入管理者帳號除了密碼，還需要手機驗證器 App（如 Google Authenticator、Microsoft Authenticator）產生的 6 位數代碼。</p>
    <p>目前狀態：${totp.length ? badge('已設定驗證器', 'ok') : badge('未設定', 'warn')}　資料庫強制要求：${s.require_mfa ? badge('已啟用', 'ok') : badge('未啟用', 'muted')}</p>
    <div class="actions">${totp.length ? '' : '<button class="btn btn-primary" id="enroll">設定驗證器</button>'}
      ${totp.length && !s.require_mfa ? '<button class="btn" id="require">要求所有管理操作都必須通過兩步驟驗證</button>' : ''}
      ${s.require_mfa ? '<button class="btn" id="unrequire">取消強制要求</button>' : ''}</div>
    <div id="enroll-box"></div></section>
    <section class="card"><h2>管理者帳號</h2><p>目前登入：${esc(ctx.admin ? (await adminClient.auth.getUser()).data.user?.email : '')}</p>
    <p class="sub">管理者名單只能在 Supabase 後台的 SQL Editor 維護（見部署說明），網站上沒有任何新增管理者的功能。</p></section>`;
  $('#enroll', body)?.addEventListener('click', async () => {
    const { data, error } = await adminClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'community-finance-' + Date.now() });
    if (error) { fail(error); return; }
    $('#enroll-box', body).innerHTML = `<p>請用驗證器 App 掃描 QR Code，然後輸入顯示的 6 位數代碼。</p>
      <img class="qr" src="${data.totp.qr_code}" alt="驗證器 QR Code"><p class="sub">無法掃描時手動輸入：<code>${esc(data.totp.secret)}</code></p>
      <form id="vf" class="inline-form"><input class="input" name="code" inputmode="numeric" pattern="\\d{6}" required autocomplete="one-time-code"><button class="btn btn-primary">驗證並啟用</button></form>`;
    $('#vf', body).onsubmit = async (e) => {
      e.preventDefault();
      const { error: err } = await adminClient.auth.mfa.challengeAndVerify({ factorId: data.id, code: e.target.code.value.trim() });
      if (err) { toast('驗證碼錯誤', 'error'); return; }
      done('驗證器已啟用');
    };
  });
  $('#require', body)?.addEventListener('click', async () => {
    const { data: aal } = await adminClient.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.currentLevel !== 'aal2') {
      const code = prompt('請輸入驗證器 6 位數代碼，以確認你能正常使用兩步驟驗證：');
      if (!code) return;
      const r = await verifyMfa(code);
      if (!r.ok) { toast(r.message, 'error'); return; }
    }
    try { await q(db().from('app_settings').update({ require_mfa: true }).eq('id', 1)); done('已啟用強制兩步驟驗證'); } catch (err) { fail(err); }
  });
  $('#unrequire', body)?.addEventListener('click', async () => {
    if (!(await confirmDialog('取消強制兩步驟驗證', '取消後，只要知道管理者密碼即可修改財務資料，安全性會降低。'))) return;
    try { await q(db().from('app_settings').update({ require_mfa: false }).eq('id', 1)); done(); } catch (err) { fail(err); }
  });
}

async function categories(body, ctx, done, fail) {
  const list = [...ctx.D.categories.values()].sort((a, b) => (a.side === b.side ? a.sort_order - b.sort_order : a.side === 'income' ? -1 : 1));
  body.innerHTML = `<section class="card"><h2>分析分類</h2><p class="sub">分析分類用於統計圖表，不會改動原始科目。可以自由新增、改名、調整排序。</p>
    <div class="table-wrap"><table><thead><tr><th>收支</th><th>名稱</th><th>修繕類</th><th>排序</th><th>使用筆數</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr data-id="${c.id}"><td>${c.side === 'income' ? '收入' : '支出'}</td><td><input class="input" name="name" value="${esc(c.name)}"></td>
      <td><input type="checkbox" name="is_repair" ${c.is_repair ? 'checked' : ''}></td><td><input class="input input-xs" type="number" name="sort_order" value="${c.sort_order}"></td>
      <td>${ctx.D.tx.filter((t) => t.analysis_category_id === c.id).length}</td>
      <td><button class="btn btn-sm" data-save>儲存</button><button class="btn btn-sm btn-danger" data-del>刪除</button></td></tr>`).join('')}
    <tr><td><select class="input" id="nc-side">${options([['income', '收入'], ['expense', '支出']], 'expense')}</select></td><td><input class="input" id="nc-name" placeholder="新分類名稱"></td><td><input type="checkbox" id="nc-rep"></td><td></td><td></td><td><button class="btn btn-sm btn-primary" id="nc-add">新增</button></td></tr>
    </tbody></table></div></section>`;
  body.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.querySelector('[data-save]').onclick = async () => {
      try { await q(db().from('analysis_categories').update({ name: tr.querySelector('[name=name]').value.trim(), is_repair: tr.querySelector('[name=is_repair]').checked, sort_order: Number(tr.querySelector('[name=sort_order]').value) || 0 }).eq('id', id)); done(); } catch (err) { fail(err); }
    };
    tr.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmDialog('刪除分類', '使用此分類的明細會變成「未分類」，原始資料不受影響。', { danger: true }))) return;
      try { await q(db().from('analysis_categories').delete().eq('id', id)); done(); } catch (err) { fail(err); }
    };
  });
  $('#nc-add', body).onclick = async () => {
    const name = $('#nc-name', body).value.trim(); if (!name) return;
    try { await q(db().from('analysis_categories').insert({ side: $('#nc-side', body).value, name, is_repair: $('#nc-rep', body).checked, sort_order: list.length + 1 })); done(); } catch (err) { fail(err); }
  };
}

async function accounts(body, ctx, done, fail) {
  const D = ctx.D;
  const cats = [...D.categories.values()];
  const list = [...D.accounts.values()].sort((a, b) => (a.side === b.side ? a.sort_order - b.sort_order || a.standard_name.localeCompare(b.standard_name, 'zh-Hant') : a.side === 'income' ? -1 : 1));
  const mappings = ctx.raw.mappings;
  body.innerHTML = `<section class="card"><h2>標準化科目</h2>
    <p class="sub">匯入時，每個原始科目名稱會自動對應到同名的標準化科目（不改名）。你可以把不同寫法的原始科目改對應到同一個標準化科目，原始名稱仍完整保留。</p>
    <div class="table-wrap"><table><thead><tr><th>收支</th><th>標準化名稱</th><th>分析分類</th><th>修繕</th><th>對應的原始科目名稱</th><th>筆數／金額</th><th></th></tr></thead><tbody>
    ${list.map((a) => {
      const rows = D.tx.filter((t) => t.account_id === a.id);
      return `<tr data-id="${a.id}"><td>${a.side === 'income' ? '收入' : '支出'}</td><td><input class="input" name="standard_name" value="${esc(a.standard_name)}"></td>
      <td><select class="input" name="analysis_category_id">${options(cats.filter((c) => c.side === a.side).map((c) => [c.id, c.name]), a.analysis_category_id, { empty: '（未分類）' })}</select></td>
      <td><input type="checkbox" name="is_repair" ${a.is_repair ? 'checked' : ''}></td>
      <td>${mappings.filter((m) => m.account_id === a.id).map((m) => `<span class="chip chip-static">${esc(m.raw_name)} <button class="link" data-remap="${m.id}" title="改對應">↪</button></span>`).join(' ')}</td>
      <td>${rows.length} 筆<br><span class="sub">${esc(fmtMoney(rows.reduce((s, t) => s + t.cents, 0)))}</span></td>
      <td><button class="btn btn-sm" data-save>儲存</button><button class="btn btn-sm" data-apply title="將分類與修繕設定套用到此科目所有明細">套用到明細</button>${rows.length ? '' : '<button class="btn btn-sm btn-danger" data-del>刪除</button>'}</td></tr>`;
    }).join('')}</tbody></table></div></section>`;
  body.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = Number(tr.dataset.id);
    const vals = () => ({ standard_name: tr.querySelector('[name=standard_name]').value.trim(), analysis_category_id: Number(tr.querySelector('[name=analysis_category_id]').value) || null, is_repair: tr.querySelector('[name=is_repair]').checked });
    tr.querySelector('[data-save]').onclick = async () => { try { await q(db().from('accounts').update(vals()).eq('id', id)); done(); } catch (err) { fail(err); } };
    tr.querySelector('[data-apply]').onclick = async () => {
      const v = vals();
      const n = D.tx.filter((t) => t.account_id === id).length;
      if (!(await confirmDialog('套用到明細', `將此科目的 ${n} 筆明細，分析分類設為「${cats.find((c) => c.id === v.analysis_category_id)?.name || '未分類'}」、修繕設為「${v.is_repair ? '是' : '否'}」。原始科目與摘要不受影響。`))) return;
      try { await q(db().from('accounts').update(v).eq('id', id)); await q(db().from('transactions').update({ analysis_category_id: v.analysis_category_id, is_repair: v.is_repair }).eq('account_id', id)); done('已套用'); } catch (err) { fail(err); }
    };
    tr.querySelector('[data-del]')?.addEventListener('click', async () => { try { await q(db().from('accounts').delete().eq('id', id)); done(); } catch (err) { fail(err); } });
  });
  body.querySelectorAll('[data-remap]').forEach((b) => (b.onclick = () => {
    const m = mappings.find((x) => x.id === Number(b.dataset.remap));
    const dlg = modal('改對應標準化科目', `<p>原始科目「<b>${esc(m.raw_name)}</b>」改對應到：</p>
      <select class="input" id="to">${options(list.filter((a) => a.side === m.side).map((a) => [a.id, a.standard_name]), m.account_id)}</select>
      <label class="check"><input type="checkbox" id="apply" checked> 同時更新已存在、原始科目為此名稱的明細</label>
      <div class="actions"><button class="btn btn-primary" id="ok">確認</button></div>`);
    $('#ok', dlg.el).onclick = async () => {
      const to = Number($('#to', dlg.el).value);
      try {
        await q(db().from('account_mappings').update({ account_id: to }).eq('id', m.id));
        if ($('#apply', dlg.el).checked) await q(db().from('transactions').update({ account_id: to }).eq('side', m.side).eq('original_account_name', m.raw_name));
        dlg.close(); done();
      } catch (err) { fail(err); }
    };
  }));
}

async function repair(body, ctx, done, fail) {
  const list = [...ctx.D.repairCats.values()].sort((a, b) => a.sort_order - b.sort_order);
  body.innerHTML = `<section class="card"><h2>修繕分類</h2><p class="sub">關鍵字用於匯入時「建議」修繕分類（仍需你核對確認）。多個關鍵字以逗號分隔。</p>
    <div class="table-wrap"><table><thead><tr><th>名稱</th><th>建議關鍵字</th><th>排序</th><th>筆數</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr data-id="${c.id}"><td><input class="input" name="name" value="${esc(c.name)}"></td><td><input class="input" name="keywords" value="${esc((c.keywords || []).join(','))}"></td>
      <td><input class="input input-xs" type="number" name="sort_order" value="${c.sort_order}"></td><td>${ctx.D.tx.filter((t) => t.repair_category_id === c.id).length}</td>
      <td><button class="btn btn-sm" data-save>儲存</button><button class="btn btn-sm btn-danger" data-del>刪除</button></td></tr>`).join('')}
    <tr><td><input class="input" id="nr-name" placeholder="新修繕分類"></td><td><input class="input" id="nr-kw" placeholder="關鍵字,關鍵字"></td><td></td><td></td><td><button class="btn btn-sm btn-primary" id="nr-add">新增</button></td></tr>
    </tbody></table></div></section>`;
  const kws = (s) => s.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
  body.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.querySelector('[data-save]').onclick = async () => { try { await q(db().from('repair_categories').update({ name: tr.querySelector('[name=name]').value.trim(), keywords: kws(tr.querySelector('[name=keywords]').value), sort_order: Number(tr.querySelector('[name=sort_order]').value) || 0 }).eq('id', id)); done(); } catch (err) { fail(err); } };
    tr.querySelector('[data-del]').onclick = async () => { if (!(await confirmDialog('刪除修繕分類', '使用此分類的明細會變成「未分類」。', { danger: true }))) return; try { await q(db().from('repair_categories').delete().eq('id', id)); done(); } catch (err) { fail(err); } };
  });
  $('#nr-add', body).onclick = async () => { const name = $('#nr-name', body).value.trim(); if (!name) return; try { await q(db().from('repair_categories').insert({ name, keywords: kws($('#nr-kw', body).value), sort_order: list.length + 1 })); done(); } catch (err) { fail(err); } };
}

async function vendors(body, ctx, done, fail) {
  const D = ctx.D;
  const vlist = [...D.vendors.values()].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name, 'zh-Hant'));
  const aliases = ctx.raw.aliases;
  const pending = aliases.filter((a) => a.status === 'pending');
  const txCount = (name) => D.tx.filter((t) => t.counterparty_raw === name).length;
  const suggest = (name) => vlist.map((v) => ({ v, s: Math.max(similarity(name, v.canonical_name), ...aliases.filter((a) => a.vendor_id === v.id && a.status === 'confirmed').map((a) => similarity(name, a.alias_name))) }))
    .filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, 3);
  body.innerHTML = `
  <section class="card"><h2>待確認的交易對象名稱（${pending.length}）</h2>
    <p class="sub">匯入時從摘要取出的交易對象名稱，系統不會自動判定屬於哪家廠商。名稱相似只會列為「可能是」，必須由你確認後才會歸戶。</p>
    ${pending.length ? `<div class="table-wrap"><table><thead><tr><th>名稱原文</th><th>出現筆數</th><th>可能是（僅供參考）</th><th>處理</th></tr></thead><tbody>
    ${pending.map((a) => `<tr data-alias="${a.id}"><td><b>${esc(a.alias_name)}</b></td><td>${txCount(a.alias_name)}</td>
      <td>${suggest(a.alias_name).map((x) => `${esc(x.v.canonical_name)}（相似 ${(x.s * 100).toFixed(0)}%）`).join('<br>') || '<span class="muted">無</span>'}</td>
      <td><select class="input input-inline" name="vendor">${options(vlist.map((v) => [v.id, v.canonical_name]), '', { empty: '選擇既有廠商…' })}</select>
        <button class="btn btn-sm" data-confirm>確認歸戶</button><button class="btn btn-sm btn-primary" data-new>建立為新廠商</button><button class="btn btn-sm" data-reject>不歸戶</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">沒有待確認的名稱。</p>'}
  </section>
  <section class="card"><h2>廠商（${vlist.length}）</h2>
    <div class="table-wrap"><table><thead><tr><th>廠商名稱</th><th>已確認別名</th><th>類型</th><th>明細筆數</th><th></th></tr></thead><tbody>
    ${vlist.map((v) => `<tr data-v="${v.id}"><td><input class="input" name="canonical_name" value="${esc(v.canonical_name)}"></td>
      <td>${aliases.filter((a) => a.vendor_id === v.id && a.status === 'confirmed').map((a) => `<span class="chip chip-static">${esc(a.alias_name)} <button class="link" data-unalias="${a.id}" title="取消此別名">✕</button></span>`).join(' ')}</td>
      <td><input class="input" name="vendor_type" value="${esc(v.vendor_type || '')}" placeholder="例如：保全、機電"></td>
      <td>${D.tx.filter((t) => t.vendor_id === v.id).length}</td>
      <td><button class="btn btn-sm" data-save>儲存</button><button class="btn btn-sm" data-merge>合併到…</button></td></tr>`).join('')}
    </tbody></table></div>
    <form class="inline-form" id="nv"><input class="input" name="name" placeholder="新增廠商名稱" required><button class="btn btn-primary">新增廠商</button></form></section>
  ${aliases.some((a) => a.status === 'rejected') ? `<section class="card"><h2>已標記不歸戶的名稱</h2><div class="chips">${aliases.filter((a) => a.status === 'rejected').map((a) => `<span class="chip chip-static">${esc(a.alias_name)} <button class="link" data-reopen="${a.id}">重新處理</button></span>`).join('')}</div></section>` : ''}`;

  body.querySelectorAll('tr[data-alias]').forEach((tr) => {
    const a = aliases.find((x) => x.id === Number(tr.dataset.alias));
    tr.querySelector('[data-confirm]').onclick = async () => {
      const vid = Number(tr.querySelector('[name=vendor]').value);
      if (!vid) { toast('請先選擇廠商', 'error'); return; }
      if (!(await confirmDialog('確認歸戶', `確認「${a.alias_name}」就是「${D.vendors.get(vid).canonical_name}」？\n確認後，摘要中出現此名稱的 ${txCount(a.alias_name)} 筆明細都會歸到這家廠商。`))) return;
      try { const r = await rpc('confirm_vendor_alias', { p_alias_id: a.id, p_vendor_id: vid }); done(`已歸戶 ${r.transactions_updated} 筆`); } catch (err) { fail(err); }
    };
    tr.querySelector('[data-new]').onclick = async () => {
      const name = prompt('新廠商名稱（可修改為正式名稱）：', a.alias_name);
      if (!name) return;
      try { const [v] = await q(db().from('vendors').insert({ canonical_name: name.trim() }).select()); const r = await rpc('confirm_vendor_alias', { p_alias_id: a.id, p_vendor_id: v.id }); done(`已建立並歸戶 ${r.transactions_updated} 筆`); } catch (err) { fail(err); }
    };
    tr.querySelector('[data-reject]').onclick = async () => { try { await q(db().from('vendor_aliases').update({ status: 'rejected' }).eq('id', a.id)); done(); } catch (err) { fail(err); } };
  });
  body.querySelectorAll('[data-reopen]').forEach((b) => (b.onclick = async () => { try { await q(db().from('vendor_aliases').update({ status: 'pending', vendor_id: null }).eq('id', Number(b.dataset.reopen))); done(); } catch (err) { fail(err); } }));
  body.querySelectorAll('[data-unalias]').forEach((b) => (b.onclick = async () => {
    const a = aliases.find((x) => x.id === Number(b.dataset.unalias));
    if (!(await confirmDialog('取消別名', `取消「${a.alias_name}」的歸戶？已歸戶的明細會改回未歸戶。`))) return;
    try {
      await q(db().from('vendor_aliases').update({ status: 'pending', vendor_id: null, confirmed_at: null }).eq('id', a.id));
      await q(db().from('transactions').update({ vendor_id: null }).eq('counterparty_raw', a.alias_name).eq('vendor_id', a.vendor_id));
      done();
    } catch (err) { fail(err); }
  }));
  body.querySelectorAll('tr[data-v]').forEach((tr) => {
    const id = Number(tr.dataset.v);
    tr.querySelector('[data-save]').onclick = async () => { try { await q(db().from('vendors').update({ canonical_name: tr.querySelector('[name=canonical_name]').value.trim(), vendor_type: tr.querySelector('[name=vendor_type]').value.trim() || null }).eq('id', id)); done(); } catch (err) { fail(err); } };
    tr.querySelector('[data-merge]').onclick = () => {
      const from = D.vendors.get(id);
      const dlg = modal('合併廠商', `<p>把「<b>${esc(from.canonical_name)}</b>」合併到：</p><select class="input" id="into">${options(vlist.filter((v) => v.id !== id).map((v) => [v.id, v.canonical_name]), '', { empty: '選擇…' })}</select>
        <p class="sub">合併後，「${esc(from.canonical_name)}」的所有明細與別名會移到目標廠商，原名稱會保留為別名。此動作會記錄在修改紀錄。</p><div class="actions"><button class="btn btn-danger" id="go">合併</button></div>`);
      $('#go', dlg.el).onclick = async () => {
        const into = Number($('#into', dlg.el).value); if (!into) return;
        if (!(await confirmDialog('再次確認', `確定「${from.canonical_name}」與「${D.vendors.get(into).canonical_name}」是同一家廠商？`, { danger: true, requireText: '確認合併' }))) return;
        try { const r = await rpc('merge_vendors', { p_from: id, p_into: into }); dlg.close(); done(`已合併，移動 ${r.transactions_moved} 筆明細`); } catch (err) { fail(err); }
      };
    };
  });
  $('#nv', body).onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    try {
      const [v] = await q(db().from('vendors').insert({ canonical_name: name }).select());
      const [al] = await q(db().from('vendor_aliases').upsert({ alias_name: name, vendor_id: v.id, status: 'confirmed', confirmed_at: new Date().toISOString() }, { onConflict: 'alias_name' }).select());
      await rpc('confirm_vendor_alias', { p_alias_id: al.id, p_vendor_id: v.id });
      done();
    } catch (err) { fail(err); }
  };
}
