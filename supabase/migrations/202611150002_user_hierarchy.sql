-- Requires the existing application schema and Phase 1 security migration.
-- AUTHENTICATED user administration only. Never replay the master schema.
-- Review deployed booking/portal contracts and rehearse in staging first.
begin;

do $$ begin
  if not exists(select 1 from pg_trigger
    where tgrelid='public.users'::regclass and tgname='trg_users_protect_platform_admin'
      and tgenabled<>'D'
      and tgfoid=to_regprocedure('app.tg_protect_platform_admin()')) then
    raise exception 'Phase 1 platform-admin protection must be installed first';
  end if;
  if current_user not in ('postgres','supabase_admin','service_role') then
    raise exception 'use a reviewed trusted migration principal';
  end if;
end $$;

create or replace function app.hierarchy_role_for(p_user uuid)
returns text language sql stable security definer
set search_path = pg_catalog
as $$
  select case
    when u.is_platform_admin then 'ultra_admin'
    when bool_or(r.code = 'technician')
      and bool_or(r.code in ('owner','admin','company_admin')) then 'conflict'
    when bool_or(r.code = 'owner') then 'owner'
    when bool_or(r.code in ('admin','company_admin')) then 'admin'
    when bool_or(r.code = 'technician') then 'technician'
    else 'legacy' end
  from public.users u
  join public.companies c on c.id=u.company_id and c.is_active and c.deleted_at is null
  left join public.user_roles ur on ur.user_id=u.id and ur.company_id=u.company_id
    and ur.deleted_at is null and (ur.expires_at is null or ur.expires_at>now())
  left join public.roles r on r.id=ur.role_id and r.deleted_at is null
    and (r.company_id=u.company_id or r.company_id is null)
  where u.id=p_user and u.status::text='active' and u.deleted_at is null
  group by u.id,u.is_platform_admin
$$;

create or replace function app.hierarchy_role()
returns text language sql stable security definer
set search_path = pg_catalog as $$
  select app.hierarchy_role_for(auth.uid())
$$;

create or replace function app.hierarchy_can_delegate(
  p_actor uuid, p_company uuid, p_code text, p_target uuid default null)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog as $$
declare
  actor_role text := app.hierarchy_role_for(p_actor);
  target_role text;
begin
  if actor_role is null or p_code is null
     or p_code not in ('owner','admin','company_admin','technician')
     or p_target=p_actor then return false; end if;
  if not exists(select 1 from public.companies
    where id=p_company and is_active and deleted_at is null) then return false; end if;
  if actor_role <> 'ultra_admin' and not exists(
    select 1 from public.users where id=p_actor and company_id=p_company
  ) then return false; end if;
  if p_target is not null then
    select case when u.is_platform_admin then 'ultra_admin'
      else coalesce(app.hierarchy_role_for(u.id),
        (select case when bool_or(r.code='owner') then 'owner'
          when bool_or(r.code in ('admin','company_admin')) then 'admin'
          when bool_or(r.code='technician') then 'technician' else 'legacy' end
         from public.user_roles ur join public.roles r on r.id=ur.role_id
         where ur.user_id=u.id and ur.company_id=u.company_id
           and ur.deleted_at is null and r.deleted_at is null
           and (r.company_id=u.company_id or r.company_id is null)
           and (ur.expires_at is null or ur.expires_at>now())))
      end into target_role from public.users u
      where u.id=p_target and u.company_id=p_company and u.deleted_at is null;
    if target_role is null or target_role in ('ultra_admin','conflict','legacy')
      then return false; end if;
    if actor_role='owner' and target_role not in ('admin','technician')
      then return false; end if;
    if actor_role='admin' and target_role<>'technician'
      then return false; end if;
  end if;
  return actor_role='ultra_admin'
    or (actor_role='owner' and p_code in ('admin','company_admin','technician'))
    or (actor_role='admin' and p_code='technician');
end $$;

create or replace function app.hierarchy_operator(p_company uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog as $$
  select coalesce(app.hierarchy_role()='ultra_admin' or
    (app.hierarchy_role() in ('owner','admin') and exists(
      select 1 from public.users where id=auth.uid() and company_id=p_company)),false)
$$;

create or replace function app.hierarchy_job_visible(p_job uuid,p_company uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog as $$
  select app.hierarchy_operator(p_company) or
    (app.hierarchy_role()='technician'
     and (select count(*) from public.technicians where user_id=auth.uid() and deleted_at is null)=1
     and exists(
      select 1 from public.users u
      join public.technicians t on t.user_id=u.id and t.company_id=u.company_id
        and t.deleted_at is null
      join public.job_technicians jt on jt.technician_id=t.id and jt.company_id=t.company_id
        and jt.deleted_at is null
      join public.jobs j on j.id=jt.job_id and j.company_id=jt.company_id
        and j.deleted_at is null
      where u.id=auth.uid() and u.company_id=p_company and j.id=p_job))
$$;

-- Only safe profile fields remain directly editable by a browser session.
revoke insert,update,delete on public.users from public,anon,authenticated;
grant update(full_name,first_name,last_name,phone,avatar_url,timezone,locale,notification_prefs)
  on public.users to authenticated;
revoke insert,update,delete on public.roles,public.user_roles,public.user_invitations
  from public,anon,authenticated;

-- Security-invoker trigger: definer RPCs are not exempt from delegation rules.
create or replace function app.hierarchy_guard()
returns trigger language plpgsql set search_path=pg_catalog as $$
declare
  item jsonb := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  previous jsonb := case when tg_op='INSERT' then null else to_jsonb(old) end;
  company uuid := (item->>'company_id')::uuid;
  target uuid;
  code text;
  invitation_ok boolean := false;
begin
  if auth.uid() is null and coalesce(auth.role(),'') not in ('anon','authenticated')
     and current_user in ('postgres','supabase_admin','service_role') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if current_user not in ('postgres','supabase_admin','service_role') then
    raise exception 'use controlled user administration' using errcode='42501';
  end if;
  if previous is not null and previous->'company_id' is distinct from item->'company_id' then
    raise exception 'company membership is immutable' using errcode='42501';
  end if;
  if tg_table_name='user_roles' then
    target := (item->>'user_id')::uuid;
    select r.code into code from public.roles r
      where r.id=(item->>'role_id')::uuid and r.company_id=company and r.deleted_at is null;
    if previous is not null and previous->'user_id' is distinct from item->'user_id' then
      raise exception 'role subject is immutable' using errcode='42501';
    end if;
    if target=auth.uid() and tg_op='INSERT' then
      select exists(
        select 1 from public.user_invitations i join auth.users a on a.id=target
        where i.company_id=company and i.role_id=(item->>'role_id')::uuid
          and lower(i.email)=lower(a.email) and a.email_confirmed_at is not null
          and i.accepted_at is null and i.revoked_at is null and i.expires_at>now()
          and app.hierarchy_can_delegate(i.invited_by,company,code)
      ) into invitation_ok;
    end if;
    if not invitation_ok and not app.hierarchy_can_delegate(auth.uid(),company,code,target) then
      raise exception 'role delegation forbidden' using errcode='42501';
    end if;
    if previous is not null and previous->'role_id' is distinct from item->'role_id'
       and not app.hierarchy_can_delegate(auth.uid(),company,
         (select r.code from public.roles r where r.id=(previous->>'role_id')::uuid),target) then
      raise exception 'previous role is protected' using errcode='42501';
    end if;
  elsif tg_table_name='user_invitations' then
    select r.code into code from public.roles r where r.id=(item->>'role_id')::uuid
      and r.company_id=company and r.deleted_at is null;
    -- An invitee may only consume their own still-valid invitation. They may
    -- not rewrite its role, company, issuer, recipient, expiry or token.
    if tg_op='UPDATE' and (item->>'accepted_by')::uuid=auth.uid()
       and previous->>'accepted_at' is null and item->>'accepted_at' is not null
       and (previous-array['accepted_at','accepted_by','updated_at'])=
           (item-array['accepted_at','accepted_by','updated_at'])
       and exists(select 1 from auth.users a where a.id=auth.uid()
         and a.email_confirmed_at is not null and lower(a.email)=lower(item->>'email'))
       and (item->>'expires_at')::timestamptz>now() and item->>'revoked_at' is null
       and app.hierarchy_can_delegate((item->>'invited_by')::uuid,company,code) then
      return new;
    end if;
    if not app.hierarchy_can_delegate(auth.uid(),company,code)
       or (previous is not null and not app.hierarchy_can_delegate(auth.uid(),company,
         (select r.code from public.roles r where r.id=(previous->>'role_id')::uuid))) then
      raise exception 'invitation delegation forbidden' using errcode='42501';
    end if;
  else
    raise exception 'unsupported administration surface' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;

drop trigger if exists hierarchy_role_guard on public.user_roles;
create trigger hierarchy_role_guard before insert or update or delete on public.user_roles
  for each row execute function app.hierarchy_guard();
drop trigger if exists hierarchy_invite_guard on public.user_invitations;
create trigger hierarchy_invite_guard before insert or update or delete on public.user_invitations
  for each row execute function app.hierarchy_guard();

create or replace function app.hierarchy_profile_guard()
returns trigger language plpgsql set search_path=pg_catalog as $$
declare
  changed boolean;
  target_code text;
begin
  if auth.uid() is null and coalesce(auth.role(),'') not in ('anon','authenticated')
    and current_user in ('postgres','supabase_admin','service_role') then return new; end if;
  if tg_op='INSERT' then
    if current_user not in ('postgres','supabase_admin','service_role') or new.id<>auth.uid()
      or not exists(
        select 1 from public.user_invitations i
        join public.roles r on r.id=i.role_id and r.company_id=i.company_id
        join auth.users a on a.id=new.id and lower(a.email)=lower(i.email)
        where i.company_id=new.company_id and i.accepted_at is null
          and i.revoked_at is null and i.expires_at>now() and a.email_confirmed_at is not null
          and app.hierarchy_can_delegate(i.invited_by,i.company_id,r.code)
      ) then raise exception 'profile requires an authorized invitation' using errcode='42501'; end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
    or new.member_type is distinct from old.member_type or new.partner_id is distinct from old.partner_id then
    raise exception 'membership fields are protected' using errcode='42501'; end if;
  changed := new.status is distinct from old.status or new.deleted_at is distinct from old.deleted_at;
  if changed then
    select case when bool_or(r.code='owner') then 'owner'
      when bool_or(r.code in ('admin','company_admin')) then 'admin'
      when bool_or(r.code='technician') then 'technician' else 'legacy' end into target_code
      from public.user_roles ur join public.roles r on r.id=ur.role_id
      where ur.user_id=old.id and ur.deleted_at is null and r.deleted_at is null
        and (ur.expires_at is null or ur.expires_at>now());
    if current_user not in ('postgres','supabase_admin','service_role')
      or not app.hierarchy_can_delegate(auth.uid(),old.company_id,target_code,old.id) then
      raise exception 'status delegation forbidden' using errcode='42501'; end if;
  end if;
  return new;
end $$;
drop trigger if exists hierarchy_profile_guard on public.users;
create trigger hierarchy_profile_guard before insert or update on public.users
  for each row execute function app.hierarchy_profile_guard();

create or replace function app.hierarchy_role_definition_guard()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if current_user not in ('postgres','supabase_admin','service_role') or
    (auth.uid() is not null and app.hierarchy_role() is distinct from 'ultra_admin') or
    (auth.uid() is null and coalesce(auth.role(),'') in ('anon','authenticated')) then
    raise exception 'role definitions require trusted platform configuration' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists hierarchy_role_definition_guard on public.roles;
create trigger hierarchy_role_definition_guard before insert or update or delete on public.roles
  for each row execute function app.hierarchy_role_definition_guard();

create or replace function app.hierarchy_seed_roles(p_company uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare
  admin_permissions jsonb;
begin
  -- Preserve legacy Admin operational permissions, including custom families.
  select coalesce(jsonb_agg(distinct x.value),'[]'::jsonb) into admin_permissions
  from (
    select e.value from public.roles r cross join lateral jsonb_array_elements(r.permissions) e
    where r.company_id=p_company and r.code in ('admin','company_admin') and r.deleted_at is null
    union all
    select value from jsonb_array_elements(
      '["jobs.read","jobs.write","jobs.publish","bookings.read","bookings.write",
        "technicians.read","technicians.write","technicians.assign",
        "customers.read","customers.write","subcontractors.manage"]'::jsonb)
  ) x;
  insert into public.roles(company_id,code,name,permissions,is_system,rank)
    select p_company,'owner','Super Admin','["*"]'::jsonb,true,1
    where not exists(select 1 from public.roles where company_id=p_company and code='owner' and deleted_at is null);
  insert into public.roles(company_id,code,name,permissions,is_system,rank)
    select p_company,'admin','Admin',admin_permissions,true,10
    where not exists(select 1 from public.roles where company_id=p_company and code='admin' and deleted_at is null);
  insert into public.roles(company_id,code,name,permissions,is_system,rank)
    select p_company,'technician','Subcontractor',
      '["jobs.read","jobs.self","bookings.read","bookings.complete"]'::jsonb,true,40
    where not exists(select 1 from public.roles where company_id=p_company and code='technician' and deleted_at is null);
  update public.roles set name=case code when 'owner' then 'Super Admin'
    when 'technician' then 'Subcontractor' else 'Admin' end,
    permissions=case when code in ('admin','company_admin') then admin_permissions else permissions end
    where company_id=p_company and code in ('owner','admin','company_admin','technician') and deleted_at is null;
end $$;

do $$ declare c record; begin
  for c in select id from public.companies where deleted_at is null loop
    perform app.hierarchy_seed_roles(c.id);
  end loop;
end $$;

create or replace function public.hierarchy_create_company(p_legal_name text,p_slug text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare company uuid;
begin
  if app.hierarchy_role() is distinct from 'ultra_admin' then
    raise exception 'Ultra Admin required' using errcode='42501'; end if;
  insert into public.companies(legal_name,slug,created_by)
    values(btrim(p_legal_name),lower(btrim(p_slug)),auth.uid()) returning id into company;
  perform app.hierarchy_seed_roles(company);
  return company;
end $$;

create or replace function public.hierarchy_invite(
  p_company_id uuid,p_email text,p_role_code text)
returns table(invitation_id uuid,token text,email text,expires_at timestamptz)
language plpgsql security definer set search_path=pg_catalog as $$
declare
  selected_role uuid;
  invite public.user_invitations%rowtype;
  member app.member_type;
begin
  if not app.hierarchy_can_delegate(auth.uid(),p_company_id,p_role_code) then
    raise exception 'invitation delegation forbidden' using errcode='42501'; end if;
  if p_email is null or btrim(p_email)!~*'^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email' using errcode='22023'; end if;
  perform 1 from public.companies where id=p_company_id for update;
  if exists(select 1 from public.users u where lower(u.email)=lower(btrim(p_email)) and u.deleted_at is null) then
    raise exception 'account already has a company; manage the existing account' using errcode='22023'; end if;
  select id into selected_role from public.roles
    where company_id=p_company_id and code=p_role_code and deleted_at is null;
  if selected_role is null then raise exception 'role unavailable' using errcode='22023'; end if;
  -- Reuse an existing enum label; no enum expansion or schema redesign.
  select e into member from unnest(enum_range(null::app.member_type)) e
    where e::text=case when p_role_code='technician' then 'technician' else 'staff' end;
  if member is null then raise exception 'unsupported member enum: inspect deployed schema'; end if;
  select * into invite from public.user_invitations
    where company_id=p_company_id and lower(user_invitations.email)=lower(btrim(p_email))
      and accepted_at is null and revoked_at is null for update;
  if found then
    update public.user_invitations set role_id=selected_role,member_type=member,
      invited_by=auth.uid(),expires_at=now()+interval '14 days',
      send_count=send_count+1,last_sent_at=now(),updated_at=now(),updated_by=auth.uid()
      where id=invite.id returning * into invite;
  else
    insert into public.user_invitations(company_id,email,role_id,member_type,invited_by,
      expires_at,send_count,last_sent_at,created_by)
    values(p_company_id,lower(btrim(p_email)),selected_role,member,auth.uid(),
      now()+interval '14 days',1,now(),auth.uid()) returning * into invite;
  end if;
  return query select invite.id,invite.token,invite.email,invite.expires_at;
end $$;

-- Replace only the secured delivery authorization query; retain the Edge email
-- handler and stored-recipient behavior introduced in the Critical patch.
create or replace function public.invitation_for_delivery(p_token text)
returns table(invitation_id uuid,email text,token text,role_code text,company_name text,expires_at timestamptz)
language sql stable security definer set search_path=pg_catalog as $$
  select i.id,i.email,i.token,r.code,c.legal_name,i.expires_at
  from public.user_invitations i
  join public.roles r on r.id=i.role_id and r.company_id=i.company_id and r.deleted_at is null
  join public.companies c on c.id=i.company_id and c.is_active and c.deleted_at is null
  where i.token=p_token and i.accepted_at is null and i.revoked_at is null and i.expires_at>now()
    and app.hierarchy_can_delegate(auth.uid(),i.company_id,r.code)
    and app.hierarchy_can_delegate(i.invited_by,i.company_id,r.code)
$$;

create or replace function public.hierarchy_set_user(
  p_user_id uuid,p_role_code text default null,p_status text default null)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare
  subject public.users%rowtype;
  target_kind text;
  assignment_id uuid;
  selected_role uuid;
begin
  select * into subject from public.users where id=p_user_id and deleted_at is null for update;
  target_kind:=app.hierarchy_role_for(p_user_id);
  if target_kind is null then
    select case when bool_or(r.code='owner') then 'owner'
      when bool_or(r.code in ('admin','company_admin')) then 'admin'
      when bool_or(r.code='technician') then 'technician' else 'legacy' end
      into target_kind from public.user_roles ur join public.roles r on r.id=ur.role_id
      where ur.user_id=p_user_id and ur.deleted_at is null and r.deleted_at is null
        and (ur.expires_at is null or ur.expires_at>now()) and ur.company_id=subject.company_id;
  end if;
  if subject.id is null or not app.hierarchy_can_delegate(auth.uid(),subject.company_id,
    coalesce(p_role_code,target_kind),p_user_id) then
    raise exception 'user delegation forbidden' using errcode='42501'; end if;
  if p_status is not null and p_status not in ('active','disabled','suspended') then
    raise exception 'unsupported status' using errcode='22023'; end if;
  if p_role_code is not null then
    if (select count(*) from public.user_roles ur join public.roles r on r.id=ur.role_id
      where ur.user_id=p_user_id and ur.deleted_at is null and r.deleted_at is null
        and (ur.expires_at is null or ur.expires_at>now()))<>1 then
      raise exception 'mixed/legacy assignments require explicit review' using errcode='22023'; end if;
    select ur.id into assignment_id from public.user_roles ur where ur.user_id=p_user_id
      and ur.deleted_at is null and (ur.expires_at is null or ur.expires_at>now()) for update;
    select id into selected_role from public.roles where company_id=subject.company_id
      and code=p_role_code and deleted_at is null;
    if selected_role is null then raise exception 'role unavailable' using errcode='22023'; end if;
    update public.user_roles set role_id=selected_role,granted_by=auth.uid(),updated_at=now()
      where id=assignment_id;
  end if;
  if p_status is not null then
    update public.users set status=p_status::app.user_status,updated_at=now(),updated_by=auth.uid()
      where id=p_user_id;
  end if;
end $$;

-- Invitation acceptance retains the current URL/Auth flow, but cannot silently
-- move an existing account or lose allocations by replacing a technician ID.
create or replace function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare
  invite public.user_invitations%rowtype;
  identity auth.users%rowtype;
  profile public.users%rowtype;
  code text;
  matches integer;
  tech uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  select * into identity from auth.users where id=auth.uid();
  select * into invite from public.user_invitations where token=p_token for update;
  select r.code into code from public.roles r where r.id=invite.role_id
    and r.company_id=invite.company_id and r.deleted_at is null;
  if invite.id is null or invite.revoked_at is not null or invite.expires_at<=now()
    or identity.email_confirmed_at is null or lower(identity.email) is distinct from lower(invite.email)
    or not app.hierarchy_can_delegate(invite.invited_by,invite.company_id,code) then
    raise exception 'invalid or unauthorized invitation' using errcode='42501'; end if;
  select * into profile from public.users where id=auth.uid() for update;
  if profile.id is not null and (profile.company_id<>invite.company_id
     or profile.deleted_at is not null or profile.status::text<>'active' or profile.is_platform_admin) then
    raise exception 'existing account cannot be moved or reactivated by invitation' using errcode='42501'; end if;
  if invite.accepted_at is not null then
    if invite.accepted_by=auth.uid() and profile.id is not null then return auth.uid(); end if;
    raise exception 'invitation already accepted' using errcode='42501';
  end if;
  -- Serialize same-company email linkage without altering allocation rows.
  perform 1 from public.companies where id=invite.company_id for update;
  if profile.id is null then
    insert into public.users(id,company_id,email,full_name,member_type,status,accepted_at,invited_at)
      values(identity.id,invite.company_id,identity.email,
        coalesce(nullif(identity.raw_user_meta_data->>'full_name',''),split_part(identity.email,'@',1)),
        invite.member_type,'active',now(),invite.created_at);
  end if;
  if exists(select 1 from public.user_roles ur where ur.user_id=auth.uid() and ur.deleted_at is null
    and (ur.expires_at is null or ur.expires_at>now()) and ur.role_id<>invite.role_id) then
    raise exception 'existing role conflict' using errcode='42501'; end if;
  insert into public.user_roles(company_id,user_id,role_id,granted_by)
    select invite.company_id,auth.uid(),invite.role_id,invite.invited_by
    where not exists(select 1 from public.user_roles where user_id=auth.uid()
      and role_id=invite.role_id and deleted_at is null);
  if code='technician' then
    perform 1 from public.technicians where company_id=invite.company_id
      and deleted_at is null and (user_id=auth.uid() or lower(email)=lower(invite.email)) for update;
    select count(*),min(id::text)::uuid into matches,tech from public.technicians
      where company_id=invite.company_id and deleted_at is null
        and (user_id=auth.uid() or lower(email)=lower(invite.email));
    if matches>1 or exists(select 1 from public.technicians where id=tech
      and user_id is not null and user_id<>auth.uid()) then
      raise exception 'ambiguous technician linkage; administrator review required' using errcode='22023'; end if;
    if tech is null then
      insert into public.technicians(company_id,user_id,code,full_name,email,employment_type)
        values(invite.company_id,auth.uid(),replace(auth.uid()::text,'-',''),
          coalesce(nullif(identity.raw_user_meta_data->>'full_name',''),split_part(identity.email,'@',1)),
          identity.email,'subcontractor');
    else
      update public.technicians set user_id=auth.uid(),updated_at=now() where id=tech;
    end if;
  end if;
  update public.user_invitations set accepted_at=now(),accepted_by=auth.uid(),updated_at=now()
    where id=invite.id;
  return auth.uid();
end $$;

create or replace function public.hierarchy_snapshot(p_company_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  kind text:=app.hierarchy_role();
  selected uuid;
  companies jsonb;
  members jsonb;
begin
  if kind is null or kind not in ('ultra_admin','owner','admin') then
    raise exception 'user management unavailable' using errcode='42501'; end if;
  select coalesce(p_company_id,company_id) into selected from public.users where id=auth.uid();
  if not app.hierarchy_operator(selected) then
    raise exception 'company access denied' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'legal_name',legal_name) order by legal_name),'[]')
    into companies from public.companies where deleted_at is null and is_active
      and (kind='ultra_admin' or id=selected);
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',u.id,'full_name',u.full_name,'email',u.email,'status',u.status,
      'role_code',coalesce(app.hierarchy_role_for(u.id),(
        select case when bool_or(r.code='owner') then 'owner'
          when bool_or(r.code in ('admin','company_admin')) then 'admin'
          when bool_or(r.code='technician') then 'technician' else 'legacy' end
        from public.user_roles ur join public.roles r on r.id=ur.role_id
        where ur.user_id=u.id and ur.deleted_at is null and r.deleted_at is null
          and (ur.expires_at is null or ur.expires_at>now()))),
      'can_manage',app.hierarchy_can_delegate(auth.uid(),selected,'technician',u.id))
      order by u.full_name),'[]') into members
    from public.users u where u.company_id=selected and u.deleted_at is null
      and (kind<>'admin' or u.id=auth.uid() or
        app.hierarchy_can_delegate(auth.uid(),selected,'technician',u.id));
  return jsonb_build_object('actor_role',kind,'company_id',selected,'companies',companies,'users',members);
end $$;

-- Add restrictive AUTHENTICATED policies only: existing permissive operator
-- permissions, public booking RPCs, allocation writes and workflows remain.
do $$ declare t text; key text; begin
  foreach t in array array['jobs','job_slots','customer_bookings','job_technicians'] loop
    key:=case when t='jobs' then 'id' else 'job_id' end;
    execute format('drop policy if exists hierarchy_allocated_read on public.%I',t);
    execute format('create policy hierarchy_allocated_read on public.%I as restrictive for select to authenticated using(app.hierarchy_job_visible(%I,company_id))',t,key);
    execute format('drop policy if exists hierarchy_operator_insert on public.%I',t);
    execute format('create policy hierarchy_operator_insert on public.%I as restrictive for insert to authenticated with check(app.hierarchy_operator(company_id))',t);
    execute format('drop policy if exists hierarchy_operator_delete on public.%I',t);
    execute format('create policy hierarchy_operator_delete on public.%I as restrictive for delete to authenticated using(app.hierarchy_operator(company_id))',t);
    execute format('drop policy if exists hierarchy_scoped_update on public.%I',t);
    if t='customer_bookings' then
      execute format('create policy hierarchy_scoped_update on public.%I as restrictive for update to authenticated using(app.hierarchy_job_visible(job_id,company_id)) with check(app.hierarchy_job_visible(job_id,company_id))',t);
    else
      execute format('create policy hierarchy_scoped_update on public.%I as restrictive for update to authenticated using(app.hierarchy_operator(company_id)) with check(app.hierarchy_operator(company_id))',t);
    end if;
  end loop;
end $$;

drop policy if exists hierarchy_user_read on public.users;
create policy hierarchy_user_read on public.users as restrictive for select to authenticated
  using(id=auth.uid() or app.hierarchy_operator(company_id));
drop policy if exists hierarchy_technician_read on public.technicians;
create policy hierarchy_technician_read on public.technicians as restrictive for select to authenticated
  using(user_id=auth.uid() or app.hierarchy_operator(company_id));

create or replace function app.hierarchy_allocation_guard()
returns trigger language plpgsql set search_path=pg_catalog as $$
declare company uuid;
begin
  company:=case when tg_op='DELETE' then old.company_id else new.company_id end;
  if auth.role()='authenticated' and
    (not app.hierarchy_operator(company)
      or not app.has_permission('technicians.assign')
      or (tg_op='UPDATE' and not app.hierarchy_operator(old.company_id))) then
    raise exception 'operator allocation authority required' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists hierarchy_allocation_guard on public.job_technicians;
create trigger hierarchy_allocation_guard before insert or update or delete on public.job_technicians
  for each row execute function app.hierarchy_allocation_guard();

-- Preserve opaque deployed read-RPC bodies while adding a mandatory outer
-- allocation boundary. Exact original return shapes are obtained from catalog.
-- No public booking/slot-generation/allocation function is renamed or changed.
do $$
declare name text; signature text; routine oid; result_type text; args text; body text;
begin
  foreach name in array array['technician_portal_jobs','technician_portal_bookings'] loop
    signature:=case when name='technician_portal_jobs' then '()' else '(uuid)' end;
    routine:=to_regprocedure('public.'||name||signature);
    if routine is null then
      raise exception 'missing deployed portal contract: % %; inspect production before migration',name,signature;
    end if;
    result_type:=pg_get_function_result(routine);
    args:=pg_get_function_arguments(routine);
    if result_type not like 'TABLE(%' then
      raise exception 'unsupported portal return shape for %; inspect before migration',name;
    end if;
    if name='technician_portal_bookings' and
      (select proargnames[1] from pg_proc where oid=routine) is distinct from 'p_job_id' then
      raise exception 'unexpected portal argument name for %; inspect before migration',name;
    end if;
    if not coalesce((select
      (case when name='technician_portal_jobs' then 'job_id' else 'booking_id' end)=any(proargnames)
      from pg_proc where oid=routine),false) then
      raise exception 'missing required portal identity field for %; inspect before migration',name;
    end if;
    if to_regprocedure('app.hierarchy_original_'||name||signature) is null then
      execute format('alter function public.%I%s set schema app',name,signature);
      execute format('alter function app.%I%s rename to %I',name,signature,'hierarchy_original_'||name);
    else
      raise exception 'hierarchy portal wrappers already installed; do not replay migration';
    end if;
    execute format('revoke all on function app.%I%s from public,anon,authenticated','hierarchy_original_'||name,signature);
    if name='technician_portal_jobs' then
      body:='begin if app.hierarchy_role() is distinct from ''technician'' then raise exception ''Subcontractor role required'' using errcode=''42501''; end if; return query select r.* from app.hierarchy_original_technician_portal_jobs() r where app.hierarchy_job_visible((to_jsonb(r)->>''job_id'')::uuid,(select company_id from public.users where id=auth.uid())); end';
    else
      body:='begin if app.hierarchy_role() is distinct from ''technician'' or not app.hierarchy_job_visible(p_job_id,(select company_id from public.users where id=auth.uid())) then raise exception ''job allocation required'' using errcode=''42501''; end if; return query select r.* from app.hierarchy_original_technician_portal_bookings(p_job_id) r where exists(select 1 from public.customer_bookings b where b.id=(to_jsonb(r)->>''booking_id'')::uuid and b.job_id=p_job_id and app.hierarchy_job_visible(b.job_id,b.company_id)); end';
    end if;
    execute format('create function public.%I(%s) returns %s language plpgsql security definer set search_path=pg_catalog as %L',name,args,result_type,body);
    execute format('revoke all on function public.%I%s from public,anon',name,signature);
    execute format('grant execute on function public.%I%s to authenticated',name,signature);
  end loop;
end $$;

-- Internal functions are not APIs. Grant only predicates used by RLS, and
-- explicitly expose the new authenticated user-management surface.
revoke all on function app.hierarchy_role_for(uuid),
  app.hierarchy_can_delegate(uuid,uuid,text,uuid),app.hierarchy_seed_roles(uuid),
  app.hierarchy_guard(),app.hierarchy_profile_guard(),app.hierarchy_role_definition_guard()
  from public,anon,authenticated;
-- This invoker trigger only uses granted, caller-scoped predicates.
revoke all on function app.hierarchy_allocation_guard() from public,anon,authenticated;
revoke all on function app.hierarchy_role(),app.hierarchy_operator(uuid),
  app.hierarchy_job_visible(uuid,uuid) from public,anon;
grant execute on function app.hierarchy_role(),app.hierarchy_operator(uuid),
  app.hierarchy_job_visible(uuid,uuid) to authenticated;
revoke all on function public.hierarchy_create_company(text,text),
  public.hierarchy_invite(uuid,text,text),public.hierarchy_set_user(uuid,text,text),
  public.hierarchy_snapshot(uuid) from public,anon;
grant execute on function public.hierarchy_create_company(text,text),
  public.hierarchy_invite(uuid,text,text),public.hierarchy_set_user(uuid,text,text),
  public.hierarchy_snapshot(uuid) to authenticated;
revoke all on function public.accept_invitation(text) from public,anon;
grant execute on function public.accept_invitation(text) to authenticated;
revoke all on function public.invitation_for_delivery(text) from public,anon,service_role;
grant execute on function public.invitation_for_delivery(text) to authenticated;

commit;
