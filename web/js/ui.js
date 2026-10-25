// 介面共用元件
import { esc, fmtMoney, SIDE_LABEL, REVIEW_LABEL, OCR_LABEL, PAYER_LABEL, ymLabel, toCents } from './util.js';
import { accountName, categoryName, vendorName, repairCatName } from './analytics.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function html(strings, ...vals) {
  return strings.reduce((s, str, i) => s + str + (i < vals.length ? (vals[i] && vals[i].__raw ? vals[i].v : esc(vals[i])) : ''), '');
}
export const raw = (v) => ({ __raw: true, v: v ?? '' });

export function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function modal(title, bodyHtml, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="btn-icon" data-close aria-label="關閉">✕</button></div>
    <div class="modal-body">${bodyHtml}</div></div>`;
  const close = () => { wrap.remove(); document.body.classList.remove('no-scroll'); onClose && onClose(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  return { el: wrap.querySelector('.modal-body'), close };
}

export function confirmDialog(title, message, { okText = '確定', danger = false, requireText = null } = {}) {
  return new Promise((resolve) => {
    const m = modal(title, `<p class="pre">${esc(message)}</p>
      ${requireText ? `<label>請輸入「${esc(requireText)}」以確認<input class="input" data-req autocomplete="off"></label>` : ''}
      <div class="actions"><button class="btn" data-no>取消</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button></div>`,
      { onClose: () => resolve(false) });
    m.el.querySelector('[data-no]').onclick = () => m.close();
    m.el.querySelector('[data-ok]').onclick = () => {
      if (requireText && m.el.querySelector('[data-req]').value.trim() !== requireText) { toast('確認文字不正確', 'error'); return; }
      resolve(true); m.el.closest('.modal-backdrop').remove(); document.body.classList.remove('no-scroll');
    };
  });
}

export function moneyCell(cents, cls = '') {
  return `<td class="num ${cls} ${cents < 0 ? 'neg' : ''}">${esc(fmtMoney(cents, { unit: false }))}</td>`;
}

export function badge(text, kind = '') { return `<span class="badge ${kind}">${esc(text)}</span>`; }

export function reviewBadge(t) {
  if (t.hidden) return badge('不公開（彙總）', 'muted');
  const k = t.review_status === 'verified' ? 'ok' : 'warn';
  return badge(REVIEW_LABEL[t.review_status] || t.review_status, k);
}

// 交易明細表（手機上自動變成卡片排列）
export function txTable(D, rows, { admin = false, showMonth = true, limit = 300 } = {}) {
  if (!rows.length) return '<p class="muted">沒有符合條件的資料。</p>';
  const total = rows.reduce((s, t) => s + (t.side === 'income' ? t.cents : -t.cents), 0);
  const inc = rows.filter((t) => t.side === 'income').reduce((s, t) => s + t.cents, 0);
  const exp = rows.filter((t) => t.side === 'expense').reduce((s, t) => s + t.cents, 0);
  const shown = rows.slice(0, limit);
  return `<div class="table-meta">共 ${rows.length} 筆　收入 ${esc(fmtMoney(inc))}　支出 ${esc(fmtMoney(exp))}　差額 ${esc(fmtMoney(total))}
    ${rows.length > limit ? `<span class="muted">（僅顯示前 ${limit} 筆，請縮小搜尋條件）</span>` : ''}</div>
  <div class="table-wrap"><table class="tx-table">
  <thead><tr>${showMonth ? '<th>報表月份</th>' : ''}<th>類別</th><th>原始科目</th><th>標準科目／分類</th><th>原始摘要</th><th>廠商／對象</th><th class="num">金額</th><th>狀態</th>${admin ? '<th></th>' : ''}</tr></thead>
  <tbody>${shown.map((t) => `<tr class="${t.review_status !== 'verified' ? 'row-warn' : ''}">
    ${showMonth ? `<td data-label="月份">${t.roc_year}/${String(t.month).padStart(2, '0')}</td>` : ''}
    <td data-label="類別">${badge(SIDE_LABEL[t.side], t.side)}${t.is_repair ? badge('修繕', 'repair') : ''}</td>
    <td data-label="原始科目">${esc(t.original_account_name)}${t.original_group ? `<div class="sub">${esc(t.original_group)}</div>` : ''}</td>
    <td data-label="標準科目">${esc(accountName(D, t))}<div class="sub">${esc(categoryName(D, t))}${t.is_repair ? '・' + esc(repairCatName(D, t)) : ''}</div></td>
    <td data-label="原始摘要" class="summary">${esc(t.original_summary)}${t.public_note ? `<div class="sub">備註：${esc(t.public_note)}</div>` : ''}${admin && t.admin_note ? `<div class="sub private">管理者備註：${esc(t.admin_note)}</div>` : ''}${(t.uncertain_fields || []).length ? `<div class="sub warn-text">待人工核對欄位：${esc(t.uncertain_fields.join('、'))}</div>` : ''}</td>
    <td data-label="廠商">${esc(vendorName(D, t) || '')}${t.counterparty_raw && t.counterparty_raw !== vendorName(D, t) ? `<div class="sub">原文：${esc(t.counterparty_raw)}${t.vendor_id ? '' : '（未歸戶）'}</div>` : ''}${t.side === 'income' && t.payer_status !== 'not_applicable' ? `<div class="sub">${esc(PAYER_LABEL[t.payer_status])}</div>` : ''}</td>
    <td data-label="金額" class="num ${t.cents < 0 ? 'neg' : ''}">${esc(fmtMoney(t.cents, { unit: false }))}</td>
    <td data-label="狀態">${reviewBadge(t)}${t.ocr_status && t.ocr_status !== 'manual' ? `<div class="sub">${esc(OCR_LABEL[t.ocr_status] || '')}</div>` : ''}${t.is_public === false && !t.hidden ? badge('不公開', 'muted') : ''}</td>
    ${admin ? `<td>${t.hidden ? '' : `<button class="btn btn-sm" data-edit-tx="${t.id}">編輯</button>`}</td>` : ''}
  </tr>`).join('')}</tbody></table></div>`;
}

export function drill(D, title, rows, ctx) {
  const m = modal(title, txTable(D, rows, { admin: ctx?.admin }), { wide: true });
  if (ctx?.onEdit) m.el.addEventListener('click', (e) => { const b = e.target.closest('[data-edit-tx]'); if (b) ctx.onEdit(Number(b.dataset.editTx)); });
  return m;
}

const charts = new WeakMap();
export function chart(canvas, config) {
  if (charts.has(canvas)) charts.get(canvas).destroy();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  window.Chart.defaults.color = dark ? '#c9d1d9' : '#3b4252';
  window.Chart.defaults.borderColor = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)';
  window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  const c = new window.Chart(canvas, config);
  charts.set(canvas, c);
  return c;
}
export const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#475569', '#0d9488', '#9333ea'];

export const moneyTick = (v) => (Math.abs(v) >= 10000 ? (v / 10000).toLocaleString('zh-TW') + ' 萬' : v.toLocaleString('zh-TW'));

export function periodSelect(D, current, id = 'period') {
  const ps = [...new Set(D.reports.map((r) => r.ymk))].sort((a, b) => b - a);
  return `<select id="${id}" class="input input-inline">${ps.map((p) => `<option value="${p}" ${p === current ? 'selected' : ''}>${ymLabel(Math.floor(p / 100), p % 100)}</option>`).join('')}</select>`;
}

export function options(list, selected, { empty } = {}) {
  return (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
    list.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else o[el.name] = el.value;
  }
  return o;
}

export const numOrNull = (v) => { if (v === '' || v === null || v === undefined) return null; const c = toCents(v); return c === null ? NaN : c / 100; };
export const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
