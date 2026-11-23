-- Additive onboarding fix. Keep jobs.partner_id mandatory and preserve all RLS,
-- role definitions, billing, invitations and technician allocation logic.
-- Apply through a trusted database migration session, not a browser client.
begin;

do $$
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Use a trusted migration principal';
  end if;
  if to_regprocedure('public.hierarchy_create_company(text,text)') is null
     or to_regprocedure('app.hierarchy_seed_roles(uuid)') is null
     or to_regprocedure('app.hierarchy_operator(uuid)') is null then
    raise exception 'Existing hierarchy company creation and operator helpers are required';
  end if;
end $$;

-- Same signature, return type, ownership, privileges and caller authorization.
-- No exception handler: a partner/role failure rolls back company creation too.
create or replace function public.hierarchy_create_company(p_legal_name text,p_slug text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare company uuid;
begin
  if app.hierarchy_role() is distinct from 'ultra_admin' then
    raise exception 'Ultra Admin required' using errcode='42501'; end if;
  insert into public.companies(legal_name,slug,created_by)
    values(btrim(p_legal_name),lower(btrim(p_slug)),auth.uid()) returning id into company;
  perform app.hierarchy_seed_roles(company);
  insert into public.partners(company_id,code,name,is_active,portal_enabled,created_by)
    values(company,'DEFAULT',btrim(p_legal_name)||' Default',true,false,auth.uid());
  return company;
end $$;

-- Existing Admin roles have jobs.write but not necessarily partners.read.
-- Expose only picker fields, for the caller's own active operator workspace.
-- This deliberately does not grant direct partner-table access or modify RLS.
create or replace function public.job_partner_options()
returns table(id uuid,company_id uuid,name text)
language plpgsql stable security definer set search_path=pg_catalog as $$
declare tenant uuid;
begin
  select u.company_id into tenant from public.users u
    where u.id=auth.uid() and u.status::text='active' and u.deleted_at is null;
  if tenant is null or not coalesce(app.hierarchy_operator(tenant),false) then
    raise exception 'Active company operator required' using errcode='42501';
  end if;
  return query select p.id,p.company_id,p.name::text
    from public.partners p
    where p.company_id=tenant and p.is_active and p.deleted_at is null
    order by p.name,p.id;
end $$;
revoke all on function public.job_partner_options() from public,anon,authenticated,service_role;
grant execute on function public.job_partner_options() to authenticated;

-- Existing partnerless workspaces, including Test Telco, need the same setup.
-- Lock and recheck each company so concurrent reruns do not duplicate defaults.
-- Preserve historical inactive/deleted partners and all operational data.
do $$
declare
  company record;
  partner_code text;
  suffix integer;
begin
  for company in
    select c.id,c.legal_name from public.companies c
    where c.deleted_at is null
      and not exists(select 1 from public.partners p
        where p.company_id=c.id and p.is_active and p.deleted_at is null)
    order by c.id for update of c
  loop
    if exists(select 1 from public.partners p
      where p.company_id=company.id and p.is_active and p.deleted_at is null) then
      continue;
    end if;
    partner_code := 'DEFAULT';
    suffix := 0;
    -- A retired DEFAULT may still occupy the existing company/code unique index.
    -- Do not reactivate it or overwrite its historical billing identity.
    while exists(select 1 from public.partners p
      where p.company_id=company.id and p.deleted_at is null
        and lower(p.code)=lower(partner_code))
    loop
      suffix := suffix+1;
      partner_code := 'DEFAULT_'||suffix::text;
    end loop;
    insert into public.partners(company_id,code,name,is_active,portal_enabled,created_by)
      values(company.id,partner_code,btrim(company.legal_name)||' Default',true,false,auth.uid());
  end loop;
end $$;

-- Delivered only after COMMIT, so PostgREST sees the new picker RPC atomically.
notify pgrst, 'reload schema';

commit;
