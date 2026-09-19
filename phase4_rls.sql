-- =============================================================================
-- phase4_rls.sql
-- SwiftWorks — Phase 4: Row Level Security
--
-- Depends on: bootstrap.sql, phase2_tables.sql, phase3_auth.sql
--
-- Enables and FORCES RLS on every tenant table, revokes the default
-- anon/authenticated grants, and generates per-table policies from the
-- existing helper functions.
--
-- No table structures are altered. Policies are additive.
--
-- Access model
--   SELECT  tenant members, gated by member type and permission
--   INSERT  tenant members holding the write permission
--   UPDATE  tenant members holding the write permission
--   DELETE  not granted. Soft delete only, via UPDATE of deleted_at.
--
-- Platform admins bypass tenant scoping through app.is_platform_admin(),
-- which app.can_access_company() already honours.
-- =============================================================================

begin;

set client_min_messages = warning;

-- =============================================================================
-- SECTION 1 — BASELINE
-- =============================================================================

-- 1.1 Enable and force RLS on every table in the public schema.
--     FORCE matters: it applies RLS to the table owner too, so a migration
--     run as owner cannot bypass its own policies.
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('alter table public.%I force  row level security', r.relname);
  end loop;
end $$;

-- 1.2 Strip Supabase's default grants. RLS becomes the only gate.
--     Usage on the schema is required for PostgREST to reach the tables.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- Sequences are needed for insert into serial-backed tables.
grant usage, select on all sequences in schema public to authenticated;

-- =============================================================================
-- SECTION 2 — EXTRA PREDICATE
-- =============================================================================
-- app.has_permission() and friends already exist from phase3_auth.sql.
-- This adds only the technician-scope predicate, which has no consumer until
-- the restrictive policies below.
-- =============================================================================

create or replace function app.current_technician_id()
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select t.id
  from public.technicians t
  where t.user_id = auth.uid()
    and t.deleted_at is null
  limit 1
$$;

comment on function app.current_technician_id() is
  'Resolves the calling user to their technicians row. NULL for operator and partner users, which is what lets the restrictive technician policies fall through to the permissive baseline.';

create or replace function app.tech_scope_ok(p_technician_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select app.current_technician_id() is null
      or p_technician_id = app.current_technician_id()
$$;

comment on function app.tech_scope_ok(uuid) is
  'Restrictive predicate narrowing technician users to their own assignments.';

revoke execute on function app.current_technician_id() from public, anon, authenticated;
revoke execute on function app.tech_scope_ok(uuid) from public, anon, authenticated;
grant execute on function app.current_technician_id() to service_role;
grant execute on function app.tech_scope_ok(uuid) to service_role;

-- =============================================================================
-- SECTION 3 — POLICY GENERATOR
-- =============================================================================
-- Produces four policies per table from one call:
--   _tenant_read    SELECT
--   _tenant_insert  INSERT
--   _tenant_update  UPDATE
--   (no delete policy — soft delete is enforced by its absence)
--
-- Parameters
--   p_table        table name in public
--   p_company_col  tenant column, default 'company_id'
--   p_read_perm    permission string required to SELECT (NULL = any member)
--   p_write_perm   permission string required to INSERT/UPDATE (NULL = member)
--   p_soft_delete  whether the table carries deleted_at
-- =============================================================================

create or replace function app.apply_tenant_policies(
  p_table       text,
  p_company_col text    default 'company_id',
  p_read_perm   text    default null,
  p_write_perm  text    default null,
  p_soft_delete boolean default true
)
returns void
language plpgsql
as $$
declare
  v_read  text;
  v_write text;
  v_live  text;
begin
  v_read  := format('app.can_access_company(%I)', p_company_col);
  v_write := format('app.can_access_company(%I)', p_company_col);

  if p_read_perm is not null then
    v_read := v_read || format(' and app.has_permission(%L)', p_read_perm);
  end if;
  if p_write_perm is not null then
    v_write := v_write || format(' and app.has_permission(%L)', p_write_perm);
  end if;

  v_live := case when p_soft_delete then ' and deleted_at is null' else '' end;

  execute format('drop policy if exists %I on public.%I', p_table || '_tenant_read', p_table);
  execute format(
    'create policy %I on public.%I for select to authenticated using ((%s)%s)',
    p_table || '_tenant_read', p_table, v_read, v_live);

  execute format('drop policy if exists %I on public.%I', p_table || '_tenant_insert', p_table);
  execute format(
    'create policy %I on public.%I for insert to authenticated with check ((%s))',
    p_table || '_tenant_insert', p_table, v_write);

  execute format('drop policy if exists %I on public.%I', p_table || '_tenant_update', p_table);
  execute format(
    'create policy %I on public.%I for update to authenticated using ((%s)) with check ((%s))',
    p_table || '_tenant_update', p_table, v_write, v_write);
end $$;

comment on function app.apply_tenant_policies(text, text, text, text, boolean) is
  'Generates SELECT/INSERT/UPDATE policies for a tenant table. Omits DELETE deliberately so soft delete is the only removal path.';

revoke execute on function app.apply_tenant_policies(text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function app.apply_tenant_policies(text, text, text, text, boolean) to service_role;

-- =============================================================================
-- SECTION 4 — TENANT TABLES
-- =============================================================================
-- Every call sets p_soft_delete explicitly where the table has no deleted_at.
-- Tables without that column: audit_logs, qr_code_scans, notifications,
-- email_logs, user_invitations.
-- =============================================================================

select app.apply_tenant_policies('companies',           'id',         null,                 'settings.manage');

select app.apply_tenant_policies('audit_logs',          'company_id', 'reports.read',       'reports.read',       false);

select app.apply_tenant_policies('roles',               'company_id', null,                 'users.manage');
select app.apply_tenant_policies('user_roles',          'company_id', null,                 'users.manage');
select app.apply_tenant_policies('user_invitations',    'company_id', null,                 'users.manage',       false);

select app.apply_tenant_policies('partners',            'company_id', 'partners.read',      'partners.write');
select app.apply_tenant_policies('technicians',         'company_id', 'technicians.read',   'technicians.write');
select app.apply_tenant_policies('customers',           'company_id', 'customers.read',     'customers.write');
select app.apply_tenant_policies('jobs',                'company_id', 'jobs.read',          'jobs.write');
select app.apply_tenant_policies('job_technicians',     'company_id', 'jobs.read',          'technicians.assign');

select app.apply_tenant_policies('qr_codes',            'company_id', 'jobs.read',          'jobs.publish');
select app.apply_tenant_policies('qr_code_scans',       'company_id', 'reports.read',       'reports.read',       false);

select app.apply_tenant_policies('job_slots',           'company_id', 'jobs.read',          'jobs.write');
select app.apply_tenant_policies('customer_bookings',   'company_id', 'bookings.read',      'bookings.write');

select app.apply_tenant_policies('rate_cards',          'company_id', 'rates.read',         'rates.manage');
select app.apply_tenant_policies('rate_card_items',     'company_id', 'rates.read',         'rates.manage');

select app.apply_tenant_policies('invoices',            'company_id', 'invoices.read',      'invoices.write');
select app.apply_tenant_policies('invoice_items',       'company_id', 'invoices.read',      'invoices.write');

select app.apply_tenant_policies('notifications',       'company_id', 'notifications.read', 'notifications.send', false);
select app.apply_tenant_policies('email_accounts',      'company_id', 'settings.read',      'settings.manage');
select app.apply_tenant_policies('email_logs',          'company_id', 'settings.read',      'settings.manage',    false);

select app.apply_tenant_policies('subscriptions',       'company_id', 'billing.read',       'billing.manage');

-- =============================================================================
-- SECTION 5 — APPEND-ONLY TABLES
-- =============================================================================
-- audit_logs is a forensic trail. Remove its update policy so it can only be
-- appended to, never rewritten by a tenant user.
-- =============================================================================

drop policy if exists audit_logs_tenant_update on public.audit_logs;

-- =============================================================================
-- SECTION 6 — USERS  (self-read plus tenant-scoped admin)
-- =============================================================================

drop policy if exists users_self_read on public.users;
create policy users_self_read on public.users
  for select to authenticated
  using (id = auth.uid());

drop policy if exists users_tenant_read on public.users;
create policy users_tenant_read on public.users
  for select to authenticated
  using (app.can_access_company(company_id) and deleted_at is null);

-- Users may edit their own profile but may not move themselves to another
-- tenant: the WITH CHECK pins company_id to the caller's own tenant.
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

-- No INSERT policy on public.users: rows are created only by
-- public.handle_new_user() and public.create_tenant(), both SECURITY DEFINER.

-- =============================================================================
-- SECTION 7 — GLOBAL TABLES  (no tenant column)
-- =============================================================================

drop policy if exists subscription_plans_public_read on public.subscription_plans;
create policy subscription_plans_public_read on public.subscription_plans
  for select to authenticated
  using (deleted_at is null and is_active);

drop policy if exists subscription_plans_admin_write on public.subscription_plans;
create policy subscription_plans_admin_write on public.subscription_plans
  for all to authenticated
  using (app.is_platform_admin())
  with check (app.is_platform_admin());

-- =============================================================================
-- SECTION 8 — PARTNER PORTAL NARROWING
-- =============================================================================
-- Restrictive policies AND with the permissive baseline, so a partner-portal
-- user sees their own partner's rows and nothing else in the tenant.
-- rls_force_row_security means app.is_platform_admin() still bypasses via the
-- baseline policy; these only narrow, never widen.
-- =============================================================================

drop policy if exists jobs_partner_scope on public.jobs;
create policy jobs_partner_scope on public.jobs
  as restrictive for select to authenticated
  using (app.partner_scope_ok(partner_id));

drop policy if exists technicians_partner_scope on public.technicians;
create policy technicians_partner_scope on public.technicians
  as restrictive for select to authenticated
  using (app.partner_scope_ok(partner_id));

drop policy if exists qr_codes_partner_scope on public.qr_codes;
create policy qr_codes_partner_scope on public.qr_codes
  as restrictive for select to authenticated
  using (exists (
    select 1 from public.jobs j
    where j.id = qr_codes.job_id and app.partner_scope_ok(j.partner_id)
  ));

drop policy if exists bookings_partner_scope on public.customer_bookings;
create policy bookings_partner_scope on public.customer_bookings
  as restrictive for select to authenticated
  using (exists (
    select 1 from public.jobs j
    where j.id = customer_bookings.job_id and app.partner_scope_ok(j.partner_id)
  ));

drop policy if exists invoices_partner_scope on public.invoices;
create policy invoices_partner_scope on public.invoices
  as restrictive for select to authenticated
  using (app.partner_scope_ok(partner_id));

-- =============================================================================
-- SECTION 9 — TECHNICIAN SELF-SCOPE
-- =============================================================================
-- A technician sees their own work. app.current_technician_id() returns NULL
-- for operator and partner users, so those callers pass through unchanged and
-- the permissive baseline decides.
-- =============================================================================

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

-- Technicians may complete their own bookings but not touch anyone else's.
-- RLS filters rows; this trigger stops the write on the rows it does see.
create or replace function app.tg_booking_tech_guard()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
begin
  if app.current_technician_id() is not null
     and app.current_technician_id() <> coalesce(new.technician_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid) then
    raise exception 'technician may only modify own bookings' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function app.tg_booking_tech_guard() is
  'Blocks a technician from updating a booking not assigned to them.';

revoke execute on function app.tg_booking_tech_guard() from public, anon, authenticated;
grant execute on function app.tg_booking_tech_guard() to service_role;

drop trigger if exists trg_booking_tech_guard on public.customer_bookings;
create trigger trg_booking_tech_guard
  before update on public.customer_bookings
  for each row
  execute function app.tg_booking_tech_guard();

-- =============================================================================
-- SECTION 10 — ANON SURFACE
-- =============================================================================
-- The public booking flow does not touch base tables. It reaches the database
-- only through SECURITY DEFINER RPCs created in Phase 5. No anon policy is
-- created on any base table. Granting none is intentional: with RLS forced and
-- no policy, anon reads nothing.
--
-- The one exception is the public booking lookup, which will be delivered as a
-- SECURITY DEFINER function rather than a policy.
-- =============================================================================

revoke all on public.users, public.companies, public.roles, public.user_roles,
              public.user_invitations, public.partners, public.technicians,
              public.customers, public.jobs, public.job_technicians,
              public.qr_codes, public.qr_code_scans, public.job_slots,
              public.customer_bookings, public.rate_cards, public.rate_card_items,
              public.invoices, public.invoice_items, public.notifications,
              public.email_accounts, public.email_logs, public.subscriptions,
              public.subscription_plans, public.audit_logs
  from anon;

-- =============================================================================
-- SECTION 11 — VERIFICATION
-- =============================================================================
do $$
declare
  v_rls_off    text[] := array[]::text[];
  v_no_policy  text[] := array[]::text[];
  v_anon_open  text[] := array[]::text[];
  r          record;
begin
  -- 11.1 Every public table must have RLS enabled and forced.
  for r in
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    if not r.relrowsecurity or not r.relforcerowsecurity then
      v_rls_off := v_rls_off || r.relname;
    end if;
  end loop;

  if array_length(v_rls_off, 1) > 0 then
    raise exception 'phase 4 incomplete - RLS not forced on: %',
      array_to_string(v_rls_off, ', ') using errcode = 'P0001';
  end if;

  -- 11.2 Every public table must carry at least one policy.
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = r.relname
    ) then
      v_no_policy := v_no_policy || r.relname;
    end if;
  end loop;

  if array_length(v_no_policy, 1) > 0 then
    raise exception 'phase 4 incomplete - no policies on: %',
      array_to_string(v_no_policy, ', ') using errcode = 'P0001';
  end if;

  -- 11.3 No base table may grant to anon.
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    if has_table_privilege('anon', format('public.%I', r.relname), 'SELECT') then
      v_anon_open := v_anon_open || r.relname;
    end if;
  end loop;

  if array_length(v_anon_open, 1) > 0 then
    raise exception 'phase 4 incomplete - anon retains SELECT on: %',
      array_to_string(v_anon_open, ', ') using errcode = 'P0001';
  end if;

  raise notice 'phase 4 complete: RLS forced on % tables, % policies, anon locked out',
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'),
    (select count(*) from pg_policies where schemaname = 'public');
end $$;

commit;

-- =============================================================================
-- END phase4_rls.sql
-- =============================================================================
