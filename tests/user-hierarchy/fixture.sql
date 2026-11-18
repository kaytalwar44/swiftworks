-- ISOLATED TEST DATA ONLY. IDs, identities and portal/booking routines below
-- are synthetic. They are not a reconstruction of unknown production RPCs.
insert into public.companies(id,slug,legal_name) values
 ('10000000-0000-0000-0000-000000000001','company-one','Company One'),
 ('10000000-0000-0000-0000-000000000002','company-two','Company Two');
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'user'||n||'@example.test',now(),'{}'
from generate_series(1,12) n;
insert into public.roles(id,company_id,code,name,permissions,is_system)
select ('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 case when n=5 then '10000000-0000-0000-0000-000000000002'::uuid
 else '10000000-0000-0000-0000-000000000001'::uuid end,
 case when n in (1,5) then 'owner' when n=2 then 'admin' when n=3 then 'technician' else 'company_admin' end,
 'Fixture role',
 case when n in (1,2,4,5) then '["*","custom.existing"]'::jsonb
 else '["jobs.read","bookings.read","bookings.write"]'::jsonb end,true
from generate_series(1,5) n;
insert into public.users(id,company_id,email,full_name,status,is_platform_admin)
select a.id,
 case when n=6 then '10000000-0000-0000-0000-000000000002'::uuid
 else '10000000-0000-0000-0000-000000000001'::uuid end,
 a.email,'Fixture user '||n,'active',n=1
from generate_series(1,8) n
join auth.users a on a.id=('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
insert into public.user_roles(company_id,user_id,role_id)
select u.company_id,u.id,
 ('20000000-0000-0000-0000-'||lpad(
 case when n=2 then '1' when n=3 then '2' when n=6 then '5' when n=7 then '4' else '3' end,12,'0'))::uuid
from generate_series(2,8) n join public.users u
 on u.id=('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid;
insert into public.partners(id,company_id,code,name)
values('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','FIXTURE','Fixture Partner');
insert into public.technicians(id,company_id,user_id,code,full_name,email)
values
 ('40000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000004','TECH4','Subcontractor Four','user4@example.test'),
 ('40000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000005','TECH5','Subcontractor Five','user5@example.test'),
 ('40000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000001',null,'TECH9','Invited Subcontractor','user9@example.test');
insert into public.jobs(id,company_id,partner_id,job_number,title,address_line1,suburb,state,postcode,start_date,end_date)
select ('50000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 '10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',
 'FIXTURE-'||n,'Fixture job '||n,'1 Test St','Test Suburb','NSW','2000',current_date,current_date+1
from generate_series(1,3) n;
insert into public.job_technicians(company_id,job_id,technician_id,is_lead)
values
 ('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000004',true),
 ('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000005',true),
 ('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000009',true);
insert into public.customer_bookings(company_id,job_id,booking_ref,phone,full_name)
select '10000000-0000-0000-0000-000000000001',
 ('50000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'FIXTURE-'||n,'0000000000','Fixture Customer'
from generate_series(1,3) n;

-- Intentionally overbroad legacy definers: the migration must constrain their
-- output, not trust a legacy WHERE clause or rewrite the allocation mechanism.
create function public.technician_portal_jobs()
returns table(job_id uuid,job_title text,job_number text,address text,booking_count bigint)
language sql security definer set search_path=pg_catalog as $$
 select j.id,j.title,j.job_number,j.address_line1,
 (select count(*) from public.customer_bookings b where b.job_id=j.id)
 from public.jobs j
$$;
create function public.technician_portal_bookings(p_job_id uuid)
returns table(booking_id uuid,customer_name text,status text)
language sql security definer set search_path=pg_catalog as $$
 select id,full_name,status::text from public.customer_bookings
$$;
create function public.booking_link_job(p_token text)
returns uuid language sql security definer set search_path=pg_catalog as $$
 select '50000000-0000-0000-0000-000000000001'::uuid where p_token='fixture-public-token'
$$;
create function public.booking_slots(p_token text,p_from date default null)
returns integer language sql security definer set search_path=pg_catalog as $$
 select 1 where p_token='fixture-public-token'
$$;
create function public.booking_create(
 p_token text,p_slot_id uuid,p_full_name text,p_mobile text,p_email text,p_unit_number text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare booking uuid;
begin
 if p_token<>'fixture-public-token' then raise exception 'invalid fixture token'; end if;
 insert into public.customer_bookings(company_id,job_id,booking_ref,phone,full_name)
 values('10000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',
  'FIX-'||substr(extensions.gen_random_uuid()::text,1,12),p_mobile,p_full_name) returning id into booking;
 return booking;
end $$;
create function public.job_assign_technician(p_job_id uuid,p_technician_id uuid)
returns void language sql security definer set search_path=pg_catalog as $$
 update public.job_technicians set technician_id=p_technician_id where job_id=p_job_id
$$;
revoke all on function public.job_assign_technician(uuid,uuid) from public;
grant execute on function public.job_assign_technician(uuid,uuid) to authenticated;
grant execute on function public.booking_link_job(text),public.booking_slots(text,date),
 public.booking_create(text,uuid,text,text,text,text) to anon,authenticated;
grant execute on function public.technician_portal_jobs(),public.technician_portal_bookings(uuid) to authenticated;

-- Model the helper access required by a working deployment. The checked-in
-- phase files alone revoke these grants inconsistently; production must be
-- inspected. These are TEST FIXTURE grants, not a production ACL migration.
grant execute on all functions in schema app to authenticated;

-- Deliberately unsafe legacy APIs to prove triggers enforce hierarchy even
-- when a SECURITY DEFINER forgot its own caller check.
create function public.fixture_change_role(p_user uuid,p_code text)
returns void language sql security definer set search_path=pg_catalog as $$
 update public.user_roles ur set role_id=r.id
 from public.roles r where ur.user_id=p_user and r.code=p_code
   and r.company_id=ur.company_id and r.deleted_at is null
$$;
create function public.fixture_edit_permissions()
returns void language sql security definer set search_path=pg_catalog as $$
 update public.roles set permissions='["*"]' where code='admin'
$$;
grant execute on function public.fixture_change_role(uuid,text),public.fixture_edit_permissions() to authenticated;
