# Swift Works enhancement implementation and deployment plan

## Scope and implementation order
Base: hierarchy draft PR #2, commit b37ec4cc. This is not deployed production code.

1. Add a shared, dependency-free OOXML XLSX writer and reusable export button.
   Export only the rows already loaded and authorized on the Jobs, Bookings and
   Users pages, in their displayed order. Label this scope explicitly; do not
   imply that a server-limited page contains the entire database. Export no
   passwords, invitation tokens, booking-link tokens or auth metadata.
2. Extend the controlled company-scoped user snapshot with company, created
   date and last login. Last login comes from auth.users.last_sign_in_at inside
   the existing privileged, authorized snapshot—not browser access to auth.
3. Display Name, Email, Company, Role, Status, Created Date and Last Login.
   Present Active/Inactive; map Inactive to existing database `disabled`.
   Existing suspended accounts also display Inactive. Do not introduce enums
   or remove existing status compatibility.
4. Retain server-enforced hierarchy: Ultra provisions companies and Super
   Admins; Super manages own-company Admins/Subcontractors; Admin manages
   own-company Subcontractors. Reuse all existing hierarchy RPCs.
5. Enforce invitation-only auth account creation with a narrowly scoped
   BEFORE INSERT trigger on auth.users. Require a valid pending, unexpired
   invitation matching email, role, active company and current issuer authority.
   The invitation page supplies its token as signup metadata; the trigger
   removes that token before persistence. Membership/company assignment remains
   exclusively in accept_invitation. No public signup UI or unauthenticated
   account creation without an invitation. Existing accounts/sign-in unaffected.
6. Test XLSX ZIP/XML structure and safe literal cells, hierarchy regression,
   authorization of added user data, signup denial cases, typecheck and build.
   Protect workflow handler bodies with source-integrity checks.

## Expected files
- New export utility and export-button component.
- Jobs.tsx and Bookings.tsx: export imports/button only; no workflow changes.
- Users.tsx: display/export/status controls.
- AcceptInvitation.tsx: invitation signup metadata only.
- New additive migration: snapshot replacement and Auth insert gate; no table,
  column, enum, booking RLS, allocation or public booking RPC changes.
- Focused tests, this plan and an implementation results report.

## Risk, deployment gates and rollback
- Exports: low/medium risk; authorized business/contact data downloads require
  the same access and data handling care as the displayed records. Large pages
  use browser memory. No additional unrestricted export endpoint.
- Snapshot: medium risk; inspect live function privileges/owner, auth schema
  and company scoping before production.
- Signup gate: high risk because Auth triggers can block legitimate account
  creation. Rehearse actual email-confirmation, invited-account retry and
  issuer-disable/revocation cases in staging. Inspect all existing auth.users
  triggers first; do not override existing provisioning automation blindly.
- Keep Supabase email/password signup enabled for invitation acceptance:
  the database gate rejects non-invited signup. Disabling all signup would
  also break this invitation path. OAuth/phone/admin account creation without
  matching invitation metadata is intentionally denied by the gate.
- New migration requires the prior Critical and hierarchy migrations. Confirm
  actual deployed functions, tables, grants and roles before applying.
- Protected customer booking, QR/link generation, slots and allocation logic
  must pass live staging regression tests. Source/fixture tests alone do not
  establish this, particularly the source-missing booking_links contracts.
- Publish code for review only. No production migration, Auth configuration,
  real invitation, merge or deployment is authorized by this plan.
- Roll back frontend to the prior hierarchy commit. Restore the prior snapshot
  definition from the reviewed hierarchy migration. Remove ONLY the new signup
  trigger/function in a reviewed transaction if necessary; this reopens raw
  signup, so disable signup temporarily or install a replacement invitation gate
  first. No users/data are deleted. Prior hierarchy/security protections remain.

## Acceptance
- Each requested page downloads a valid .xlsx containing its loaded rows and
  explicit business headers, with user-controlled content stored as text.
- User display/export contains all seven requested fields, never invented login
  timestamps; absent login displays “Never”.
- Cross-company and upward delegation attempts remain denied.
- Direct Auth account creation with no/invalid/expired/revoked/wrong-email invite
  is denied; authorized invite creates an account and preserves existing
  email-verification/company-assignment checks.
- Active/Inactive updates cannot change own, peer-higher or foreign users.
- No protected workflow handler, public booking route or booking URL changed.
- Deployment requires a separate approval after review of tests and live staging.
