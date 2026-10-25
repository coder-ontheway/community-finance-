# 社區財務透明查詢系統

把社區每月「收支月報表」整理成可搜尋、可分析的網站：

- **鄰居**：輸入社區共同瀏覽密碼後唯讀查看儀表板、月報表核對、明細搜尋、廠商分析、修繕分析、收支科目分析，可下載 CSV。
- **管理者**（只有你）：以 Email＋密碼（可加兩步驟驗證）登入，負責上傳報表圖片、OCR／JSON／貼上匯入、逐筆核對、公開報表、管理分類與廠商別名、匯出備份、查看修改紀錄、管理共同瀏覽密碼。

所有權限都在資料庫（PostgreSQL Row Level Security）與伺服器端函式中執行，不是只把按鈕藏起來。鄰居即使自己寫程式直接呼叫 API，也無法新增、修改或刪除任何資料。

## 架構

| 部分 | 使用技術 | 費用 |
|---|---|---|
| 網站（純靜態 HTML／JavaScript，免建置） | GitHub Pages | 免費 |
| 資料庫、登入、檔案儲存、API | Supabase（PostgreSQL＋Auth＋Storage） | 免費方案即可 |
| 圖表／Excel 匯出 | Chart.js、SheetJS（已放在 `web/vendor/`） | 免費 |
| OCR（管理者匯入時使用） | Tesseract.js（瀏覽器端執行） | 免費 |

```
web/                 網站（部署到 GitHub Pages）
  config.example.js  連線設定範本（正式的 config.js 由部署流程自動產生，不進儲存庫）
supabase/
  migrations/        資料庫結構、權限、伺服器端函式（一個檔案）
  seed_reference.sql 分析分類、修繕分類的初始值（非財務資料）
tests/               安全驗收測試、單元測試、瀏覽器端到端測試
docs/                部署、操作說明、權限設計
.github/workflows/   自動部署到 GitHub Pages、每週喚醒 Supabase
```

## 文件

- [部署步驟](docs/deploy.md)：第一次架站照著做
- [管理者操作說明](docs/admin-guide.md)
- [鄰居使用說明](docs/neighbor-guide.md)（可直接轉貼給鄰居）
- [資料庫結構與權限設計](docs/security.md)
- [匯入檔（JSON）格式](docs/import-format.md)
- [測試方式](docs/testing.md)

## 重要原則

- 財務資料、報表圖片、備份檔**不放在這個公開儲存庫**，只存在你的 Supabase 專案中（`.gitignore` 已排除 `*.jpg`、`*.png`、`*import*.json`、`*backup*.json` 等）。
- 不在程式碼或儲存庫中放任何密碼、`service_role` 金鑰或資料庫連線字串。網站只使用 Supabase 的公開金鑰（anon / publishable key），它本來就會出現在瀏覽器中，安全性由 RLS 保證。
- 所有匯入資料先進「核對區」，必須逐筆人工核對後才寫入正式資料；OCR 看不清楚的欄位標示「待人工核對」，系統不會猜測。
- 報表核對只顯示差額，不會自動修改任何數字。
- 「待查核線索」是規則產生的提示，不是指控；廠商的收支差額不是利潤。
