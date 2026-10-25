-- GoTrue 建立 auth schema 之後，補上 Supabase 平台提供的 auth.uid() / auth.jwt()
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (auth.jwt() ->> 'sub')), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.role', true),
                         (auth.jwt() ->> 'role')), '')::text $$;
grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;
grant select on auth.users to service_role;
