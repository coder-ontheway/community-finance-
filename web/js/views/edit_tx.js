// 交易明細新增／編輯（只有管理者會看到；實際權限由資料庫 RLS 判斷）
import { modal, options, toast, confirmDialog, formData, numOrNull, $ } from '../ui.js';
import { esc, fmtMoney, PAYER_LABEL, REVIEW_LABEL, OCR_LABEL, toCents } from '../util.js';
import { q, rpc, db } from '../api.js';

export function editTxDialog(ctx, id, { reportId } = {}) {
  const D = ctx.D;
  const t = id ? ctx.raw.transactions.find((x) => x.id === id) : null;
  if (id && !t) { toast('找不到此筆資料', 'error'); return; }
  const isNew = !t;
  const side = t?.side || 'expense';
  const cats = [...D.categories.values()].sort((a, b) => a.sort_order - b.sort_order);
  const accs = [...D.accounts.values()].sort((a, b) => a.sort_order - b.sort_order || a.standard_name.localeCompare(b.standard_name));
  const vendors = [...D.vendors.values()].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name, 'zh-Hant'));
  const reports = [...D.reports].reverse();
  const items = D.items;
  const linked = new Set(D.links.filter((l) => l.transaction_id === id).map((l) => l.repair_item_id));

  const m = modal(isNew ? '新增交易明細' : `編輯交易明細 #${id}`, `
  <form id="tx-form" class="form-grid">
    ${isNew ? `
      <label>所屬月報表<select class="input" name="report_id" required>${options(reports.map((r) => [r.id, `${r.roc_year} 年 ${r.month} 月`]), reportId)}</select></label>
      <label>收入／支出<select class="input" name="side">${options([['income', '收入'], ['expense', '支出']], side)}</select></label>
      <label>報表原始大項（例如【修繕費】）<input class="input" name="original_group"></label>
      <label>原始科目名稱 *<input class="input" name="original_account_name" required></label>
      <label class="span2">原始摘要全文<textarea class="input" name="original_summary" rows="3"></textarea></label>
    ` : `
      <div class="span2 readonly-box">
        <div><b>${esc(t.roc_year)} 年 ${esc(t.month)} 月・${t.side === 'income' ? '收入' : '支出'}</b>　${esc(t.original_group || '')}</div>
        <div>原始科目：<b>${esc(t.original_account_name)}</b></div>
        <div>原始摘要：${esc(t.original_summary)}</div>
        <div class="sub">來源：報表第 ${esc(t.source_row_no ?? '—')} 列・${esc(OCR_LABEL[t.ocr_status] || t.ocr_status)}${(t.uncertain_fields || []).length ? `・待核對欄位：${esc(t.uncertain_fields.join('、'))}` : ''}</div>
        <button type="button" class="btn btn-sm" id="fix-original">更正原始內容（抄錄錯誤時）</button>
      </div>`}
    <label>金額（元）*<input class="input" name="amount" inputmode="decimal" required value="${t ? esc(t.amount) : ''}"></label>
    <label>標準化科目<select class="input" name="account_id">${options(accs.map((a) => [a.id, `${a.side === 'income' ? '收' : '支'}｜${a.standard_name}`]), t?.account_id, { empty: '（依原始科目自動）' })}</select></label>
    <label>分析分類<select class="input" name="analysis_category_id">${options(cats.map((c) => [c.id, `${c.side === 'income' ? '收' : '支'}｜${c.name}`]), t?.analysis_category_id, { empty: '（未分類）' })}</select></label>
    <label>交易對象原文<input class="input" name="counterparty_raw" value="${esc(t?.counterparty_raw || '')}"></label>
    <label>歸戶廠商<select class="input" name="vendor_id">${options(vendors.map((v) => [v.id, v.canonical_name]), t?.vendor_id, { empty: '（未歸戶）' })}</select></label>
    <label>付款方狀態（收入用）<select class="input" name="payer_status">${options(Object.entries(PAYER_LABEL), t?.payer_status || 'not_applicable')}</select></label>
    <label>交易日期（報表有記載才填）<input class="input" type="date" name="transaction_date" value="${esc(t?.transaction_date || '')}"></label>
    <label>日期原文<input class="input" name="date_raw" value="${esc(t?.date_raw || '')}"></label>
    <label class="check"><input type="checkbox" name="is_repair" ${t?.is_repair ? 'checked' : ''}> 列入修繕分析</label>
    <label>修繕分類<select class="input" name="repair_category_id">${options([...D.repairCats.values()].map((c) => [c.id, c.name]), t?.repair_category_id, { empty: '（未分類）' })}</select></label>
    <label>人工核對狀態<select class="input" name="review_status">${options(Object.entries(REVIEW_LABEL).filter(([k]) => k !== 'needs_check' || true), t?.review_status || 'pending')}</select></label>
    <label class="check"><input type="checkbox" name="is_public" ${t?.is_public !== false ? 'checked' : ''}> 公開給鄰居（含個資請取消）</label>
    <label class="span2">公開備註（鄰居看得到）<input class="input" name="public_note" value="${esc(t?.public_note || '')}"></label>
    <label class="span2">管理者私人備註（鄰居看不到）<textarea class="input" name="admin_note" rows="2">${esc(t?.admin_note || '')}</textarea></label>
    ${items.length && !isNew ? `<fieldset class="span2"><legend>修繕項目追蹤（同一設備／工程）</legend>
      ${items.map((it) => `<label class="check"><input type="checkbox" name="item_${it.id}" ${linked.has(it.id) ? 'checked' : ''}> ${esc(it.name)}${it.facility ? `（${esc(it.facility)}）` : ''}</label>`).join('')}</fieldset>` : ''}
    <div class="actions span2">
      ${isNew ? '' : '<button type="button" class="btn btn-danger" id="del-tx">刪除</button>'}
      <span class="spacer"></span>
      <button type="button" class="btn" data-close>取消</button>
      <button type="submit" class="btn btn-primary">儲存</button>
    </div>
  </form>`, { wide: true });

  const form = $('#tx-form', m.el);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(form);
    const amount = numOrNull(f.amount);
    if (amount === null || Number.isNaN(amount)) { toast('金額格式不正確', 'error'); return; }
    const rec = {
      amount,
      account_id: f.account_id ? Number(f.account_id) : null,
      analysis_category_id: f.analysis_category_id ? Number(f.analysis_category_id) : null,
      counterparty_raw: f.counterparty_raw.trim() || null,
      vendor_id: f.vendor_id ? Number(f.vendor_id) : null,
      payer_status: f.payer_status,
      transaction_date: f.transaction_date || null,
      date_raw: f.date_raw.trim() || null,
      is_repair: f.is_repair,
      repair_category_id: f.repair_category_id ? Number(f.repair_category_id) : null,
      review_status: f.review_status,
      is_public: f.is_public,
      public_note: f.public_note.trim() || null,
      admin_note: f.admin_note.trim() || null,
    };
    try {
      if (isNew) {
        Object.assign(rec, {
          report_id: Number(f.report_id), side: f.side, original_group: f.original_group.trim() || null,
          original_account_name: f.original_account_name.trim(), original_summary: f.original_summary, ocr_status: 'manual',
          roc_year: 0, month: 0,
        });
        if (rec.side === 'expense') rec.payer_status = 'not_applicable';
        await q(db().from('transactions').insert(rec));
      } else {
        if (toCents(t.amount) !== toCents(amount)) {
          const ok = await confirmDialog('確認修改金額', `金額將由 ${fmtMoney(toCents(t.amount))} 改為 ${fmtMoney(toCents(amount))}。\n修改會記錄在「修改紀錄」中。`);
          if (!ok) return;
        }
        if (t.side === 'expense') rec.payer_status = 'not_applicable';
        await q(db().from('transactions').update(rec).eq('id', id));
        // 修繕項目關聯
        const want = new Set(items.filter((it) => f[`item_${it.id}`]).map((it) => it.id));
        const add = [...want].filter((x) => !linked.has(x)).map((x) => ({ transaction_id: id, repair_item_id: x }));
        const del = [...linked].filter((x) => !want.has(x));
        if (add.length) await q(db().from('transaction_repair_links').insert(add));
        for (const x of del) await q(db().from('transaction_repair_links').delete().eq('transaction_id', id).eq('repair_item_id', x));
      }
      toast('已儲存', 'success');
      m.close();
      await ctx.reload(); ctx.rerender();
    } catch (err) { toast('儲存失敗：' + err.message, 'error', 8000); }
  };

  $('#del-tx', m.el)?.addEventListener('click', async () => {
    const ok = await confirmDialog('刪除交易明細', `確定刪除這筆 ${fmtMoney(toCents(t.amount))} 的明細？\n「${t.original_summary}」\n刪除內容會保留在修改紀錄中。`, { danger: true, okText: '刪除', requireText: '刪除' });
    if (!ok) return;
    try { await q(db().from('transactions').delete().eq('id', id)); toast('已刪除', 'success'); m.close(); await ctx.reload(); ctx.rerender(); }
    catch (err) { toast('刪除失敗：' + err.message, 'error', 8000); }
  });

  $('#fix-original', m.el)?.addEventListener('click', () => {
    const m2 = modal('更正原始內容', `<p class="muted">只有在系統內容與原始報表不符（抄錄或辨識錯誤）時才使用。更正前後的內容與理由都會保存在修改紀錄。</p>
      <form id="fix-form"><label>原始科目名稱<input class="input" name="acc" value="${esc(t.original_account_name)}" required></label>
      <label>原始摘要全文<textarea class="input" name="sum" rows="4">${esc(t.original_summary)}</textarea></label>
      <label>更正理由 *<input class="input" name="reason" required placeholder="例如：對照原始報表，第 3 字辨識錯誤"></label>
      <div class="actions"><button class="btn btn-primary">確認更正</button></div></form>`);
    $('#fix-form', m2.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        await rpc('admin_correct_original', { p_transaction_id: id, p_original_account_name: f.acc.trim(), p_original_summary: f.sum, p_reason: f.reason });
        toast('已更正', 'success'); m2.close(); m.close(); await ctx.reload(); ctx.rerender();
      } catch (err) { toast(err.message, 'error', 8000); }
    };
  });
}
