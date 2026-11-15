-- Synthetic, isolated PostgreSQL test fixture. Never run against production.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema app;
grant usage on schema public, auth, app to anon, authenticated, service_role;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;

create table public.companies (
  id uuid primary key, legal_name text not null, is_active boolean default true
);
create table public.users (
  id uuid primary key, company_id uuid not null references public.companies,
  full_name text, is_platform_admin boolean not null default false,
  status text default 'active', deleted_at timestamptz
);
create table public.roles (
  id uuid primary key, company_id uuid, code text,
  permissions jsonb not null default '[]', deleted_at timestamptz
);
create table public.user_roles (
  id uuid primary key, user_id uuid, company_id uuid, role_id uuid,
  expires_at timestamptz, deleted_at timestamptz
);
create table public.user_invitations (
  id uuid primary key, company_id uuid, email text, token text,
  role_id uuid, expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz
);

insert into public.companies values
  ('10000000-0000-0000-0000-000000000001','First Company',true),
  ('10000000-0000-0000-0000-000000000002','Second Company',true),
  ('10000000-0000-0000-0000-000000000003','Inactive Company',false);
insert into public.roles (id,company_id,code,permissions) values
  ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','admin','["users.manage"]'),
  ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','admin','["users.*"]'),
  ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','staff','["jobs.read"]'),
  ('20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003','owner','["*"]');
insert into public.users (id,company_id,full_name,is_platform_admin,status) values
  ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Manager',false,'active'),
  ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','Staff',false,'active'),
  ('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002','Other manager',false,'active'),
  ('30000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','Expired manager',false,'active'),
  ('30000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','Disabled manager',false,'disabled'),
  ('30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','Platform operator',true,'active'),
  ('30000000-0000-0000-0000-000000000007','10000000-0000-0000-0000-000000000001','Wrong role tenant',false,'active'),
  ('30000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000003','Inactive manager',false,'active');
insert into public.user_roles (id,user_id,company_id,role_id,expires_at)
select ('40000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
       ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
       case when n=3 then '10000000-0000-0000-0000-000000000002'::uuid
            when n=8 then '10000000-0000-0000-0000-000000000003'::uuid
            else '10000000-0000-0000-0000-000000000001'::uuid end,
       case when n in (3,7) then '20000000-0000-0000-0000-000000000002'::uuid
            when n=2 then '20000000-0000-0000-0000-000000000003'::uuid
            when n=8 then '20000000-0000-0000-0000-000000000004'::uuid
            else '20000000-0000-0000-0000-000000000001'::uuid end,
       case when n=4 then now()-interval '1 day' else null end
from unnest(array[1,2,3,4,5,7,8]) n;
insert into public.user_invitations
  (id,company_id,email,token,role_id,expires_at,accepted_at,revoked_at)
select ('50000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
       case when n=2 then '10000000-0000-0000-0000-000000000002'::uuid
            when n=7 then '10000000-0000-0000-0000-000000000003'::uuid
            else '10000000-0000-0000-0000-000000000001'::uuid end,
       'invited@example.test', 'invitation-'||n,
       case when n in (2,6) then '20000000-0000-0000-0000-000000000002'::uuid
            when n=7 then '20000000-0000-0000-0000-000000000004'::uuid
            else '20000000-0000-0000-0000-000000000001'::uuid end,
       case when n=3 then now()-interval '1 day' else now()+interval '1 day' end,
       case when n=5 then now() else null end,
       case when n=4 then now() else null end
from generate_series(1,7) n;

create function app.current_company_id() returns uuid language sql stable security definer
set search_path=pg_catalog as $$
  select company_id from public.users where id=auth.uid() and deleted_at is null
$$;
create function app.is_platform_admin() returns boolean language sql stable security definer
set search_path=pg_catalog as $$
  select coalesce((select is_platform_admin from public.users where id=auth.uid()),false)
$$;
create function app.can_access_company(p uuid) returns boolean language sql stable security definer
set search_path=pg_catalog as $$
  select p=app.current_company_id() or app.is_platform_admin()
$$;
create function app.has_permission(p text) returns boolean language sql stable security definer
set search_path=pg_catalog as $$
  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id
    where ur.user_id=auth.uid() and ur.deleted_at is null and r.deleted_at is null
      and (ur.expires_at is null or ur.expires_at>now())
      and (r.permissions ? p or r.permissions ? '*' or r.permissions ? 'users.*')
  ) or app.is_platform_admin()
$$;

alter table public.users enable row level security;
alter table public.users force row level security;
grant select,insert,update,delete on public.users to authenticated;
grant select,insert,update,delete on all tables in schema public to service_role;
grant execute on all functions in schema app to authenticated;

-- Test-only bypass candidate: validates trigger protection even from a
-- SECURITY DEFINER API that otherwise lets a browser request set the flag.
create function public.test_definer_set_admin(p_user uuid,p_value boolean)
returns void language sql security definer set search_path=pg_catalog as $$
  update public.users set is_platform_admin=p_value where id=p_user
$$;
revoke all on function public.test_definer_set_admin(uuid,boolean) from public;
grant execute on function public.test_definer_set_admin(uuid,boolean) to authenticated;
