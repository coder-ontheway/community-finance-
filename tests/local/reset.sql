-- 本機測試：清空所有資料（保留管理者名單與資料表結構）。絕對不要在正式環境執行。
truncate public.transaction_repair_links, public.repair_items, public.import_rows, public.transactions, public.import_batches,
  public.report_subtotals, public.report_files, public.reports, public.vendor_aliases, public.vendors, public.account_mappings,
  public.accounts, public.repair_categories, public.analysis_categories, public.audit_log restart identity cascade;
truncate private.viewer_sessions, private.viewer_login_attempts restart identity;
update private.viewer_secret set password_hash = null, version = 0, changed_at = null, changed_by = null;
update public.app_settings set community_name = '社區財務透明查詢系統', public_notice = null, opening_balance = null,
  opening_balance_label = null, opening_roc_year = null, opening_month = null, require_mfa = false, viewer_session_days = 30;
delete from storage.objects;
