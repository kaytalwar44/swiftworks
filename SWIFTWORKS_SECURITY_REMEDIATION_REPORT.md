# Swift Works — Phase 1 Critical Security Remediation Report

**Date:** 15 November 2026

**Base revision:** `c28531bc53416bea200ae8608ea537c704459817`

**Review branch:** `security/phase1-critical-hardening`

**Status:** Repository implementation and isolated verification complete. Not deployed.

## 1. Authorized scope

Implemented only:

1. Critical invitation Edge Function authorization.
2. Critical `is_platform_admin` protection against browser/profile writes.
3. Requested service-role exposure review.

No features, UI redesign, framework migration, table/column redesign, broad refactor, dependency upgrade, general CI rollout, or High/Medium/Low backlog remediation was implemented. Tests are narrowly scoped to these Critical changes.

No production database, Supabase project, Edge Function deployment, secret store or frontend deployment was changed. The SQL below was displayed before applying it to an isolated test database. An initial migration-rerun permission issue was found by tests, corrected with a second displayed SQL preview, and retested successfully.

This report distinguishes code implementation, isolated test evidence and production verification. They are not interchangeable.

## 2. Implementation plans, affected files and risk

### Remediation 1 — Secure invitation delivery

**Plan:** Enable gateway JWT verification; independently verify the bearer identity with Supabase Auth; authorize the caller against current database profile and unexpired `users.manage`/`users.*`/`*` grants; resolve a live same-tenant invitation server-side; send only the stored recipient and content. Reject anonymous, unauthorized and invalid-invitation requests before provider delivery.

**Implemented:**

- `verify_jwt = true` in function configuration.
- Handler requires a correctly shaped Bearer header and a verified Auth user.
- New `public.invitation_for_delivery(text)` requires an active, nondeleted caller and a company.
- RPC allows current permission grants or an existing platform operator, but still limits invitations to the caller's company.
- RPC excludes foreign-tenant, expired, revoked, accepted, inactive-company and invalid-role invitations.
- Existing frontend request shapes remain compatible: extra recipient/role/company/expiry fields are ignored.
- Email recipient, token, role, company and expiry come only from the authorized database result.
- The Edge Function uses the public project key plus caller Authorization header, never a service-role client.
- Caller/session persistence is disabled in the per-request server client.
- Upstream errors fail closed without returning database/provider internals.
- OPTIONS remains available for CORS preflight; it performs no Auth, database or email action.

**Affected files:** `supabase/config.toml`; `supabase/functions/send-invitation/index.ts`; security migration and focused tests listed below.

**Estimated rollout risk:** Medium. Incorrect production role/grant assumptions or gateway signing-key compatibility can prevent valid invitations. Deploy only after metadata/configuration preflight and staging tests. No email is sent during the included tests.

**No unrelated expansion:** This patch does not implement invitation-rate-limit infrastructure, invitation-token storage redesign or the separate technician invitation UX backlog. Existing role/member-code and onboarding inconsistencies remain outside scope.

### Remediation 2 — Protect platform-admin authority

**Plan:** Remove broad browser UPDATE privilege on `users`; preserve only the previously permitted non-protected column updates; deny privileged INSERTs with a restrictive policy; enforce an additional trigger against authenticated/anonymous changes even through security-definer functions.

**Implemented:**

- The migration captures effective authenticated UPDATE privileges per column before revoking broad grants.
- It restores only already-authorized columns other than `is_platform_admin`; it does not grant previously absent profile privileges.
- Explicit UPDATE privilege on `is_platform_admin` is removed from PUBLIC, anon and authenticated.
- A restrictive authenticated INSERT policy requires `is_platform_admin = false`.
- An AFTER INSERT/UPDATE trigger rejects changes to the privileged flag for untrusted roles or requests carrying anon/authenticated JWT roles.
- Trusted database maintenance/server execution remains possible through the explicitly allowed database principals, without a browser JWT role.
- The trigger is security-invoker with a fixed search path. A security-definer routine cannot silently bypass it for a normal browser JWT.
- Existing self/tenant/admin row policies are not broadened or replaced.

**Affected files:** `supabase/migrations/202611150001_phase1_critical_security.sql`; focused SQL fixture/integration tests.

**Estimated rollout risk:** Medium. Existing privilege inheritance, unexpected production function ownership, or a maintenance path that carries an authenticated JWT may affect compatibility. Validate metadata and legitimate workflows before deployment.

**Least-privilege verification:** Local tests imported the exact existing `users` policy statements from `phase4_rls.sql`, used synthetic identity/tenant/permission helpers, and verified own-profile updates, denied other-user/cross-tenant writes, privileged-column denial, privileged INSERT denial and security-definer bypass denial. The fixture explicitly supplies helper access needed for these tests. It is not a replay or validation of every production grant/helper/RLS policy.

The baseline's broader helper-ACL, account-status, technician-scope and other-column concerns are not fixed by this patch. Existing non-protected column rights are preserved, not certified as ideal.

### Remediation 3 — Review service-role exposure

**Plan:** Scan first-party tracked source and browser artifacts without printing credential values; inspect browser environment references and the new Edge client; move a real exposed server credential only if discovered.

**Result:** No service-role JWT, `sb_secret_` credential, private-key header or privileged browser environment reference was detected in the scanned tracked first-party text. The browser client continues to reference only its public project URL/key. The invitation handler adds only server-side `SUPABASE_URL`/`SUPABASE_ANON_KEY` consumption and does not require any service-role credential.

**Affected files:** No browser/secret relocation change was necessary; `tests/phase1-security/service_role_scan.py` records the reproducible check.

**Estimated risk:** Low for the audit itself. A negative pattern scan is not proof about runtime-injected values, obfuscated credentials, repository history, all third-party dependency contents, the live deployed bundle or secret stores.

**Not claimed:** No production secret values or configuration were accessible; the scan cannot certify that production never exposed a key. If separate evidence identifies a real leak, removal plus rotation/revocation and deployment verification will require an approved response. No credential was printed, moved or rotated during this task.

## 3. Exact affected-file inventory

| File | Change |
|---|---|
| `supabase/config.toml` | Enable invitation gateway JWT verification |
| `supabase/functions/send-invitation/index.ts` | Verify caller; use authorized server-derived invitation; retain email template |
| `supabase/migrations/202611150001_phase1_critical_security.sql` | Privileged-column ACLs, trigger, restrictive INSERT policy and authorized invitation RPC |
| `tests/phase1-security/edge.test.mjs` | Focused handler/config tests with mocked Auth/database/provider |
| `tests/phase1-security/database_fixture.sql` | Synthetic disposable database fixture; never production |
| `tests/phase1-security/database_test.py` | Real PostgreSQL integration test runner using a socket-only temporary cluster |
| `tests/phase1-security/service_role_scan.py` | Value-safe first-party credential/browser-reference scan |
| `SWIFTWORKS_SECURITY_REMEDIATION_REPORT.md` | This report, exact SQL, evidence and rollout/rollback limits |

No `src/` file, old master/phase SQL script, package manifest/lockfile, generated declaration, vendored dependency or built frontend artifact is part of the patch.

## 4. Exact SQL changes

The migration below changes authorization objects and privileges only; it adds no table or column. It is not a complete fresh-database schema and must be applied only after validating the existing application schema and production metadata.

```sql
-- Phase 1 only: invitation authorization and platform-admin column protection.
-- Review against production metadata before deployment. Do not run master SQL.
begin;

do $$
declare
  columns_sql text;
begin
  select string_agg(format('%I', attname), ', ' order by attnum)
    into columns_sql
    from pg_attribute
    where attrelid = 'public.users'::regclass
      and attnum > 0 and not attisdropped
      and attname <> 'is_platform_admin'
      and has_column_privilege(
        'authenticated', 'public.users', attname, 'UPDATE');

  revoke update on public.users from public, anon, authenticated;
  revoke update (is_platform_admin) on public.users
    from public, anon, authenticated;

  if columns_sql is not null then
    execute format(
      'grant update (%s) on public.users to authenticated', columns_sql);
  end if;
end $$;

create or replace function app.tg_protect_platform_admin()
returns trigger language plpgsql
set search_path = pg_catalog
as $$
begin
  if (tg_op = 'INSERT' and new.is_platform_admin)
     or (tg_op = 'UPDATE'
         and new.is_platform_admin is distinct from old.is_platform_admin) then
    if current_user not in ('postgres', 'supabase_admin', 'service_role')
       or coalesce(auth.role(), '') in ('anon', 'authenticated') then
      raise exception 'platform administrator changes require trusted server execution'
        using errcode = '42501';
    end if;
  end if;
  return null;
end $$;

revoke all on function app.tg_protect_platform_admin()
  from public, anon, authenticated;

drop trigger if exists trg_users_protect_platform_admin on public.users;
create trigger trg_users_protect_platform_admin
  after insert or update on public.users
  for each row execute function app.tg_protect_platform_admin();

drop policy if exists users_no_platform_admin_insert on public.users;
create policy users_no_platform_admin_insert on public.users
  as restrictive for insert to authenticated
  with check (not is_platform_admin);

create or replace function public.invitation_for_delivery(p_token text)
returns table (
  invitation_id uuid, email text, token text,
  role_code text, company_name text, expires_at timestamptz
)
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare
  caller public.users%rowtype;
begin
  select u.* into caller from public.users u
    where u.id = auth.uid() and u.deleted_at is null
      and u.status::text = 'active';

  if not found or caller.company_id is null then
    raise exception 'invitation delivery forbidden' using errcode = '42501';
  end if;

  if not caller.is_platform_admin and not exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = caller.id
      and ur.company_id = caller.company_id
      and ur.deleted_at is null and r.deleted_at is null
      and (r.company_id = caller.company_id or r.company_id is null)
      and (ur.expires_at is null or ur.expires_at > now())
      and (r.permissions ? '*'
        or r.permissions ? 'users.*'
        or r.permissions ? 'users.manage')
  ) then
    raise exception 'invitation delivery forbidden' using errcode = '42501';
  end if;

  return query
    select i.id, i.email, i.token, coalesce(r.code, 'staff'),
           c.legal_name, i.expires_at
    from public.user_invitations i
    join public.companies c on c.id = i.company_id
    left join public.roles r on r.id = i.role_id and r.deleted_at is null
    where i.token = p_token and i.company_id = caller.company_id
      and i.accepted_at is null and i.revoked_at is null
      and i.expires_at > now() and c.is_active
      and (i.role_id is null or
        (r.id is not null and
          (r.company_id = caller.company_id or r.company_id is null)));
end $$;

revoke all on function public.invitation_for_delivery(text)
  from public, anon, service_role;
grant execute on function public.invitation_for_delivery(text)
  to authenticated;

commit;
```

### Policy/configuration changes, explicitly

```toml
[functions.send-invitation]
verify_jwt = true
```

Added policy:

```sql
create policy users_no_platform_admin_insert on public.users
  as restrictive for insert to authenticated
  with check (not is_platform_admin);
```

The restrictive policy ANDs with existing applicable permissive policies. It does not grant INSERT on its own. UPDATE protection is enforced by column ACLs plus the trigger, not by falsely assuming row-level policies restrict individual fields.

The new security-definer RPC has a fixed `pg_catalog` search path and explicitly qualified relations. PUBLIC, anon and service_role EXECUTE are revoked; only authenticated callers receive explicit EXECUTE. Its owner must be a trusted migration/administrative principal, not a browser-controlled role.

## 5. Test execution and results

| Check | Result | Scope / limitations |
|---|---|---|
| `node --test tests/phase1-security/edge.test.mjs` | **31 passed, 0 failed** | Actual handler transpiled/executed with mocked Auth/RPC/Resend; no live network/provider delivery |
| `python tests/phase1-security/database_test.py` | **37 passed, 0 failed** | Actual migration and original source users-policy statements in disposable PostgreSQL 16.15 |
| `deno check --no-config --no-lock --node-modules-dir=none supabase/functions/send-invitation/index.ts` | **Passed** | Deno typecheck with real npm import resolution; not a gateway or deployment test |
| `npm run typecheck` | **Passed** | Unchanged frontend snapshot in a temporary build directory with existing checked-in dependencies |
| `npm run build` | **Passed** | Vite production compilation of unchanged frontend; no generated artifact committed or deployed |
| `python tests/phase1-security/service_role_scan.py` | **Passed** | No privileged patterns/references detected; output reports counts, paths and finding types only |
| `git diff --check` | **Passed** | Patch whitespace/format validation |

The first Deno command without isolation flags could not resolve the existing `npm:resend` import from the frontend's node_modules layout. The documented command isolates Deno dependency resolution and passes; no package manifest or dependency version was changed.

### Security cases exercised

- Missing/malformed bearer identity and unverified/expired/service-only identities.
- No provider action on authentication, authorization or payload failure.
- Authenticated but nonmanager, expired grant, disabled caller and foreign-role assignment.
- Same-tenant manager and existing platform operator; platform operator still cannot substitute another company's invitation.
- Cross-tenant, nonexistent, expired, revoked, accepted and role-mismatched invitation.
- Inactive company.
- Body-tampered recipient/company/role/expiry ignored in favor of authorized SQL data.
- Safe ordinary profile updates remain possible; other-user/cross-tenant writes are denied by original policy behavior.
- Self-elevation, manager elevation, browser platform-operator flag changes and privileged INSERTs denied.
- Authenticated requests through a deliberately permissive test-only security-definer function cannot change the flag.
- Trusted maintenance/service-role provisioning remains possible.
- Function search path and RPC EXECUTE ACL verified from PostgreSQL catalogs.
- Migration rerun retains safe existing grants and never adds a previously absent column privilege.
- Missing server configuration and upstream exceptions fail closed; HTML company markup remains escaped.

The disposable database runner removes PG connection variables from its environment and creates its own Unix-socket-only temporary database. It does not consume `DATABASE_URL`, connect to Supabase or persist test users.

## 6. Service-role audit methodology and limits

The scanner enumerates first-party tracked text with `git ls-files`, including `src/`, `public/`, checked-in `dist/`, SQL and configuration. It excludes vendored `node_modules` and binary content.

It identifies:

- JWT-shaped strings whose decoded payload role is `service_role`.
- Server-secret token prefixes.
- Private-key headers.
- Privileged environment-variable references in browser source/artifacts.

It does not print matched credential values. An absence of matches is scoped to those rules and files; it is not a universal secret detector. Existing public anon-key use is not treated as service-role exposure.

The final scan count may include this report/tests after staging; file counts are not an exposure metric. No relocation was performed because no exposed credential was identified. Resend remains server-side; the new invitation authorization path intentionally needs no service-role key.

## 7. Deployment prerequisites — not performed

Before approving production execution:

1. Identify the actual production Supabase project and deployed frontend/Edge revision.
2. Compare the migration's referenced columns/types with live metadata. Confirm effective grants, inherited privileges, triggers, original policies and trusted function ownership.
3. Verify the deployed Edge gateway supports JWT verification for the project's actual signing-key setup. Do not disable verification as a workaround.
4. Confirm server-side variable names/configuration status: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `RESEND_API_KEY`, `APP_URL`, `INVITE_FROM`. Do not disclose values.
5. Validate the current role permission representation and status enum. This patch assumes the checked-in `active` status, JSONB permission arrays and role-assignment expiry columns.
6. Capture the exact pre-change ACL/policy/function definitions and verify recovery capability.
7. Rehearse this additive migration and the Edge deployment together in staging; verify existing ordinary profile and authorized invitation flows.
8. Review the exact production SQL and separately approve execution. Apply the additive security migration before deploying the handler that depends on its RPC.
9. Deploy the secured handler/config without a frontend redesign or API-body change.
10. Perform approved post-deployment read-only/catalog checks and a separately authorized controlled functional test. Verify anonymous/unauthorized callers cannot send and an approved manager can send only the intended invitation.

Because production access is unavailable, no claim is made that deployed RLS is now least-privileged or that either Critical production risk is resolved.

## 8. Rollback and containment

- Do not restore `verify_jwt = false`, arbitrary-recipient delivery or unrestricted flag-update privileges.
- If invitation authorization/configuration fails after an approved deployment, disable delivery or return a clear unavailable result; keep invitation records and server-side authorization protections. Do not roll back to the insecure handler.
- Keep the additive RPC available for compatible clients while correcting the secured implementation forward.
- If profile updates regress, repair the non-protected column allowlist using captured prior rights; keep the protected-column denial and trigger. Temporary loss of profile editing is safer than restoring escalation.
- Do not automatically delete audit/identity records or change existing platform-admin flags. Evidence of an already unauthorized grant requires a separate approved incident response.
- Existing sent messages cannot be unsent. No production message was sent by this task.
- There is deliberately no automatic “down migration” that reopens the vulnerability. Any emergency production change must be reviewed against the captured deployed state.

## 9. Remaining scope and approval

The source implementation is complete for the authorized Critical changes. Production verification/deployment is pending. All unrelated backlog items remain unimplemented, including broader account disabling, technician isolation, ledger RLS, cache isolation, transaction redesign, pagination, CI rollout, role/member UX reconciliation and schema-baseline cleanup.

The invitation RPC checks active status/expiry only for its own required authorization; this is not a global High-priority account-status or role-system remediation.

**Main has not been changed by this patch. No merge, production SQL application or deployment is authorized by this report.**
