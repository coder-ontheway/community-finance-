// 匯入核對區：OCR／JSON／貼上／手動輸入 → 逐筆核對 → 確認後才寫入正式資料
import { esc, fmtMoney, toCents, parseAmount, ROW_TYPE_LABEL, PAYER_LABEL, REVIEW_LABEL, OCR_LABEL } from '../util.js';
import { $, $$, toast, modal, confirmDialog, options, badge } from '../ui.js';
import { q, db, rpc } from '../api.js';
import { recognize, parseLines, parsePasted, suggestRepairCategory } from '../ocr.js';

let rows = [];
let removed = [];
let dirty = false;
let saveTimer = null;

export async function render(view, ctx, [idStr]) {
  const id = Number(idStr);
  const batch = (await q(db().from('import_batches').select('*').eq('id', id)))[0];
  if (!batch) { view.innerHTML = '<div class="card"><h2>找不到匯入批次</h2></div>'; return; }
  const report = ctx.D.reports.find((r) => r.id === batch.report_id);
  rows = await q(db().from('import_rows').select('*').eq('batch_id', id).order('row_no'));
  removed = []; dirty = false;
  const readOnly = batch.status !== 'open';
  const file = ctx.raw.files.find((f) => f.id === batch.file_id);
  const cats = [...ctx.D.categories.values()].sort((a, b) => a.sort_order - b.sort_order);
  const rcats = [...ctx.D.repairCats.values()].sort((a, b) => a.sort_order - b.sort_order);

  view.innerHTML = `
  <div class="page-head"><h1>匯入核對：${report.roc_year} 年 ${report.month} 月</h1>
    <a class="btn" href="#/report/${report.id}">回到報表</a></div>
  <div class="notice ${readOnly ? '' : 'warn'}">${readOnly
    ? `此批次已${batch.status === 'committed' ? '寫入正式資料' : '捨棄'}，僅供檢視。`
    : '這裡的資料尚未成為正式財務資料，不會出現在任何統計中。請對照原始報表逐筆核對，確認無誤後再按「寫入正式資料」。'}</div>

  ${!readOnly ? `<section class="card" id="source-panel">
    ${batch.method === 'ocr' ? `
      <h2>OCR 辨識</h2>
      <p class="sub">報表左右兩欄分別是收入與支出。建議先框選「收入區」辨識，再框選「支出區」辨識，準確度較高。手機上可用手指拖曳框選。</p>
      <div class="actions"><button class="btn" data-region="income">框選收入區並辨識</button><button class="btn" data-region="expense">框選支出區並辨識</button>
        <button class="btn" data-region="all">整張辨識</button></div>
      <div class="ocr-stage" id="ocr-stage"><img id="ocr-img" alt="原始報表"><div id="sel-box" class="sel-box" hidden></div></div>
      <div class="actions" id="region-actions" hidden><span id="region-label"></span><button class="btn btn-primary" id="run-ocr">開始辨識選取範圍</button><button class="btn" id="cancel-region">取消</button></div>
      <p id="ocr-progress" class="sub" role="status"></p>` : ''}
    ${batch.method === 'json' ? `<h2>匯入 JSON 檔</h2><p class="sub">檔案格式見部署說明。匯入後仍需逐筆核對。</p><input type="file" id="json-file" accept=".json,application/json">` : ''}
    ${batch.method === 'paste' ? `<h2>貼上表格文字</h2><p class="sub">可從 Excel 複製（欄位依序：收支、大項、科目、摘要、金額、交易對象），或直接貼上報表文字。</p>
      <textarea class="input" id="paste-text" rows="8"></textarea><button class="btn" id="parse-paste">解析</button>` : ''}
    <div class="actions"><button class="btn" id="add-row">新增一列</button></div>
  </section>` : ''}

  ${file ? `<details class="card" ${batch.method !== 'ocr' ? 'open' : ''}><summary>對照原始報表圖片</summary><div class="ref-img"><img id="ref-img" alt="原始報表"></div></details>` : ''}

  <section class="card sticky-totals" id="totals"></section>

  <section class="card">
    <div class="page-head"><h2>核對清單（<span id="row-count"></span> 列）</h2>
      ${!readOnly ? `<div class="actions"><button class="btn" id="save">儲存草稿</button><button class="btn" id="verify-all">全部標記已核對</button>
        <button class="btn btn-primary" id="commit">寫入正式資料</button><button class="btn btn-danger" id="discard">捨棄批次</button></div>` : ''}</div>
    <p class="sub" id="save-state"></p>
    <div id="rows"></div>
  </section>`;

  // 原始圖片（以授權下載取得，避免公開網址）
  let imgUrl = null;
  if (file) {
    const { data: blob, error } = await db().storage.from('report-files').download(file.storage_path);
    if (!error) {
      imgUrl = URL.createObjectURL(blob);
      if ($('#ocr-img', view)) $('#ocr-img', view).src = imgUrl;
      if ($('#ref-img', view)) $('#ref-img', view).src = imgUrl;
    }
  }

  const renderRows = () => {
    $('#row-count', view).textContent = rows.length;
    $('#rows', view).innerHTML = rows.map((r, i) => rowCard(r, i, { cats, rcats, readOnly })).join('') || '<p class="muted">尚無資料列。</p>';
    renderTotals();
  };
  const renderTotals = () => {
    const det = rows.filter((r) => r.row_type === 'detail');
    const s = (side) => det.filter((r) => r.side === side).reduce((a, r) => a + (toCents(r.amount) || 0), 0);
    const fig = (type) => { const r = rows.find((x) => x.row_type === type); return r ? toCents(r.amount) : null; };
    const inc = s('income'), exp = s('expense');
    const line = (label, sys, rep) => `<tr><th>${label}</th><td class="num">${esc(fmtMoney(sys, { unit: false }))}</td><td class="num">${rep === null ? '—' : esc(fmtMoney(rep, { unit: false }))}</td>
      <td class="num ${rep === null ? '' : sys === rep ? 'ok-text' : 'warn-text strong'}">${rep === null ? '—' : sys === rep ? '一致' : esc(fmtMoney(sys - rep, { sign: true }))}</td></tr>`;
    const groups = rows.filter((r) => r.row_type === 'group_subtotal');
    const unverified = rows.filter((r) => r.row_type !== 'ignore' && r.review_status !== 'verified').length;
    const uncertain = rows.filter((r) => r.row_type !== 'ignore' && (r.uncertain_fields || []).length && r.review_status !== 'verified').length;
    $('#totals', view).innerHTML = `<h2>即時加總比對</h2>
      <p>${badge(`未核對 ${unverified} 列`, unverified ? 'warn' : 'ok')} ${badge(`待人工核對欄位 ${uncertain} 列`, uncertain ? 'warn' : 'ok')}</p>
      <div class="table-wrap"><table class="recon"><thead><tr><th></th><th class="num">明細加總</th><th class="num">報表數字（核對區）</th><th class="num">差額</th></tr></thead><tbody>
      ${line('收入小計', inc, fig('income_total'))}${line('支出小計', exp, fig('expense_total'))}${line('本期餘絀', inc - exp, fig('period_balance'))}
      ${fig('prior_balance') !== null ? line('累計餘絀（前期＋本期明細）', fig('prior_balance') + inc - exp, fig('cumulative_balance')) : ''}
      ${groups.map((g) => line(esc(g.original_group || g.original_account_name), det.filter((r) => r.side === g.side && r.original_group === g.original_group).reduce((a, r) => a + (toCents(r.amount) || 0), 0), toCents(g.amount))).join('')}
      </tbody></table></div>
      <p class="sub">已登錄的正式報表數字：收入 ${esc(fmtMoney(toCents(report.reported_income_total)))}、支出 ${esc(fmtMoney(toCents(report.reported_expense_total)))}。</p>`;
  };
  renderRows();
  if (readOnly) return;

  const markDirty = () => {
    dirty = true; $('#save-state', view).textContent = '有尚未儲存的變更（2 秒後自動儲存）';
    clearTimeout(saveTimer); saveTimer = setTimeout(() => save(), 2000);
  };
  const save = async () => {
    clearTimeout(saveTimer);
    if (!dirty) return true;
    try {
      rows.forEach((r, i) => (r.row_no = i + 1));
      const pick = (r) => ({
        batch_id: id, row_no: r.row_no, row_type: r.row_type, side: r.side || null, original_group: r.original_group || null,
        original_account_name: r.original_account_name || null, original_summary: r.original_summary ?? null, amount_raw: r.amount_raw ?? null,
        amount: r.amount === '' || r.amount === undefined ? null : r.amount, counterparty_raw: r.counterparty_raw || null,
        payer_status: r.side === 'income' ? r.payer_status || 'unconfirmed' : 'not_applicable', date_raw: r.date_raw || null, transaction_date: r.transaction_date || null,
        analysis_category_id: r.analysis_category_id || null, is_repair: r.is_repair ?? null, repair_category_id: r.repair_category_id || null,
        is_public: r.is_public !== false, ocr_status: r.ocr_status || 'manual', confidence: r.confidence ?? null, uncertain_fields: r.uncertain_fields || [],
        review_status: r.review_status || 'pending', note: r.note || null,
      });
      if (removed.length) await q(db().from('import_rows').delete().in('id', removed));
      removed = [];
      // 先把既有列的 row_no 移開，避免與新順序衝突
      const existing = rows.filter((r) => r.id);
      if (existing.length) {
        await q(db().from('import_rows').upsert(existing.map((r) => ({ id: r.id, ...pick(r), row_no: -r.id }))));
        await q(db().from('import_rows').upsert(existing.map((r) => ({ id: r.id, ...pick(r) }))));
      }
      const fresh = rows.filter((r) => !r.id);
      if (fresh.length) {
        const ins = await q(db().from('import_rows').insert(fresh.map(pick)).select('id,row_no'));
        for (const x of ins) { const r = rows.find((y) => !y.id && y.row_no === x.row_no); if (r) r.id = x.id; }
      }
      dirty = false;
      $('#save-state', view).textContent = `已儲存（${new Date().toLocaleTimeString('zh-TW', { hour12: false })}）`;
      return true;
    } catch (err) { toast('儲存失敗：' + err.message, 'error', 8000); $('#save-state', view).textContent = '儲存失敗'; return false; }
  };
  window.onbeforeunload = () => (dirty ? '尚有未儲存的變更' : undefined);

  const addRows = (newRows) => {
    for (const r of newRows) {
      if (r.row_type === 'detail' && r.side === 'expense' && r.is_repair === undefined && /修繕|修繕費|維修/.test((r.original_account_name || '') + (r.original_group || ''))) {
        r.is_repair = true;
        r.repair_category_id = r.repair_category_id || suggestRepairCategory(r.original_summary, rcats);
      }
      if (r.row_type === 'detail' && r.side === 'income' && !r.payer_status) r.payer_status = 'unconfirmed';
      if (r.row_type === 'detail' && !r.analysis_category_id) {
        const acc = [...ctx.D.accounts.values()].find((a) => a.side === r.side && a.standard_name === r.original_account_name);
        if (acc) { r.analysis_category_id = acc.analysis_category_id; if (r.is_repair === undefined) r.is_repair = acc.is_repair; }
      }
      if (/(\d+號|\d+樓之?\d*|戶別|欠費|住戶)/.test(r.original_summary || '') && r.row_type === 'detail') {
        r.is_public = false;
        r.note = [r.note, '摘要可能含住戶個資，預設不公開明細'].filter(Boolean).join('；');
      }
      rows.push(r);
    }
    markDirty(); renderRows();
  };

  // 欄位編輯
  $('#rows', view).addEventListener('change', (e) => {
    const el = e.target; const card = el.closest('[data-i]'); if (!card || !el.name) return;
    const r = rows[Number(card.dataset.i)];
    if (el.type === 'checkbox') r[el.name] = el.checked;
    else if (el.name === 'amount') {
      const v = parseAmount(el.value);
      if (el.value.trim() && v === null) { toast('金額格式不正確', 'error'); el.focus(); return; }
      r.amount = v; r.uncertain_fields = (r.uncertain_fields || []).filter((x) => x !== '金額' || v === null);
    } else if (['analysis_category_id', 'repair_category_id'].includes(el.name)) r[el.name] = el.value ? Number(el.value) : null;
    else r[el.name] = el.value;
    if (el.name !== 'review_status' && r.review_status === 'verified') { r.review_status = 'pending'; toast('內容已修改，此列改回「待核對」，請再次確認。', 'info'); }
    markDirty();
    if (['row_type', 'side', 'review_status', 'amount', 'is_repair', 'original_group'].includes(el.name)) renderRows(); else renderTotals();
  });
  $('#rows', view).addEventListener('click', (e) => {
    const card = e.target.closest('[data-i]'); if (!card) return;
    const i = Number(card.dataset.i);
    if (e.target.closest('[data-verify]')) {
      const r = rows[i];
      if (r.row_type !== 'ignore' && r.amount === null) { toast('沒有金額，無法標記已核對', 'error'); return; }
      r.review_status = r.review_status === 'verified' ? 'pending' : 'verified';
      markDirty(); renderRows();
    } else if (e.target.closest('[data-del]')) {
      if (rows[i].id) removed.push(rows[i].id);
      rows.splice(i, 1); markDirty(); renderRows();
    } else if (e.target.closest('[data-up]') && i > 0) {
      [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; markDirty(); renderRows();
    }
  });

  $('#add-row', view).onclick = () => addRows([{ row_type: 'detail', side: 'expense', original_summary: '', ocr_status: 'manual', uncertain_fields: [], review_status: 'pending', is_public: true }]);
  $('#save', view).onclick = save;
  $('#verify-all', view).onclick = async () => {
    const ok = await confirmDialog('全部標記已核對', '只有在你已經「逐筆」對照原始報表、確認每一列的科目、摘要與金額都正確時，才使用此功能。', { requireText: '我已逐筆核對' });
    if (!ok) return;
    const missing = rows.filter((r) => r.row_type !== 'ignore' && r.amount === null).length;
    if (missing) { toast(`有 ${missing} 列沒有金額，請先處理`, 'error'); return; }
    rows.forEach((r) => { r.review_status = 'verified'; }); markDirty(); renderRows();
  };
  $('#discard', view).onclick = async () => {
    if (!(await confirmDialog('捨棄批次', '捨棄後此批次的核對資料不會寫入正式資料。', { danger: true }))) return;
    await save();
    try { await q(db().from('import_batches').update({ status: 'discarded' }).eq('id', id)); window.onbeforeunload = null; ctx.go('report/' + report.id); } catch (err) { toast(err.message, 'error'); }
  };
  $('#commit', view).onclick = async () => {
    if (!(await save())) return;
    let pc;
    try { pc = await rpc('import_precheck', { p_batch_id: id }); } catch (err) { toast(err.message, 'error'); return; }
    const dup = pc.existing_transactions > 0 || pc.other_committed_batches > 0;
    const m = modal('寫入前檢查', `
      <ul class="plain">
        <li>資料列：${pc.rows}（明細 ${pc.detail_rows}）</li>
        <li>明細收入加總：${esc(fmtMoney(toCents(pc.detail_income)))}；明細支出加總：${esc(fmtMoney(toCents(pc.detail_expense)))}</li>
        <li class="${pc.unverified_rows ? 'warn-text' : 'ok-text'}">未核對：${pc.unverified_rows} 列</li>
        <li class="${pc.missing_amount ? 'warn-text' : 'ok-text'}">缺少金額：${pc.missing_amount} 列</li>
        <li class="${dup ? 'warn-text strong' : 'ok-text'}">此報表已有正式明細：${pc.existing_transactions} 筆；其他已寫入批次：${pc.other_committed_batches} 個</li>
        ${pc.possible_duplicates.length ? `<li class="warn-text">與既有明細完全相同（科目、摘要、金額）：${pc.possible_duplicates.length} 列</li>` : ''}
      </ul>
      ${pc.unverified_rows ? `<label class="check"><input type="checkbox" id="inc-unv"> 以「待人工核對」狀態寫入未核對的列（這些資料不會公開，報表也無法公開）</label>` : ''}
      ${dup ? `<label class="check"><input type="checkbox" id="allow-dup"> 我確認這不是重複匯入同一份報表</label>` : ''}
      <div class="actions"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="do-commit">確認寫入</button></div>`);
    $('#do-commit', m.el).onclick = async () => {
      try {
        const res = await rpc('commit_import_batch', { p_batch_id: id, p_include_unverified: $('#inc-unv', m.el)?.checked || false, p_allow_duplicate: $('#allow-dup', m.el)?.checked || false });
        m.close(); window.onbeforeunload = null;
        toast(`已寫入：明細 ${res.transactions} 筆、大項小計 ${res.subtotals} 筆、報表數字 ${res.figures} 項`, 'success', 6000);
        await ctx.reload(); ctx.go('report/' + report.id);
      } catch (err) { toast(err.message, 'error', 10000); }
    };
  };

  // JSON
  $('#json-file', view)?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.format !== 'community-finance-import') throw new Error('不是本系統的匯入格式（format 應為 community-finance-import）');
      if (data.report && (data.report.roc_year !== report.roc_year || data.report.month !== report.month)) {
        if (!(await confirmDialog('年月不符', `檔案是 ${data.report.roc_year} 年 ${data.report.month} 月，但此報表是 ${report.roc_year} 年 ${report.month} 月。確定要匯入？`))) return;
      }
      const newRows = await resolveNames(ctx, data.rows || []);
      if (!newRows) return;
      if (data.source) await q(db().from('import_batches').update({ source_label: String(data.source).slice(0, 200) }).eq('id', id));
      addRows(newRows);
      toast(`已載入 ${newRows.length} 列，請逐筆核對`, 'success');
    } catch (err) { toast('JSON 讀取失敗：' + err.message, 'error', 8000); }
  });

  // 貼上
  $('#parse-paste', view)?.addEventListener('click', () => {
    const text = $('#paste-text', view).value;
    if (!text.trim()) return;
    addRows(parsePasted(text));
    q(db().from('import_batches').update({ raw_text: text }).eq('id', id)).catch(() => {});
  });

  // OCR 區域選取
  if (batch.method === 'ocr') setupOcr(view, id, addRows);
}

function rowCard(r, i, { cats, rcats, readOnly }) {
  const dis = readOnly ? 'disabled' : '';
  const isFig = !['detail', 'group_subtotal', 'ignore'].includes(r.row_type);
  const uf = r.uncertain_fields || [];
  return `<div class="row-card ${r.review_status === 'verified' ? 'verified' : uf.length ? 'uncertain' : ''} ${r.row_type === 'ignore' ? 'ignored' : ''}" data-i="${i}">
    <div class="row-card-head">
      <b>#${i + 1}</b>
      <select class="input input-inline" name="row_type" ${dis}>${options(Object.entries(ROW_TYPE_LABEL), r.row_type)}</select>
      ${r.row_type !== 'ignore' && !isFig ? `<select class="input input-inline" name="side" ${dis}>${options([['income', '收入'], ['expense', '支出']], r.side, { empty: '收／支？' })}</select>` : ''}
      ${r.review_status === 'verified' ? badge('已核對', 'ok') : badge('待人工核對', 'warn')}
      ${r.ocr_status && r.ocr_status !== 'manual' ? `<span class="sub">${esc(OCR_LABEL[r.ocr_status])}${r.confidence !== null && r.confidence !== undefined ? `・信心 ${Number(r.confidence).toFixed(0)}` : ''}</span>` : ''}
      <span class="spacer"></span>
      ${readOnly ? '' : `<button class="btn btn-sm" data-up title="上移" aria-label="上移">↑</button><button class="btn btn-sm btn-danger" data-del aria-label="刪除此列">刪除</button>
      <button class="btn btn-sm ${r.review_status === 'verified' ? '' : 'btn-primary'}" data-verify>${r.review_status === 'verified' ? '取消核對' : '核對無誤 ✓'}</button>`}
    </div>
    ${uf.length ? `<div class="warn-text sub">待人工核對：${esc(uf.join('、'))}</div>` : ''}
    <div class="row-card-grid">
      ${r.row_type === 'detail' ? `<label>原始大項<input class="input" name="original_group" value="${esc(r.original_group || '')}" ${dis}></label>` : ''}
      <label>${r.row_type === 'detail' ? '原始科目名稱' : r.row_type === 'group_subtotal' ? '大項名稱（原文）' : '報表標示文字'}<input class="input" name="${r.row_type === 'group_subtotal' ? 'original_group' : 'original_account_name'}" value="${esc(r.row_type === 'group_subtotal' ? r.original_group || r.original_account_name || '' : r.original_account_name || '')}" ${dis}></label>
      <label>金額${r.amount_raw ? `<span class="sub">（原文 ${esc(r.amount_raw)}）</span>` : ''}<input class="input num" name="amount" inputmode="decimal" value="${r.amount === null || r.amount === undefined ? '' : esc(r.amount)}" ${dis}></label>
      ${r.row_type === 'detail' ? `
        <label class="span-all">原始摘要全文<textarea class="input" name="original_summary" rows="2" ${dis}>${esc(r.original_summary || '')}</textarea></label>
        <label>交易對象原文<input class="input" name="counterparty_raw" value="${esc(r.counterparty_raw || '')}" ${dis}></label>
        ${r.side === 'income' ? `<label>付款方<select class="input" name="payer_status" ${dis}>${options(Object.entries(PAYER_LABEL).filter(([k]) => k !== 'not_applicable'), r.payer_status || 'unconfirmed')}</select></label>` : ''}
        <label>日期原文<input class="input" name="date_raw" value="${esc(r.date_raw || '')}" ${dis}></label>
        <label>分析分類<select class="input" name="analysis_category_id" ${dis}>${options(cats.filter((c) => !r.side || c.side === r.side).map((c) => [c.id, c.name]), r.analysis_category_id, { empty: '（未分類）' })}</select></label>
        ${r.side === 'expense' ? `<label class="check"><input type="checkbox" name="is_repair" ${r.is_repair ? 'checked' : ''} ${dis}> 修繕</label>
        ${r.is_repair ? `<label>修繕分類<select class="input" name="repair_category_id" ${dis}>${options(rcats.map((c) => [c.id, c.name]), r.repair_category_id, { empty: '（未分類）' })}</select></label>` : ''}` : ''}
        <label class="check"><input type="checkbox" name="is_public" ${r.is_public !== false ? 'checked' : ''} ${dis}> 公開明細</label>` : ''}
      <label class="span-all">核對備註<input class="input" name="note" value="${esc(r.note || '')}" ${dis}></label>
    </div></div>`;
}

async function resolveNames(ctx, inRows) {
  const D = ctx.D;
  const missingCats = new Map();
  const missingRepair = new Set();
  for (const r of inRows) {
    if (r.analysis_category_name && ![...D.categories.values()].some((c) => c.side === r.side && c.name === r.analysis_category_name)) missingCats.set(`${r.side}|${r.analysis_category_name}`, { side: r.side, name: r.analysis_category_name });
    if (r.repair_category_name && ![...D.repairCats.values()].some((c) => c.name === r.repair_category_name)) missingRepair.add(r.repair_category_name);
  }
  if (missingCats.size || missingRepair.size) {
    const ok = await confirmDialog('建立分類', `檔案中有下列分類尚未建立，是否建立？（分類可在「科目／廠商設定」隨時調整）\n\n${[...missingCats.values()].map((c) => `分析分類（${c.side === 'income' ? '收入' : '支出'}）：${c.name}`).join('\n')}\n${[...missingRepair].map((n) => `修繕分類：${n}`).join('\n')}`, { okText: '建立並繼續' });
    if (!ok) return null;
    if (missingCats.size) await q(db().from('analysis_categories').insert([...missingCats.values()].map((c) => ({ ...c, is_repair: /修繕/.test(c.name) }))));
    if (missingRepair.size) await q(db().from('repair_categories').insert([...missingRepair].map((name) => ({ name }))));
    await ctx.reload();
  }
  const D2 = ctx.D;
  return inRows.map((r) => {
    const cat = [...D2.categories.values()].find((c) => c.side === r.side && c.name === r.analysis_category_name);
    const rc = [...D2.repairCats.values()].find((c) => c.name === r.repair_category_name);
    const amount = r.amount === null || r.amount === undefined ? (r.amount_raw ? parseAmount(r.amount_raw) : null) : Number(r.amount);
    return {
      row_type: r.row_type || 'detail', side: r.side || null, original_group: r.original_group || null, original_account_name: r.original_account_name || null,
      original_summary: r.original_summary || '', amount_raw: r.amount_raw ?? null, amount: Number.isFinite(amount) ? amount : null,
      counterparty_raw: r.counterparty_raw || null, payer_status: r.payer_status || (r.side === 'income' ? 'unconfirmed' : 'not_applicable'),
      date_raw: r.date_raw || null, transaction_date: r.transaction_date || null, analysis_category_id: cat?.id || null,
      is_repair: r.is_repair ?? undefined, repair_category_id: rc?.id || null, is_public: r.is_public !== false,
      ocr_status: r.ocr_status || 'manual', confidence: r.confidence ?? null,
      uncertain_fields: Array.isArray(r.uncertain_fields) ? r.uncertain_fields : [], review_status: 'pending', note: r.note || null,
    };
  });
}

function setupOcr(view, batchId, addRows) {
  const stage = $('#ocr-stage', view), img = $('#ocr-img', view), box = $('#sel-box', view);
  let mode = null, start = null, rect = null;
  const pos = (e) => { const b = img.getBoundingClientRect(); return { x: Math.min(Math.max(0, (e.clientX - b.left) / b.width), 1), y: Math.min(Math.max(0, (e.clientY - b.top) / b.height), 1) }; };
  const show = () => { if (!rect) { box.hidden = true; return; } box.hidden = false; Object.assign(box.style, { left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.w * 100 + '%', height: rect.h * 100 + '%' }); };
  $$('[data-region]', view).forEach((b) => (b.onclick = () => {
    mode = b.dataset.region;
    if (mode === 'all') { rect = { x: 0, y: 0, w: 1, h: 1 }; show(); }
    else { rect = null; show(); }
    $('#region-actions', view).hidden = false;
    $('#region-label', view).textContent = mode === 'all' ? '整張圖片' : `請在圖片上拖曳框選「${mode === 'income' ? '收入' : '支出'}」區域`;
    stage.classList.add('selecting');
  }));
  stage.addEventListener('pointerdown', (e) => { if (!mode || mode === 'all') return; e.preventDefault(); stage.setPointerCapture(e.pointerId); start = pos(e); rect = { x: start.x, y: start.y, w: 0, h: 0 }; show(); });
  stage.addEventListener('pointermove', (e) => { if (!start) return; const p = pos(e); rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; show(); });
  stage.addEventListener('pointerup', () => { start = null; });
  $('#cancel-region', view).onclick = () => { mode = null; rect = null; show(); $('#region-actions', view).hidden = true; stage.classList.remove('selecting'); };
  $('#run-ocr', view).onclick = async () => {
    if (!rect || rect.w < 0.02 || rect.h < 0.02) { toast('請先框選範圍', 'error'); return; }
    const W = img.naturalWidth, H = img.naturalHeight;
    const sx = rect.x * W, sy = rect.y * H, sw = rect.w * W, sh = rect.h * H;
    const scale = Math.min(3, Math.max(1, 2400 / sw));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const prog = $('#ocr-progress', view);
    $('#run-ocr', view).disabled = true;
    try {
      prog.textContent = '準備辨識元件（第一次使用需下載約 10–20 MB 語言資料）…';
      const res = await recognize(c, (s, p) => { prog.textContent = `${s} ${p ? Math.round(p * 100) + '%' : ''}`; });
      const side = mode === 'all' ? null : mode;
      const parsed = parseLines(res.lines, { side, method: 'ocr' });
      prog.textContent = `辨識完成：${res.lines.length} 行文字，產生 ${parsed.length} 列待核對資料。OCR 結果可能有錯字或漏字，請務必逐筆對照原圖核對。`;
      addRows(parsed);
      q(db().from('import_batches').update({ raw_text: res.text, engine: 'tesseract.js 5 chi_tra+eng' }).eq('id', batchId)).catch(() => {});
    } catch (err) { prog.textContent = ''; toast('辨識失敗：' + err.message, 'error', 8000); }
    finally { $('#run-ocr', view).disabled = false; }
  };
}
