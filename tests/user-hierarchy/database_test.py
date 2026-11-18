"""Integration tests: real source tables/policies, synthetic Auth and opaque RPCs.

Only a disposable socket-only PostgreSQL cluster is used. No Supabase access,
DATABASE_URL, production data, emails or actual deployed booking tests.
"""
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def main():
    passed = 0
    with tempfile.TemporaryDirectory(prefix="swiftworks-hierarchy-") as tmp:
        tmp = Path(tmp)
        sock = tmp / "socket"
        sock.mkdir(mode=0o700)
        data = tmp / "data"
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        env.update(PGHOST=str(sock), PGPORT="55484", PGUSER="postgres", PGDATABASE="postgres")

        def command(args):
            return subprocess.run(args, env=env, capture_output=True, text=True)

        def sql(query, file=False):
            return command(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
                            "-v", "VERBOSITY=verbose"] + (["-f", str(query)] if file else ["-c", query]))

        def setup(query, file=False):
            result = sql(query, file)
            if result.returncode:
                raise RuntimeError(result.stderr)
            return result.stdout.strip()

        def uid(n):
            return f"'30000000-0000-0000-0000-{n:012d}'"

        def check(name, query, expected=None, user=None, role="authenticated", denied=False):
            nonlocal passed
            prefix = f"set request.jwt.claim.sub={uid(user)};" if user else ""
            if role:
                prefix += f"set request.jwt.claim.role='{role}';set role {role};"
            result = sql(prefix + query)
            if denied:
                assert result.returncode != 0, (name, "unexpectedly permitted")
                assert "42501" in result.stderr, (name, result.stderr)
            else:
                assert result.returncode == 0, (name, result.stderr)
                if expected is not None:
                    assert result.stdout.strip() == expected, (name, result.stdout)
            passed += 1
            print("PASS:", name)
            return result.stdout.strip()

        result = command(["initdb", "-D", str(data), "-U", "postgres", "-A", "trust",
                          "--no-locale", "-E", "UTF8"])
        if result.returncode:
            raise RuntimeError(result.stderr)
        result = command(["pg_ctl", "-D", str(data), "-l", str(tmp / "postgres.log"),
                          "-o", f"-F -k {sock} -p 55484 -c listen_addresses=''", "-w", "start"])
        if result.returncode:
            raise RuntimeError(result.stderr)
        try:
            setup("""
              create role anon nologin;
              create role authenticated nologin;
              create role service_role nologin bypassrls;
              create schema auth; create schema extensions;
              grant usage on schema auth to anon,authenticated,service_role;
              create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
                raw_user_meta_data jsonb default '{}',phone text,last_sign_in_at timestamptz);
              create function auth.uid() returns uuid language sql stable as $$
                select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
              create function auth.role() returns text language sql stable as $$
                select nullif(current_setting('request.jwt.claim.role',true),'') $$;
              create function auth.jwt() returns jsonb language sql stable as $$
                select jsonb_build_object('sub',auth.uid(),'role',auth.role()) $$;
            """)
            for file in ["bootstrap.sql", "phase2_tables.sql", "phase3_auth.sql", "phase4_rls.sql"]:
                setup(ROOT / file, True)
            setup(HERE / "fixture.sql", True)
            missing_dependency = sql((ROOT / "supabase/migrations/202611150002_user_hierarchy.sql").read_text())
            assert missing_dependency.returncode and "must be installed first" in missing_dependency.stderr
            passed += 1
            print("PASS: hierarchy refuses deployment without Critical flag protection")
            setup(ROOT / "supabase/migrations/202611150001_phase1_critical_security.sql", True)
            missing_hierarchy = sql((ROOT / "supabase/migrations/202611170001_exports_invitation_user_management.sql").read_text())
            assert missing_hierarchy.returncode and "Hierarchy migration must be installed first" in missing_hierarchy.stderr
            passed += 1
            print("PASS: enhancement refuses deployment before hierarchy")
            protected = ["booking_link_job(text)", "booking_slots(text,date)",
                         "booking_create(text,uuid,text,text,text,text)", "job_assign_technician(uuid,uuid)"]
            definitions = {name: setup(f"select pg_get_functiondef('public.{name}'::regprocedure);") for name in protected}
            migration = ROOT / "supabase/migrations/202611150002_user_hierarchy.sql"
            for fault, expected_error in [
                ("alter function public.technician_portal_bookings(uuid) rename to fixture_missing_portal;",
                 "missing deployed portal contract"),
                ("drop function public.technician_portal_bookings(uuid);"
                 "create function public.technician_portal_bookings(p_job_id uuid) returns integer "
                 "language sql as $$select 1$$;", "unsupported portal return shape"),
            ]:
                result = sql("begin;" + fault + migration.read_text())
                assert result.returncode and expected_error in result.stderr, result.stderr
                assert setup("select to_regprocedure('public.hierarchy_snapshot(uuid)') is null;") == "t"
                assert setup("select to_regprocedure('public.technician_portal_bookings(uuid)') is not null;") == "t"
                passed += 1
                print("PASS: unsupported deployment contract aborts and rolls back:", expected_error)
            setup(migration, True)
            setup(ROOT / "supabase/migrations/202611170001_exports_invitation_user_management.sql", True)
            for name, definition in definitions.items():
                assert definition == setup(f"select pg_get_functiondef('public.{name}'::regprocedure);")
                print("PASS: existing synthetic public/allocation definition unchanged:", name)
                passed += 1

            c1 = "'10000000-0000-0000-0000-000000000001'"
            c2 = "'10000000-0000-0000-0000-000000000002'"
            j1 = "'50000000-0000-0000-0000-000000000001'"
            j2 = "'50000000-0000-0000-0000-000000000002'"
            for user, expected in [(1, "ultra_admin"), (2, "owner"), (3, "admin"), (4, "technician"), (7, "admin")]:
                check("canonical/legacy hierarchy classification", "select app.hierarchy_role();", expected, user)
            check("Ultra can provision company", "select public.hierarchy_create_company('New Customer','new-customer') is not null;", "t", 1)
            check("tenant cannot provision company", "select public.hierarchy_create_company('Forbidden','forbidden-company');", user=2, denied=True)
            check("Super Admin snapshot own company", f"select public.hierarchy_snapshot({c1})->>'actor_role';", "owner", 2)
            check("Super Admin cannot switch company", f"select public.hierarchy_snapshot({c2});", user=2, denied=True)
            check("Admin snapshot exposes no higher-level targets",
                  f"select bool_and(not (u->>'can_manage')::boolean or u->>'role_code'='technician') "
                  f"from jsonb_array_elements(public.hierarchy_snapshot({c1})->'users') u;", "t", 3)
            check("Subcontractor cannot list managed users", "select public.hierarchy_snapshot();", user=4, denied=True)
            check("Admin operational wildcard/custom rights preserved",
                  "select permissions ? '*' and permissions ? 'custom.existing' and permissions ? 'subcontractors.manage' "
                  "from public.roles where code='admin';", "t", 3)
            for actor, target, code in [(3, 3, "owner"), (3, 2, "technician"), (2, 2, "admin"), (6, 4, "admin")]:
                check("self/higher/cross-tenant role change denied",
                      f"select public.hierarchy_set_user({uid(target)},'{code}',null);", user=actor, denied=True)
            check("Admin can disable own subcontractor",
                  f"select public.hierarchy_set_user({uid(5)},null,'disabled');", user=3)
            check("disabled subcontractor cannot use work portal", "select * from public.technician_portal_jobs();", user=5, denied=True)
            check("Admin can restore own subcontractor",
                  f"select public.hierarchy_set_user({uid(5)},null,'active');", user=3)
            check("Super Admin can change Subcontractor to Admin",
                  f"select public.hierarchy_set_user({uid(5)},'admin',null);", user=2)
            check("Super Admin can change Admin back to Subcontractor",
                  f"select public.hierarchy_set_user({uid(5)},'technician',null);", user=2)
            check("raw role insertion denied", f"insert into public.user_roles(company_id,user_id,role_id) "
                  f"select {c1},{uid(3)},id from public.roles where code='owner' and company_id={c1};", user=3, denied=True)
            check("raw status self-reactivation denied", f"update public.users set status='active' where id={uid(4)};", user=4, denied=True)
            check("raw platform elevation remains denied", f"update public.users set is_platform_admin=true where id={uid(3)};", user=3, denied=True)
            check("legacy SECURITY DEFINER self-promotion denied",
                  f"select public.fixture_change_role({uid(3)},'owner');", user=3, denied=True)
            check("legacy SECURITY DEFINER permission edits denied",
                  "select public.fixture_edit_permissions();", user=3, denied=True)
            check("safe profile edit remains allowed", f"update public.users set full_name='Profile edit' where id={uid(3)};", user=3)
            for code in ["owner", "admin"]:
                check("Admin cannot invite higher role",
                      f"select * from public.hierarchy_invite({c1},'user10@example.test','{code}');", user=3, denied=True)
            check("Super Admin cannot invite peer",
                  f"select * from public.hierarchy_invite({c1},'user10@example.test','owner');", user=2, denied=True)
            check("Admin cannot invite into another tenant",
                  f"select * from public.hierarchy_invite({c2},'user10@example.test','technician');", user=3, denied=True)
            check("legacy invitation API cannot bypass role delegation",
                  f"select * from public.invite_user('user11@example.test',"
                  f"(select id from public.roles where code='owner' and company_id={c1}),null,'staff',14);",
                  user=3, denied=True)
            super_token = check("Ultra can invite cross-company Super Admin",
                  f"select token from public.hierarchy_invite({c2},'user10@example.test','owner');", user=1)
            check("Ultra can authorize stored cross-company delivery",
                  f"select count(*) from public.invitation_for_delivery('{super_token}');", "1", 1)
            check("Admin cannot authorize Super Admin email",
                  f"select count(*) from public.invitation_for_delivery('{super_token}');", "0", 3)
            check("Super Admin invite acceptance creates tenant owner",
                  f"select public.accept_invitation('{super_token}')={uid(10)};", "t", 10)
            token = check("Admin can invite Subcontractor",
                  f"select token from public.hierarchy_invite({c1},'user9@example.test','technician');", user=3)
            check("Admin authorizes subcontractor email",
                  f"select count(*) from public.invitation_for_delivery('{token}');", "1", 3)
            check("wrong identity cannot accept invitation",
                  f"select public.accept_invitation('{token}');", user=11, denied=True)
            check("Subcontractor accepts and links existing allocated technician",
                  f"select public.accept_invitation('{token}')={uid(9)};", "t", 9)
            check("technician ID preserved", f"select user_id={uid(9)} from public.technicians where code='TECH9';", "t", role=None)
            check("accepted invitation is idempotent",
                  f"select public.accept_invitation('{token}')={uid(9)};", "t", 9)
            check("booking created before login linkage remains visible",
                  "select count(*) from public.technician_portal_bookings('50000000-0000-0000-0000-000000000003');",
                  "1", 9)
            check("unlinked subcontractor sees no jobs", "select count(*) from public.technician_portal_jobs();", "0", 8)
            check("job RPC filters intentionally overbroad legacy output",
                  "select count(*) from public.technician_portal_jobs();", "1", 4)
            check("booking RPC filters overbroad output and preserves null-tech bookings",
                  f"select count(*) from public.technician_portal_bookings({j1});", "1", 4)
            check("guessed job RPC denied", f"select * from public.technician_portal_bookings({j2});", user=4, denied=True)
            check("original privileged job RPC cannot be called directly",
                  "select * from app.hierarchy_original_technician_portal_jobs();", user=4, denied=True)
            check("raw jobs query allocation-scoped", "select count(*) from public.jobs;", "1", 4)
            check("raw booking query allocation-scoped", "select count(*) from public.customer_bookings;", "1", 4)
            check("Admin retains all own-company jobs", "select count(*) from public.jobs;", "3", 3)
            check("Admin can still create jobs",
                  f"insert into public.jobs(company_id,partner_id,job_number,address_line1,suburb,state,postcode,start_date,end_date) "
                  f"values({c1},'60000000-0000-0000-0000-000000000001','ADMIN-CREATE','Test Address','Test','NSW','2000',current_date,current_date);",
                  user=3)
            check("Admin can still create slots",
                  f"insert into public.job_slots(company_id,job_id,slot_date,start_time,end_time,local_start,local_end) "
                  f"values({c1},{j1},current_date,current_date+interval '8 hours',current_date+interval '9 hours','08:00','09:00');",
                  user=3)
            check("Admin retains QR-generation data privileges",
                  f"insert into public.qr_codes(company_id,job_id,token) values({c1},{j1},'unchanged-fixture-qr');",
                  user=3)
            check("Subcontractor cannot invoke legacy allocator to self-assign",
                  f"select public.job_assign_technician({j2},'40000000-0000-0000-0000-000000000004');",
                  user=4, denied=True)
            check("existing public link works anonymously",
                  "select public.booking_link_job('fixture-public-token') is not null;", "t", role="anon")
            check("existing public slots work anonymously",
                  "select public.booking_slots('fixture-public-token',null);", "1", role="anon")
            check("synthetic anonymous booking uses unchanged contract",
                  "select public.booking_create('fixture-public-token',null,'Anonymous Customer','0000000000',"
                  "'resident@example.test','Unit 99') is not null;", "t", role="anon")
            check("new customer booking appears to assigned subcontractor",
                  f"select count(*) from public.technician_portal_bookings({j1});", "2", 4)
            check("new booking remains hidden from other subcontractor",
                  f"select * from public.technician_portal_bookings({j1});", user=5, denied=True)
            check("allocation function works without replacing its implementation",
                  f"select public.job_assign_technician({j1},'40000000-0000-0000-0000-000000000005');", user=3)
            check("old assignee loses job", f"select count(*) from public.jobs where id={j1};", "0", 4)
            check("old assignee loses booking RPC", f"select * from public.technician_portal_bookings({j1});", user=4, denied=True)
            check("new assignee gets existing and new bookings",
                  f"select count(*) from public.technician_portal_bookings({j1});", "2", 5)
            pending = check("manager can issue pending invitation",
                  f"select token from public.hierarchy_invite({c1},'user11@example.test','technician');", user=3)
            check("Super Admin can suspend invitation issuer",
                  f"select public.hierarchy_set_user({uid(3)},null,'disabled');", user=2)
            check("suspended issuer cannot authorize delivery",
                  f"select count(*) from public.invitation_for_delivery('{pending}');", "0", 3)
            check("suspended issuer invitation cannot grant membership",
                  f"select public.accept_invitation('{pending}');", user=11, denied=True)
            check("Super Admin can restore Admin without changing operational roles",
                  f"select public.hierarchy_set_user({uid(3)},null,'active');", user=2)
            new_admin_token = check("Ultra invites Admin into newly provisioned company",
                  "select token from public.hierarchy_invite((select id from public.companies "
                  "where slug='new-customer'),'user12@example.test','admin');", user=1)
            check("new Admin accepts without creating another identity system",
                  f"select public.accept_invitation('{new_admin_token}')={uid(12)};", "t", 12)
            check("new Admin has all required operational permissions without wildcard",
                  "select app.has_permission('jobs.write') and app.has_permission('jobs.publish')"
                  " and app.has_permission('bookings.write') and app.has_permission('technicians.assign')"
                  " and app.has_permission('subcontractors.manage') and not app.has_permission('users.manage');",
                  "t", 12)
            check("new Admin can use controlled administration without users.manage",
                  "select public.hierarchy_snapshot()->>'actor_role';", "admin", 12)
            check("anonymous hierarchy management denied",
                  "select public.hierarchy_snapshot();", denied=True, role="anon")
            setup(f"update auth.users set last_sign_in_at='2026-11-17T01:02:03Z' where id={uid(3)};")
            check("snapshot includes company and creation date",
                  "select bool_and(u ? 'company_name' and u ? 'created_at' and u ? 'last_login') "
                  "from jsonb_array_elements(public.hierarchy_snapshot()->'users') u;", "t", 2)
            check("last login is real Auth timestamp",
                  f"select (u->>'last_login')::timestamptz='2026-11-17T01:02:03Z'::timestamptz "
                  f"from jsonb_array_elements(public.hierarchy_snapshot({c1})->'users') u where u->>'id'={uid(3)}::text;",
                  "t", 2)
            check("never-signed-in user has null timestamp",
                  f"select u->>'last_login' is null from jsonb_array_elements(public.hierarchy_snapshot({c1})->'users') u "
                  f"where u->>'id'={uid(4)}::text;", "t", 2)
            check("browser cannot query auth users", "select * from auth.users;", user=3, denied=True)
            check("direct public signup denied without invitation",
                  f"insert into auth.users(id,email) values({uid(99)},'invite-only@example.test');",
                  role=None, denied=True)
            check("forged platform metadata cannot bypass signup gate",
                  f"""insert into auth.users(id,email,raw_user_meta_data) values({uid(99)},'invite-only@example.test',
                  '{{"is_platform_admin":true,"invitation_token":"forged"}}');""", role=None, denied=True)
            gate_token = check("create signup invitation through existing Admin RPC",
                  f"select token from public.hierarchy_invite({c1},'invite-only@example.test','technician');", user=3)
            def signup(email="invite-only@example.test", token=gate_token):
                return (f"insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values("
                        f"{uid(99)},'{email}',null,jsonb_build_object('invitation_token','{token}',"
                        f"'company_id',{c2},'is_platform_admin',true));")
            check("wrong-email invitation cannot register", signup("other@example.test"), role=None, denied=True)
            setup(f"update public.user_invitations set expires_at=now()-interval '1 second' where token='{gate_token}';")
            check("expired invitation cannot register", signup(), role=None, denied=True)
            setup(f"update public.user_invitations set expires_at=now()+interval '1 day',revoked_at=now() where token='{gate_token}';")
            check("revoked invitation cannot register", signup(), role=None, denied=True)
            setup(f"update public.user_invitations set revoked_at=null where token='{gate_token}';")
            check("disable issuer", f"select public.hierarchy_set_user({uid(3)},null,'disabled');", user=2)
            check("disabled issuer cannot authorize signup", signup(), role=None, denied=True)
            check("restore issuer", f"select public.hierarchy_set_user({uid(3)},null,'active');", user=2)
            setup(f"update public.companies set is_active=false where id={c1};")
            check("inactive company cannot authorize signup", signup(), role=None, denied=True)
            setup(f"update public.companies set is_active=true where id={c1};")
            check("valid invitation permits Auth account creation", signup(), role=None)
            check("signup token is removed before metadata persistence",
                  f"select not(raw_user_meta_data ? 'invitation_token') from auth.users where id={uid(99)};", "t", role=None)
            check("signup does not assign company from untrusted metadata",
                  f"select count(*) from public.users where id={uid(99)};", "0", role=None)
            check("email must still be verified before joining company",
                  f"select public.accept_invitation('{gate_token}');", user=99, denied=True)
            setup(f"update auth.users set email_confirmed_at=now() where id={uid(99)};")
            check("accept invitation uses existing membership path",
                  f"select public.accept_invitation('{gate_token}')={uid(99)};", "t", 99)
            check("company and platform flag ignore forged metadata",
                  f"select company_id={c1} and not is_platform_admin from public.users where id={uid(99)};", "t", role=None)
            check("accepted invitation cannot create another identity",
                  signup("invite-only@example.test"), role=None, denied=True)
            setup(ROOT / "supabase/migrations/202611170001_exports_invitation_user_management.sql", True)
            check("enhancement rerun preserves invite-only gate",
                  f"insert into auth.users(id,email) values({uid(98)},'raw-signup@example.test');",
                  role=None, denied=True)
            print(f"Hierarchy database tests passed: {passed}")
        finally:
            result = command(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"])
            if result.returncode:
                raise RuntimeError("Could not stop disposable PostgreSQL.")


if __name__ == "__main__":
    main()
