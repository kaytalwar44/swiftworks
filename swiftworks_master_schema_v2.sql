-- =============================================================================
-- SwiftWorks - MASTER SCHEMA  (v1.1 - reviewed & corrected)
-- Complete PostgreSQL / Supabase schema, assembled from 27 ordered migrations.
--
-- Target:   PostgreSQL 15+ (Supabase)
-- Run as:   psql -f swiftworks_master_schema.sql
--           or paste into the Supabase SQL editor (single transaction).
--
-- Contents (dependency order):
--   00. 000_prerequisites
--   01. 001_audit_logs
--   02. 002_companies
--   03. 003_roles
--   04. 004_users
--   05. 005_user_roles
--   06. 006_partners
--   07. 007_technicians
--   08. 008_customers
--   09. 009_jobs
--   10. 010_job_technicians
--   11. 011_qr_codes
--   12. 012_qr_code_scans
--   13. 013_job_slots
--   14. 014_customer_bookings
--   15. 015_rate_cards
--   16. 016_rate_card_items
--   17. 017_invoices
--   18. 018_invoice_items
--   19. 019_notifications
--   20. 020_email_accounts
--   21. 021_email_logs
--   22. 022_subscription_plans
--   23. 023_subscriptions
--   24. 024_auth
--   25. 025_rls_policies
--   26. 026_booking_rpc
--
-- Conventions
--   * UUID primary keys (gen_random_uuid()).
--   * Multi-tenant: every tenant-owned table carries company_id.
--   * Tenant integrity enforced structurally via composite (id, company_id) FKs.
--   * Soft delete: deleted_at / deleted_by. Hard DELETE is never granted.
--   * Auditing: created_at, created_by, updated_at, updated_by + audit_logs.
--   * Helpers live in the private app schema, never exposed via PostgREST.
--
-- v1.1 corrections applied (see docs/review-notes.md)
--   1. app.slot_claim() EXECUTE revoked from PUBLIC/anon/authenticated.
--   2. public.booking_housekeeping() EXECUTE revoked from PUBLIC/anon/authenticated.
--   3. app.generate_booking_ref() EXECUTE revoked from PUBLIC/anon/authenticated.
--   4. authenticator role pinned to pgrst.db_schemas = 'public,graphql_public'
--      so the private app schema is unreachable over HTTP.
--   5. public.user_invitations created BEFORE handle_new_user(), whose
--      %rowtype is resolved at function-creation time.
--   6. booking_rate_limit lookup index leads on (bucket, occurred_at desc);
--      no non-immutable now() in the index predicate.
--   7. booking_idempotency given a tenant-scoped read policy for support use.
--
-- WARNING: Section 25 enables and FORCES row level security on every table in
-- the public schema and revokes default grants from anon/authenticated. Run it
-- last, and never truncate the script before that section in production.
-- =============================================================================

set client_min_messages = warning;
set check_function_bodies = off;




-- =============================================================================
-- SECTION 0 - PREREQUISITES (extensions, app schema, enums, helpers)
-- Source: 000_prerequisites.sql
-- =============================================================================

begin;

set local search_path = public, extensions, pg_catalog;

create extension if not exists pgcrypto   with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_trgm    with schema extensions;

create schema if not exists app;
comment on schema app is 'SwiftWorks internal helpers. Never exposed via PostgREST.';

revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

create type app.user_status          as enum ('invited','active','suspended','disabled');
create type app.member_type          as enum ('staff','partner','technician','customer_service');
create type app.job_status           as enum ('draft','scheduled','published','in_progress','completed','cancelled','archived');
create type app.slot_status          as enum ('open','held','booked','completed','cancelled','blocked');
create type app.booking_status       as enum ('pending','confirmed','rescheduled','in_progress','completed','cancelled','no_show');
create type app.qr_status            as enum ('active','paused','expired','revoked');
create type app.rate_unit            as enum ('each','hour','half_day','day','metre','kilometre','fixed','percent');
create type app.invoice_direction    as enum ('payable','receivable');
create type app.invoice_status       as enum ('draft','submitted','approved','sent','part_paid','paid','void','disputed');
create type app.notification_channel as enum ('email','sms','push','in_app','webhook');
create type app.notification_status  as enum ('queued','sending','sent','delivered','failed','cancelled','read');
create type app.email_status         as enum ('queued','sending','sent','delivered','bounced','failed','complained');
create type app.subscription_status  as enum ('trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused');
create type app.billing_interval     as enum ('day','week','month','year');

-- ---------------------------------------------------------------------------
-- Identity / tenancy helpers
-- ---------------------------------------------------------------------------
create or replace function app.current_user_id()
returns uuid language sql stable
as $$ select auth.uid() $$;

create or replace function app.is_platform_admin()
returns boolean language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select coalesce(
    (select u.is_platform_admin from public.users u
      where u.id = auth.uid() and u.deleted_at is null), false)
$$;

create or replace function app.current_company_id()
returns uuid language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select u.company_id from public.users u
  where u.id = auth.uid() and u.deleted_at is null
$$;

create or replace function app.current_partner_id()
returns uuid language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select u.partner_id from public.users u
  where u.id = auth.uid() and u.deleted_at is null
$$;

create or replace function app.has_permission(p_permission text)
returns boolean language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.deleted_at is null
    where ur.user_id = auth.uid() and ur.deleted_at is null
      and (r.permissions ? '*' or r.permissions ? p_permission
           or r.permissions ? (split_part(p_permission,'.',1) || '.*'))
  ) or app.is_platform_admin()
$$;

create or replace function app.has_role(variadic p_codes text[])
returns boolean language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.deleted_at is null
    where ur.user_id = auth.uid() and ur.deleted_at is null
      and lower(r.code) = any (select lower(x) from unnest(p_codes) x)
  )
$$;

-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------
create or replace function app.tg_touch_audit()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_at := new.created_at;
    new.updated_by := new.created_by;
  elsif tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_by := coalesce(new.deleted_by, auth.uid());
    elsif new.deleted_at is null then
      new.deleted_by := null;
    end if;
  end if;
  return new;
end $$;

create or replace function app.tg_lock_company_id()
returns trigger language plpgsql as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'company_id is immutable on %.%', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function app.tg_write_audit_log()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_old jsonb := case when tg_op='INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op='DELETE' then null else to_jsonb(new) end;
  v_company uuid; v_record uuid; v_keys text[];
begin
  v_company := nullif(coalesce(v_new, v_old) ->> 'company_id','')::uuid;
  v_record  := (coalesce(v_new, v_old) ->> 'id')::uuid;
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into v_keys
    from jsonb_each(v_new)
    where v_new -> key is distinct from v_old -> key
      and key not in ('updated_at','updated_by');
    if v_keys is null then return null; end if;
  end if;
  insert into public.audit_logs (company_id, table_name, record_id, operation,
                                 actor_id, actor_role, old_data, new_data, changed_keys)
  values (v_company, tg_table_name, v_record, tg_op, auth.uid(),
          current_setting('role', true), v_old, v_new, v_keys);
  return null;
end $$;



-- =============================================================================
-- SECTION 1 - AUDIT LOGS
-- Source: 001_audit_logs.sql
-- =============================================================================

begin;

create table if not exists public.audit_logs (
  id            uuid primary key default extensions.gen_random_uuid(),
  company_id    uuid,
  table_name    text        not null,
  record_id     uuid        not null,
  operation     text        not null check (operation in ('INSERT','UPDATE','DELETE')),
  actor_id      uuid,
  actor_role    text,
  changed_at    timestamptz not null default now(),
  old_data      jsonb,
  new_data      jsonb,
  changed_keys  text[]
);

comment on table  public.audit_logs is 'Append-only forensic trail for all tenant-owned tables.';
comment on column public.audit_logs.actor_id is 'auth.uid() at time of change; NULL for system/service-role writes.';
comment on column public.audit_logs.changed_keys is 'Top-level columns that differ between old_data and new_data (UPDATE only).';

create index if not exists audit_logs_company_time_idx on public.audit_logs (company_id, changed_at desc);
create index if not exists audit_logs_record_idx       on public.audit_logs (table_name, record_id, changed_at desc);
create index if not exists audit_logs_actor_idx        on public.audit_logs (actor_id, changed_at desc);
create index if not exists audit_logs_operation_idx    on public.audit_logs (operation, changed_at desc);

-- No audit trigger on audit_logs itself (would recurse).
-- No updated_at / deleted_at: rows are immutable by policy in 090_rls.



-- =============================================================================
-- SECTION 2 - COMPANIES (tenant root)
-- Source: 002_companies.sql
-- =============================================================================

begin;

create table if not exists public.companies (
  id                 uuid primary key default extensions.gen_random_uuid(),
  slug               text        not null check (slug ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$'),
  legal_name         text        not null check (length(btrim(legal_name)) > 0),
  trading_name       text,
  abn                text,
  email              text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text,
  website            text,
  logo_url           text,
  timezone           text        not null default 'Australia/Sydney',
  currency           char(3)     not null default 'AUD',
  locale             text        not null default 'en-AU',
  default_tax_rate   numeric(5,4) not null default 0.1000
                       check (default_tax_rate >= 0 and default_tax_rate < 1),
  address_line1      text,
  address_line2      text,
  suburb             text,
  state              text,
  postcode           text,
  country            char(2)     not null default 'AU',
  settings           jsonb       not null default '{}'::jsonb,
  branding           jsonb       not null default '{}'::jsonb,
  onboarding_status  text        not null default 'pending'
                       check (onboarding_status in ('pending','in_progress','complete')),
  is_active          boolean     not null default true,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  deleted_at         timestamptz,
  deleted_by         uuid
);

comment on table public.companies is 'Tenant root. Every tenant-owned row carries this company_id.';
comment on column public.companies.settings is 'Arbitrary tenant configuration (feature flags, defaults).';
comment on column public.companies.branding is 'Colour palette, logo variants, email template overrides.';

create unique index if not exists companies_slug_uidx on public.companies (lower(slug)) where deleted_at is null;
create index if not exists companies_active_idx    on public.companies (is_active) where deleted_at is null;
create index if not exists companies_name_trgm_idx on public.companies using gin (legal_name extensions.gin_trgm_ops);

drop trigger if exists trg_companies_audit on public.companies;
create trigger trg_companies_audit before insert or update on public.companies
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_companies_auditlog on public.companies;
create trigger trg_companies_auditlog after insert or update or delete on public.companies
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 3 - ROLES
-- Source: 003_roles.sql
-- =============================================================================

begin;

create table if not exists public.roles (
  id           uuid primary key default extensions.gen_random_uuid(),
  company_id   uuid references public.companies(id) on delete cascade,
  code         text        not null check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         text        not null,
  description  text,
  permissions  jsonb       not null default '[]'::jsonb,
  is_system    boolean     not null default false,
  rank         int         not null default 100,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  deleted_at   timestamptz,
  deleted_by   uuid,
  constraint roles_permissions_is_array check (jsonb_typeof(permissions) = 'array'),
  constraint roles_id_company_uk unique (id, company_id)
);

comment on table  public.roles is 'RBAC roles. permissions is a JSONB array of permission strings.';
comment on column public.roles.permissions is
  'e.g. ["jobs.*","invoices.read","rates.manage"]. "*" = all; "prefix.*" = wildcard family.';
comment on column public.roles.company_id is 'NULL for platform system roles shared by all tenants.';

create unique index if not exists roles_scoped_code_uidx
  on public.roles (coalesce(company_id,'00000000-0000-0000-0000-000000000000'::uuid), lower(code))
  where deleted_at is null;
create index if not exists roles_company_idx on public.roles (company_id) where deleted_at is null;
create index if not exists roles_rank_idx    on public.roles (company_id, rank) where deleted_at is null;
create index if not exists roles_perms_idx   on public.roles using gin (permissions);

drop trigger if exists trg_roles_audit on public.roles;
create trigger trg_roles_audit before insert or update on public.roles
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_roles_lock on public.roles;
create trigger trg_roles_lock before update on public.roles
  for each row when (old.company_id is not null)
  execute function app.tg_lock_company_id();

drop trigger if exists trg_roles_auditlog on public.roles;
create trigger trg_roles_auditlog after insert or update or delete on public.roles
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 4 - USERS
-- Source: 004_users.sql
-- =============================================================================

begin;

create table if not exists public.users (
  id                 uuid primary key references auth.users(id) on delete cascade,
  company_id         uuid        not null references public.companies(id) on delete restrict,
  partner_id         uuid,   -- FK added in 015_partners (circular dependency)
  email              text        not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name          text,
  first_name         text,
  last_name          text,
  phone              text,
  avatar_url         text,
  job_title          text,
  status             app.user_status not null default 'invited',
  member_type        app.member_type not null default 'staff',
  is_platform_admin  boolean     not null default false,
  timezone           text        not null default 'Australia/Sydney',
  locale             text        not null default 'en-AU',
  notification_prefs jsonb       not null default '{"email":true,"sms":true,"push":true,"in_app":true}'::jsonb,
  ms_graph_user_id   text,
  ms_upn             text,
  last_seen_at       timestamptz,
  invited_at         timestamptz,
  accepted_at        timestamptz,
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id),
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id),
  constraint users_id_company_uk unique (id, company_id)
);

comment on table  public.users is 'Application user profile, 1:1 with auth.users. Tenant-scoped.';
comment on column public.users.partner_id is 'Set when the user belongs to a partner portal account.';
comment on column public.users.ms_graph_user_id is 'Entra ID object id for Microsoft Graph sendMail.';
comment on column public.users.is_platform_admin is 'Cross-tenant SwiftWorks operator. Use sparingly; audited.';

create unique index if not exists users_company_email_uidx on public.users (company_id, lower(email)) where deleted_at is null;
create index if not exists users_company_idx     on public.users (company_id) where deleted_at is null;
create index if not exists users_status_idx      on public.users (company_id, status) where deleted_at is null;
create index if not exists users_member_type_idx on public.users (company_id, member_type) where deleted_at is null;
create index if not exists users_partner_idx     on public.users (partner_id) where partner_id is not null and deleted_at is null;
create index if not exists users_ms_graph_idx    on public.users (ms_graph_user_id) where ms_graph_user_id is not null;
create index if not exists users_name_trgm_idx   on public.users using gin (full_name extensions.gin_trgm_ops);

drop trigger if exists trg_users_audit on public.users;
create trigger trg_users_audit before insert or update on public.users
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_users_lock on public.users;
create trigger trg_users_lock before update on public.users
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_users_auditlog on public.users;
create trigger trg_users_auditlog after insert or update or delete on public.users
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 5 - USER ROLES
-- Source: 005_user_roles.sql
-- =============================================================================

begin;

create table if not exists public.user_roles (
  id          uuid primary key default extensions.gen_random_uuid(),
  company_id  uuid        not null references public.companies(id) on delete cascade,
  user_id     uuid        not null,
  role_id     uuid        not null references public.roles(id) on delete cascade,
  granted_at  timestamptz not null default now(),
  granted_by  uuid references public.users(id) on delete set null,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id) on delete set null,
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id) on delete set null,
  constraint user_roles_user_fk foreign key (user_id, company_id)
    references public.users (id, company_id) on delete cascade
);

comment on table public.user_roles is 'Role assignments. expires_at enables temporary elevation.';

create unique index if not exists user_roles_unique_uidx on public.user_roles (user_id, role_id) where deleted_at is null;
create index if not exists user_roles_company_idx on public.user_roles (company_id) where deleted_at is null;
create index if not exists user_roles_role_idx    on public.user_roles (role_id) where deleted_at is null;
create index if not exists user_roles_user_idx    on public.user_roles (user_id) where deleted_at is null;
create index if not exists user_roles_expiry_idx  on public.user_roles (expires_at) where expires_at is not null and deleted_at is null;

drop trigger if exists trg_user_roles_audit on public.user_roles;
create trigger trg_user_roles_audit before insert or update on public.user_roles
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_user_roles_lock on public.user_roles;
create trigger trg_user_roles_lock before update on public.user_roles
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_user_roles_auditlog on public.user_roles;
create trigger trg_user_roles_auditlog after insert or update or delete on public.user_roles
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 6 - PARTNERS
-- Source: 006_partners.sql
-- =============================================================================

begin;

create table if not exists public.partners (
  id                 uuid primary key default extensions.gen_random_uuid(),
  company_id         uuid        not null references public.companies(id) on delete restrict,
  code               text        not null check (code ~ '^[A-Za-z0-9_-]{2,32}$'),
  name               text        not null check (length(btrim(name)) > 0),
  legal_name         text,
  trading_name       text,
  abn                text,
  contact_name       text,
  contact_email      text        check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone      text,
  billing_email      text        check (billing_email is null or billing_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  portal_enabled     boolean     not null default true,
  default_rate_card_id uuid,    -- FK added in 020_rate_cards (circular dependency)
  payment_terms_days int         not null default 14 check (payment_terms_days >= 0 and payment_terms_days <= 365),
  address_line1      text,
  address_line2      text,
  suburb             text,
  state              text,
  postcode           text,
  country            char(2)     not null default 'AU',
  notes              text,
  settings           jsonb       not null default '{}'::jsonb,
  is_active          boolean     not null default true,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id) on delete set null,
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id) on delete set null,
  constraint partners_id_company_uk unique (id, company_id)
);

comment on table  public.partners is 'External partner organisations (builders, developers, strata managers) that raise jobs.';
comment on column public.partners.code is 'Human-readable partner code used on job numbering and exports.';
comment on column public.partners.portal_enabled is 'Whether partner users may sign in to the partner portal.';

create unique index if not exists partners_company_code_uidx on public.partners (company_id, lower(code)) where deleted_at is null;
create index if not exists partners_company_idx  on public.partners (company_id) where deleted_at is null;
create index if not exists partners_active_idx   on public.partners (company_id, is_active) where deleted_at is null;
create index if not exists partners_name_trgm_idx on public.partners using gin (name extensions.gin_trgm_ops);

-- Back-fill the users.partner_id FK now that partners exists.
alter table public.users drop constraint if exists users_partner_fk;
alter table public.users add constraint users_partner_fk
  foreign key (partner_id) references public.partners(id) on delete set null;

drop trigger if exists trg_partners_audit on public.partners;
create trigger trg_partners_audit before insert or update on public.partners
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_partners_lock on public.partners;
create trigger trg_partners_lock before update on public.partners
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_partners_auditlog on public.partners;
create trigger trg_partners_auditlog after insert or update or delete on public.partners
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 7 - TECHNICIANS
-- Source: 007_technicians.sql
-- =============================================================================

begin;

create table if not exists public.technicians (
  id                 uuid primary key default extensions.gen_random_uuid(),
  company_id         uuid        not null references public.companies(id) on delete restrict,
  partner_id         uuid        references public.partners(id) on delete set null,
  user_id            uuid        references public.users(id) on delete set null,
  code               text        not null check (code ~ '^[A-Za-z0-9_-]{1,32}$'),
  full_name          text        not null check (length(btrim(full_name)) > 0),
  email              text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text,
  abn                text,
  employment_type    text        not null default 'contractor'
                       check (employment_type in ('employee','contractor','subcontractor')),
  skills             text[]      not null default '{}',
  service_areas      text[]      not null default '{}',
  max_installs_per_day int       not null default 8 check (max_installs_per_day > 0 and max_installs_per_day <= 50),
  colour             text        check (colour is null or colour ~* '^#[0-9a-f]{6}$'),
  is_available       boolean     not null default true,
  rating             numeric(3,2) check (rating is null or (rating >= 0 and rating <= 5)),
  notes              text,
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id) on delete set null,
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id) on delete set null,
  constraint technicians_id_company_uk unique (id, company_id)
);

comment on table  public.technicians is 'Technicians who perform installs. user_id is set when they have app login.';
comment on column public.technicians.max_installs_per_day is 'Default daily capacity; job_slots may override.';
comment on column public.technicians.colour is 'Hex colour used on the scheduling board.';

create unique index if not exists technicians_company_code_uidx on public.technicians (company_id, lower(code)) where deleted_at is null;
create unique index if not exists technicians_user_uidx         on public.technicians (user_id) where user_id is not null and deleted_at is null;
create index if not exists technicians_company_idx      on public.technicians (company_id) where deleted_at is null;
create index if not exists technicians_partner_idx      on public.technicians (partner_id) where deleted_at is null;
create index if not exists technicians_available_idx    on public.technicians (company_id, is_available) where deleted_at is null;
create index if not exists technicians_skills_idx       on public.technicians using gin (skills);
create index if not exists technicians_areas_idx        on public.technicians using gin (service_areas);
create index if not exists technicians_name_trgm_idx    on public.technicians using gin (full_name extensions.gin_trgm_ops);

drop trigger if exists trg_technicians_audit on public.technicians;
create trigger trg_technicians_audit before insert or update on public.technicians
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_technicians_lock on public.technicians;
create trigger trg_technicians_lock before update on public.technicians
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_technicians_auditlog on public.technicians;
create trigger trg_technicians_auditlog after insert or update or delete on public.technicians
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 8 - CUSTOMERS
-- Source: 008_customers.sql
-- =============================================================================

begin;

create table if not exists public.customers (
  id                 uuid primary key default extensions.gen_random_uuid(),
  company_id         uuid        not null references public.companies(id) on delete restrict,
  email              text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text,
  full_name          text,
  first_name         text,
  last_name          text,
  unit_number        text,
  address_line1      text,
  address_line2      text,
  suburb             text,
  state              text,
  postcode           text,
  country            char(2)     not null default 'AU',
  marketing_opt_in   boolean     not null default false,
  sms_opt_in         boolean     not null default false,
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  first_seen_at      timestamptz not null default now(),
  last_booking_at    timestamptz,
  booking_count      int         not null default 0 check (booking_count >= 0),
  no_show_count      int         not null default 0 check (no_show_count >= 0),
  notes              text,
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id) on delete set null,
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id) on delete set null,
  constraint customers_id_company_uk unique (id, company_id)
);

comment on table  public.customers is 'End customers/residents. Contact identity is email + phone, verified at booking.';
comment on column public.customers.booking_count is 'Denormalised counter maintained by the booking RPC.';
comment on column public.customers.phone_verified_at is 'Set when the SMS one-time code is confirmed at booking.';

create unique index if not exists customers_company_phone_uidx
  on public.customers (company_id, phone) where phone is not null and deleted_at is null;
create unique index if not exists customers_company_email_uidx
  on public.customers (company_id, lower(email)) where email is not null and deleted_at is null;
create index if not exists customers_company_idx   on public.customers (company_id) where deleted_at is null;
create index if not exists customers_phone_idx     on public.customers (company_id, phone) where deleted_at is null;
create index if not exists customers_email_idx     on public.customers (company_id, lower(email)) where deleted_at is null;
create index if not exists customers_unit_idx      on public.customers (company_id, unit_number) where deleted_at is null;
create index if not exists customers_name_trgm_idx on public.customers using gin (full_name extensions.gin_trgm_ops);

drop trigger if exists trg_customers_audit on public.customers;
create trigger trg_customers_audit before insert or update on public.customers
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_customers_lock on public.customers;
create trigger trg_customers_lock before update on public.customers
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_customers_auditlog on public.customers;
create trigger trg_customers_auditlog after insert or update or delete on public.customers
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 9 - JOBS
-- Source: 009_jobs.sql
-- =============================================================================

begin;

create sequence if not exists public.job_number_seq;

create table if not exists public.jobs (
  id                 uuid primary key default extensions.gen_random_uuid(),
  company_id         uuid        not null references public.companies(id) on delete restrict,
  partner_id         uuid        not null,
  job_number         text        not null check (length(btrim(job_number)) between 1 and 64),
  title              text,
  reference          text,
  status             app.job_status not null default 'draft',
  priority           int         not null default 3 check (priority between 1 and 5),

  site_name          text,
  address_line1      text        not null,
  address_line2      text,
  suburb             text        not null,
  state              text        not null,
  postcode           text        not null,
  country            char(2)     not null default 'AU',
  latitude           numeric(9,6),
  longitude          numeric(9,6),
  access_notes       text,

  unit_count         int         not null default 0 check (unit_count >= 0),
  installs_per_day   int         not null default 8 check (installs_per_day > 0 and installs_per_day <= 200),
  slot_minutes       int         not null default 60 check (slot_minutes between 5 and 480),
  day_start_time     time        not null default '08:00',
  day_end_time       time        not null default '16:00',
  working_days       int[]       not null default '{1,2,3,4,5}',  -- ISO dow: 1=Mon..7=Sun

  start_date         date        not null,
  end_date           date        not null,
  booking_opens_at   timestamptz,
  booking_closes_at  timestamptz,
  published_at       timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancellation_reason text,

  require_sms_verification boolean not null default true,
  require_email        boolean   not null default true,
  require_unit_number  boolean   not null default true,
  allow_waitlist       boolean   not null default true,
  max_units_per_booking int      not null default 1 check (max_units_per_booking >= 1),

  instructions       text,
  contact_name       text,
  contact_phone      text,
  settings           jsonb       not null default '{}'::jsonb,
  metadata           jsonb       not null default '{}'::jsonb,

  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id) on delete set null,
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id) on delete set null,

  constraint jobs_id_company_uk unique (id, company_id),
  constraint jobs_partner_fk foreign key (partner_id, company_id)
    references public.partners (id, company_id) on delete restrict,
  constraint jobs_date_order check (end_date >= start_date),
  constraint jobs_time_order  check (day_end_time > day_start_time),
  constraint jobs_working_days_valid check (
    working_days <@ array[1,2,3,4,5,6,7] and array_length(working_days,1) > 0),
  constraint jobs_latlng check (
    (latitude is null and longitude is null)
    or (latitude between -90 and 90 and longitude between -180 and 180))
);

comment on table  public.jobs is 'One install campaign at one site. Generated slot rows hang off this.';
comment on column public.jobs.installs_per_day is 'Capacity per technician per day; slot generation divides the working window by this.';
comment on column public.jobs.slot_minutes is 'Simultaneous installs per slot window; capacity x slot length must fit the working day.';
comment on column public.jobs.working_days is 'ISO day-of-week integers that slot generation may use.';
comment on column public.jobs.require_sms_verification is 'Enforce SMS OTP on the public booking page; also verifies the phone number.';

create unique index if not exists jobs_company_number_uidx on public.jobs (company_id, upper(job_number)) where deleted_at is null;
create index if not exists jobs_company_idx       on public.jobs (company_id) where deleted_at is null;
create index if not exists jobs_partner_idx       on public.jobs (partner_id) where deleted_at is null;
create index if not exists jobs_status_idx        on public.jobs (company_id, status) where deleted_at is null;
create index if not exists jobs_dates_idx          on public.jobs (company_id, start_date, end_date) where deleted_at is null;
create index if not exists jobs_active_idx        on public.jobs (company_id, published_at) where published_at is not null and deleted_at is null;
create index if not exists jobs_postcode_idx      on public.jobs (company_id, postcode) where deleted_at is null;
create index if not exists jobs_address_trgm_idx  on public.jobs using gin (address_line1 extensions.gin_trgm_ops);
create index if not exists jobs_geog_idx          on public.jobs (latitude, longitude) where latitude is not null and deleted_at is null;

drop trigger if exists trg_jobs_audit on public.jobs;
create trigger trg_jobs_audit before insert or update on public.jobs
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_jobs_lock on public.jobs;
create trigger trg_jobs_lock before update on public.jobs
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_jobs_auditlog on public.jobs;
create trigger trg_jobs_auditlog after insert or update or delete on public.jobs
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 10 - JOB TECHNICIANS
-- Source: 010_job_technicians.sql
-- =============================================================================

begin;

create table if not exists public.job_technicians (
  id            uuid primary key default extensions.gen_random_uuid(),
  company_id    uuid        not null references public.companies(id) on delete restrict,
  job_id        uuid        not null,
  technician_id uuid        not null,
  is_lead       boolean     not null default false,
  assigned_from date,
  assigned_to   date,
  daily_capacity int        check (daily_capacity is null or (daily_capacity > 0 and daily_capacity <= 50)),
  notes         text,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.users(id) on delete set null,
  deleted_at    timestamptz,
  deleted_by    uuid references public.users(id) on delete set null,
  constraint job_technicians_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete cascade,
  constraint job_technicians_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete restrict,
  constraint job_technicians_window check (
    assigned_from is null or assigned_to is null or assigned_to >= assigned_from)
);

comment on table  public.job_technicians is 'Technician assignments to a job. daily_capacity overrides the technician default for this job.';

create unique index if not exists job_technicians_uidx
  on public.job_technicians (job_id, technician_id) where deleted_at is null;
create index if not exists job_technicians_company_idx on public.job_technicians (company_id) where deleted_at is null;
create index if not exists job_technicians_job_idx     on public.job_technicians (job_id) where deleted_at is null;
create index if not exists job_technicians_tech_idx    on public.job_technicians (technician_id) where deleted_at is null;
create unique index if not exists job_technicians_lead_uidx
  on public.job_technicians (job_id) where is_lead and deleted_at is null;

drop trigger if exists trg_job_technicians_audit on public.job_technicians;
create trigger trg_job_technicians_audit before insert or update on public.job_technicians
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_job_technicians_lock on public.job_technicians;
create trigger trg_job_technicians_lock before update on public.job_technicians
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_job_technicians_auditlog on public.job_technicians;
create trigger trg_job_technicians_auditlog after insert or update or delete on public.job_technicians
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 11 - QR CODES
-- Source: 011_qr_codes.sql
-- =============================================================================

begin;

create table if not exists public.qr_codes (
  id                 uuid primary key default extensions.gen_random_uuid(),
  company_id         uuid        not null references public.companies(id) on delete restrict,
  job_id             uuid        not null,
  token              text        not null check (length(token) between 8 and 128),
  label              text,
  scope              text        not null default 'job'
                       check (scope in ('job','unit','batch')),
  unit_number        text,       -- set when scope = 'unit' (pre-filled booking)
  status             app.qr_status not null default 'active',
  target_url         text,
  image_path         text,       -- Supabase Storage path for the rendered PNG/SVG
  image_url          text,

  max_scans          int         check (max_scans is null or max_scans > 0),
  max_bookings       int         check (max_bookings is null or max_bookings > 0),
  scan_count         int         not null default 0 check (scan_count >= 0),
  booking_count      int         not null default 0 check (booking_count >= 0),
  last_scanned_at    timestamptz,

  opens_at           timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_via        text        not null default 'partner_portal'
                       check (created_via in ('partner_portal','api','import','admin')),
  metadata           jsonb       not null default '{}'::jsonb,

  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id) on delete set null,
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id) on delete set null,

  constraint qr_codes_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete cascade,
  constraint qr_codes_id_company_uk unique (id, company_id),
  constraint qr_codes_window check (expires_at is null or opens_at is null or expires_at > opens_at),
  constraint qr_codes_unit_scope check (scope <> 'unit' or unit_number is not null)
);

comment on table  public.qr_codes is 'Booking QR codes. token is the public URL secret; rotate by issuing a new row.';
comment on column public.qr_codes.scope is 'job = one code for the whole site; unit = pre-fills a specific unit; batch = printed sheet.';
comment on column public.qr_codes.token is 'Opaque random token embedded in the public booking URL. Never sequential.';
comment on column public.qr_codes.scan_count is 'Denormalised counter incremented by qr_code_scans trigger.';

create unique index if not exists qr_codes_token_uidx on public.qr_codes (token) where deleted_at is null;
create index if not exists qr_codes_company_idx on public.qr_codes (company_id) where deleted_at is null;
create index if not exists qr_codes_job_idx     on public.qr_codes (job_id) where deleted_at is null;
create index if not exists qr_codes_status_idx  on public.qr_codes (company_id, status) where deleted_at is null;
create index if not exists qr_codes_active_idx  on public.qr_codes (job_id, status)
  where status = 'active' and deleted_at is null;
create unique index if not exists qr_codes_unit_uidx
  on public.qr_codes (job_id, unit_number) where scope = 'unit' and deleted_at is null;

drop trigger if exists trg_qr_codes_audit on public.qr_codes;
create trigger trg_qr_codes_audit before insert or update on public.qr_codes
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_qr_codes_lock on public.qr_codes;
create trigger trg_qr_codes_lock before update on public.qr_codes
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_qr_codes_auditlog on public.qr_codes;
create trigger trg_qr_codes_auditlog after insert or update or delete on public.qr_codes
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 12 - QR CODE SCANS
-- Source: 012_qr_code_scans.sql
-- =============================================================================

begin;

create table if not exists public.qr_code_scans (
  id            uuid primary key default extensions.gen_random_uuid(),
  company_id    uuid        not null references public.companies(id) on delete restrict,
  qr_code_id    uuid        not null,
  scanned_at    timestamptz not null default now(),
  ip_address    inet,
  user_agent    text,
  referrer      text,
  device_type   text        check (device_type is null or device_type in ('mobile','tablet','desktop','bot','unknown')),
  os            text,
  browser       text,
  country       char(2),
  region        text,
  city          text,
  session_id    text,
  converted     boolean     not null default false,
  booking_id    uuid,       -- FK added in 016_customer_bookings (circular dependency)
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  metadata      jsonb       not null default '{}'::jsonb,
  constraint qr_code_scans_qr_fk foreign key (qr_code_id, company_id)
    references public.qr_codes (id, company_id) on delete cascade
);

comment on table  public.qr_code_scans is 'One row per QR scan/first page view. Used for funnel analytics.';

create index if not exists qr_code_scans_qr_time_idx   on public.qr_code_scans (qr_code_id, scanned_at desc);
create index if not exists qr_code_scans_company_idx   on public.qr_code_scans (company_id, scanned_at desc);
create index if not exists qr_code_scans_converted_idx on public.qr_code_scans (qr_code_id) where converted = false;
create index if not exists qr_code_scans_session_idx   on public.qr_code_scans (session_id) where session_id is not null;

-- Keep qr_codes.scan_count in sync.
create or replace function app.tg_qr_scan_count()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    update public.qr_codes
       set scan_count = scan_count + 1,
           last_scanned_at = new.scanned_at,
           updated_at = now()
     where id = new.qr_code_id;
  elsif tg_op = 'DELETE' then
    update public.qr_codes
       set scan_count = greatest(scan_count - 1, 0), updated_at = now()
     where id = old.qr_code_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_qr_code_scans_count on public.qr_code_scans;
create trigger trg_qr_code_scans_count after insert or delete on public.qr_code_scans
  for each row execute function app.tg_qr_scan_count();



-- =============================================================================
-- SECTION 13 - JOB SLOTS (capacity + slot_claim)
-- Source: 013_job_slots.sql
-- =============================================================================

begin;

create table if not exists public.job_slots (
  id              uuid primary key default extensions.gen_random_uuid(),
  company_id      uuid        not null references public.companies(id) on delete restrict,
  job_id          uuid        not null,
  technician_id   uuid,
  slot_date       date        not null,
  start_time      timestamptz not null,
  end_time        timestamptz not null,
  local_start     time        not null,
  local_end       time        not null,
  capacity        int         not null default 1 check (capacity > 0),
  booked_count    int         not null default 0 check (booked_count >= 0),
  status          app.slot_status not null default 'open',
  hold_token      text,
  hold_expires_at timestamptz,
  sequence        int         not null default 1,
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.users(id) on delete set null,
  deleted_at      timestamptz,
  deleted_by      uuid references public.users(id) on delete set null,

  constraint job_slots_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete cascade,
  constraint job_slots_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint job_slots_window check (end_time > start_time),
  constraint job_slots_capacity check (booked_count <= capacity),
  constraint job_slots_id_company_uk unique (id, company_id)
);

comment on table  public.job_slots is 'Generated bookable capacity. Public booking only ever touches these rows via a locked RPC.';
comment on column public.job_slots.booked_count is 'Denormalised seat count; guarded by constraints and the slot_claim RPC.';
comment on column public.job_slots.hold_token is 'Short-lived soft hold issued during the booking wizard.';

-- Overlap prevention: one technician cannot hold two overlapping live slots.
alter table public.job_slots drop constraint if exists job_slots_no_tech_overlap;
alter table public.job_slots add constraint job_slots_no_tech_overlap
  exclude using gist (
    technician_id with =,
    tstzrange(start_time, end_time, '[)') with &&
  )
  where (deleted_at is null
     and technician_id is not null
     and status in ('open','held','booked'));

-- A job cannot have two simultaneous slot windows with the same sequence number.
alter table public.job_slots drop constraint if exists job_slots_no_seq_overlap;
alter table public.job_slots add constraint job_slots_no_seq_overlap
  exclude using gist (
    job_id with =,
    sequence with =,
    tstzrange(start_time, end_time, '[)') with &&
  )
  where (deleted_at is null and status <> 'cancelled');

create unique index if not exists job_slots_unique_window_uidx
  on public.job_slots (job_id, slot_date, local_start, sequence) where deleted_at is null;
create index if not exists job_slots_company_idx   on public.job_slots (company_id) where deleted_at is null;
create index if not exists job_slots_job_date_idx  on public.job_slots (job_id, slot_date) where deleted_at is null;
create index if not exists job_slots_tech_date_idx on public.job_slots (technician_id, slot_date) where deleted_at is null;
create index if not exists job_slots_open_idx      on public.job_slots (job_id, slot_date, local_start)
  where status = 'open' and deleted_at is null;
create index if not exists job_slots_hold_idx      on public.job_slots (hold_expires_at)
  where hold_token is not null and deleted_at is null;

drop trigger if exists trg_job_slots_audit on public.job_slots;
create trigger trg_job_slots_audit before insert or update on public.job_slots
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_job_slots_lock on public.job_slots;
create trigger trg_job_slots_lock before update on public.job_slots
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_job_slots_auditlog on public.job_slots;
create trigger trg_job_slots_auditlog after insert or update or delete on public.job_slots
  for each row execute function app.tg_write_audit_log();

-- ---------------------------------------------------------------------------
-- app.slot_claim — the only supported way to take a seat.
-- SECURITY DEFINER, row-locked, so concurrent QR bookings cannot oversell.
-- ---------------------------------------------------------------------------
create or replace function app.slot_claim(p_slot_id uuid, p_hold_token text default null)
returns table (slot_id uuid, booked_count int, capacity int, status app.slot_status)
language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_slot public.job_slots%rowtype;
begin
  select * into v_slot
  from public.job_slots
  where id = p_slot_id and deleted_at is null
  for update;                       -- serialise concurrent claims on this row

  if not found then
    raise exception 'slot_not_found' using errcode = 'P0002';
  end if;

  if v_slot.status not in ('open','held') then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end if;

  if v_slot.hold_token is not null
     and p_hold_token is distinct from v_slot.hold_token
     and coalesce(v_slot.hold_expires_at, now() - interval '1 second') > now() then
    raise exception 'slot_held_by_another' using errcode = 'P0001';
  end if;

  if v_slot.booked_count >= v_slot.capacity then
    raise exception 'slot_full' using errcode = 'P0001';
  end if;

  update public.job_slots
     set booked_count = booked_count + 1,
         status = case when booked_count + 1 >= capacity then 'booked'::app.slot_status
                       else 'held'::app.slot_status end,
         hold_token = null,
         hold_expires_at = null,
         updated_at = now()
   where id = p_slot_id
  returning * into v_slot;

  return query select v_slot.id, v_slot.booked_count, v_slot.capacity, v_slot.status;
end $$;

revoke all on function app.slot_claim(uuid, text) from public;
grant execute on function app.slot_claim(uuid, text) to service_role;



-- =============================================================================
-- SECTION 14 - CUSTOMER BOOKINGS
-- Source: 014_customer_bookings.sql
-- =============================================================================

begin;

create table if not exists public.customer_bookings (
  id                 uuid primary key default extensions.gen_random_uuid(),
  company_id         uuid        not null references public.companies(id) on delete restrict,
  job_id             uuid        not null,
  slot_id            uuid,
  technician_id      uuid,
  customer_id        uuid,
  qr_code_id         uuid,

  booking_ref        text        not null check (length(btrim(booking_ref)) between 4 and 32),
  status             app.booking_status not null default 'pending',

  unit_number        text,
  phone              text        not null,
  email              text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name          text,
  special_comments   text,

  scheduled_date     date,
  scheduled_start    timestamptz,
  scheduled_end      timestamptz,

  sms_verified       boolean     not null default false,
  sms_verified_at    timestamptz,
  email_verified     boolean     not null default false,
  email_verified_at  timestamptz,

  confirmed_at       timestamptz,
  reminder_sent_at   timestamptz,
  checked_in_at      timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancellation_reason text,
  cancelled_by       text        check (cancelled_by is null or cancelled_by in ('customer','partner','technician','system')),

  rescheduled_from_id uuid references public.customer_bookings(id) on delete set null,
  reschedule_count   int         not null default 0 check (reschedule_count >= 0),

  source             text        not null default 'qr'
                       check (source in ('qr','link','phone','email','walk_in','import','api')),
  technician_notes   text,
  completed_notes    text,
  signature_url      text,
  photo_urls         text[]      not null default '{}',
  metadata           jsonb       not null default '{}'::jsonb,

  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id) on delete set null,

  constraint customer_bookings_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete cascade,
  constraint customer_bookings_slot_fk foreign key (slot_id, company_id)
    references public.job_slots (id, company_id) on delete set null,
  constraint customer_bookings_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint customer_bookings_customer_fk foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete set null,
  constraint customer_bookings_qr_fk foreign key (qr_code_id, company_id)
    references public.qr_codes (id, company_id) on delete set null,
  constraint customer_bookings_window check (
    scheduled_end is null or scheduled_start is null or scheduled_end > scheduled_start),
  constraint customer_bookings_id_company_uk unique (id, company_id)
);

comment on table  public.customer_bookings is 'A resident''s claimed slot. Public writes go through app.booking_create().';
comment on column public.customer_bookings.booking_ref is 'Short human-quotable reference (e.g. SW-4K2P9A).';
comment on column public.customer_bookings.unit_number is 'Free text; one unit cannot hold two live bookings for the same job.';
comment on column public.customer_bookings.special_comments is 'Free-text note the resident gives the technician.';

-- One live booking per (job, unit). Cancelled rows are excluded so the unit can re-book.
create unique index if not exists customer_bookings_unit_uidx
  on public.customer_bookings (job_id, lower(unit_number))
  where unit_number is not null
    and deleted_at is null
    and status not in ('cancelled','no_show');
create unique index if not exists customer_bookings_ref_uidx
  on public.customer_bookings (company_id, upper(booking_ref)) where deleted_at is null;
create index if not exists customer_bookings_company_idx  on public.customer_bookings (company_id, created_at desc);
create index if not exists customer_bookings_job_idx      on public.customer_bookings (job_id, scheduled_date);
create index if not exists customer_bookings_slot_idx     on public.customer_bookings (slot_id) where slot_id is not null;
create index if not exists customer_bookings_tech_date_idx on public.customer_bookings (technician_id, scheduled_date)
  where technician_id is not null;
create index if not exists customer_bookings_customer_idx on public.customer_bookings (customer_id) where customer_id is not null;
create index if not exists customer_bookings_phone_idx    on public.customer_bookings (company_id, phone);
create index if not exists customer_bookings_status_idx   on public.customer_bookings (company_id, status);
create index if not exists customer_bookings_pending_idx  on public.customer_bookings (scheduled_date)
  where status in ('pending','confirmed') and reminder_sent_at is null;

-- Back-fill the scan -> booking link now that bookings exist.
alter table public.qr_code_scans drop constraint if exists qr_code_scans_booking_fk;
alter table public.qr_code_scans add constraint qr_code_scans_booking_fk
  foreign key (booking_id) references public.customer_bookings(id) on delete set null;

-- Keep qr_codes.booking_count accurate.
create or replace function app.tg_qr_booking_count()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.qr_code_id is not null then
      update public.qr_codes set booking_count = booking_count + 1, updated_at = now()
       where id = new.qr_code_id;
      update public.qr_code_scans set converted = true, booking_id = new.id
       where qr_code_id = new.qr_code_id and converted = false
         and id = (select id from public.qr_code_scans
                    where qr_code_id = new.qr_code_id and converted = false
                    order by scanned_at desc limit 1);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_bookings_qr_count on public.customer_bookings;
create trigger trg_bookings_qr_count after insert on public.customer_bookings
  for each row execute function app.tg_qr_booking_count();

-- Customer rollup counters.
create or replace function app.tg_customer_rollup()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
begin
  if tg_op = 'INSERT' and new.customer_id is not null then
    update public.customers
       set booking_count = booking_count + 1,
           last_booking_at = greatest(coalesce(last_booking_at, new.created_at), new.created_at),
           updated_at = now()
     where id = new.customer_id;
  elsif tg_op = 'UPDATE' and new.status = 'no_show' and old.status <> 'no_show'
        and new.customer_id is not null then
    update public.customers set no_show_count = no_show_count + 1, updated_at = now()
     where id = new.customer_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_bookings_customer_rollup on public.customer_bookings;
create trigger trg_bookings_customer_rollup after insert or update on public.customer_bookings
  for each row execute function app.tg_customer_rollup();

-- Release the seat when a booking is cancelled, so capacity is returned.
create or replace function app.tg_booking_release_slot()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
begin
  if new.status in ('cancelled','no_show') and old.status not in ('cancelled','no_show')
     and new.slot_id is not null then
    update public.job_slots
       set booked_count = greatest(booked_count - 1, 0),
           status = case when status = 'booked' then 'open'::app.slot_status else status end,
           updated_at = now()
     where id = new.slot_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_bookings_release_slot on public.customer_bookings;
create trigger trg_bookings_release_slot after update on public.customer_bookings
  for each row execute function app.tg_booking_release_slot();

drop trigger if exists trg_bookings_audit on public.customer_bookings;
create trigger trg_bookings_audit before insert or update on public.customer_bookings
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_bookings_lock on public.customer_bookings;
create trigger trg_bookings_lock before update on public.customer_bookings
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_bookings_auditlog on public.customer_bookings;
create trigger trg_bookings_auditlog after insert or update or delete on public.customer_bookings
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 15 - RATE CARDS
-- Source: 015_rate_cards.sql
-- =============================================================================

begin;

create table if not exists public.rate_cards (
  id                 uuid primary key default extensions.gen_random_uuid(),
  company_id         uuid        not null references public.companies(id) on delete restrict,
  technician_id      uuid,       -- NULL = company/partner default card
  partner_id         uuid,
  name               text        not null,
  code               text,
  scope              text        not null default 'technician'
                       check (scope in ('technician','partner','company')),
  effective_from     date        not null,
  effective_to       date,       -- NULL = open-ended
  currency           char(3)     not null default 'AUD',
  tax_rate           numeric(5,4) not null default 0.1000 check (tax_rate >= 0 and tax_rate < 1),
  tax_inclusive      boolean     not null default false,
  is_active          boolean     not null default true,
  source             text        not null default 'manual'
                       check (source in ('manual','csv','xlsx','api','template')),
  source_filename    text,
  source_checksum    text,
  imported_at        timestamptz,
  imported_by        uuid references public.users(id) on delete set null,
  import_summary     jsonb       not null default '{}'::jsonb,
  notes              text,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id) on delete set null,
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id) on delete set null,

  constraint rate_cards_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete cascade,
  constraint rate_cards_partner_fk foreign key (partner_id, company_id)
    references public.partners (id, company_id) on delete cascade,
  constraint rate_cards_id_company_uk unique (id, company_id),
  constraint rate_cards_window check (effective_to is null or effective_to >= effective_from),
  constraint rate_cards_owner check (
    (scope = 'technician' and technician_id is not null)
    or (scope = 'partner' and partner_id is not null)
    or (scope = 'company' and technician_id is null and partner_id is null))
);

comment on table  public.rate_cards is 'Version-dated rate cards. Invoices always reprice against the card effective on the job date.';
comment on column public.rate_cards.effective_to is 'NULL = open-ended. Close a card by setting this, never by editing its items.';
comment on column public.rate_cards.source_checksum is 'Hash of the uploaded CSV/XLSX, for duplicate-import detection.';
comment on column public.rate_cards.tax_inclusive is 'Whether item rates already include tax.';

-- No two live cards may cover the same technician for overlapping periods.
alter table public.rate_cards drop constraint if exists rate_cards_no_tech_overlap;
alter table public.rate_cards add constraint rate_cards_no_tech_overlap
  exclude using gist (
    technician_id with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  )
  where (deleted_at is null and is_active and technician_id is not null);

create index if not exists rate_cards_company_idx  on public.rate_cards (company_id) where deleted_at is null;
create index if not exists rate_cards_tech_idx     on public.rate_cards (technician_id, effective_from desc) where deleted_at is null;
create index if not exists rate_cards_partner_idx  on public.rate_cards (partner_id) where deleted_at is null;
create index if not exists rate_cards_active_idx   on public.rate_cards (company_id, effective_from, effective_to)
  where is_active and deleted_at is null;
create index if not exists rate_cards_checksum_idx on public.rate_cards (company_id, source_checksum)
  where source_checksum is not null and deleted_at is null;

-- Resolve the card that applies to a technician on a given date.
create or replace function app.resolve_rate_card(p_technician_id uuid, p_on date)
returns uuid language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select rc.id
  from public.rate_cards rc
  where rc.deleted_at is null and rc.is_active
    and rc.effective_from <= p_on
    and (rc.effective_to is null or rc.effective_to >= p_on)
    and (
      rc.technician_id = p_technician_id
      or rc.scope = 'company'
    )
  order by case rc.scope when 'technician' then 1 when 'partner' then 2 else 3 end,
           rc.effective_from desc
  limit 1
$$;

-- Back-fill the partner default-card pointer.
alter table public.partners drop constraint if exists partners_default_rate_card_fk;
alter table public.partners add constraint partners_default_rate_card_fk
  foreign key (default_rate_card_id) references public.rate_cards(id) on delete set null;

drop trigger if exists trg_rate_cards_audit on public.rate_cards;
create trigger trg_rate_cards_audit before insert or update on public.rate_cards
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_rate_cards_lock on public.rate_cards;
create trigger trg_rate_cards_lock before update on public.rate_cards
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_rate_cards_auditlog on public.rate_cards;
create trigger trg_rate_cards_auditlog after insert or update or delete on public.rate_cards
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 16 - RATE CARD ITEMS
-- Source: 016_rate_card_items.sql
-- =============================================================================

begin;

create table if not exists public.rate_card_items (
  id              uuid primary key default extensions.gen_random_uuid(),
  company_id      uuid        not null references public.companies(id) on delete restrict,
  rate_card_id    uuid        not null,
  code            text        not null check (length(btrim(code)) between 1 and 64),
  description     text        not null default '',
  category        text,
  unit            app.rate_unit not null default 'each',
  rate            numeric(12,4) not null default 0 check (rate >= 0),
  min_quantity    numeric(12,4) not null default 0 check (min_quantity >= 0),
  max_quantity    numeric(12,4) check (max_quantity is null or max_quantity >= min_quantity),
  technician_pay  numeric(12,4) check (technician_pay is null or technician_pay >= 0),
  is_taxable      boolean     not null default true,
  is_active       boolean     not null default true,
  sort_order      int         not null default 0,
  external_code   text,
  source_row      int,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.users(id) on delete set null,
  deleted_at      timestamptz,
  deleted_by      uuid references public.users(id) on delete set null,

  constraint rate_card_items_card_fk foreign key (rate_card_id, company_id)
    references public.rate_cards (id, company_id) on delete cascade,
  constraint rate_card_items_id_company_uk unique (id, company_id),
  constraint rate_card_items_qty check (max_quantity is null or max_quantity >= min_quantity)
);

comment on table  public.rate_card_items is 'Priced line on a rate card. Imported from CSV/XLSX or entered manually.';
comment on column public.rate_card_items.unit is 'Billing unit: each, hour, day, metre, fixed, percent, etc.';
comment on column public.rate_card_items.technician_pay is 'What the technician earns for this line; drives technician invoices.';
comment on column public.rate_card_items.source_row is 'Row number in the uploaded file, for import error reporting.';

create unique index if not exists rate_card_items_code_uidx
  on public.rate_card_items (rate_card_id, lower(code)) where deleted_at is null;
create index if not exists rate_card_items_card_idx      on public.rate_card_items (rate_card_id) where deleted_at is null;
create index if not exists rate_card_items_company_idx   on public.rate_card_items (company_id) where deleted_at is null;
create index if not exists rate_card_items_category_idx  on public.rate_card_items (rate_card_id, category) where deleted_at is null;
create index if not exists rate_card_items_external_idx  on public.rate_card_items (company_id, external_code)
  where external_code is not null and deleted_at is null;
create index if not exists rate_card_items_desc_trgm_idx on public.rate_card_items using gin (description extensions.gin_trgm_ops);

drop trigger if exists trg_rate_card_items_audit on public.rate_card_items;
create trigger trg_rate_card_items_audit before insert or update on public.rate_card_items
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_rate_card_items_lock on public.rate_card_items;
create trigger trg_rate_card_items_lock before update on public.rate_card_items
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_rate_card_items_auditlog on public.rate_card_items;
create trigger trg_rate_card_items_auditlog after insert or update or delete on public.rate_card_items
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 17 - INVOICES
-- Source: 017_invoices.sql
-- =============================================================================

begin;

create sequence if not exists public.invoice_number_seq;

create table if not exists public.invoices (
  id                  uuid primary key default extensions.gen_random_uuid(),
  company_id          uuid        not null references public.companies(id) on delete restrict,
  invoice_number      text        not null check (length(btrim(invoice_number)) between 1 and 40),
  direction           app.invoice_direction not null default 'payable',
  status              app.invoice_status    not null default 'draft',

  technician_id       uuid,
  partner_id          uuid,
  customer_id         uuid,
  job_id              uuid,
  rate_card_id        uuid,
  subscription_id     uuid,       -- FK added in 020_subscriptions

  period_start        date,
  period_end          date,
  issue_date          date        not null default current_date,
  due_date            date,
  paid_date           date,

  currency            char(3)     not null default 'AUD',
  subtotal            numeric(14,2) not null default 0,
  discount_total      numeric(14,2) not null default 0,
  tax_total           numeric(14,2) not null default 0,
  total               numeric(14,2) not null default 0,
  amount_paid         numeric(14,2) not null default 0,
  amount_due          numeric(14,2) not null default 0,
  tax_rate            numeric(5,4) not null default 0.1000 check (tax_rate >= 0 and tax_rate < 1),
  tax_inclusive       boolean     not null default false,

  supply_date         date,
  place_of_supply     char(2)     not null default 'AU',
  supplier_abn        text,
  supplier_name       text,
  buyer_abn           text,
  buyer_name          text,
  purchase_order      text,
  notes               text,
  terms               text,
  pdf_path            text,
  pdf_url             text,
  pdf_generated_at    timestamptz,

  submitted_at        timestamptz,
  approved_at         timestamptz,
  approved_by         uuid references public.users(id) on delete set null,
  sent_at             timestamptz,
  voided_at           timestamptz,
  void_reason         text,
  dispute_reason      text,

  xero_invoice_id     text,
  myob_invoice_id     text,
  quickbooks_id       text,
  external_reference  text,

  line_count          int         not null default 0 check (line_count >= 0),
  metadata            jsonb       not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references public.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.users(id) on delete set null,
  deleted_at          timestamptz,
  deleted_by          uuid references public.users(id) on delete set null,

  constraint invoices_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint invoices_partner_fk foreign key (partner_id, company_id)
    references public.partners (id, company_id) on delete set null,
  constraint invoices_customer_fk foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete set null,
  constraint invoices_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete set null,
  constraint invoices_rate_card_fk foreign key (rate_card_id, company_id)
    references public.rate_cards (id, company_id) on delete set null,
  constraint invoices_id_company_uk unique (id, company_id),
  constraint invoices_period check (period_end is null or period_start is null or period_end >= period_start),
  constraint invoices_amounts_nonneg check (
    subtotal >= 0 and discount_total >= 0 and tax_total >= 0 and total >= 0
    and amount_paid >= 0)
);

comment on table  public.invoices is 'Invoices both directions. Totals are maintained by trigger from invoice_items.';
comment on column public.invoices.direction is 'payable = money out to technician; receivable = money in from partner/customer.';
comment on column public.invoices.amount_due is 'Generated column: total - amount_paid.';
comment on column public.invoices.xero_invoice_id is 'External accounting system id, for reconciliation.';

-- amount_due as a generated column so it can never drift.
alter table public.invoices drop column if exists amount_due cascade;
alter table public.invoices add column amount_due numeric(14,2)
  generated always as (total - amount_paid) stored;

create unique index if not exists invoices_company_number_uidx
  on public.invoices (company_id, upper(invoice_number)) where deleted_at is null;
create index if not exists invoices_company_idx    on public.invoices (company_id, issue_date desc) where deleted_at is null;
create index if not exists invoices_tech_period_idx on public.invoices (technician_id, period_start, period_end)
  where direction = 'payable' and deleted_at is null;
create index if not exists invoices_partner_idx    on public.invoices (partner_id, issue_date desc) where deleted_at is null;
create index if not exists invoices_status_idx     on public.invoices (company_id, status) where deleted_at is null;
create index if not exists invoices_due_idx        on public.invoices (company_id, due_date)
  where status in ('sent','part_paid') and deleted_at is null;
create index if not exists invoices_external_idx   on public.invoices (company_id, external_reference)
  where external_reference is not null and deleted_at is null;

drop trigger if exists trg_invoices_audit on public.invoices;
create trigger trg_invoices_audit before insert or update on public.invoices
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_invoices_lock on public.invoices;
create trigger trg_invoices_lock before update on public.invoices
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_invoices_auditlog on public.invoices;
create trigger trg_invoices_auditlog after insert or update or delete on public.invoices
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 18 - INVOICE ITEMS
-- Source: 018_invoice_items.sql
-- =============================================================================

begin;

create table if not exists public.invoice_items (
  id                   uuid primary key default extensions.gen_random_uuid(),
  company_id           uuid        not null references public.companies(id) on delete restrict,
  invoice_id           uuid        not null,
  customer_booking_id  uuid,
  job_id               uuid,
  technician_id        uuid,
  rate_card_item_id    uuid,

  line_number          int         not null default 1,
  code                 text,
  description          text        not null default '',
  category             text,
  unit                 app.rate_unit not null default 'each',
  quantity             numeric(12,4) not null default 1 check (quantity >= 0),
  unit_rate            numeric(12,4) not null default 0 check (unit_rate >= 0),
  discount_rate        numeric(5,4)  not null default 0 check (discount_rate >= 0 and discount_rate < 1),
  discount_amount      numeric(14,2) not null default 0 check (discount_amount >= 0),
  tax_rate             numeric(5,4)  not null default 0.1000 check (tax_rate >= 0 and tax_rate < 1),
  is_taxable           boolean     not null default true,
  technician_pay       numeric(12,4) check (technician_pay is null or technician_pay >= 0),
  service_date         date,
  install_completed_at timestamptz,
  source               text        not null default 'booking'
                         check (source in ('booking','rate_card','manual','rollup','adjustment','import')),
  notes                text,
  metadata             jsonb       not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  created_by           uuid references public.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.users(id) on delete set null,
  deleted_at           timestamptz,
  deleted_by           uuid references public.users(id) on delete set null,

  constraint invoice_items_invoice_fk foreign key (invoice_id, company_id)
    references public.invoices (id, company_id) on delete cascade,
  constraint invoice_items_booking_fk foreign key (customer_booking_id, company_id)
    references public.customer_bookings (id, company_id) on delete set null,
  constraint invoice_items_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete set null,
  constraint invoice_items_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint invoice_items_rate_item_fk foreign key (rate_card_item_id, company_id)
    references public.rate_card_items (id, company_id) on delete set null,
  constraint invoice_items_id_company_uk unique (id, company_id)
);

comment on table  public.invoice_items is 'Priced invoice lines. Snapshots rate/code/description so history never shifts.';
comment on column public.invoice_items.unit_rate is 'Rate snapshot at time of invoicing — the rate card may change later.';
comment on column public.invoice_items.technician_pay is 'Technician earnings snapshot for this line.';
comment on column public.invoice_items.source is 'Where the line came from: completed booking, rate card, manual adjustment.';

-- Money columns as generated values so arithmetic can never drift.
alter table public.invoice_items drop column if exists line_subtotal cascade;
alter table public.invoice_items add column line_subtotal numeric(14,2)
  generated always as (round(quantity * unit_rate, 2)) stored;
alter table public.invoice_items drop column if exists line_tax cascade;
alter table public.invoice_items add column line_tax numeric(14,2)
  generated always as (case when is_taxable
                            then round(quantity * unit_rate * (1 - discount_rate) * tax_rate, 2)
                            else 0::numeric end) stored;
alter table public.invoice_items drop column if exists line_total cascade;
alter table public.invoice_items add column line_total numeric(14,2)
  generated always as (round(quantity * unit_rate * (1 - discount_rate), 2)
                       + case when is_taxable
                              then round(quantity * unit_rate * (1 - discount_rate) * tax_rate, 2)
                              else 0::numeric end) stored;

create unique index if not exists invoice_items_line_uidx on public.invoice_items (invoice_id, line_number) where deleted_at is null;
create index if not exists invoice_items_invoice_idx   on public.invoice_items (invoice_id) where deleted_at is null;
create index if not exists invoice_items_company_idx   on public.invoice_items (company_id) where deleted_at is null;
create index if not exists invoice_items_booking_idx   on public.invoice_items (customer_booking_id) where customer_booking_id is not null;
create index if not exists invoice_items_tech_idx      on public.invoice_items (technician_id, service_date) where technician_id is not null;
create index if not exists invoice_items_job_idx       on public.invoice_items (job_id) where job_id is not null;
create unique index if not exists invoice_items_booking_once_uidx
  on public.invoice_items (invoice_id, customer_booking_id, rate_card_item_id)
  where customer_booking_id is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Invoice totals roll up from items, never from the app.
-- ---------------------------------------------------------------------------
create or replace function app.tg_invoice_rollup()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update public.invoices i
     set subtotal       = coalesce(agg.subtotal, 0),
         discount_total = coalesce(agg.discount_total, 0),
         tax_total      = coalesce(agg.tax_total, 0),
         total          = coalesce(agg.total, 0),
         line_count     = coalesce(agg.line_count, 0),
         updated_at     = now()
  from (
    select
      sum(round(quantity * unit_rate, 2))                                  as subtotal,
      sum(round(quantity * unit_rate * discount_rate, 2))                  as discount_total,
      sum(case when is_taxable
               then round(quantity * unit_rate * (1 - discount_rate) * tax_rate, 2)
               else 0::numeric end)                                        as tax_total,
      sum(round(quantity * unit_rate * (1 - discount_rate), 2)
          + case when is_taxable
                 then round(quantity * unit_rate * (1 - discount_rate) * tax_rate, 2)
                 else 0::numeric end)                                      as total,
      count(*)                                                             as line_count
    from public.invoice_items
    where invoice_id = v_invoice and deleted_at is null
  ) agg
  where i.id = v_invoice;
  return null;
end $$;

drop trigger if exists trg_invoice_items_rollup on public.invoice_items;
create trigger trg_invoice_items_rollup
  after insert or update or delete on public.invoice_items
  for each row execute function app.tg_invoice_rollup();

drop trigger if exists trg_invoice_items_audit on public.invoice_items;
create trigger trg_invoice_items_audit before insert or update on public.invoice_items
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_invoice_items_lock on public.invoice_items;
create trigger trg_invoice_items_lock before update on public.invoice_items
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_invoice_items_auditlog on public.invoice_items;
create trigger trg_invoice_items_auditlog after insert or update or delete on public.invoice_items
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 19 - NOTIFICATIONS
-- Source: 019_notifications.sql
-- =============================================================================

begin;

create table if not exists public.notifications (
  id                uuid primary key default extensions.gen_random_uuid(),
  company_id        uuid        not null references public.companies(id) on delete restrict,
  channel           app.notification_channel not null default 'email',
  status            app.notification_status  not null default 'queued',
  template_key      text,
  event_key         text,        -- e.g. 'booking.confirmed', 'slot.assigned'
  subject           text,
  body              text,
  body_html         text,
  variables         jsonb       not null default '{}'::jsonb,

  recipient_user_id uuid references public.users(id) on delete set null,
  recipient_customer_id uuid,
  recipient_technician_id uuid,
  recipient_partner_id uuid,
  recipient_email   text,
  recipient_phone   text,
  recipient_name    text,

  customer_booking_id uuid,
  job_id            uuid,
  technician_id     uuid,
  invoice_id        uuid,

  priority          int         not null default 3 check (priority between 1 and 5),
  scheduled_for     timestamptz not null default now(),
  expires_at        timestamptz,
  attempt_count     int         not null default 0 check (attempt_count >= 0),
  max_attempts      int         not null default 3 check (max_attempts > 0),
  last_attempt_at   timestamptz,
  next_attempt_at   timestamptz,
  sent_at           timestamptz,
  delivered_at      timestamptz,
  read_at           timestamptz,
  failed_at         timestamptz,
  error_code        text,
  error_message     text,
  provider          text,       -- 'microsoft_graph', 'twilio', 'webpush', ...
  provider_message_id text,
  dedupe_key        text,       -- idempotency guard for event-driven sends
  metadata          jsonb       not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  created_by        uuid references public.users(id) on delete set null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.users(id) on delete set null,

  constraint notifications_customer_fk foreign key (recipient_customer_id, company_id)
    references public.customers (id, company_id) on delete set null,
  constraint notifications_tech_fk foreign key (recipient_technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint notifications_partner_fk foreign key (recipient_partner_id, company_id)
    references public.partners (id, company_id) on delete set null,
  constraint notifications_booking_fk foreign key (customer_booking_id, company_id)
    references public.customer_bookings (id, company_id) on delete set null,
  constraint notifications_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete set null,
  constraint notifications_technician_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint notifications_invoice_fk foreign key (invoice_id, company_id)
    references public.invoices (id, company_id) on delete set null,
  constraint notifications_dedupe_uk unique (company_id, dedupe_key)
);

comment on table  public.notifications is 'Outbound notification queue and delivery record.';
comment on column public.notifications.dedupe_key is 'Deterministic idempotency key so a retried event never double-sends.';
comment on column public.notifications.next_attempt_at is 'Backoff cursor for a scheduled retry worker.';
comment on column public.notifications.expires_at is 'Do not send after this time (e.g. a reminder for a past slot).';

create index if not exists notifications_queue_idx     on public.notifications (company_id, status, priority, scheduled_for)
  where status in ('queued','sending');
create index if not exists notifications_retry_idx     on public.notifications (next_attempt_at)
  where status = 'failed' and attempt_count < max_attempts;
create index if not exists notifications_recipient_idx on public.notifications (recipient_email, created_at desc);
create index if not exists notifications_user_idx      on public.notifications (recipient_user_id, created_at desc)
  where recipient_user_id is not null;
create index if not exists notifications_booking_idx   on public.notifications (customer_booking_id) where customer_booking_id is not null;
create index if not exists notifications_event_idx     on public.notifications (company_id, event_key, created_at desc);
create index if not exists notifications_inapp_idx     on public.notifications (recipient_user_id, read_at)
  where channel = 'in_app' and read_at is null;

drop trigger if exists trg_notifications_audit on public.notifications;
create trigger trg_notifications_audit before insert or update on public.notifications
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_notifications_lock on public.notifications;
create trigger trg_notifications_lock before update on public.notifications
  for each row execute function app.tg_lock_company_id();



-- =============================================================================
-- SECTION 20 - EMAIL ACCOUNTS (Microsoft Graph)
-- Source: 020_email_accounts.sql
-- =============================================================================

begin;

create table if not exists public.email_accounts (
  id                  uuid primary key default extensions.gen_random_uuid(),
  company_id          uuid        not null references public.companies(id) on delete restrict,
  label               text        not null default 'default',
  provider            text        not null default 'microsoft_graph'
                        check (provider in ('microsoft_graph','smtp','resend','sendgrid','ses')),
  from_name           text        not null,
  from_email          text        not null check (from_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  reply_to_email      text        check (reply_to_email is null or reply_to_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),

  -- Microsoft Graph / Entra ID configuration
  ms_tenant_id        text,
  ms_client_id        text,
  ms_token_secret_ref text,       -- Supabase Vault secret id holding the client secret
  ms_mailbox_upn      text,       -- sender mailbox userPrincipalName
  ms_mailbox_user_id  text,       -- Entra object id
  ms_scope            text        not null default 'https://graph.microsoft.com/.default',
  ms_auth_mode        text        not null default 'client_credentials'
                        check (ms_auth_mode in ('client_credentials','delegated','shared_mailbox')),
  ms_save_to_sent     boolean     not null default true,

  -- Generic SMTP fallback
  smtp_host           text,
  smtp_port           int         check (smtp_port is null or (smtp_port > 0 and smtp_port <= 65535)),
  smtp_secure         boolean     not null default true,
  smtp_username       text,
  smtp_password_ref   text,       -- Supabase Vault secret id
  api_key_ref         text,       -- Resend/SendGrid/SES key via Vault

  daily_send_limit    int         not null default 2000 check (daily_send_limit > 0),
  daily_sent_count    int         not null default 0 check (daily_sent_count >= 0),
  quota_reset_at      timestamptz,
  is_default          boolean     not null default false,
  is_verified         boolean     not null default false,
  verified_at         timestamptz,
  last_send_at        timestamptz,
  last_error          text,
  connection_meta     jsonb       not null default '{}'::jsonb,
  settings            jsonb       not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references public.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.users(id) on delete set null,
  deleted_at          timestamptz,
  deleted_by          uuid references public.users(id) on delete set null,
  constraint email_accounts_id_company_uk unique (id, company_id)
);

comment on table  public.email_accounts is 'Sending mailbox configuration. Supports Microsoft Graph and SMTP/API providers.';
comment on column public.email_accounts.ms_token_secret_ref is 'Vault secret reference — the client secret itself is never stored here.';
comment on column public.email_accounts.ms_auth_mode is 'client_credentials app-only send, delegated user context, or shared mailbox.';
comment on column public.email_accounts.daily_sent_count is 'Rolling counter reset by quota_reset_at; guards Graph throttling.';

create unique index if not exists email_accounts_default_uidx
  on public.email_accounts (company_id) where is_default and deleted_at is null;
create unique index if not exists email_accounts_label_uidx
  on public.email_accounts (company_id, lower(label)) where deleted_at is null;
create index if not exists email_accounts_company_idx on public.email_accounts (company_id) where deleted_at is null;
create index if not exists email_accounts_from_idx    on public.email_accounts (company_id, lower(from_email)) where deleted_at is null;
create index if not exists email_accounts_ms_idx      on public.email_accounts (ms_tenant_id, ms_client_id)
  where ms_tenant_id is not null and deleted_at is null;

drop trigger if exists trg_email_accounts_audit on public.email_accounts;
create trigger trg_email_accounts_audit before insert or update on public.email_accounts
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_email_accounts_lock on public.email_accounts;
create trigger trg_email_accounts_lock before update on public.email_accounts
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_email_accounts_auditlog on public.email_accounts;
create trigger trg_email_accounts_auditlog after insert or update or delete on public.email_accounts
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 21 - EMAIL LOGS
-- Source: 021_email_logs.sql
-- =============================================================================

// Migration 021 — email_logs
// Per-message Microsoft Graph delivery record. No soft delete.

begin;

create table if not exists public.email_logs (
  id                  uuid primary key default extensions.gen_random_uuid(),
  company_id          uuid        not null references public.companies(id) on delete restrict,
  notification_id     uuid,
  email_account_id    uuid,
  status              app.email_status not null default 'queued',

  direction           text        not null default 'outbound'
                        check (direction in ('outbound','inbound')),
  from_email          text        not null,
  from_name           text,
  to_emails           text[]      not null default '{}',
  cc_emails           text[]      not null default '{}',
  bcc_emails          text[]      not null default '{}',
  reply_to            text,
  subject             text,
  body_preview        text,
  template_key        text,
  event_key           text,
  has_attachments     boolean     not null default false,
  attachment_count    int         not null default 0 check (attachment_count >= 0),

  recipient_user_id   uuid references public.users(id) on delete set null,
  customer_booking_id uuid,
  job_id              uuid,
  invoice_id          uuid,

  provider            text        not null default 'microsoft_graph',
  graph_message_id    text,
  internet_message_id text,
  conversation_id     text,
  conversation_index  text,
  graph_request_id    text,
  graph_status_code   int,
  graph_error_code    text,
  graph_error_message text,
  smtp_response       text,

  queued_at           timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  opened_at           timestamptz,
  bounced_at          timestamptz,
  failed_at           timestamptz,
  retry_count         int         not null default 0 check (retry_count >= 0),
  latency_ms          int,

  created_at          timestamptz not null default now(),
  created_by          uuid references public.users(id) on delete set null,

  constraint email_logs_account_fk foreign key (email_account_id, company_id)
    references public.email_accounts (id, company_id) on delete set null,
  constraint email_logs_booking_fk foreign key (customer_booking_id, company_id)
    references public.customer_bookings (id, company_id) on delete set null,
  constraint email_logs_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete set null,
  constraint email_logs_invoice_fk foreign key (invoice_id, company_id)
    references public.invoices (id, company_id) on delete set null,
  constraint email_logs_id_company_uk unique (id, company_id)
);

comment on table  public.email_logs is 'Delivery record for every email sent via Graph or another provider.';
comment on column public.email_logs.graph_message_id is 'Graph message id returned by sendMail, used to query delivery status.';
comment on column public.email_logs.internet_message_id is 'RFC 5322 Message-ID, for correlation with the recipient mailbox.';
comment on column public.email_logs.graph_error_code is 'Graph error code on failure, e.g. ErrorAccessDenied, MailboxNotEnabledForRESTAPI.';

create index if not exists email_logs_company_time_idx on public.email_logs (company_id, created_at desc);
create index if not exists email_logs_graph_msg_idx    on public.email_logs (graph_message_id) where graph_message_id is not null;
create index if not exists email_logs_internet_id_idx  on public.email_logs (internet_message_id) where internet_message_id is not null;
create index if not exists email_logs_conversation_idx on public.email_logs (conversation_id) where conversation_id is not null;
create index if not exists email_logs_status_idx       on public.email_logs (company_id, status, created_at desc);
create index if not exists email_logs_failed_idx       on public.email_logs (company_id)
  where status in ('failed','bounced') and retry_count < 3;
create index if not exists email_logs_booking_idx      on public.email_logs (customer_booking_id) where customer_booking_id is not null;
create index if not exists email_logs_recipients_idx   on public.email_logs using gin (to_emails);

-- Back-fill the notification <-> email_log relationship.
alter table public.email_logs drop constraint if exists email_logs_notification_fk;
alter table public.email_logs add constraint email_logs_notification_fk
  foreign key (notification_id) references public.notifications(id) on delete set null;

-- Keep the email account's rolling daily counter honest.
create or replace function app.tg_email_account_count()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
begin
  if new.email_account_id is not null and new.status in ('sent','delivered') then
    update public.email_accounts
       set daily_sent_count = daily_sent_count + 1,
           last_send_at = coalesce(new.sent_at, now()),
           updated_at = now()
     where id = new.email_account_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_email_logs_account_count on public.email_logs;
create trigger trg_email_logs_account_count after insert or update on public.email_logs
  for each row when (new.status in ('sent','delivered'))
  execute function app.tg_email_account_count();



-- =============================================================================
-- SECTION 22 - SUBSCRIPTION PLANS
-- Source: 022_subscription_plans.sql
-- =============================================================================

// Migration 022 — subscription_plans
// Catalogue of SwiftWorks plans. Global (not tenant-scoped), Stripe-backed.

begin;

create table if not exists public.subscription_plans (
  id                     uuid primary key default extensions.gen_random_uuid(),
  code                   text        not null check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name                   text        not null,
  description            text,
  tier                   int         not null default 1 check (tier >= 0),

  stripe_product_id      text,
  stripe_price_id        text,
  price                  numeric(12,2) not null default 0 check (price >= 0),
  currency               char(3)     not null default 'AUD',
  billing_interval       app.billing_interval not null default 'month',
  interval_count         int         not null default 1 check (interval_count > 0),
  trial_days             int         not null default 14 check (trial_days >= 0),

  -- Entitlements / limits (enforced in app code; -1 = unlimited)
  included_users         int         not null default 5,
  included_technicians   int         not null default 5,
  included_jobs_per_month int        not null default -1,
  included_bookings_per_month int    not null default -1,
  included_sms           int         not null default 0,
  included_emails        int         not null default 500,
  max_storage_mb         int         not null default 1024,
  features               jsonb       not null default '[]'::jsonb,
  limits                 jsonb       not null default '{}'::jsonb,

  is_public              boolean     not null default true,
  is_active              boolean     not null default true,
  sort_order             int         not null default 0,
  metadata               jsonb       not null default '{}'::jsonb,

  created_at             timestamptz not null default now(),
  created_by             uuid,
  updated_at             timestamptz not null default now(),
  updated_by             uuid,
  deleted_at             timestamptz,
  deleted_by             uuid
);

comment on table  public.subscription_plans is 'Global plan catalogue. Not tenant-scoped — visible to all companies.';
comment on column public.subscription_plans.code is 'Stable plan identifier, e.g. starter / pro / enterprise.';
comment on column public.subscription_plans.features is 'JSONB array of feature flags unlocked by this plan.';
comment on column public.subscription_plans.limits is 'Overflow limits beyond the typed columns; -1 means unlimited.';

create unique index if not exists subscription_plans_code_uidx   on public.subscription_plans (lower(code)) where deleted_at is null;
create unique index if not exists subscription_plans_stripe_price_uidx
  on public.subscription_plans (stripe_price_id) where stripe_price_id is not null and deleted_at is null;
create index if not exists subscription_plans_active_idx on public.subscription_plans (is_public, is_active, sort_order) where deleted_at is null;
create index if not exists subscription_plans_stripe_idx on public.subscription_plans (stripe_product_id) where stripe_product_id is not null;

drop trigger if exists trg_subscription_plans_audit on public.subscription_plans;
create trigger trg_subscription_plans_audit before insert or update on public.subscription_plans
  for each row execute function app.tg_touch_audit();



-- =============================================================================
-- SECTION 23 - SUBSCRIPTIONS (Stripe)
-- Source: 023_subscriptions.sql
-- =============================================================================

begin;

create table if not exists public.subscriptions (
  id                      uuid primary key default extensions.gen_random_uuid(),
  company_id              uuid        not null references public.companies(id) on delete restrict,
  plan_id                 uuid        not null references public.subscription_plans(id) on delete restrict,
  status                  app.subscription_status not null default 'trialing',

  stripe_customer_id      text,
  stripe_subscription_id  text,
  stripe_price_id         text,
  stripe_product_id       text,
  stripe_latest_invoice_id text,
  stripe_default_payment_method_id text,

  quantity                int         not null default 1 check (quantity > 0),
  currency                char(3)     not null default 'AUD',
  unit_amount             numeric(12,2),
  billing_interval        app.billing_interval not null default 'month',
  interval_count          int         not null default 1 check (interval_count > 0),

  trial_start             timestamptz,
  trial_end               timestamptz,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean     not null default false,
  cancel_at               timestamptz,
  canceled_at             timestamptz,
  ended_at                timestamptz,
  paused_at               timestamptz,
  resumed_at              timestamptz,
  grace_period_ends_at    timestamptz,

  seats_used              int         not null default 0 check (seats_used >= 0),
  sms_used_this_period    int         not null default 0 check (sms_used_this_period >= 0),
  emails_used_this_period int         not null default 0 check (emails_used_this_period >= 0),
  bookings_used_this_period int       not null default 0 check (bookings_used_this_period >= 0),
  storage_used_mb         numeric(12,2) not null default 0 check (storage_used_mb >= 0),
  overage_amount          numeric(12,2) not null default 0 check (overage_amount >= 0),

  billing_email           text,
  billing_name            text,
  billing_address         jsonb       not null default '{}'::jsonb,
  tax_id                  text,
  tax_exempt              text        not null default 'none'
                            check (tax_exempt in ('none','exempt','reverse')),
  discount_code           text,
  coupon_id               text,

  last_webhook_at         timestamptz,
  last_webhook_event      text,
  cancelled_reason        text,
  cancellation_feedback   text,
  metadata                jsonb       not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references public.users(id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references public.users(id) on delete set null,
  deleted_at              timestamptz,
  deleted_by              uuid references public.users(id) on delete set null,

  constraint subscriptions_id_company_uk unique (id, company_id),
  constraint subscriptions_period_order check (
    current_period_end is null or current_period_start is null
    or current_period_end >= current_period_start),
  constraint subscriptions_trial_order check (
    trial_end is null or trial_start is null or trial_end >= trial_start)
);

comment on table  public.subscriptions is 'Stripe subscription state per company. Written by webhook handler, never edited by users.';
comment on column public.subscriptions.grace_period_ends_at is 'Access continues until here after past_due before the tenant is locked out.';
comment on column public.subscriptions.stripe_subscription_id is 'Stripe sub_... id; the join key for all webhook reconciliation.';
comment on column public.subscriptions.seats_used is 'Active user count for per-seat billing.';

-- Only one live subscription per company; historical rows stay for audit.
create unique index if not exists subscriptions_company_live_uidx
  on public.subscriptions (company_id)
  where deleted_at is null
    and status in ('trialing','active','past_due','unpaid','paused','incomplete');
create unique index if not exists subscriptions_stripe_sub_uidx
  on public.subscriptions (stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists subscriptions_company_idx  on public.subscriptions (company_id, created_at desc) where deleted_at is null;
create index if not exists subscriptions_status_idx   on public.subscriptions (status) where deleted_at is null;
create index if not exists subscriptions_customer_idx on public.subscriptions (stripe_customer_id) where stripe_customer_id is not null;
create index if not exists subscriptions_renewal_idx  on public.subscriptions (current_period_end)
  where status in ('active','trialing') and deleted_at is null;
create index if not exists subscriptions_downgrade_idx on public.subscriptions (cancel_at_period_end, current_period_end)
  where cancel_at_period_end and deleted_at is null;

-- Back-fill the invoices.subscription_id link.
alter table public.invoices drop constraint if exists invoices_subscription_fk;
alter table public.invoices add constraint invoices_subscription_fk
  foreign key (subscription_id) references public.subscriptions(id) on delete set null;

drop trigger if exists trg_subscriptions_audit on public.subscriptions;
create trigger trg_subscriptions_audit before insert or update on public.subscriptions
  for each row execute function app.tg_touch_audit();

drop trigger if exists trg_subscriptions_lock on public.subscriptions;
create trigger trg_subscriptions_lock before update on public.subscriptions
  for each row execute function app.tg_lock_company_id();

drop trigger if exists trg_subscriptions_auditlog on public.subscriptions;
create trigger trg_subscriptions_auditlog after insert or update or delete on public.subscriptions
  for each row execute function app.tg_write_audit_log();



-- =============================================================================
-- SECTION 24 - AUTH ARCHITECTURE (invitations, signup, tenant bootstrap)
-- Source: 024_auth.sql
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. user_invitations — the only legitimate path to tenant membership.
--    Created first: handle_new_user() below declares
--    public.user_invitations%rowtype, and PL/pgSQL resolves %rowtype against
--    the catalog at function-creation time, not at call time.
-- ---------------------------------------------------------------------------
create table if not exists public.user_invitations (
  id            uuid primary key default extensions.gen_random_uuid(),
  company_id    uuid        not null references public.companies(id) on delete cascade,
  email         text        not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token         text        not null default encode(extensions.gen_random_bytes(32), 'hex'),
  role_id       uuid        references public.roles(id) on delete set null,
  partner_id    uuid        references public.partners(id) on delete set null,
  member_type   app.member_type not null default 'staff',
  invited_by    uuid references public.users(id) on delete set null,
  expires_at    timestamptz not null default now() + interval '14 days',
  accepted_at   timestamptz,
  accepted_by   uuid references public.users(id) on delete set null,
  revoked_at    timestamptz,
  revoked_by    uuid references public.users(id) on delete set null,
  send_count    int         not null default 0 check (send_count >= 0),
  last_sent_at  timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.users(id) on delete set null
);

comment on table public.user_invitations is 'Tenant invites. Carries the role and partner scope granted on acceptance.';

create unique index if not exists user_invitations_token_uidx on public.user_invitations (token);
create unique index if not exists user_invitations_pending_uidx
  on public.user_invitations (company_id, lower(email))
  where accepted_at is null and revoked_at is null;
create index if not exists user_invitations_company_idx on public.user_invitations (company_id);
create index if not exists user_invitations_email_idx   on public.user_invitations (lower(email));

drop trigger if exists trg_user_invitations_audit on public.user_invitations;
create trigger trg_user_invitations_audit before insert or update on public.user_invitations
  for each row execute function app.tg_touch_audit();

-- ---------------------------------------------------------------------------
-- 1. auth.users -> public.users bridge
-- ---------------------------------------------------------------------------
-- public.users already references auth.users(id) and owns the profile columns.
-- Keep the mutable identity fields mirrored from auth so email/phone changes
-- made in Supabase Auth do not drift from the app.
create or replace function app.tg_sync_auth_user()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
begin
  update public.users u
     set email = new.email,
         phone = coalesce(new.phone, u.phone),
         last_seen_at = coalesce(new.last_sign_in_at, u.last_seen_at),
         status = case
                    when u.status = 'invited' and new.email_confirmed_at is not null then 'active'::app.user_status
                    else u.status
                  end,
         accepted_at = coalesce(u.accepted_at, new.email_confirmed_at),
         updated_at = now()
   where u.id = new.id;
  return null;
end $$;

drop trigger if exists trg_auth_users_sync on auth.users;
create trigger trg_auth_users_sync after update on auth.users
  for each row execute function app.tg_sync_auth_user();

-- ---------------------------------------------------------------------------
-- 2. Signup handler
--    Invoked by the app as an RPC immediately after an invited user confirms.
--    Resolves the tenant from a single-use invitation, then seeds a default
--    role. Anonymous self-signup with no invitation is refused.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user(
  p_user_id uuid,
  p_invitation_token text default null
)
returns uuid
language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid;
  v_role uuid;
  v_email text;
  v_invite public.user_invitations%rowtype;
begin
  if exists (select 1 from public.users where id = p_user_id) then
    return p_user_id;                       -- idempotent
  end if;

  if p_invitation_token is not null then
    select * into v_invite
    from public.user_invitations
    where token = p_invitation_token
      and accepted_at is null
      and revoked_at is null
      and expires_at > now()
    for update;

    if not found then
      raise exception 'invitation_invalid_or_expired' using errcode = 'P0001';
    end if;
    v_company := v_invite.company_id;
  else
    raise exception 'invitation_required' using errcode = 'P0001';
  end if;

  select email into v_email from auth.users where id = p_user_id;

  insert into public.users (id, company_id, partner_id, email, member_type, status, accepted_at)
  values (p_user_id, v_company, v_invite.partner_id, coalesce(v_email, v_invite.email),
          coalesce(v_invite.member_type, 'staff'), 'active', now());

  -- Assign the invitation's role, else the tenant default.
  v_role := v_invite.role_id;
  if v_role is null then
    select id into v_role from public.roles
     where company_id = v_company and code = 'staff' and deleted_at is null limit 1;
  end if;
  if v_role is not null then
    insert into public.user_roles (company_id, user_id, role_id, granted_by)
    values (v_company, p_user_id, v_role, null)
    on conflict do nothing;
  end if;

  update public.user_invitations
     set accepted_at = now(),
         accepted_by = p_user_id
   where id = v_invite.id;

  return p_user_id;
end $$;

revoke all on function public.handle_new_user(uuid, text) from public;
grant execute on function public.handle_new_user(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Tenant bootstrap — creates company + owner role + owner membership
-- ---------------------------------------------------------------------------
create or replace function public.create_tenant(
  p_legal_name text,
  p_slug text,
  p_owner_user_id uuid,
  p_email text
)
returns uuid
language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid;
  v_owner_role uuid;
  v_admin_role uuid;
begin
  insert into public.companies (slug, legal_name, email, created_by)
  values (lower(p_slug), p_legal_name, p_email, p_owner_user_id)
  returning id into v_company;

  insert into public.roles (company_id, code, name, permissions, is_system, rank)
  values (v_company, 'owner', 'Owner', '["*"]'::jsonb, true, 1)
  returning id into v_owner_role;

  insert into public.roles (company_id, code, name, permissions, is_system, rank)
  values (v_company, 'admin', 'Administrator',
          '["jobs.*","partners.*","technicians.*","customers.*","rates.*","invoices.*","users.*","settings.*","reports.read"]'::jsonb,
          true, 10)
  returning id into v_admin_role;

  insert into public.roles (company_id, code, name, permissions, is_system, rank)
  values (v_company, 'scheduler', 'Scheduler',
          '["jobs.read","jobs.write","jobs.publish","technicians.read","technicians.assign","customers.*","rates.read","reports.read"]'::jsonb,
          true, 20);

  insert into public.roles (company_id, code, name, permissions, is_system, rank)
  values (v_company, 'partner_admin', 'Partner Administrator',
          '["jobs.read","jobs.write","jobs.publish","technicians.read","customers.read","rates.read","reports.read"]'::jsonb,
          true, 30);

  insert into public.roles (company_id, code, name, permissions, is_system, rank)
  values (v_company, 'technician', 'Technician',
          '["jobs.read","jobs.self","bookings.read","bookings.complete","rates.self","invoices.self"]'::jsonb,
          true, 40);

  insert into public.roles (company_id, code, name, permissions, is_system, rank)
  values (v_company, 'staff', 'Staff',
          '["jobs.read","customers.read","reports.read"]'::jsonb, true, 50);

  insert into public.users (id, company_id, email, member_type, status, accepted_at)
  values (p_owner_user_id, v_company, p_email, 'staff', 'active', now())
  on conflict (id) do nothing;

  insert into public.user_roles (company_id, user_id, role_id, granted_by)
  values (v_company, p_owner_user_id, v_owner_role, null);

  return v_company;
end $$;

revoke all on function public.create_tenant(text, text, uuid, text) from public;
grant execute on function public.create_tenant(text, text, uuid, text) to service_role;



-- =============================================================================
-- SECTION 25 - ROW LEVEL SECURITY
-- Source: 025_rls_policies.sql
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Baseline: enable RLS everywhere. With no policy, access is denied.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('alter table public.%I force row level security', r.relname);
  end loop;
end $$;

-- Strip Supabase's default anon/authenticated grants. RLS is the only gate.
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helper predicates used by the policies below
-- ---------------------------------------------------------------------------

-- Can the caller see this company's data at all?
create or replace function app.can_access_company(p_company_id uuid)
returns boolean language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select p_company_id = app.current_company_id() or app.is_platform_admin()
$$;

-- Partner-portal users only see their own partner's rows.
create or replace function app.partner_scope_ok(p_partner_id uuid)
returns boolean language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select app.current_partner_id() is null
      or p_partner_id = app.current_partner_id()
$$;

-- Technicians see only work assigned to them.
create or replace function app.tech_scope_ok(p_technician_id uuid)
returns boolean language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select app.current_technician_id() is null
      or p_technician_id = app.current_technician_id()
$$;

-- Generic tenant isolation policy generator.
-- read: any tenant member. write: requires the named permission.
create or replace function app.apply_tenant_policies(
  p_table text,
  p_company_col text default 'company_id',
  p_read_perm text default null,
  p_write_perm text default null,
  p_soft_delete boolean default true
)
returns void language plpgsql as $$
declare
  v_read_cond text;
  v_write_cond text;
  v_live text;
begin
  v_read_cond := format('app.can_access_company(%I)', p_company_col);
  if p_read_perm is not null then
    v_read_cond := v_read_cond || format(' and app.has_permission(%L)', p_read_perm);
  end if;

  v_write_cond := format('app.can_access_company(%I)', p_company_col);
  if p_write_perm is not null then
    v_write_cond := v_write_cond || format(' and app.has_permission(%L)', p_write_perm);
  end if;

  v_live := case when p_soft_delete then ' and deleted_at is null' else '' end;

  execute format('drop policy if exists %I on public.%I', p_table || '_tenant_read', p_table);
  execute format(
    'create policy %I on public.%I for select to authenticated using ((%s)%s)',
    p_table || '_tenant_read', p_table, v_read_cond, v_live);

  execute format('drop policy if exists %I on public.%I', p_table || '_tenant_insert', p_table);
  execute format(
    'create policy %I on public.%I for insert to authenticated with check ((%s))',
    p_table || '_tenant_insert', p_table, v_write_cond);

  execute format('drop policy if exists %I on public.%I', p_table || '_tenant_update', p_table);
  execute format(
    'create policy %I on public.%I for update to authenticated using ((%s)) with check ((%s))',
    p_table || '_tenant_update', p_table, v_write_cond, v_write_cond);

  -- No DELETE policy anywhere: soft delete only. Absence denies hard deletes.
end $$;

-- ---------------------------------------------------------------------------
-- Tenant tables
-- ---------------------------------------------------------------------------
select app.apply_tenant_policies('companies',            'id',         null,               'settings.manage');
select app.apply_tenant_policies('audit_logs',           'company_id', 'reports.read',     'reports.read');
select app.apply_tenant_policies('roles',                'company_id', null,               'users.manage');
select app.apply_tenant_policies('user_roles',           'company_id', null,               'users.manage');
select app.apply_tenant_policies('user_invitations',     'company_id', null,               'users.manage');
select app.apply_tenant_policies('partners',             'company_id', 'partners.read',    'partners.write');
select app.apply_tenant_policies('technicians',          'company_id', 'technicians.read', 'technicians.write');
select app.apply_tenant_policies('customers',            'company_id', 'customers.read',   'customers.write');
select app.apply_tenant_policies('jobs',                 'company_id', 'jobs.read',        'jobs.write');
select app.apply_tenant_policies('job_technicians',      'company_id', 'jobs.read',        'technicians.assign');
select app.apply_tenant_policies('qr_codes',             'company_id', 'jobs.read',        'jobs.publish');
select app.apply_tenant_policies('qr_code_scans',        'company_id', 'reports.read',     'reports.read', false);
select app.apply_tenant_policies('job_slots',            'company_id', 'jobs.read',        'jobs.write');
select app.apply_tenant_policies('customer_bookings',    'company_id', 'bookings.read',    'bookings.write');
select app.apply_tenant_policies('rate_cards',           'company_id', 'rates.read',       'rates.manage');
select app.apply_tenant_policies('rate_card_items',      'company_id', 'rates.read',       'rates.manage');
select app.apply_tenant_policies('invoices',             'company_id', 'invoices.read',    'invoices.write');
select app.apply_tenant_policies('invoice_items',        'company_id', 'invoices.read',    'invoices.write');
select app.apply_tenant_policies('notifications',        'company_id', 'notifications.read','notifications.send');
select app.apply_tenant_policies('email_accounts',       'company_id', 'settings.read',    'settings.manage');
select app.apply_tenant_policies('email_logs',           'company_id', 'settings.read',    'settings.manage', false);

-- ---------------------------------------------------------------------------
-- audit_logs is append-only: revoke update/delete outright.
-- ---------------------------------------------------------------------------
drop policy if exists audit_logs_tenant_update on public.audit_logs;

-- ---------------------------------------------------------------------------
-- Global tables (no tenant column)
-- ---------------------------------------------------------------------------
drop policy if exists subscription_plans_public_read on public.subscription_plans;
create policy subscription_plans_public_read on public.subscription_plans
  for select to authenticated using (deleted_at is null and is_active);

drop policy if exists subscription_plans_admin_write on public.subscription_plans;
create policy subscription_plans_admin_write on public.subscription_plans
  for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

select app.apply_tenant_policies('subscriptions', 'company_id', 'billing.read', 'billing.manage');

-- ---------------------------------------------------------------------------
-- users — self-read, tenant-scoped read, admin write
-- ---------------------------------------------------------------------------
drop policy if exists users_self_read on public.users;
create policy users_self_read on public.users
  for select to authenticated using (id = auth.uid());

drop policy if exists users_tenant_read on public.users;
create policy users_tenant_read on public.users
  for select to authenticated
  using (app.can_access_company(company_id) and deleted_at is null);

drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and company_id = app.current_company_id());

drop policy if exists users_admin_write on public.users;
create policy users_admin_write on public.users
  for all to authenticated
  using (app.can_access_company(company_id) and app.has_permission('users.manage'))
  with check (app.can_access_company(company_id) and app.has_permission('users.manage'));

-- No INSERT policy: rows are only created by handle_new_user() / create_tenant().

-- ---------------------------------------------------------------------------
-- Partner-portal narrowing on top of the tenant baseline
-- ---------------------------------------------------------------------------
drop policy if exists jobs_partner_scope on public.jobs;
create policy jobs_partner_scope on public.jobs
  as restrictive for select to authenticated
  using (app.partner_scope_ok(partner_id));

drop policy if exists bookings_partner_scope on public.customer_bookings;
create policy bookings_partner_scope on public.customer_bookings
  as restrictive for select to authenticated
  using (exists (select 1 from public.jobs j
                  where j.id = customer_bookings.job_id
                    and app.partner_scope_ok(j.partner_id)));

-- ---------------------------------------------------------------------------
-- Technician self-scope: a technician sees their own work, nothing else
-- ---------------------------------------------------------------------------
drop policy if exists slots_tech_scope on public.job_slots;
create policy slots_tech_scope on public.job_slots
  as restrictive for select to authenticated
  using (app.current_technician_id() is null
         or technician_id = app.current_technician_id()
         or app.has_permission('jobs.write'));

drop policy if exists bookings_tech_scope on public.customer_bookings;
create policy bookings_tech_scope on public.customer_bookings
  as restrictive for select to authenticated
  using (app.current_technician_id() is null
         or technician_id = app.current_technician_id()
         or app.has_permission('bookings.read'));

drop policy if exists invoices_tech_self on public.invoices;
create policy invoices_tech_self on public.invoices
  as restrictive for select to authenticated
  using (app.current_technician_id() is null
         or direction = 'receivable'
         or technician_id = app.current_technician_id()
         or app.has_permission('invoices.read'));

drop policy if exists rate_cards_tech_self on public.rate_cards;
create policy rate_cards_tech_self on public.rate_cards
  as restrictive for select to authenticated
  using (app.current_technician_id() is null
         or technician_id = app.current_technician_id()
         or app.has_permission('rates.manage'));

-- ---------------------------------------------------------------------------
-- Technicians may complete their own bookings but not reprice them.
-- The trigger below blocks status/comment writes to lines that are not theirs.
-- ---------------------------------------------------------------------------
create or replace function app.tg_booking_tech_guard()
returns trigger language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
begin
  if app.current_technician_id() is not null
     and app.current_technician_id() <> coalesce(new.technician_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid) then
    raise exception 'technician may only modify own bookings' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_booking_tech_guard on public.customer_bookings;
create trigger trg_booking_tech_guard before update on public.customer_bookings
  for each row execute function app.tg_booking_tech_guard();



-- =============================================================================
-- SECTION 26 - PUBLIC BOOKING RPC
-- Source: 026_booking_rpc.sql
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Supporting structures
-- ---------------------------------------------------------------------------

-- Short, human-quotable booking reference (SW-XXXXXX). Alphabet excludes
-- I/O/0/1 so residents can read it back over the phone without ambiguity.
create or replace function app.generate_booking_ref()
returns text language plpgsql volatile
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

-- SMS challenge issued on the public page and consumed by booking_create().
create table if not exists public.sms_challenges (
  id            uuid primary key default extensions.gen_random_uuid(),
  company_id    uuid        not null references public.companies(id) on delete cascade,
  qr_code_id    uuid,
  phone         text        not null,
  code_hash     text        not null,
  attempts      int         not null default 0 check (attempts >= 0),
  max_attempts  int         not null default 5 check (max_attempts > 0),
  verified_at   timestamptz,
  consumed_at   timestamptz,
  expires_at    timestamptz not null default now() + interval '10 minutes',
  created_at    timestamptz not null default now()
);
comment on table public.sms_challenges is
  'One-time SMS verification codes. Code is stored hashed; verified once, then consumed.';

create index if not exists sms_challenges_phone_idx on public.sms_challenges (phone, created_at desc);
create index if not exists sms_challenges_live_idx  on public.sms_challenges (phone)
  where verified_at is not null and consumed_at is null;
create index if not exists sms_challenges_expiry_idx on public.sms_challenges (expires_at)
  where consumed_at is null;

-- Idempotency ledger: a retried form submit returns the original booking ref
-- instead of creating a second reservation.
create table if not exists public.booking_idempotency (
  key         text        primary key,
  booking_id  uuid        not null,
  company_id  uuid        not null references public.companies(id) on delete cascade,
  created_at  timestamptz not null default now()
);
comment on table public.booking_idempotency is
  'Guards against duplicate bookings from a double-tapped submit. Keys expire after 24h.';

create index if not exists booking_idempotency_created_idx on public.booking_idempotency (created_at);

-- Throttle ledger: caps bookings per phone and per IP over a rolling window.
create table if not exists public.booking_rate_limit (
  id          bigserial   primary key,
  company_id  uuid        not null references public.companies(id) on delete cascade,
  bucket      text        not null,          -- 'phone:+61...' or 'ip:203.0.113.4'
  occurred_at timestamptz not null default now()
);
comment on table public.booking_rate_limit is
  'Rolling-window rate-limit ledger for the public booking endpoint.';

-- Leading column is `bucket`: the hot query filters on an exact bucket value
-- then ranges over occurred_at, so this index serves both the predicate and
-- the ordering. A partial predicate is deliberately avoided - now() is not
-- immutable and cannot appear in an index WHERE clause.
create index if not exists booking_rate_limit_lookup_idx on public.booking_rate_limit (bucket, occurred_at desc);
create index if not exists booking_rate_limit_gc_idx     on public.booking_rate_limit (occurred_at);

-- ---------------------------------------------------------------------------
-- 1. Structured error type — callers get a stable code, not a raw message
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'booking_error' and typnamespace = 'app'::regnamespace) then
    create type app.booking_error as enum (
      'invalid_token',
      'qr_inactive',
      'qr_expired',
      'job_not_found',
      'job_not_published',
      'job_closed',
      'job_cancelled',
      'slot_not_found',
      'slot_unavailable',
      'slot_full',
      'unit_already_booked',
      'verification_required',
      'verification_invalid',
      'rate_limited',
      'invalid_input'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. app.booking_create()
--    Returns a single-row table so PostgREST exposes it as a clean RPC.
--    On failure it RAISEs; the client maps SQLSTATE + the leading token of
--    the message ("<error_code>: detail") to a user-facing message.
-- ---------------------------------------------------------------------------
create or replace function app.booking_create(
  p_qr_token        text,
  p_slot_id         uuid,
  p_unit_number     text,
  p_phone           text,
  p_email           text,
  p_full_name       text        default null,
  p_special_comments text       default null,
  p_verification_id uuid        default null,
  p_idempotency_key text        default null,
  p_ip_address      inet        default null,
  p_user_agent      text        default null,
  p_session_id      text        default null
)
returns table (
  booking_id    uuid,
  booking_ref   text,
  status        app.booking_status,
  scheduled_date date,
  scheduled_start timestamptz,
  scheduled_end   timestamptz,
  unit_number   text,
  job_id        uuid,
  job_number    text,
  site_address  text,
  technician_name text,
  already_existed boolean
)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_qr          public.qr_codes%rowtype;
  v_job         public.jobs%rowtype;
  v_slot        public.job_slots%rowtype;
  v_customer    uuid;
  v_booking     public.customer_bookings%rowtype;
  v_email       text := nullif(lower(btrim(p_email)), '');
  v_phone       text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_unit        text := nullif(btrim(p_unit_number), '');
  v_challenge   public.sms_challenges%rowtype;
  v_existing    uuid;
  v_attempts    int;
  v_tech_name   text;
  v_address     text;
begin
  ---------------------------------------------------------------------------
  -- 0. Input validation
  ---------------------------------------------------------------------------
  if p_qr_token is null or length(btrim(p_qr_token)) < 8 then
    raise exception 'invalid_token: QR token missing or malformed' using errcode = 'P0001';
  end if;
  if v_phone is null or length(v_phone) < 8 or length(v_phone) > 20 then
    raise exception 'invalid_input: phone number is not valid' using errcode = 'P0001';
  end if;
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_input: email address is not valid' using errcode = 'P0001';
  end if;
  if length(coalesce(p_special_comments, '')) > 2000 then
    raise exception 'invalid_input: comments exceed 2000 characters' using errcode = 'P0001';
  end if;

  ---------------------------------------------------------------------------
  -- 1. Idempotency — a retried submit returns the original booking.
  ---------------------------------------------------------------------------
  if p_idempotency_key is not null then
    select bi.booking_id into v_existing
    from public.booking_idempotency bi
    where bi.key = p_idempotency_key and bi.created_at > now() - interval '24 hours';

    if found then
      return query
        select b.id, b.booking_ref, b.status, b.scheduled_date, b.scheduled_start,
               b.scheduled_end, b.unit_number, b.job_id, j.job_number,
               concat_ws(', ', j.address_line1, j.suburb, j.state, j.postcode),
               t.full_name, true
        from public.customer_bookings b
        join public.jobs j on j.id = b.job_id
        left join public.technicians t on t.id = b.technician_id
        where b.id = v_existing;
      return;
    end if;
  end if;

  ---------------------------------------------------------------------------
  -- 2. Validate the QR token (locks the row so status cannot flip mid-flight)
  ---------------------------------------------------------------------------
  select * into v_qr
  from public.qr_codes
  where token = p_qr_token and deleted_at is null
  for share;

  if not found then
    raise exception 'invalid_token: QR token not recognised' using errcode = 'P0001';
  end if;
  if v_qr.status = 'revoked' then
    raise exception 'qr_inactive: this QR code has been revoked' using errcode = 'P0001';
  end if;
  if v_qr.status <> 'active' then
    raise exception 'qr_inactive: this QR code is not accepting bookings' using errcode = 'P0001';
  end if;
  if v_qr.expires_at is not null and v_qr.expires_at <= now() then
    raise exception 'qr_expired: this QR code has expired' using errcode = 'P0001';
  end if;
  if v_qr.opens_at is not null and v_qr.opens_at > now() then
    raise exception 'job_closed: bookings have not opened yet' using errcode = 'P0001';
  end if;
  if v_qr.max_bookings is not null and v_qr.booking_count >= v_qr.max_bookings then
    raise exception 'job_closed: this QR code has reached its booking limit' using errcode = 'P0001';
  end if;

  ---------------------------------------------------------------------------
  -- 3. Rate limiting — per phone and per IP, rolling 15-minute windows.
  --    Cheap, and stops a lobby QR being scripted from a single handset.
  ---------------------------------------------------------------------------
  if exists (
    select 1 from public.booking_rate_limit
    where bucket = 'phone:' || v_phone and occurred_at > now() - interval '15 minutes'
    group by bucket having count(*) >= 3
  ) then
    raise exception 'rate_limited: too many booking attempts from this number' using errcode = 'P0001';
  end if;

  if p_ip_address is not null and exists (
    select 1 from public.booking_rate_limit
    where bucket = 'ip:' || host(p_ip_address) and occurred_at > now() - interval '15 minutes'
    group by bucket having count(*) >= 20
  ) then
    raise exception 'rate_limited: too many booking attempts from this address' using errcode = 'P0001';
  end if;

  ---------------------------------------------------------------------------
  -- 4. Resolve the job behind the QR code
  ---------------------------------------------------------------------------
  select * into v_job
  from public.jobs
  where id = v_qr.job_id and deleted_at is null;

  if not found then
    raise exception 'job_not_found: the job behind this QR code no longer exists' using errcode = 'P0001';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'job_cancelled: this installation job has been cancelled' using errcode = 'P0001';
  end if;
  if v_job.status not in ('published','in_progress') or v_job.published_at is null then
    raise exception 'job_not_published: this job is not open for booking' using errcode = 'P0001';
  end if;

  -- Booking window (distinct from the QR's own window)
  if v_job.booking_closes_at is not null and v_job.booking_closes_at <= now() then
    raise exception 'job_closed: the booking window for this job has closed' using errcode = 'P0001';
  end if;
  if v_job.booking_opens_at is not null and v_job.booking_opens_at > now() then
    raise exception 'job_closed: the booking window for this job has not opened' using errcode = 'P0001';
  end if;

  if v_unit is null and (v_job.require_unit_number or v_qr.scope = 'unit') then
    raise exception 'invalid_input: unit number is required' using errcode = 'P0001';
  end if;

  -- Unit-scoped QR pre-fills and pins the unit number.
  if v_qr.scope = 'unit' then
    v_unit := v_qr.unit_number;
  end if;

  ---------------------------------------------------------------------------
  -- 5. SMS verification
  ---------------------------------------------------------------------------
  if v_job.require_sms_verification then
    if p_verification_id is null then
      raise exception 'verification_required: please verify your mobile number' using errcode = 'P0001';
    end if;

    select * into v_challenge
    from public.sms_challenges
    where id = p_verification_id
    for update;

    if not found then
      raise exception 'verification_invalid: verification session not found' using errcode = 'P0001';
    end if;
    if v_challenge.consumed_at is not null or v_challenge.expires_at <= now() then
      raise exception 'verification_invalid: verification has expired, please request a new code' using errcode = 'P0001';
    end if;
    if v_challenge.verified_at is null then
      raise exception 'verification_invalid: code has not been confirmed' using errcode = 'P0001';
    end if;
    if v_challenge.phone <> v_phone then
      raise exception 'verification_invalid: verified number does not match' using errcode = 'P0001';
    end if;
    if v_challenge.company_id <> v_job.company_id then
      raise exception 'verification_invalid: verification belongs to another account' using errcode = 'P0001';
    end if;
  end if;

  ---------------------------------------------------------------------------
  -- 6. Duplicate-unit guard (in addition to the partial unique index, so the
  --    caller gets a friendly error rather than a constraint violation).
  ---------------------------------------------------------------------------
  if v_unit is not null then
    if exists (
      select 1 from public.customer_bookings
      where job_id = v_job.id
        and lower(unit_number) = lower(v_unit)
        and deleted_at is null
        and status not in ('cancelled','no_show')
    ) then
      raise exception 'unit_already_booked: unit % already has a booking for this job', v_unit
        using errcode = 'P0001';
    end if;
  end if;

  ---------------------------------------------------------------------------
  -- 7. Claim the slot — app.slot_claim() row-locks, so concurrent scans on the
  --    same lobby QR serialise here. Any later failure rolls this back.
  ---------------------------------------------------------------------------
  perform app.slot_claim(p_slot_id, null);

  select * into v_slot from public.job_slots where id = p_slot_id;

  if not found or v_slot.job_id <> v_job.id then
    raise exception 'slot_not_found: the selected time is not part of this job' using errcode = 'P0001';
  end if;

  ---------------------------------------------------------------------------
  -- 8. Upsert the customer (phone is the primary identity; email secondary)
  ---------------------------------------------------------------------------
  select id into v_customer
  from public.customers
  where company_id = v_job.company_id
    and deleted_at is null
    and (phone = v_phone or (v_email is not null and lower(email) = v_email))
  order by (phone = v_phone) desc
  limit 1;

  if v_customer is null then
    insert into public.customers (
      company_id, phone, email, full_name, unit_number,
      address_line1, suburb, state, postcode,
      sms_opt_in, phone_verified_at, last_booking_at
    ) values (
      v_job.company_id, v_phone, v_email, nullif(btrim(coalesce(p_full_name,'')), ''), v_unit,
      v_job.address_line1, v_job.suburb, v_job.state, v_job.postcode,
      false,
      case when v_challenge.verified_at is not null then now() else null end,
      now()
    )
    returning id into v_customer;
  else
    update public.customers
       set email = coalesce(v_email, email),
           full_name = coalesce(nullif(btrim(coalesce(p_full_name,'')), ''), full_name),
           unit_number = coalesce(v_unit, unit_number),
           phone_verified_at = coalesce(phone_verified_at,
                 case when v_challenge.verified_at is not null then now() else null end),
           updated_at = now()
     where id = v_customer;
  end if;

  ---------------------------------------------------------------------------
  -- 9. Create the booking
  ---------------------------------------------------------------------------
  insert into public.customer_bookings (
    company_id, job_id, slot_id, technician_id, customer_id, qr_code_id,
    booking_ref, status, unit_number, phone, email, full_name, special_comments,
    scheduled_date, scheduled_start, scheduled_end,
    sms_verified, sms_verified_at, confirmed_at,
    source, metadata
  ) values (
    v_job.company_id, v_job.id, v_slot.id, v_slot.technician_id, v_customer, v_qr.id,
    app.generate_booking_ref(),
    case when v_job.require_sms_verification then 'confirmed' else 'pending' end,
    v_unit, v_phone, v_email, nullif(btrim(coalesce(p_full_name,'')), ''),
    nullif(btrim(coalesce(p_special_comments,'')), ''),
    v_slot.slot_date, v_slot.start_time, v_slot.end_time,
    v_challenge.verified_at is not null, v_challenge.verified_at,
    case when v_job.require_sms_verification then now() else null end,
    'qr',
    jsonb_strip_nulls(jsonb_build_object(
      'ip', case when p_ip_address is not null then host(p_ip_address) end,
      'user_agent', left(p_user_agent, 500),
      'session_id', p_session_id,
      'qr_scope', v_qr.scope))
  )
  returning * into v_booking;

  ---------------------------------------------------------------------------
  -- 10. Consume the verification, record the rate-limit hit, store idempotency
  ---------------------------------------------------------------------------
  if v_challenge.id is not null then
    update public.sms_challenges set consumed_at = now() where id = v_challenge.id;
  end if;

  insert into public.booking_rate_limit (company_id, bucket) values (v_job.company_id, 'phone:' || v_phone);
  if p_ip_address is not null then
    insert into public.booking_rate_limit (company_id, bucket) values (v_job.company_id, 'ip:' || host(p_ip_address));
  end if;

  if p_idempotency_key is not null then
    insert into public.booking_idempotency (key, booking_id, company_id)
    values (p_idempotency_key, v_booking.id, v_job.company_id)
    on conflict (key) do nothing;
  end if;

  ---------------------------------------------------------------------------
  -- 11. Queue notifications (queued, not sent — a worker delivers them)
  --     dedupe_key makes the event idempotent across RPC retries.
  ---------------------------------------------------------------------------
  insert into public.notifications (
    company_id, channel, status, template_key, event_key,
    recipient_customer_id, customer_booking_id, job_id, technician_id,
    recipient_email, recipient_phone, recipient_name,
    subject, variables, scheduled_for, dedupe_key, provider
  )
  select v_job.company_id, c.channel, 'queued',
         'booking.confirmed.' || c.channel, 'booking.confirmed',
         v_customer, v_booking.id, v_job.id, v_slot.technician_id,
         v_email, v_phone, nullif(btrim(coalesce(p_full_name,'')), ''),
         case when c.channel = 'email' then 'Your installation is booked' else null end,
         jsonb_build_object(
           'booking_ref', v_booking.booking_ref,
           'unit_number', v_unit,
           'scheduled_date', v_slot.slot_date,
           'scheduled_start', v_slot.local_start,
           'scheduled_end', v_slot.local_end,
           'job_number', v_job.job_number,
           'address', concat_ws(', ', v_job.address_line1, v_job.suburb, v_job.state, v_job.postcode)),
         now(), 'booking.confirmed:' || v_booking.id || ':' || c.channel,
         case when c.channel = 'email' then 'microsoft_graph' else 'twilio' end
  from (values ('email'::app.notification_channel), ('sms'::app.notification_channel)) as c(channel)
  on conflict (company_id, dedupe_key) do nothing;

  -- Alert the assigned technician, if any.
  if v_slot.technician_id is not null then
    insert into public.notifications (
      company_id, channel, status, template_key, event_key,
      recipient_technician_id, technician_id, customer_booking_id, job_id,
      subject, variables, scheduled_for, dedupe_key, provider
    ) values (
      v_job.company_id, 'push', 'queued', 'slot.assigned.push', 'slot.assigned',
      v_slot.technician_id, v_slot.technician_id, v_booking.id, v_job.id,
      'New booking', jsonb_build_object(
        'booking_ref', v_booking.booking_ref,
        'unit_number', v_unit,
        'local_start', v_slot.local_start,
        'local_end', v_slot.local_end),
      now(), 'slot.assigned:' || v_booking.id, 'webpush'
    ) on conflict (company_id, dedupe_key) do nothing;
  end if;

  ---------------------------------------------------------------------------
  -- 12. Return the confirmation payload
  ---------------------------------------------------------------------------
  select t.full_name into v_tech_name
  from public.technicians t where t.id = v_slot.technician_id;

  v_address := concat_ws(', ', v_job.address_line1, v_job.suburb, v_job.state, v_job.postcode);

  return query select
    v_booking.id, v_booking.booking_ref, v_booking.status,
    v_booking.scheduled_date, v_booking.scheduled_start, v_booking.scheduled_end,
    v_booking.unit_number, v_job.id, v_job.job_number, v_address,
    v_tech_name, false;

exception
  -- The unique index on (job_id, lower(unit_number)) is the last line of
  -- defence if two units race past the pre-check above.
  when unique_violation then
    if sqlerrm like '%customer_bookings_unit_uidx%' then
      raise exception 'unit_already_booked: this unit was just booked by someone else'
        using errcode = 'P0001';
    end if;
    raise;
end $$;

comment on function app.booking_create is
  'Anonymous booking entry point. Validates QR/job/window/verification, claims a slot under lock, upserts the customer, writes the booking and queues notifications — all in one transaction.';

revoke all on function app.booking_create(text, uuid, text, text, text, text, text, uuid, text, inet, text, text) from public;
grant execute on function app.booking_create(text, uuid, text, text, text, text, text, uuid, text, inet, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Public wrapper so PostgREST exposes a stable, tenant-safe entry point.
-- ---------------------------------------------------------------------------
create or replace function public.create_booking(
  p_qr_token        text,
  p_slot_id         uuid,
  p_unit_number     text,
  p_phone           text,
  p_email           text,
  p_full_name       text        default null,
  p_special_comments text       default null,
  p_verification_id uuid        default null,
  p_idempotency_key text        default null,
  p_ip_address      inet        default null,
  p_user_agent      text        default null,
  p_session_id      text        default null
)
returns table (
  booking_id uuid, booking_ref text, status app.booking_status,
  scheduled_date date, scheduled_start timestamptz, scheduled_end timestamptz,
  unit_number text, job_id uuid, job_number text, site_address text,
  technician_name text, already_existed boolean
)
language sql security definer
set search_path = app, public, pg_catalog
as $$
  select * from app.booking_create(
    p_qr_token, p_slot_id, p_unit_number, p_phone, p_email,
    p_full_name, p_special_comments, p_verification_id, p_idempotency_key,
    p_ip_address, p_user_agent, p_session_id)
$$;

comment on function public.create_booking is
  'PostgREST-exposed wrapper for app.booking_create(). Callable by anon for the public booking page.';

revoke all on function public.create_booking(text, uuid, text, text, text, text, text, uuid, text, inet, text, text) from public;
grant execute on function public.create_booking(text, uuid, text, text, text, text, text, uuid, text, inet, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Public read: available slots for a QR token (informational only —
--    the authoritative check happens inside booking_create under lock).
-- ---------------------------------------------------------------------------
create or replace function public.available_slots(p_qr_token text)
returns table (
  slot_id uuid, slot_date date, local_start time, local_end time,
  capacity int, remaining int, technician_name text
)
language sql stable security definer
set search_path = app, public, pg_catalog
as $$
  select s.id, s.slot_date, s.local_start, s.local_end,
         s.capacity, greatest(s.capacity - s.booked_count, 0), t.full_name
  from public.qr_codes qr
  join public.jobs j on j.id = qr.job_id and j.deleted_at is null
  join public.job_slots s on s.job_id = j.id and s.deleted_at is null
  left join public.technicians t on t.id = s.technician_id
  where qr.token = p_qr_token
    and qr.deleted_at is null
    and qr.status = 'active'
    and j.status in ('published','in_progress')
    and s.status in ('open','held')
    and s.booked_count < s.capacity
    and s.start_time > now()
  order by s.slot_date, s.local_start;
$$;

comment on function public.available_slots is
  'Read-only slot availability for a QR token. Public; returns nothing sensitive.';

revoke all on function public.available_slots(text) from public;
grant execute on function public.available_slots(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. housekeeping — expire stale holds and prune ledgers
--    Run on a Supabase cron schedule (e.g. every 5 minutes).
-- ---------------------------------------------------------------------------
create or replace function public.booking_housekeeping()
returns jsonb language plpgsql security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_holds int;
  v_codes int;
  v_keys  int;
  v_rate  int;
begin
  update public.job_slots
     set hold_token = null, hold_expires_at = null,
         status = case when status = 'held' then 'open'::app.slot_status else status end,
         updated_at = now()
   where hold_token is not null
     and hold_expires_at is not null
     and hold_expires_at < now()
     and booked_count < capacity
     and deleted_at is null;
  get diagnostics v_holds = row_count;

  delete from public.sms_challenges
   where consumed_at is null and expires_at < now() - interval '1 hour';
  get diagnostics v_codes = row_count;

  delete from public.booking_idempotency where created_at < now() - interval '24 hours';
  get diagnostics v_keys = row_count;

  delete from public.booking_rate_limit where occurred_at < now() - interval '24 hours';
  get diagnostics v_rate = row_count;

  return jsonb_build_object(
    'holds_released', v_holds, 'challenges_pruned', v_codes,
    'keys_pruned', v_keys, 'rate_rows_pruned', v_rate);
end $$;

revoke all on function public.booking_housekeeping() from public;
grant execute on function public.booking_housekeeping() to service_role;

-- ---------------------------------------------------------------------------
-- 6. RLS for the new tables
-- ---------------------------------------------------------------------------
alter table public.sms_challenges       enable row level security;
alter table public.sms_challenges       force  row level security;
alter table public.booking_idempotency  enable row level security;
alter table public.booking_idempotency  force  row level security;
alter table public.booking_rate_limit   enable row level security;
alter table public.booking_rate_limit   force  row level security;

revoke all on public.sms_challenges, public.booking_idempotency, public.booking_rate_limit
  from anon, authenticated;

-- Operators may inspect challenges; nobody reads the idempotency or rate ledgers.
drop policy if exists sms_challenges_staff_read on public.sms_challenges;
create policy sms_challenges_staff_read on public.sms_challenges
  for select to authenticated
  using (app.can_access_company(company_id) and app.has_permission('bookings.read'));

drop policy if exists booking_rate_limit_staff_read on public.booking_rate_limit;
create policy booking_rate_limit_staff_read on public.booking_rate_limit
  for select to authenticated
  using (app.can_access_company(company_id) and app.has_permission('bookings.read'));

drop policy if exists booking_idempotency_staff_read on public.booking_idempotency;
create policy booking_idempotency_staff_read on public.booking_idempotency
  for select to authenticated
  using (app.can_access_company(company_id) and app.has_permission('bookings.read'));

-- ---------------------------------------------------------------------------
-- 7. Lock down the internal primitives created in this section.
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on every new function, and
-- an orphaned PUBLIC grant survives CREATE OR REPLACE. Both functions below
-- are SECURITY DEFINER, so an anonymous caller reaching them via PostgREST
-- would act with elevated rights:
--
--   * app.slot_claim()          - could be looped to consume slot capacity
--                                 and render a whole building unbookable.
--   * app.booking_housekeeping()- could be looped to drain the rate-limit
--                                 ledger and disable the booking throttle.
--
-- Revoke from PUBLIC, anon and authenticated; grant to service_role only.
-- ---------------------------------------------------------------------------
revoke execute on function app.slot_claim(uuid, text) from public, anon, authenticated;
grant  execute on function app.slot_claim(uuid, text) to service_role;

revoke all on function public.booking_housekeeping() from public, anon, authenticated;
grant  execute on function public.booking_housekeeping() to service_role;

revoke all on function app.generate_booking_ref() from public, anon, authenticated;
grant  execute on function app.generate_booking_ref() to service_role;

-- ---------------------------------------------------------------------------
-- 8. Keep the private `app` schema off the PostgREST surface entirely.
--    This is the durable fix: with `app` excluded from the exposed schema
--    list, no helper function is reachable over HTTP regardless of grants.
--    Verify after a PostgREST restart with:
--      select current_setting('pgrst.db_schemas', true);
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_schemas = ''public,graphql_public''';
    execute 'alter role authenticator set pgrst.db_extra_search_path = ''public,extensions''';
  end if;
end $$;

-- No policies on booking_idempotency: service_role (which bypasses RLS) is the
-- only reader, and it has no need to read it outside the RPC.



-- =============================================================================
-- END OF MASTER SCHEMA
--
-- 27 sections - 28 tables - 16 enum types - 4 RPCs - 1 public booking function.
--
-- Post-install checklist
--   1. Verify RLS is forced on every table:
--        select c.relname, c.relrowsecurity, c.relforcerowsecurity
--        from pg_class c join pg_namespace n on n.oid = c.relnamespace
--        where n.nspname = 'public' and c.relkind = 'r';
--   2. Confirm no internal function is anon-reachable:
--        select p.proname, coalesce(array_to_string(p.proacl,','),'DEFAULT(=>PUBLIC)')
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname in ('app','public') and p.proname in
--              ('slot_claim','booking_housekeeping','generate_booking_ref');
--      Expect each to list service_role only - no PUBLIC, no anon.
--   3. Confirm the private schema is off the API surface (after a PostgREST
--      restart):  select current_setting('pgrst.db_schemas', true);
--   4. Schedule public.booking_housekeeping() on cron every 5 minutes.
--   5. Seed subscription_plans from the Stripe product catalogue.
--   6. Regenerate types:
--        supabase gen types typescript --linked > src/lib/supabase/types.ts
-- =============================================================================

commit;
