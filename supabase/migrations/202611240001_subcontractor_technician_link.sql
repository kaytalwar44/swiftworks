-- Additive linkage fix. Apply before deploying the updated assignment picker.
-- No role grants, RLS policies, booking RPCs or existing allocation rows change.
begin;

do $$ begin
  if current_user not in ('postgres','supabase_admin') then
    raise exception 'use a trusted migration principal' using errcode='42501';
  end if;
  if to_regprocedure('app.hierarchy_role_for(uuid)') is null
     or to_regprocedure('app.hierarchy_operator(uuid)') is null
     or to_regprocedure('app.has_permission(text)') is null then
    raise exception 'existing hierarchy helpers must be installed first';
  end if;
end $$;

-- Private: called only by the triggers below and the trusted migration.
-- A role must already have passed existing hierarchy authorization guards.
create or replace function app.hierarchy_ensure_technician(p_user_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare
  profile public.users%rowtype;
  technician_id uuid;
  candidate_count integer;
begin
  select * into profile from public.users where id=p_user_id for update;
  if profile.id is null or profile.deleted_at is not null
     or profile.status::text<>'active'
     or app.hierarchy_role_for(profile.id) is distinct from 'technician' then
    return null;
  end if;

  -- Do not resurrect archived records or move a technician between tenants.
  -- Such cases need an explicit administrator decision, not a new identity.
  if exists(select 1 from public.technicians t
    where (t.user_id=profile.id and
      (t.company_id<>profile.company_id or t.deleted_at is not null))
    or (t.company_id=profile.company_id and t.deleted_at is not null
      and lower(btrim(t.email))=lower(btrim(profile.email)))) then
    raise exception 'archived or cross-company technician linkage for user %; administrator review required',
      profile.id using errcode='22023';
  end if;

  perform 1 from public.technicians t
    where t.company_id=profile.company_id and t.deleted_at is null
      and (t.user_id=profile.id or lower(btrim(t.email))=lower(btrim(profile.email)))
    order by t.id for update;
  select count(*),min(t.id::text)::uuid into candidate_count,technician_id
    from public.technicians t
    where t.company_id=profile.company_id and t.deleted_at is null
      and (t.user_id=profile.id or lower(btrim(t.email))=lower(btrim(profile.email)));
  if candidate_count>1 or exists(select 1 from public.technicians t
    where t.id=technician_id and t.user_id is not null and t.user_id<>profile.id) then
    raise exception 'ambiguous technician linkage for user %; administrator review required',
      profile.id using errcode='22023';
  end if;
  if technician_id is null then
    insert into public.technicians(company_id,user_id,code,full_name,email,phone,employment_type,is_available)
      values(profile.company_id,profile.id,replace(profile.id::text,'-',''),
        coalesce(nullif(btrim(profile.full_name),''),split_part(profile.email,'@',1)),
        profile.email,profile.phone,'subcontractor',true)
      returning id into technician_id;
  else
    -- Keep the technician ID, allocations, partner, rates and availability.
    update public.technicians set user_id=profile.id,updated_at=now()
      where id=technician_id and user_id is null;
  end if;
  return technician_id;
end $$;
revoke all on function app.hierarchy_ensure_technician(uuid) from public,anon,authenticated;

create or replace function app.hierarchy_sync_technician()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_table_schema<>'public' then
    raise exception 'unsupported technician linkage surface' using errcode='42501';
  end if;
  if tg_table_name='user_roles' then
    perform app.hierarchy_ensure_technician(new.user_id);
  elsif tg_table_name='users' then
    perform app.hierarchy_ensure_technician(new.id);
  else
    raise exception 'unsupported technician linkage surface' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function app.hierarchy_sync_technician() from public,anon,authenticated;

drop trigger if exists hierarchy_technician_role_sync on public.user_roles;
create trigger hierarchy_technician_role_sync
  after insert or update of role_id,user_id,company_id,deleted_at,expires_at on public.user_roles
  for each row execute function app.hierarchy_sync_technician();
drop trigger if exists hierarchy_technician_profile_sync on public.users;
create trigger hierarchy_technician_profile_sync
  after insert or update of status,deleted_at,company_id on public.users
  for each row execute function app.hierarchy_sync_technician();

-- Preserve standalone legacy technicians, but never offer a linked inactive,
-- conflicting, cross-company or non-subcontractor account for new allocation.
create or replace function public.job_assignable_technicians(p_company_id uuid)
returns table(id uuid,full_name text,code text)
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if auth.uid() is null
     or not coalesce(app.hierarchy_operator(p_company_id),false)
     or not coalesce(app.has_permission('technicians.assign'),false)
     or not exists(select 1 from public.companies c where c.id=p_company_id
       and c.is_active and c.deleted_at is null) then
    raise exception 'technician assignment access forbidden' using errcode='42501';
  end if;
  return query select t.id,t.full_name,t.code from public.technicians t
    where t.company_id=p_company_id and t.deleted_at is null and t.is_available
      and (t.user_id is null or exists(
        select 1 from public.users u where u.id=t.user_id and u.company_id=t.company_id
          and u.status::text='active' and u.deleted_at is null
          and app.hierarchy_role_for(u.id)='technician'))
    order by lower(t.full_name),t.id;
end $$;
revoke all on function public.job_assignable_technicians(uuid) from public,anon,authenticated;
grant execute on function public.job_assignable_technicians(uuid) to authenticated;

-- Repair already-accepted accounts without replacing technician identities.
-- Ambiguous/archived/cross-tenant matches abort the entire migration, including
-- this repair, rather than guessing which technician owns existing work.
do $$
declare profile record;
begin
  for profile in select u.id from public.users u
    where u.deleted_at is null and u.status::text='active'
      and app.hierarchy_role_for(u.id)='technician' order by u.id
  loop
    perform app.hierarchy_ensure_technician(profile.id);
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
