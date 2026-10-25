// 資料匯出、JSON 完整備份與還原
import { esc, fmtMoney, toCents, toCsv, downloadFile, fromCents, SIDE_LABEL, REVIEW_LABEL } from '../util.js';
import { $, toast, confirmDialog, options } from '../ui.js';
import { fetchAll, rpc } from '../api.js';
import { txCsv } from './transactions.js';
import { reconcile } from '../analytics.js';

const TABLES = ['app_settings', 'analysis_categories', 'repair_categories', 'accounts', 'account_mappings', 'vendors', 'vendor_aliases', 'reports',
  'report_files', 'report_subtotals', 'import_batches', 'transactions', 'import_rows', 'repair_items', 'transaction_repair_links'];
const XLSX_URL = 'vendor/xlsx.full.min.js';
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

export async function render(view, ctx) {
  const D = ctx.D;
  const all = D.tx;
  const verified = all.filter((t) => t.review_status === 'verified');
  const pending = all.filter((t) => t.review_status !== 'verified');
  const s = (rows, side) => rows.filter((t) => t.side === side).reduce((a, t) => a + t.cents, 0);
  const mismatched = D.reports.filter((r) => { const rc = reconcile(D, r); return rc.txCount && !rc.ok; });
  view.innerHTML = `
  <div class="page-head"><h1>匯出與備份</h1></div>
  <section class="card"><h2>匯出前檢查</h2>
    <div class="table-wrap"><table><thead><tr><th></th><th class="num">筆數</th><th class="num">收入合計</th><th class="num">支出合計</th></tr></thead><tbody>
      <tr><th>全部明細</th><td class="num">${all.length}</td><td class="num">${esc(fmtMoney(s(all, 'income')))}</td><td class="num">${esc(fmtMoney(s(all, 'expense')))}</td></tr>
      <tr><th>已核對</th><td class="num">${verified.length}</td><td class="num">${esc(fmtMoney(s(verified, 'income')))}</td><td class="num">${esc(fmtMoney(s(verified, 'expense')))}</td></tr>
      <tr><th>待核對</th><td class="num ${pending.length ? 'warn-text' : ''}">${pending.length}</td><td class="num">${esc(fmtMoney(s(pending, 'income')))}</td><td class="num">${esc(fmtMoney(s(pending, 'expense')))}</td></tr>
    </tbody></table></div>
    <p>月報表 ${D.reports.length} 份；與報表數字不一致：${mismatched.length ? `<span class="warn-text">${mismatched.map((r) => `${r.roc_year}/${r.month}`).join('、')}</span>` : '<span class="ok-text">無</span>'}</p>
  </section>
  <section class="card"><h2>匯出</h2>
    <div class="form-grid"><label>範圍<select class="input" id="scope">${options([['all', '全部明細'], ['verified', '只匯出已核對'], ['pending', '只匯出待核對']], 'all')}</select></label></div>
    <div class="actions">
      <button class="btn" id="csv">交易明細 CSV（Excel 可直接開啟）</button>
      <button class="btn" id="xlsx">完整 Excel 活頁簿（.xlsx）</button>
      <button class="btn" id="srcmap">原始報表來源對照 CSV</button>
      <button class="btn" id="recon">各月核對結果 CSV</button>
    </div>
    <p class="sub">CSV 使用 UTF-8（含 BOM），Excel 開啟時中文不會變亂碼。</p>
  </section>
  <section class="card"><h2>JSON 完整備份</h2>
    <p>包含所有資料表（含待核對資料、匯入批次、修改紀錄）。<b>不包含</b>共同瀏覽密碼、管理者密碼及報表圖片檔本身（圖片存放於 Supabase Storage，備份內有檔名與 SHA-256 對照）。</p>
    <button class="btn btn-primary" id="backup">下載 JSON 完整備份</button>
  </section>
  <section class="card"><h2>從 JSON 備份還原</h2>
    <p class="sub">還原前會先顯示備份內容與現有資料的比對，並自動下載一份目前資料的備份。預設只新增目前沒有的資料，不會覆蓋。</p>
    <input type="file" id="restore-file" accept=".json,application/json">
    <div id="restore-preview"></div>
  </section>`;

  const scopeRows = () => ({ all, verified, pending }[$('#scope', view).value]);
  $('#csv', view).onclick = () => downloadFile(`transactions-${$('#scope', view).value}-${stamp()}.csv`, txCsv(D, scopeRows(), true), 'text/csv;charset=utf-8');
  $('#srcmap', view).onclick = () => {
    const files = new Map(ctx.raw.files.map((f) => [f.id, f]));
    const header = ['交易ID', '報表年度', '報表月份', '收支', '原始科目', '金額', '報表列號', '來源檔名', '儲存路徑', '檔案SHA-256', '匯入批次', '核對狀態'];
    const rows = scopeRows().map((t) => { const raw = ctx.raw.transactions.find((x) => x.id === t.id) || {}; const f = files.get(raw.source_file_id);
      return [t.id, t.roc_year, t.month, SIDE_LABEL[t.side], t.original_account_name, fromCents(t.cents), t.source_row_no, f?.original_name, f?.storage_path, f?.sha256, raw.import_batch_id, REVIEW_LABEL[t.review_status]]; });
    downloadFile(`source-map-${stamp()}.csv`, toCsv(header, rows), 'text/csv;charset=utf-8');
  };
  $('#recon', view).onclick = () => {
    const header = ['報表年度', '報表月份', '項目', '報表數字', '系統計算', '差額'];
    const rows = [];
    for (const r of D.reports) { const rc = reconcile(D, r);
      for (const x of [...rc.rows, ...rc.groupRows]) rows.push([r.roc_year, r.month, x.label, fromCents(x.reported), fromCents(x.system), fromCents(x.diff)]); }
    downloadFile(`reconciliation-${stamp()}.csv`, toCsv(header, rows), 'text/csv;charset=utf-8');
  };
  $('#xlsx', view).onclick = async () => {
    try {
      await loadScript(XLSX_URL);
      const data = await fullBackup();
      const wb = window.XLSX.utils.book_new();
      const csvRows = (txt) => txt.replace(/^﻿/, '').split('\r\n').map(parseCsvLine);
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(csvRows(txCsv(D, scopeRows(), true))), '交易明細');
      for (const t of TABLES.filter((x) => x !== 'transactions')) {
        const rows = data.tables[t] || [];
        window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v])))), t.slice(0, 31));
      }
      const buf = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      downloadFile(`community-finance-${stamp()}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (err) { toast('Excel 匯出失敗：' + err.message, 'error'); }
  };
  $('#backup', view).onclick = async () => {
    try { const data = await fullBackup(); downloadFile(`community-finance-backup-${stamp()}.json`, JSON.stringify(data, null, 1), 'application/json'); toast('備份已下載', 'success'); }
    catch (err) { toast('備份失敗：' + err.message, 'error'); }
  };
  $('#restore-file', view).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { toast('不是有效的 JSON 檔', 'error'); return; }
    if (data.format !== 'community-finance-backup') { toast('這不是本系統產生的備份檔', 'error'); return; }
    const current = await fullBackup();
    const pk = (t, r) => (t === 'transaction_repair_links' ? `${r.transaction_id}-${r.repair_item_id}` : String(r.id));
    const stats = TABLES.map((t) => {
      const cur = new Set((current.tables[t] || []).map((r) => pk(t, r)));
      const rows = data.tables?.[t] || [];
      const conflict = rows.filter((r) => cur.has(pk(t, r))).length;
      return { t, backup: rows.length, current: cur.size, conflict, fresh: rows.length - conflict };
    });
    const chk = data.checks || {};
    $('#restore-preview', view).innerHTML = `<h3>備份內容（建立於 ${esc(data.created_at || '?')}）</h3>
      ${chk.transactions ? `<p class="sub">備份內交易：${chk.transactions.count} 筆，收入 ${esc(fmtMoney(toCents(chk.transactions.income)))}、支出 ${esc(fmtMoney(toCents(chk.transactions.expense)))}</p>` : ''}
      <div class="table-wrap"><table><thead><tr><th>資料表</th><th class="num">備份筆數</th><th class="num">目前筆數</th><th class="num">ID 相同（衝突）</th><th class="num">將新增</th></tr></thead>
      <tbody>${stats.map((x) => `<tr><td>${x.t}</td><td class="num">${x.backup}</td><td class="num">${x.current}</td><td class="num ${x.conflict ? 'warn-text' : ''}">${x.conflict}</td><td class="num">${x.fresh}</td></tr>`).join('')}</tbody></table></div>
      <label>還原方式<select class="input" id="mode">${options([['insert_missing', '只新增目前沒有的資料（不覆蓋，建議）'], ['overwrite', '以備份覆蓋 ID 相同的資料（危險）']], 'insert_missing')}</select></label>
      <div class="actions"><button class="btn btn-danger" id="do-restore">開始還原</button></div>`;
    $('#do-restore', view).onclick = async () => {
      const mode = $('#mode', view).value;
      const word = mode === 'overwrite' ? '確認覆蓋' : '確認還原';
      const conflicts = stats.reduce((a, x) => a + x.conflict, 0);
      const ok = await confirmDialog('確認還原', `${mode === 'overwrite' ? `將以備份內容覆蓋 ${conflicts} 筆 ID 相同的現有資料。` : `將新增 ${stats.reduce((a, x) => a + x.fresh, 0)} 筆資料，ID 相同的 ${conflicts} 筆會略過、不覆蓋。`}\n開始前會自動下載目前資料的備份。`, { danger: true, requireText: word });
      if (!ok) return;
      downloadFile(`pre-restore-backup-${stamp()}.json`, JSON.stringify(current, null, 1), 'application/json');
      try {
        const res = await rpc('restore_backup', { p_backup: data, p_mode: mode, p_confirm: word });
        toast('還原完成', 'success', 6000);
        $('#restore-preview', view).innerHTML = `<div class="notice ok">還原完成：${Object.entries(res.tables).map(([t, x]) => `${t} 寫入 ${x.written}/${x.in_backup}`).join('、')}</div>`;
        await ctx.reload();
      } catch (err) { toast('還原失敗（資料未變更）：' + err.message, 'error', 10000); }
    };
  };
}

export async function fullBackup() {
  const tables = {};
  for (const t of [...TABLES, 'audit_log']) tables[t] = await fetchAll(t, { order: t === 'transaction_repair_links' ? 'transaction_id' : 'id' });
  const tx = tables.transactions;
  const sumSide = (side) => tx.filter((t) => t.side === side).reduce((a, t) => a + toCents(t.amount), 0) / 100;
  return {
    format: 'community-finance-backup', version: 1, created_at: new Date().toISOString(),
    note: '不含共同瀏覽密碼、管理者密碼與報表圖片檔本身。',
    checks: { transactions: { count: tx.length, income: sumSide('income'), expense: sumSide('expense'),
      verified: tx.filter((t) => t.review_status === 'verified').length, pending: tx.filter((t) => t.review_status !== 'verified').length },
      counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])) },
    tables,
  };
}

function loadScript(src) {
  return new Promise((res, rej) => { if (window.XLSX) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('無法載入 Excel 元件')); document.head.appendChild(s); });
}
function parseCsvLine(line) {
  const out = []; let cur = ''; let qd = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (qd) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') qd = false; else cur += ch; }
    else if (ch === '"') qd = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
