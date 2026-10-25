// 修繕費獨立分析中心
import { repairStats, repairAnomalies, periods, vendorName, repairCatName } from '../analytics.js';
import { esc, fmtMoney, fmtChange, fmtPct, ymShort, ymLabel } from '../util.js';
import { $, chart, drill, txTable, periodSelect, moneyTick, PALETTE, modal, toast, formData, options, confirmDialog } from '../ui.js';
import { q, db } from '../api.js';

let selected = null;
let tab = 'overview';
const KEYWORDS = ['電梯', '管線', '防水', '照明', '門禁', '空調', '馬達', '監控', '消防', '水電', '地坪', '油漆'];

export async function render(view, ctx) {
  const D = ctx.D;
  const ps = periods(D);
  if (!ps.length) { view.innerHTML = '<div class="card"><h2>尚無資料</h2></div>'; return; }
  if (!ps.includes(selected)) selected = ps[ps.length - 1];
  const s = repairStats(D, selected);
  const clues = repairAnomalies(D);
  const dctx = { admin: ctx.admin, onEdit: ctx.editTx };
  const c = (v) => esc(fmtMoney(v, { unit: false }));
  const pc = fmtChange(s.cur, s.prev), ly = fmtChange(s.cur, s.lastYear);
  const tabs = [['overview', '總覽'], ['category', '分類／科目／廠商'], ['history', '歷年比較'], ['ranking', '單筆排行'], ['search', '關鍵字查詢'], ['items', '修繕項目追蹤'], ['clues', `待查核線索（${clues.length}）`]];

  view.innerHTML = `
  <div class="page-head"><h1>修繕分析中心</h1><label class="inline">月份 ${periodSelect(D, selected)}</label></div>
  <p class="sub">納入範圍：支出明細中標記為「修繕」者（管理者可在每筆明細調整，也可在「科目／廠商設定」設定整個科目為修繕）。</p>
  <section class="kpis">
    <button class="kpi" data-k="cur"><span class="kpi-label">${ymLabel(Math.floor(selected / 100), selected % 100)} 修繕支出</span><span class="kpi-value">${esc(fmtMoney(s.cur))}</span>
      <span class="kpi-note">占當月總支出 ${s.curRatio === null ? '—' : (s.curRatio * 100).toFixed(1) + '%'}</span></button>
    <div class="kpi"><span class="kpi-label">與前一月比較</span><span class="kpi-value ${pc.cls}">${esc(pc.text)}</span></div>
    <div class="kpi"><span class="kpi-label">與去年同月比較</span><span class="kpi-value ${ly.cls}">${esc(ly.text)}</span></div>
    <button class="kpi" data-k="all"><span class="kpi-label">歷年修繕支出合計</span><span class="kpi-value">${esc(fmtMoney(s.totalRepair))}</span>
      <span class="kpi-note">占全部支出 ${fmtPct(s.totalRepair, s.totalExpense)}</span></button>
  </section>
  <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab ${tab === k ? 'active' : ''}" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`).join('')}</nav>
  <div id="tab-body"></div>`;

  $('#period', view).onchange = (e) => { selected = Number(e.target.value); render(view, ctx); };
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(view, ctx); }));
  view.querySelector('[data-k="cur"]').onclick = () => drill(D, `${ymShort(selected)} 修繕支出明細`, s.rep.filter((t) => t.ymk === selected), dctx);
  view.querySelector('[data-k="all"]').onclick = () => drill(D, '歷年修繕支出明細', s.rep, dctx);
  view.onclick = (e) => { const b = e.target.closest('[data-edit-tx]'); if (b) ctx.editTx(Number(b.dataset.editTx)); };
  const body = $('#tab-body', view);

  const listTable = (title, list, extra = '') => `<section class="card"><h2>${title}</h2><div class="table-wrap"><table>
    <thead><tr><th>名稱</th><th class="num">累計金額</th><th class="num">筆數</th>${extra ? `<th class="num">${extra}</th>` : ''}<th class="num">占修繕比例</th></tr></thead>
    <tbody>${list.map((x, i) => `<tr class="clickable" data-list="${esc(title)}" data-i="${i}"><td>${esc(x.name)}</td><td class="num">${c(x.cents)}</td><td class="num">${x.count}</td>${extra ? `<td class="num">${x.months}</td>` : ''}<td class="num">${fmtPct(x.cents, s.totalRepair)}</td></tr>`).join('')}</tbody></table></div></section>`;
  const bindLists = (lists) => body.querySelectorAll('[data-list]').forEach((tr) => (tr.onclick = () => { const x = lists[tr.dataset.list][tr.dataset.i]; drill(D, `${tr.dataset.list}：${x.name}`, x.rows, dctx); }));

  if (tab === 'overview') {
    body.innerHTML = `<div class="grid-2">
      <section class="card"><h2>每月修繕支出</h2><div class="chart-box"><canvas id="m-chart"></canvas></div></section>
      <section class="card"><h2>每年修繕支出</h2><div class="table-wrap"><table><thead><tr><th>年度</th><th class="num">修繕支出</th><th class="num">總支出</th><th class="num">占比</th></tr></thead>
        <tbody>${s.yearly.map((y) => `<tr><td>${y.year} 年</td><td class="num">${c(y.cents)}</td><td class="num">${c(y.total)}</td><td class="num">${fmtPct(y.cents, y.total)}</td></tr>`).join('')}</tbody></table></div></section></div>
      <section class="card"><h2>每月明細</h2><div class="table-wrap"><table><thead><tr><th>月份</th><th class="num">修繕支出</th><th class="num">總支出</th><th class="num">修繕占比</th></tr></thead>
        <tbody>${[...s.monthly].reverse().map((m) => `<tr class="clickable" data-ym="${m.ymk}"><td>${ymShort(m.ymk)}</td><td class="num">${c(m.cents)}</td><td class="num">${c(m.total)}</td><td class="num">${fmtPct(m.cents, m.total)}</td></tr>`).join('')}</tbody></table></div></section>`;
    body.querySelectorAll('[data-ym]').forEach((tr) => (tr.onclick = () => { const k = Number(tr.dataset.ym); drill(D, `${ymShort(k)} 修繕明細`, s.rep.filter((t) => t.ymk === k), dctx); }));
    chart($('#m-chart', body), {
      type: 'bar',
      data: { labels: s.monthly.map((m) => ymShort(m.ymk)), datasets: [{ label: '修繕支出', data: s.monthly.map((m) => m.cents / 100), backgroundColor: '#d97706' }] },
      options: { maintainAspectRatio: false, scales: { y: { ticks: { callback: moneyTick } } }, plugins: { legend: { display: false } },
        onClick: (_, els) => { if (els.length) { const m = s.monthly[els[0].index]; drill(D, `${ymShort(m.ymk)} 修繕明細`, m.rows, dctx); } } },
    });
  } else if (tab === 'category') {
    body.innerHTML = listTable('修繕分類', s.byCategory) + listTable('修繕科目（原始）', s.byAccount) + listTable('修繕廠商累計收款', s.byVendor, '出現月數');
    bindLists({ 修繕分類: s.byCategory, '修繕科目（原始）': s.byAccount, 修繕廠商累計收款: s.byVendor });
  } else if (tab === 'history') {
    body.innerHTML = `<section class="card"><h2>同類修繕項目歷年金額比較</h2><div class="chart-box"><canvas id="y-chart"></canvas></div>
      <div class="table-wrap"><table><thead><tr><th>修繕分類</th>${s.years.map((y) => `<th class="num">${y} 年</th>`).join('')}</tr></thead>
      <tbody>${s.catYear.map((r) => `<tr><td>${esc(r.name)}</td>${r.years.map((v) => `<td class="num">${c(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
    chart($('#y-chart', body), {
      type: 'bar',
      data: { labels: s.catYear.map((r) => r.name), datasets: s.years.map((y, i) => ({ label: `${y} 年`, data: s.catYear.map((r) => r.years[i] / 100), backgroundColor: PALETTE[i % PALETTE.length] })) },
      options: { maintainAspectRatio: false, scales: { y: { ticks: { callback: moneyTick } } },
        onClick: (_, els) => { if (els.length) { const cat = s.catYear[els[0].index].name, y = s.years[els[0].datasetIndex]; drill(D, `${y} 年「${cat}」`, s.rep.filter((t) => t.roc_year === y && repairCatName(D, t) === cat), dctx); } } },
    });
  } else if (tab === 'ranking') {
    body.innerHTML = `<section class="card"><h2>單筆修繕金額排行</h2>${txTable(D, s.ranking.slice(0, 50), { admin: ctx.admin })}</section>`;
  } else if (tab === 'search') {
    body.innerHTML = `<section class="card"><h2>修繕摘要關鍵字查詢</h2>
      <div class="chips">${KEYWORDS.map((k) => `<button class="chip" data-kw="${k}">${k}</button>`).join('')}</div>
      <form id="kw-form" class="inline-form"><input class="input" name="kw" placeholder="輸入關鍵字，多個以空白分隔"><button class="btn btn-primary">查詢</button></form>
      <div id="kw-result"></div></section>`;
    const run = (kw) => {
      const ks = kw.split(/\s+/).filter(Boolean);
      const rows = s.rep.filter((t) => ks.every((k) => `${t.original_summary} ${t.original_account_name} ${vendorName(D, t) || ''} ${t.counterparty_raw || ''}`.includes(k)));
      $('#kw-result', body).innerHTML = `<h3>「${esc(kw)}」</h3>` + txTable(D, rows, { admin: ctx.admin });
    };
    body.querySelectorAll('[data-kw]').forEach((b) => (b.onclick = () => run(b.dataset.kw)));
    $('#kw-form', body).onsubmit = (e) => { e.preventDefault(); run(e.target.kw.value.trim()); };
  } else if (tab === 'items') {
    renderItems(body, ctx, s);
  } else if (tab === 'clues') {
    body.innerHTML = `<section class="card">
      <div class="notice">以下為系統依規則自動產生的「待查核線索」，僅供管理者與鄰居進一步了解或詢問之用，<b>不代表</b>任何廠商有重複請款、浪費公帑或其他不當行為。</div>
      ${clues.length ? `<ul class="clues">${clues.map((x, i) => `<li><span class="badge warn">待查核線索</span> <b>${esc(x.title)}</b><div class="sub">${esc(x.detail)}</div>
        <button class="btn btn-sm" data-clue="${i}">查看相關明細（${x.ids.length}）</button></li>`).join('')}</ul>` : '<p class="muted">目前沒有符合規則的線索。</p>'}
      <details><summary>判斷規則</summary><ul class="sub">
        <li>同類修繕金額突然增加：某修繕分類當月金額達前 6 個月平均的 2 倍以上，且差額至少 1 萬元（至少需 2 個月歷史資料）。</li>
        <li>同一設備短期內多次修繕：同一「修繕項目追蹤」在 90 天內出現 2 次以上。</li>
        <li>相似摘要：兩筆修繕摘要文字相似度 60% 以上；相同金額：同一金額（1,000 元以上）出現 2 次以上。</li>
        <li>同一廠商持續收取修繕費：同一廠商在 3 個以上不同月份有修繕支出。</li>
        <li>資料缺漏：修繕支出缺少廠商、日期，或摘要過短。</li></ul></details></section>`;
    body.querySelectorAll('[data-clue]').forEach((b) => (b.onclick = () => { const x = clues[b.dataset.clue]; const ids = new Set(x.ids); drill(D, x.title, D.tx.filter((t) => ids.has(t.id)), dctx); }));
  }
}

function renderItems(body, ctx, s) {
  const D = ctx.D;
  const txById = new Map(D.tx.map((t) => [t.id, t]));
  const items = D.items.map((it) => {
    const rows = D.links.filter((l) => l.repair_item_id === it.id).map((l) => txById.get(l.transaction_id)).filter(Boolean).sort((a, b) => a.ymk - b.ymk);
    return { ...it, rows, cents: rows.reduce((a, t) => a + t.cents, 0) };
  });
  body.innerHTML = `<section class="card"><div class="page-head"><h2>修繕項目追蹤（同一設備或同一工程）</h2>${ctx.admin ? '<button class="btn btn-primary" id="new-item">新增追蹤項目</button>' : ''}</div>
    <p class="sub">把不同月份、不同摘要，但實際屬於同一設備或同一工程的修繕紀錄關聯起來，查看歷次修繕。</p>
    ${items.length ? items.map((it) => `<details class="item"><summary><b>${esc(it.name)}</b> ${it.facility ? `・${esc(it.facility)}` : ''}${it.location ? `・${esc(it.location)}` : ''}
      <span class="sub">${it.rows.length} 次・合計 ${esc(fmtMoney(it.cents))}</span></summary>
      ${it.public_note ? `<p>${esc(it.public_note)}</p>` : ''}
      ${it.rows.length ? `<ol class="timeline">${it.rows.map((t) => `<li><b>${ymShort(t.ymk)}</b> ${esc(fmtMoney(t.cents))}<div class="sub">${esc(t.original_summary)}</div></li>`).join('')}</ol>` : '<p class="muted">尚未關聯任何明細。</p>'}
      ${ctx.admin ? `<div class="actions"><button class="btn btn-sm" data-link="${it.id}">關聯修繕明細</button><button class="btn btn-sm" data-edit-item="${it.id}">編輯</button><button class="btn btn-sm btn-danger" data-del-item="${it.id}">刪除</button></div>` : ''}
    </details>`).join('') : '<p class="muted">尚未建立追蹤項目。</p>'}</section>`;
  if (!ctx.admin) return;
  const itemForm = (it = {}) => {
    const m = modal(it.id ? '編輯追蹤項目' : '新增追蹤項目', `<form id="itf" class="form-grid">
      <label class="span2">名稱 *<input class="input" name="name" required value="${esc(it.name || '')}" placeholder="例如：A 棟 1 號電梯"></label>
      <label>設備／設施<input class="input" name="facility" value="${esc(it.facility || '')}"></label>
      <label>位置<input class="input" name="location" value="${esc(it.location || '')}"></label>
      <label>修繕分類<select class="input" name="repair_category_id">${options([...D.repairCats.values()].map((c) => [c.id, c.name]), it.repair_category_id, { empty: '（未分類）' })}</select></label>
      <label class="span2">公開說明<input class="input" name="public_note" value="${esc(it.public_note || '')}"></label>
      <label class="span2">管理者備註<input class="input" name="admin_note" value="${esc(it.admin_note || '')}"></label>
      <div class="actions span2"><button class="btn btn-primary">儲存</button></div></form>`);
    $('#itf', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const rec = { name: f.name.trim(), facility: f.facility || null, location: f.location || null, repair_category_id: f.repair_category_id ? Number(f.repair_category_id) : null, public_note: f.public_note || null, admin_note: f.admin_note || null };
      try { if (it.id) await q(db().from('repair_items').update(rec).eq('id', it.id)); else await q(db().from('repair_items').insert(rec)); m.close(); await ctx.reload(); ctx.rerender(); }
      catch (err) { toast(err.message, 'error'); }
    };
  };
  $('#new-item', body).onclick = () => itemForm();
  body.querySelectorAll('[data-edit-item]').forEach((b) => (b.onclick = () => itemForm(D.items.find((x) => x.id === Number(b.dataset.editItem)))));
  body.querySelectorAll('[data-del-item]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('刪除追蹤項目', '只會刪除追蹤項目與關聯，不會刪除任何財務明細。', { danger: true }))) return;
    try { await q(db().from('repair_items').delete().eq('id', Number(b.dataset.delItem))); await ctx.reload(); ctx.rerender(); } catch (err) { toast(err.message, 'error'); }
  }));
  body.querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => {
    const itemId = Number(b.dataset.link);
    const linked = new Set(D.links.filter((l) => l.repair_item_id === itemId).map((l) => l.transaction_id));
    const m = modal('關聯修繕明細', `<input class="input" id="lk-q" placeholder="以摘要關鍵字篩選">
      <form id="lk"><div class="link-list">${s.rep.filter((t) => !t.hidden).sort((a, b) => b.ymk - a.ymk).map((t) => `<label class="check link-row" data-text="${esc(t.original_summary + ' ' + t.original_account_name)}"><input type="checkbox" name="t" value="${t.id}" ${linked.has(t.id) ? 'checked' : ''}>
        <span><b>${ymShort(t.ymk)}</b> ${esc(fmtMoney(t.cents))}<br><span class="sub">${esc(t.original_summary)}</span></span></label>`).join('')}</div>
      <div class="actions"><button class="btn btn-primary">儲存關聯</button></div></form>`, { wide: true });
    $('#lk-q', m.el).oninput = (e) => m.el.querySelectorAll('.link-row').forEach((r) => (r.hidden = !r.dataset.text.includes(e.target.value.trim())));
    $('#lk', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const want = new Set([...e.target.querySelectorAll('input[name=t]:checked')].map((x) => Number(x.value)));
      const add = [...want].filter((x) => !linked.has(x)).map((x) => ({ transaction_id: x, repair_item_id: itemId }));
      const del = [...linked].filter((x) => !want.has(x));
      try {
        if (add.length) await q(db().from('transaction_repair_links').insert(add));
        if (del.length) await q(db().from('transaction_repair_links').delete().eq('repair_item_id', itemId).in('transaction_id', del));
        m.close(); await ctx.reload(); ctx.rerender();
      } catch (err) { toast(err.message, 'error'); }
    };
  }));
}
