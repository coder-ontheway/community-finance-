# 部署步驟（第一次架站）

大約 30–40 分鐘。全程使用網頁操作，不需要在電腦上安裝任何程式。

## 一、建立 Supabase 專案

1. 到 <https://supabase.com> 註冊並登入，按 **New project**。
   - Name：例如 `community-finance`
   - Database Password：按 Generate 產生一組強密碼，**存到你的密碼管理器，不要寫進任何檔案或儲存庫**
   - Region：選 **Northeast Asia (Tokyo)** 或 **Southeast Asia (Singapore)**
2. 等專案建立完成（約 2 分鐘）。

## 二、建立資料庫結構

1. 左側選 **SQL Editor** → **New query**。
2. 打開本儲存庫的 `supabase/migrations/20261025000001_init.sql`，全選複製，貼到 SQL Editor，按 **Run**。看到 `Success. No rows returned` 即完成。
3. 再開一個 New query，貼上 `supabase/seed_reference.sql` 的內容，按 **Run**（建立分析分類與修繕分類，可重複執行）。

> 若 Run 時出現 `extension "pgcrypto" ...` 相關錯誤：到 **Database → Extensions** 確認 `pgcrypto` 已啟用後再執行一次。

## 三、建立管理者帳號（只有你）

1. 左側 **Authentication → Users → Add user → Create new user**，輸入你的 Email 與一組強密碼，勾選 **Auto Confirm User**。
2. **關閉公開註冊**：**Authentication → Sign In / Providers**（或 Settings）→ 關閉 **Allow new users to sign up**。
   這樣除了你之外，沒有人能建立帳號。（即使有人有帳號，不在管理者名單內也看不到、改不了任何資料。）
3. 回到 **SQL Editor**，執行（把 Email 換成你的）：

   ```sql
   insert into public.app_admins (user_id, note)
   select id, '社區財務管理者' from auth.users where email = '你的Email';
   ```

## 四、取得公開連線資訊

**Project Settings → API**（或 **Data API** / **API Keys**）：

- **Project URL**：形如 `https://abcdefgh.supabase.co`
- **anon public key**：建議使用 **Legacy API Keys** 分頁中的 `anon` `public` 金鑰（以 `eyJ` 開頭）。本系統以此金鑰測試過；新版 *publishable key*（`sb_publishable_` 開頭）理論上也可用。

> ⚠️ 只複製 anon／publishable 金鑰。**絕對不要**使用 `service_role` / secret key。

## 五、設定 GitHub Pages

1. 在 GitHub 儲存庫頁面 → **Settings → Secrets and variables → Actions → Variables** 分頁 → **New repository variable**，新增兩個：
   - `SUPABASE_URL`：上一步的 Project URL
   - `SUPABASE_ANON_KEY`：上一步的 anon／publishable key
   （這兩個值本來就會公開在網站上，用 Variables 即可；不需要也不應該放其他任何密碼。）
2. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 到 **Actions** 分頁，選 **Deploy to GitHub Pages** → **Run workflow**（之後每次 main 分支有更新會自動部署）。
4. 完成後網址為 `https://你的帳號.github.io/儲存庫名稱/`。

## 六、讓 Supabase 接受網站網址

**Authentication → URL Configuration**：

- **Site URL**：填入上一步的網站網址
- **Redirect URLs**：同樣加入網站網址

## 七、第一次登入與設定

1. 打開網站，點「管理者登入」，用第三步的 Email／密碼登入。
2. **科目／廠商設定 → 網站設定**：填社區名稱、公告；「系統起算餘額」填你第一份報表的「前期餘絀」與年月（例如 115 年 5 月、408,640）。
3. **科目／廠商設定 → 管理者安全**：建議啟用兩步驟驗證（Google Authenticator 等 App），啟用後可勾選「管理者必須使用兩步驟驗證」。
4. **瀏覽密碼管理**：設定社區共同瀏覽密碼（8 個字元以上），再以安全方式告訴鄰居。
5. 依 [管理者操作說明](admin-guide.md) 匯入第一份月報表。

## 八、部署後檢查（約 5 分鐘）

用手機或另一個瀏覽器（無痕視窗）：

- [ ] 輸入錯誤的共同瀏覽密碼 → 顯示錯誤，進不去
- [ ] 輸入正確密碼 → 可看到已公開的報表
- [ ] 鄰居畫面沒有任何新增／修改／刪除按鈕，網址輸入 `#/settings`、`#/viewer-password` 會被擋下
- [ ] 管理者更改共同瀏覽密碼後，鄰居頁面重新整理即被登出，舊密碼無法再登入
- [ ] 若鄰居登入後出現「無法連線」：通常是 Supabase 的 CORS 設定不允許自訂標頭 `x-viewer-token`，請截圖錯誤訊息回報（本機測試環境已驗證可用，但 Supabase 平台設定可能變動）

## 費用與維護注意

- **Supabase 免費方案閒置 7 天會自動暫停**。儲存庫已附 `.github/workflows/keepalive.yml`，每週自動呼叫一次網站的公開狀態查詢以避免暫停（使用與網站相同的 Variables）。若專案仍被暫停，到 Supabase 後台按 **Restore** 即可，資料不會遺失。
- GitHub 會在公開儲存庫 **60 天沒有任何更新** 時自動停用排程工作流程（會先寄信通知）。收到通知時到 **Actions → Keep Supabase awake → Enable workflow** 重新啟用即可。
- 免費方案資料庫 500 MB、檔案 1 GB，每月報表圖片約 0.5 MB，足夠使用多年。
- **重新部署網站不會影響資料**：資料都在 Supabase，GitHub Pages 只放網站程式。
- 定期（例如每月匯入後）到「匯出與備份」下載 JSON 完整備份，存到你自己的雲端硬碟。

## GitHub Pages 的限制（已處理）

- GitHub Pages 只能放靜態檔案、無法自訂 HTTP 標頭。因此：
  - 內容安全政策（CSP）以 `<meta>` 標籤設定；
  - 防止被內嵌（點擊劫持）改用程式判斷，被其他網站內嵌時拒絕顯示；
  - 所有權限檢查都在 Supabase 資料庫端執行，與網站放在哪裡無關。
- 公開儲存庫的程式碼任何人都看得到，所以程式碼中沒有任何秘密；即使有人複製網站，也只能用鄰居的唯讀權限讀取資料，且仍需共同瀏覽密碼。
