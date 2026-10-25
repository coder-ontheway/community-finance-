// 首頁財務儀表板
import { dashboard, periods, reconcile } from '../analytics.js';
import { esc, fmtMoney, fmtChange, fmtPct, ymLabel, ymShort, toCents } from '../util.js';
import { chart, drill, periodSelect, PALETTE, moneyTick, $ } from '../ui.js';

let selected = null;

export async function render(view, ctx) {
  const D = ctx.D;
  const ps = periods(D);
  const notice = D.settings.public_notice ? `<div class="notice">${esc(D.settings.public_notice)}</div>` : '';
  if (!ps.length) {
    view.innerHTML = `${notice}<div class="card"><h2>尚無資料</h2><p>${ctx.admin ? '請到「月報表」新增第一份報表並匯入資料。' : '管理者尚未公開任何月報表。'}</p></div>`;
    return;
  }
  if (!ps.includes(selected)) selected = ps[ps.length - 1];
  const k = selected;
  const d = dashboard(D, k);
  const y = Math.floor(k / 100), m = k % 100;
  const r = d.report;
  const rec = r ? reconcile(D, r) : null;
  const pendingAll = D.tx.filter((t) => t.review_status !== 'verified').length;
  const ytdMonths = [...new Set(d.ytdTx.map((t) => t.month))].sort((a, b) => a - b);
  const ytdNote = ytdMonths.length === m ? `1–${m} 月合計` : `已建檔 ${ytdMonths.length} 個月（${ytdMonths.join('、')} 月）合計`;

  const kpi = (label, cents, note, drillKey) => `<button class="kpi" ${drillKey ? `data-drill="${drillKey}"` : ''}>
    <span class="kpi-label">${esc(label)}</span><span class="kpi-value ${cents < 0 ? 'neg' : ''}">${esc(fmtMoney(cents))}</span>
    ${note ? `<span class="kpi-note">${note}</span>` : ''}</button>`;
  const cmpRow = (label, key) => {
    const p = d.prev?.[key], ly = d.lastYear?.[key];
    const a = fmtChange(d.cur[key], p), b = fmtChange(d.cur[key], ly);
    return `<tr><th>${label}</th><td class="num">${esc(fmtMoney(d.cur[key], { unit: false }))}</td>
      <td class="num">${p === undefined ? '—' : esc(fmtMoney(p, { unit: false }))}</td><td class="num ${a.cls}">${esc(a.text)}</td>
      <td class="num">${ly === undefined ? '—' : esc(fmtMoney(ly, { unit: false }))}</td><td class="num ${b.cls}">${esc(b.text)}</td></tr>`;
  };

  view.innerHTML = `
  <div class="page-head">
    <h1>財務儀表板</h1>
    <label class="inline">報表月份 ${periodSelect(D, k)}</label>
  </div>
  ${notice}
  ${ctx.admin && pendingAll ? `<div class="notice warn">目前有 ${pendingAll} 筆交易尚未人工核對（待核對資料不會公開給鄰居）。</div>` : ''}
  ${rec && !rec.ok ? `<div class="notice warn">本月報表核對有差異，請到 <a href="#/report/${r.id}">月報表核對頁</a> 查看。</div>` : ''}

  <section class="kpis">
    ${kpi(`${m} 月總收入`, d.inc, '點擊查看明細', 'inc')}
    ${kpi(`${m} 月總支出`, d.exp, '點擊查看明細', 'exp')}
    ${kpi('本期收支差額', d.net, '收入 − 支出（系統依明細計算）', 'net')}
    ${kpi(`${y} 年累計收入`, d.ytdInc, ytdNote, 'ytdinc')}
    ${kpi(`${y} 年累計支出`, d.ytdExp, ytdNote, 'ytdexp')}
    ${kpi(`${m} 月修繕支出`, d.repMonth, `${y} 年累計 ${esc(fmtMoney(d.repYtd))}`, 'rep')}
  </section>

  <section class="card">
    <h2>結餘（三種不同概念，分開呈現）</h2>
    <div class="balance-grid">
      <div class="balance"><div class="b-title">報表記載的結餘</div>
        <div>本期餘絀：<b>${esc(fmtMoney(toCents(r?.reported_period_balance)))}</b></div>
        <div>累計餘絀：<b>${esc(fmtMoney(toCents(r?.reported_cumulative_balance)))}</b></div>
        <div class="sub">直接取自月報表印出的數字。${r?.reported_figures_note ? `<br><span class="warn-text">${esc(r.reported_figures_note)}</span>` : ''}</div></div>
      <div class="balance"><div class="b-title">系統依交易計算的結餘</div>
        <div>本期：<b>${esc(fmtMoney(d.net))}</b></div>
        <div>累計：<b>${d.cumulative.value === null ? '無法計算' : esc(fmtMoney(d.cumulative.value))}</b></div>
        <div class="sub">${d.cumulative.reason ? esc(d.cumulative.reason) : `起算餘額 ${esc(fmtMoney(toCents(D.settings.opening_balance)))}（${esc(D.settings.opening_balance_label || '')}）＋ 各月收入 − 支出。`}</div></div>
      <div class="balance"><div class="b-title">銀行實際餘額</div>
        <div><b>${r?.bank_balance !== null && r?.bank_balance !== undefined ? esc(fmtMoney(toCents(r.bank_balance))) : '未提供'}</b></div>
        <div class="sub">${r?.bank_balance_date ? `對帳日 ${esc(r.bank_balance_date)}。` : ''}取自銀行存摺或對帳單，與報表結餘可能因時間差、預收款等原因不同。</div></div>
    </div>
  </section>

  <div class="grid-2">
    <section class="card"><h2>${m} 月支出類別占比</h2><p class="sub">點擊圖表區塊可查看組成明細。</p>
      <div class="chart-box"><canvas id="share-chart"></canvas></div>
      <table class="mini">${d.expenseShare.map((s, i) => `<tr class="clickable" data-share="${i}"><td><span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(s.name)}</td><td class="num">${esc(fmtMoney(s.cents, { unit: false }))}</td><td class="num">${fmtPct(s.cents, d.exp)}</td></tr>`).join('')}</table>
    </section>
    <section class="card"><h2>每月收入與支出趨勢</h2><p class="sub">點擊長條可查看該月明細。</p>
      <div class="chart-box"><canvas id="trend-chart"></canvas></div>
    </section>
  </div>

  <section class="card"><h2>與前一月份、去年同月份比較</h2>
    <div class="table-wrap"><table class="cmp"><thead><tr><th></th><th class="num">本月</th><th class="num">前一月</th><th class="num">增減</th><th class="num">去年同月</th><th class="num">增減</th></tr></thead>
    <tbody>${cmpRow('收入', 'income')}${cmpRow('支出', 'expense')}${cmpRow('收支差額', 'net')}</tbody></table></div>
    <p class="sub">「—」表示系統內沒有該月份的報表資料。</p>
  </section>`;

  $('#period', view).onchange = (e) => { selected = Number(e.target.value); render(view, ctx); };
  const dctx = { admin: ctx.admin, onEdit: (id) => ctx.editTx(id) };
  const label = ymLabel(y, m);
  const drills = {
    inc: () => drill(D, `${label} 收入明細`, d.monthTx.filter((t) => t.side === 'income'), dctx),
    exp: () => drill(D, `${label} 支出明細`, d.monthTx.filter((t) => t.side === 'expense'), dctx),
    net: () => drill(D, `${label} 全部明細`, d.monthTx, dctx),
    ytdinc: () => drill(D, `${y} 年累計收入明細（${ytdNote}）`, d.ytdTx.filter((t) => t.side === 'income'), dctx),
    ytdexp: () => drill(D, `${y} 年累計支出明細（${ytdNote}）`, d.ytdTx.filter((t) => t.side === 'expense'), dctx),
    rep: () => drill(D, `${label} 修繕支出明細`, d.monthTx.filter((t) => t.side === 'expense' && t.is_repair), dctx),
  };
  view.querySelectorAll('[data-drill]').forEach((b) => (b.onclick = () => drills[b.dataset.drill]()));
  view.querySelectorAll('[data-share]').forEach((tr) => (tr.onclick = () => { const s = d.expenseShare[tr.dataset.share]; drill(D, `${label}「${s.name}」明細`, s.rows, dctx); }));

  chart($('#share-chart', view), {
    type: 'doughnut',
    data: { labels: d.expenseShare.map((s) => s.name), datasets: [{ data: d.expenseShare.map((s) => s.cents / 100), backgroundColor: d.expenseShare.map((_, i) => PALETTE[i % PALETTE.length]) }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}：${c.parsed.toLocaleString()} 元` } } },
      onClick: (_, els) => { if (els.length) { const s = d.expenseShare[els[0].index]; drill(D, `${label}「${s.name}」明細`, s.rows, dctx); } } },
  });
  chart($('#trend-chart', view), {
    type: 'bar',
    data: { labels: d.trend.map((p) => ymShort(p.ymk)), datasets: [
      { label: '收入', data: d.trend.map((p) => p.income / 100), backgroundColor: '#16a34a' },
      { label: '支出', data: d.trend.map((p) => p.expense / 100), backgroundColor: '#dc2626' }] },
    options: { maintainAspectRatio: false, scales: { y: { ticks: { callback: moneyTick } } },
      plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}：${c.parsed.y.toLocaleString()} 元` } } },
      onClick: (_, els) => { if (!els.length) return; const p = d.trend[els[0].index]; const side = els[0].datasetIndex === 0 ? 'income' : 'expense';
        drill(D, `${ymLabel(Math.floor(p.ymk / 100), p.ymk % 100)} ${side === 'income' ? '收入' : '支出'}明細`, D.tx.filter((t) => t.ymk === p.ymk && t.side === side), dctx); } },
  });
}
