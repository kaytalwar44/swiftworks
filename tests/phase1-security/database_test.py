"""Run Phase 1 integration tests in a disposable, socket-only PostgreSQL cluster.

Requires initdb, pg_ctl and psql on PATH. Does not read DATABASE_URL, use a
configured database, create production users, or connect to Supabase.
"""
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
passed = 0


def main():
    global passed
    with tempfile.TemporaryDirectory(prefix="swiftworks-phase1-") as temp:
        temp = Path(temp)
        data, sock = temp / "data", temp / "socket"
        sock.mkdir(mode=0o700)
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        env.update(PGHOST=str(sock), PGPORT="55483", PGUSER="postgres", PGDATABASE="postgres")

        def command(args, **kwargs):
            return subprocess.run(args, env=env, text=True, capture_output=True, **kwargs)

        def sql(query, *, file=False):
            args = ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"]
            return command(args + (["-f", str(query)] if file else ["-c", query]))

        def setup(query, *, file=False):
            result = sql(query, file=file)
            if result.returncode:
                raise RuntimeError(result.stderr)

        def check(name, query, expected=None, denied=False, user=None, role="authenticated"):
            global passed
            prefix = ""
            if user is not None:
                uid = f"30000000-0000-0000-0000-{user:012d}"
                prefix += f"set request.jwt.claim.sub='{uid}';"
            if role:
                prefix += f"set request.jwt.claim.role='{role}'; set role {role};"
            result = sql(prefix + query)
            if denied:
                assert result.returncode and "42501" in result.stderr, (name, result.stderr)
            else:
                assert result.returncode == 0, (name, result.stderr)
                if expected is not None:
                    assert result.stdout.strip() == expected, (name, result.stdout)
            passed += 1
            print("PASS:", name)

        initialized = command(["initdb", "-D", str(data), "-U", "postgres", "-A", "trust",
                               "--no-locale", "-E", "UTF8"])
        if initialized.returncode:
            raise RuntimeError(initialized.stderr)
        started = command(["pg_ctl", "-D", str(data), "-l", str(temp / "postgres.log"),
                           "-o", f"-F -k {sock} -p 55483 -c listen_addresses=''", "-w", "start"])
        if started.returncode:
            raise RuntimeError(started.stderr)
        try:
            setup(HERE / "database_fixture.sql", file=True)
            # Use the exact existing users RLS statements rather than rewriting
            # their behavior in the test. Fixture helpers model only this scope.
            policies = (ROOT / "phase4_rls.sql").read_text()
            policies = policies.split("drop policy if exists users_self_read", 1)[1]
            policies = "drop policy if exists users_self_read" + policies.split("-- No INSERT policy", 1)[0]
            setup(policies)
            migration = ROOT / "supabase/migrations/202611150001_phase1_critical_security.sql"
            setup(migration, file=True)

            own = "'30000000-0000-0000-0000-000000000001'"
            staff = "'30000000-0000-0000-0000-000000000002'"
            foreign = "'30000000-0000-0000-0000-000000000003'"
            platform = "'30000000-0000-0000-0000-000000000006'"
            check("own ordinary profile update succeeds",
                  f"with changed as(update public.users set full_name='Updated' where id={staff} returning id) select count(*) from changed;",
                  "1", user=2)
            check("staff cannot update another profile",
                  f"with changed as(update public.users set full_name='Forbidden' where id={own} returning id) select count(*) from changed;",
                  "0", user=2)
            check("manager can update safe same-tenant profile",
                  f"with changed as(update public.users set full_name='Allowed' where id={staff} returning id) select count(*) from changed;",
                  "1", user=1)
            check("manager cannot update other tenant",
                  f"with changed as(update public.users set full_name='Forbidden' where id={foreign} returning id) select count(*) from changed;",
                  "0", user=1)
            check("ordinary self-elevation rejected",
                  f"update public.users set is_platform_admin=true where id={staff};", denied=True, user=2)
            check("manager self-elevation rejected",
                  f"update public.users set is_platform_admin=true where id={own};", denied=True, user=1)
            check("manager cannot elevate another user",
                  f"update public.users set is_platform_admin=true where id={staff};", denied=True, user=1)
            check("browser platform operator cannot alter protected flag",
                  f"update public.users set is_platform_admin=false where id={platform};", denied=True, user=6)
            check("privileged INSERT rejected by restrictive policy",
                  "insert into public.users(id,company_id,is_platform_admin) values "
                  "('30000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000001',true);",
                  denied=True, user=1)
            check("ordinary permitted INSERT still works",
                  "insert into public.users(id,company_id,is_platform_admin) values "
                  "('30000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000001',false);",
                  user=1)
            for user, target in [(1, own), (2, staff), (6, staff)]:
                check("SECURITY DEFINER flag bypass rejected",
                      f"select public.test_definer_set_admin({target},true);", denied=True, user=user)
            check("trusted maintenance can provision a flag",
                  f"update public.users set is_platform_admin=true where id={staff};"
                  f"select is_platform_admin from public.users where id={staff};",
                  "t", role=None)
            setup(f"update public.users set is_platform_admin=false where id={staff};")
            check("trusted service role can provision a flag",
                  f"update public.users set is_platform_admin=true where id={staff};"
                  f"select is_platform_admin from public.users where id={staff};",
                  "t", role="service_role")
            setup(f"update public.users set is_platform_admin=false where id={staff};")
            check("column grants exclude only protected field",
                  "select has_column_privilege('authenticated','public.users','full_name','UPDATE')"
                  " and not has_column_privilege('authenticated','public.users','is_platform_admin','UPDATE');",
                  "t", role=None)
            check("anonymous profile access rejected", "select * from public.users;", denied=True, role="anon")
            check("anonymous delivery RPC execution rejected",
                  "select * from public.invitation_for_delivery('invitation-1');", denied=True, role="anon")
            check("manager receives authorized stored invitation",
                  "select company_name from public.invitation_for_delivery('invitation-1');", "First Company", user=1)
            check("wildcard manager permission works in its tenant",
                  "select company_name from public.invitation_for_delivery('invitation-2');", "Second Company", user=3)
            for user in [2, 4, 5, 7]:
                check("unprivileged, expired, disabled or foreign-role caller denied",
                      "select * from public.invitation_for_delivery('invitation-1');", denied=True, user=user)
            for token in ["invitation-2", "invitation-3", "invitation-4", "invitation-5",
                          "invitation-6", "nonexistent"]:
                check("foreign, expired, revoked, accepted or invalid invitation hidden",
                      f"select count(*) from public.invitation_for_delivery('{token}');", "0", user=1)
            check("platform operator authorized in own tenant",
                  "select count(*) from public.invitation_for_delivery('invitation-1');", "1", user=6)
            check("platform operator cannot substitute foreign tenant",
                  "select count(*) from public.invitation_for_delivery('invitation-2');", "0", user=6)
            check("inactive company cannot deliver",
                  "select count(*) from public.invitation_for_delivery('invitation-7');", "0", user=8)
            check("service-role-only caller cannot use user delivery RPC",
                  "select * from public.invitation_for_delivery('invitation-1');", denied=True, role="service_role")
            check("RPC has fixed search path and least-privilege EXECUTE",
                  "select prosecdef and proconfig=array['search_path=pg_catalog']"
                  " and has_function_privilege('authenticated',oid,'EXECUTE')"
                  " and not has_function_privilege('anon',oid,'EXECUTE')"
                  " and not has_function_privilege('service_role',oid,'EXECUTE')"
                  " from pg_proc where oid='public.invitation_for_delivery(text)'::regprocedure;",
                  "t", role=None)
            setup(migration, file=True)
            check("migration rerun preserves protection and safe grants",
                  "select has_column_privilege('authenticated','public.users','full_name','UPDATE')"
                  " and not has_column_privilege('authenticated','public.users','is_platform_admin','UPDATE');",
                  "t", role=None)
            setup("revoke update (full_name) on public.users from authenticated;")
            setup(migration, file=True)
            check("rerun never adds a previously absent column privilege",
                  "select not has_column_privilege('authenticated','public.users','full_name','UPDATE')"
                  " and has_column_privilege('authenticated','public.users','status','UPDATE')"
                  " and not has_column_privilege('authenticated','public.users','is_platform_admin','UPDATE');",
                  "t", role=None)
            print(f"Database Phase 1 tests passed: {passed}")
        finally:
            stopped = command(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"])
            if stopped.returncode:
                raise RuntimeError("Disposable PostgreSQL cluster could not be stopped.")


if __name__ == "__main__":
    main()
