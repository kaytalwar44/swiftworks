# SwiftWorks — Project Inventory

**Generated:** 2026-09-19
**Scope:** Every artefact produced across the schema, RLS, auth, RPC, and application-structure deliverables.
**Status:** 30 files. 28 complete. 2 referenced but not yet written (flagged below).

---

## Summary

| Category | Files | Bytes | Status |
|---|---:|---:|---|
| Schema migrations | 27 | 158,138 | Complete |
| Combined schema | 1 | 163,700 | Complete |
| Documentation | 1 | 27,452 | Complete |
| **Total delivered** | **29** | **349,290** | |
| Design docs (pending) | 2 | — | Not written |
| Build scripts (scratch) | 2 | 8,000 | Working files, not deliverables |

---

## 0. Superseded — delete on import

| # | File | Purpose | Folder |
|---|---|---|---|
| 0.1 | `001_swiftworks_schema.sql` | First-pass single-file schema (companies, roles, users, user_roles, audit_logs). Superseded by migrations `002`–`005`, which carry the later refinements: `companies_id_company_uk`, `roles_id_company_uk`, correctly scoped immutability trigger. **Running it alongside the current set causes duplicate-object errors.** | `database/_superseded/` |

---

## 1. Schema migrations

Each file is independently runnable, numbered for in-order execution. Every table carries UUID PKs, tenant scoping, soft delete (`deleted_at`/`deleted_by`), auditing fields, indexes, FK constraints, and the shared `app.tg_touch_audit()` / `app.tg_write_audit_log()` triggers.

| # | File | Purpose | Folder |
|---|---|---|---|
| 1.1 | `000_prerequisites.sql` | Extensions (`pgcrypto`, `btree_gist`, `pg_trgm`), private `app` schema, 16 enum types, tenancy + permission helper functions, shared audit/immutability triggers. **Must run first.** | `database/migrations/` |
| 1.2 | `001_audit_logs.sql` | Append-only forensic trail. No soft delete, no update policy. Written exclusively by trigger. | `database/migrations/` |
| 1.3 | `002_companies.sql` | Tenant root table. Slug, legal/trading name, ABN, timezone, currency, tax rate, address, JSONB settings and branding. | `database/migrations/` |
| 1.4 | `003_roles.sql` | RBAC roles. `permissions` JSONB array supporting `*` and `prefix.*` wildcards; `company_id` NULL = platform system role. | `database/migrations/` |
| 1.5 | `004_users.sql` | User profiles, 1:1 with `auth.users`. Partner linkage, member type, notification prefs, Microsoft Graph identity fields. | `database/migrations/` |
| 1.6 | `005_user_roles.sql` | Role assignments with optional expiry. Composite FK to `users (id, company_id)`. | `database/migrations/` |
| 1.7 | `006_partners.sql` | Partner organisations. Back-fills the `users.partner_id` FK (circular dependency). | `database/migrations/` |
| 1.8 | `007_technicians.sql` | Field staff. Skills, service areas, per-day capacity, scheduling colour, optional login link. | `database/migrations/` |
| 1.9 | `008_customers.sql` | Residents. Identity is phone + email; denormalised booking and no-show counters. | `database/migrations/` |
| 1.10 | `009_jobs.sql` | One install campaign at one site. Capacity, slot length, working window and days, booking window, publish state. | `database/migrations/` |
| 1.11 | `010_job_technicians.sql` | Job staffing many-to-many. Per-job capacity override, single-lead constraint. | `database/migrations/` |
| 1.12 | `011_qr_codes.sql` | Shareable booking tokens. Job/unit/batch scope, scan and booking limits, lifecycle window, denormalised counters. | `database/migrations/` |
| 1.13 | `012_qr_code_scans.sql` | Scan telemetry for funnel analytics. Trigger maintains `qr_codes.scan_count`. | `database/migrations/` |
| 1.14 | `013_job_slots.sql` | Generated bookable capacity. **GiST exclusion constraints** prevent technician and sequence overlap; `app.slot_claim()` performs the row-locked seat claim. | `database/migrations/` |
| 1.15 | `014_customer_bookings.sql` | Bookings. Partial unique index enforces one live booking per unit; triggers handle QR counters, customer rollup, and slot release on cancel. | `database/migrations/` |
| 1.16 | `015_rate_cards.sql` | Version-dated rate cards. Exclusion constraint prevents overlapping periods per technician; `app.resolve_rate_card()` picks the effective card. | `database/migrations/` |
| 1.17 | `016_rate_card_items.sql` | Priced rate-card lines from CSV/XLSX import or manual entry. Technician pay column drives pay runs. | `database/migrations/` |
| 1.18 | `017_invoices.sql` | Invoices in both directions (payable / receivable). Generated `amount_due` column; external accounting IDs. | `database/migrations/` |
| 1.19 | `018_invoice_items.sql` | Invoice lines. Three generated money columns (`line_subtotal`, `line_tax`, `line_total`) plus a trigger that rolls totals up to the parent invoice. | `database/migrations/` |
| 1.20 | `019_notifications.sql` | Multi-channel outbound queue. `dedupe_key` idempotency, backoff cursor, per-channel delivery state. | `database/migrations/` |
| 1.21 | `020_email_accounts.sql` | Microsoft Graph / Entra ID mailbox config, plus SMTP and API-provider fallback. **Secrets stored by Vault reference only.** | `database/migrations/` |
| 1.22 | `021_email_logs.sql` | Per-message delivery record. Graph message IDs, RFC 5322 message ID, error codes, rolling daily send counter. | `database/migrations/` |
| 1.23 | `022_subscription_plans.sql` | Global plan catalogue. Stripe product/price IDs, entitlements, feature flags. Not tenant-scoped. | `database/migrations/` |
| 1.24 | `023_subscriptions.sql` | Stripe subscription state per company. One live subscription enforced by partial unique index; back-fills `invoices.subscription_id`. | `database/migrations/` |
| 1.25 | `024_auth.sql` | Auth architecture: `auth.users` → `public.users` bridge trigger, invitation-only `handle_new_user()`, `user_invitations` table, `create_tenant()` bootstrap that seeds six roles. | `database/migrations/` |
| 1.26 | `025_rls_policies.sql` | Full RLS layer. Forces RLS on every public table, revokes default grants, four helper predicates, policy generator covering 21 tenant tables, restrictive partner/technician scoping, append-only lock on `audit_logs`. **Must run last.** | `database/migrations/` |
| 1.27 | `026_booking_rpc.sql` | The single anonymous-reachable write path. `app.booking_create()` validates QR/job/window/verification, claims a slot under lock, upserts the customer, writes the booking, queues notifications. Adds `sms_challenges`, `booking_idempotency`, `booking_rate_limit`, `public.create_booking()`, `public.available_slots()`, `public.booking_housekeeping()`. | `database/migrations/` |

---

## 2. Combined schema

| # | File | Purpose | Folder |
|---|---|---|---|
| 2.1 | `swiftworks_master_schema.sql` | All 27 migrations concatenated into one transaction-safe script. Section headers preserve each source filename. Per-file `commit;` statements stripped and replaced with a single trailing COMMIT, so a failure rolls back the entire build. 3,325 lines. | `database/` |

---

## 3. Documentation

| # | File | Purpose | Folder |
|---|---|---|---|
| 3.1 | `project-structure.md` | Complete Next.js 15 App Router folder tree: TypeScript, Tailwind, shadcn/ui, Supabase. Four route groups — `(app)` operator console, `(technician)` mobile shell, `(partner)` portal, `(auth)`/`(marketing)` public — plus the anonymous `/book/[token]` wizard, API route handlers, and `lib/` split by domain. | `docs/` |

---

## 4. Design documents — referenced but not yet written

| # | File | Purpose | Folder |
|---|---|---|---|
| 4.1 | `database-design.md` | Written design rationale: tenancy enforced structurally via composite `(id, company_id)` FKs, why helpers are `SECURITY DEFINER` + `STABLE`, soft-delete semantics, JSONB permission model, audit strategy. Discussed in conversation; never written to a file. | `docs/` |
| 4.2 | `er-diagram.md` | Mermaid entity-relationship diagram covering all 28 tables. Rendered in conversation only. | `architecture/` |

---

## 5. Working files — not deliverables

| # | File | Purpose | Folder |
|---|---|---|---|
| 5.1 | `build-master.js` | Script that assembles the master schema from the migration files. | `scratch/` — exclude from repo |
| 5.2 | `last-run.js` | Auto-saved copy of the second assembly pass. | `scratch/` — exclude from repo |

---

## Recommended repository layout

```
SwiftWorks/
├── database/
│   ├── migrations/
│   │   ├── 000_prerequisites.sql
│   │   ├── 001_audit_logs.sql
│   │   ├── 002_companies.sql
│   │   ├── 003_roles.sql
│   │   ├── 004_users.sql
│   │   ├── 005_user_roles.sql
│   │   ├── 006_partners.sql
│   │   ├── 007_technicians.sql
│   │   ├── 008_customers.sql
│   │   ├── 009_jobs.sql
│   │   ├── 010_job_technicians.sql
│   │   ├── 011_qr_codes.sql
│   │   ├── 012_qr_code_scans.sql
│   │   ├── 013_job_slots.sql
│   │   ├── 014_customer_bookings.sql
│   │   ├── 015_rate_cards.sql
│   │   ├── 016_rate_card_items.sql
│   │   ├── 017_invoices.sql
│   │   ├── 018_invoice_items.sql
│   │   ├── 019_notifications.sql
│   │   ├── 020_email_accounts.sql
│   │   ├── 021_email_logs.sql
│   │   ├── 022_subscription_plans.sql
│   │   ├── 023_subscriptions.sql
│   │   ├── 024_auth.sql
│   │   ├── 025_rls_policies.sql
│   │   └── 026_booking_rpc.sql
│   ├── _superseded/
│   │   └── 001_swiftworks_schema.sql      ← delete or archive
│   └── swiftworks_master_schema.sql
│
├── docs/
│   ├── project-structure.md
│   ├── database-design.md                  ← pending
│   └── project_inventory.md                ← this file
│
└── architecture/
    └── er-diagram.md                       ← pending
```

**Import note:** `database/migrations/` is the source of truth; `swiftworks_master_schema.sql` is a generated convenience for fresh environments. Do not edit the master directly — edits are lost on the next assembly. Change a migration, then regenerate.

---

## Run order

```
000_prerequisites
    ↓
001_audit_logs → 023_subscriptions     (any order within this block;
    ↓                                   cross-dependencies back-filled inline)
024_auth
    ↓
025_rls_policies                        (walks pg_class — must see all tables)
    ↓
026_booking_rpc
```

`000` must run first: every table depends on the `app` schema and enum types. `025` must run last of the DDL sections: it iterates `pg_class` to enable and force RLS on whatever tables exist at that moment.

---

## Inventory totals

```
Migrations              27 files    158,138 bytes
Combined schema          1 file     163,700 bytes
Documentation            1 file      27,452 bytes
─────────────────────────────────────────────────
Delivered               29 files    349,290 bytes

Pending design docs      2 files          —
Superseded               1 file      17,636 bytes
Scratch (excluded)       2 files       8,000 bytes
```

Database objects: **28 tables · 16 enum types · 4 RPCs · 1 public booking function · 17 explicit policies** (plus generated policies from `app.apply_tenant_policies()` covering 21 tenant tables).
