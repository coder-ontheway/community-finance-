// 明細搜尋：年度、月份、科目、廠商、收支類別、關鍵字
import { txTable, options, $, formData } from '../ui.js';
import { accountName, categoryName, vendorName, repairCatName } from '../analytics.js';
import { toCsv, downloadFile, SIDE_LABEL, REVIEW_LABEL, PAYER_LABEL, OCR_LABEL, fromCents } from '../util.js';
import { editTxDialog } from './edit_tx.js';

let filters = {};

export async function render(view, ctx, params) {
  const D = ctx.D;
  if (params[0] === 'q' && params[1]) filters = { keyword: params[1] };
  const years = [...new Set(D.tx.map((t) => t.roc_year))].sort((a, b) => b - a);
  const accs = [...new Set(D.tx.map((t) => accountName(D, t)))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const vendors = [...D.vendors.values()].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name, 'zh-Hant'));
  const cats = [...new Set(D.tx.map((t) => categoryName(D, t)))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));

  view.innerHTML = `
  <div class="page-head"><h1>明細搜尋</h1>
    <div class="actions">${ctx.admin ? '<button class="btn btn-primary" id="add-tx">新增明細</button>' : ''}<button class="btn" id="csv">匯出搜尋結果 CSV</button></div></div>
  <form class="card filters" id="filters">
    <label>年度<select class="input" name="year">${options(years.map((y) => [y, `${y} 年`]), filters.year, { empty: '全部' })}</select></label>
    <label>月份<select class="input" name="month">${options([...Array(12)].map((_, i) => [i + 1, `${i + 1} 月`]), filters.month, { empty: '全部' })}</select></label>
    <label>收入／支出<select class="input" name="side">${options([['income', '收入'], ['expense', '支出']], filters.side, { empty: '全部' })}</select></label>
    <label>科目<select class="input" name="account">${options(accs.map((a) => [a, a]), filters.account, { empty: '全部' })}</select></label>
    <label>分析分類<select class="input" name="category">${options(cats.map((a) => [a, a]), filters.category, { empty: '全部' })}</select></label>
    <label>廠商<select class="input" name="vendor">${options([['none', '（未歸戶／無廠商）'], ...vendors.map((v) => [v.id, v.canonical_name])], filters.vendor, { empty: '全部' })}</select></label>
    <label>修繕<select class="input" name="repair">${options([['1', '只看修繕'], ['0', '排除修繕']], filters.repair, { empty: '全部' })}</select></label>
    ${ctx.admin ? `<label>核對狀態<select class="input" name="review">${options(Object.entries(REVIEW_LABEL), filters.review, { empty: '全部' })}</select></label>` : ''}
    <label class="span2">關鍵字（摘要、科目、廠商）<input class="input" name="keyword" value="${filters.keyword || ''}" placeholder="例如：電梯、防水、監控"></label>
    <div class="actions"><button class="btn btn-primary">搜尋</button><button type="button" class="btn" id="reset">清除</button></div>
  </form>
  <section class="card" id="results"></section>`;

  const apply = () => {
    const f = filters;
    const kws = (f.keyword || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = D.tx.filter((t) =>
      (!f.year || t.roc_year === Number(f.year)) &&
      (!f.month || t.month === Number(f.month)) &&
      (!f.side || t.side === f.side) &&
      (!f.account || accountName(D, t) === f.account) &&
      (!f.category || categoryName(D, t) === f.category) &&
      (!f.vendor || (f.vendor === 'none' ? !t.vendor_id : t.vendor_id === Number(f.vendor))) &&
      (!f.repair || (f.repair === '1' ? t.is_repair : !t.is_repair)) &&
      (!f.review || t.review_status === f.review) &&
      kws.every((k) => [t.original_summary, t.original_account_name, t.counterparty_raw, vendorName(D, t), accountName(D, t), t.original_group, t.public_note, ctx.admin ? t.admin_note : '']
        .some((s) => (s || '').toLowerCase().includes(k))))
      .sort((a, b) => b.ymk - a.ymk || (a.side === b.side ? (a.source_row_no ?? 0) - (b.source_row_no ?? 0) : a.side === 'income' ? -1 : 1));
    $('#results', view).innerHTML = txTable(D, rows, { admin: ctx.admin });
    return rows;
  };
  let rows = apply();

  $('#filters', view).onsubmit = (e) => { e.preventDefault(); filters = formData(e.target); rows = apply(); };
  $('#reset', view).onclick = () => { filters = {}; render(view, ctx, []); };
  $('#results', view).addEventListener('click', (e) => { const b = e.target.closest('[data-edit-tx]'); if (b) ctx.editTx(Number(b.dataset.editTx)); });
  $('#add-tx', view)?.addEventListener('click', () => editTxDialog(ctx, null));
  $('#csv', view).onclick = () => downloadFile(`transactions-search-${new Date().toISOString().slice(0, 10)}.csv`, txCsv(D, rows, ctx.admin), 'text/csv;charset=utf-8');
}

export function txCsv(D, rows, admin) {
  const header = ['交易ID', '報表年度', '報表月份', '收入或支出', '原始大項', '原始科目名稱', '標準化科目', '分析分類', '原始摘要全文', '金額',
    '交易對象原文', '歸戶廠商', '付款方狀態', '交易日期', '日期原文', '修繕', '修繕分類', '報表列號', 'OCR狀態', '人工核對狀態', '公開', '公開備註',
    ...(admin ? ['管理者備註', '待核對欄位'] : []), '最後修改'];
  const body = rows.map((t) => [t.hidden ? '' : t.id, t.roc_year, t.month, SIDE_LABEL[t.side], t.original_group, t.original_account_name, accountName(D, t), categoryName(D, t),
    t.original_summary, fromCents(t.cents), t.counterparty_raw, vendorName(D, t), PAYER_LABEL[t.payer_status], t.transaction_date, t.date_raw,
    t.is_repair ? '是' : '否', t.is_repair ? repairCatName(D, t) : '', t.source_row_no, OCR_LABEL[t.ocr_status] || '', REVIEW_LABEL[t.review_status],
    t.hidden ? '不公開（彙總）' : t.is_public === false ? '否' : '是', t.public_note, ...(admin ? [t.admin_note, t.uncertain_fields] : []), t.updated_at]);
  return toCsv(header, body);
}
