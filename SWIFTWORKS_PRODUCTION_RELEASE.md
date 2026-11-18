# Swift Works production release preparation

Target production origin: **https://swiftworks.auss-tech.com.au**

Status: **release candidate prepared; production release is NOT authorized or
ready to execute until the gates below are cleared.** Only an updated Preview
deployment is requested and authorized in this change.

## Candidate and retained scope
- Existing branch: `feat/exports-invitation-user-management`, existing PR #3.
- No new feature branch, no additional banners and no production merge/promotion.
- Removed EXPORT_BRANCH_TEST from Dashboard, Jobs and Bookings and removed the
  temporary Dashboard wrapper. Discarded the earlier unpushed header test marker.
- Retained Jobs, Bookings and Users XLSX exports; company-scoped hierarchy;
  invitation delivery, acceptance and invitation-only signup; user status/details.
- Customer booking, QR generation, public URLs, slots and allocation workflow
  implementations remain unchanged.
- The release candidate is the PR #3 commit containing this checklist and banner
  removal. Record its full SHA and immutable Preview URL in the approval record;
  do not promote an older preview URL or assume the branch alias is immutable.

## Repository/deployment evidence at preparation
- PR #1: Critical security; draft, unmerged; base main.
- PR #2: hierarchy; draft, unmerged; base PR #1 branch.
- PR #3: exports/invitation administration; draft, unmerged; base PR #2 branch.
- Main remained c28531bc53416bea200ae8608ea537c704459817 before this update.
- The public production origin returned HTTPS 200 and the SwiftWorks HTML title.
  This verifies reachability only, not its commit, build settings or domain
  ownership/provider configuration.
- Prior PR previews were automatically deployed by Vercel. The earlier report's
  blanket “not deployed” statement refers only to actions not manually taken:
  automatic Preview deployments did occur. No production release was performed.

## Production origin/configuration checklist
Do not change DNS, environment variables, Auth settings or deployment aliases
without release approval.

| Setting | Required production intent | Verification |
|---|---|---|
| Domain | swiftworks.auss-tech.com.au points to the intended Vercel production project, with valid HTTPS | Provider binding/DNS ownership not audited |
| Frontend VITE_PUBLIC_APP_URL | https://swiftworks.auss-tech.com.au | Source fallback already matches; deployed override unknown |
| Frontend VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY | Intended existing production Supabase project/public configuration only | Deployed values not inspected |
| Edge APP_URL | https://swiftworks.auss-tech.com.au | Production Edge configuration unverified |
| Edge SUPABASE_URL / SUPABASE_ANON_KEY | Same intended existing production Supabase project | Unverified |
| Edge RESEND_API_KEY / INVITE_FROM | Server-only delivery configuration and verified sender | Presence/provider setup unverified |
| Supabase Auth Site URL/redirect allowlist | Production origin and actual invitation/confirmation return paths | Inspect actual configuration and test, no blanket wildcard |
| Build | Fresh application build via npm run build; output dist | Actual provider build/output settings unverified |

Do not rename or substitute VITE_APP_URL for VITE_PUBLIC_APP_URL: the QR/link
code reads the latter. Do not use a Preview hostname for customer booking or
production invitation links. Do not recreate existing booking links/QR codes.
No key values should appear in release records, screenshots or browser bundles.

## Mandatory go/no-go gates
1. **Exact candidate:** PR #3 Preview succeeds for the banner-removal SHA, all
   test markers are absent, and an authorized browser opens the actual app.
2. **Exports:** observe buttons on Jobs/Bookings/Users; download and open all
   three XLSX files. Confirm loaded-row scope and authorized data, including
   empty-data disabled behavior. Prior structural tests are not visual proof.
3. **Live database audit:** inspect actual tables, RLS, grants, indexes,
   functions, Auth triggers, invitation schema, technician links and migrations.
   Check source-missing booking_links and all opaque public/portal RPCs.
4. **Role/invitation regression:** Ultra creates company/Super; Super manages
   own-company Admin/Subcontractor; Admin manages only own-company Subcontractor.
   Deny cross-company/upward/self escalation. Test real invitation mail,
   existing-account retries, email confirmation, expiry/revocation and disabled
   issuer/user behavior; company must come from the stored invite.
5. **Protected business flows:** real anonymous booking without login, existing
   QR/public links, job/slot creation, allocation/reallocation and assigned
   Subcontractor booking visibility. Test actual booking capacity and a logged-in
   Subcontractor opening a public link. Do not rely solely on synthetic fixtures.
6. **Auth trigger compatibility:** inspect existing auth.users triggers and
   provisioning automation. The new INSERT gate intentionally denies account
   creation without invite metadata, including other provisioning channels.
   Keep invited email/password signup working; globally disabling signup would
   break the current invitation path.
7. **Recovery:** verified database backup/restore procedure, current production
   deployment identifier/SHA, inspected prior function definitions/ACLs and
   reviewed rollback SQL. Do not blindly drop security policies or delete data.
8. **Explicit production approval:** approve exact candidate, production
   migration SQL, invitation Edge changes, configuration changes (if any),
   rollout order/window and rollback plan together.

No connected Vercel or Supabase administrative integration was available at
preparation. Protected previews redirect this environment to Vercel sign-in.
These access limitations leave gates open; they are not evidence of success.

## Local validation after banner removal
- 201 focused tests passed: 104 hierarchy/signup database checks, 37 Critical
  database checks, 29 hierarchy/XLSX/source checks and 31 invitation Edge checks.
- Frontend typecheck and fresh temporary-directory production build passed,
  using existing checked-in dependencies, not a clean dependency installation.
- Fresh build contains the XLSX export component and neither temporary marker.
- Application source and tests match the original export feature commit
  1ae248fec9fb3886bd6952a58dac200fa0b3f5d6 after removal.
- These are local/fixture/build results, not live Supabase or browser acceptance.

## Reviewed rollout sequence — execute only after approval
1. Lock the exact candidate SHA; inspect live contracts and clear all gates.
2. Rehearse in isolated staging with the real deployed schema/function
   contracts. Review the three incremental migrations; never replay the master
   schema or infer that missing source definitions do not exist in production.
3. Apply any missing reviewed migrations in chronological order:
   - 202611150001_phase1_critical_security.sql
   - 202611150002_user_hierarchy.sql
   - 202611170001_exports_invitation_user_management.sql
   Check migration history first. This list is not authority to apply SQL.
4. Coordinate frontend, secured invitation Edge deployment/config and database
   changes in the approved window. Old cached clients may lack signup metadata
   or use raw user-management DML, so require refresh and rehearse coexistence.
5. Release the exact approved fresh-built frontend to the existing production
   domain using the provider's reviewed process. Never merely serve the stale
   checked-in dist tree or promote a preview without verifying its environment.
6. Verify deployed frontend SHA, database migrations and Edge version separately.
   A successful Vercel frontend build does not deploy Supabase SQL/Edge code.
7. Smoke-test the production origin and monitor errors, invitations, anonymous
   bookings, slots and assigned booking visibility. Stop/rollback on regression.

The existing PRs are stacked. Do not merge them independently while automatic
production deployment could publish an unreviewed intermediate state. Plan a
coordinated approved integration/promotion of the complete candidate using the
existing branches; no new feature branch is needed or created here.

## Rollback preparation
Record the actual known-good production deployment before release; main's
source SHA alone does not identify the currently served production artifact.
Rollback frontend/Edge and database changes as a coordinated procedure, not a
blind reverse migration. Restore reviewed prior function definitions/grants
where needed. If removing the new Auth gate, install a replacement invitation
control or temporarily disable signup first; removing the gate alone reopens
raw signup. Keep Critical platform-admin protections and all customer data.
Re-run anonymous booking and allocation visibility checks after rollback.
