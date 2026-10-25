-- =====================================================================
-- 社區財務透明查詢系統：資料庫結構、權限與安全政策
-- 適用：Supabase (PostgreSQL 15+)
-- 執行方式：Supabase 後台 → SQL Editor → 貼上全文 → Run
--
-- 權限模型（全部在資料庫端強制執行）：
--   1. 管理者：Supabase Auth 登入，且 user_id 列於 public.app_admins。
--      只有管理者能寫入任何財務資料（RLS 政策 + 只授權 authenticated 寫入）。
--   2. 鄰居：不需帳號。以「共同瀏覽密碼」呼叫 viewer_login() 取得瀏覽憑證，
--      之後每次請求帶 x-viewer-token 標頭；RLS 以 viewer_ok() 驗證。
--      鄰居（anon 角色）完全沒有 INSERT/UPDATE/DELETE 權限。
--   3. 沒有密碼的訪客：讀不到任何財務資料。
--   4. 登入但不是管理者的帳號：讀不到、也寫不了任何資料。
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------------
-- 共用函式
-- ---------------------------------------------------------------------

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- 管理者名單（僅能由 SQL Editor / service role 維護）
create table public.app_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

-- 網站設定（單列）
create table public.app_settings (
  id                     int primary key default 1 check (id = 1),
  community_name         text not null default '社區財務透明查詢系統',
  public_notice          text,
  data_limit_notice      text not null default '本系統資料來源為社區每月收支月報表。報表只記載收支金額，無法據以判斷廠商實際成本、利潤，或社區是否因此獲利。',
  opening_balance        numeric(14,2),
  opening_balance_label  text,
  opening_roc_year       int,
  opening_month          int check (opening_month between 1 and 12),
  require_mfa            boolean not null default false,
  viewer_session_days    int not null default 30 check (viewer_session_days between 1 and 365),
  updated_at             timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict do nothing;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_admins a
    where a.user_id = auth.uid()
      and (
        not coalesce((select s.require_mfa from public.app_settings s where s.id = 1), false)
        or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      )
  );
$$;

-- ---------------------------------------------------------------------
-- 共同瀏覽密碼（private schema，API 無法讀取）
-- ---------------------------------------------------------------------

create table private.viewer_secret (
  id            int primary key default 1 check (id = 1),
  password_hash text,               -- bcrypt，永不回傳給任何客戶端
  version       int not null default 0,
  changed_at    timestamptz,
  changed_by    uuid
);
insert into private.viewer_secret (id) values (1) on conflict do nothing;

create table private.viewer_sessions (
  id               bigint generated always as identity primary key,
  token_hash       text not null unique,   -- 只存 SHA-256 雜湊
  password_version int  not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  client_ip        text
);

create table private.viewer_login_attempts (
  id         bigint generated always as identity primary key,
  client_ip  text not null,
  success    boolean not null,
  at         timestamptz not null default now()
);
create index on private.viewer_login_attempts (client_ip, at);
create index on private.viewer_login_attempts (at);

create or replace function private.request_header(p_name text) returns text
language plpgsql stable as $$
declare h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  return h ->> lower(p_name);
end $$;

create or replace function private.client_ip() returns text
language sql stable as $$
  select coalesce(
    nullif(private.request_header('cf-connecting-ip'), ''),
    nullif(trim(split_part(coalesce(private.request_header('x-forwarded-for'), ''), ',', 1)), ''),
    nullif(private.request_header('x-real-ip'), ''),
    'unknown');
$$;

-- 目前請求是否帶有有效的鄰居瀏覽憑證
create or replace function public.viewer_ok() returns boolean
language plpgsql stable security definer set search_path = public, private, extensions as $$
declare tok text;
begin
  tok := private.request_header('x-viewer-token');
  if tok is null or length(tok) < 32 or length(tok) > 128 then
    return false;
  end if;
  return exists (
    select 1
    from private.viewer_sessions s
    join private.viewer_secret v on v.id = 1
    where s.token_hash = encode(extensions.digest(tok, 'sha256'), 'hex')
      and s.password_version = v.version
      and v.password_hash is not null
      and s.revoked_at is null
      and s.expires_at > now()
  );
end $$;

-- 鄰居登入：伺服器端比對 bcrypt，含錯誤次數限制
create or replace function public.viewer_login(p_password text) returns json
language plpgsql volatile security definer set search_path = public, private, extensions as $$
declare
  ip        text := private.client_ip();
  sec       private.viewer_secret%rowtype;
  ip_fail   int;
  all_fail  int;
  tok       text;
  exp       timestamptz;
  days      int;
begin
  select * into sec from private.viewer_secret where id = 1;
  if sec.password_hash is null then
    return json_build_object('ok', false, 'error', 'not_configured');
  end if;

  -- 同一來源 15 分鐘內錯誤 5 次即暫停；全站 15 分鐘內錯誤 50 次即全面暫停
  select count(*) into ip_fail from private.viewer_login_attempts
   where client_ip = ip and not success and at > now() - interval '15 minutes';
  select count(*) into all_fail from private.viewer_login_attempts
   where not success and at > now() - interval '15 minutes';
  if ip_fail >= 5 or all_fail >= 50 then
    return json_build_object('ok', false, 'error', 'locked', 'retry_after_minutes', 15);
  end if;

  if p_password is null or length(p_password) > 200
     or extensions.crypt(p_password, sec.password_hash) <> sec.password_hash then
    insert into private.viewer_login_attempts (client_ip, success) values (ip, false);
    perform pg_sleep(0.4);
    return json_build_object('ok', false, 'error', 'invalid',
                             'remaining', greatest(0, 4 - ip_fail));
  end if;

  insert into private.viewer_login_attempts (client_ip, success) values (ip, true);
  delete from private.viewer_sessions where expires_at < now() - interval '1 day';
  delete from private.viewer_login_attempts where at < now() - interval '30 days';

  select viewer_session_days into days from public.app_settings where id = 1;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  exp := now() + make_interval(days => coalesce(days, 30));
  insert into private.viewer_sessions (token_hash, password_version, expires_at, client_ip)
  values (encode(extensions.digest(tok, 'sha256'), 'hex'), sec.version, exp, ip);
  return json_build_object('ok', true, 'token', tok, 'expires_at', exp);
end $$;

create or replace function public.viewer_logout() returns json
language plpgsql volatile security definer set search_path = public, private, extensions as $$
declare tok text := private.request_header('x-viewer-token');
begin
  if tok is not null then
    update private.viewer_sessions set revoked_at = now()
     where token_hash = encode(extensions.digest(tok, 'sha256'), 'hex') and revoked_at is null;
  end if;
  return json_build_object('ok', true);
end $$;

-- 不需登入即可取得的最少資訊（登入頁顯示社區名稱）
create or replace function public.site_info() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'community_name', s.community_name,
    'viewer_ok', public.viewer_ok(),
    'is_admin', public.is_admin(),
    'viewer_configured', (select password_hash is not null from private.viewer_secret where id = 1))
  from public.app_settings s where s.id = 1;
$$;

-- 管理者是否在 p_seconds 秒內重新輸入過密碼（依 Supabase JWT 的 amr 時間戳）
create or replace function private.admin_recently_authenticated(p_seconds int default 300) returns boolean
language sql stable as $$
  select coalesce(
    (select max((e ->> 'timestamp')::bigint)
       from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) e
      where e ->> 'method' in ('password', 'totp'))
    >= extract(epoch from now())::bigint - p_seconds,
    false);
$$;

create or replace function public.admin_set_viewer_password(p_new text, p_confirm text) returns json
language plpgsql volatile security definer set search_path = public, private, extensions as $$
declare v int;
begin
  if not public.is_admin() then
    raise exception '權限不足：只有管理者可以設定共同瀏覽密碼' using errcode = '42501';
  end if;
  if not private.admin_recently_authenticated(300) then
    return json_build_object('ok', false, 'error', 'reauth_required',
      'message', '請先重新輸入管理者密碼驗證身分（5 分鐘內有效）');
  end if;
  if p_new is null or p_new <> p_confirm then
    return json_build_object('ok', false, 'error', 'mismatch', 'message', '兩次輸入的密碼不一致');
  end if;
  if length(p_new) < 8 or length(p_new) > 100 then
    return json_build_object('ok', false, 'error', 'too_short', 'message', '密碼長度需為 8 到 100 個字元');
  end if;
  update private.viewer_secret
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)),
         version = version + 1,
         changed_at = now(),
         changed_by = auth.uid()
   where id = 1
  returning version into v;
  update private.viewer_sessions set revoked_at = now() where revoked_at is null;
  insert into public.audit_log (table_name, row_pk, action, new_data)
  values ('viewer_password', '1', 'PASSWORD_CHANGED', json_build_object('version', v)::jsonb);
  return json_build_object('ok', true, 'version', v, 'changed_at', now());
end $$;

create or replace function public.admin_revoke_viewer_sessions() returns json
language plpgsql volatile security definer set search_path = public, private as $$
declare n int;
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  update private.viewer_sessions set revoked_at = now() where revoked_at is null;
  get diagnostics n = row_count;
  insert into public.audit_log (table_name, row_pk, action, new_data)
  values ('viewer_sessions', '*', 'SESSIONS_REVOKED', json_build_object('count', n)::jsonb);
  return json_build_object('ok', true, 'revoked', n);
end $$;

create or replace function public.admin_viewer_status() returns json
language plpgsql stable security definer set search_path = public, private as $$
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  return (
    select json_build_object(
      'configured', s.password_hash is not null,
      'version', s.version,
      'changed_at', s.changed_at,
      'active_sessions', (select count(*) from private.viewer_sessions vs
                           where vs.revoked_at is null and vs.expires_at > now()
                             and vs.password_version = s.version),
      'failed_last_24h', (select count(*) from private.viewer_login_attempts a
                           where not a.success and a.at > now() - interval '24 hours'),
      'locked_sources', (select count(*) from (
                           select client_ip from private.viewer_login_attempts a
                            where not a.success and a.at > now() - interval '15 minutes'
                            group by client_ip having count(*) >= 5) x))
    from private.viewer_secret s where s.id = 1);
end $$;

create or replace function public.admin_unlock_viewer_login() returns json
language plpgsql volatile security definer set search_path = public, private as $$
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  delete from private.viewer_login_attempts where not success;
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 稽核紀錄
-- ---------------------------------------------------------------------

create table public.audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_pk     text,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb,
  actor      uuid default auth.uid(),
  at         timestamptz not null default now()
);
create index on public.audit_log (table_name, at desc);

create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare pk text;
begin
  if tg_op = 'DELETE' then
    pk := coalesce(to_jsonb(old) ->> 'id', to_jsonb(old)::text);
    insert into public.audit_log (table_name, row_pk, action, old_data)
    values (tg_table_name, pk, tg_op, to_jsonb(old));
    return old;
  elsif tg_op = 'UPDATE' then
    if to_jsonb(old) - 'updated_at' = to_jsonb(new) - 'updated_at' then
      return new;
    end if;
    pk := coalesce(to_jsonb(new) ->> 'id', to_jsonb(new)::text);
    insert into public.audit_log (table_name, row_pk, action, old_data, new_data)
    values (tg_table_name, pk, tg_op, to_jsonb(old), to_jsonb(new));
    return new;
  else
    pk := coalesce(to_jsonb(new) ->> 'id', to_jsonb(new)::text);
    insert into public.audit_log (table_name, row_pk, action, new_data)
    values (tg_table_name, pk, tg_op, to_jsonb(new));
    return new;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 參考資料：分析分類、科目、修繕分類、廠商
-- ---------------------------------------------------------------------

create table public.analysis_categories (
  id          bigint generated by default as identity primary key,
  side        text not null check (side in ('income', 'expense')),
  name        text not null,
  is_repair   boolean not null default false,
  sort_order  int not null default 0,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (side, name)
);

create table public.accounts (
  id                   bigint generated by default as identity primary key,
  side                 text not null check (side in ('income', 'expense')),
  standard_name        text not null,
  analysis_category_id bigint references public.analysis_categories(id) on delete set null,
  is_repair            boolean not null default false,
  sort_order           int not null default 0,
  active               boolean not null default true,
  description          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (side, standard_name)
);

-- 原始科目名稱 → 標準化科目（由管理者確認）
create table public.account_mappings (
  id         bigint generated by default as identity primary key,
  side       text not null check (side in ('income', 'expense')),
  raw_name   text not null,
  account_id bigint not null references public.accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (side, raw_name)
);

create table public.repair_categories (
  id          bigint generated by default as identity primary key,
  name        text not null unique,
  keywords    text[] not null default '{}',
  sort_order  int not null default 0,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.vendors (
  id             bigint generated by default as identity primary key,
  canonical_name text not null unique,
  vendor_type    text,
  public_note    text,
  admin_note     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 廠商別名：pending = 尚未確認；confirmed = 管理者已確認屬於某廠商；rejected = 確認不歸戶
create table public.vendor_aliases (
  id           bigint generated by default as identity primary key,
  alias_name   text not null unique,
  vendor_id    bigint references public.vendors(id) on delete set null,
  status       text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  confirmed_at timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (status <> 'confirmed' or vendor_id is not null)
);

-- ---------------------------------------------------------------------
-- 月報表、來源檔案、報表小計
-- ---------------------------------------------------------------------

create table public.reports (
  id                          bigint generated by default as identity primary key,
  roc_year                    int not null check (roc_year between 80 and 200),
  month                       int not null check (month between 1 and 12),
  title                       text,
  period_text                 text,
  status                      text not null default 'draft' check (status in ('draft', 'reviewing', 'verified')),
  is_published                boolean not null default false,
  published_at                timestamptz,
  -- 報表上印的數字（原樣記錄，不由系統計算）
  reported_prior_balance      numeric(14,2),
  reported_income_total       numeric(14,2),
  reported_expense_total      numeric(14,2),
  reported_period_balance     numeric(14,2),
  reported_cumulative_balance numeric(14,2),
  reported_figures_note       text,
  -- 銀行實際餘額（另行由存摺／對帳單取得，與報表結餘是不同概念）
  bank_balance                numeric(14,2),
  bank_balance_date           date,
  bank_balance_note           text,
  public_note                 text,
  admin_note                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (roc_year, month)
);

create table public.report_files (
  id            bigint generated by default as identity primary key,
  report_id     bigint not null references public.reports(id) on delete restrict,
  storage_path  text not null unique,
  original_name text,
  mime_type     text,
  size_bytes    bigint,
  sha256        text not null unique,   -- 同一檔案重複上傳時會被擋下
  page_no       int not null default 1,
  admin_note    text,
  uploaded_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.report_subtotals (
  id              bigint generated by default as identity primary key,
  report_id       bigint not null references public.reports(id) on delete cascade,
  side            text not null check (side in ('income', 'expense')),
  label           text not null,          -- 報表原文，例如【行政合約】
  original_group  text not null,          -- 對應交易的 original_group
  reported_amount numeric(14,2) not null,
  sort_order      int not null default 0,
  review_status   text not null default 'pending' check (review_status in ('pending', 'verified', 'needs_check')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (report_id, side, original_group)
);

-- ---------------------------------------------------------------------
-- OCR／匯入暫存區（未核對資料只存在這裡，不列入任何統計）
-- ---------------------------------------------------------------------

create table public.import_batches (
  id           bigint generated by default as identity primary key,
  report_id    bigint not null references public.reports(id) on delete cascade,
  file_id      bigint references public.report_files(id) on delete set null,
  method       text not null check (method in ('ocr', 'paste', 'json', 'manual')),
  status       text not null default 'open' check (status in ('open', 'committed', 'discarded')),
  source_label text,
  raw_text     text,
  engine       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  committed_at timestamptz
);

create table public.transactions (
  id                    bigint generated by default as identity primary key,
  report_id             bigint not null references public.reports(id) on delete restrict,
  roc_year              int not null,
  month                 int not null,
  side                  text not null check (side in ('income', 'expense')),
  original_group        text,                     -- 報表原始大項，例如【修繕費】
  original_account_name text not null,            -- 原始科目名稱（不可覆蓋）
  account_id            bigint references public.accounts(id) on delete set null, -- 標準化科目
  original_summary      text not null default '', -- 原始摘要全文（不可覆蓋）
  amount                numeric(14,2) not null,
  counterparty_raw      text,                     -- 摘要中的交易對象原文
  vendor_id             bigint references public.vendors(id) on delete set null,
  payer_status          text not null default 'not_applicable'
                          check (payer_status in ('not_applicable', 'vendor_confirmed', 'unconfirmed', 'residents', 'other')),
  transaction_date      date,                     -- 原始報表有記載才填
  date_raw              text,
  analysis_category_id  bigint references public.analysis_categories(id) on delete set null,
  is_repair             boolean not null default false,
  repair_category_id    bigint references public.repair_categories(id) on delete set null,
  source_file_id        bigint references public.report_files(id) on delete set null,
  source_row_no         int,
  import_batch_id       bigint references public.import_batches(id) on delete set null,
  ocr_status            text not null default 'manual'
                          check (ocr_status in ('manual', 'ocr_ok', 'ocr_uncertain', 'ocr_unreadable', 'ai_transcribed')),
  uncertain_fields      text[] not null default '{}',
  review_status         text not null default 'pending' check (review_status in ('pending', 'verified', 'needs_check')),
  verified_at           timestamptz,
  is_public             boolean not null default true,  -- 含個資的明細設為 false，鄰居只看到彙總金額
  public_note           text,
  admin_note            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index on public.transactions (report_id);
create index on public.transactions (roc_year, month);
create index on public.transactions (vendor_id);
create index on public.transactions (account_id);

create table public.import_rows (
  id                    bigint generated by default as identity primary key,
  batch_id              bigint not null references public.import_batches(id) on delete cascade,
  row_no                int not null,
  row_type              text not null default 'detail' check (row_type in (
                          'detail', 'group_subtotal', 'income_total', 'expense_total',
                          'prior_balance', 'period_balance', 'cumulative_balance', 'ignore')),
  side                  text check (side in ('income', 'expense')),
  original_group        text,
  original_account_name text,
  original_summary      text,
  amount_raw            text,
  amount                numeric(14,2),
  counterparty_raw      text,
  payer_status          text not null default 'not_applicable'
                          check (payer_status in ('not_applicable', 'vendor_confirmed', 'unconfirmed', 'residents', 'other')),
  date_raw              text,
  transaction_date      date,
  analysis_category_id  bigint references public.analysis_categories(id) on delete set null,
  is_repair             boolean,
  repair_category_id    bigint references public.repair_categories(id) on delete set null,
  is_public             boolean not null default true,
  ocr_status            text not null default 'manual'
                          check (ocr_status in ('manual', 'ocr_ok', 'ocr_uncertain', 'ocr_unreadable', 'ai_transcribed')),
  confidence            numeric(5,2),
  uncertain_fields      text[] not null default '{}',
  review_status         text not null default 'pending' check (review_status in ('pending', 'verified', 'needs_check')),
  note                  text,
  transaction_id        bigint references public.transactions(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (batch_id, row_no)
);

-- ---------------------------------------------------------------------
-- 修繕項目追蹤
-- ---------------------------------------------------------------------

create table public.repair_items (
  id                 bigint generated by default as identity primary key,
  name               text not null,
  facility           text,
  location           text,
  repair_category_id bigint references public.repair_categories(id) on delete set null,
  public_note        text,
  admin_note         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.transaction_repair_links (
  transaction_id bigint not null references public.transactions(id) on delete cascade,
  repair_item_id bigint not null references public.repair_items(id) on delete cascade,
  note           text,
  created_at     timestamptz not null default now(),
  primary key (transaction_id, repair_item_id)
);

-- ---------------------------------------------------------------------
-- 觸發器
-- ---------------------------------------------------------------------

create or replace function public.transactions_before_write() returns trigger
language plpgsql as $$
declare r public.reports%rowtype;
begin
  select * into r from public.reports where id = new.report_id;
  new.roc_year := r.roc_year;
  new.month := r.month;
  if new.review_status = 'verified' and (tg_op = 'INSERT' or old.review_status is distinct from 'verified') then
    new.verified_at := now();
  elsif new.review_status <> 'verified' then
    new.verified_at := null;
  end if;
  -- 原始科目與原始摘要一經建立不可覆蓋（若真的抄錯，需刪除後重建，並留下稽核紀錄）
  if tg_op = 'UPDATE' and current_setting('app.allow_original_edit', true) is distinct from 'on' then
    if new.original_account_name is distinct from old.original_account_name
       or new.original_summary is distinct from old.original_summary then
      raise exception '原始科目名稱與原始摘要不可直接修改；如為抄錄錯誤，請使用「更正原始內容」功能（會留下稽核紀錄）'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger trg_transactions_before_write before insert or update on public.transactions
  for each row execute function public.transactions_before_write();

-- 報表若仍有未核對明細，不得公開
create or replace function public.reports_before_write() returns trigger
language plpgsql as $$
begin
  if new.is_published and (tg_op = 'INSERT' or not old.is_published) then
    if exists (select 1 from public.transactions t where t.report_id = new.id and t.review_status <> 'verified') then
      raise exception '此報表仍有未核對的交易明細，不能公開' using errcode = 'P0001';
    end if;
    new.published_at := now();
  elsif not new.is_published then
    new.published_at := null;
  end if;
  -- 報表年月變更時同步交易
  return new;
end $$;

create trigger trg_reports_before_write before insert or update on public.reports
  for each row execute function public.reports_before_write();

create or replace function public.reports_after_update() returns trigger
language plpgsql as $$
begin
  if new.roc_year <> old.roc_year or new.month <> old.month then
    update public.transactions set roc_year = new.roc_year, month = new.month where report_id = new.id;
  end if;
  return null;
end $$;
create trigger trg_reports_after_update after update on public.reports
  for each row execute function public.reports_after_update();

-- 公開報表中的交易，若被改回待核對，報表自動下架
create or replace function public.transactions_after_write() returns trigger
language plpgsql as $$
begin
  if new.review_status <> 'verified' then
    update public.reports set is_published = false where id = new.report_id and is_published;
  end if;
  return null;
end $$;
create trigger trg_transactions_after_write after insert or update on public.transactions
  for each row execute function public.transactions_after_write();

do $$
declare t text;
begin
  foreach t in array array['app_settings','analysis_categories','accounts','account_mappings','repair_categories',
                           'vendors','vendor_aliases','reports','report_files','report_subtotals','import_batches',
                           'import_rows','transactions','repair_items']
  loop
    execute format('create trigger trg_%s_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
  foreach t in array array['app_settings','app_admins','analysis_categories','accounts','account_mappings','repair_categories',
                           'vendors','vendor_aliases','reports','report_files','report_subtotals','import_batches',
                           'transactions','repair_items','transaction_repair_links']
  loop
    execute format('create trigger trg_%s_audit after insert or update or delete on public.%I for each row execute function public.audit_trigger()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 管理者 RPC
-- ---------------------------------------------------------------------

-- 更正原始內容（抄錄錯誤時使用，必須填寫理由，會留下稽核紀錄）
create or replace function public.admin_correct_original(
  p_transaction_id bigint, p_original_account_name text, p_original_summary text, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception '請填寫更正理由';
  end if;
  perform set_config('app.allow_original_edit', 'on', true);
  update public.transactions
     set original_account_name = p_original_account_name,
         original_summary = p_original_summary,
         admin_note = concat_ws(E'\n', admin_note,
           format('[%s 更正原始內容] %s', to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI'), p_reason))
   where id = p_transaction_id;
  perform set_config('app.allow_original_edit', 'off', true);
end $$;

-- 匯入前檢查（重複匯入、未核對、缺金額、加總差異）
create or replace function public.import_precheck(p_batch_id bigint) returns json
language plpgsql stable security definer set search_path = public as $$
declare b public.import_batches%rowtype; r public.reports%rowtype;
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  select * into b from public.import_batches where id = p_batch_id;
  select * into r from public.reports where id = b.report_id;
  return json_build_object(
    'batch_status', b.status,
    'rows', (select count(*) from public.import_rows where batch_id = b.id),
    'detail_rows', (select count(*) from public.import_rows where batch_id = b.id and row_type = 'detail'),
    'unverified_rows', (select count(*) from public.import_rows where batch_id = b.id and row_type <> 'ignore' and review_status <> 'verified'),
    'uncertain_rows', (select count(*) from public.import_rows where batch_id = b.id and row_type <> 'ignore' and cardinality(uncertain_fields) > 0 and review_status <> 'verified'),
    'missing_amount', (select count(*) from public.import_rows where batch_id = b.id and row_type <> 'ignore' and amount is null),
    'missing_side', (select count(*) from public.import_rows where batch_id = b.id and row_type in ('detail','group_subtotal') and side is null),
    'detail_income', (select coalesce(sum(amount),0) from public.import_rows where batch_id = b.id and row_type = 'detail' and side = 'income'),
    'detail_expense', (select coalesce(sum(amount),0) from public.import_rows where batch_id = b.id and row_type = 'detail' and side = 'expense'),
    'existing_transactions', (select count(*) from public.transactions where report_id = b.report_id),
    'other_committed_batches', (select count(*) from public.import_batches where report_id = b.report_id and status = 'committed' and id <> b.id),
    'possible_duplicates', (
      select coalesce(json_agg(json_build_object('row_no', ir.row_no, 'transaction_id', t.id, 'amount', t.amount,
                                                 'original_account_name', t.original_account_name)), '[]'::json)
      from public.import_rows ir
      join public.transactions t
        on t.report_id = b.report_id and t.side = ir.side and t.amount = ir.amount
       and t.original_account_name = ir.original_account_name
       and t.original_summary = coalesce(ir.original_summary, '')
      where ir.batch_id = b.id and ir.row_type = 'detail'),
    'report', json_build_object('roc_year', r.roc_year, 'month', r.month,
       'reported_income_total', r.reported_income_total, 'reported_expense_total', r.reported_expense_total));
end $$;

-- 將已核對的暫存列正式寫入交易資料表（單一交易，全部成功或全部不寫入）
create or replace function public.commit_import_batch(
  p_batch_id bigint, p_include_unverified boolean default false, p_allow_duplicate boolean default false)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  b        public.import_batches%rowtype;
  ir       public.import_rows%rowtype;
  acc_id   bigint;
  acc      public.accounts%rowtype;
  vend_id  bigint;
  tx_id    bigint;
  n_tx     int := 0;
  n_sub    int := 0;
  n_fig    int := 0;
  pc       json;
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then raise exception '找不到匯入批次'; end if;
  if b.status <> 'open' then raise exception '此批次已%s，不可重複寫入', case b.status when 'committed' then '寫入' else '捨棄' end; end if;

  pc := public.import_precheck(p_batch_id);
  if (pc ->> 'missing_amount')::int > 0 then
    raise exception '有 % 列沒有金額，請先補齊或標為「忽略」', pc ->> 'missing_amount';
  end if;
  if (pc ->> 'missing_side')::int > 0 then
    raise exception '有 % 列未指定收入或支出', pc ->> 'missing_side';
  end if;
  if not p_include_unverified and (pc ->> 'unverified_rows')::int > 0 then
    raise exception '有 % 列尚未核對。請逐筆核對，或明確選擇「以待核對狀態寫入」', pc ->> 'unverified_rows';
  end if;
  if not p_allow_duplicate and ((pc ->> 'existing_transactions')::int > 0 or (pc ->> 'other_committed_batches')::int > 0) then
    raise exception 'DUPLICATE_IMPORT: 此月報表已有 % 筆交易／% 個已寫入批次，可能重複匯入。若確定不是重複，請勾選「確認不是重複匯入」',
      pc ->> 'existing_transactions', pc ->> 'other_committed_batches';
  end if;

  for ir in select * from public.import_rows where batch_id = b.id and row_type <> 'ignore' order by row_no loop
    if ir.row_type = 'detail' then
      if coalesce(trim(ir.original_account_name), '') = '' then
        raise exception '第 % 列缺少原始科目名稱', ir.row_no;
      end if;
      -- 標準化科目：依管理者確認過的對照；沒有對照時以原始名稱建立同名科目（不改名）
      select m.account_id into acc_id from public.account_mappings m
       where m.side = ir.side and m.raw_name = ir.original_account_name;
      if acc_id is null then
        insert into public.accounts (side, standard_name) values (ir.side, ir.original_account_name)
        on conflict (side, standard_name) do nothing;
        select id into acc_id from public.accounts where side = ir.side and standard_name = ir.original_account_name;
        insert into public.account_mappings (side, raw_name, account_id) values (ir.side, ir.original_account_name, acc_id)
        on conflict do nothing;
      end if;
      select * into acc from public.accounts where id = acc_id;

      -- 廠商：只連結「管理者已確認」的別名；其餘建立待確認別名，不自動歸戶
      vend_id := null;
      if coalesce(trim(ir.counterparty_raw), '') <> '' then
        select va.vendor_id into vend_id from public.vendor_aliases va
         where va.alias_name = trim(ir.counterparty_raw) and va.status = 'confirmed';
        if vend_id is null then
          insert into public.vendor_aliases (alias_name, status) values (trim(ir.counterparty_raw), 'pending')
          on conflict (alias_name) do nothing;
        end if;
      end if;

      insert into public.transactions (
        report_id, side, original_group, original_account_name, account_id, original_summary, amount,
        counterparty_raw, vendor_id, payer_status, transaction_date, date_raw, analysis_category_id,
        is_repair, repair_category_id, source_file_id, source_row_no, import_batch_id, ocr_status,
        uncertain_fields, review_status, is_public, admin_note)
      values (
        b.report_id, ir.side, ir.original_group, ir.original_account_name, acc_id, coalesce(ir.original_summary, ''), ir.amount,
        nullif(trim(ir.counterparty_raw), ''), vend_id,
        case when ir.side = 'expense' then 'not_applicable' else ir.payer_status end,
        ir.transaction_date, ir.date_raw, coalesce(ir.analysis_category_id, acc.analysis_category_id),
        coalesce(ir.is_repair, acc.is_repair), ir.repair_category_id, b.file_id, ir.row_no, b.id, ir.ocr_status,
        ir.uncertain_fields, case when ir.review_status = 'verified' then 'verified' else 'needs_check' end,
        ir.is_public, ir.note)
      returning id into tx_id;
      update public.import_rows set transaction_id = tx_id where id = ir.id;
      n_tx := n_tx + 1;

    elsif ir.row_type = 'group_subtotal' then
      insert into public.report_subtotals (report_id, side, label, original_group, reported_amount, sort_order, review_status, note)
      values (b.report_id, ir.side, coalesce(ir.original_group, ir.original_account_name), coalesce(ir.original_group, ir.original_account_name),
              ir.amount, ir.row_no, case when ir.review_status = 'verified' then 'verified' else 'needs_check' end, ir.note)
      on conflict (report_id, side, original_group) do update
        set reported_amount = excluded.reported_amount, label = excluded.label, review_status = excluded.review_status, note = excluded.note;
      n_sub := n_sub + 1;
    else
      execute format('update public.reports set %I = $1 where id = $2',
        case ir.row_type
          when 'income_total' then 'reported_income_total'
          when 'expense_total' then 'reported_expense_total'
          when 'prior_balance' then 'reported_prior_balance'
          when 'period_balance' then 'reported_period_balance'
          when 'cumulative_balance' then 'reported_cumulative_balance'
        end) using ir.amount, b.report_id;
      n_fig := n_fig + 1;
      if cardinality(ir.uncertain_fields) > 0 or ir.review_status <> 'verified' then
        update public.reports
           set reported_figures_note = concat_ws(E'\n', reported_figures_note,
                 format('%s：待人工核對（%s）', ir.original_account_name, coalesce(ir.note, '辨識不確定')))
         where id = b.report_id;
      end if;
    end if;
  end loop;

  update public.import_batches set status = 'committed', committed_at = now() where id = b.id;
  update public.reports set status = case when exists (
      select 1 from public.transactions where report_id = b.report_id and review_status <> 'verified') then 'reviewing' else 'verified' end
   where id = b.report_id;
  return json_build_object('ok', true, 'transactions', n_tx, 'subtotals', n_sub, 'figures', n_fig);
end $$;

-- 確認別名屬於某廠商，並把相同原文的交易歸戶
create or replace function public.confirm_vendor_alias(p_alias_id bigint, p_vendor_id bigint) returns json
language plpgsql volatile security definer set search_path = public as $$
declare a public.vendor_aliases%rowtype; n int;
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  update public.vendor_aliases set vendor_id = p_vendor_id, status = 'confirmed', confirmed_at = now()
   where id = p_alias_id returning * into a;
  if not found then raise exception '找不到別名'; end if;
  update public.transactions set vendor_id = p_vendor_id
   where counterparty_raw = a.alias_name and vendor_id is distinct from p_vendor_id;
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'transactions_updated', n);
end $$;

-- 合併兩個廠商（需由管理者在畫面上二次確認後才呼叫）
create or replace function public.merge_vendors(p_from bigint, p_into bigint) returns json
language plpgsql volatile security definer set search_path = public as $$
declare n_tx int; n_alias int; v public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  if p_from = p_into then raise exception '不能與自己合併'; end if;
  select * into v from public.vendors where id = p_from;
  if not found then raise exception '找不到要合併的廠商'; end if;
  update public.transactions set vendor_id = p_into where vendor_id = p_from;
  get diagnostics n_tx = row_count;
  update public.vendor_aliases set vendor_id = p_into where vendor_id = p_from;
  get diagnostics n_alias = row_count;
  insert into public.vendor_aliases (alias_name, vendor_id, status, confirmed_at, note)
  values (v.canonical_name, p_into, 'confirmed', now(), '由廠商合併產生')
  on conflict (alias_name) do update set vendor_id = p_into, status = 'confirmed', confirmed_at = now();
  delete from public.vendors where id = p_from;
  return json_build_object('ok', true, 'transactions_moved', n_tx, 'aliases_moved', n_alias);
end $$;

-- 鄰居看不到不公開明細，但仍需看到正確總額：提供不含明細內容的彙總
create or replace function public.hidden_transaction_aggregates() returns table (
  report_id bigint, roc_year int, month int, side text, original_group text, original_account_name text,
  account_id bigint, analysis_category_id bigint, is_repair boolean, repair_category_id bigint,
  row_count bigint, amount numeric)
language sql stable security definer set search_path = public as $$
  select t.report_id, t.roc_year, t.month, t.side, t.original_group, t.original_account_name,
         t.account_id, t.analysis_category_id, t.is_repair, t.repair_category_id, count(*), sum(t.amount)
  from public.transactions t
  join public.reports r on r.id = t.report_id
  where (public.viewer_ok() or public.is_admin())
    and r.is_published and not t.is_public and t.review_status = 'verified'
  group by 1,2,3,4,5,6,7,8,9,10;
$$;

-- JSON 備份還原（只限管理者；需輸入確認字樣；預設不覆蓋既有資料）
create or replace function public.restore_backup(p_backup jsonb, p_mode text, p_confirm text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  t       text;
  pk      text;
  cols    text;
  upd     text;
  n       int;
  result  jsonb := '{}'::jsonb;
  tables  text[] := array['app_settings','analysis_categories','repair_categories','accounts','account_mappings',
                          'vendors','vendor_aliases','reports','report_files','report_subtotals','import_batches',
                          'transactions','import_rows','repair_items','transaction_repair_links'];
begin
  if not public.is_admin() then
    raise exception '權限不足' using errcode = '42501';
  end if;
  if p_backup ->> 'format' is distinct from 'community-finance-backup' then
    raise exception '這不是本系統產生的備份檔';
  end if;
  if p_mode = 'insert_missing' then
    if p_confirm is distinct from '確認還原' then raise exception '請輸入「確認還原」'; end if;
  elsif p_mode = 'overwrite' then
    if p_confirm is distinct from '確認覆蓋' then raise exception '覆蓋模式請輸入「確認覆蓋」'; end if;
  else
    raise exception '未知的還原模式';
  end if;
  -- 還原時允許寫回備份中的原始科目／摘要（僅限本次交易）
  perform set_config('app.allow_original_edit', 'on', true);

  foreach t in array tables loop
    if jsonb_typeof(p_backup -> 'tables' -> t) is distinct from 'array' then
      continue;
    end if;
    pk := case t when 'transaction_repair_links' then 'transaction_id, repair_item_id' else 'id' end;
    select string_agg(format('%I = excluded.%I', column_name, column_name), ', ')
      into upd
      from information_schema.columns
     where table_schema = 'public' and table_name = t
       and column_name not in ('id', 'transaction_id', 'repair_item_id');
    if t = 'transaction_repair_links' then
      upd := 'note = excluded.note';
    end if;
    execute format(
      'insert into public.%I select * from jsonb_populate_recordset(null::public.%I, $1) on conflict (%s) do %s',
      t, t, pk, case when p_mode = 'overwrite' then 'update set ' || upd else 'nothing' end)
      using p_backup -> 'tables' -> t;
    get diagnostics n = row_count;
    result := result || jsonb_build_object(t, jsonb_build_object(
      'in_backup', jsonb_array_length(p_backup -> 'tables' -> t), 'written', n));
    if t not in ('app_settings', 'transaction_repair_links') then
      execute format('select setval(pg_get_serial_sequence(%L, %L), greatest((select coalesce(max(id), 0) from public.%I), 1))',
                     'public.' || t, 'id', t);
    end if;
  end loop;
  insert into public.audit_log (table_name, row_pk, action, new_data)
  values ('backup', null, 'RESTORE_' || upper(p_mode), result);
  return json_build_object('ok', true, 'mode', p_mode, 'tables', result);
end $$;

-- ---------------------------------------------------------------------
-- 權限：先全部收回，再逐一授權
-- ---------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- 管理者（authenticated）可讀寫，但 RLS 仍要求 is_admin()
grant select, insert, update, delete on
  public.app_settings, public.analysis_categories, public.accounts, public.account_mappings,
  public.repair_categories, public.vendors, public.vendor_aliases, public.reports, public.report_files,
  public.report_subtotals, public.import_batches, public.import_rows, public.transactions,
  public.repair_items, public.transaction_repair_links
  to authenticated;
grant select on public.audit_log, public.app_admins to authenticated;

-- 鄰居（anon + 有效瀏覽憑證）只能 SELECT 公開欄位；完全沒有寫入權限
grant select (id, community_name, public_notice, data_limit_notice, opening_balance, opening_balance_label,
              opening_roc_year, opening_month, updated_at) on public.app_settings to anon;
grant select (id, side, name, is_repair, sort_order, description) on public.analysis_categories to anon;
grant select (id, side, standard_name, analysis_category_id, is_repair, sort_order, active, description) on public.accounts to anon;
grant select (id, name, keywords, sort_order, description) on public.repair_categories to anon;
grant select (id, canonical_name, vendor_type, public_note) on public.vendors to anon;
grant select (id, roc_year, month, title, period_text, status, is_published, published_at,
              reported_prior_balance, reported_income_total, reported_expense_total, reported_period_balance,
              reported_cumulative_balance, reported_figures_note, bank_balance, bank_balance_date,
              public_note, updated_at) on public.reports to anon;
grant select (id, report_id, side, label, original_group, reported_amount, sort_order, review_status) on public.report_subtotals to anon;
grant select (id, report_id, roc_year, month, side, original_group, original_account_name, account_id,
              original_summary, amount, counterparty_raw, vendor_id, payer_status, transaction_date, date_raw,
              analysis_category_id, is_repair, repair_category_id, source_row_no, ocr_status, review_status,
              is_public, public_note, verified_at, updated_at) on public.transactions to anon;
grant select (id, name, facility, location, repair_category_id, public_note) on public.repair_items to anon;
grant select (transaction_id, repair_item_id) on public.transaction_repair_links to anon;

grant usage on schema public to anon, authenticated;
grant execute on function public.viewer_login(text), public.viewer_logout(), public.site_info(),
                          public.hidden_transaction_aggregates()
  to anon, authenticated;
grant execute on function public.is_admin(), public.viewer_ok() to anon, authenticated;
grant execute on function public.admin_set_viewer_password(text, text), public.admin_revoke_viewer_sessions(),
                          public.admin_viewer_status(), public.admin_unlock_viewer_login(),
                          public.admin_correct_original(bigint, text, text, text),
                          public.import_precheck(bigint), public.commit_import_batch(bigint, boolean, boolean),
                          public.confirm_vendor_alias(bigint, bigint), public.merge_vendors(bigint, bigint),
                          public.restore_backup(jsonb, text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- RLS 政策
-- ---------------------------------------------------------------------

alter table public.app_admins               enable row level security;
alter table public.app_settings             enable row level security;
alter table public.analysis_categories      enable row level security;
alter table public.accounts                 enable row level security;
alter table public.account_mappings         enable row level security;
alter table public.repair_categories        enable row level security;
alter table public.vendors                  enable row level security;
alter table public.vendor_aliases           enable row level security;
alter table public.reports                  enable row level security;
alter table public.report_files             enable row level security;
alter table public.report_subtotals         enable row level security;
alter table public.import_batches           enable row level security;
alter table public.import_rows              enable row level security;
alter table public.transactions             enable row level security;
alter table public.repair_items             enable row level security;
alter table public.transaction_repair_links enable row level security;
alter table public.audit_log                enable row level security;

-- 管理者：全部資料表完整權限
do $$
declare t text;
begin
  foreach t in array array['app_settings','analysis_categories','accounts','account_mappings','repair_categories',
                           'vendors','vendor_aliases','reports','report_files','report_subtotals','import_batches',
                           'import_rows','transactions','repair_items','transaction_repair_links']
  loop
    execute format('create policy admin_all on public.%I for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);
  end loop;
end $$;
create policy admin_read on public.audit_log for select to authenticated using ((select public.is_admin()));
create policy admin_read on public.app_admins for select to authenticated using ((select public.is_admin()));

-- 鄰居：必須有有效瀏覽憑證，且只看已公開內容
create policy viewer_read on public.app_settings for select to anon using ((select public.viewer_ok()));
create policy viewer_read on public.analysis_categories for select to anon using ((select public.viewer_ok()));
create policy viewer_read on public.accounts for select to anon using ((select public.viewer_ok()));
create policy viewer_read on public.repair_categories for select to anon using ((select public.viewer_ok()));
create policy viewer_read on public.vendors for select to anon using ((select public.viewer_ok()));
create policy viewer_read on public.reports for select to anon
  using ((select public.viewer_ok()) and is_published);
create policy viewer_read on public.report_subtotals for select to anon
  using ((select public.viewer_ok()) and exists (select 1 from public.reports r where r.id = report_id and r.is_published));
create policy viewer_read on public.transactions for select to anon
  using ((select public.viewer_ok()) and is_public and review_status = 'verified'
         and exists (select 1 from public.reports r where r.id = report_id and r.is_published));
create policy viewer_read on public.repair_items for select to anon using ((select public.viewer_ok()));
create policy viewer_read on public.transaction_repair_links for select to anon
  using ((select public.viewer_ok()) and exists (select 1 from public.transactions t where t.id = transaction_id));

-- ---------------------------------------------------------------------
-- 檔案儲存：報表原始圖片（私有，只有管理者可上傳、讀取、刪除）
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('report-files', 'report-files', false)
on conflict (id) do update set public = false;

create policy report_files_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'report-files' and (select public.is_admin()));
create policy report_files_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'report-files' and (select public.is_admin()));
create policy report_files_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'report-files' and (select public.is_admin()));
create policy report_files_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'report-files' and (select public.is_admin()));
