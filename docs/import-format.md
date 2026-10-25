# 匯入檔（JSON）格式

在報表頁選「JSON 匯入」時使用。匯入後所有列都進入核對區、狀態為「待核對」，必須逐筆核對才能寫入。

> 匯入檔含真實財務資料，**不要**放進公開的 GitHub 儲存庫（`.gitignore` 已排除 `*import*.json`）。

```json
{
  "format": "community-finance-import",
  "version": 1,
  "source": "115年9月收支月報表截圖，逐行轉錄",
  "report": { "roc_year": 115, "month": 9, "title": "收支月報表", "period_text": "115年9月1日至115年9月30日" },
  "rows": [
    { "row_type": "prior_balance", "original_account_name": "前期餘絀", "amount": 100000, "amount_raw": "100,000",
      "uncertain_fields": ["金額"], "note": "被印章遮住，請對照紙本" },
    { "row_type": "detail", "side": "income", "original_group": "本期收入",
      "original_account_name": "利息收入", "original_summary": "115年09月份利息收入",
      "amount": 1234, "amount_raw": "1,234", "payer_status": "unconfirmed",
      "analysis_category_name": "其他收入", "ocr_status": "ai_transcribed", "uncertain_fields": [] },
    { "row_type": "group_subtotal", "side": "expense", "original_group": "【修繕費】",
      "original_account_name": "【修繕費】", "amount": 20000 },
    { "row_type": "detail", "side": "expense", "original_group": "【修繕費】",
      "original_account_name": "公共設備修繕費", "original_summary": "某公司 2026/09 屋頂排水管更換",
      "amount": 20000, "counterparty_raw": "某公司", "payer_status": "not_applicable",
      "analysis_category_name": "修繕費", "is_repair": true, "repair_category_name": "管線／給排水",
      "is_public": true, "uncertain_fields": ["交易對象"], "note": "廠商名稱字跡細小" },
    { "row_type": "income_total",  "side": "income",  "original_account_name": "收入小計", "amount": 1234 },
    { "row_type": "expense_total", "side": "expense", "original_account_name": "支出小計", "amount": 20000 },
    { "row_type": "period_balance",     "original_account_name": "本期餘絀", "amount": -18766 },
    { "row_type": "cumulative_balance", "original_account_name": "累計餘絀", "amount": 81234 }
  ]
}
```

## 欄位說明

| 欄位 | 說明 |
|---|---|
| `row_type` | `detail` 明細、`group_subtotal` 大項小計、`income_total` 收入小計、`expense_total` 支出小計、`prior_balance` 前期餘絀、`period_balance` 本期餘絀、`cumulative_balance` 累計餘絀、`ignore` 忽略 |
| `side` | `income` 或 `expense` |
| `original_group` | 報表上的大項（如「【修繕費】」），用於小計比對 |
| `original_account_name` | 報表上的科目名稱，照原文 |
| `original_summary` | 摘要全文，照原文（含錯字，不要修正） |
| `amount` | 數字；負數照填（例如管理費折扣 `-59780`）。看不清楚就填 `null` 並在 `uncertain_fields` 加「金額」 |
| `amount_raw` | 報表上的原始寫法 |
| `counterparty_raw` | 摘要中的交易對象原文（沒有就省略） |
| `payer_status` | 收入的付款方：`residents` 住戶繳納、`vendor` 廠商、`unconfirmed` 未確認；支出填 `not_applicable` |
| `analysis_category_name` | 分析分類名稱，需與網站上的分類同名（不存在時匯入畫面會提示建立） |
| `is_repair`、`repair_category_name` | 是否修繕、修繕分類 |
| `is_public` | `false` 表示涉及個資，鄰居只看到彙總 |
| `transaction_date`、`date_raw` | 只有報表上有寫日期才填 |
| `ocr_status` | `manual`、`ocr`、`ocr_uncertain`、`ai_transcribed` |
| `uncertain_fields` | 需要人工核對的欄位名稱清單 |
| `note` | 給管理者的核對備註 |
