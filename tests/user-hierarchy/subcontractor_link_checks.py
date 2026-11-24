"""Real PostgreSQL checks in the existing disposable, synthetic hierarchy suite."""


def run(setup, check, sql, uid, root):
    migration = root / "supabase/migrations/202611240001_subcontractor_technician_link.sql"
    c1 = "'10000000-0000-0000-0000-000000000001'"
    c2 = "'10000000-0000-0000-0000-000000000002'"
    before_work = setup("""
      select jsonb_build_array(
        (select jsonb_agg(to_jsonb(t) order by id) from public.jobs t),
        (select jsonb_agg(to_jsonb(t) order by id) from public.job_slots t),
        (select jsonb_agg(to_jsonb(t) order by id) from public.customer_bookings t),
        (select jsonb_agg(to_jsonb(t) order by id) from public.job_technicians t),
        (select jsonb_agg(to_jsonb(t) order by id) from public.invoices t));
    """)
    before_policies = setup("select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p;")

    # Reproduce an ambiguous legacy match: fail atomically rather than guessing.
    setup(f"""insert into public.technicians(company_id,code,full_name,email)
      values({c1},'AMBIGUOUS_8A','Legacy A','user8@example.test'),
            ({c1},'AMBIGUOUS_8B','Legacy B','user8@example.test');""")
    failure = sql(migration, True)
    assert failure.returncode and "ambiguous technician linkage" in failure.stderr, failure.stderr
    assert setup("select to_regprocedure('app.hierarchy_ensure_technician(uuid)') is null;") == "t"
    setup("delete from public.technicians where code in ('AMBIGUOUS_8A','AMBIGUOUS_8B');")
    setup(migration, True)
    check("missing active subcontractor is backfilled",
          f"select count(*) from public.technicians where user_id={uid(8)} and deleted_at is null;",
          "1", role=None)
    technician = setup(f"select id from public.technicians where user_id={uid(8)} and deleted_at is null;")
    check("backfilled subcontractor appears for company Admin",
          f"select count(*) from public.job_assignable_technicians({c1}) where id='{technician}';", "1", 3)
    check("backfilled subcontractor appears for company Super Admin",
          f"select count(*) from public.job_assignable_technicians({c1}) where id='{technician}';", "1", 2)

    # The migration preserves all work, allocation identities, policies and grants.
    after_work = setup("""
      select jsonb_build_array(
        (select jsonb_agg(to_jsonb(t) order by id) from public.jobs t),
        (select jsonb_agg(to_jsonb(t) order by id) from public.job_slots t),
        (select jsonb_agg(to_jsonb(t) order by id) from public.customer_bookings t),
        (select jsonb_agg(to_jsonb(t) order by id) from public.job_technicians t),
        (select jsonb_agg(to_jsonb(t) order by id) from public.invoices t));
    """)
    assert before_work == after_work
    assert before_policies == setup("select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p;")
    before_technicians = setup("select jsonb_agg(to_jsonb(t) order by id) from public.technicians t;")
    setup(migration, True)
    assert before_technicians == setup("select jsonb_agg(to_jsonb(t) order by id) from public.technicians t;")

    check("inactive linked subcontractor is excluded",
          f"select public.hierarchy_set_user({uid(8)},null,'disabled');"
          f"select count(*) from public.job_assignable_technicians({c1}) where id='{technician}';", "0", 3)
    check("reactivation restores the same technician identity",
          f"select public.hierarchy_set_user({uid(8)},null,'active');", user=3)
    check("reactivated subcontractor is selectable",
          f"select count(*) from public.job_assignable_technicians({c1}) where id='{technician}';", "1", 3)
    check("role change to Admin preserves technician but excludes it from picker",
          f"select public.hierarchy_set_user({uid(8)},'admin',null);", user=2)
    check("non-subcontractor linked account is not selectable",
          f"select count(*) from public.job_assignable_technicians({c1}) where id='{technician}';", "0", 2)
    check("restoring subcontractor role reuses technician",
          f"select public.hierarchy_set_user({uid(8)},'technician',null);", user=2)
    check("no duplicate on role changes",
          f"select count(*) from public.technicians where user_id={uid(8)} and deleted_at is null;", "1", role=None)

    setup(f"update public.technicians set is_available=false where id='{technician}';")
    check("status toggle does not override manual unavailability",
          f"select public.hierarchy_set_user({uid(8)},null,'disabled');"
          f"select public.hierarchy_set_user({uid(8)},null,'active');", user=3)
    check("manual availability setting is preserved",
          f"select not is_available from public.technicians where id='{technician}';", "t", role=None)
    setup(f"update public.technicians set is_available=true where id='{technician}';")

    def invite_and_register(n, role="technician"):
        email = f"link-test-{n}@example.test"
        issuer = 3 if role == "technician" else 2
        token = check(f"authorized {role} invitation {n}",
                      f"select token from public.hierarchy_invite({c1},'{email}','{role}');", user=issuer)
        setup(f"""insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
          values({uid(n)},'{email}',now(),jsonb_build_object(
            'invitation_token','{token}','full_name','Link Test {n}'));""")
        return email, token

    email, token = invite_and_register(8001)
    check("invitation acceptance provisions a selectable subcontractor",
          f"select public.accept_invitation('{token}')={uid(8001)};", "t", 8001)
    check("accepted subcontractor has one company-scoped technician",
          f"select count(*) from public.technicians where user_id={uid(8001)} and company_id={c1}"
          " and employment_type='subcontractor' and is_available and deleted_at is null;", "1", role=None)
    check("acceptance retry remains idempotent",
          f"select public.accept_invitation('{token}')={uid(8001)};", "t", 8001)
    check("accepted subcontractor appears in picker",
          f"select count(*) from public.job_assignable_technicians({c1})"
          f" where id in(select id from public.technicians where user_id={uid(8001)});", "1", 3)

    # Same-company email linking retains a technician with historical allocations.
    email2, token2 = invite_and_register(8002)
    legacy = setup(f"""insert into public.technicians(company_id,code,full_name,email)
      values({c1},'LINK_LEGACY_8002','Existing allocated technician','{email2.upper()}')
      returning id;""")
    setup(f"""insert into public.job_technicians(company_id,job_id,technician_id,is_lead)
      values({c1},'50000000-0000-0000-0000-000000000003','{legacy}',false);""")
    check("acceptance links existing case-insensitive email match",
          f"select public.accept_invitation('{token2}')={uid(8002)};", "t", 8002)
    check("existing technician and allocation IDs are preserved",
          f"select exists(select 1 from public.technicians where id='{legacy}' and user_id={uid(8002)})"
          f" and exists(select 1 from public.job_technicians where technician_id='{legacy}');", "t", role=None)
    check("linked subcontractor sees only allocated portal job",
          "select count(*) from public.technician_portal_jobs();", "1", 8002)
    check("linked subcontractor sees bookings for allocated job",
          "select count(*) from public.technician_portal_bookings('50000000-0000-0000-0000-000000000003');",
          "1", 8002)
    check("linked subcontractor cannot see another job",
          "select * from public.technician_portal_bookings('50000000-0000-0000-0000-000000000001');",
          user=8002, denied=True)

    # Assigning a role to an existing non-technician account is the original gap.
    _, admin_token = invite_and_register(8003, "admin")
    check("new Admin accepts invitation",
          f"select public.accept_invitation('{admin_token}')={uid(8003)};", "t", 8003)
    check("Admin does not get a technician record",
          f"select count(*) from public.technicians where user_id={uid(8003)};", "0", role=None)
    check("Super Admin assigns subcontractor role",
          f"select public.hierarchy_set_user({uid(8003)},'technician',null);", user=2)
    check("role assignment automatically provisions technician",
          f"select count(*) from public.technicians where user_id={uid(8003)} and deleted_at is null;", "1", role=None)

    check("foreign company picker denied",
          f"select * from public.job_assignable_technicians({c2});", user=3, denied=True)
    check("subcontractor cannot enumerate assignable people",
          f"select * from public.job_assignable_technicians({c1});", user=8001, denied=True)
    check("anonymous picker denied",
          f"select * from public.job_assignable_technicians({c1});", role="anon", denied=True)
    check("private helper cannot be called from a browser",
          f"select app.hierarchy_ensure_technician({uid(8001)});", user=3, denied=True)

    # A bad match must roll back role assignment, not leave partial provisioning.
    check("prepare role conversion conflict",
          f"select public.hierarchy_set_user({uid(8)},'admin',null);", user=2)
    setup(f"""insert into public.technicians(company_id,code,full_name,email)
      values({c1},'LINK_DUPLICATE_8','Conflicting legacy technician','user8@example.test');""")
    conflict = sql(f"set request.jwt.claim.sub={uid(2)};set role authenticated;"
                   f"select public.hierarchy_set_user({uid(8)},'technician',null);")
    assert conflict.returncode and "22023" in conflict.stderr, conflict.stderr
    assert setup(f"select app.hierarchy_role_for({uid(8)});") == "admin"
    print("PASS: ambiguous role linkage rolls back the complete role change")

    for n, kind in [(8004, "cross-company"), (8005, "archived"), (8006, "other-account")]:
        email, role_token = invite_and_register(n, "admin")
        check(f"prepare {kind} account",
              f"select public.accept_invitation('{role_token}')={uid(n)};", "t", n)
        if kind == "cross-company":
            setup(f"""insert into public.technicians(company_id,user_id,code,full_name,email)
              values({c2},{uid(n)},'LINK_FOREIGN','Foreign technician','{email}');""")
        elif kind == "archived":
            setup(f"""insert into public.technicians(company_id,code,full_name,email,deleted_at)
              values({c1},'LINK_ARCHIVED','Archived technician','{email}',now());""")
        else:
            setup(f"update public.technicians set email='{email}' where user_id={uid(8003)};")
        failure = sql(f"set request.jwt.claim.sub={uid(2)};set role authenticated;"
                      f"select public.hierarchy_set_user({uid(n)},'technician',null);")
        assert failure.returncode and "22023" in failure.stderr, (kind, failure.stderr)
        assert setup(f"select app.hierarchy_role_for({uid(n)});") == "admin"
        print(f"PASS: {kind} technician is never moved, resurrected or stolen")

    setup("delete from public.technicians where code='LINK_DUPLICATE_8';")
    check("restore unambiguous subcontractor",
          f"select public.hierarchy_set_user({uid(8)},'technician',null);", user=2)
    setup(f"update public.user_roles set expires_at=now()-interval '1 second' where user_id={uid(8)};")
    check("expired subcontractor role is excluded dynamically",
          f"select count(*) from public.job_assignable_technicians({c1}) where id='{technician}';", "0", 3)
    setup(f"update public.user_roles set expires_at=null where user_id={uid(8)};")
    setup(f"update public.companies set is_active=false where id={c1};")
    check("inactive company picker denied",
          f"select * from public.job_assignable_technicians({c1});", user=3, denied=True)
    setup(f"update public.companies set is_active=true where id={c1};")
    new_tech = setup(f"select id from public.technicians where user_id={uid(8001)} and deleted_at is null;")
    check("Admin allocates newly accepted subcontractor using the existing allocation RPC",
          "select public.job_assign_technician("
          f"'50000000-0000-0000-0000-000000000001','{new_tech}');", user=3)
    check("newly assigned subcontractor sees the allocated job",
          "select count(*) from public.technician_portal_jobs();", "1", 8001)
    check("newly assigned subcontractor sees the allocated customer bookings",
          "select count(*) from public.technician_portal_bookings('50000000-0000-0000-0000-000000000001');",
          "2", 8001)
    check("Super Admin can use the same unchanged allocation RPC",
          "select public.job_assign_technician("
          f"'50000000-0000-0000-0000-000000000002','{new_tech}');", user=2)
    check("subcontractor sees both allocated jobs and no unallocated third job",
          "select count(*) from public.technician_portal_jobs();", "2", 8001)
    print("PASS: idempotent backfill preserves RLS, work, allocations and existing technician identities")
