// 共用工具：金額（以「分」為整數計算，避免浮點誤差）、格式化、HTML 跳脫

export const toCents = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s$＄元]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
export const fromCents = (c) => (c === null || c === undefined ? null : c / 100);

export function fmtMoney(cents, { sign = false, unit = true } = {}) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  let s = whole.toLocaleString('en-US') + (frac ? '.' + String(frac).padStart(2, '0') : '');
  s = (neg ? '-' : sign && cents > 0 ? '+' : '') + s;
  return unit ? s + ' 元' : s;
}

export function fmtPct(num, den, digits = 1) {
  if (!den) return '—';
  return ((num / den) * 100).toFixed(digits) + '%';
}

export function fmtChange(cur, prev) {
  if (prev === null || prev === undefined) return { text: '無比較資料', cls: 'muted' };
  const d = cur - prev;
  const pct = prev !== 0 ? ` (${d >= 0 ? '+' : ''}${((d / Math.abs(prev)) * 100).toFixed(1)}%)` : '';
  return { text: fmtMoney(d, { sign: true }) + pct, cls: d > 0 ? 'up' : d < 0 ? 'down' : 'muted' };
}

// 解析報表上的金額文字；無法確定時回傳 null（不猜測）
export function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/\s/g, '').replace(/[元$＄]/g, '');
  s = s.replace(/[−–—]/g, '-').replace(/[，]/g, ',').replace(/[．]/g, '.');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ym = (y, m) => y * 100 + m;
export const ymLabel = (y, m) => `${y} 年 ${m} 月`;
export const ymShort = (k) => `${Math.floor(k / 100)}/${String(k % 100).padStart(2, '0')}`;
export function prevYm(k) { const y = Math.floor(k / 100), m = k % 100; return m === 1 ? ym(y - 1, 12) : ym(y, m - 1); }
export const lastYearYm = (k) => k - 100;

export const SIDE_LABEL = { income: '收入', expense: '支出' };
export const REVIEW_LABEL = { pending: '待人工核對', verified: '已核對', needs_check: '待人工核對（已寫入）' };
export const OCR_LABEL = {
  manual: '人工輸入', ocr_ok: 'OCR 辨識', ocr_uncertain: 'OCR 不確定（待人工核對）',
  ocr_unreadable: 'OCR 無法辨識（待人工核對）', ai_transcribed: 'AI 判讀（待人工核對）',
};
export const PAYER_LABEL = {
  not_applicable: '—', vendor_confirmed: '已確認：廠商支付給社區', unconfirmed: '報表記載收入，付款方未確認',
  residents: '住戶繳納', other: '其他',
};
export const ROW_TYPE_LABEL = {
  detail: '明細', group_subtotal: '大項小計', income_total: '收入小計', expense_total: '支出小計',
  prior_balance: '前期餘絀', period_balance: '本期餘絀', cumulative_balance: '累計餘絀', ignore: '忽略（非資料列）',
};

// 字串相似度（字元二元組 Jaccard），只用於「提示」，絕不自動合併
export function similarity(a, b) {
  const norm = (s) => String(s || '').replace(/[\s\d.,/$()（）:：\-+*#%]/g, '');
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); if (s.length === 1) g.add(s); return g; };
  const A = grams(norm(a)), B = grams(norm(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
export const sumCents = (rows) => rows.reduce((s, r) => s + (r.cents ?? toCents(r.amount) ?? 0), 0);

export function downloadFile(name, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (header, rows) => '﻿' + [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');

export async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const todayStr = () => new Date().toISOString().slice(0, 10);
export const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '—');
