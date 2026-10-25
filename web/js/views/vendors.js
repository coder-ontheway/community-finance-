// 廠商財務分析
import { vendorStats, vendorDetail } from '../analytics.js';
import { esc, fmtMoney, ymShort, SIDE_LABEL } from '../util.js';
import { $, chart, drill, txTable, moneyTick, badge } from '../ui.js';

const LIMIT_NOTICE = `資料限制：本分析只使用社區收支月報表。報表只記載社區付出與收到的金額，
無法得知廠商的成本與利潤，也無法判斷社區是否因此「獲利」。「收支差額」只是兩個金額相減，不代表任何一方的商業利潤。`;

export async function render(view, ctx, params, route) {
  if (route === 'vendor') return renderDetail(view, ctx, Number(params[0]));
  const D = ctx.D;
  const stats = vendorStats(D).filter((s) => s.rows.length);
  const unlinked = D.tx.filter((t) => !t.vendor_id && t.counterparty_raw && !t.hidden);
  const unconfirmedIncome = D.tx.filter((t) => t.side === 'income' && t.payer_status === 'unconfirmed');
  const sumC = (rows) => rows.reduce((s, t) => s + t.cents, 0);
  view.innerHTML = `
  <div class="page-head"><h1>廠商財務分析</h1></div>
  <div class="notice pre">${esc(D.settings.data_limit_notice || LIMIT_NOTICE)}</div>
  <section class="card">
    <h2>三種金額分開計算</h2>
    <ul class="plain">
      <li><b>A. 社區支付給廠商的費用</b>（廠商收款金額）：報表「支出」中歸戶到該廠商的明細。</li>
      <li><b>B. 廠商支付給社區的收入</b>：報表「收入」中，管理者已確認付款方是該廠商的明細。</li>
      <li><b>C. 報表記載的收入，但尚未確認實際付款方</b>：不計入 B，另外列出。</li>
    </ul>
  </section>
  <section class="card">
    <h2>廠商一覽</h2>
    ${stats.length ? `<div class="table-wrap"><table>
      <thead><tr><th>廠商</th><th class="num">A. 社區付給廠商</th><th class="num">B. 廠商付給社區</th><th class="num">C. 未確認付款方收入</th><th class="num">收支差額（B − A）</th><th class="num">筆數</th></tr></thead>
      <tbody>${stats.map((s) => `<tr class="clickable" data-v="${s.vendor.id}"><td data-label="廠商"><a href="#/vendor/${s.vendor.id}">${esc(s.vendor.canonical_name)}</a></td>
        <td data-label="A" class="num">${esc(fmtMoney(s.paid, { unit: false }))}</td><td data-label="B" class="num">${esc(fmtMoney(s.received, { unit: false }))}</td>
        <td data-label="C" class="num">${esc(fmtMoney(s.unconfirmed, { unit: false }))}</td><td data-label="差額" class="num ${s.net < 0 ? 'neg' : ''}">${esc(fmtMoney(s.net, { unit: false }))}</td><td data-label="筆數" class="num">${s.rows.length}</td></tr>`).join('')}</tbody></table></div>
      <p class="sub">收支差額 = 廠商付給社區（B）− 社區付給廠商（A）。負數表示社區付出較多，這是一般採購的正常情形，不代表虧損。</p>`
    : `<p class="muted">尚未有歸戶的廠商。${ctx.admin ? '請到「科目／廠商設定」確認廠商別名。' : ''}</p>`}
  </section>
  <section class="card"><h2>C. 報表記載收入，付款方尚未確認（${unconfirmedIncome.length} 筆，${esc(fmtMoney(sumC(unconfirmedIncome)))}）</h2>
    <button class="btn" id="show-c">查看明細</button></section>
  ${unlinked.length ? `<section class="card"><h2>尚未歸戶的交易對象名稱（${new Set(unlinked.map((t) => t.counterparty_raw)).size} 個）</h2>
    <p class="sub">這些名稱出現在報表摘要中，但管理者尚未確認屬於哪一家廠商，因此不列入上方統計。</p>
    <div class="chips">${[...new Set(unlinked.map((t) => t.counterparty_raw))].map((n) => `<button class="chip" data-raw="${esc(n)}">${esc(n)}</button>`).join('')}</div></section>` : ''}`;

  view.querySelectorAll('tr[data-v]').forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest('a')) ctx.go('vendor/' + tr.dataset.v); }));
  $('#show-c', view).onclick = () => drill(D, 'C. 報表記載收入、付款方未確認', unconfirmedIncome, { admin: ctx.admin, onEdit: ctx.editTx });
  view.querySelectorAll('[data-raw]').forEach((b) => (b.onclick = () => drill(D, `交易對象原文：${b.dataset.raw}`, unlinked.filter((t) => t.counterparty_raw === b.dataset.raw), { admin: ctx.admin, onEdit: ctx.editTx })));
}

function renderDetail(view, ctx, id) {
  const D = ctx.D;
  const v = D.vendors.get(id);
  if (!v) { view.innerHTML = '<div class="card"><h2>找不到此廠商</h2></div>'; return; }
  const d = vendorDetail(D, id);
  const tot = d.yearly.reduce((a, y) => ({ paid: a.paid + y.paid, received: a.received + y.received, unconfirmed: a.unconfirmed + y.unconfirmed }), { paid: 0, received: 0, unconfirmed: 0 });
  const aliases = ctx.raw.aliases.filter((a) => a.vendor_id === id && a.status === 'confirmed');
  view.innerHTML = `
  <div class="page-head"><h1>${esc(v.canonical_name)}</h1><a class="btn" href="#/vendors">回廠商一覽</a></div>
  ${v.public_note ? `<p>${esc(v.public_note)}</p>` : ''}
  ${ctx.admin && aliases.length ? `<p class="sub">已確認的別名：${aliases.map((a) => esc(a.alias_name)).join('、')}</p>` : ''}
  <div class="notice pre">${esc(D.settings.data_limit_notice || LIMIT_NOTICE)}</div>
  <section class="kpis">
    <div class="kpi"><span class="kpi-label">A. 廠商收款金額（社區付給廠商，歷年累計）</span><span class="kpi-value">${esc(fmtMoney(tot.paid))}</span></div>
    <div class="kpi"><span class="kpi-label">B. 廠商付款給社區的金額（已確認，歷年累計）</span><span class="kpi-value">${esc(fmtMoney(tot.received))}</span></div>
    <div class="kpi"><span class="kpi-label">C. 未確認付款方的收入</span><span class="kpi-value">${esc(fmtMoney(tot.unconfirmed))}</span></div>
    <div class="kpi"><span class="kpi-label">社區與廠商的收支差額（B − A）</span><span class="kpi-value ${tot.received - tot.paid < 0 ? 'neg' : ''}">${esc(fmtMoney(tot.received - tot.paid))}</span><span class="kpi-note">不是利潤</span></div>
  </section>
  <section class="card"><h2>各月份金額變化</h2><div class="chart-box"><canvas id="v-chart"></canvas></div>
    <div class="table-wrap"><table><thead><tr><th>月份</th><th class="num">A. 社區付給廠商</th><th class="num">B. 廠商付給社區</th><th class="num">C. 未確認</th></tr></thead>
    <tbody>${d.monthly.map((m, i) => `<tr class="clickable" data-m="${i}"><td>${ymShort(m.ymk)}</td><td class="num">${esc(fmtMoney(m.paid, { unit: false }))}</td><td class="num">${esc(fmtMoney(m.received, { unit: false }))}</td><td class="num">${esc(fmtMoney(m.unconfirmed, { unit: false }))}</td></tr>`).join('')}</tbody></table></div></section>
  <section class="card"><h2>每年合計</h2><div class="table-wrap"><table><thead><tr><th>年度</th><th class="num">A. 社區付給廠商</th><th class="num">B. 廠商付給社區</th><th class="num">C. 未確認</th><th class="num">差額（B − A）</th></tr></thead>
    <tbody>${d.yearly.map((y) => `<tr><td>${y.year} 年</td><td class="num">${esc(fmtMoney(y.paid, { unit: false }))}</td><td class="num">${esc(fmtMoney(y.received, { unit: false }))}</td><td class="num">${esc(fmtMoney(y.unconfirmed, { unit: false }))}</td><td class="num">${esc(fmtMoney(y.received - y.paid, { unit: false }))}</td></tr>`).join('')}</tbody></table></div></section>
  <section class="card"><h2>對應的財務科目</h2><ul class="plain">${d.accounts.map((a) => `<li>${badge(SIDE_LABEL[a.side], a.side)} ${esc(a.name)}：${esc(fmtMoney(a.cents))}（${a.count} 筆）</li>`).join('')}</ul></section>
  <section class="card"><h2>相關交易明細與原始摘要</h2>${txTable(D, [...d.rows].sort((a, b) => b.ymk - a.ymk), { admin: ctx.admin })}</section>`;

  view.onclick = (e) => { const b = e.target.closest('[data-edit-tx]'); if (b) ctx.editTx(Number(b.dataset.editTx)); };
  view.querySelectorAll('[data-m]').forEach((tr) => (tr.onclick = () => { const m = d.monthly[tr.dataset.m]; drill(D, `${ymShort(m.ymk)} ${v.canonical_name}`, m.rows, { admin: ctx.admin, onEdit: ctx.editTx }); }));
  chart($('#v-chart', view), {
    type: 'bar',
    data: { labels: d.monthly.map((m) => ymShort(m.ymk)), datasets: [
      { label: 'A. 社區付給廠商', data: d.monthly.map((m) => m.paid / 100), backgroundColor: '#dc2626' },
      { label: 'B. 廠商付給社區', data: d.monthly.map((m) => m.received / 100), backgroundColor: '#16a34a' },
      { label: 'C. 未確認付款方', data: d.monthly.map((m) => m.unconfirmed / 100), backgroundColor: '#d97706' }] },
    options: { maintainAspectRatio: false, scales: { y: { ticks: { callback: moneyTick } } },
      onClick: (_, els) => { if (els.length) { const m = d.monthly[els[0].index]; drill(D, `${ymShort(m.ymk)} ${v.canonical_name}`, m.rows, { admin: ctx.admin, onEdit: ctx.editTx }); } } },
  });
}
