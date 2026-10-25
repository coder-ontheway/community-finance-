// 複製本檔為 config.js 並填入你的 Supabase 專案資訊。
// SUPABASE_ANON_KEY 是「公開金鑰」（Supabase 後台稱 anon / publishable key），本來就會出現在瀏覽器中，
// 安全性由資料庫的 RLS 政策保證。
// ⚠️ 絕對不要填入 service_role / secret key、資料庫密碼或管理者密碼。
window.APP_CONFIG = {
  SUPABASE_URL: 'https://你的專案代碼.supabase.co',
  SUPABASE_ANON_KEY: '你的 anon public key',
};
