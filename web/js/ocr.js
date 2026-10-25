// OCR 辨識與文字解析
// 原則：辨識不確定的內容一律標示「待人工核對」，不自動猜測或補字。
import { parseAmount } from './util.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
export const LOW_CONFIDENCE = 80;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('無法載入 OCR 元件，請確認網路連線'));
    document.head.appendChild(s);
  });
}

// 對圖片（canvas）進行辨識，回傳每一行文字與信心分數
export async function recognize(canvas, onProgress) {
  await loadScript(TESSERACT_URL);
  const worker = await window.Tesseract.createWorker('chi_tra+eng', 1, {
    logger: (m) => onProgress && m.status && onProgress(m.status, m.progress),
  });
  try {
    await worker.setParameters({ preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(canvas);
    const lines = (data.lines || []).map((l) => ({ text: l.text.replace(/\n/g, '').trim(), confidence: l.confidence })).filter((l) => l.text);
    return { text: data.text, lines };
  } finally {
    await worker.terminate();
  }
}

const FIGURES = [
  [/收入小計/, 'income_total', 'income'],
  [/支出小計/, 'expense_total', 'expense'],
  [/前期餘[絀紬細]/, 'prior_balance', null],
  [/本期餘[絀紬細]/, 'period_balance', null],
  [/累計餘[絀紬細]/, 'cumulative_balance', null],
];
const HEADER = /^(科目名稱|摘要|金額|本期收入|本期支出|金額小計)(\s|$)/;
const AMOUNT_AT_END = /(\(?-?\s?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\)?|\(?-?\d+(?:\.\d{1,2})?\)?)\s*$/;

function normalizeText(s) {
  return String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/，/g, ',').replace(/．/g, '.').replace(/[−–—]/g, '-')
    .replace(/\[/g, '【').replace(/\]/g, '】')
    .replace(/\s+/g, ' ').trim();
}

// 將辨識或貼上的文字行轉成待核對的列
export function parseLines(lines, { side = null, method = 'ocr' } = {}) {
  const rows = [];
  let group = side === 'income' ? '本期收入' : null;
  for (const line of lines) {
    const text = normalizeText(line.text ?? line);
    const conf = line.confidence ?? null;
    if (!text || HEADER.test(text)) continue;
    const low = conf !== null && conf < LOW_CONFIDENCE;
    const base = {
      side, original_group: group, ocr_status: method === 'ocr' ? (low ? 'ocr_uncertain' : 'ocr_ok') : 'manual',
      confidence: conf === null ? null : Math.round(conf * 100) / 100,
      uncertain_fields: low ? ['全部欄位（辨識信心偏低）'] : [], review_status: 'pending', is_public: true, payer_status: 'not_applicable',
    };
    let m = text.match(AMOUNT_AT_END);
    // 「$11,214」這種帶錢號的數字是摘要內文，不是金額欄
    if (m && /[$＄]\s*$/.test(text.slice(0, m.index))) m = null;
    const amountRaw = m ? m[1].replace(/\s/g, '') : null;
    const amount = amountRaw ? parseAmount(amountRaw) : null;
    const rest = m ? text.slice(0, m.index).trim() : text;

    const fig = FIGURES.find(([re]) => re.test(rest || text));
    if (fig) {
      rows.push({ ...base, row_type: fig[1], side: fig[2] || side, original_account_name: (rest.match(fig[0]) || [''])[0],
        original_summary: '', amount_raw: amountRaw, amount,
        uncertain_fields: amount === null ? [...base.uncertain_fields, '金額'] : base.uncertain_fields });
      continue;
    }
    const g = rest.match(/^【(.+?)】/);
    if (g) {
      group = `【${g[1]}】`;
      if (amountRaw) rows.push({ ...base, row_type: 'group_subtotal', original_group: group, original_account_name: group, original_summary: '', amount_raw: amountRaw, amount,
        uncertain_fields: amount === null ? [...base.uncertain_fields, '金額'] : base.uncertain_fields });
      continue;
    }
    if (!amountRaw && rows.length && rows[rows.length - 1].row_type === 'detail') {
      // 沒有金額的行，視為上一列摘要的換行內容（需人工確認）
      const prev = rows[rows.length - 1];
      prev.original_summary = (prev.original_summary + ' ' + rest).trim();
      if (!prev.uncertain_fields.includes('摘要（跨行合併）')) prev.uncertain_fields = [...prev.uncertain_fields, '摘要（跨行合併）'];
      continue;
    }
    const sp = rest.indexOf(' ');
    const account = sp > 0 ? rest.slice(0, sp) : rest;
    const summary = sp > 0 ? rest.slice(sp + 1) : '';
    const uf = [...base.uncertain_fields];
    if (amount === null) uf.push('金額');
    if (!summary) uf.push('科目與摘要分界');
    rows.push({ ...base, row_type: 'detail', original_account_name: account, original_summary: summary, amount_raw: amountRaw, amount, uncertain_fields: uf });
  }
  return rows;
}

// 貼上的表格文字（從 Excel 複製時以 Tab 分隔）：收支 | 大項 | 科目 | 摘要 | 金額 | 交易對象
export function parsePasted(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const tabular = lines.filter((l) => l.split('\t').length >= 5);
  if (tabular.length >= lines.length * 0.6) {
    return tabular.map((l) => {
      const [s, group, account, summary, amt, cp] = l.split('\t').map((x) => x.trim());
      const side = /收/.test(s) ? 'income' : /支/.test(s) ? 'expense' : null;
      const amount = parseAmount(amt);
      const uf = [];
      if (!side) uf.push('收入或支出');
      if (amount === null) uf.push('金額');
      return { row_type: 'detail', side, original_group: group || null, original_account_name: account, original_summary: summary || '',
        amount_raw: amt, amount, counterparty_raw: cp || null, ocr_status: 'manual', uncertain_fields: uf, review_status: 'pending',
        is_public: true, payer_status: side === 'income' ? 'unconfirmed' : 'not_applicable' };
    });
  }
  return parseLines(lines, { method: 'paste' });
}

// 依關鍵字建議修繕分類（只是建議，仍需管理者確認）
export function suggestRepairCategory(summary, repairCats) {
  const s = summary || '';
  for (const c of repairCats) {
    if ((c.keywords || []).some((k) => k && s.includes(k))) return c.id;
  }
  return null;
}
