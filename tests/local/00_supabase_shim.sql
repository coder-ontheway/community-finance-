-- 僅供本機模擬環境使用（密碼為本機測試用假值，與正式 Supabase 無關）
-- 本機測試用：模擬 Supabase 平台預先建立的角色、schema 與函式。
-- 正式環境（supabase.com）已內建這些，請勿在正式環境執行此檔。
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit password 'authpass'; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login createrole password 'authpass'; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin login password 'authpass'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to supabase_storage_admin;

create schema if not exists extensions;
grant usage on schema extensions to public;
create schema if not exists auth authorization supabase_auth_admin;
grant create on database postgres to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase 預設：public schema 新表自動授權 anon/authenticated（遷移檔會收回）
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- storage schema（簡化版，欄位與 Supabase Storage 相容的部分）
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;
create table if not exists storage.buckets (
  id text primary key, name text not null unique, owner uuid, public boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text not null, owner uuid, metadata jsonb, data bytea,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (bucket_id, name));
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
create policy buckets_read on storage.buckets for select using (true);
