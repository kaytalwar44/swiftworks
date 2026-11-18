# Swift Works enhancements — implementation report

## Delivery status
Implemented on a separate review branch based on the unmerged hierarchy draft.
Not merged, deployed or applied to live Supabase. No production users, bookings,
invitations or Auth configuration were changed.

Read SWIFTWORKS_ENHANCEMENT_PLAN.md before any deployment.

## Implemented behavior

| Area | Implemented result |
|---|---|
| Jobs | XLSX export of currently loaded job rows, preserving display order |
| Bookings | XLSX export of currently loaded bookings in displayed chronological order |
| Users | XLSX export of the authorized selected-company snapshot |
| Hierarchy | Reuses prior Ultra → Super → Admin → Subcontractor controlled RPCs |
| Companies | Ultra retains company creation and selected-company Super Admin invitations |
| Company isolation | Existing server-side delegation and snapshot filters retained |
| Registration | Auth account creation requires valid invitation metadata, checked in database |
| Company assignment | Existing accept_invitation assigns company/role from stored invitation only |
| User display | Name, Email, Company, Role, Status, Created Date, Last Login |
| User status | Active / Inactive; existing active / disabled stored values retained |

Ultra retains existing ability to manage lower roles as well. Super Admin cannot
create a peer Super Admin or access another company. Admin can invite/manage only
Subcontractors. No second user system or role enum was introduced.

Suspended/disabled accounts display Inactive; setting active restores the
existing active status. Existing disabled-account portal denial is tested.
Self, peer-higher and foreign-company access changes remain denied.

Last Login comes from auth.users.last_sign_in_at through the authorized
SECURITY DEFINER snapshot. Null displays Never. Created Date is the existing
public profile created_at. Dates display in the browser's locale timezone and
export as original ISO timestamp strings.

## Excel export scope and safety
- Genuine OOXML .xlsx, not CSV renamed as XLSX.
- Uses only rows already loaded through existing page queries/RLS or the
  controlled Users snapshot; no new queries, service-role key or privileged
  export endpoint.
- Buttons explicitly say “Export loaded rows”; no guarantee of all historical
  database rows beyond Supabase's response limits.
- User content is escaped XML stored as literal string cells, never formulas,
  external hyperlinks or macros. Phone/postcode/leading-zero strings stay text.
- No booking/invitation token, public booking URL, password or Auth metadata is
  exported. User exports include only the requested seven business fields.
- Disabled while loading/empty; export errors shown; object URLs released.
- No new dependency/package/lockfile changes. A small stored-ZIP/OOXML writer
  is shared by all three pages. XLSX validation is structural, not a manual
  Microsoft Excel/LibreOffice application test.
- Browser-memory export is intended for normal loaded page sizes. Excel row,
  column and cell limits reject oversized data rather than silently truncating.

## Invitation-only security mechanism
The new additive migration installs trg_hierarchy_invitation_signup BEFORE INSERT
on auth.users. It requires:
- Pending, unexpired, unrevoked invitation matching the new account email.
- Active company and valid tenant role.
- Currently authorized invitation issuer.

The invitation page passes its existing URL token to signup metadata. The
database removes that token before storing the Auth row. Arbitrary company or
platform-admin metadata grants no membership/authority. Email verification and
the existing accept_invitation authorization remain required before membership.
Account creation does not itself create a company profile.

This gate covers raw Auth calls, including uninvited admin/OAuth/phone/anonymous
account creation. Existing accounts are not affected by an INSERT-only trigger.
Signup must stay enabled for valid invitations; disabling signup globally would
break the existing invitation acceptance mechanism.

High-risk deployment dependency: inspect actual Auth triggers/ownership and
provisioning integrations first. Unknown live trigger ordering and live Auth
behavior have not been inspected or tested. The frontend must support passing
the invitation token before enabling the gate; existing open invite links keep
their URLs and work with the updated page.

## Protected workflows
No changes to public booking route/component, public URLs, QR generator,
booking-link generation, slot-creation or job-allocation handlers.

Jobs/Bookings changes are additive export imports/buttons only. Removing exactly
those additions reproduces their prior main-branch source byte-for-byte. The
invitation page differs only by the signup metadata addition. App routes,
BookingPage, JobCreate and TechnicianPortal remain byte-identical.

The new migration does not change booking-related RLS, public booking RPCs,
technician allocator implementations, slot tables or link tables. Previous
hierarchy protections remain in force.

## Affected files relative to hierarchy draft
- src/lib/export-xlsx.ts
- src/components/shared/export-button.tsx
- src/pages/Jobs.tsx
- src/pages/Bookings.tsx
- src/pages/Users.tsx
- src/pages/AcceptInvitation.tsx
- supabase/migrations/202611170001_exports_invitation_user_management.sql
- tests/user-hierarchy/database_test.py
- tests/user-hierarchy/hierarchy.test.mjs
- tests/user-hierarchy/export.test.mjs
- SWIFTWORKS_ENHANCEMENT_PLAN.md
- SWIFTWORKS_ENHANCEMENT_REPORT.md

No booking policy changes, new table/column/enum, package changes or unrelated
refactoring are included.

## Validation

| Check | Result |
|---|---|
| Hierarchy + enhanced database integration tests | 104 passed |
| Hierarchy/source integrity + XLSX tests | 29 passed |
| Earlier Critical-security database tests | 37 passed |
| Earlier invitation Edge handler tests | 31 passed |
| Total focused assertions/tests | 201 passed |
| Frontend typecheck | Passed |
| Frontend production build | Passed |
| Diff whitespace check | Passed |
| Privileged credential scan | Passed; no secret values printed |

Database tests run in a disposable local PostgreSQL cluster, loading actual
source schemas/policies with synthetic Auth identities and synthetic otherwise
unavailable portal/public-booking/allocator routines. They verify new signup
denials for missing/forged/wrong-email/expired/revoked/consumed invitations,
inactive company/issuer, preservation of email verification, automatic company
assignment, timestamp accuracy, cross-company denial, migration dependency and
rerun behavior, and the earlier allocation/public booking security regressions.

XLSX tests independently parse ZIP CRCs, all XML entries, workbook relationships,
Unicode/escaping, literal formula-like inputs, leading zero text, numeric/boolean
types and size rejection.

Build uses existing checked-in node_modules from a temporary build directory,
with the repository's actual Vite/Tailwind/PostCSS config. It is not a fresh
dependency-install reproducibility check.

## Required before deployment
1. Review this additive SQL and the preceding two draft migrations together.
2. Inspect live Supabase catalog, grants, Auth triggers, role mappings and
   existing provisioning paths. No live administrative access was available.
3. Rehearse invited signup, existing-account retries, confirmation redirects,
   revoked/expired links and denied raw signup against actual staging Auth.
4. Validate true QR/booking-link actions against the deployed booking_links
   definition. Earlier fixture qr_codes tests do NOT validate that UI path.
5. Exercise actual anonymous public links, slot selection/capacity, customer
   booking creation and assigned-Subcontractor visibility; also test a logged-in
   Subcontractor opening a public booking link. Opaque portal wrappers cannot
   restore bookings omitted by the original deployed function.
6. Open exports in an actual spreadsheet application, verify contact-data
   handling and confirm loaded-row scope meets operational needs.
7. Obtain separate deployment approval. No CI/live/browser end-to-end result is
   claimed by these local checks.

## Rollback
Restore the prior hierarchy frontend and prior hierarchy_snapshot definition.
In a reviewed transaction, remove only the new Auth invitation trigger/function
after arranging a replacement invitation gate or temporarily disabling signup.
Removing the gate alone would permit raw account creation again. Do not revert
the preceding Critical/hierarchy protections or delete any users/customer data.
