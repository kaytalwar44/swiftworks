# Swift Works — Hierarchical User Administration

**Status:** Implemented on a review branch; not deployed or merged.

**Branch:** `feat/hierarchical-user-administration`

**Dependency:** Phase 1 Critical Security branch, `security/phase1-critical-hardening`, revision `5e39a9a4773e6a01e0441b7cdf9cf455f506ae51`.

## Scope and compatibility

Implemented only the approved hierarchy and its authorization/onboarding paths:

- Ultra Admin: protected platform flag; customer-company provisioning and Super Admin invitations.
- Super Admin: existing tenant `owner`; company-scoped Admin/Subcontractor administration.
- Admin: existing `admin` / legacy `company_admin`; same-company Subcontractor administration.
- Subcontractor: existing `technician`; allocated jobs and related bookings only.

No new user system, membership table, asset model or allocation engine was created. There are no new tables, business columns or enum values.

The customer booking page, public routes, job creation/slot/QR/booking-link/allocation screen, booking management screen, technician work portal and invitation acceptance screen are byte-for-byte unchanged from main. Tests enforce this against the pinned source revision.

Customer login was not introduced. Public URLs and QR payload/generation code were not changed. Existing slot creation and allocation function bodies are not replaced by the migration.

## Reused structures

| Concern | Existing structure |
|---|---|
| Identity | Supabase Auth and `public.users` |
| Tenant | `companies`, required `users.company_id` |
| Role and capabilities | `roles`, `user_roles`, existing JSONB permission arrays |
| Invitations | `user_invitations`, existing `/invite/:token` and secured Edge delivery |
| Subcontractor identity | `technicians.user_id` |
| Allocation | `job_technicians` |
| Work and bookings | Existing `jobs`, `job_slots`, `customer_bookings` and portal contracts |

### Source correction and preservation decisions

The actual reviewed enum uses `technician`, not the design document's assumed `contractor` member-type label. Implementation reuses `technician` and rejects an unsupported deployed enum; no enum migration is performed.

Existing Admin permission arrays, including custom operational families and pre-existing wildcards, are retained. Required operational capabilities and `subcontractors.manage` are unioned into Admin role data. No new Admin wildcard is added for newly provisioned companies. Dedicated delegation checks, DML privileges and triggers prevent a retained wildcard from becoming permission to grant higher roles.

Unknown/mixed legacy roles are not automatically promoted or deleted. Only the four supported hierarchy categories can use the authenticated console/work boundary. Existing scheduler, partner, staff, mixed or custom-role accounts must be reviewed and mapped before rollout. Known `company_admin` is treated as Admin, never automatically as Super Admin.

## Affected files

| File | Purpose |
|---|---|
| `supabase/migrations/202611150002_user_hierarchy.sql` | Exact proposed security/data migration, controlled RPCs, guards, restrictive work access and portal wrappers |
| `src/features/auth/hierarchy.ts` | Stable-code labels, deterministic role classification and delegation choices |
| `src/features/auth/providers/auth-provider.tsx` | Reject disabled/unavailable identities and unsupported/conflicting active console roles |
| `src/components/Sidebar.tsx` | Show controlled Users administration to supported managers without granting generic `users.manage` |
| `src/pages/Users.tsx` | Company/role-scoped administration, invitations, status and atomic role changes |
| `src/pages/Technicians.tsx` | Replace hardcoded invitation role ID with controlled invitation and confirmed email delivery |
| `tests/user-hierarchy/fixture.sql` | Synthetic Auth/data/opaque RPC fixtures, deliberately unsafe legacy APIs |
| `tests/user-hierarchy/database_test.py` | Disposable PostgreSQL integration tests using actual checked-in tables/policies |
| `tests/user-hierarchy/hierarchy.test.mjs` | Role/delegation logic and protected-source integrity tests |
| `USER_MANAGEMENT_IMPLEMENTATION.md` | Implementation evidence, limitations and deployment gates |

## Exact SQL and policy review

The complete SQL is in `supabase/migrations/202611150002_user_hierarchy.sql`, delivered separately for review. It was previewed before isolated testing. No production SQL was run.

Main database changes:

- Seed/reuse `owner`, `admin`, `technician` role rows per company without assigning/promoting users automatically.
- Add narrowly scoped `hierarchy_snapshot`, `hierarchy_create_company`, `hierarchy_invite` and `hierarchy_set_user` authenticated operations.
- Protect role definitions and role/invitation delegation even when an existing security-definer API forgets its caller check.
- Restrict direct profile editing to safe personal fields; membership/status/role changes use controlled operations.
- Retain the Critical platform-admin flag guard.
- Revalidate invitation issuer authority, email confirmation and tenant/role when accepting an invitation.
- Preserve technician IDs and allocations when linking invited subcontractors. Ambiguous/conflicting links fail rather than selecting an arbitrary row.
- Add authenticated restrictive policies for jobs, slots, allocations and bookings. Existing permissive operator rules remain necessary; the new policies do not replace public booking functions.
- A subcontractor's read boundary is the current job allocation, not a broad `bookings.read` shortcut or a stale/null booking-level technician ID.
- Require operator allocation authority even through legacy security-definer allocator calls; do not replace allocator business logic.

### Portal wrappers — important deployment detail

The source does not contain the deployed bodies of `technician_portal_jobs()` and `technician_portal_bookings(uuid)`.

Instead of inventing their business logic, the migration obtains their existing argument/default and TABLE-return declarations from PostgreSQL metadata, preserves the original functions under private `app.hierarchy_original_*` names, revokes browser/public execution on those originals and installs authenticated wrappers under the existing public names.

The wrappers enforce active Subcontractor identity and allocation scope. Returned job rows are checked by `job_id`. Returned booking rows are independently checked by `booking_id` against the requested allocated job, so an overbroad original function cannot return another job's rows.

Missing functions, unsupported return shapes or an unexpected booking argument name abort the transaction. The migration is versioned for one application, not intended to be replayed after its wrappers are installed.

Production review must inspect original function bodies, owners, dependencies, field semantics and aliases before deployment. A preserved return type does not prove that every opaque field/nested payload is safe or that every other exposed RPC follows these rules.

## Verification

| Command/check | Result |
|---|---|
| `python tests/user-hierarchy/database_test.py` | 81 passed |
| `node --test tests/user-hierarchy/hierarchy.test.mjs` | 25 passed |
| `python tests/phase1-security/database_test.py` | 37 passed |
| `node --test tests/phase1-security/edge.test.mjs` | 31 passed |
| Frontend `npm run typecheck` | Passed |
| Frontend `npm run build` | Passed |
| Deno check of invitation Edge handler | Passed |
| Value-safe service-role scanner | No privileged matches detected in scanned first-party text |
| `git diff --check` | Passed |

Total focused automated tests: **174**.

The build/typecheck run in a temporary directory using the modified frontend source and existing dependency tree, with generated declarations/bundles excluded from the patch. No dependency upgrades or framework migrations were made.

### What the database tests establish

- Correct canonical and `company_admin` classification.
- Company-scoped delegation, self-promotion/higher-role denial and platform-only company provisioning.
- Controlled suspension/restoration and atomic role changes.
- Raw table and deliberately unsafe security-definer privilege-escalation attempts are denied.
- Admin operational custom/wildcard rights are preserved; new Admins also have required operational capabilities without `users.manage`.
- Cross-company Ultra invitations, verified acceptance, wrong-recipient denial and issuer suspension checks.
- Existing allocated technician IDs are retained when a Subcontractor obtains login access.
- Missing technician linkage returns no work.
- Overbroad synthetic legacy portal outputs are filtered; guessed/unallocated jobs are denied.
- Direct jobs/bookings reads are allocation-scoped.
- Synthetic anonymous booking remains callable and its booking appears to the current assignee.
- Reassignment removes the former assignee's access and grants the new assignee access without changing the fixture allocator definition.
- Missing/unsupported deployed portal metadata aborts and rolls back the migration.

### What these tests do not establish

The fixture uses actual source tables/policies, but synthetic Auth identities and **synthetic public booking/allocation/portal functions** because the real deployed definitions are unavailable.

The fixture explicitly supplies the helper EXECUTE access needed by a working deployment; source phase-file grants are inconsistent. Those fixture grants are not part of the production migration.

The tests do **not** certify live booking capacity, real QR scans, deployed slot behavior, all existing Admin integrations, Auth email configuration, storage/realtime authorization or every exposed production RPC/view. No real customer booking or invitation email was created.

The original Critical migration's 37 tests are a separate regression suite; they are not evidence that every original Critical acceptance expectation remains the complete hierarchy contract.

## Deployment blockers and required preflight

There is no live Supabase administrative/database connection in this environment. This is a concrete release blocker, not evidence that production is secure or ready to deploy.

Before rollout:

1. Verify actual deployed tables/columns/enums, function definitions, RLS/ACLs, owners and project/Edge revisions.
2. Determine whether the Critical Security migration is deployed; this branch depends on it.
3. Review all existing role mappings. Resolve unsupported/mixed roles and ensure every company has an approved Super Admin without auto-promoting users.
4. Review pending invitations, verified-email behavior and duplicate/unlinked technician emails.
5. Inspect actual `booking_links` policies and public booking, slot, allocation and portal RPCs, including aliases/dependencies and any date-window/multiple-technician semantics.
6. Confirm public booking function ownership and RLS interactions, including a logged-in Subcontractor opening a public booking URL. Read-policy changes must not alter public-token behavior.
7. Confirm intended Admin direct/operator workflows, existing permissions and required helper EXECUTE grants in staging.
8. Capture current ACL/role/function definitions and recovery data. Use a trusted migration owner matching the guarded server roles.
9. Rehearse the exact migration and frontend change together. Test an existing printed QR, existing/new public link, anonymous booking, slot capacity and Admin allocation end-to-end.
10. Verify related report/export/storage/realtime surfaces and any security-definer aliases cannot expose unallocated work.
11. Approve production SQL/deployment separately. Do not run a master-schema reset or blanket grants.

Public booking and allocator bodies remain untouched by this patch, but shared authentication and database authorization changed; staging regression is mandatory rather than assumed from source integrity alone.

## Risk and rollback

**Rollout risk: medium–high until production preflight is complete.** The main risks are source/deployment drift, unknown portal dependencies, unsupported legacy-role mappings, invitation email-confirmation configuration and unintended RLS interaction with a deployed public function owner.

- No production deployment was performed.
- Keep current source/SQL revisions and captured role/ACL definitions for a reviewed rollback.
- If user management fails, disable affected management actions; do not restore raw privilege writes.
- If portal wrapping is incompatible, stop rollout. Restore only a reviewed secure portal contract or apply a narrow forward fix; do not reopen overbroad legacy execution.
- Do not drop Critical flag guards or turn off invitation JWT verification.
- Do not rotate booking tokens/URLs, replace technician IDs, reallocate work, alter slots or rewrite customer bookings as rollback actions.
- Never treat a database-schema reset as rollback.

**Next:** Review the pull request and the exact SQL. Release remains blocked on read-only production verification and staging compatibility tests; this report is not deployment approval.
