// 月報表清單與新增
import { reconcile } from '../analytics.js';
import { esc, fmtMoney, toCents } from '../util.js';
import { $, modal, toast, formData, badge } from '../ui.js';
import { q, db } from '../api.js';

export async function render(view, ctx) {
  const D = ctx.D;
  const reports = [...D.reports].reverse();
  view.innerHTML = `
  <div class="page-head"><h1>月報表</h1>${ctx.admin ? '<button class="btn btn-primary" id="new-report">新增月報表</button>' : ''}</div>
  ${reports.length ? `<div class="table-wrap card"><table>
    <thead><tr><th>報表月份</th><th class="num">報表收入小計</th><th class="num">報表支出小計</th><th class="num">本期餘絀</th><th class="num">累計餘絀</th><th>核對結果</th><th>狀態</th></tr></thead>
    <tbody>${reports.map((r) => {
      const rec = reconcile(D, r);
      return `<tr class="clickable" data-id="${r.id}">
        <td data-label="月份"><a href="#/report/${r.id}">${r.roc_year} 年 ${r.month} 月</a></td>
        <td data-label="收入小計" class="num">${esc(fmtMoney(toCents(r.reported_income_total), { unit: false }))}</td>
        <td data-label="支出小計" class="num">${esc(fmtMoney(toCents(r.reported_expense_total), { unit: false }))}</td>
        <td data-label="本期餘絀" class="num">${esc(fmtMoney(toCents(r.reported_period_balance), { unit: false }))}</td>
        <td data-label="累計餘絀" class="num">${esc(fmtMoney(toCents(r.reported_cumulative_balance), { unit: false }))}</td>
        <td data-label="核對">${rec.txCount === 0 ? badge('尚無明細', 'muted') : rec.ok ? badge('與報表一致', 'ok') : badge('有差異', 'warn')}</td>
        <td data-label="狀態">${ctx.admin ? (r.is_published ? badge('已公開', 'ok') : badge('未公開', 'muted')) : ''}${rec.pending ? badge(`${rec.pending} 筆待核對`, 'warn') : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : `<div class="card"><p>${ctx.admin ? '尚未建立任何月報表。請按「新增月報表」。' : '目前沒有公開的月報表。'}</p></div>`}`;

  view.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest('a')) ctx.go('report/' + tr.dataset.id); }));
  $('#new-report', view)?.addEventListener('click', () => newReportDialog(ctx));
}

export function newReportDialog(ctx) {
  const now = new Date();
  const m = modal('新增月報表', `<form id="rf" class="form-grid">
    <label>民國年<input class="input" name="roc_year" type="number" min="80" max="200" required value="${now.getFullYear() - 1911}"></label>
    <label>月份<input class="input" name="month" type="number" min="1" max="12" required value="${now.getMonth() + 1}"></label>
    <label class="span2">報表標題（原文）<input class="input" name="title" placeholder="例如：收支月報表"></label>
    <label class="span2">報表期間（原文）<input class="input" name="period_text" placeholder="例如：115年9月1日至115年9月30日"></label>
    <div class="actions span2"><button class="btn btn-primary">建立</button></div></form>`);
  $('#rf', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const y = Number(f.roc_year), mo = Number(f.month);
    if (ctx.D.reports.some((r) => r.roc_year === y && r.month === mo)) {
      toast(`${y} 年 ${mo} 月的報表已經存在，不能重複建立。請直接到該報表補充資料。`, 'error', 8000);
      return;
    }
    try {
      const [row] = await q(db().from('reports').insert({ roc_year: y, month: mo, title: f.title || null, period_text: f.period_text || null }).select());
      m.close(); toast('已建立', 'success');
      await ctx.reload(); ctx.go('report/' + row.id);
    } catch (err) { toast(err.message.includes('duplicate') ? '此年月報表已存在' : err.message, 'error', 8000); }
  };
}
