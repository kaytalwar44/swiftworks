-- Phase 1 only: invitation authorization and platform-admin column protection.
-- Review against production metadata before deployment. Do not run master SQL.
begin;

do $$
declare
  columns_sql text;
begin
  select string_agg(format('%I', attname), ', ' order by attnum)
    into columns_sql
    from pg_attribute
    where attrelid = 'public.users'::regclass
      and attnum > 0 and not attisdropped
      and attname <> 'is_platform_admin'
      and has_column_privilege(
        'authenticated', 'public.users', attname, 'UPDATE');

  revoke update on public.users from public, anon, authenticated;
  revoke update (is_platform_admin) on public.users
    from public, anon, authenticated;

  if columns_sql is not null then
    execute format(
      'grant update (%s) on public.users to authenticated', columns_sql);
  end if;
end $$;

create or replace function app.tg_protect_platform_admin()
returns trigger language plpgsql
set search_path = pg_catalog
as $$
begin
  if (tg_op = 'INSERT' and new.is_platform_admin)
     or (tg_op = 'UPDATE'
         and new.is_platform_admin is distinct from old.is_platform_admin) then
    if current_user not in ('postgres', 'supabase_admin', 'service_role')
       or coalesce(auth.role(), '') in ('anon', 'authenticated') then
      raise exception 'platform administrator changes require trusted server execution'
        using errcode = '42501';
    end if;
  end if;
  return null;
end $$;

revoke all on function app.tg_protect_platform_admin()
  from public, anon, authenticated;

drop trigger if exists trg_users_protect_platform_admin on public.users;
create trigger trg_users_protect_platform_admin
  after insert or update on public.users
  for each row execute function app.tg_protect_platform_admin();

drop policy if exists users_no_platform_admin_insert on public.users;
create policy users_no_platform_admin_insert on public.users
  as restrictive for insert to authenticated
  with check (not is_platform_admin);

create or replace function public.invitation_for_delivery(p_token text)
returns table (
  invitation_id uuid, email text, token text,
  role_code text, company_name text, expires_at timestamptz
)
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  caller public.users%rowtype;
begin
  select u.* into caller from public.users u
    where u.id = auth.uid() and u.deleted_at is null
      and u.status::text = 'active';

  if not found or caller.company_id is null then
    raise exception 'invitation delivery forbidden' using errcode = '42501';
  end if;

  if not caller.is_platform_admin and not exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = caller.id
      and ur.company_id = caller.company_id
      and ur.deleted_at is null and r.deleted_at is null
      and (r.company_id = caller.company_id or r.company_id is null)
      and (ur.expires_at is null or ur.expires_at > now())
      and (r.permissions ? '*'
        or r.permissions ? 'users.*'
        or r.permissions ? 'users.manage')
  ) then
    raise exception 'invitation delivery forbidden' using errcode = '42501';
  end if;

  return query
    select i.id, i.email, i.token, coalesce(r.code, 'staff'),
           c.legal_name, i.expires_at
    from public.user_invitations i
    join public.companies c on c.id = i.company_id
    left join public.roles r on r.id = i.role_id and r.deleted_at is null
    where i.token = p_token and i.company_id = caller.company_id
      and i.accepted_at is null and i.revoked_at is null
      and i.expires_at > now() and c.is_active
      and (i.role_id is null or
        (r.id is not null and
          (r.company_id = caller.company_id or r.company_id is null)));
end $$;

revoke all on function public.invitation_for_delivery(text)
  from public, anon, service_role;
grant execute on function public.invitation_for_delivery(text)
  to authenticated;

commit;
