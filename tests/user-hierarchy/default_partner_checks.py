"""Real PostgreSQL checks invoked inside database_test.py's disposable cluster.

All identities, companies and jobs below are synthetic test fixtures. No live
Supabase, email delivery, production credentials or production records are used.
"""
import json


def run(setup, check, sql, uid, root):
    migration = root / "supabase/migrations/202611230001_company_default_partner.sql"
    telco = "0e5573a7-fcb5-4184-97ad-105602dddc89"
    retired = "71000000-0000-0000-0000-000000000001"
    deleted = "71000000-0000-0000-0000-000000000002"
    setup(f"""
      insert into public.companies(id,slug,legal_name) values
        ('{telco}','test-telco','Test Telco'),
        ('{retired}','retired-default','Retired Company'),
        ('{deleted}','deleted-company','Deleted Company');
      update public.companies set deleted_at=now() where id='{deleted}';
      select app.hierarchy_seed_roles('{telco}');
      insert into public.partners(company_id,code,name,is_active,notes)
        values('{retired}','default','Historical partner',false,'Preserve history');
    """)
    snapshots = {
        "policies": "select coalesce(jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname),'[]') from pg_policies p",
        "roles": "select jsonb_agg(to_jsonb(r) order by id) from public.roles r",
        "memberships": "select jsonb_agg(to_jsonb(r) order by id) from public.user_roles r",
        "rpc_properties": """select jsonb_build_array(proowner,proacl,prosecdef,proconfig,proargnames,prorettype)
          from pg_proc where oid='public.hierarchy_create_company(text,text)'::regprocedure""",
        "required_partner": """select attnotnull from pg_attribute
          where attrelid='public.jobs'::regclass and attname='partner_id'""",
        "job_fk": """select pg_get_constraintdef(oid) from pg_constraint
          where conrelid='public.jobs'::regclass and conname='jobs_partner_fk'""",
    }
    for table in ["jobs", "customer_bookings", "technicians", "invoices", "job_slots", "job_technicians"]:
        snapshots[table] = f"select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.{table} t"
    before = {key: setup(query) for key, query in snapshots.items()}
    old_partners = json.loads(setup("select jsonb_object_agg(id,to_jsonb(p)) from public.partners p"))
    old_functions = setup("""
      select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','app') and p.prokind='f'
        and p.oid<>'public.hierarchy_create_company(text,text)'::regprocedure
    """)
    setup(migration, True)
    for key, query in snapshots.items():
        assert setup(query) == before[key], f"Migration changed protected {key}"
    current = json.loads(setup("select jsonb_object_agg(id,to_jsonb(p)) from public.partners p"))
    assert all(current[key] == value for key, value in old_partners.items())
    functions = json.loads(setup("""
      select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','app') and p.prokind='f'
        and p.oid not in ('public.hierarchy_create_company(text,text)'::regprocedure,
                         'public.job_partner_options()'::regprocedure)
    """))
    assert functions == json.loads(old_functions), "Unrelated function definitions changed"
    print("PASS: migration preserved all policies, roles, memberships, operational rows, existing partners, FK and unrelated functions")
    check("Test Telco backfill creates exactly one active internal default",
          f"""select count(*)=1 and bool_and(name='Test Telco Default' and code='DEFAULT'
          and is_active and not portal_enabled) from public.partners
          where company_id='{telco}' and deleted_at is null;""", "t", role=None)
    check("existing active-partner company remains unchanged",
          "select count(*) from public.partners where company_id='10000000-0000-0000-0000-000000000001';",
          "1", role=None)
    check("inactive default is preserved and collision-safe replacement is active",
          f"""select count(*)=2 and count(*) filter(where code='DEFAULT_1' and is_active)=1
          and count(*) filter(where code='default' and not is_active and notes='Preserve history')=1
          from public.partners where company_id='{retired}';""", "t", role=None)
    check("deleted company is not backfilled",
          f"select count(*) from public.partners where company_id='{deleted}';", "0", role=None)
    partner_snapshot = setup("select jsonb_agg(to_jsonb(p) order by id) from public.partners p")
    setup(migration, True)
    assert setup("select jsonb_agg(to_jsonb(p) order by id) from public.partners p") == partner_snapshot
    print("PASS: migration/backfill rerun created no duplicate and modified no partner")

    def invite_join(actor, target, company, code):
        token = check(f"invite test {code}", f"select token from public.hierarchy_invite("
                      f"'{company}','user{target}@example.test','{code}');", user=actor)
        if int(setup(f"select count(*) from auth.users where id={uid(target)};")) == 0:
            setup(f"""insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
              values({uid(target)},'user{target}@example.test',now(),
                     jsonb_build_object('invitation_token','{token}'));""")
        check(f"accept test {code}", f"select public.accept_invitation('{token}')={uid(target)};",
              "t", target)

    # user11 is an existing unjoined fixture identity; 120+ are new test accounts.
    invite_join(1, 11, telco, "owner")
    invite_join(11, 120, telco, "admin")
    fresh = check("Ultra creates company with default partner atomically",
                  "select public.hierarchy_create_company('Immediate Company','immediate-company');", user=1)
    check("new company has exactly one correctly attributed selectable default",
          f"""select count(*)=1 and bool_and(code='DEFAULT' and name='Immediate Company Default'
          and is_active and not portal_enabled and created_by={uid(1)})
          from public.partners where company_id='{fresh}';""", "t", role=None)
    invite_join(1, 121, fresh, "owner")
    invite_join(121, 122, fresh, "admin")
    for actor, company, label in [
        (11, telco, "Test Telco Super Admin"), (120, telco, "Test Telco Admin"),
        (121, fresh, "new-company Super Admin"), (122, fresh, "new-company Admin"),
    ]:
        check(f"{label} selects only own active partner",
              f"""select count(*)=1 and bool_and(company_id='{company}'::uuid)
              from public.job_partner_options();""", "t", actor)
        check(f"{label} can insert a job with the default partner under existing RLS",
              f"""with created as(
                insert into public.jobs(company_id,partner_id,job_number,address_line1,suburb,
                                        state,postcode,start_date,end_date)
                select company_id,id,'DEFAULT-TEST-{actor}','1 Test St','Test Suburb',
                       'NSW','2000',current_date,current_date+1 from public.job_partner_options()
                returning id
              ) select count(*) from created;""", "1", actor)
    check("new Admin permissions remain unchanged without partners.read",
          "select not app.has_permission('partners.read') and app.has_permission('jobs.write');",
          "t", 122)
    check("new Admin direct partner-table RLS is still unchanged",
          "select count(*) from public.partners;", "0", 122)
    check("Subcontractor cannot use the operator partner picker",
          "select * from public.job_partner_options();", user=4, denied=True)
    check("disable test Admin using existing hierarchy control",
          f"select public.hierarchy_set_user({uid(120)},null,'disabled');", user=11)
    check("disabled Admin cannot use the partner picker",
          "select * from public.job_partner_options();", user=120, denied=True)
    check("restore test Admin using existing hierarchy control",
          f"select public.hierarchy_set_user({uid(120)},null,'active');", user=11)
    check("anonymous cannot use partner picker",
          "select * from public.job_partner_options();", role="anon", denied=True)
    check("picker has no company override argument",
          "select pronargs from pg_proc where oid='public.job_partner_options()'::regprocedure;",
          "0", role=None)
    for actor in [11, 120, 121, 122]:
        check("company provisioning is still Ultra-only",
              "select public.hierarchy_create_company('Forbidden','forbidden-default');",
              user=actor, denied=True)
    check("picker cannot disclose retired partners",
          "select bool_and(p.is_active and p.deleted_at is null) from public.job_partner_options() o "
          "join public.partners p on p.id=o.id;", "t", 11)

    # Force an insert failure in the disposable cluster only. No test trigger is
    # present in the migration, and no production schema is touched.
    setup("""
      create function public.fixture_fail_default_partner() returns trigger language plpgsql as $$
      begin if new.name='Atomic Failure Default' then raise exception 'forced partner failure'; end if;
        return new; end $$;
      create trigger fixture_fail_default_partner before insert on public.partners
        for each row execute function public.fixture_fail_default_partner();
    """)
    failed = sql(f"set request.jwt.claim.sub={uid(1)};"
                 "set request.jwt.claim.role='authenticated';set role authenticated;"
                 "select public.hierarchy_create_company('Atomic Failure','atomic-failure');")
    assert failed.returncode and "forced partner failure" in failed.stderr
    check("failed partner insertion rolled back company and seeded roles",
          """select not exists(select 1 from public.companies where slug='atomic-failure')
          and not exists(select 1 from public.partners where name='Atomic Failure Default')
          and not exists(select 1 from public.roles r
            left join public.companies c on c.id=r.company_id
            where r.company_id is not null and c.id is null);""", "t", role=None)
    setup("drop trigger fixture_fail_default_partner on public.partners;"
          "drop function public.fixture_fail_default_partner();")
    print("PASS: default-partner PostgreSQL acceptance checks complete (isolated fixtures, not production)")
