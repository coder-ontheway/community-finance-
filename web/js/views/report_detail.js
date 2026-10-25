// 單一月報表：核對、報表數字、銀行餘額、公開、來源檔案、匯入
import { reconcile } from '../analytics.js';
import { esc, fmtMoney, toCents, sha256Hex, fmtTime, SIDE_LABEL } from '../util.js';
import { $, toast, modal, confirmDialog, formData, numOrNull, badge, txTable } from '../ui.js';
import { q, db, rpc } from '../api.js';

export async function render(view, ctx, [idStr]) {
  const D = ctx.D;
  const id = Number(idStr);
  const r = D.reports.find((x) => x.id === id);
  if (!r) { view.innerHTML = '<div class="card"><h2>找不到此報表</h2><p>可能尚未公開或已被刪除。</p></div>'; return; }
  const rec = reconcile(D, r);
  const txs = D.tx.filter((t) => t.report_id === id).sort((a, b) => (a.side === b.side ? (a.source_row_no ?? 0) - (b.source_row_no ?? 0) : a.side === 'income' ? -1 : 1));
  const files = ctx.raw.files.filter((f) => f.report_id === id);
  let batches = [];
  if (ctx.admin) batches = await q(db().from('import_batches').select('id,method,status,source_label,created_at,committed_at,file_id').eq('report_id', id).order('id'));

  const diffCell = (d) => d === null ? '<td class="num muted">—</td>' : `<td class="num ${d === 0 ? 'ok-text' : 'warn-text strong'}">${d === 0 ? '0（一致）' : esc(fmtMoney(d, { sign: true }))}</td>`;
  const c = (v) => esc(fmtMoney(v, { unit: false }));

  view.innerHTML = `
  <div class="page-head"><h1>${r.roc_year} 年 ${r.month} 月 月報表</h1>
    <div class="actions">${ctx.admin ? `
      ${r.is_published ? '<button class="btn" id="unpublish">取消公開</button>' : '<button class="btn btn-primary" id="publish">公開給鄰居</button>'}
      <button class="btn" id="edit-figures">編輯報表數字／銀行餘額</button>` : ''}</div></div>
  <p class="muted">${esc(r.title || '')} ${esc(r.period_text || '')}</p>
  ${r.public_note ? `<div class="notice">${esc(r.public_note)}</div>` : ''}
  ${r.reported_figures_note ? `<div class="notice warn pre">${esc(r.reported_figures_note)}</div>` : ''}

  <section class="card">
    <h2>報表數字與系統計算比對</h2>
    <p class="sub">「報表」為月報表上印的數字；「系統」為所有明細逐筆加總的結果。差額不為 0 時請對照原始報表查核，系統不會自動修改數字。</p>
    <div class="table-wrap"><table class="recon">
      <thead><tr><th>項目</th><th class="num">報表數字</th><th class="num">系統計算</th><th class="num">差額（系統 − 報表）</th><th>說明</th></tr></thead>
      <tbody>${rec.rows.map((x) => `<tr><th>${esc(x.label)}</th><td class="num">${x.reported === null ? '<span class="muted">未登錄</span>' : c(x.reported)}</td>
        <td class="num">${x.system === null ? '<span class="muted">無法計算</span>' : c(x.system)}</td>${diffCell(x.diff)}<td class="sub">${esc(x.note)}</td></tr>`).join('')}
      <tr><th>前期餘絀（報表）</th><td class="num">${r.reported_prior_balance === null ? '<span class="muted">未登錄</span>' : c(toCents(r.reported_prior_balance))}</td><td></td><td></td><td class="sub">累計結餘的計算基礎</td></tr>
      </tbody></table></div>
    ${rec.groupRows.length ? `<h3>各大項小計</h3><div class="table-wrap"><table class="recon">
      <thead><tr><th>大項（報表原文）</th><th>類別</th><th class="num">報表小計</th><th class="num">明細加總</th><th class="num">差額</th></tr></thead>
      <tbody>${rec.groupRows.map((g) => `<tr class="clickable" data-group="${esc(g.group)}" data-side="${g.side}"><th>${esc(g.label)}${g.review_status !== 'verified' ? badge('待人工核對', 'warn') : ''}</th><td>${SIDE_LABEL[g.side]}</td><td class="num">${c(g.reported)}</td><td class="num">${c(g.system)}</td>${diffCell(g.diff)}</tr>`).join('')}</tbody></table></div>` : ''}
    ${rec.internal.length ? `<h3>報表自身數字的一致性</h3><ul class="plain">${rec.internal.map((x) => `<li>${esc(x.label)} = <b class="${x.diff === 0 ? 'ok-text' : 'warn-text'}">${esc(fmtMoney(x.diff))}</b></li>`).join('')}</ul>` : ''}
    <div class="balance-grid">
      <div class="balance"><div class="b-title">報表累計餘絀</div><b>${esc(fmtMoney(toCents(r.reported_cumulative_balance)))}</b></div>
      <div class="balance"><div class="b-title">系統：前期餘絀＋本期明細淨額</div><b>${esc(fmtMoney(rec.rows[3].system))}</b></div>
      <div class="balance"><div class="b-title">銀行實際餘額</div><b>${r.bank_balance === null ? '未提供' : esc(fmtMoney(toCents(r.bank_balance)))}</b><div class="sub">${esc(r.bank_balance_date || '')}</div></div>
    </div>
  </section>

  ${ctx.admin ? `<section class="card">
    <h2>原始報表檔案（僅管理者可見）</h2>
    ${files.length ? `<ul class="files">${files.map((f) => `<li><button class="btn btn-sm" data-view-file="${f.id}">檢視</button> ${esc(f.original_name || f.storage_path)}
      <span class="sub">${(f.size_bytes / 1024).toFixed(0)} KB・${fmtTime(f.uploaded_at)}・SHA-256 ${esc(f.sha256.slice(0, 12))}…</span></li>`).join('')}</ul>` : '<p class="muted">尚未上傳。</p>'}
    <label class="btn">上傳報表截圖／掃描檔<input type="file" id="upload" accept="image/*,application/pdf" hidden></label>
  </section>
  <section class="card">
    <h2>匯入資料</h2>
    <p class="sub">匯入的資料會先進入「核對區」，逐筆核對確認後才會寫入正式財務資料。</p>
    ${batches.length ? `<ul class="plain">${batches.map((b) => `<li><a href="#/import/${b.id}">批次 #${b.id}</a>（${esc({ ocr: 'OCR 辨識', paste: '貼上文字', json: 'JSON 檔', manual: '手動輸入' }[b.method])}${b.source_label ? '・' + esc(b.source_label) : ''}）
      ${b.status === 'committed' ? badge('已寫入', 'ok') : b.status === 'open' ? badge('核對中', 'warn') : badge('已捨棄', 'muted')} <span class="sub">${fmtTime(b.created_at)}</span></li>`).join('')}</ul>` : ''}
    <div class="actions">
      <button class="btn" data-new-batch="ocr">從截圖 OCR 辨識</button>
      <button class="btn" data-new-batch="json">匯入 JSON 檔</button>
      <button class="btn" data-new-batch="paste">貼上表格文字</button>
      <button class="btn" data-new-batch="manual">逐筆手動輸入</button>
    </div>
  </section>` : ''}

  <section class="card"><h2>本月明細（${txs.length} 筆）</h2>${txTable(ctx.D, txs, { admin: ctx.admin, showMonth: false })}</section>
  ${ctx.admin && !txs.length && !batches.length ? '<div class="card"><button class="btn btn-danger" id="del-report">刪除此空白報表</button></div>' : ''}`;

  view.onclick = (e) => { const b = e.target.closest('[data-edit-tx]'); if (b) ctx.editTx(Number(b.dataset.editTx)); };
  view.querySelectorAll('[data-group]').forEach((tr) => (tr.onclick = async () => {
    const { drill } = await import('../ui.js');
    drill(D, `${tr.dataset.group} 明細`, txs.filter((t) => t.original_group === tr.dataset.group && t.side === tr.dataset.side), { admin: ctx.admin, onEdit: ctx.editTx });
  }));
  if (!ctx.admin) return;

  $('#publish', view)?.addEventListener('click', async () => {
    const warn = [];
    if (!rec.ok) warn.push('報表數字與系統計算仍有差異。');
    if (rec.pending) warn.push(`仍有 ${rec.pending} 筆明細未核對（資料庫會拒絕公開）。`);
    const ok = await confirmDialog('公開月報表', `${warn.length ? '注意：\n' + warn.join('\n') + '\n\n' : ''}公開後，持有共同瀏覽密碼的鄰居可以看到本月已核對且設為公開的明細。標記為不公開的明細只會顯示彙總金額。`, { okText: '確認公開' });
    if (!ok) return;
    try { await q(db().from('reports').update({ is_published: true }).eq('id', id)); toast('已公開', 'success'); await ctx.reload(); ctx.rerender(); }
    catch (err) { toast(err.message, 'error', 8000); }
  });
  $('#unpublish', view)?.addEventListener('click', async () => {
    try { await q(db().from('reports').update({ is_published: false }).eq('id', id)); toast('已取消公開', 'success'); await ctx.reload(); ctx.rerender(); }
    catch (err) { toast(err.message, 'error'); }
  });
  $('#edit-figures', view).onclick = () => figuresDialog(ctx, r);
  $('#del-report', view)?.addEventListener('click', async () => {
    if (!(await confirmDialog('刪除報表', '確定刪除這份沒有任何明細的報表？', { danger: true }))) return;
    try { await q(db().from('reports').delete().eq('id', id)); await ctx.reload(); ctx.go('reports'); } catch (err) { toast(err.message, 'error'); }
  });

  $('#upload', view).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const fileId = await uploadReportFile(ctx, r, file);
      if (fileId) { toast('已上傳', 'success'); await ctx.reload(); ctx.rerender(); }
    } catch (err) { toast('上傳失敗：' + err.message, 'error', 8000); }
  };
  view.querySelectorAll('[data-view-file]').forEach((b) => (b.onclick = async () => {
    const f = files.find((x) => x.id === Number(b.dataset.viewFile));
    const url = await signedUrl(f.storage_path);
    if (url) window.open(url, '_blank', 'noopener');
  }));
  view.querySelectorAll('[data-new-batch]').forEach((b) => (b.onclick = () => newBatch(ctx, r, b.dataset.newBatch, files)));
}

export async function signedUrl(path) {
  const { data, error } = await db().storage.from('report-files').createSignedUrl(path, 300);
  if (error) { toast('無法開啟檔案：' + error.message, 'error'); return null; }
  return data.signedUrl;
}

export async function uploadReportFile(ctx, r, file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('檔案超過 20 MB');
  const buf = await file.arrayBuffer();
  const hash = await sha256Hex(buf);
  const dup = ctx.raw.files.find((f) => f.sha256 === hash);
  if (dup) {
    const dr = ctx.D.reports.find((x) => x.id === dup.report_id);
    toast(`這個檔案已經上傳過（${dr ? `${dr.roc_year} 年 ${dr.month} 月報表` : '其他報表'}），不重複上傳。`, 'error', 8000);
    return null;
  }
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${r.roc_year}-${String(r.month).padStart(2, '0')}/${hash}.${ext}`;
  const { error } = await db().storage.from('report-files').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (error && !/exists/i.test(error.message)) throw new Error(error.message);
  const [row] = await q(db().from('report_files').insert({ report_id: r.id, storage_path: path, original_name: file.name, mime_type: file.type, size_bytes: file.size, sha256: hash }).select());
  return row.id;
}

async function newBatch(ctx, r, method, files) {
  const existing = ctx.D.tx.filter((t) => t.report_id === r.id).length;
  if (existing) {
    const ok = await confirmDialog('可能重複匯入', `這份報表已經有 ${existing} 筆正式明細。再次匯入同一份報表會造成重複加總。\n\n只有在補登漏掉的明細時才需要新的匯入批次。確定要建立新批次嗎？`, { okText: '仍要建立' });
    if (!ok) return;
  }
  let fileId = null;
  if (method === 'ocr') {
    if (!files.length) { toast('請先上傳報表截圖', 'error'); return; }
    fileId = files[files.length - 1].id;
  }
  try {
    const [b] = await q(db().from('import_batches').insert({ report_id: r.id, method, file_id: fileId }).select());
    ctx.go('import/' + b.id);
  } catch (err) { toast(err.message, 'error'); }
}

function figuresDialog(ctx, r) {
  const v = (x) => (x === null || x === undefined ? '' : esc(x));
  const m = modal('報表數字與銀行餘額', `<form id="ff" class="form-grid">
    <p class="span2 sub">請完全依照月報表上印的數字填寫，不要填入系統計算的結果。</p>
    <label>前期餘絀<input class="input" name="reported_prior_balance" inputmode="decimal" value="${v(r.reported_prior_balance)}"></label>
    <label>收入小計<input class="input" name="reported_income_total" inputmode="decimal" value="${v(r.reported_income_total)}"></label>
    <label>支出小計<input class="input" name="reported_expense_total" inputmode="decimal" value="${v(r.reported_expense_total)}"></label>
    <label>本期餘絀<input class="input" name="reported_period_balance" inputmode="decimal" value="${v(r.reported_period_balance)}"></label>
    <label>累計餘絀<input class="input" name="reported_cumulative_balance" inputmode="decimal" value="${v(r.reported_cumulative_balance)}"></label>
    <label class="span2">報表數字附註（例如：待人工核對的原因）<textarea class="input" name="reported_figures_note" rows="2">${v(r.reported_figures_note)}</textarea></label>
    <h3 class="span2">銀行實際餘額（與報表結餘是不同概念）</h3>
    <label>銀行餘額<input class="input" name="bank_balance" inputmode="decimal" value="${v(r.bank_balance)}"></label>
    <label>對帳日期<input class="input" type="date" name="bank_balance_date" value="${v(r.bank_balance_date)}"></label>
    <label class="span2">銀行餘額說明（僅管理者可見，請勿填入帳號）<input class="input" name="bank_balance_note" value="${v(r.bank_balance_note)}"></label>
    <label class="span2">公開說明（鄰居看得到）<textarea class="input" name="public_note" rows="2">${v(r.public_note)}</textarea></label>
    <label class="span2">管理者私人備註<textarea class="input" name="admin_note" rows="2">${v(r.admin_note)}</textarea></label>
    <div class="actions span2"><button class="btn btn-primary">儲存</button></div></form>`, { wide: true });
  $('#ff', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const rec = {};
    for (const k of ['reported_prior_balance', 'reported_income_total', 'reported_expense_total', 'reported_period_balance', 'reported_cumulative_balance', 'bank_balance']) {
      rec[k] = numOrNull(f[k]);
      if (Number.isNaN(rec[k])) { toast(`「${k}」金額格式不正確`, 'error'); return; }
    }
    Object.assign(rec, { reported_figures_note: f.reported_figures_note || null, bank_balance_date: f.bank_balance_date || null,
      bank_balance_note: f.bank_balance_note || null, public_note: f.public_note || null, admin_note: f.admin_note || null });
    try { await q(db().from('reports').update(rec).eq('id', r.id)); toast('已儲存', 'success'); m.close(); await ctx.reload(); ctx.rerender(); }
    catch (err) { toast(err.message, 'error', 8000); }
  };
}

export { rpc };
