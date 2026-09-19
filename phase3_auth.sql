-- =============================================================================
-- phase3_auth.sql
-- SwiftWorks — Phase 3: Authentication Layer
--
-- Depends on: bootstrap.sql (schemas, extensions, app enums, utility helpers)
--             phase2_tables.sql (companies, users, roles, user_roles,
--                                user_invitations, audit_logs)
--
-- Contains:
--   1. Supabase Auth integration (auth.users -> public.users sync)
--   2. Auth helper functions (tenant resolution, permission checks)
--   3. First company admin onboarding (create_tenant)
--   4. New user onboarding (handle_new_user)
--   5. Invite user workflow (invite_user)
--   6. Acceptance workflow (accept_invitation)
--   7. Database triggers required by the auth layer
--
-- EXCLUDES: RLS policies (Phase 8). No table alterations — every object here is
-- additive. Existing column definitions are reused as-is.
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1 — SUPABASE AUTH INTEGRATION
-- =============================================================================
-- public.users.id already references auth.users(id). Supabase owns identity;
-- this layer keeps the application profile in step with it.
--
-- Note: app.current_user_id(), app.is_authenticated(), and app.jwt_claim()
-- already exist from bootstrap.sql. The functions below are the ones that
-- require the application tables and so could not be created earlier.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1.1 Tenant resolution — requires public.users
-- -----------------------------------------------------------------------------
create or replace function app.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select u.company_id
  from public.users u
  where u.id = auth.uid()
    and u.deleted_at is null
$$;

comment on function app.current_company_id() is
  'Resolves the calling user''s tenant. Every tenant RLS policy is expressed in terms of this.';

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select coalesce(
    (select u.is_platform_admin
     from public.users u
     where u.id = auth.uid() and u.deleted_at is null),
    false)
$$;

comment on function app.is_platform_admin() is
  'True when the calling user is a SwiftWorks operator. Bypasses tenant scoping.';

create or replace function app.current_partner_id()
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select u.partner_id
  from public.users u
  where u.id = auth.uid() and u.deleted_at is null
$$;

comment on function app.current_partner_id() is
  'Partner scope for the calling user. NULL for operator users, which widens rather than narrows access.';

-- -----------------------------------------------------------------------------
-- 1.2 Membership helpers
-- -----------------------------------------------------------------------------
create or replace function app.current_member_type()
returns app.member_type
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select u.member_type
  from public.users u
  where u.id = auth.uid() and u.deleted_at is null
$$;

comment on function app.current_member_type() is
  'Member type of the calling user: staff, partner, technician, customer_service.';

create or replace function app.user_company_id(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select u.company_id
  from public.users u
  where u.id = p_user_id and u.deleted_at is null
$$;

comment on function app.user_company_id(uuid) is
  'Tenant for an arbitrary user id. Bypasses the caller check for administrative use.';

create or replace function app.is_company_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.company_id = p_company_id
      and u.deleted_at is null
  )
$$;

comment on function app.is_company_member(uuid) is
  'True when the calling user belongs to the given tenant.';

-- -----------------------------------------------------------------------------
-- 1.3 Permission resolution against roles / user_roles
-- -----------------------------------------------------------------------------
create or replace function app.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.deleted_at is null
    where ur.user_id = auth.uid()
      and ur.deleted_at is null
      and (ur.expires_at is null or ur.expires_at > now())
      and (
        r.permissions ? '*'
        or r.permissions ? p_permission
        or r.permissions ? (split_part(p_permission, '.', 1) || '.*')
      )
  )
  or app.is_platform_admin()
$$;

comment on function app.has_permission(text) is
  'Permission check driven by roles.permissions (jsonb array). Supports * and prefix.* wildcards. Honours user_roles.expires_at.';

create or replace function app.has_role(variadic p_codes text[])
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.deleted_at is null
    where ur.user_id = auth.uid()
      and ur.deleted_at is null
      and (ur.expires_at is null or ur.expires_at > now())
      and lower(r.code) = any (select lower(x) from unnest(p_codes) x)
  )
$$;

comment on function app.has_role(text[]) is
  'True when the calling user holds any of the supplied role codes.';

create or replace function app.has_permission_in(
  p_company_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.deleted_at is null
    where ur.user_id = auth.uid()
      and ur.company_id = p_company_id
      and ur.deleted_at is null
      and (ur.expires_at is null or ur.expires_at > now())
      and (
        r.permissions ? '*'
        or r.permissions ? p_permission
        or r.permissions ? (split_part(p_permission, '.', 1) || '.*')
      )
  )
  or app.is_platform_admin()
$$;

comment on function app.has_permission_in(uuid, text) is
  'Tenant-scoped permission check. Use in multi-company contexts.';

create or replace function app.user_permissions(p_user_id uuid default null)
returns text[]
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select coalesce(array_agg(distinct perm order by perm), '{}')
  from (
    select jsonb_array_elements_text(r.permissions) as perm
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.deleted_at is null
    where ur.user_id = coalesce(p_user_id, auth.uid())
      and ur.deleted_at is null
      and (ur.expires_at is null or ur.expires_at > now())
  ) t
$$;

comment on function app.user_permissions(uuid) is
  'Flattened permission strings for a user. Drives UI capability gating.';

-- -----------------------------------------------------------------------------
-- 1.4 Scope predicates (consumed by restrictive RLS policies in Phase 8)
-- -----------------------------------------------------------------------------
create or replace function app.can_access_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select p_company_id = app.current_company_id() or app.is_platform_admin()
$$;

comment on function app.can_access_company(uuid) is
  'Tenant access predicate used by every generated RLS policy.';

create or replace function app.partner_scope_ok(p_partner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select app.current_partner_id() is null
      or p_partner_id = app.current_partner_id()
$$;

comment on function app.partner_scope_ok(uuid) is
  'Restrictive predicate narrowing partner-portal users to their own partner.';

-- =============================================================================
-- SECTION 2 — AUTH TRIGGERS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 Mirror auth.users changes onto public.users
--     Supabase owns email / phone / confirmation state; the profile row must
--     not drift from it.
-- -----------------------------------------------------------------------------
create or replace function app.tg_sync_auth_user()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
begin
  update public.users u
     set email        = new.email,
         phone        = coalesce(new.phone, u.phone),
         last_seen_at = coalesce(new.last_sign_in_at, u.last_seen_at),
         status       = case
                          when u.status = 'invited' and new.email_confirmed_at is not null
                            then 'active'::app.user_status
                          else u.status
                        end,
         accepted_at  = coalesce(u.accepted_at, new.email_confirmed_at),
         updated_at   = now()
   where u.id = new.id;

  return null;
end $$;

comment on function app.tg_sync_auth_user() is
  'Mirrors auth.users identity fields onto public.users. Activates invited users on email confirmation.';

drop trigger if exists trg_auth_users_sync on auth.users;
create trigger trg_auth_users_sync
  after update on auth.users
  for each row
  execute function app.tg_sync_auth_user();

-- -----------------------------------------------------------------------------
-- 2.2 Block hard deletes of public.users — soft delete only.
--     auth.users cascade would otherwise silently remove the profile.
-- -----------------------------------------------------------------------------
create or replace function app.tg_block_user_hard_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'public.users rows are soft-deleted (set deleted_at), not removed'
    using errcode = '42501';
end $$;

comment on function app.tg_block_user_hard_delete() is
  'Enforces soft delete on public.users. Preserves audit trail and FK integrity.';

drop trigger if exists trg_users_block_delete on public.users;
create trigger trg_users_block_delete
  before delete on public.users
  for each row
  execute function app.tg_block_user_hard_delete();

-- -----------------------------------------------------------------------------
-- 2.3 Expire user_invitations past their window.
--     Written as a statement-level sweep so Phase 9 cron can call it.
-- -----------------------------------------------------------------------------
create or replace function app.expire_stale_invitations()
returns integer
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_count integer;
begin
  update public.user_invitations
     set revoked_at = now(),
         revoked_by = null,
         updated_at = now()
   where accepted_at is null
     and revoked_at is null
     and expires_at < now();

  get diagnostics v_count = row_count;
  return v_count;
end $$;

comment on function app.expire_stale_invitations() is
  'Revokes pending invitations past expires_at. Schedule on cron.';

-- -----------------------------------------------------------------------------
-- 2.4 Default role for a new tenant member.
-- -----------------------------------------------------------------------------
create or replace function app.default_role_for(p_company_id uuid)
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select r.id
  from public.roles r
  where r.company_id = p_company_id
    and r.code = 'staff'
    and r.deleted_at is null
  limit 1
$$;

comment on function app.default_role_for(uuid) is
  'Resolves the tenant staff role, used when an invitation carries no explicit role.';

-- =============================================================================
-- SECTION 3 — FIRST COMPANY ADMIN ONBOARDING
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 create_tenant()
--     Creates the company, seeds the six system roles, and grants the founding
--     user the owner role — in one transaction.
-- -----------------------------------------------------------------------------
create or replace function public.create_tenant(
  p_legal_name    text,
  p_slug          text,
  p_owner_user_id uuid,
  p_email         text,
  p_trading_name  text default null,
  p_timezone      text default 'Australia/Sydney'
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company    uuid;
  v_owner_role uuid;
begin
  if exists (select 1 from public.users where id = p_owner_user_id and deleted_at is null) then
    raise exception 'user_already_belongs_to_a_tenant' using errcode = 'P0001';
  end if;

  insert into public.companies (
    slug, legal_name, trading_name, email, timezone, created_by, onboarding_status
  ) values (
    lower(btrim(p_slug)), btrim(p_legal_name), nullif(btrim(coalesce(p_trading_name,'')), ''),
    lower(btrim(p_email)), coalesce(p_timezone, 'Australia/Sydney'), p_owner_user_id, 'in_progress'
  )
  returning id into v_company;

  insert into public.roles (company_id, code, name, permissions, is_system, rank)
  values
    (v_company, 'owner', 'Owner', '["*"]'::jsonb, true, 1),
    (v_company, 'admin', 'Administrator',
     '["jobs.*","partners.*","technicians.*","customers.*","rates.*","invoices.*","users.*","settings.*","reports.read"]'::jsonb,
     true, 10),
    (v_company, 'scheduler', 'Scheduler',
     '["jobs.read","jobs.write","jobs.publish","technicians.read","technicians.assign","customers.*","rates.read","reports.read"]'::jsonb,
     true, 20),
    (v_company, 'partner_admin', 'Partner Administrator',
     '["jobs.read","jobs.write","jobs.publish","technicians.read","customers.read","rates.read","reports.read"]'::jsonb,
     true, 30),
    (v_company, 'technician', 'Technician',
     '["jobs.read","jobs.self","bookings.read","bookings.complete","rates.self","invoices.self"]'::jsonb,
     true, 40),
    (v_company, 'staff', 'Staff',
     '["jobs.read","customers.read","reports.read"]'::jsonb, true, 50);

  select r.id into v_owner_role
  from public.roles r
  where r.company_id = v_company and r.code = 'owner' and r.deleted_at is null;

  insert into public.users (
    id, company_id, email, member_type, status, accepted_at
  ) values (
    p_owner_user_id, v_company, lower(btrim(p_email)), 'staff', 'active', now()
  );

  insert into public.user_roles (company_id, user_id, role_id, granted_by)
  values (v_company, p_owner_user_id, v_owner_role, p_owner_user_id);

  update public.companies
     set onboarding_status = 'complete', updated_at = now()
   where id = v_company;

  return v_company;
end $$;

comment on function public.create_tenant(text, text, uuid, text, text, text) is
  'Bootstraps a tenant: company row, six system roles, owner membership. Call once per signup.';

revoke all on function public.create_tenant(text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_tenant(text, text, uuid, text, text, text) to service_role;

-- =============================================================================
-- SECTION 4 — NEW USER ONBOARDING
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4.1 handle_new_user()
--     The only sanctioned path that creates a public.users row. Resolves the
--     tenant from a single-use invitation, then seeds the role.
--
--     Anonymous self-signup is refused: without an invitation there is no way
--     to determine which tenant the user belongs to.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user(
  p_user_id          uuid,
  p_invitation_token text default null
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_invite  public.user_invitations%rowtype;
  v_email   text;
  v_role    uuid;
begin
  if exists (select 1 from public.users where id = p_user_id) then
    return p_user_id;                        -- idempotent
  end if;

  if p_invitation_token is null or length(btrim(p_invitation_token)) < 8 then
    raise exception 'invitation_required' using errcode = 'P0001';
  end if;

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

  select email into v_email from auth.users where id = p_user_id;

  insert into public.users (
    id, company_id, partner_id, email, member_type, status, accepted_at, invited_at
  ) values (
    p_user_id, v_invite.company_id, v_invite.partner_id,
    coalesce(v_email, v_invite.email),
    coalesce(v_invite.member_type, 'staff'),
    'active', now(), v_invite.created_at
  );

  v_role := coalesce(v_invite.role_id, app.default_role_for(v_invite.company_id));

  if v_role is not null then
    insert into public.user_roles (company_id, user_id, role_id, granted_by)
    values (v_invite.company_id, p_user_id, v_role, v_invite.invited_by)
    on conflict do nothing;
  end if;

  update public.user_invitations
     set accepted_at = now(),
         accepted_by = p_user_id,
         updated_at  = now()
   where id = v_invite.id;

  return p_user_id;
end $$;

comment on function public.handle_new_user(uuid, text) is
  'Invitation-only signup. Creates the profile row and seeds the role. Idempotent.';

revoke all on function public.handle_new_user(uuid, text) from public, anon, authenticated;
grant execute on function public.handle_new_user(uuid, text) to service_role;

-- =============================================================================
-- SECTION 5 — INVITE USER WORKFLOW
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 5.1 invite_user()
--     Issues an invitation. Requires users.manage in the target tenant.
--     Re-inviting the same address refreshes the existing pending invitation
--     rather than creating a duplicate (enforced by user_invitations_pending_uidx).
-- -----------------------------------------------------------------------------
create or replace function public.invite_user(
  p_email        text,
  p_role_id      uuid      default null,
  p_partner_id   uuid      default null,
  p_member_type  app.member_type default 'staff',
  p_expires_days integer   default 14
)
returns table (
  invitation_id uuid,
  token         text,
  email         text,
  role_id       uuid,
  expires_at    timestamptz,
  is_resend     boolean
)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_email   text := lower(btrim(p_email));
  v_id      uuid;
  v_token   text;
  v_expires timestamptz;
  v_existing public.user_invitations%rowtype;
  v_resend  boolean := false;
begin
  if v_company is null then
    raise exception 'no_tenant_context' using errcode = 'P0001';
  end if;

  if not app.has_permission('users.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.users
    where company_id = v_company and lower(email) = v_email and deleted_at is null
  ) then
    raise exception 'user_already_exists' using errcode = 'P0001';
  end if;

  if p_role_id is not null and not exists (
    select 1 from public.roles
    where id = p_role_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'role_not_in_tenant' using errcode = 'P0001';
  end if;

  if p_partner_id is not null and not exists (
    select 1 from public.partners
    where id = p_partner_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'partner_not_in_tenant' using errcode = 'P0001';
  end if;

  select * into v_existing
  from public.user_invitations
  where company_id = v_company
    and lower(email) = v_email
    and accepted_at is null
    and revoked_at is null
  for update;

  if found then
    v_id      := v_existing.id;
    v_token   := v_existing.token;
    v_expires := now() + make_interval(days => greatest(coalesce(p_expires_days, 14), 1));
    v_resend  := true;

    update public.user_invitations
       set role_id      = coalesce(p_role_id, role_id),
           partner_id   = coalesce(p_partner_id, partner_id),
           member_type  = coalesce(p_member_type, member_type),
           expires_at   = v_expires,
           send_count   = send_count + 1,
           last_sent_at = now(),
           updated_at   = now(),
           updated_by   = auth.uid()
     where id = v_id;
  else
    v_expires := now() + make_interval(days => greatest(coalesce(p_expires_days, 14), 1));

    insert into public.user_invitations (
      company_id, email, role_id, partner_id, member_type,
      invited_by, expires_at, send_count, last_sent_at, created_by
    ) values (
      v_company, v_email, p_role_id, p_partner_id, coalesce(p_member_type, 'staff'),
      auth.uid(), v_expires, 1, now(), auth.uid()
    )
    returning id, token into v_id, v_token;
  end if;

  return query select v_id, v_token, v_email, p_role_id, v_expires, v_resend;
end $$;

comment on function public.invite_user(text, uuid, uuid, app.member_type, integer) is
  'Issues or refreshes a tenant invitation. Requires users.manage. Returns the token for the invite email.';

revoke all on function public.invite_user(text, uuid, uuid, app.member_type, integer) from public, anon;
grant execute on function public.invite_user(text, uuid, uuid, app.member_type, integer) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5.2 revoke_invitation()
-- -----------------------------------------------------------------------------
create or replace function public.revoke_invitation(p_invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_count   integer;
begin
  if not app.has_permission('users.manage') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  update public.user_invitations
     set revoked_at = now(),
         revoked_by = auth.uid(),
         updated_at = now()
   where id = p_invitation_id
     and company_id = v_company
     and accepted_at is null
     and revoked_at is null;

  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

comment on function public.revoke_invitation(uuid) is
  'Revokes a pending invitation in the caller''s tenant.';

revoke all on function public.revoke_invitation(uuid) from public, anon;
grant execute on function public.revoke_invitation(uuid) to authenticated, service_role;

-- =============================================================================
-- SECTION 6 — INVITATION ACCEPTANCE WORKFLOW
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 6.1 invitation_lookup()
--     Anonymous-safe preview of an invitation, for the accept-invite page.
--     Returns no token, no ids beyond what the page needs.
-- -----------------------------------------------------------------------------
create or replace function public.invitation_lookup(p_token text)
returns table (
  email        text,
  company_name text,
  company_slug text,
  role_name    text,
  member_type  app.member_type,
  invited_at   timestamptz,
  expires_at   timestamptz,
  is_valid     boolean,
  reason       text
)
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select
    i.email,
    c.trading_name,
    c.slug,
    r.name,
    i.member_type,
    i.created_at,
    i.expires_at,
    (i.accepted_at is null and i.revoked_at is null and i.expires_at > now()),
    case
      when i.accepted_at is not null then 'already_accepted'
      when i.revoked_at is not null  then 'revoked'
      when i.expires_at <= now()     then 'expired'
      else null
    end
  from public.user_invitations i
  join public.companies c on c.id = i.company_id
  left join public.roles r on r.id = i.role_id
  where i.token = p_token
  limit 1
$$;

comment on function public.invitation_lookup(text) is
  'Public preview of an invitation for the accept page. Exposes no privileged ids.';

revoke all on function public.invitation_lookup(text) from public;
grant execute on function public.invitation_lookup(text) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6.2 accept_invitation()
--     Consumes an invitation for the calling authenticated user. Delegates the
--     profile creation to handle_new_user() so there is exactly one code path
--     that inserts into public.users.
-- -----------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_uid     uuid := auth.uid();
  v_invite  public.user_invitations%rowtype;
  v_auth_em text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into v_invite
  from public.user_invitations
  where token = p_token
    and accepted_at is null
    and revoked_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'invitation_invalid_or_expired' using errcode = 'P0001';
  end if;

  select email into v_auth_em from auth.users where id = v_uid;

  if v_auth_em is null or lower(v_auth_em) <> lower(v_invite.email) then
    raise exception 'invitation_email_mismatch' using errcode = 'P0001';
  end if;

  return public.handle_new_user(v_uid, p_token);
end $$;

comment on function public.accept_invitation(text) is
  'Consumes an invitation for the signed-in user. Verifies the auth email matches the invited address.';

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6.3 complete_onboarding()
--     Marks the tenant onboarding complete once the founding admin has set up
--     company details. Idempotent.
-- -----------------------------------------------------------------------------
create or replace function public.complete_onboarding()
returns boolean
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_count   integer;
begin
  if v_company is null then
    raise exception 'no_tenant_context' using errcode = 'P0001';
  end if;

  update public.companies
     set onboarding_status = 'complete',
         updated_at = now(),
         updated_by = auth.uid()
   where id = v_company
     and onboarding_status <> 'complete';

  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

comment on function public.complete_onboarding() is
  'Marks the caller''s tenant onboarding complete.';

revoke all on function public.complete_onboarding() from public, anon;
grant execute on function public.complete_onboarding() to authenticated, service_role;

-- =============================================================================
-- SECTION 7 — GRANTS
-- Internal helpers are SECURITY DEFINER and read tenant data. None may be
-- anon-reachable over PostgREST.
-- =============================================================================
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'app.current_company_id()',
    'app.is_platform_admin()',
    'app.current_partner_id()',
    'app.current_member_type()',
    'app.user_company_id(uuid)',
    'app.is_company_member(uuid)',
    'app.has_permission(text)',
    'app.has_role(text[])',
    'app.has_permission_in(uuid, text)',
    'app.user_permissions(uuid)',
    'app.can_access_company(uuid)',
    'app.partner_scope_ok(uuid)',
    'app.tg_sync_auth_user()',
    'app.tg_block_user_hard_delete()',
    'app.expire_stale_invitations()',
    'app.default_role_for(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
    execute format('grant  execute on function %s to service_role', v_sig);
  end loop;
end $$;

-- =============================================================================
-- SECTION 8 — VERIFICATION
-- =============================================================================
do $$
declare
  v_missing text[] := array[]::text[];
  v_fn text;
  v_trigger text;
begin
  foreach v_fn in array array[
    'current_company_id','is_platform_admin','current_partner_id','current_member_type',
    'user_company_id','is_company_member','has_permission','has_role',
    'has_permission_in','user_permissions','can_access_company','partner_scope_ok',
    'tg_sync_auth_user','tg_block_user_hard_delete','expire_stale_invitations','default_role_for'
  ] loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = v_fn
    ) then
      v_missing := v_missing || ('app.' || v_fn);
    end if;
  end loop;

  foreach v_fn in array array[
    'create_tenant','handle_new_user','invite_user','revoke_invitation',
    'invitation_lookup','accept_invitation','complete_onboarding'
  ] loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
    ) then
      v_missing := v_missing || ('public.' || v_fn);
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'phase 3 incomplete - unresolved functions: %',
      array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_auth_users_sync'
  ) then
    raise exception 'phase 3 incomplete - trigger trg_auth_users_sync missing'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_users_block_delete'
  ) then
    raise exception 'phase 3 incomplete - trigger trg_users_block_delete missing'
      using errcode = 'P0001';
  end if;

  raise notice 'phase 3 complete: 23 auth objects, 15 helpers, 7 rpc functions, 2 triggers';
end $$;

commit;

-- =============================================================================
-- END phase3_auth.sql
-- =============================================================================
