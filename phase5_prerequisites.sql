-- =============================================================================
-- phase5_prerequisites.sql
-- SwiftWorks — Phase 5 prerequisites
--
-- Creates ONLY the objects Phase 5 (phase5_api.sql) requires that no earlier
-- phase introduced:
--
--   TABLES   public.sms_challenges
--            public.booking_idempotency
--            public.booking_rate_limit
--   FUNCTION app.resolve_rate_card(uuid, date)
--
-- No RLS policies, no triggers, no other functions. Additive only.
-- Run BEFORE phase5_api.sql.
--
-- Tables carry soft-delete-free designs deliberately: all three are ephemeral
-- ledgers pruned by public.booking_housekeeping(), so deleted_at would add
-- cost without benefit.
-- =============================================================================

begin;

set client_min_messages = warning;

-- =============================================================================
-- 1. SMS_CHALLENGES
-- =============================================================================
-- One-time verification codes issued on the public booking page. The code is
-- stored hashed, verified once, then consumed. Referenced by create_booking()
-- and pruned by booking_housekeeping().
-- =============================================================================
create table if not exists public.sms_challenges (
  id            uuid primary key default extensions.gen_random_uuid(),
  company_id    uuid        not null references public.companies(id) on delete cascade,
  qr_code_id    uuid,
  phone         text        not null,
  code_hash     text        not null,
  attempts      int         not null default 0 check (attempts >= 0),
  max_attempts  int         not null default 5 check (max_attempts > 0),
  verified_at   timestamptz,
  consumed_at   timestamptz,
  expires_at    timestamptz not null default now() + interval '10 minutes',
  created_at    timestamptz not null default now()
);

comment on table  public.sms_challenges is
  'One-time SMS verification codes. Code is stored hashed; verified once, then consumed.';
comment on column public.sms_challenges.code_hash is
  'Hash of the one-time code. The plaintext code is never persisted.';
comment on column public.sms_challenges.consumed_at is
  'Set when the challenge is redeemed by a booking. A consumed challenge cannot be reused.';

create index if not exists sms_challenges_phone_idx
  on public.sms_challenges (phone, created_at desc);
create index if not exists sms_challenges_live_idx
  on public.sms_challenges (phone)
  where verified_at is not null and consumed_at is null;
create index if not exists sms_challenges_expiry_idx
  on public.sms_challenges (expires_at)
  where consumed_at is null;
create index if not exists sms_challenges_company_idx
  on public.sms_challenges (company_id, created_at desc);

-- =============================================================================
-- 2. BOOKING_IDEMPOTENCY
-- =============================================================================
-- Guards against a duplicate booking from a double-tapped submit or a client
-- retry. A key younger than 24 hours short-circuits create_booking() and
-- returns the original booking reference.
-- =============================================================================
create table if not exists public.booking_idempotency (
  key         text        primary key,
  booking_id  uuid        not null,
  company_id  uuid        not null references public.companies(id) on delete cascade,
  created_at  timestamptz not null default now()
);

comment on table  public.booking_idempotency is
  'Guards against duplicate bookings from a double-tapped submit. Keys expire after 24h.';
comment on column public.booking_idempotency.key is
  'Client-supplied idempotency key. Primary key, so a retry cannot create a second row.';

create index if not exists booking_idempotency_created_idx
  on public.booking_idempotency (created_at);
create index if not exists booking_idempotency_company_idx
  on public.booking_idempotency (company_id, created_at desc);

-- Forward FK to customer_bookings. Added separately so this script remains
-- runnable even if the two objects are created in different transactions.
alter table public.booking_idempotency
  drop constraint if exists booking_idempotency_booking_fk;
alter table public.booking_idempotency
  add constraint booking_idempotency_booking_fk
  foreign key (booking_id) references public.customer_bookings(id) on delete cascade;

-- =============================================================================
-- 3. BOOKING_RATE_LIMIT
-- =============================================================================
-- Rolling-window throttle for the public booking endpoint. One row per attempt,
-- bucketed as 'phone:+61...' or 'ip:203.0.113.4'. A QR on a lobby wall is a
-- public URL; without this, one scripted handset can drain a building.
-- =============================================================================
create table if not exists public.booking_rate_limit (
  id          bigserial   primary key,
  company_id  uuid        not null references public.companies(id) on delete cascade,
  bucket      text        not null,
  occurred_at timestamptz not null default now()
);

comment on table  public.booking_rate_limit is
  'Rolling-window rate-limit ledger for the public booking endpoint.';
comment on column public.booking_rate_limit.bucket is
  'Bucket key, e.g. phone:+61400000000 or ip:203.0.113.4.';

-- Leading column is `bucket`: the hot query filters on an exact bucket value
-- then ranges over occurred_at, so this serves both the predicate and the
-- ordering. A partial predicate is deliberately avoided — now() is not
-- immutable and cannot appear in an index WHERE clause.
create index if not exists booking_rate_limit_lookup_idx
  on public.booking_rate_limit (bucket, occurred_at desc);
create index if not exists booking_rate_limit_gc_idx
  on public.booking_rate_limit (occurred_at);
create index if not exists booking_rate_limit_company_idx
  on public.booking_rate_limit (company_id, occurred_at desc);

-- =============================================================================
-- 4. app.resolve_rate_card(technician_id, on_date)
-- =============================================================================
-- Returns the rate card that applies to a technician on a given date.
-- Specificity order: technician-scoped card, then company-wide default.
-- Within a scope the most recently effective card wins.
--
-- Relies on the rate_cards GiST exclusion constraint to guarantee at most one
-- live card per technician per period, so the technician branch cannot be
-- ambiguous. The company fallback is ordered for determinism.
-- =============================================================================
create or replace function app.resolve_rate_card(
  p_technician_id uuid,
  p_on            date
)
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select rc.id
  from public.rate_cards rc
  where rc.deleted_at is null
    and rc.is_active
    and rc.effective_from <= p_on
    and (rc.effective_to is null or rc.effective_to >= p_on)
    and (
      rc.technician_id = p_technician_id
      or rc.scope = 'company'
    )
  order by
    case rc.scope
      when 'technician' then 1
      when 'partner'    then 2
      else 3
    end,
    rc.effective_from desc,
    rc.id
  limit 1
$$;

comment on function app.resolve_rate_card(uuid, date) is
  'Resolves the rate card effective for a technician on a given date. Technician-scoped beats company-wide; most recent wins within a scope.';

revoke execute on function app.resolve_rate_card(uuid, date) from public, anon, authenticated;
grant  execute on function app.resolve_rate_card(uuid, date) to service_role;

-- =============================================================================
-- 5. RLS
-- =============================================================================
-- All three tables are internal ledgers reached only through SECURITY DEFINER
-- RPCs. RLS is enabled and forced with NO policies, so authenticated users read
-- nothing directly and anon reads nothing at all. Phase 5's create_booking()
-- reaches them through definer rights.
-- =============================================================================
alter table public.sms_challenges      enable row level security;
alter table public.sms_challenges      force  row level security;
alter table public.booking_idempotency enable row level security;
alter table public.booking_idempotency force  row level security;
alter table public.booking_rate_limit  enable row level security;
alter table public.booking_rate_limit  force  row level security;

revoke all on public.sms_challenges, public.booking_idempotency, public.booking_rate_limit
  from anon, authenticated;

-- One narrow read path: operators investigating a booking problem.
drop policy if exists sms_challenges_staff_read on public.sms_challenges;
create policy sms_challenges_staff_read on public.sms_challenges
  for select to authenticated
  using (app.can_access_company(company_id) and app.has_permission('bookings.read'));

drop policy if exists booking_rate_limit_staff_read on public.booking_rate_limit;
create policy booking_rate_limit_staff_read on public.booking_rate_limit
  for select to authenticated
  using (app.can_access_company(company_id) and app.has_permission('bookings.read'));

-- booking_idempotency gets no policy: service_role (which bypasses RLS) is the
-- only reader, and it needs no visibility outside the RPC. If a support tool
-- later needs to trace a duplicate, add a policy mirroring the two above.

-- =============================================================================
-- 6. VERIFICATION
-- =============================================================================
do $$
declare
  v_tbl text;
  v_missing text[] := array[]::text[];
begin
  foreach v_tbl in array array['sms_challenges','booking_idempotency','booking_rate_limit'] loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_tbl and c.relkind = 'r'
    ) then
      v_missing := v_missing || ('public.' || v_tbl);
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'phase 5 prerequisites incomplete - missing tables: %',
      array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'resolve_rate_card'
  ) then
    raise exception 'phase 5 prerequisites incomplete - app.resolve_rate_card missing'
      using errcode = 'P0001';
  end if;

  if has_function_privilege('anon', 'app.resolve_rate_card(uuid, date)', 'EXECUTE') then
    raise exception 'phase 5 prerequisites incomplete - anon retains EXECUTE on app.resolve_rate_card'
      using errcode = 'P0001';
  end if;

  raise notice 'phase 5 prerequisites complete: 3 tables, 1 function, RLS forced with no anon access';
end $$;

commit;

-- =============================================================================
-- END phase5_prerequisites.sql
--
-- Run order:  bootstrap.sql  ->  phase2_tables.sql  ->  phase3_auth.sql
--             ->  phase4_rls.sql  ->  phase5_prerequisites.sql  ->  phase5_api.sql
-- =============================================================================
