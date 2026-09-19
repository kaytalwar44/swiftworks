swiftworks/
├── .env.example
├── .env.local                          # gitignored
├── .eslintrc.json
├── .gitignore
├── .prettierrc
├── components.json                     # shadcn/ui config
├── middleware.ts                        # Supabase session refresh + route guards
├── next.config.ts
├── package.json
├── postcss.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── README.md
│
├── supabase/
│   ├── config.toml
│   ├── seed.sql
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
│   └── functions/
│       ├── send-notifications/
│       │   └── index.ts                 # Edge Function: drains notifications queue
│       ├── stripe-webhook/
│       │   └── index.ts                 # Edge Function: subscription sync
│       └── graph-delivery-status/
│           └── index.ts                 # Edge Function: polls Graph for bounces
│
├── public/
│   ├── favicon.ico
│   ├── logo.svg
│   ├── logo-mark.svg
│   └── images/
│       └── qr-placeholder.svg
│
└── src/
    ├── app/
    │   ├── layout.tsx                   # root: fonts, providers, Toaster
    │   ├── globals.css
    │   ├── page.tsx                     # marketing landing
    │   ├── not-found.tsx
    │   ├── error.tsx
    │   ├── global-error.tsx
    │   ├── loading.tsx
    │   ├── robots.ts
    │   ├── sitemap.ts
    │   │
    │   ├── (marketing)/
    │   │   ├── layout.tsx
    │   │   ├── pricing/page.tsx
    │   │   ├── features/page.tsx
    │   │   ├── about/page.tsx
    │   │   ├── contact/page.tsx
    │   │   └── legal/
    │   │       ├── terms/page.tsx
    │   │       └── privacy/page.tsx
    │   │
    │   ├── (auth)/
    │   │   ├── layout.tsx
    │   │   ├── login/page.tsx
    │   │   ├── signup/page.tsx
    │   │   ├── forgot-password/page.tsx
    │   │   ├── reset-password/page.tsx
    │   │   ├── verify-email/page.tsx
    │   │   ├── accept-invite/page.tsx
    │   │   └── callback/route.ts        # Supabase OAuth / magic-link exchange
    │   │
    │   ├── (app)/                       # authenticated shell
    │   │   ├── layout.tsx               # sidebar + topbar + tenant context
    │   │   ├── dashboard/
    │   │   │   ├── page.tsx
    │   │   │   ├── loading.tsx
    │   │   │   └── _components/
    │   │   │       ├── stats-cards.tsx
    │   │   │       ├── bookings-today.tsx
    │   │   │       ├── jobs-in-progress.tsx
    │   │   │       ├── upcoming-slots.tsx
    │   │   │       ├── revenue-chart.tsx
    │   │   │       └── activity-feed.tsx
    │   │   │
    │   │   ├── customers/
    │   │   │   ├── page.tsx
    │   │   │   ├── loading.tsx
    │   │   │   ├── new/page.tsx
    │   │   │   ├── import/page.tsx
    │   │   │   └── [id]/
    │   │   │       ├── page.tsx
    │   │   │       ├── edit/page.tsx
    │   │   │       ├── bookings/page.tsx
    │   │   │       └── _components/
    │   │   │           ├── customer-detail.tsx
    │   │   │           ├── booking-history.tsx
    │   │   │           └── customer-form.tsx
    │   │   │
    │   │   ├── partners/
    │   │   │   ├── page.tsx
    │   │   │   ├── loading.tsx
    │   │   │   ├── new/page.tsx
    │   │   │   └── [id]/
    │   │   │       ├── page.tsx
    │   │   │       ├── edit/page.tsx
    │   │   │       ├── jobs/page.tsx
    │   │   │       ├── technicians/page.tsx
    │   │   │       └── _components/
    │   │   │           ├── partner-detail.tsx
    │   │   │           ├── partner-form.tsx
    │   │   │           └── partner-users.tsx
    │   │   │
    │   │   ├── technicians/
    │   │   │   ├── page.tsx
    │   │   │   ├── loading.tsx
    │   │   │   ├── new/page.tsx
    │   │   │   ├── schedule/page.tsx
    │   │   │   └── [id]/
    │   │   │       ├── page.tsx
    │   │   │       ├── edit/page.tsx
    │   │   │       ├── schedule/page.tsx
    │   │   │       ├── rate-cards/page.tsx
    │   │   │       └── _components/
    │   │   │           ├── technician-detail.tsx
    │   │   │           ├── technician-form.tsx
    │   │   │           ├── availability-grid.tsx
    │   │   │           └── workload-summary.tsx
    │   │   │
    │   │   ├── jobs/
    │   │   │   ├── page.tsx
    │   │   │   ├── loading.tsx
    │   │   │   ├── new/
    │   │   │   │   ├── page.tsx
    │   │   │   │   └── _components/
    │   │   │   │       ├── job-wizard.tsx
    │   │   │   │       ├── step-details.tsx
    │   │   │   │       ├── step-site.tsx
    │   │   │   │       ├── step-capacity.tsx
    │   │   │   │       └── step-technicians.tsx
    │   │   │   └── [id]/
    │   │   │       ├── page.tsx
    │   │   │       ├── edit/page.tsx
    │   │   │       ├── slots/page.tsx
    │   │   │       ├── schedule/page.tsx
    │   │   │       ├── bookings/page.tsx
    │   │   │       ├── technicians/page.tsx
    │   │   │       ├── qr/page.tsx
    │   │   │       ├── analytics/page.tsx
    │   │   │       └── _components/
    │   │   │           ├── job-detail.tsx
    │   │   │           ├── job-form.tsx
    │   │   │           ├── job-status-badge.tsx
    │   │   │           ├── slot-generator.tsx
    │   │   │           ├── slot-table.tsx
    │   │   │           ├── slot-board.tsx
    │   │   │           ├── booking-table.tsx
    │   │   │           ├── booking-detail-sheet.tsx
    │   │   │           ├── job-technician-assign.tsx
    │   │   │           ├── scan-funnel.tsx
    │   │   │           └── publish-job-dialog.tsx
    │   │   │
    │   │   ├── qr/
    │   │   │   ├── page.tsx                       # all QR codes
    │   │   │   ├── new/page.tsx
    │   │   │   ├── batch/page.tsx                 # per-unit label sheet
    │   │   │   └── [id]/
    │   │   │       ├── page.tsx
    │   │   │       ├── print/page.tsx             # printable flyer
    │   │   │       └── _components/
    │   │   │           ├── qr-card.tsx
    │   │   │           ├── qr-preview.tsx
    │   │   │           ├── qr-download.tsx
    │   │   │           ├── qr-flyer.tsx
    │   │   │           ├── qr-label-sheet.tsx
    │   │   │           └── qr-rotate-dialog.tsx
    │   │   │
    │   │   ├── bookings/
    │   │   │   ├── page.tsx
    │   │   │   ├── calendar/page.tsx
    │   │   │   ├── today/page.tsx                 # technician run sheet
    │   │   │   └── [id]/
    │   │   │       ├── page.tsx
    │   │   │       └── _components/
    │   │   │           ├── booking-detail.tsx
    │   │   │           ├── complete-install-dialog.tsx
    │   │   │           ├── reschedule-dialog.tsx
    │   │   │           └── cancel-dialog.tsx
    │   │   │
    │   │   ├── rates/
    │   │   │   ├── page.tsx
    │   │   │   ├── new/page.tsx
    │   │   │   ├── import/page.tsx                # CSV / XLSX upload
    │   │   │   └── [id]/
    │   │   │       ├── page.tsx
    │   │   │       ├── items/page.tsx
    │   │   │       └── _components/
    │   │   │           ├── rate-card-detail.tsx
    │   │   │           ├── rate-card-form.tsx
    │   │   │           ├── rate-item-table.tsx
    │   │   │           ├── rate-import-wizard.tsx
    │   │   │           ├── column-mapper.tsx      # maps arbitrary headers
    │   │   │           └── import-preview.tsx
    │   │   │
    │   │   ├── invoices/
    │   │   │   ├── page.tsx
    │   │   │   ├── new/page.tsx
    │   │   │   ├── run/page.tsx                   # generate pay-run invoices
    │   │   │   ├── payable/page.tsx               # technician pay
    │   │   │   ├── receivable/page.tsx            # partner billing
    │   │   │   └── [id]/
    │   │   │       ├── page.tsx
    │   │   │       ├── edit/page.tsx
    │   │   │       └── _components/
    │   │   │           ├── invoice-detail.tsx
    │   │   │           ├── invoice-form.tsx
    │   │   │           ├── invoice-line-table.tsx
    │   │   │           ├── invoice-status-badge.tsx
    │   │   │           ├── invoice-totals.tsx
    │   │   │           ├── invoice-pdf-preview.tsx
    │   │   │           └── pay-run-wizard.tsx
    │   │   │
    │   │   ├── notifications/
    │   │   │   ├── page.tsx
    │   │   │   └── _components/
    │   │   │       ├── notification-list.tsx
    │   │   │       ├── notification-bell.tsx
    │   │   │       └── delivery-log-table.tsx
    │   │   │
    │   │   ├── reports/
    │   │   │   ├── page.tsx
    │   │   │   ├── bookings/page.tsx
    │   │   │   ├── technicians/page.tsx
    │   │   │   ├── partners/page.tsx
    │   │   │   └── _components/
    │   │   │       ├── report-filters.tsx
    │   │   │       ├── report-table.tsx
    │   │   │       └── export-button.tsx
    │   │   │
    │   │   ├── billing/
    │   │   │   ├── page.tsx                       # current plan + usage
    │   │   │   ├── plans/page.tsx
    │   │   │   ├── invoices/page.tsx              # Stripe invoices
    │   │   │   ├── payment-methods/page.tsx
    │   │   │   └── _components/
    │   │   │       ├── plan-card.tsx
    │   │   │       ├── usage-meter.tsx
    │   │   │       ├── plan-compare.tsx
    │   │   │       ├── checkout-button.tsx
    │   │   │       └── billing-portal-button.tsx
    │   │   │
    │   │   └── settings/
    │   │       ├── page.tsx
    │   │       ├── profile/page.tsx
    │   │       ├── company/page.tsx
    │   │       ├── branding/page.tsx
    │   │       ├── users/page.tsx
    │   │       ├── roles/page.tsx
    │   │       ├── notifications/page.tsx
    │   │       ├── email/page.tsx                 # Graph mailbox config
    │   │       ├── integrations/page.tsx
    │   │       ├── audit-log/page.tsx
    │   │       └── _components/
    │   │           ├── profile-form.tsx
    │   │           ├── company-form.tsx
    │   │           ├── branding-form.tsx
    │   │           ├── user-table.tsx
    │   │           ├── invite-user-dialog.tsx
    │   │           ├── role-editor.tsx
    │   │           ├── permission-matrix.tsx
    │   │           ├── email-account-form.tsx
    │   │           └── audit-log-table.tsx
    │   │
    │   ├── (technician)/                   # stripped mobile-first shell
    │   │   ├── layout.tsx
    │   │   ├── today/page.tsx
    │   │   ├── schedule/page.tsx
    │   │   ├── job/[bookingId]/
    │   │   │   ├── page.tsx
    │   │   │   ├── complete/page.tsx
    │   │   │   └── _components/
    │   │   │       ├── job-card.tsx
    │   │   │       ├── check-in-button.tsx
    │   │   │       ├── complete-form.tsx
    │   │   │       ├── photo-upload.tsx
    │   │   │       └── signature-pad.tsx
    │   │   └── earnings/page.tsx
    │   │
    │   ├── (partner)/                      # partner portal shell
    │   │   ├── layout.tsx
    │   │   ├── portal/
    │   │   │   ├── page.tsx
    │   │   │   ├── jobs/
    │   │   │   │   ├── page.tsx
    │   │   │   │   ├── new/page.tsx
    │   │   │   │   └── [id]/
    │   │   │   │       ├── page.tsx
    │   │   │   │       ├── bookings/page.tsx
    │   │   │   │       └── qr/page.tsx
    │   │   │   ├── technicians/page.tsx
    │   │   │   ├── invoices/page.tsx
    │   │   │   └── _components/
    │   │   │       ├── partner-job-form.tsx
    │   │   │       ├── partner-job-list.tsx
    │   │   │       └── partner-qr-panel.tsx
    │   │
    │   ├── book/                           # PUBLIC QR booking flow
    │   │   ├── layout.tsx                  # no auth, no app chrome
    │   │   ├── [token]/
    │   │   │   ├── page.tsx                # entry: QR scan lands here
    │   │   │   ├── loading.tsx
    │   │   │   ├── error.tsx
    │   │   │   ├── slot/page.tsx           # choose a time
    │   │   │   ├── details/page.tsx        # unit, phone, email, comments
    │   │   │   ├── verify/page.tsx         # SMS one-time code
    │   │   │   ├── review/page.tsx
    │   │   │   ├── confirm/page.tsx
    │   │   │   └── _components/
    │   │   │       ├── booking-wizard.tsx
    │   │   │       ├── job-summary.tsx
    │   │   │       ├── slot-picker.tsx
    │   │   │       ├── slot-button.tsx
    │   │   │       ├── details-form.tsx
    │   │   │       ├── sms-verify-form.tsx
    │   │   │       ├── review-summary.tsx
    │   │   │       └── confirmation-card.tsx
    │   │   ├── confirmation/
    │   │   │   └── [bookingRef]/page.tsx   # shareable confirmation link
    │   │   └── manage/
    │   │       └── [bookingRef]/
    │   │           ├── page.tsx            # reschedule / cancel
    │   │           └── _components/
    │   │               ├── manage-booking.tsx
    │   │               ├── reschedule-form.tsx
    │   │               └── cancel-form.tsx
    │   │
    │   └── api/
    │       ├── qr/
    │       │   ├── [token]/route.ts        # resolve QR -> job payload
    │       │   ├── generate/route.ts       # render PNG/SVG
    │       │   └── batch/route.ts          # zip of unit labels
    │       ├── bookings/
    │       │   ├── route.ts                # POST -> create_booking RPC
    │       │   ├── slots/route.ts          # GET available_slots RPC
    │       │   └── [id]/
    │       │       ├── route.ts            # GET / PATCH
    │       │       └── complete/route.ts
    │       ├── sms/
    │       │   ├── start/route.ts
    │       │   └── verify/route.ts
    │       ├── jobs/
    │       │   ├── route.ts
    │       │   └── [id]/
    │       │       ├── route.ts
    │       │       ├── publish/route.ts
    │       │       └── generate-slots/route.ts
    │       ├── rates/
    │       │   ├── import/route.ts         # parse CSV/XLSX
    │       │   └── parse/route.ts          # header detection + preview
    │       ├── invoices/
    │       │   ├── route.ts
    │       │   ├── [id]/pdf/route.ts
    │       │   └── run/route.ts            # batch pay-run
    │       ├── notifications/
    │       │   ├── route.ts
    │       │   └── [id]/read/route.ts
    │       ├── webhooks/
    │       │   ├── stripe/route.ts
    │       │   ├── twilio/route.ts
    │       │   └── graph/route.ts
    │       ├── cron/
    │       │   ├── housekeeping/route.ts   # booking_housekeeping()
    │       │   ├── reminders/route.ts      # day-before reminders
    │       │   └── run-sheets/route.ts     # technician daily digest
    │       └── health/route.ts
    │
    ├── components/
    │   ├── ui/                             # shadcn/ui primitives (generated)
    │   │   ├── accordion.tsx
    │   │   ├── alert-dialog.tsx
    │   │   ├── alert.tsx
    │   │   ├── avatar.tsx
    │   │   ├── badge.tsx
    │   │   ├── breadcrumb.tsx
    │   │   ├── button.tsx
    │   │   ├── calendar.tsx
    │   │   ├── card.tsx
    │   │   ├── checkbox.tsx
    │   │   ├── command.tsx
    │   │   ├── dialog.tsx
    │   │   ├── drawer.tsx
    │   │   ├── dropdown-menu.tsx
    │   │   ├── form.tsx
    │   │   ├── input.tsx
    │   │   ├── label.tsx
    │   │   ├── popover.tsx
    │   │   ├── progress.tsx
    │   │   ├── radio-group.tsx
    │   │   ├── scroll-area.tsx
    │   │   ├── select.tsx
    │   │   ├── separator.tsx
    │   │   ├── sheet.tsx
    │   │   ├── skeleton.tsx
    │   │   ├── slider.tsx
    │   │   ├── sonner.tsx
    │   │   ├── switch.tsx
    │   │   ├── table.tsx
    │   │   ├── tabs.tsx
    │   │   ├── textarea.tsx
    │   │   ├── toast.tsx
    │   │   ├── toaster.tsx
    │   │   ├── tooltip.tsx
    │   │   └── data-table/
    │   │       ├── data-table.tsx
    │   │       ├── data-table-column-header.tsx
    │   │       ├── data-table-pagination.tsx
    │   │       ├── data-table-faceted-filter.tsx
    │   │       ├── data-table-toolbar.tsx
    │   │       └── data-table-view-options.tsx
    │   │
    │   ├── layout/
    │   │   ├── app-sidebar.tsx
    │   │   ├── sidebar-nav.tsx
    │   │   ├── sidebar-user.tsx
    │   │   ├── topbar.tsx
    │   │   ├── breadcrumbs.tsx
    │   │   ├── page-header.tsx
    │   │   ├── mobile-nav.tsx
    │   │   ├── command-menu.tsx
    │   │   ├── tenant-switcher.tsx
    │   │   └── footer.tsx
    │   │
    │   ├── shared/
    │   │   ├── empty-state.tsx
    │   │   ├── error-state.tsx
    │   │   ├── loading-spinner.tsx
    │   │   ├── page-skeleton.tsx
    │   │   ├── copy-button.tsx
    │   │   ├── status-badge.tsx
    │   │   ├── confirm-dialog.tsx
    │   │   ├── file-dropzone.tsx
    │   │   ├── date-range-picker.tsx
    │   │   ├── money.tsx
    │   │   ├── address-block.tsx
    │   │   ├── phone-input.tsx
    │   │   ├── time-window.tsx
    │   │   └── qr-image.tsx
    │   │
    │   ├── charts/
    │   │   ├── bookings-trend.tsx
    │   │   ├── slots-utilisation.tsx
    │   │   ├── technician-workload.tsx
    │   │   ├── revenue-by-partner.tsx
    │   │   └── scan-funnel-chart.tsx
    │   │
    │   └── providers/
    │       ├── theme-provider.tsx
    │       ├── supabase-provider.tsx
    │       ├── query-provider.tsx
    │       └── posthog-provider.tsx
    │
    ├── lib/
    │   ├── supabase/
    │   │   ├── client.ts                   # browser client
    │   │   ├── server.ts                   # RSC / route handler client
    │   │   ├── admin.ts                    # service-role client (server only)
    │   │   ├── middleware.ts               # session refresh helper
    │   │   └── types.ts                    # generated Database types
    │   ├── auth/
    │   │   ├── actions.ts                  # login, signup, reset
    │   │   ├── session.ts                  # getSession, requireAuth
    │   │   ├── permissions.ts              # hasPermission, can()
    │   │   └── guards.ts                   # requireRole, requirePartner
    │   ├── validations/
    │   │   ├── auth.ts
    │   │   ├── booking.ts
    │   │   ├── customer.ts
    │   │   ├── partner.ts
    │   │   ├── technician.ts
    │   │   ├── job.ts
    │   │   ├── rate-card.ts
    │   │   ├── invoice.ts
    │   │   └── settings.ts
    │   ├── booking/
    │   │   ├── create-booking.ts           # calls create_booking RPC
    │   │   ├── available-slots.ts          # calls available_slots RPC
    │   │   ├── reference.ts                # booking ref helpers
    │   │   └── errors.ts                   # maps RPC codes -> copy
    │   ├── qr/
    │   │   ├── generate.ts                 # QR encode -> SVG/PNG
    │   │   ├── token.ts                    # token mint/validate
    │   │   ├── flyer.ts                    # flyer layout
    │   │   └── labels.ts                   # per-unit label sheet
    │   ├── scheduling/
    │   │   ├── slot-generator.ts           # installs_per_day -> slot rows
    │   │   ├── capacity.ts                 # per-technician capacity
    │   │   └── timezone.ts                 # tenant TZ helpers
    │   ├── rates/
    │   │   ├── parse-spreadsheet.ts        # CSV/XLSX -> rows
    │   │   ├── column-mapper.ts            # fuzzy header matching
    │   │   └── resolve-rate-card.ts
    │   ├── invoices/
    │   │   ├── build-invoice.ts
    │   │   ├── pay-run.ts
    │   │   ├── totals.ts
    │   │   └── number.ts
    │   ├── notifications/
    │   │   ├── queue.ts
    │   │   ├── templates.ts
    │   │   └── channels/
    │   │       ├── email-graph.ts          # Microsoft Graph sendMail
    │   │       ├── sms-twilio.ts
    │   │       ├── push.ts
    │   │       └── in-app.ts
    │   ├── billing/
    │   │   ├── stripe.ts
    │   │   ├── entitlements.ts
    │   │   └── usage.ts
    │   ├── audit/
    │   │   └── log.ts
    │   ├── permissions.ts                  # permission string constants
    │   ├── constants.ts
    │   ├── routes.ts                       # typed route map
    │   ├── utils.ts                        # cn() and friends
    │   ├── format.ts                       # dates, money, phone, address
    │   ├── config.ts                       # env parsing
    │   └── errors.ts
    │
    ├── hooks/
    │   ├── use-user.ts
    │   ├── use-company.ts
    │   ├── use-permissions.ts
    │   ├── use-media-query.ts
    │   ├── use-debounce.ts
    │   ├── use-toast.ts
    │   ├── use-bookings.ts
    │   ├── use-slots.ts
    │   ├── use-jobs.ts
    │   ├── use-notifications.ts
    │   └── use-realtime.ts
    │
    ├── types/
    │   ├── database.ts                     # generated Supabase types
    │   ├── supabase.ts
    │   ├── booking.ts
    │   ├── job.ts
    │   ├── customer.ts
    │   ├── partner.ts
    │   ├── technician.ts
    │   ├── invoice.ts
    │   ├── rate-card.ts
    │   ├── notification.ts
    │   ├── billing.ts
    │   ├── auth.ts
    │   └── index.ts
    │
    ├── styles/
    │   └── print.css                       # QR flyer / label print rules
    │
    └── emails/                             # React Email templates
        ├── booking-confirmed.tsx
        ├── booking-reminder.tsx
        ├── booking-cancelled.tsx
        ├── booking-rescheduled.tsx
        ├── technician-schedule.tsx
        ├── invite-user.tsx
        ├── invoice-sent.tsx
        ├── subscription-past-due.tsx
        └── components/
            ├── email-layout.tsx
            ├── email-header.tsx
            ├── email-footer.tsx
            └── email-button.tsx
