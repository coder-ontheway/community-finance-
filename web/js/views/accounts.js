// 管理費及社區收支科目分析：每個科目的每月金額、全年累計、歷年比較、明細
import { accountStats, periods } from '../analytics.js';
import { esc, fmtMoney, ymShort, fmtPct, SIDE_LABEL } from '../util.js';
import { $, chart, drill, txTable, moneyTick, PALETTE, badge } from '../ui.js';

let mode = 'standard';
let selectedKey = null;

export async function render(view, ctx) {
  const D = ctx.D;
  const list = accountStats(D, mode);
  const years = [...new Set(D.tx.map((t) => t.roc_year))].sort();
  const incTotal = list.filter((a) => a.side === 'income').reduce((s, a) => s + a.cents, 0);
  const expTotal = list.filter((a) => a.side === 'expense').reduce((s, a) => s + a.cents, 0);
  const c = (v) => esc(fmtMoney(v, { unit: false }));
  const yearCell = (a, y) => a.rows.filter((t) => t.roc_year === y).reduce((s, t) => s + t.cents, 0);
  const section = (side) => `<section class="card"><h2>${SIDE_LABEL[side]}科目</h2><div class="table-wrap"><table>
    <thead><tr><th>${mode === 'original' ? '原始科目名稱' : mode === 'category' ? '分析分類' : '標準化科目'}</th>${years.map((y) => `<th class="num">${y} 年累計</th>`).join('')}<th class="num">歷年合計</th><th class="num">占${SIDE_LABEL[side]}</th></tr></thead>
    <tbody>${list.filter((a) => a.side === side).map((a) => `<tr class="clickable ${a.key === selectedKey ? 'selected' : ''}" data-key="${esc(a.key)}"><td>${esc(a.name)}</td>${years.map((y) => `<td class="num">${c(yearCell(a, y))}</td>`).join('')}<td class="num">${c(a.cents)}</td><td class="num">${fmtPct(a.cents, side === 'income' ? incTotal : expTotal)}</td></tr>`).join('')}</tbody></table></div></section>`;

  view.innerHTML = `
  <div class="page-head"><h1>收支科目分析</h1>
    <div class="seg" role="group" aria-label="分組方式">${[['standard', '標準化科目'], ['original', '原始科目'], ['category', '分析分類']].map(([k, l]) => `<button class="seg-btn ${mode === k ? 'active' : ''}" data-mode="${k}">${l}</button>`).join('')}</div></div>
  <p class="sub">科目完全依照實際報表保留；點擊任一科目可查看每月金額、全年累計、歷年比較與明細。</p>
  ${section('income')}${section('expense')}
  <div id="acc-detail"></div>`;

  view.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { mode = b.dataset.mode; selectedKey = null; render(view, ctx); }));
  view.querySelectorAll('[data-key]').forEach((tr) => (tr.onclick = () => { selectedKey = tr.dataset.key; render(view, ctx); setTimeout(() => $('#acc-detail', view).scrollIntoView({ behavior: 'smooth' }), 50); }));
  view.onclick = (e) => { const b = e.target.closest('[data-edit-tx]'); if (b) ctx.editTx(Number(b.dataset.editTx)); };

  const a = list.find((x) => x.key === selectedKey);
  if (!a) return;
  const ps = periods(D);
  const byMonth = new Map(ps.map((p) => [p, []]));
  a.rows.forEach((t) => byMonth.get(t.ymk)?.push(t));
  const monthly = ps.map((p) => ({ ymk: p, cents: byMonth.get(p).reduce((s, t) => s + t.cents, 0), rows: byMonth.get(p) }));
  const det = $('#acc-detail', view);
  det.innerHTML = `<section class="card"><h2>${badge(SIDE_LABEL[a.side], a.side)} ${esc(a.name)}</h2>
    <div class="chart-box"><canvas id="acc-chart"></canvas></div>
    <h3>歷年同月比較</h3><div class="table-wrap"><table><thead><tr><th>月份</th>${years.map((y) => `<th class="num">${y} 年</th>`).join('')}</tr></thead>
    <tbody>${[...Array(12)].map((_, i) => `<tr><td>${i + 1} 月</td>${years.map((y) => { const m = monthly.find((x) => x.ymk === y * 100 + i + 1); return `<td class="num">${m ? c(m.cents) : '<span class="muted">—</span>'}</td>`; }).join('')}</tr>`).join('')}
    <tr class="total"><th>全年累計</th>${years.map((y) => `<td class="num">${c(yearCell(a, y))}</td>`).join('')}</tr></tbody></table></div>
    <p class="sub">「—」表示系統內沒有該月報表。</p>
    <h3>相關明細</h3>${txTable(D, [...a.rows].sort((x, y) => y.ymk - x.ymk), { admin: ctx.admin })}</section>`;
  chart($('#acc-chart', det), {
    type: 'line',
    data: { labels: monthly.map((m) => ymShort(m.ymk)), datasets: [{ label: a.name, data: monthly.map((m) => m.cents / 100), borderColor: PALETTE[0], backgroundColor: PALETTE[0], tension: 0.2 }] },
    options: { maintainAspectRatio: false, scales: { y: { ticks: { callback: moneyTick } } }, plugins: { legend: { display: false } },
      onClick: (_, els) => { if (els.length) { const m = monthly[els[0].index]; drill(D, `${ymShort(m.ymk)} ${a.name}`, m.rows, { admin: ctx.admin, onEdit: ctx.editTx }); } } },
  });
}
