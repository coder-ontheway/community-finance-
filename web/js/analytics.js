// 財務統計與分析（純函式，不連網，可在 Node 以單元測試驗證）
import { toCents, ym, prevYm, lastYearYm, groupBy, similarity } from './util.js';

// 把資料庫取回的原始列整理成分析用結構
export function normalize(raw) {
  const reports = [...(raw.reports || [])].map((r) => ({ ...r, ymk: ym(r.roc_year, r.month) })).sort((a, b) => a.ymk - b.ymk);
  const reportById = new Map(reports.map((r) => [r.id, r]));
  const tx = (raw.transactions || []).map((t) => ({ ...t, cents: toCents(t.amount), ymk: ym(t.roc_year, t.month), hidden: false }));
  for (const [i, h] of (raw.hidden || []).entries()) {
    tx.push({
      id: `hidden-${i}`, report_id: h.report_id, roc_year: h.roc_year, month: h.month, ymk: ym(h.roc_year, h.month),
      side: h.side, original_group: h.original_group, original_account_name: h.original_account_name,
      account_id: h.account_id, analysis_category_id: h.analysis_category_id, is_repair: h.is_repair,
      repair_category_id: h.repair_category_id, amount: h.amount, cents: toCents(h.amount),
      original_summary: `（不公開明細 ${h.row_count} 筆，含個人資料，僅顯示彙總金額）`,
      counterparty_raw: null, vendor_id: null, payer_status: 'not_applicable', review_status: 'verified', hidden: true,
    });
  }
  return {
    settings: raw.settings || {},
    reports, reportById,
    subtotals: raw.subtotals || [],
    tx,
    categories: new Map((raw.categories || []).map((c) => [c.id, c])),
    accounts: new Map((raw.accounts || []).map((a) => [a.id, a])),
    repairCats: new Map((raw.repairCats || []).map((c) => [c.id, c])),
    vendors: new Map((raw.vendors || []).map((v) => [v.id, v])),
    aliases: raw.aliases || [],
    items: raw.items || [],
    links: raw.links || [],
    files: raw.files || [],
  };
}

export const periods = (D) => [...new Set(D.reports.map((r) => r.ymk))].sort((a, b) => a - b);

export function totalsBy(txs, keyFn) {
  const m = new Map();
  for (const t of txs) {
    const k = keyFn(t);
    if (k === undefined) continue;
    const o = m.get(k) || { income: 0, expense: 0, count: 0, rows: [] };
    o[t.side] += t.cents; o.count++; o.rows.push(t);
    m.set(k, o);
  }
  return m;
}

export const sum = (txs, pred = () => true) => txs.reduce((s, t) => (pred(t) ? s + t.cents : s), 0);

export function categoryName(D, t) {
  const c = D.categories.get(t.analysis_category_id);
  if (c) return c.name;
  const a = D.accounts.get(t.account_id);
  return a ? a.standard_name : t.original_account_name;
}
export const accountName = (D, t) => D.accounts.get(t.account_id)?.standard_name || t.original_account_name;
export const vendorName = (D, t) => D.vendors.get(t.vendor_id)?.canonical_name || null;
export const repairCatName = (D, t) => D.repairCats.get(t.repair_category_id)?.name || '未分類';

// 系統依交易計算的累計結餘：起算餘額 + 起算月份起每月（收入 − 支出）
// 若中間缺月份，之後的累計標示為「無法計算」，不以猜測補齊
export function systemCumulative(D) {
  const s = D.settings;
  const out = new Map();
  if (s.opening_balance === null || s.opening_balance === undefined || !s.opening_roc_year || !s.opening_month) {
    for (const p of periods(D)) out.set(p, { value: null, reason: '尚未設定系統起算餘額' });
    return out;
  }
  const start = ym(s.opening_roc_year, s.opening_month);
  const byMonth = totalsBy(D.tx, (t) => t.ymk);
  const have = new Set(periods(D));
  let bal = toCents(s.opening_balance);
  let broken = null;
  for (let k = start; k <= Math.max(start, ...have); k = nextYm(k)) {
    if (!have.has(k)) { broken = broken || k; continue; }
    if (broken) { out.set(k, { value: null, reason: `缺少 ${Math.floor(broken / 100)} 年 ${broken % 100} 月報表，無法連續累計` }); continue; }
    const m = byMonth.get(k) || { income: 0, expense: 0 };
    bal += m.income - m.expense;
    out.set(k, { value: bal, reason: null });
  }
  for (const p of have) if (p < start) out.set(p, { value: null, reason: '早於系統起算月份' });
  return out;
}
function nextYm(k) { const y = Math.floor(k / 100), m = k % 100; return m === 12 ? ym(y + 1, 1) : ym(y, m + 1); }

// 月報表核對：報表印的數字 vs 系統依明細計算的數字
export function reconcile(D, report) {
  const txs = D.tx.filter((t) => t.report_id === report.id);
  const inc = sum(txs, (t) => t.side === 'income');
  const exp = sum(txs, (t) => t.side === 'expense');
  const c = (v) => toCents(v);
  const rows = [];
  const add = (label, reported, system, note) => rows.push({
    label, reported, system,
    diff: reported === null || system === null ? null : system - reported,
    note,
  });
  add('收入小計', c(report.reported_income_total), inc, '系統＝所有收入明細加總');
  add('支出小計', c(report.reported_expense_total), exp, '系統＝所有支出明細加總');
  add('本期結餘', c(report.reported_period_balance), inc - exp, '系統＝收入明細 − 支出明細');
  const prior = c(report.reported_prior_balance);
  add('累計結餘', c(report.reported_cumulative_balance), prior === null ? null : prior + inc - exp,
    '系統＝報表前期餘絀 ＋ 系統本期結餘');
  const groups = D.subtotals.filter((s) => s.report_id === report.id).sort((a, b) => a.sort_order - b.sort_order);
  const groupRows = groups.map((g) => {
    const s = sum(txs, (t) => t.side === g.side && t.original_group === g.original_group);
    const reported = c(g.reported_amount);
    return { label: g.label, side: g.side, reported, system: s, diff: s - reported, review_status: g.review_status, group: g.original_group };
  });
  const internal = [];
  if (prior !== null && report.reported_period_balance !== null && report.reported_cumulative_balance !== null) {
    const d = prior + c(report.reported_period_balance) - c(report.reported_cumulative_balance);
    internal.push({ label: '報表自身：前期餘絀 ＋ 本期餘絀 − 累計餘絀', diff: d });
  }
  if (report.reported_income_total !== null && report.reported_expense_total !== null && report.reported_period_balance !== null) {
    const d = c(report.reported_income_total) - c(report.reported_expense_total) - c(report.reported_period_balance);
    internal.push({ label: '報表自身：收入小計 − 支出小計 − 本期餘絀', diff: d });
  }
  const pending = txs.filter((t) => t.review_status !== 'verified').length;
  const ok = rows.every((r) => r.diff === null || r.diff === 0) && groupRows.every((r) => r.diff === 0) && internal.every((r) => r.diff === 0);
  return { rows, groupRows, internal, pending, txCount: txs.length, ok };
}

export function dashboard(D, k) {
  const monthTx = D.tx.filter((t) => t.ymk === k);
  const inc = sum(monthTx, (t) => t.side === 'income');
  const exp = sum(monthTx, (t) => t.side === 'expense');
  const y = Math.floor(k / 100);
  const ytdTx = D.tx.filter((t) => t.roc_year === y && t.ymk <= k);
  const ytdInc = sum(ytdTx, (t) => t.side === 'income');
  const ytdExp = sum(ytdTx, (t) => t.side === 'expense');
  const repMonth = sum(monthTx, (t) => t.side === 'expense' && t.is_repair);
  const repYtd = sum(ytdTx, (t) => t.side === 'expense' && t.is_repair);
  const report = D.reports.find((r) => r.ymk === k) || null;
  const cum = systemCumulative(D).get(k) || { value: null, reason: '無資料' };
  const byMonth = totalsBy(D.tx, (t) => t.ymk);
  const cmp = (kk) => { const m = byMonth.get(kk); return m ? { income: m.income, expense: m.expense, net: m.income - m.expense } : null; };
  const expenseShare = [...totalsBy(monthTx.filter((t) => t.side === 'expense'), (t) => categoryName(D, t)).entries()]
    .map(([name, o]) => ({ name, cents: o.expense, rows: o.rows })).sort((a, b) => b.cents - a.cents);
  const trend = periods(D).map((p) => ({ ymk: p, income: byMonth.get(p)?.income || 0, expense: byMonth.get(p)?.expense || 0 }));
  return {
    k, report, monthTx, inc, exp, net: inc - exp, ytdInc, ytdExp, ytdTx, repMonth, repYtd,
    cumulative: cum, prev: cmp(prevYm(k)), lastYear: cmp(lastYearYm(k)), cur: { income: inc, expense: exp, net: inc - exp },
    expenseShare, trend,
  };
}

// 廠商分析：A 社區支付給廠商；B 已確認由廠商支付給社區；C 報表記載收入但付款方未確認
export function vendorStats(D) {
  const out = new Map();
  for (const v of D.vendors.values()) out.set(v.id, { vendor: v, paid: 0, received: 0, unconfirmed: 0, rows: [] });
  for (const t of D.tx) {
    if (!t.vendor_id || !out.has(t.vendor_id)) continue;
    const o = out.get(t.vendor_id);
    o.rows.push(t);
    if (t.side === 'expense') o.paid += t.cents;
    else if (t.payer_status === 'vendor_confirmed') o.received += t.cents;
    else o.unconfirmed += t.cents;
  }
  return [...out.values()].map((o) => ({ ...o, net: o.received - o.paid })).sort((a, b) => b.paid + b.received - (a.paid + a.received));
}

export function vendorDetail(D, vendorId) {
  const rows = D.tx.filter((t) => t.vendor_id === vendorId);
  const monthly = [...totalsBy(rows, (t) => t.ymk).entries()].sort((a, b) => a[0] - b[0]).map(([k, o]) => ({
    ymk: k, paid: sum(o.rows, (t) => t.side === 'expense'),
    received: sum(o.rows, (t) => t.side === 'income' && t.payer_status === 'vendor_confirmed'),
    unconfirmed: sum(o.rows, (t) => t.side === 'income' && t.payer_status !== 'vendor_confirmed'), rows: o.rows,
  }));
  const yearly = [...groupBy(monthly, (m) => Math.floor(m.ymk / 100)).entries()].map(([y, ms]) => ({
    year: y, paid: ms.reduce((s, m) => s + m.paid, 0), received: ms.reduce((s, m) => s + m.received, 0),
    unconfirmed: ms.reduce((s, m) => s + m.unconfirmed, 0),
  }));
  const accounts = [...totalsBy(rows, (t) => `${t.side}|${t.original_account_name}`).entries()].map(([k, o]) => ({
    side: k.split('|')[0], name: k.split('|')[1], cents: o.income + o.expense, count: o.count,
  }));
  return { rows, monthly, yearly, accounts };
}

// 修繕分析
export function repairTx(D) { return D.tx.filter((t) => t.side === 'expense' && t.is_repair); }

export function repairStats(D, k) {
  const rep = repairTx(D);
  const allExp = D.tx.filter((t) => t.side === 'expense');
  const byMonth = totalsBy(rep, (t) => t.ymk);
  const expByMonth = totalsBy(allExp, (t) => t.ymk);
  const monthly = periods(D).map((p) => ({ ymk: p, cents: byMonth.get(p)?.expense || 0, total: expByMonth.get(p)?.expense || 0, rows: byMonth.get(p)?.rows || [] }));
  const yearly = [...groupBy(monthly, (m) => Math.floor(m.ymk / 100)).entries()].map(([y, ms]) => ({
    year: y, cents: ms.reduce((s, m) => s + m.cents, 0), total: ms.reduce((s, m) => s + m.total, 0),
  }));
  const byCategory = [...totalsBy(rep, (t) => repairCatName(D, t)).entries()].map(([name, o]) => ({ name, cents: o.expense, count: o.count, rows: o.rows })).sort((a, b) => b.cents - a.cents);
  const byAccount = [...totalsBy(rep, (t) => t.original_account_name).entries()].map(([name, o]) => ({ name, cents: o.expense, count: o.count, rows: o.rows })).sort((a, b) => b.cents - a.cents);
  const byVendor = [...totalsBy(rep, (t) => vendorName(D, t) || (t.counterparty_raw ? `${t.counterparty_raw}（未歸戶）` : '（未記載廠商）')).entries()]
    .map(([name, o]) => ({ name, cents: o.expense, count: o.count, rows: o.rows, months: new Set(o.rows.map((r) => r.ymk)).size })).sort((a, b) => b.cents - a.cents);
  const years = [...new Set(rep.map((t) => t.roc_year))].sort();
  const catYear = byCategory.map((c) => ({ name: c.name, years: years.map((y) => sum(c.rows, (t) => t.roc_year === y)) }));
  const ranking = [...rep].sort((a, b) => b.cents - a.cents);
  const cur = byMonth.get(k)?.expense || 0;
  const curTotal = expByMonth.get(k)?.expense || 0;
  const prevK = prevYm(k), lyK = lastYearYm(k);
  return {
    rep, monthly, yearly, byCategory, byAccount, byVendor, years, catYear, ranking,
    cur, curTotal, curRatio: curTotal ? cur / curTotal : null,
    prev: periods(D).includes(prevK) ? byMonth.get(prevK)?.expense || 0 : null,
    lastYear: periods(D).includes(lyK) ? byMonth.get(lyK)?.expense || 0 : null,
    totalRepair: sum(rep), totalExpense: sum(allExp),
  };
}

// 異常提醒：僅為「待查核線索」，不代表任何人有不當行為
export function repairAnomalies(D, opts = {}) {
  const o = { spikeRatio: 2, spikeMin: 1000000, shortDays: 90, similar: 0.6, minRepeatAmount: 100000, vendorMonths: 3, ...opts };
  const rep = repairTx(D).filter((t) => !t.hidden);
  const clues = [];
  const ps = periods(D);

  // 1. 同類修繕金額突然增加（與前 6 個有資料月份平均比較）
  const byCat = groupBy(rep, (t) => repairCatName(D, t));
  for (const [cat, rows] of byCat) {
    const m = totalsBy(rows, (t) => t.ymk);
    for (const k of ps) {
      const cur = m.get(k)?.expense || 0;
      const hist = ps.filter((p) => p < k).slice(-6);
      if (hist.length < 2 || !cur) continue;
      const avg = hist.reduce((s, p) => s + (m.get(p)?.expense || 0), 0) / hist.length;
      if (avg > 0 && cur >= avg * o.spikeRatio && cur - avg >= o.spikeMin) {
        clues.push({ type: 'spike', title: `「${cat}」${fmtYm(k)} 修繕金額明顯高於前期平均`,
          detail: `本月 ${money(cur)}，前 ${hist.length} 個月平均 ${money(Math.round(avg))}。`, ids: m.get(k).rows.map((r) => r.id) });
      }
    }
  }

  // 2. 同一設備（修繕項目追蹤）短期內多次修繕
  const linkByItem = groupBy(D.links, (l) => l.repair_item_id);
  const txById = new Map(D.tx.map((t) => [t.id, t]));
  for (const item of D.items) {
    const rows = (linkByItem.get(item.id) || []).map((l) => txById.get(l.transaction_id)).filter(Boolean).sort((a, b) => a.ymk - b.ymk);
    for (let i = 1; i < rows.length; i++) {
      if (monthsBetween(rows[i - 1].ymk, rows[i].ymk) * 30 <= o.shortDays) {
        clues.push({ type: 'repeat_item', title: `「${item.name}」${o.shortDays} 天內有多次修繕紀錄`,
          detail: `${fmtYm(rows[i - 1].ymk)} 與 ${fmtYm(rows[i].ymk)} 都有修繕支出。`, ids: [rows[i - 1].id, rows[i].id] });
      }
    }
  }

  // 3. 相似摘要或相同金額反覆出現
  for (let i = 0; i < rep.length; i++) {
    for (let j = i + 1; j < rep.length; j++) {
      const a = rep[i], b = rep[j];
      const sim = similarity(a.original_summary, b.original_summary);
      if (sim >= o.similar) {
        clues.push({ type: 'similar', title: '摘要內容相似', detail: `相似度 ${(sim * 100).toFixed(0)}%：「${a.original_summary}」／「${b.original_summary}」`, ids: [a.id, b.id] });
      }
    }
  }
  for (const [c, rows] of groupBy(rep.filter((t) => Math.abs(t.cents) >= o.minRepeatAmount), (t) => t.cents)) {
    if (rows.length >= 2) clues.push({ type: 'same_amount', title: `相同金額 ${money(c)} 出現 ${rows.length} 次`, detail: rows.map((r) => `${fmtYm(r.ymk)} ${r.original_summary}`).join('；'), ids: rows.map((r) => r.id) });
  }

  // 4. 同一廠商在不同月份持續收取修繕費
  for (const [vid, rows] of groupBy(rep.filter((t) => t.vendor_id), (t) => t.vendor_id)) {
    const months = [...new Set(rows.map((r) => r.ymk))];
    if (months.length >= o.vendorMonths) {
      clues.push({ type: 'vendor_months', title: `「${D.vendors.get(vid)?.canonical_name || vid}」在 ${months.length} 個不同月份收取修繕費`,
        detail: `合計 ${money(sum(rows))}。`, ids: rows.map((r) => r.id) });
    }
  }

  // 5. 缺少廠商、日期或必要摘要
  const noVendor = rep.filter((t) => !t.vendor_id && !t.counterparty_raw);
  const noDate = rep.filter((t) => !t.transaction_date && !t.date_raw);
  const noSummary = rep.filter((t) => (t.original_summary || '').replace(/\s/g, '').length < 4);
  if (noVendor.length) clues.push({ type: 'missing', title: `${noVendor.length} 筆修繕支出未記載廠商`, detail: '報表摘要中沒有可辨識的廠商名稱。', ids: noVendor.map((t) => t.id) });
  if (noDate.length) clues.push({ type: 'missing', title: `${noDate.length} 筆修繕支出沒有交易日期`, detail: '原始報表未記載交易日期（只有報表月份）。', ids: noDate.map((t) => t.id) });
  if (noSummary.length) clues.push({ type: 'missing', title: `${noSummary.length} 筆修繕支出摘要過短`, detail: '摘要不足以判斷修繕內容。', ids: noSummary.map((t) => t.id) });
  return clues;
}

export function accountStats(D, mode = 'standard') {
  const keyFn = mode === 'original' ? (t) => `${t.side}|${t.original_account_name}` : mode === 'category' ? (t) => `${t.side}|${categoryName(D, t)}` : (t) => `${t.side}|${accountName(D, t)}`;
  const m = totalsBy(D.tx, keyFn);
  return [...m.entries()].map(([k, o]) => {
    const [side, name] = k.split('|');
    return { key: k, side, name, cents: o[side], count: o.count, rows: o.rows };
  }).sort((a, b) => (a.side === b.side ? b.cents - a.cents : a.side === 'income' ? -1 : 1));
}

export function seriesByMonth(rows) {
  const m = totalsBy(rows, (t) => t.ymk);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, o]) => ({ ymk: k, cents: o.income + o.expense, rows: o.rows }));
}

function monthsBetween(a, b) { return (Math.floor(b / 100) - Math.floor(a / 100)) * 12 + (b % 100) - (a % 100); }
const fmtYm = (k) => `${Math.floor(k / 100)} 年 ${k % 100} 月`;
const money = (c) => (c / 100).toLocaleString('en-US') + ' 元';
