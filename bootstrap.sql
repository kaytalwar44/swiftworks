-- =============================================================================
-- bootstrap.sql  (v2)
-- SwiftWorks — Phase 1.
--
-- Contains ONLY:
--   * CREATE SCHEMA
--   * CREATE EXTENSION
--   * custom types (enums)
--   * table-independent helper functions
--   * table-independent utility functions
--
-- Contains NO application-table references. Safe on an empty database.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto   with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_trgm    with schema extensions;

-- -----------------------------------------------------------------------------
-- 2. Schemas
-- -----------------------------------------------------------------------------
create schema if not exists app;

comment on schema app is
  'SwiftWorks internal helpers. Not exposed via PostgREST.';

revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Custom types
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_status') then
    create type app.user_status as enum ('invited','active','suspended','disabled');
  end if;
  if not exists (select 1 from pg_type where typname = 'member_type') then
    create type app.member_type as enum ('staff','partner','technician','customer_service');
  end if;
  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type app.job_status as enum ('draft','scheduled','published','in_progress','completed','cancelled','archived');
  end if;
  if not exists (select 1 from pg_type where typname = 'slot_status') then
    create type app.slot_status as enum ('open','held','booked','completed','cancelled','blocked');
  end if;
  if not exists (select 1 from pg_type where typname = 'booking_status') then
    create type app.booking_status as enum ('pending','confirmed','rescheduled','in_progress','completed','cancelled','no_show');
  end if;
  if not exists (select 1 from pg_type where typname = 'qr_status') then
    create type app.qr_status as enum ('active','paused','expired','revoked');
  end if;
  if not exists (select 1 from pg_type where typname = 'rate_unit') then
    create type app.rate_unit as enum ('each','hour','half_day','day','metre','kilometre','fixed','percent');
  end if;
  if not exists (select 1 from pg_type where typname = 'invoice_direction') then
    create type app.invoice_direction as enum ('payable','receivable');
  end if;
  if not exists (select 1 from pg_type where typname = 'invoice_status') then
    create type app.invoice_status as enum ('draft','submitted','approved','sent','part_paid','paid','void','disputed');
  end if;
  if not exists (select 1 from pg_type where typname = 'notification_channel') then
    create type app.notification_channel as enum ('email','sms','push','in_app','webhook');
  end if;
  if not exists (select 1 from pg_type where typname = 'notification_status') then
    create type app.notification_status as enum ('queued','sending','sent','delivered','failed','cancelled','read');
  end if;
  if not exists (select 1 from pg_type where typname = 'email_status') then
    create type app.email_status as enum ('queued','sending','sent','delivered','bounced','failed','complained');
  end if;
  if not exists (select 1 from pg_type where typname = 'subscription_status') then
    create type app.subscription_status as enum ('trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused');
  end if;
  if not exists (select 1 from pg_type where typname = 'billing_interval') then
    create type app.billing_interval as enum ('day','week','month','year');
  end if;
  if not exists (select 1 from pg_type where typname = 'booking_error') then
    create type app.booking_error as enum (
      'invalid_token','qr_inactive','qr_expired','job_not_found','job_not_published',
      'job_closed','job_cancelled','slot_not_found','slot_unavailable','slot_full',
      'unit_already_booked','verification_required','verification_invalid',
      'rate_limited','invalid_input');
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Identity primitives — no application tables
-- -----------------------------------------------------------------------------

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$ select auth.uid() $$;

comment on function app.current_user_id() is
  'Current authenticated user id.';

create or replace function app.is_authenticated()
returns boolean
language sql
stable
as $$ select auth.uid() is not null $$;

comment on function app.is_authenticated() is
  'True when a Supabase session is present.';

create or replace function app.jwt_claim(p_claim text)
returns text
language sql
stable
as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> p_claim $$;

comment on function app.jwt_claim(text) is
  'Reads a single claim from the request JWT payload.';

create or replace function app.auth_role()
returns text
language sql
stable
as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;

comment on function app.auth_role() is
  'Postgres role name from the JWT (anon, authenticated, service_role).';

-- -----------------------------------------------------------------------------
-- 5. Utility functions — no application tables
-- -----------------------------------------------------------------------------

create or replace function app.slugify(p_text text)
returns text
language sql
immutable
as $$
  select trim(both '-' from
    regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'))
$$;

comment on function app.slugify(text) is
  'Normalises arbitrary text into a URL-safe slug.';

create or replace function app.normalise_phone(p_phone text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '')
$$;

comment on function app.normalise_phone(text) is
  'Strips formatting from a phone number, preserving a leading +.';

create or replace function app.is_valid_email(p_email text)
returns boolean
language sql
immutable
as $$ select p_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' $$;

comment on function app.is_valid_email(text) is
  'Basic RFC-5322-shaped email validation.';

create or replace function app.generate_booking_ref()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_ref text := '';
  i int;
begin
  for i in 1..6 loop
    v_ref := v_ref || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return 'SW-' || v_ref;
end $$;

comment on function app.generate_booking_ref() is
  'Short human-quotable booking reference. Excludes I/O/0/1 for phone read-back.';

create or replace function app.slug_to_title(p_slug text)
returns text
language sql
immutable
as $$
  select initcap(replace(coalesce(p_slug, ''), '-', ' '))
$$;

comment on function app.slug_to_title(text) is
  'Inverse of app.slugify() for display labels.';

create or replace function app.safe_jsonb_object(p_pairs text[])
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from (
    select p_pairs[i] as k, p_pairs[i + 1] as v
    from generate_series(1, coalesce(array_length(p_pairs, 1), 0), 2) as i
  ) t
  where k is not null
$$;

comment on function app.safe_jsonb_object(text[]) is
  'Builds a jsonb object from a flat key/value array, skipping null keys.';

-- -----------------------------------------------------------------------------
-- 6. Granted access
-- -----------------------------------------------------------------------------
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'app.current_user_id()',
    'app.is_authenticated()',
    'app.jwt_claim(text)',
    'app.auth_role()',
    'app.slugify(text)',
    'app.normalise_phone(text)',
    'app.is_valid_email(text)',
    'app.generate_booking_ref()',
    'app.slug_to_title(text)',
    'app.safe_jsonb_object(text[])'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
    execute format('grant  execute on function %s to service_role', v_sig);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 7. PostgREST surface
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_schemas = ''public,graphql_public''';
    execute 'alter role authenticator set pgrst.db_extra_search_path = ''public,extensions''';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 8. Verification
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := array[]::text[];
  v_ext text;
  v_fn text;
begin
  if not exists (select 1 from pg_namespace where nspname = 'app') then
    raise exception 'bootstrap failed: schema app missing' using errcode = 'P0001';
  end if;

  foreach v_ext in array array['pgcrypto','btree_gist','pg_trgm'] loop
    if not exists (select 1 from pg_extension where extname = v_ext) then
      raise exception 'bootstrap failed: extension % missing', v_ext using errcode = 'P0001';
    end if;
  end loop;

  foreach v_fn in array array[
    'current_user_id','is_authenticated','jwt_claim','auth_role',
    'slugify','normalise_phone','is_valid_email','generate_booking_ref',
    'slug_to_title','safe_jsonb_object'
  ] loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = v_fn
    ) then
      v_missing := v_missing || v_fn;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'bootstrap incomplete - unresolved helpers: %',
      array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  raise notice 'bootstrap complete: 3 extensions, app schema, 16 enum types, 10 helper functions';
end $$;
