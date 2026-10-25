// 單元測試：金額計算、報表核對、異常線索、OCR 文字解析（不需網路與資料庫）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, toCents, fmtMoney, similarity } from '../../web/js/util.js';
import { normalize, reconcile, dashboard, systemCumulative, vendorStats, repairAnomalies, repairStats } from '../../web/js/analytics.js';
import { parseLines, parsePasted } from '../../web/js/ocr.js';

test('金額解析：不確定時回傳 null，不猜測', () => {
  assert.equal(parseAmount('1,603,371'), 1603371);
  assert.equal(parseAmount('-59,780'), -59780);
  assert.equal(parseAmount('(12,345)'), -12345);
  assert.equal(parseAmount('５,０００'.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))), 5000);
  assert.equal(parseAmount('3.998'), null, '小數點後三位（報表上的 $3.998）格式不明，不猜測');
  assert.equal(parseAmount('5?4,109'), null);
  assert.equal(parseAmount('1,23,456'), null);
  assert.equal(parseAmount(''), null);
});

test('以「分」為整數加總，避免浮點誤差', () => {
  const vals = [0.1, 0.2, 0.3].map(toCents);
  assert.equal(vals.reduce((a, b) => a + b, 0), 60);
  assert.equal(fmtMoney(-1234500), '-12,345 元');
  assert.equal(fmtMoney(123456700, { unit: false }), '1,234,567');
});

function sample() {
  return normalize({
    settings: { opening_balance: 500000, opening_roc_year: 115, opening_month: 9 },
    reports: [
      { id: 1, roc_year: 115, month: 9, reported_income_total: 300, reported_expense_total: 250, reported_period_balance: 50, reported_prior_balance: 500000, reported_cumulative_balance: 500050 },
      { id: 2, roc_year: 115, month: 10, reported_income_total: 100, reported_expense_total: 90, reported_period_balance: 10, reported_prior_balance: 500050, reported_cumulative_balance: 500060 },
    ],
    subtotals: [{ report_id: 1, side: 'expense', label: '【修繕費】', original_group: '【修繕費】', reported_amount: 200, review_status: 'verified', sort_order: 1 }],
    transactions: [
      { id: 1, report_id: 1, roc_year: 115, month: 9, side: 'income', amount: 300, original_account_name: '管理費', original_summary: 'a', review_status: 'verified', payer_status: 'residents' },
      { id: 2, report_id: 1, roc_year: 115, month: 9, side: 'expense', amount: 150, original_group: '【修繕費】', original_account_name: '修繕', original_summary: 'B棟R1空調移至6F', is_repair: true, vendor_id: 7, review_status: 'verified' },
      { id: 3, report_id: 1, roc_year: 115, month: 9, side: 'expense', amount: 50, original_group: '【修繕費】', original_account_name: '修繕', original_summary: '材料', is_repair: true, review_status: 'verified' },
      { id: 4, report_id: 2, roc_year: 115, month: 10, side: 'income', amount: 100, original_account_name: '回饋金', original_summary: 'x', vendor_id: 7, payer_status: 'vendor_confirmed', review_status: 'verified' },
      { id: 5, report_id: 2, roc_year: 115, month: 10, side: 'expense', amount: 80, original_account_name: '修繕', original_summary: 'B棟R1空調移至6F 追加', is_repair: true, vendor_id: 7, review_status: 'verified' },
    ],
    hidden: [{ report_id: 2, roc_year: 115, month: 10, side: 'expense', original_account_name: '個資', row_count: 1, amount: 10 }],
    vendors: [{ id: 7, canonical_name: '千祥' }],
  });
}

test('報表核對：一致時差額為 0，不一致時列出差額', () => {
  const D = sample();
  const r1 = reconcile(D, D.reports[0]);
  assert.equal(r1.ok, false, '修繕小計 200 與明細 200 相符，但支出小計 250 與明細 200 不符');
  assert.equal(r1.rows.find((x) => x.label === '支出小計').diff, -5000);
  assert.equal(r1.groupRows[0].diff, 0);
  const r2 = reconcile(D, D.reports[1]);
  assert.equal(r2.ok, true, '不公開明細以彙總計入，總額仍一致');
});

test('三種結餘分開計算；缺月份時系統累計標示無法計算', () => {
  const D = sample();
  const cum = systemCumulative(D);
  assert.equal(cum.get(11509).value, (500000 + 100) * 100);
  assert.equal(cum.get(11510).value, (500000 + 100 + 10) * 100);
  const D2 = sample();
  D2.reports.push({ id: 3, roc_year: 115, month: 12, ymk: 11512 });
  assert.equal(systemCumulative(D2).get(11512).value, null);
  const d = dashboard(D, 11510);
  assert.equal(d.prev.income, 30000);
  assert.equal(d.lastYear, null);
});

test('廠商分析：A/B/C 分開計算，差額不是利潤', () => {
  const D = sample();
  const v = vendorStats(D).find((x) => x.vendor.id === 7);
  assert.equal(v.paid, 23000);
  assert.equal(v.received, 10000);
  assert.equal(v.unconfirmed, 0);
  assert.equal(v.net, -13000);
});

test('修繕分析與待查核線索', () => {
  const D = sample();
  const s = repairStats(D, 11510);
  assert.equal(s.cur, 8000);
  assert.equal(s.prev, 20000);
  const clues = repairAnomalies(D, { vendorMonths: 2 });
  assert.ok(clues.some((c) => c.type === 'similar'));
  assert.ok(clues.some((c) => c.type === 'vendor_months'));
  assert.ok(clues.some((c) => c.type === 'missing' && /未記載廠商/.test(c.title)));
  assert.ok(clues.every((c) => !/重複請款|浪費|不當/.test(c.title)));
});

test('相似度只用於提示', () => {
  assert.ok(similarity('大同', '大同保全') > 0.3);
  assert.ok(similarity('甲乙機電工業', '丙丁') === 0);
});

test('OCR 文字解析：辨識出小計、大項、明細，信心低時標示待人工核對', () => {
  const rows = parseLines([
    { text: '科目名稱 摘要 金額', confidence: 95 },
    { text: '【修繕費】 30,500', confidence: 92 },
    { text: '公共設備修繕費 甲公司 2026/01 屋頂排水管更換 20,000', confidence: 91 },
    { text: '公共設備修繕費 乙公司 2026/01 監控主機維修 $3,000 +A 10,500', confidence: 60 },
    { text: '棟 大廳新增鏡頭1組 $7,500', confidence: 70 },
    { text: '支出小計: 1,234,567', confidence: 90 },
    { text: '[累計餘絀] 456,789', confidence: 90 },
  ], { side: 'expense' });
  assert.equal(rows[0].row_type, 'group_subtotal');
  assert.equal(rows[0].amount, 30500);
  assert.equal(rows[1].original_account_name, '公共設備修繕費');
  assert.equal(rows[1].amount, 20000);
  assert.equal(rows[1].original_group, '【修繕費】');
  assert.equal(rows[2].ocr_status, 'ocr_uncertain');
  assert.match(rows[2].original_summary, /大廳新增鏡頭/);
  assert.ok(rows[2].uncertain_fields.includes('摘要（跨行合併）'));
  assert.equal(rows.find((r) => r.row_type === 'expense_total').amount, 1234567);
  assert.equal(rows.find((r) => r.row_type === 'cumulative_balance').amount, 456789);
  assert.ok(rows.every((r) => r.review_status === 'pending'));
});

test('貼上 Excel 表格：收支無法判斷時標示待核對', () => {
  const rows = parsePasted('收入\t本期收入\t利息收入\t115年01月份利息收入\t1,234\t\n??\t\t影印收入\t影印\t10x3\t');
  assert.equal(rows[0].side, 'income');
  assert.equal(rows[0].amount, 1234);
  assert.deepEqual(rows[1].uncertain_fields, ['收入或支出', '金額']);
  assert.equal(rows[1].amount, null);
});
