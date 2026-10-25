// 資料修改紀錄（只有管理者可讀；資料庫觸發器自動寫入，網站無法修改或刪除）
import { esc, fmtTime } from '../util.js';
import { $, options } from '../ui.js';
import { q, db } from '../api.js';

const TABLE_LABEL = {
  transactions: '交易明細', reports: '月報表', report_subtotals: '報表小計', report_files: '報表檔案', vendors: '廠商', vendor_aliases: '廠商別名',
  accounts: '科目', account_mappings: '科目對照', analysis_categories: '分析分類', repair_categories: '修繕分類', repair_items: '修繕項目',
  transaction_repair_links: '修繕項目關聯', app_settings: '網站設定', import_batches: '匯入批次', app_admins: '管理者', viewer_password: '共同瀏覽密碼',
  viewer_sessions: '瀏覽工作階段', backup: '備份還原',
};
const ACTION_LABEL = { INSERT: '新增', UPDATE: '修改', DELETE: '刪除' };
let filter = '';
let page = 0;

export async function render(view) {
  let query = db().from('audit_log').select('*').order('id', { ascending: false }).range(page * 100, page * 100 + 99);
  if (filter) query = query.eq('table_name', filter);
  const rows = await q(query);
  view.innerHTML = `<div class="page-head"><h1>資料修改紀錄</h1>
    <label class="inline">資料表 <select class="input input-inline" id="tf">${options(Object.entries(TABLE_LABEL), filter, { empty: '全部' })}</select></label></div>
    <p class="sub">所有新增、修改、刪除都由資料庫自動記錄（含修改前後內容），網站上無法變更這些紀錄。</p>
    <div class="card">${rows.length ? rows.map((r) => `<details class="audit"><summary><span class="sub">${fmtTime(r.at)}</span>
      <b>${esc(ACTION_LABEL[r.action] || r.action)}</b> ${esc(TABLE_LABEL[r.table_name] || r.table_name)} #${esc(r.row_pk || '')} ${summary(r)}</summary>
      ${diff(r)}</details>`).join('') : '<p class="muted">沒有紀錄。</p>'}
    <div class="actions">${page > 0 ? '<button class="btn" id="prev">較新</button>' : ''}${rows.length === 100 ? '<button class="btn" id="next">較舊</button>' : ''}</div></div>`;
  $('#tf', view).onchange = (e) => { filter = e.target.value; page = 0; render(view); };
  $('#prev', view)?.addEventListener('click', () => { page--; render(view); });
  $('#next', view)?.addEventListener('click', () => { page++; render(view); });
}

function summary(r) {
  const d = r.new_data || r.old_data || {};
  const s = d.original_summary || d.canonical_name || d.alias_name || d.name || d.standard_name || (d.roc_year ? `${d.roc_year} 年 ${d.month} 月` : '');
  return s ? `<span class="sub">「${esc(String(s).slice(0, 40))}」</span>` : '';
}

function diff(r) {
  if (r.action === 'UPDATE' && r.old_data && r.new_data) {
    const keys = Object.keys(r.new_data).filter((k) => k !== 'updated_at' && JSON.stringify(r.old_data[k]) !== JSON.stringify(r.new_data[k]));
    return `<table class="mini"><thead><tr><th>欄位</th><th>修改前</th><th>修改後</th></tr></thead><tbody>${keys.map((k) => `<tr><td>${esc(k)}</td><td class="pre">${esc(JSON.stringify(r.old_data[k]))}</td><td class="pre">${esc(JSON.stringify(r.new_data[k]))}</td></tr>`).join('')}</tbody></table>`;
  }
  return `<pre class="json">${esc(JSON.stringify(r.new_data || r.old_data, null, 2))}</pre>`;
}
