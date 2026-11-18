-- Reviewed additive enhancement. Apply AFTER the Critical + hierarchy migrations.
-- No booking/slot/QR/allocation tables, policies or routine bodies are changed.
begin;

do $$ begin
  if to_regprocedure('app.hierarchy_can_delegate(uuid,uuid,text,uuid)') is null
    or to_regprocedure('public.hierarchy_snapshot(uuid)') is null then
    raise exception 'Hierarchy migration must be installed first';
  end if;
  if current_user not in ('postgres','supabase_admin') then
    raise exception 'Use a trusted migration principal with Auth schema ownership';
  end if;
end $$;

-- Keep existing delegation and visibility restrictions. Auth timestamps never
-- require granting browser roles SELECT on auth.users.
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
      'company_name',c.legal_name,'created_at',u.created_at,'last_login',a.last_sign_in_at,
      'role_code',coalesce(app.hierarchy_role_for(u.id),(
        select case when bool_or(r.code='owner') then 'owner'
          when bool_or(r.code in ('admin','company_admin')) then 'admin'
          when bool_or(r.code='technician') then 'technician' else 'legacy' end
        from public.user_roles ur join public.roles r on r.id=ur.role_id
        where ur.user_id=u.id and ur.deleted_at is null and r.deleted_at is null
          and (ur.expires_at is null or ur.expires_at>now()))),
      'can_manage',app.hierarchy_can_delegate(auth.uid(),selected,'technician',u.id))
      order by u.full_name),'[]') into members
    from public.users u
    join public.companies c on c.id=u.company_id
    left join auth.users a on a.id=u.id
    where u.company_id=selected and u.deleted_at is null
      and (kind<>'admin' or u.id=auth.uid() or
        app.hierarchy_can_delegate(auth.uid(),selected,'technician',u.id));
  return jsonb_build_object('actor_role',kind,'company_id',selected,'companies',companies,'users',members);
end $$;
revoke all on function public.hierarchy_snapshot(uuid) from public,anon;
grant execute on function public.hierarchy_snapshot(uuid) to authenticated;

-- Database gate also covers direct calls to Auth signup, anonymous identities,
-- OAuth/phone/admin provisioning without an authorized invitation. No JWT/client
-- metadata flag can bypass it. Keep email/password signup enabled in Auth:
-- a blanket disable would prevent the existing invite acceptance path.
create or replace function app.hierarchy_require_invitation()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if new.email is null or not exists (
    select 1 from public.user_invitations i
    join public.roles r on r.id=i.role_id and r.company_id=i.company_id and r.deleted_at is null
    join public.companies c on c.id=i.company_id and c.is_active and c.deleted_at is null
    where i.token=new.raw_user_meta_data->>'invitation_token'
      and lower(btrim(i.email))=lower(btrim(new.email))
      and i.accepted_at is null and i.revoked_at is null and i.expires_at>now()
      and app.hierarchy_can_delegate(i.invited_by,i.company_id,r.code)
  ) then
    raise exception 'A valid invitation is required to register' using errcode='42501';
  end if;
  -- Tokens must not be retained in user-editable metadata or later JWTs.
  new.raw_user_meta_data:=new.raw_user_meta_data-'invitation_token';
  return new;
end $$;
revoke all on function app.hierarchy_require_invitation() from public,anon,authenticated;
drop trigger if exists trg_hierarchy_invitation_signup on auth.users;
create trigger trg_hierarchy_invitation_signup
  before insert on auth.users for each row execute function app.hierarchy_require_invitation();

commit;
