# 測試方式

測試分三類，都在 `tests/`：

| 測試 | 檔案 | 內容 |
|---|---|---|
| 安全驗收（21 項） | `security/acceptance.test.mjs` | 以真實 API 驗證：鄰居錯誤／正確密碼、鄰居無法新增修改刪除任何資料表、無法呼叫管理函式、非管理者帳號無權限、匯入核對與重複匯入、報表四項數字與小計比對、隱私彙總、更改瀏覽密碼後舊密碼與舊憑證失效、錯誤次數限制、Storage 權限、備份還原不覆蓋 |
| 單元測試（9 項） | `unit/analytics.test.mjs` | 金額解析、以分加總、核對、累計結餘、廠商 A／B／C 分類、修繕線索、OCR 文字解析 |
| 瀏覽器端到端（約 36 項） | `e2e/ui_flow.cjs` | 用 Chromium 實際操作：管理者匯入、核對、寫入、公開、設定瀏覽密碼；鄰居登入、唯讀、被擋在管理頁外；更改密碼後舊密碼失效；iPhone／iPad 版面；CSV／Excel／JSON 匯出 |

驗收數字（收入小計、支出小計、本期與累計餘絀、筆數）一律從 `IMPORT_JSON` 指定的匯入檔讀取，儲存庫本身不含真實財務資料。

## 執行環境

自動化測試設計在「本機模擬環境」中執行（見下節）：其中錯誤次數限制的測試需要模擬不同來源 IP，過期憑證測試需要本機的 JWT 簽章金鑰，這兩件事在雲端 Supabase 上無法由測試程式控制。

正式上線後，請依 [部署步驟](deploy.md) 第八節的「部署後檢查」在真實網站上手動確認一次（約 5 分鐘）。

```bash
cd tests && npm install
# 安全驗收＋單元測試（需先啟動本機模擬環境）
SUPABASE_URL=http://localhost:8000 ANON_KEY=... JWT_SECRET=... \
ADMIN_EMAIL=... ADMIN_PASSWORD=... OTHER_EMAIL=... OTHER_PASSWORD=... \
IMPORT_JSON=/path/to/115-09-import.json \
node --test --test-concurrency=1 security/*.mjs unit/*.mjs
# 瀏覽器端到端（需要 Playwright）
WEB=http://localhost:8080 IMPORT_JSON=... REPORT_IMG=... node e2e/ui_flow.cjs
```

## 本機完整模擬環境

`tests/local/` 內有在沒有 Docker 的環境中模擬 Supabase 的檔案（PostgreSQL＋GoTrue＋PostgREST＋簡易閘道），開發時使用：

- `00_supabase_shim.sql`：建立 Supabase 內建角色、`auth`／`storage` schema 的最小模擬
- `01_after_gotrue.sql`：GoTrue 啟動後補上的設定
- `reset.sql`：清空並重建資料庫（執行 migration）
- `gateway.mjs`：把 `/rest/v1`、`/auth/v1`、`/storage/v1` 轉送到對應服務，並模擬 Storage

正式上線請以雲端 Supabase 專案的測試結果為準。
