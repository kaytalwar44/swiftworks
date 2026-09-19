-- =============================================================================
-- phase2_tables.sql
-- SwiftWorks — Phase 2: Core Tables
--
-- Contains ONLY base tables: columns, defaults, checks, primary keys, foreign
-- keys, unique constraints, and indexes.
--
-- Deliberately EXCLUDES:
--   * RLS policies            (Phase 8)
--   * Triggers                (Phase 7-b / deferred)
--   * Booking procedures      (Phase 9)
--   * Helper functions        (already created by bootstrap.sql)
--
-- Prerequisite: bootstrap.sql has been run (schemas, extensions, app enum
-- types, helper functions).
--
-- Ordering is dependency-driven. Forward FKs that would create a cycle are
-- added as ALTER TABLE statements at the end of the file.
-- =============================================================================

begin;

-- =============================================================================
-- 1. COMPANIES — tenant root
-- =============================================================================
create table if not exists public.companies (
  id                 uuid primary key default extensions.gen_random_uuid(),
  slug               text        not null check (slug ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$'),
  legal_name         text        not null check (length(btrim(legal_name)) > 0),
  trading_name       text,
  abn                text,
  email              text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text,
  website            text,
  logo_url           text,
  timezone           text        not null default 'Australia/Sydney',
  currency           char(3)     not null default 'AUD',
  locale             text        not null default 'en-AU',
  default_tax_rate   numeric(5,4) not null default 0.1000
                       check (default_tax_rate >= 0 and default_tax_rate < 1),
  address_line1      text,
  address_line2      text,
  suburb             text,
  state              text,
  postcode           text,
  country            char(2)     not null default 'AU',
  settings           jsonb       not null default '{}'::jsonb,
  branding           jsonb       not null default '{}'::jsonb,
  onboarding_status  text        not null default 'pending'
                       check (onboarding_status in ('pending','in_progress','complete')),
  is_active          boolean     not null default true,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  deleted_at         timestamptz,
  deleted_by         uuid
);

create unique index if not exists companies_slug_uidx
  on public.companies (lower(slug)) where deleted_at is null;
create index if not exists companies_active_idx
  on public.companies (is_active) where deleted_at is null;
create index if not exists companies_name_trgm_idx
  on public.companies using gin (legal_name extensions.gin_trgm_ops);

-- =============================================================================
-- 2. ROLES
-- =============================================================================
create table if not exists public.roles (
  id           uuid primary key default extensions.gen_random_uuid(),
  company_id   uuid references public.companies(id) on delete cascade,
  code         text        not null check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         text        not null,
  description  text,
  permissions  jsonb       not null default '[]'::jsonb,
  is_system    boolean     not null default false,
  rank         int         not null default 100,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  deleted_at   timestamptz,
  deleted_by   uuid,
  constraint roles_permissions_is_array check (jsonb_typeof(permissions) = 'array'),
  constraint roles_id_company_uk unique (id, company_id)
);

create unique index if not exists roles_scoped_code_uidx
  on public.roles (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(code))
  where deleted_at is null;
create index if not exists roles_company_idx on public.roles (company_id) where deleted_at is null;
create index if not exists roles_rank_idx    on public.roles (company_id, rank) where deleted_at is null;
create index if not exists roles_perms_idx   on public.roles using gin (permissions);

-- =============================================================================
-- 3. USERS
-- =============================================================================
create table if not exists public.users (
  id                 uuid primary key references auth.users(id) on delete cascade,
  company_id         uuid        not null references public.companies(id) on delete restrict,
  partner_id         uuid,
  email              text        not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name          text,
  first_name         text,
  last_name          text,
  phone              text,
  avatar_url         text,
  job_title          text,
  status             app.user_status not null default 'invited',
  member_type        app.member_type not null default 'staff',
  is_platform_admin  boolean     not null default false,
  timezone           text        not null default 'Australia/Sydney',
  locale             text        not null default 'en-AU',
  notification_prefs jsonb       not null default '{"email":true,"sms":true,"push":true,"in_app":true}'::jsonb,
  ms_graph_user_id   text,
  ms_upn             text,
  last_seen_at       timestamptz,
  invited_at         timestamptz,
  accepted_at        timestamptz,
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id),
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id),
  constraint users_id_company_uk unique (id, company_id)
);

create unique index if not exists users_company_email_uidx
  on public.users (company_id, lower(email)) where deleted_at is null;
create index if not exists users_company_idx     on public.users (company_id) where deleted_at is null;
create index if not exists users_status_idx      on public.users (company_id, status) where deleted_at is null;
create index if not exists users_member_type_idx on public.users (company_id, member_type) where deleted_at is null;
create index if not exists users_partner_idx     on public.users (partner_id)
  where partner_id is not null and deleted_at is null;
create index if not exists users_ms_graph_idx    on public.users (ms_graph_user_id)
  where ms_graph_user_id is not null;
create index if not exists users_name_trgm_idx   on public.users using gin (full_name extensions.gin_trgm_ops);

-- =============================================================================
-- 4. USER_ROLES
-- =============================================================================
create table if not exists public.user_roles (
  id          uuid primary key default extensions.gen_random_uuid(),
  company_id  uuid        not null references public.companies(id) on delete cascade,
  user_id     uuid        not null,
  role_id     uuid        not null references public.roles(id) on delete cascade,
  granted_at  timestamptz not null default now(),
  granted_by  uuid references public.users(id) on delete set null,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id) on delete set null,
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id) on delete set null,
  constraint user_roles_user_fk foreign key (user_id, company_id)
    references public.users (id, company_id) on delete cascade
);

create unique index if not exists user_roles_unique_uidx on public.user_roles (user_id, role_id) where deleted_at is null;
create index if not exists user_roles_company_idx on public.user_roles (company_id) where deleted_at is null;
create index if not exists user_roles_role_idx    on public.user_roles (role_id) where deleted_at is null;
create index if not exists user_roles_user_idx    on public.user_roles (user_id) where deleted_at is null;
create index if not exists user_roles_expiry_idx  on public.user_roles (expires_at)
  where expires_at is not null and deleted_at is null;

-- =============================================================================
-- 5. PARTNERS
-- =============================================================================
create table if not exists public.partners (
  id                   uuid primary key default extensions.gen_random_uuid(),
  company_id           uuid        not null references public.companies(id) on delete restrict,
  code                 text        not null check (code ~ '^[A-Za-z0-9_-]{2,32}$'),
  name                 text        not null check (length(btrim(name)) > 0),
  legal_name           text,
  trading_name         text,
  abn                  text,
  contact_name         text,
  contact_email        text        check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone        text,
  billing_email        text        check (billing_email is null or billing_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  portal_enabled       boolean     not null default true,
  default_rate_card_id uuid,
  payment_terms_days   int         not null default 14 check (payment_terms_days >= 0 and payment_terms_days <= 365),
  address_line1        text,
  address_line2        text,
  suburb               text,
  state                text,
  postcode             text,
  country              char(2)     not null default 'AU',
  notes                text,
  settings             jsonb       not null default '{}'::jsonb,
  is_active            boolean     not null default true,
  created_at           timestamptz not null default now(),
  created_by           uuid references public.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.users(id) on delete set null,
  deleted_at           timestamptz,
  deleted_by           uuid references public.users(id) on delete set null,
  constraint partners_id_company_uk unique (id, company_id)
);

create unique index if not exists partners_company_code_uidx
  on public.partners (company_id, lower(code)) where deleted_at is null;
create index if not exists partners_company_idx on public.partners (company_id) where deleted_at is null;
create index if not exists partners_active_idx  on public.partners (company_id, is_active) where deleted_at is null;
create index if not exists partners_name_trgm_idx on public.partners using gin (name extensions.gin_trgm_ops);

-- Forward FK: users.partner_id -> partners(id)
alter table public.users drop constraint if exists users_partner_fk;
alter table public.users add constraint users_partner_fk
  foreign key (partner_id) references public.partners(id) on delete set null;

-- =============================================================================
-- 6. TECHNICIANS
-- =============================================================================
create table if not exists public.technicians (
  id                   uuid primary key default extensions.gen_random_uuid(),
  company_id           uuid        not null references public.companies(id) on delete restrict,
  partner_id           uuid        references public.partners(id) on delete set null,
  user_id              uuid        references public.users(id) on delete set null,
  code                 text        not null check (code ~ '^[A-Za-z0-9_-]{1,32}$'),
  full_name            text        not null check (length(btrim(full_name)) > 0),
  email                text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone                text,
  abn                  text,
  employment_type      text        not null default 'contractor'
                         check (employment_type in ('employee','contractor','subcontractor')),
  skills               text[]      not null default '{}',
  service_areas        text[]      not null default '{}',
  max_installs_per_day int         not null default 8 check (max_installs_per_day > 0 and max_installs_per_day <= 50),
  colour               text        check (colour is null or colour ~* '^#[0-9a-f]{6}$'),
  is_available         boolean     not null default true,
  rating               numeric(3,2) check (rating is null or (rating >= 0 and rating <= 5)),
  notes                text,
  metadata             jsonb       not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  created_by           uuid references public.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.users(id) on delete set null,
  deleted_at           timestamptz,
  deleted_by           uuid references public.users(id) on delete set null,
  constraint technicians_id_company_uk unique (id, company_id)
);

create unique index if not exists technicians_company_code_uidx
  on public.technicians (company_id, lower(code)) where deleted_at is null;
create unique index if not exists technicians_user_uidx
  on public.technicians (user_id) where user_id is not null and deleted_at is null;
create index if not exists technicians_company_idx   on public.technicians (company_id) where deleted_at is null;
create index if not exists technicians_partner_idx   on public.technicians (partner_id) where deleted_at is null;
create index if not exists technicians_available_idx on public.technicians (company_id, is_available) where deleted_at is null;
create index if not exists technicians_skills_idx    on public.technicians using gin (skills);
create index if not exists technicians_areas_idx     on public.technicians using gin (service_areas);
create index if not exists technicians_name_trgm_idx on public.technicians using gin (full_name extensions.gin_trgm_ops);

-- =============================================================================
-- 7. CUSTOMERS
-- =============================================================================
create table if not exists public.customers (
  id                 uuid primary key default extensions.gen_random_uuid(),
  company_id         uuid        not null references public.companies(id) on delete restrict,
  email              text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text,
  full_name          text,
  first_name         text,
  last_name          text,
  unit_number        text,
  address_line1      text,
  address_line2      text,
  suburb             text,
  state              text,
  postcode           text,
  country            char(2)     not null default 'AU',
  marketing_opt_in   boolean     not null default false,
  sms_opt_in         boolean     not null default false,
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  first_seen_at      timestamptz not null default now(),
  last_booking_at    timestamptz,
  booking_count      int         not null default 0 check (booking_count >= 0),
  no_show_count      int         not null default 0 check (no_show_count >= 0),
  notes              text,
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.users(id) on delete set null,
  deleted_at         timestamptz,
  deleted_by         uuid references public.users(id) on delete set null,
  constraint customers_id_company_uk unique (id, company_id)
);

create unique index if not exists customers_company_phone_uidx
  on public.customers (company_id, phone) where phone is not null and deleted_at is null;
create unique index if not exists customers_company_email_uidx
  on public.customers (company_id, lower(email)) where email is not null and deleted_at is null;
create index if not exists customers_company_idx   on public.customers (company_id) where deleted_at is null;
create index if not exists customers_phone_idx     on public.customers (company_id, phone) where deleted_at is null;
create index if not exists customers_email_idx     on public.customers (company_id, lower(email)) where deleted_at is null;
create index if not exists customers_unit_idx      on public.customers (company_id, unit_number) where deleted_at is null;
create index if not exists customers_name_trgm_idx on public.customers using gin (full_name extensions.gin_trgm_ops);

-- =============================================================================
-- 8. JOBS
-- =============================================================================
create sequence if not exists public.job_number_seq;

create table if not exists public.jobs (
  id                   uuid primary key default extensions.gen_random_uuid(),
  company_id           uuid        not null references public.companies(id) on delete restrict,
  partner_id           uuid        not null,
  job_number           text        not null check (length(btrim(job_number)) between 1 and 64),
  title                text,
  reference            text,
  status               app.job_status not null default 'draft',
  priority             int         not null default 3 check (priority between 1 and 5),
  site_name            text,
  address_line1        text        not null,
  address_line2        text,
  suburb               text        not null,
  state                text        not null,
  postcode             text        not null,
  country              char(2)     not null default 'AU',
  latitude             numeric(9,6),
  longitude            numeric(9,6),
  access_notes         text,
  unit_count           int         not null default 0 check (unit_count >= 0),
  installs_per_day     int         not null default 8 check (installs_per_day > 0 and installs_per_day <= 200),
  slot_minutes         int         not null default 60 check (slot_minutes between 5 and 480),
  day_start_time       time        not null default '08:00',
  day_end_time         time        not null default '16:00',
  working_days         int[]       not null default '{1,2,3,4,5}',
  start_date           date        not null,
  end_date             date        not null,
  booking_opens_at     timestamptz,
  booking_closes_at    timestamptz,
  published_at         timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  cancellation_reason  text,
  require_sms_verification boolean not null default true,
  require_email        boolean     not null default true,
  require_unit_number  boolean     not null default true,
  allow_waitlist       boolean     not null default true,
  max_units_per_booking int        not null default 1 check (max_units_per_booking >= 1),
  instructions         text,
  contact_name         text,
  contact_phone        text,
  settings             jsonb       not null default '{}'::jsonb,
  metadata             jsonb       not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  created_by           uuid references public.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.users(id) on delete set null,
  deleted_at           timestamptz,
  deleted_by           uuid references public.users(id) on delete set null,

  constraint jobs_id_company_uk unique (id, company_id),
  constraint jobs_partner_fk foreign key (partner_id, company_id)
    references public.partners (id, company_id) on delete restrict,
  constraint jobs_date_order check (end_date >= start_date),
  constraint jobs_time_order check (day_end_time > day_start_time),
  constraint jobs_working_days_valid check (
    working_days <@ array[1,2,3,4,5,6,7] and array_length(working_days,1) > 0),
  constraint jobs_latlng check (
    (latitude is null and longitude is null)
    or (latitude between -90 and 90 and longitude between -180 and 180))
);

create unique index if not exists jobs_company_number_uidx
  on public.jobs (company_id, upper(job_number)) where deleted_at is null;
create index if not exists jobs_company_idx      on public.jobs (company_id) where deleted_at is null;
create index if not exists jobs_partner_idx      on public.jobs (partner_id) where deleted_at is null;
create index if not exists jobs_status_idx       on public.jobs (company_id, status) where deleted_at is null;
create index if not exists jobs_dates_idx        on public.jobs (company_id, start_date, end_date) where deleted_at is null;
create index if not exists jobs_active_idx       on public.jobs (company_id, published_at)
  where published_at is not null and deleted_at is null;
create index if not exists jobs_postcode_idx     on public.jobs (company_id, postcode) where deleted_at is null;
create index if not exists jobs_address_trgm_idx on public.jobs using gin (address_line1 extensions.gin_trgm_ops);
create index if not exists jobs_geog_idx         on public.jobs (latitude, longitude)
  where latitude is not null and deleted_at is null;

-- =============================================================================
-- 9. JOB_TECHNICIANS
-- =============================================================================
create table if not exists public.job_technicians (
  id             uuid primary key default extensions.gen_random_uuid(),
  company_id     uuid        not null references public.companies(id) on delete restrict,
  job_id         uuid        not null,
  technician_id  uuid        not null,
  is_lead        boolean     not null default false,
  assigned_from  date,
  assigned_to    date,
  daily_capacity int         check (daily_capacity is null or (daily_capacity > 0 and daily_capacity <= 50)),
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.users(id) on delete set null,
  deleted_at     timestamptz,
  deleted_by     uuid references public.users(id) on delete set null,
  constraint job_technicians_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete cascade,
  constraint job_technicians_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete restrict,
  constraint job_technicians_window check (
    assigned_from is null or assigned_to is null or assigned_to >= assigned_from)
);

create unique index if not exists job_technicians_uidx
  on public.job_technicians (job_id, technician_id) where deleted_at is null;
create index if not exists job_technicians_company_idx on public.job_technicians (company_id) where deleted_at is null;
create index if not exists job_technicians_job_idx     on public.job_technicians (job_id) where deleted_at is null;
create index if not exists job_technicians_tech_idx    on public.job_technicians (technician_id) where deleted_at is null;
create unique index if not exists job_technicians_lead_uidx
  on public.job_technicians (job_id) where is_lead and deleted_at is null;

-- =============================================================================
-- 10. QR_CODES
-- =============================================================================
create table if not exists public.qr_codes (
  id               uuid primary key default extensions.gen_random_uuid(),
  company_id       uuid        not null references public.companies(id) on delete restrict,
  job_id           uuid        not null,
  token            text        not null check (length(token) between 8 and 128),
  label            text,
  scope            text        not null default 'job' check (scope in ('job','unit','batch')),
  unit_number      text,
  status           app.qr_status not null default 'active',
  target_url       text,
  image_path       text,
  image_url        text,
  max_scans        int         check (max_scans is null or max_scans > 0),
  max_bookings     int         check (max_bookings is null or max_bookings > 0),
  scan_count       int         not null default 0 check (scan_count >= 0),
  booking_count    int         not null default 0 check (booking_count >= 0),
  last_scanned_at  timestamptz,
  opens_at         timestamptz,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_reason   text,
  created_via      text        not null default 'partner_portal'
                     check (created_via in ('partner_portal','api','import','admin')),
  metadata         jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.users(id) on delete set null,
  deleted_at       timestamptz,
  deleted_by       uuid references public.users(id) on delete set null,
  constraint qr_codes_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete cascade,
  constraint qr_codes_id_company_uk unique (id, company_id),
  constraint qr_codes_window check (expires_at is null or opens_at is null or expires_at > opens_at),
  constraint qr_codes_unit_scope check (scope <> 'unit' or unit_number is not null)
);

create unique index if not exists qr_codes_token_uidx on public.qr_codes (token) where deleted_at is null;
create index if not exists qr_codes_company_idx on public.qr_codes (company_id) where deleted_at is null;
create index if not exists qr_codes_job_idx     on public.qr_codes (job_id) where deleted_at is null;
create index if not exists qr_codes_status_idx  on public.qr_codes (company_id, status) where deleted_at is null;
create index if not exists qr_codes_active_idx  on public.qr_codes (job_id, status)
  where status = 'active' and deleted_at is null;
create unique index if not exists qr_codes_unit_uidx
  on public.qr_codes (job_id, unit_number) where scope = 'unit' and deleted_at is null;

-- =============================================================================
-- 11. QR_CODE_SCANS
-- =============================================================================
create table if not exists public.qr_code_scans (
  id           uuid primary key default extensions.gen_random_uuid(),
  company_id   uuid        not null references public.companies(id) on delete restrict,
  qr_code_id   uuid        not null,
  scanned_at   timestamptz not null default now(),
  ip_address   inet,
  user_agent   text,
  referrer     text,
  device_type  text        check (device_type is null or device_type in ('mobile','tablet','desktop','bot','unknown')),
  os           text,
  browser      text,
  country      char(2),
  region       text,
  city         text,
  session_id   text,
  converted    boolean     not null default false,
  booking_id   uuid,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  metadata     jsonb       not null default '{}'::jsonb,
  constraint qr_code_scans_qr_fk foreign key (qr_code_id, company_id)
    references public.qr_codes (id, company_id) on delete cascade
);

create index if not exists qr_code_scans_qr_time_idx   on public.qr_code_scans (qr_code_id, scanned_at desc);
create index if not exists qr_code_scans_company_idx   on public.qr_code_scans (company_id, scanned_at desc);
create index if not exists qr_code_scans_converted_idx on public.qr_code_scans (qr_code_id) where converted = false;
create index if not exists qr_code_scans_session_idx   on public.qr_code_scans (session_id)
  where session_id is not null;

-- =============================================================================
-- 12. JOB_SLOTS
-- =============================================================================
create table if not exists public.job_slots (
  id              uuid primary key default extensions.gen_random_uuid(),
  company_id      uuid        not null references public.companies(id) on delete restrict,
  job_id          uuid        not null,
  technician_id   uuid,
  slot_date       date        not null,
  start_time      timestamptz not null,
  end_time        timestamptz not null,
  local_start     time        not null,
  local_end       time        not null,
  capacity        int         not null default 1 check (capacity > 0),
  booked_count    int         not null default 0 check (booked_count >= 0),
  status          app.slot_status not null default 'open',
  hold_token      text,
  hold_expires_at timestamptz,
  sequence        int         not null default 1,
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.users(id) on delete set null,
  deleted_at      timestamptz,
  deleted_by      uuid references public.users(id) on delete set null,
  constraint job_slots_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete cascade,
  constraint job_slots_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint job_slots_window check (end_time > start_time),
  constraint job_slots_capacity check (booked_count <= capacity),
  constraint job_slots_id_company_uk unique (id, company_id)
);

alter table public.job_slots drop constraint if exists job_slots_no_tech_overlap;
alter table public.job_slots add constraint job_slots_no_tech_overlap
  exclude using gist (
    technician_id with =,
    tstzrange(start_time, end_time, '[)') with &&
  )
  where (deleted_at is null and technician_id is not null and status in ('open','held','booked'));

alter table public.job_slots drop constraint if exists job_slots_no_seq_overlap;
alter table public.job_slots add constraint job_slots_no_seq_overlap
  exclude using gist (
    job_id with =,
    sequence with =,
    tstzrange(start_time, end_time, '[)') with &&
  )
  where (deleted_at is null and status <> 'cancelled');

create unique index if not exists job_slots_unique_window_uidx
  on public.job_slots (job_id, slot_date, local_start, sequence) where deleted_at is null;
create index if not exists job_slots_company_idx   on public.job_slots (company_id) where deleted_at is null;
create index if not exists job_slots_job_date_idx  on public.job_slots (job_id, slot_date) where deleted_at is null;
create index if not exists job_slots_tech_date_idx on public.job_slots (technician_id, slot_date) where deleted_at is null;
create index if not exists job_slots_open_idx      on public.job_slots (job_id, slot_date, local_start)
  where status = 'open' and deleted_at is null;
create index if not exists job_slots_hold_idx      on public.job_slots (hold_expires_at)
  where hold_token is not null and deleted_at is null;

-- =============================================================================
-- 13. CUSTOMER_BOOKINGS
-- =============================================================================
create table if not exists public.customer_bookings (
  id                  uuid primary key default extensions.gen_random_uuid(),
  company_id          uuid        not null references public.companies(id) on delete restrict,
  job_id              uuid        not null,
  slot_id             uuid,
  technician_id       uuid,
  customer_id         uuid,
  qr_code_id          uuid,
  booking_ref         text        not null check (length(btrim(booking_ref)) between 4 and 32),
  status              app.booking_status not null default 'pending',
  unit_number         text,
  phone               text        not null,
  email               text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name           text,
  special_comments    text,
  scheduled_date      date,
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  sms_verified        boolean     not null default false,
  sms_verified_at     timestamptz,
  email_verified      boolean     not null default false,
  email_verified_at   timestamptz,
  confirmed_at        timestamptz,
  reminder_sent_at    timestamptz,
  checked_in_at       timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  cancelled_by        text        check (cancelled_by is null or cancelled_by in ('customer','partner','technician','system')),
  rescheduled_from_id uuid references public.customer_bookings(id) on delete set null,
  reschedule_count    int         not null default 0 check (reschedule_count >= 0),
  source              text        not null default 'qr'
                        check (source in ('qr','link','phone','email','walk_in','import','api')),
  technician_notes    text,
  completed_notes     text,
  signature_url       text,
  photo_urls          text[]      not null default '{}',
  metadata            jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.users(id) on delete set null,
  deleted_at          timestamptz,
  deleted_by          uuid references public.users(id) on delete set null,
  constraint customer_bookings_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete cascade,
  constraint customer_bookings_slot_fk foreign key (slot_id, company_id)
    references public.job_slots (id, company_id) on delete set null,
  constraint customer_bookings_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint customer_bookings_customer_fk foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete set null,
  constraint customer_bookings_qr_fk foreign key (qr_code_id, company_id)
    references public.qr_codes (id, company_id) on delete set null,
  constraint customer_bookings_window check (
    scheduled_end is null or scheduled_start is null or scheduled_end > scheduled_start),
  constraint customer_bookings_id_company_uk unique (id, company_id)
);

create unique index if not exists customer_bookings_unit_uidx
  on public.customer_bookings (job_id, lower(unit_number))
  where unit_number is not null and deleted_at is null
    and status not in ('cancelled','no_show');
create unique index if not exists customer_bookings_ref_uidx
  on public.customer_bookings (company_id, upper(booking_ref)) where deleted_at is null;
create index if not exists customer_bookings_company_idx   on public.customer_bookings (company_id, created_at desc);
create index if not exists customer_bookings_job_idx       on public.customer_bookings (job_id, scheduled_date);
create index if not exists customer_bookings_slot_idx      on public.customer_bookings (slot_id) where slot_id is not null;
create index if not exists customer_bookings_tech_date_idx on public.customer_bookings (technician_id, scheduled_date)
  where technician_id is not null;
create index if not exists customer_bookings_customer_idx  on public.customer_bookings (customer_id) where customer_id is not null;
create index if not exists customer_bookings_phone_idx     on public.customer_bookings (company_id, phone);
create index if not exists customer_bookings_status_idx    on public.customer_bookings (company_id, status);
create index if not exists customer_bookings_pending_idx   on public.customer_bookings (scheduled_date)
  where status in ('pending','confirmed') and reminder_sent_at is null;

-- Forward FK: qr_code_scans.booking_id -> customer_bookings(id)
alter table public.qr_code_scans drop constraint if exists qr_code_scans_booking_fk;
alter table public.qr_code_scans add constraint qr_code_scans_booking_fk
  foreign key (booking_id) references public.customer_bookings(id) on delete set null;

-- =============================================================================
-- 14. RATE_CARDS
-- =============================================================================
create table if not exists public.rate_cards (
  id               uuid primary key default extensions.gen_random_uuid(),
  company_id       uuid        not null references public.companies(id) on delete restrict,
  technician_id    uuid,
  partner_id       uuid,
  name             text        not null,
  code             text,
  scope            text        not null default 'technician'
                     check (scope in ('technician','partner','company')),
  effective_from   date        not null,
  effective_to     date,
  currency         char(3)     not null default 'AUD',
  tax_rate         numeric(5,4) not null default 0.1000 check (tax_rate >= 0 and tax_rate < 1),
  tax_inclusive    boolean     not null default false,
  is_active        boolean     not null default true,
  source           text        not null default 'manual'
                     check (source in ('manual','csv','xlsx','api','template')),
  source_filename  text,
  source_checksum  text,
  imported_at      timestamptz,
  imported_by      uuid references public.users(id) on delete set null,
  import_summary   jsonb       not null default '{}'::jsonb,
  notes            text,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.users(id) on delete set null,
  deleted_at       timestamptz,
  deleted_by       uuid references public.users(id) on delete set null,
  constraint rate_cards_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete cascade,
  constraint rate_cards_partner_fk foreign key (partner_id, company_id)
    references public.partners (id, company_id) on delete cascade,
  constraint rate_cards_id_company_uk unique (id, company_id),
  constraint rate_cards_window check (effective_to is null or effective_to >= effective_from),
  constraint rate_cards_owner check (
    (scope = 'technician' and technician_id is not null)
    or (scope = 'partner' and partner_id is not null)
    or (scope = 'company' and technician_id is null and partner_id is null))
);

alter table public.rate_cards drop constraint if exists rate_cards_no_tech_overlap;
alter table public.rate_cards add constraint rate_cards_no_tech_overlap
  exclude using gist (
    technician_id with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  )
  where (deleted_at is null and is_active and technician_id is not null);

create index if not exists rate_cards_company_idx  on public.rate_cards (company_id) where deleted_at is null;
create index if not exists rate_cards_tech_idx     on public.rate_cards (technician_id, effective_from desc) where deleted_at is null;
create index if not exists rate_cards_partner_idx  on public.rate_cards (partner_id) where deleted_at is null;
create index if not exists rate_cards_active_idx   on public.rate_cards (company_id, effective_from, effective_to)
  where is_active and deleted_at is null;
create index if not exists rate_cards_checksum_idx on public.rate_cards (company_id, source_checksum)
  where source_checksum is not null and deleted_at is null;

-- Forward FK: partners.default_rate_card_id -> rate_cards(id)
alter table public.partners drop constraint if exists partners_default_rate_card_fk;
alter table public.partners add constraint partners_default_rate_card_fk
  foreign key (default_rate_card_id) references public.rate_cards(id) on delete set null;

-- =============================================================================
-- 15. RATE_CARD_ITEMS
-- =============================================================================
create table if not exists public.rate_card_items (
  id             uuid primary key default extensions.gen_random_uuid(),
  company_id     uuid        not null references public.companies(id) on delete restrict,
  rate_card_id   uuid        not null,
  code           text        not null check (length(btrim(code)) between 1 and 64),
  description    text        not null default '',
  category       text,
  unit           app.rate_unit not null default 'each',
  rate           numeric(12,4) not null default 0 check (rate >= 0),
  min_quantity   numeric(12,4) not null default 0 check (min_quantity >= 0),
  max_quantity   numeric(12,4) check (max_quantity is null or max_quantity >= min_quantity),
  technician_pay numeric(12,4) check (technician_pay is null or technician_pay >= 0),
  is_taxable     boolean     not null default true,
  is_active      boolean     not null default true,
  sort_order     int         not null default 0,
  external_code  text,
  source_row     int,
  metadata       jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.users(id) on delete set null,
  deleted_at     timestamptz,
  deleted_by     uuid references public.users(id) on delete set null,
  constraint rate_card_items_card_fk foreign key (rate_card_id, company_id)
    references public.rate_cards (id, company_id) on delete cascade,
  constraint rate_card_items_id_company_uk unique (id, company_id),
  constraint rate_card_items_qty check (max_quantity is null or max_quantity >= min_quantity)
);

create unique index if not exists rate_card_items_code_uidx
  on public.rate_card_items (rate_card_id, lower(code)) where deleted_at is null;
create index if not exists rate_card_items_card_idx      on public.rate_card_items (rate_card_id) where deleted_at is null;
create index if not exists rate_card_items_company_idx   on public.rate_card_items (company_id) where deleted_at is null;
create index if not exists rate_card_items_category_idx  on public.rate_card_items (rate_card_id, category) where deleted_at is null;
create index if not exists rate_card_items_external_idx  on public.rate_card_items (company_id, external_code)
  where external_code is not null and deleted_at is null;
create index if not exists rate_card_items_desc_trgm_idx on public.rate_card_items using gin (description extensions.gin_trgm_ops);

-- =============================================================================
-- 16. INVOICES
-- =============================================================================
create sequence if not exists public.invoice_number_seq;

create table if not exists public.invoices (
  id                  uuid primary key default extensions.gen_random_uuid(),
  company_id          uuid        not null references public.companies(id) on delete restrict,
  invoice_number      text        not null check (length(btrim(invoice_number)) between 1 and 40),
  direction           app.invoice_direction not null default 'payable',
  status              app.invoice_status    not null default 'draft',
  technician_id       uuid,
  partner_id          uuid,
  customer_id         uuid,
  job_id              uuid,
  rate_card_id        uuid,
  subscription_id     uuid,
  period_start        date,
  period_end          date,
  issue_date          date        not null default current_date,
  due_date            date,
  paid_date           date,
  currency            char(3)     not null default 'AUD',
  subtotal            numeric(14,2) not null default 0,
  discount_total      numeric(14,2) not null default 0,
  tax_total           numeric(14,2) not null default 0,
  total               numeric(14,2) not null default 0,
  amount_paid         numeric(14,2) not null default 0,
  tax_rate            numeric(5,4) not null default 0.1000 check (tax_rate >= 0 and tax_rate < 1),
  tax_inclusive       boolean     not null default false,
  supply_date         date,
  place_of_supply     char(2)     not null default 'AU',
  supplier_abn        text,
  supplier_name       text,
  buyer_abn           text,
  buyer_name          text,
  purchase_order      text,
  notes               text,
  terms               text,
  pdf_path            text,
  pdf_url             text,
  pdf_generated_at    timestamptz,
  submitted_at        timestamptz,
  approved_at         timestamptz,
  approved_by         uuid references public.users(id) on delete set null,
  sent_at             timestamptz,
  voided_at           timestamptz,
  void_reason         text,
  dispute_reason      text,
  xero_invoice_id     text,
  myob_invoice_id     text,
  quickbooks_id       text,
  external_reference  text,
  line_count          int         not null default 0 check (line_count >= 0),
  metadata            jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.users(id) on delete set null,
  deleted_at          timestamptz,
  deleted_by          uuid references public.users(id) on delete set null,
  amount_due          numeric(14,2) generated always as (total - amount_paid) stored,
  constraint invoices_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint invoices_partner_fk foreign key (partner_id, company_id)
    references public.partners (id, company_id) on delete set null,
  constraint invoices_customer_fk foreign key (customer_id, company_id)
    references public.customers (id, company_id) on delete set null,
  constraint invoices_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete set null,
  constraint invoices_rate_card_fk foreign key (rate_card_id, company_id)
    references public.rate_cards (id, company_id) on delete set null,
  constraint invoices_id_company_uk unique (id, company_id),
  constraint invoices_period check (period_end is null or period_start is null or period_end >= period_start),
  constraint invoices_amounts_nonneg check (
    subtotal >= 0 and discount_total >= 0 and tax_total >= 0 and total >= 0 and amount_paid >= 0)
);

create unique index if not exists invoices_company_number_uidx
  on public.invoices (company_id, upper(invoice_number)) where deleted_at is null;
create index if not exists invoices_company_idx     on public.invoices (company_id, issue_date desc) where deleted_at is null;
create index if not exists invoices_tech_period_idx on public.invoices (technician_id, period_start, period_end)
  where direction = 'payable' and deleted_at is null;
create index if not exists invoices_partner_idx     on public.invoices (partner_id, issue_date desc) where deleted_at is null;
create index if not exists invoices_status_idx      on public.invoices (company_id, status) where deleted_at is null;
create index if not exists invoices_due_idx         on public.invoices (company_id, due_date)
  where status in ('sent','part_paid') and deleted_at is null;
create index if not exists invoices_external_idx    on public.invoices (company_id, external_reference)
  where external_reference is not null and deleted_at is null;

-- =============================================================================
-- 17. INVOICE_ITEMS
-- =============================================================================
create table if not exists public.invoice_items (
  id                   uuid primary key default extensions.gen_random_uuid(),
  company_id           uuid        not null references public.companies(id) on delete restrict,
  invoice_id           uuid        not null,
  customer_booking_id  uuid,
  job_id               uuid,
  technician_id        uuid,
  rate_card_item_id    uuid,
  line_number          int         not null default 1,
  code                 text,
  description          text        not null default '',
  category             text,
  unit                 app.rate_unit not null default 'each',
  quantity             numeric(12,4) not null default 1 check (quantity >= 0),
  unit_rate            numeric(12,4) not null default 0 check (unit_rate >= 0),
  discount_rate        numeric(5,4)  not null default 0 check (discount_rate >= 0 and discount_rate < 1),
  discount_amount      numeric(14,2) not null default 0 check (discount_amount >= 0),
  tax_rate             numeric(5,4)  not null default 0.1000 check (tax_rate >= 0 and tax_rate < 1),
  is_taxable           boolean     not null default true,
  technician_pay       numeric(12,4) check (technician_pay is null or technician_pay >= 0),
  service_date         date,
  install_completed_at timestamptz,
  source               text        not null default 'booking'
                         check (source in ('booking','rate_card','manual','rollup','adjustment','import')),
  notes                text,
  metadata             jsonb       not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  created_by           uuid references public.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.users(id) on delete set null,
  deleted_at           timestamptz,
  deleted_by           uuid references public.users(id) on delete set null,
  line_subtotal        numeric(14,2) generated always as (round(quantity * unit_rate, 2)) stored,
  line_tax             numeric(14,2) generated always as (
                         case when is_taxable
                              then round(quantity * unit_rate * (1 - discount_rate) * tax_rate, 2)
                              else 0::numeric end) stored,
  line_total           numeric(14,2) generated always as (
                         round(quantity * unit_rate * (1 - discount_rate), 2)
                         + case when is_taxable
                                then round(quantity * unit_rate * (1 - discount_rate) * tax_rate, 2)
                                else 0::numeric end) stored,
  constraint invoice_items_invoice_fk foreign key (invoice_id, company_id)
    references public.invoices (id, company_id) on delete cascade,
  constraint invoice_items_booking_fk foreign key (customer_booking_id, company_id)
    references public.customer_bookings (id, company_id) on delete set null,
  constraint invoice_items_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete set null,
  constraint invoice_items_tech_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint invoice_items_rate_item_fk foreign key (rate_card_item_id, company_id)
    references public.rate_card_items (id, company_id) on delete set null,
  constraint invoice_items_id_company_uk unique (id, company_id)
);

create unique index if not exists invoice_items_line_uidx on public.invoice_items (invoice_id, line_number) where deleted_at is null;
create index if not exists invoice_items_invoice_idx   on public.invoice_items (invoice_id) where deleted_at is null;
create index if not exists invoice_items_company_idx   on public.invoice_items (company_id) where deleted_at is null;
create index if not exists invoice_items_booking_idx   on public.invoice_items (customer_booking_id)
  where customer_booking_id is not null;
create index if not exists invoice_items_tech_idx      on public.invoice_items (technician_id, service_date)
  where technician_id is not null;
create index if not exists invoice_items_job_idx       on public.invoice_items (job_id) where job_id is not null;
create unique index if not exists invoice_items_booking_once_uidx
  on public.invoice_items (invoice_id, customer_booking_id, rate_card_item_id)
  where customer_booking_id is not null and deleted_at is null;

-- =============================================================================
-- 18. NOTIFICATIONS
-- =============================================================================
create table if not exists public.notifications (
  id                     uuid primary key default extensions.gen_random_uuid(),
  company_id             uuid        not null references public.companies(id) on delete restrict,
  channel                app.notification_channel not null default 'email',
  status                 app.notification_status  not null default 'queued',
  template_key           text,
  event_key              text,
  subject                text,
  body                   text,
  body_html              text,
  variables              jsonb       not null default '{}'::jsonb,
  recipient_user_id      uuid references public.users(id) on delete set null,
  recipient_customer_id  uuid,
  recipient_technician_id uuid,
  recipient_partner_id   uuid,
  recipient_email        text,
  recipient_phone        text,
  recipient_name         text,
  customer_booking_id    uuid,
  job_id                 uuid,
  technician_id          uuid,
  invoice_id             uuid,
  priority               int         not null default 3 check (priority between 1 and 5),
  scheduled_for          timestamptz not null default now(),
  expires_at             timestamptz,
  attempt_count          int         not null default 0 check (attempt_count >= 0),
  max_attempts           int         not null default 3 check (max_attempts > 0),
  last_attempt_at        timestamptz,
  next_attempt_at        timestamptz,
  sent_at                timestamptz,
  delivered_at           timestamptz,
  read_at                timestamptz,
  failed_at              timestamptz,
  error_code             text,
  error_message          text,
  provider               text,
  provider_message_id    text,
  dedupe_key             text,
  metadata               jsonb       not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  created_by             uuid references public.users(id) on delete set null,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references public.users(id) on delete set null,
  constraint notifications_customer_fk foreign key (recipient_customer_id, company_id)
    references public.customers (id, company_id) on delete set null,
  constraint notifications_tech_fk foreign key (recipient_technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint notifications_partner_fk foreign key (recipient_partner_id, company_id)
    references public.partners (id, company_id) on delete set null,
  constraint notifications_booking_fk foreign key (customer_booking_id, company_id)
    references public.customer_bookings (id, company_id) on delete set null,
  constraint notifications_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete set null,
  constraint notifications_technician_fk foreign key (technician_id, company_id)
    references public.technicians (id, company_id) on delete set null,
  constraint notifications_invoice_fk foreign key (invoice_id, company_id)
    references public.invoices (id, company_id) on delete set null,
  constraint notifications_dedupe_uk unique (company_id, dedupe_key)
);

create index if not exists notifications_queue_idx     on public.notifications (company_id, status, priority, scheduled_for)
  where status in ('queued','sending');
create index if not exists notifications_retry_idx     on public.notifications (next_attempt_at)
  where status = 'failed' and attempt_count < max_attempts;
create index if not exists notifications_recipient_idx on public.notifications (recipient_email, created_at desc);
create index if not exists notifications_user_idx      on public.notifications (recipient_user_id, created_at desc)
  where recipient_user_id is not null;
create index if not exists notifications_booking_idx   on public.notifications (customer_booking_id)
  where customer_booking_id is not null;
create index if not exists notifications_event_idx     on public.notifications (company_id, event_key, created_at desc);
create index if not exists notifications_inapp_idx     on public.notifications (recipient_user_id, read_at)
  where channel = 'in_app' and read_at is null;

-- =============================================================================
-- 19. EMAIL_ACCOUNTS
-- =============================================================================
create table if not exists public.email_accounts (
  id                  uuid primary key default extensions.gen_random_uuid(),
  company_id          uuid        not null references public.companies(id) on delete restrict,
  label               text        not null default 'default',
  provider            text        not null default 'microsoft_graph'
                        check (provider in ('microsoft_graph','smtp','resend','sendgrid','ses')),
  from_name           text        not null,
  from_email          text        not null check (from_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  reply_to_email      text        check (reply_to_email is null or reply_to_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ms_tenant_id        text,
  ms_client_id        text,
  ms_token_secret_ref text,
  ms_mailbox_upn      text,
  ms_mailbox_user_id  text,
  ms_scope            text        not null default 'https://graph.microsoft.com/.default',
  ms_auth_mode        text        not null default 'client_credentials'
                        check (ms_auth_mode in ('client_credentials','delegated','shared_mailbox')),
  ms_save_to_sent     boolean     not null default true,
  smtp_host           text,
  smtp_port           int         check (smtp_port is null or (smtp_port > 0 and smtp_port <= 65535)),
  smtp_secure         boolean     not null default true,
  smtp_username       text,
  smtp_password_ref   text,
  api_key_ref         text,
  daily_send_limit    int         not null default 2000 check (daily_send_limit > 0),
  daily_sent_count    int         not null default 0 check (daily_sent_count >= 0),
  quota_reset_at      timestamptz,
  is_default          boolean     not null default false,
  is_verified         boolean     not null default false,
  verified_at         timestamptz,
  last_send_at        timestamptz,
  last_error          text,
  connection_meta     jsonb       not null default '{}'::jsonb,
  settings            jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.users(id) on delete set null,
  deleted_at          timestamptz,
  deleted_by          uuid references public.users(id) on delete set null,
  constraint email_accounts_id_company_uk unique (id, company_id)
);

create unique index if not exists email_accounts_default_uidx
  on public.email_accounts (company_id) where is_default and deleted_at is null;
create unique index if not exists email_accounts_label_uidx
  on public.email_accounts (company_id, lower(label)) where deleted_at is null;
create index if not exists email_accounts_company_idx on public.email_accounts (company_id) where deleted_at is null;
create index if not exists email_accounts_from_idx    on public.email_accounts (company_id, lower(from_email)) where deleted_at is null;
create index if not exists email_accounts_ms_idx      on public.email_accounts (ms_tenant_id, ms_client_id)
  where ms_tenant_id is not null and deleted_at is null;

-- =============================================================================
-- 20. EMAIL_LOGS
-- =============================================================================
create table if not exists public.email_logs (
  id                  uuid primary key default extensions.gen_random_uuid(),
  company_id          uuid        not null references public.companies(id) on delete restrict,
  notification_id     uuid,
  email_account_id    uuid,
  status              app.email_status not null default 'queued',
  direction           text        not null default 'outbound' check (direction in ('outbound','inbound')),
  from_email          text        not null,
  from_name           text,
  to_emails           text[]      not null default '{}',
  cc_emails           text[]      not null default '{}',
  bcc_emails          text[]      not null default '{}',
  reply_to            text,
  subject             text,
  body_preview        text,
  template_key        text,
  event_key           text,
  has_attachments     boolean     not null default false,
  attachment_count    int         not null default 0 check (attachment_count >= 0),
  recipient_user_id   uuid references public.users(id) on delete set null,
  customer_booking_id uuid,
  job_id              uuid,
  invoice_id          uuid,
  provider            text        not null default 'microsoft_graph',
  graph_message_id    text,
  internet_message_id text,
  conversation_id     text,
  conversation_index  text,
  graph_request_id    text,
  graph_status_code   int,
  graph_error_code    text,
  graph_error_message text,
  smtp_response       text,
  queued_at           timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  opened_at           timestamptz,
  bounced_at          timestamptz,
  failed_at           timestamptz,
  retry_count         int         not null default 0 check (retry_count >= 0),
  latency_ms          int,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.users(id) on delete set null,
  constraint email_logs_account_fk foreign key (email_account_id, company_id)
    references public.email_accounts (id, company_id) on delete set null,
  constraint email_logs_booking_fk foreign key (customer_booking_id, company_id)
    references public.customer_bookings (id, company_id) on delete set null,
  constraint email_logs_job_fk foreign key (job_id, company_id)
    references public.jobs (id, company_id) on delete set null,
  constraint email_logs_invoice_fk foreign key (invoice_id, company_id)
    references public.invoices (id, company_id) on delete set null,
  constraint email_logs_id_company_uk unique (id, company_id)
);

create index if not exists email_logs_company_time_idx on public.email_logs (company_id, created_at desc);
create index if not exists email_logs_graph_msg_idx    on public.email_logs (graph_message_id) where graph_message_id is not null;
create index if not exists email_logs_internet_id_idx  on public.email_logs (internet_message_id) where internet_message_id is not null;
create index if not exists email_logs_conversation_idx on public.email_logs (conversation_id) where conversation_id is not null;
create index if not exists email_logs_status_idx       on public.email_logs (company_id, status, created_at desc);
create index if not exists email_logs_failed_idx       on public.email_logs (company_id)
  where status in ('failed','bounced') and retry_count < 3;
create index if not exists email_logs_booking_idx      on public.email_logs (customer_booking_id) where customer_booking_id is not null;
create index if not exists email_logs_recipients_idx   on public.email_logs using gin (to_emails);

-- Forward FK: email_logs.notification_id -> notifications(id)
alter table public.email_logs drop constraint if exists email_logs_notification_fk;
alter table public.email_logs add constraint email_logs_notification_fk
  foreign key (notification_id) references public.notifications(id) on delete set null;

-- =============================================================================
-- 21. SUBSCRIPTION_PLANS  (global, not tenant-scoped)
-- =============================================================================
create table if not exists public.subscription_plans (
  id                          uuid primary key default extensions.gen_random_uuid(),
  code                        text        not null check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name                        text        not null,
  description                 text,
  tier                        int         not null default 1 check (tier >= 0),
  stripe_product_id           text,
  stripe_price_id             text,
  price                       numeric(12,2) not null default 0 check (price >= 0),
  currency                    char(3)     not null default 'AUD',
  billing_interval            app.billing_interval not null default 'month',
  interval_count              int         not null default 1 check (interval_count > 0),
  trial_days                  int         not null default 14 check (trial_days >= 0),
  included_users              int         not null default 5,
  included_technicians        int         not null default 5,
  included_jobs_per_month     int         not null default -1,
  included_bookings_per_month int         not null default -1,
  included_sms                int         not null default 0,
  included_emails             int         not null default 500,
  max_storage_mb              int         not null default 1024,
  features                    jsonb       not null default '[]'::jsonb,
  limits                      jsonb       not null default '{}'::jsonb,
  is_public                   boolean     not null default true,
  is_active                   boolean     not null default true,
  sort_order                  int         not null default 0,
  metadata                    jsonb       not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  created_by                  uuid,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid,
  deleted_at                  timestamptz,
  deleted_by                  uuid
);

create unique index if not exists subscription_plans_code_uidx
  on public.subscription_plans (lower(code)) where deleted_at is null;
create unique index if not exists subscription_plans_stripe_price_uidx
  on public.subscription_plans (stripe_price_id) where stripe_price_id is not null and deleted_at is null;
create index if not exists subscription_plans_active_idx on public.subscription_plans (is_public, is_active, sort_order)
  where deleted_at is null;
create index if not exists subscription_plans_stripe_idx on public.subscription_plans (stripe_product_id)
  where stripe_product_id is not null;

-- =============================================================================
-- 22. SUBSCRIPTIONS
-- =============================================================================
create table if not exists public.subscriptions (
  id                               uuid primary key default extensions.gen_random_uuid(),
  company_id                       uuid        not null references public.companies(id) on delete restrict,
  plan_id                          uuid        not null references public.subscription_plans(id) on delete restrict,
  status                           app.subscription_status not null default 'trialing',
  stripe_customer_id               text,
  stripe_subscription_id           text,
  stripe_price_id                  text,
  stripe_product_id                text,
  stripe_latest_invoice_id         text,
  stripe_default_payment_method_id text,
  quantity                         int         not null default 1 check (quantity > 0),
  currency                         char(3)     not null default 'AUD',
  unit_amount                      numeric(12,2),
  billing_interval                 app.billing_interval not null default 'month',
  interval_count                   int         not null default 1 check (interval_count > 0),
  trial_start                      timestamptz,
  trial_end                        timestamptz,
  current_period_start             timestamptz,
  current_period_end               timestamptz,
  cancel_at_period_end             boolean     not null default false,
  cancel_at                        timestamptz,
  canceled_at                      timestamptz,
  ended_at                         timestamptz,
  paused_at                        timestamptz,
  resumed_at                       timestamptz,
  grace_period_ends_at             timestamptz,
  seats_used                       int         not null default 0 check (seats_used >= 0),
  sms_used_this_period             int         not null default 0 check (sms_used_this_period >= 0),
  emails_used_this_period          int         not null default 0 check (emails_used_this_period >= 0),
  bookings_used_this_period        int         not null default 0 check (bookings_used_this_period >= 0),
  storage_used_mb                  numeric(12,2) not null default 0 check (storage_used_mb >= 0),
  overage_amount                   numeric(12,2) not null default 0 check (overage_amount >= 0),
  billing_email                    text,
  billing_name                     text,
  billing_address                  jsonb       not null default '{}'::jsonb,
  tax_id                           text,
  tax_exempt                       text        not null default 'none'
                                     check (tax_exempt in ('none','exempt','reverse')),
  discount_code                    text,
  coupon_id                        text,
  last_webhook_at                  timestamptz,
  last_webhook_event               text,
  cancelled_reason                 text,
  cancellation_feedback            text,
  metadata                         jsonb       not null default '{}'::jsonb,
  created_at                       timestamptz not null default now(),
  created_by                       uuid references public.users(id) on delete set null,
  updated_at                       timestamptz not null default now(),
  updated_by                       uuid references public.users(id) on delete set null,
  deleted_at                       timestamptz,
  deleted_by                       uuid references public.users(id) on delete set null,
  constraint subscriptions_id_company_uk unique (id, company_id),
  constraint subscriptions_period_order check (
    current_period_end is null or current_period_start is null
    or current_period_end >= current_period_start),
  constraint subscriptions_trial_order check (
    trial_end is null or trial_start is null or trial_end >= trial_start)
);

create unique index if not exists subscriptions_company_live_uidx
  on public.subscriptions (company_id)
  where deleted_at is null
    and status in ('trialing','active','past_due','unpaid','paused','incomplete');
create unique index if not exists subscriptions_stripe_sub_uidx
  on public.subscriptions (stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists subscriptions_company_idx    on public.subscriptions (company_id, created_at desc) where deleted_at is null;
create index if not exists subscriptions_status_idx     on public.subscriptions (status) where deleted_at is null;
create index if not exists subscriptions_customer_idx   on public.subscriptions (stripe_customer_id)
  where stripe_customer_id is not null;
create index if not exists subscriptions_renewal_idx    on public.subscriptions (current_period_end)
  where status in ('active','trialing') and deleted_at is null;
create index if not exists subscriptions_downgrade_idx  on public.subscriptions (cancel_at_period_end, current_period_end)
  where cancel_at_period_end and deleted_at is null;

-- Forward FK: invoices.subscription_id -> subscriptions(id)
alter table public.invoices drop constraint if exists invoices_subscription_fk;
alter table public.invoices add constraint invoices_subscription_fk
  foreign key (subscription_id) references public.subscriptions(id) on delete set null;

-- =============================================================================
-- 23. AUDIT_LOGS  (required by the deferred trigger layer)
-- =============================================================================
create table if not exists public.audit_logs (
  id           uuid primary key default extensions.gen_random_uuid(),
  company_id   uuid,
  table_name   text        not null,
  record_id    uuid        not null,
  operation    text        not null check (operation in ('INSERT','UPDATE','DELETE')),
  actor_id     uuid,
  actor_role   text,
  changed_at   timestamptz not null default now(),
  old_data     jsonb,
  new_data     jsonb,
  changed_keys text[]
);

create index if not exists audit_logs_company_time_idx on public.audit_logs (company_id, changed_at desc);
create index if not exists audit_logs_record_idx       on public.audit_logs (table_name, record_id, changed_at desc);
create index if not exists audit_logs_actor_idx        on public.audit_logs (actor_id, changed_at desc);
create index if not exists audit_logs_operation_idx    on public.audit_logs (operation, changed_at desc);

-- =============================================================================
-- 24. USER_INVITATIONS  (required by the deferred auth layer)
-- =============================================================================
create table if not exists public.user_invitations (
  id           uuid primary key default extensions.gen_random_uuid(),
  company_id   uuid        not null references public.companies(id) on delete cascade,
  email        text        not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token        text        not null default encode(extensions.gen_random_bytes(32), 'hex'),
  role_id      uuid        references public.roles(id) on delete set null,
  partner_id   uuid        references public.partners(id) on delete set null,
  member_type  app.member_type not null default 'staff',
  invited_by   uuid references public.users(id) on delete set null,
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz,
  accepted_by  uuid references public.users(id) on delete set null,
  revoked_at   timestamptz,
  revoked_by   uuid references public.users(id) on delete set null,
  send_count   int         not null default 0 check (send_count >= 0),
  last_sent_at timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.users(id) on delete set null
);

create unique index if not exists user_invitations_token_uidx on public.user_invitations (token);
create unique index if not exists user_invitations_pending_uidx
  on public.user_invitations (company_id, lower(email))
  where accepted_at is null and revoked_at is null;
create index if not exists user_invitations_company_idx on public.user_invitations (company_id);
create index if not exists user_invitations_email_idx   on public.user_invitations (lower(email));

commit;

-- =============================================================================
-- END phase2_tables.sql
--
-- Created: 23 tables, 2 sequences.
-- Deferred to later phases: RLS policies, triggers, booking RPCs, auth hooks.
-- =============================================================================
