# 資料庫結構與權限設計

完整定義在 `supabase/migrations/20261025000001_init.sql`。本文件說明「為什麼鄰居改不了資料」。

## 三種身分

| 身分 | 如何識別 | 讀取 | 寫入 |
|---|---|---|---|
| 管理者 | Supabase Auth 登入，且 `user_id` 在 `app_admins` 名單中（若啟用「強制兩步驟驗證」，還須 JWT 的 `aal = aal2`） | 全部 | 全部（有稽核紀錄） |
| 鄰居 | 不需帳號；以共同瀏覽密碼換得「瀏覽憑證」，每次請求帶 `x-viewer-token` 標頭 | 已公開、已核對、標示公開的資料，且只限指定欄位 | **無** |
| 其他人（無密碼訪客、非管理者帳號） | — | 無 | 無 |

## 鄰居為什麼改不了資料（三層防護）

1. **資料表權限（GRANT）**：鄰居使用的 `anon` 角色對所有資料表**只有 SELECT**，而且只授權指定欄位（例如看不到 `admin_note`、`uncertain_fields`、匯入暫存資料）。沒有 INSERT／UPDATE／DELETE 權限，資料庫在檢查任何政策前就會拒絕。
2. **列層級安全（RLS）**：所有資料表都啟用 RLS。鄰居的讀取政策要求 `viewer_ok()` 為真（瀏覽憑證有效）且資料屬於已公開報表、已核對、標示公開。寫入政策 `admin_all` 只允許 `is_admin()` 為真者。
3. **伺服器端函式**：所有管理功能（設定瀏覽密碼、寫入匯入資料、合併廠商、還原備份、更正原始內容）都在函式內第一行檢查 `is_admin()`，且對 `anon` 撤銷執行權限。

網站上「隱藏按鈕」只是使用介面；即使有人自行呼叫 API，上述三層仍會拒絕。`tests/security/acceptance.test.mjs` 以真實 API 逐項驗證（見 [測試方式](testing.md)）。

## 共同瀏覽密碼機制

| 項目 | 做法 |
|---|---|
| 保存 | 只存 bcrypt 雜湊（cost 10），放在 `private.viewer_secret`。`private` schema 不對 API 開放，`anon`／`authenticated` 都沒有權限，網站與 API 讀不到 |
| 驗證 | 伺服器端函式 `viewer_login(p_password)`；網站 JavaScript 不做任何密碼比對 |
| 憑證 | 驗證成功回傳隨機 256 位元憑證；資料庫只存其 SHA-256 雜湊（`private.viewer_sessions`），並記錄當時的密碼版本與到期時間（預設 30 天，可調整） |
| 錯誤限制 | 同一來源 IP 15 分鐘內錯 5 次 → 暫停 15 分鐘；全站 15 分鐘內錯 50 次 → 全站暫停。嘗試紀錄存在 `private.viewer_login_attempts`，錯誤時回傳 JSON（而非拋出錯誤），確保紀錄不會被交易回滾 |
| 更改 | `admin_set_viewer_password(p_new, p_confirm)`：須為管理者、且 5 分鐘內剛重新輸入過管理者密碼（檢查 JWT `amr` 時間戳），兩次輸入一致、8 字元以上。更改後版本號 +1，所有既有憑證立即撤銷，舊密碼立即失效 |
| 紀錄 | 修改紀錄只記「誰在何時更改、第幾版」，不含密碼或雜湊 |
| 備份 | JSON 備份不包含 `private` schema 的任何內容 |

## 主要資料表

| 資料表 | 用途 |
|---|---|
| `app_admins` | 管理者名單 |
| `app_settings` | 網站設定（社區名稱、公告、系統起算餘額、是否強制兩步驟驗證） |
| `reports` | 每月報表：年月、報表印出的收入小計／支出小計／前期／本期／累計餘絀、銀行餘額、是否公開 |
| `report_files` | 原始報表圖片（存在私有 Storage `report-files`，以 SHA-256 防止重複上傳） |
| `report_subtotals` | 報表上各大項的小計（用來與明細加總比對） |
| `import_batches`、`import_rows` | 匯入核對區（暫存，不進任何統計） |
| `transactions` | 正式交易明細：報表年月、收入／支出、原始大項、**原始科目名稱**、**原始摘要全文**、標準化科目、金額（numeric）、交易對象原文、歸戶廠商、付款方狀態、日期（只有報表有寫才填）、分析分類、修繕分類、來源報表與列號、OCR 狀態、人工核對狀態、是否公開、公開備註、管理者備註、建立／修改時間 |
| `accounts`、`account_mappings` | 標準化科目及原始科目名稱的對應 |
| `analysis_categories`、`repair_categories` | 分析分類、修繕分類（可調整） |
| `vendors`、`vendor_aliases` | 廠商與名稱別名（待確認／已確認／不歸戶），只有管理者確認後才歸戶 |
| `repair_items`、`transaction_repair_links` | 修繕項目追蹤 |
| `audit_log` | 修改紀錄（所有資料表的新增／修改／刪除，前後內容） |

## 資料完整性規則（資料庫觸發器）

- 原始科目名稱、原始摘要全文不可直接修改；只能透過 `admin_correct_original()` 並填寫理由。
- 有任何未核對明細的報表不能公開；已公開報表中有明細改回未核對時，自動取消公開。
- 同一份匯入資料重複寫入會被拒絕（`DUPLICATE_IMPORT`）。
- 匯入資料必須全部核對、金額齊全才能寫入正式資料。
- 所有金額以 `numeric(14,2)` 儲存，網站以「分」為整數加總，避免浮點誤差。

## 隱私

- 不公開的明細：鄰居看不到摘要與對象，只能透過 `hidden_transaction_aggregates()` 取得「該科目合計」，因此總額仍能與報表核對。
- 管理者備註、待核對欄位、匯入暫存、廠商別名、修改紀錄、原始圖片：鄰居完全無法讀取。

## 秘密管理

| 項目 | 存放位置 |
|---|---|
| Supabase URL、anon／publishable key | GitHub 儲存庫 Variables → 部署時產生 `web/config.js`（本來就公開，安全性靠 RLS） |
| 管理者密碼 | 只在 Supabase Auth（雜湊），你自己記住 |
| 共同瀏覽密碼 | 只在資料庫 `private` schema（bcrypt 雜湊） |
| `service_role` 金鑰、資料庫密碼 | 只在 Supabase 後台；**本系統完全不需要**，不要放到任何地方 |
