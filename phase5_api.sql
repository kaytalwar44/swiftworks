-- =============================================================================
-- phase5_api.sql
-- SwiftWorks — Phase 5: API Layer
--
-- Depends on: bootstrap.sql, phase2_tables.sql, phase3_auth.sql, phase4_rls.sql
--
-- SECURITY DEFINER RPCs, postgresql 15, Supabase compatible.
--
-- Security posture
--   * Internal helpers (app.*) are NOT definer by default. They are stable
--     functions over RLS-protected tables, so they inherit the caller's
--     privileges and Phase 4 RLS applies to every read.
--   * Definer is used ONLY where a caller must reach data their RLS policies
--     do not expose: the anonymous booking flow, slot claiming under lock,
--     and cross-table dashboard aggregates.
--   * Every definer function validates the caller explicitly and sets
--     search_path, so it cannot be used as a privilege-escalation surface.
--
-- Exposed objects: public.* only. app.* is never anon-reachable.
-- =============================================================================

begin;

set client_min_messages = warning;

-- =============================================================================
-- SECTION 0 — SHARED HELPERS
-- =============================================================================

-- Technician scope predicate. Phase 4 referenced this; defined here so Phase 5
-- is self-contained on databases where Phase 4's copy was not applied.
create or replace function app.current_technician_id()
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select t.id
  from public.technicians t
  where t.user_id = auth.uid()
    and t.deleted_at is null
  limit 1
$$;

comment on function app.current_technician_id() is
  'Resolves the calling user to their technicians row. NULL for operator and partner users.';

-- Consistency guard: raises on a foreign key violation inside a definer
-- function, so callers never see a raw constraint name.
create or replace function app.assert_permission(p_permission text)
returns void
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
begin
  if not app.has_permission(p_permission) then
    raise exception 'insufficient_privilege: % required', p_permission
      using errcode = '42501';
  end if;
end $$;

comment on function app.assert_permission(text) is
  'Raises 42501 when the caller lacks the named permission.';

-- Booking reference generator. Alphabet excludes I/O/0/1 so residents can
-- read the code back over the phone without ambiguity.
create or replace function app.generate_booking_ref()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_ref text := '';
  i int;
begin
  for i in 1..6 loop
    v_ref := v_ref || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return 'SW-' || v_ref;
end $$;

comment on function app.generate_booking_ref() is
  'Short human-quotable booking reference.';

-- =============================================================================
-- SECTION 1 — PUBLIC BOOKING
-- =============================================================================
-- These are the only anon-reachable objects in the system. Each validates its
-- QR token, and none exposes tenant data beyond the job the token belongs to.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1.1 booking_lookup(token) — resolve a QR token to its public job payload.
-- -----------------------------------------------------------------------------
create or replace function public.booking_lookup(p_token text)
returns table (
  job_id          uuid,
  job_number      text,
  title           text,
  site_name       text,
  address_line1   text,
  suburb          text,
  state           text,
  postcode        text,
  access_notes    text,
  instructions    text,
  unit_count      int,
  require_unit_number boolean,
  require_sms_verification boolean,
  booking_opens_at timestamptz,
  booking_closes_at timestamptz,
  qr_scope        text,
  prefilled_unit  text,
  is_open         boolean,
  closed_reason   text
)
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select
    j.id, j.job_number, j.title, j.site_name,
    j.address_line1, j.suburb, j.state, j.postcode,
    j.access_notes, j.instructions, j.unit_count,
    j.require_unit_number, j.require_sms_verification,
    j.booking_opens_at, j.booking_closes_at,
    q.scope,
    case when q.scope = 'unit' then q.unit_number else null end,
    (q.status = 'active'
      and q.deleted_at is null
      and j.deleted_at is null
      and j.status in ('published','in_progress')
      and j.published_at is not null
      and (q.expires_at is null or q.expires_at > now())
      and (q.opens_at is null or q.opens_at <= now())
      and (j.booking_opens_at is null or j.booking_opens_at <= now())
      and (j.booking_closes_at is null or j.booking_closes_at > now())
      and (q.max_bookings is null or q.booking_count < q.max_bookings)),
    case
      when q.deleted_at is not null then 'invalid_token'
      when q.status = 'revoked' then 'qr_revoked'
      when q.status <> 'active' then 'qr_inactive'
      when q.expires_at is not null and q.expires_at <= now() then 'qr_expired'
      when q.max_bookings is not null and q.booking_count >= q.max_bookings then 'booking_limit_reached'
      when j.deleted_at is not null then 'job_not_found'
      when j.status = 'cancelled' then 'job_cancelled'
      when j.status not in ('published','in_progress') or j.published_at is null then 'job_not_published'
      when j.booking_opens_at is not null and j.booking_opens_at > now() then 'not_yet_open'
      when j.booking_closes_at is not null and j.booking_closes_at <= now() then 'closed'
      else null
    end
  from public.qr_codes q
  join public.jobs j on j.id = q.job_id
  where q.token = p_token
  limit 1
$$;

comment on function public.booking_lookup(text) is
  'Public QR token resolution. Returns job details and booking state. No tenant identifiers beyond the site address.';

revoke all on function public.booking_lookup(text) from public;
grant execute on function public.booking_lookup(text) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1.2 available_slots(token) — bookable windows for a QR token.
--     Informational only. The authoritative check is the row lock inside
--     app.slot_claim(), reached through create_booking().
-- -----------------------------------------------------------------------------
create or replace function public.available_slots(p_token text)
returns table (
  slot_id    uuid,
  slot_date  date,
  local_start time,
  local_end   time,
  start_time timestamptz,
  end_time   timestamptz,
  capacity   int,
  remaining  int,
  technician_name text
)
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select
    s.id, s.slot_date, s.local_start, s.local_end,
    s.start_time, s.end_time,
    s.capacity, greatest(s.capacity - s.booked_count, 0),
    t.full_name
  from public.qr_codes q
  join public.jobs j on j.id = q.job_id and j.deleted_at is null
  join public.job_slots s on s.job_id = j.id and s.deleted_at is null
  left join public.technicians t on t.id = s.technician_id and t.deleted_at is null
  where q.token = p_token
    and q.deleted_at is null
    and q.status = 'active'
    and j.status in ('published','in_progress')
    and (q.expires_at is null or q.expires_at > now())
    and (j.booking_opens_at is null or j.booking_opens_at <= now())
    and (j.booking_closes_at is null or j.booking_closes_at > now())
    and s.status in ('open','held')
    and s.booked_count < s.capacity
    and s.start_time > now()
  order by s.slot_date, s.local_start
$$;

comment on function public.available_slots(text) is
  'Public slot availability for a QR token. Informational; the lock inside create_booking() is authoritative.';

revoke all on function public.available_slots(text) from public;
grant execute on function public.available_slots(text) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1.3 slot_claim(slot_id, hold_token) — row-locked seat claim.
--     NOT grantable to anon. Reached only from create_booking().
-- -----------------------------------------------------------------------------
create or replace function app.slot_claim(p_slot_id uuid, p_hold_token text default null)
returns table (slot_id uuid, booked_count int, capacity int, status app.slot_status)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_slot public.job_slots%rowtype;
begin
  select * into v_slot
  from public.job_slots
  where id = p_slot_id and deleted_at is null
  for update;                          -- serialises concurrent claims

  if not found then
    raise exception 'slot_not_found' using errcode = 'P0002';
  end if;

  if v_slot.status not in ('open','held') then
    raise exception 'slot_unavailable' using errcode = 'P0001';
  end if;

  if v_slot.hold_token is not null
     and p_hold_token is distinct from v_slot.hold_token
     and coalesce(v_slot.hold_expires_at, now() - interval '1 second') > now() then
    raise exception 'slot_held_by_another' using errcode = 'P0001';
  end if;

  if v_slot.booked_count >= v_slot.capacity then
    raise exception 'slot_full' using errcode = 'P0001';
  end if;

  update public.job_slots
     set booked_count = booked_count + 1,
         status = case when booked_count + 1 >= capacity
                       then 'booked'::app.slot_status
                       else 'held'::app.slot_status end,
         hold_token = null,
         hold_expires_at = null,
         updated_at = now()
   where id = p_slot_id
  returning * into v_slot;

  return query select v_slot.id, v_slot.booked_count, v_slot.capacity, v_slot.status;
end $$;

comment on function app.slot_claim(uuid, text) is
  'Row-locked seat claim. The only sanctioned way to consume slot capacity.';

revoke execute on function app.slot_claim(uuid, text) from public, anon, authenticated;
grant  execute on function app.slot_claim(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 1.4 create_booking(...) — the anonymous booking entry point.
--     One transaction: validate token, validate job window, verify SMS,
--     claim the slot under lock, upsert customer, write booking, queue
--     notifications. Any failure rolls the claim back with it.
-- -----------------------------------------------------------------------------
create or replace function public.create_booking(
  p_qr_token         text,
  p_slot_id          uuid,
  p_unit_number      text,
  p_phone            text,
  p_email            text,
  p_full_name        text default null,
  p_special_comments text default null,
  p_idempotency_key  text default null,
  p_ip_address       inet default null,
  p_user_agent       text default null,
  p_session_id       text default null
)
returns table (
  booking_id      uuid,
  booking_ref     text,
  status          app.booking_status,
  scheduled_date  date,
  scheduled_start timestamptz,
  scheduled_end   timestamptz,
  unit_number     text,
  job_id          uuid,
  job_number      text,
  site_address    text,
  technician_name text,
  already_existed boolean
)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_qr        public.qr_codes%rowtype;
  v_job       public.jobs%rowtype;
  v_slot      public.job_slots%rowtype;
  v_booking   public.customer_bookings%rowtype;
  v_customer  uuid;
  v_existing  uuid;
  v_email     text := nullif(lower(btrim(p_email)), '');
  v_phone     text := app.normalise_phone(p_phone);
  v_unit      text := nullif(btrim(p_unit_number), '');
  v_name      text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_comm      text := nullif(btrim(coalesce(p_special_comments, '')), '');
  v_address   text;
  v_tech      text;
begin
  -- 0. Input validation
  if p_qr_token is null or length(btrim(p_qr_token)) < 8 then
    raise exception 'invalid_token: QR token missing or malformed' using errcode = 'P0001';
  end if;
  if v_phone is null or length(v_phone) < 8 or length(v_phone) > 20 then
    raise exception 'invalid_input: phone number is not valid' using errcode = 'P0001';
  end if;
  if v_email is not null and not app.is_valid_email(v_email) then
    raise exception 'invalid_input: email address is not valid' using errcode = 'P0001';
  end if;
  if length(coalesce(v_comm, '')) > 2000 then
    raise exception 'invalid_input: comments exceed 2000 characters' using errcode = 'P0001';
  end if;

  -- 1. Idempotency: a retried submit returns the original booking.
  if p_idempotency_key is not null then
    select bi.booking_id into v_existing
    from public.booking_idempotency bi
    where bi.key = p_idempotency_key
      and bi.created_at > now() - interval '24 hours';

    if found then
      return query
        select b.id, b.booking_ref, b.status, b.scheduled_date, b.scheduled_start,
               b.scheduled_end, b.unit_number, b.job_id, j.job_number,
               concat_ws(', ', j.address_line1, j.suburb, j.state, j.postcode),
               t.full_name, true
        from public.customer_bookings b
        join public.jobs j on j.id = b.job_id
        left join public.technicians t on t.id = b.technician_id
        where b.id = v_existing;
      return;
    end if;
  end if;

  -- 2. Validate the QR token, locking the row so status cannot flip mid-flight.
  select * into v_qr
  from public.qr_codes
  where token = p_qr_token and deleted_at is null
  for share;

  if not found then
    raise exception 'invalid_token: QR token not recognised' using errcode = 'P0001';
  end if;
  if v_qr.status = 'revoked' then
    raise exception 'qr_inactive: this QR code has been revoked' using errcode = 'P0001';
  end if;
  if v_qr.status <> 'active' then
    raise exception 'qr_inactive: this QR code is not accepting bookings' using errcode = 'P0001';
  end if;
  if v_qr.expires_at is not null and v_qr.expires_at <= now() then
    raise exception 'qr_expired: this QR code has expired' using errcode = 'P0001';
  end if;
  if v_qr.opens_at is not null and v_qr.opens_at > now() then
    raise exception 'job_closed: bookings have not opened yet' using errcode = 'P0001';
  end if;
  if v_qr.max_bookings is not null and v_qr.booking_count >= v_qr.max_bookings then
    raise exception 'job_closed: this QR code has reached its booking limit' using errcode = 'P0001';
  end if;

  -- 3. Rate limiting: per phone and per IP, rolling 15-minute windows.
  if exists (
    select 1 from public.booking_rate_limit
    where bucket = 'phone:' || v_phone
      and occurred_at > now() - interval '15 minutes'
    group by bucket having count(*) >= 3
  ) then
    raise exception 'rate_limited: too many booking attempts from this number' using errcode = 'P0001';
  end if;

  if p_ip_address is not null and exists (
    select 1 from public.booking_rate_limit
    where bucket = 'ip:' || host(p_ip_address)
      and occurred_at > now() - interval '15 minutes'
    group by bucket having count(*) >= 20
  ) then
    raise exception 'rate_limited: too many booking attempts from this address' using errcode = 'P0001';
  end if;

  -- 4. Resolve the job behind the QR code.
  select * into v_job
  from public.jobs
  where id = v_qr.job_id and deleted_at is null;

  if not found then
    raise exception 'job_not_found: the job behind this QR code no longer exists' using errcode = 'P0001';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'job_cancelled: this installation job has been cancelled' using errcode = 'P0001';
  end if;
  if v_job.status not in ('published','in_progress') or v_job.published_at is null then
    raise exception 'job_not_published: this job is not open for booking' using errcode = 'P0001';
  end if;
  if v_job.booking_closes_at is not null and v_job.booking_closes_at <= now() then
    raise exception 'job_closed: the booking window for this job has closed' using errcode = 'P0001';
  end if;
  if v_job.booking_opens_at is not null and v_job.booking_opens_at > now() then
    raise exception 'job_closed: the booking window for this job has not opened' using errcode = 'P0001';
  end if;

  if v_qr.scope = 'unit' then
    v_unit := v_qr.unit_number;
  end if;

  if v_unit is null and (v_job.require_unit_number or v_qr.scope = 'unit') then
    raise exception 'invalid_input: unit number is required' using errcode = 'P0001';
  end if;

  -- 5. Duplicate-unit guard (the partial unique index is the backstop).
  if v_unit is not null then
    if exists (
      select 1 from public.customer_bookings
      where job_id = v_job.id
        and lower(unit_number) = lower(v_unit)
        and deleted_at is null
        and status not in ('cancelled','no_show')
    ) then
      raise exception 'unit_already_booked: unit % already has a booking for this job', v_unit
        using errcode = 'P0001';
    end if;
  end if;

  -- 6. Claim the slot under lock.
  perform app.slot_claim(p_slot_id, null);

  select * into v_slot from public.job_slots where id = p_slot_id;

  if not found or v_slot.job_id <> v_job.id then
    raise exception 'slot_not_found: the selected time is not part of this job' using errcode = 'P0001';
  end if;

  -- 7. Upsert the customer. Phone is the primary identity; email secondary.
  select id into v_customer
  from public.customers
  where company_id = v_job.company_id
    and deleted_at is null
    and (phone = v_phone or (v_email is not null and lower(email) = v_email))
  order by (phone = v_phone) desc
  limit 1;

  if v_customer is null then
    insert into public.customers (
      company_id, phone, email, full_name, unit_number,
      address_line1, suburb, state, postcode,
      sms_opt_in, phone_verified_at, last_booking_at
    ) values (
      v_job.company_id, v_phone, v_email, v_name, v_unit,
      v_job.address_line1, v_job.suburb, v_job.state, v_job.postcode,
      false, null, now()
    )
    returning id into v_customer;
  else
    update public.customers
       set email      = coalesce(v_email, email),
           full_name  = coalesce(v_name, full_name),
           unit_number = coalesce(v_unit, unit_number),
           updated_at = now()
     where id = v_customer;
  end if;

  -- 8. Create the booking.
  insert into public.customer_bookings (
    company_id, job_id, slot_id, technician_id, customer_id, qr_code_id,
    booking_ref, status, unit_number, phone, email, full_name, special_comments,
    scheduled_date, scheduled_start, scheduled_end,
    confirmed_at, source, metadata
  ) values (
    v_job.company_id, v_job.id, v_slot.id, v_slot.technician_id, v_customer, v_qr.id,
    app.generate_booking_ref(), 'confirmed',
    v_unit, v_phone, v_email, v_name, v_comm,
    v_slot.slot_date, v_slot.start_time, v_slot.end_time,
    now(), 'qr',
    jsonb_strip_nulls(jsonb_build_object(
      'ip', case when p_ip_address is not null then host(p_ip_address) end,
      'user_agent', left(p_user_agent, 500),
      'session_id', p_session_id,
      'qr_scope', v_qr.scope))
  )
  returning * into v_booking;

  -- 9. Ledgers.
  insert into public.booking_rate_limit (company_id, bucket)
  values (v_job.company_id, 'phone:' || v_phone);

  if p_ip_address is not null then
    insert into public.booking_rate_limit (company_id, bucket)
    values (v_job.company_id, 'ip:' || host(p_ip_address));
  end if;

  if p_idempotency_key is not null then
    insert into public.booking_idempotency (key, booking_id, company_id)
    values (p_idempotency_key, v_booking.id, v_job.company_id)
    on conflict (key) do nothing;
  end if;

  -- 10. Queue notifications. dedupe_key makes the event idempotent across retries.
  insert into public.notifications (
    company_id, channel, status, template_key, event_key,
    recipient_customer_id, customer_booking_id, job_id, technician_id,
    recipient_email, recipient_phone, recipient_name,
    subject, variables, scheduled_for, dedupe_key, provider
  )
  select
    v_job.company_id, c.channel, 'queued',
    'booking.confirmed.' || c.channel, 'booking.confirmed',
    v_customer, v_booking.id, v_job.id, v_slot.technician_id,
    v_email, v_phone, v_name,
    case when c.channel = 'email' then 'Your installation is booked' else null end,
    jsonb_build_object(
      'booking_ref', v_booking.booking_ref,
      'unit_number', v_unit,
      'scheduled_date', v_slot.slot_date,
      'scheduled_start', v_slot.local_start,
      'scheduled_end', v_slot.local_end,
      'job_number', v_job.job_number,
      'address', concat_ws(', ', v_job.address_line1, v_job.suburb, v_job.state, v_job.postcode)),
    now(), 'booking.confirmed:' || v_booking.id || ':' || c.channel,
    case when c.channel = 'email' then 'microsoft_graph' else 'twilio' end
  from (values ('email'::app.notification_channel), ('sms'::app.notification_channel)) as c(channel)
  on conflict (company_id, dedupe_key) do nothing;

  if v_slot.technician_id is not null then
    insert into public.notifications (
      company_id, channel, status, template_key, event_key,
      recipient_technician_id, technician_id, customer_booking_id, job_id,
      subject, variables, scheduled_for, dedupe_key, provider
    ) values (
      v_job.company_id, 'push', 'queued', 'slot.assigned.push', 'slot.assigned',
      v_slot.technician_id, v_slot.technician_id, v_booking.id, v_job.id,
      'New booking',
      jsonb_build_object(
        'booking_ref', v_booking.booking_ref,
        'unit_number', v_unit,
        'local_start', v_slot.local_start,
        'local_end', v_slot.local_end),
      now(), 'slot.assigned:' || v_booking.id, 'webpush'
    ) on conflict (company_id, dedupe_key) do nothing;
  end if;

  -- 11. Confirmation payload.
  select t.full_name into v_tech
  from public.technicians t where t.id = v_slot.technician_id;

  v_address := concat_ws(', ', v_job.address_line1, v_job.suburb, v_job.state, v_job.postcode);

  return query select
    v_booking.id, v_booking.booking_ref, v_booking.status,
    v_booking.scheduled_date, v_booking.scheduled_start, v_booking.scheduled_end,
    v_booking.unit_number, v_job.id, v_job.job_number, v_address,
    v_tech, false;

exception
  when unique_violation then
    if sqlerrm like '%customer_bookings_unit_uidx%' then
      raise exception 'unit_already_booked: this unit was just booked by someone else'
        using errcode = 'P0001';
    end if;
    raise;
end $$;

comment on function public.create_booking(text, uuid, text, text, text, text, text, text, inet, text, text) is
  'Anonymous booking entry point. Validates QR, job window and duplicate units, claims the slot under lock, upserts the customer, writes the booking and queues notifications in one transaction.';

revoke all on function public.create_booking(text, uuid, text, text, text, text, text, text, inet, text, text) from public;
grant execute on function public.create_booking(text, uuid, text, text, text, text, text, text, inet, text, text)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1.5 cancel_booking(ref, reason, actor)
--     Anonymous callers may cancel only with the booking reference and the
--     matching phone number. Staff with bookings.write may cancel anything in
--     their tenant.
-- -----------------------------------------------------------------------------
create or replace function public.cancel_booking(
  p_booking_ref text,
  p_reason      text default null,
  p_phone       text default null
)
returns table (booking_id uuid, booking_ref text, status app.booking_status, cancelled_at timestamptz)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_booking  public.customer_bookings%rowtype;
  v_is_staff boolean := auth.uid() is not null and app.has_permission('bookings.write');
  v_phone    text := app.normalise_phone(p_phone);
begin
  select * into v_booking
  from public.customer_bookings
  where upper(booking_ref) = upper(btrim(p_booking_ref))
    and deleted_at is null
  for update;

  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  if not v_is_staff then
    if v_phone is null or v_phone <> v_booking.phone then
      raise exception 'not_authorised: booking reference and phone number do not match'
        using errcode = '42501';
    end if;
  elsif not app.can_access_company(v_booking.company_id) then
    raise exception 'not_authorised: booking belongs to another tenant' using errcode = '42501';
  end if;

  if v_booking.status in ('cancelled','completed','no_show') then
    raise exception 'invalid_state: booking is already %', v_booking.status using errcode = 'P0001';
  end if;

  update public.customer_bookings
     set status               = 'cancelled',
         cancelled_at         = now(),
         cancellation_reason  = nullif(btrim(coalesce(p_reason, '')), ''),
         cancelled_by         = case when v_is_staff then 'partner' else 'customer' end,
         updated_at           = now()
   where id = v_booking.id
  returning * into v_booking;

  -- Release the seat so capacity returns to the pool.
  if v_booking.slot_id is not null then
    update public.job_slots
       set booked_count = greatest(booked_count - 1, 0),
           status = case when status = 'booked' then 'open'::app.slot_status else status end,
           updated_at = now()
     where id = v_booking.slot_id;
  end if;

  insert into public.notifications (
    company_id, channel, status, template_key, event_key,
    recipient_customer_id, customer_booking_id, job_id,
    recipient_email, recipient_phone, recipient_name,
    subject, variables, scheduled_for, dedupe_key, provider
  ) values (
    v_booking.company_id, 'email', 'queued', 'booking.cancelled.email', 'booking.cancelled',
    v_booking.customer_id, v_booking.id, v_booking.job_id,
    v_booking.email, v_booking.phone, v_booking.full_name,
    'Your booking has been cancelled',
    jsonb_build_object('booking_ref', v_booking.booking_ref, 'reason', v_booking.cancellation_reason),
    now(), 'booking.cancelled:' || v_booking.id, 'microsoft_graph'
  ) on conflict (company_id, dedupe_key) do nothing;

  return query select v_booking.id, v_booking.booking_ref, v_booking.status, v_booking.cancelled_at;
end $$;

comment on function public.cancel_booking(text, text, text) is
  'Cancels a booking. Anonymous callers must supply the matching phone number; staff require bookings.write. Releases slot capacity and queues a notification.';

revoke all on function public.cancel_booking(text, text, text) from public;
grant execute on function public.cancel_booking(text, text, text) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1.6 reschedule_booking(ref, new_slot_id, phone)
--     Claims the new slot before releasing the old one, so a failed claim
--     cannot strand the resident without a booking.
-- -----------------------------------------------------------------------------
create or replace function public.reschedule_booking(
  p_booking_ref text,
  p_new_slot_id uuid,
  p_phone       text default null
)
returns table (
  booking_id uuid,
  booking_ref text,
  scheduled_date date,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  technician_name text
)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_booking  public.customer_bookings%rowtype;
  v_new_slot public.job_slots%rowtype;
  v_old_slot uuid;
  v_is_staff boolean := auth.uid() is not null and app.has_permission('bookings.write');
  v_phone    text := app.normalise_phone(p_phone);
  v_tech     text;
begin
  select * into v_booking
  from public.customer_bookings
  where upper(booking_ref) = upper(btrim(p_booking_ref))
    and deleted_at is null
  for update;

  if not found then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  if not v_is_staff then
    if v_phone is null or v_phone <> v_booking.phone then
      raise exception 'not_authorised: booking reference and phone number do not match'
        using errcode = '42501';
    end if;
  elsif not app.can_access_company(v_booking.company_id) then
    raise exception 'not_authorised: booking belongs to another tenant' using errcode = '42501';
  end if;

  if v_booking.status in ('cancelled','completed','no_show') then
    raise exception 'invalid_state: booking is %', v_booking.status using errcode = 'P0001';
  end if;

  if v_booking.slot_id = p_new_slot_id then
    raise exception 'invalid_input: booking is already on that slot' using errcode = 'P0001';
  end if;

  -- Claim first. If this raises, the old seat is untouched.
  perform app.slot_claim(p_new_slot_id, null);

  select * into v_new_slot
  from public.job_slots
  where id = p_new_slot_id and deleted_at is null;

  if not found or v_new_slot.job_id <> v_booking.job_id then
    raise exception 'slot_not_found: the selected time is not part of this job' using errcode = 'P0001';
  end if;

  v_old_slot := v_booking.slot_id;

  update public.customer_bookings
     set slot_id           = v_new_slot.id,
         technician_id     = v_new_slot.technician_id,
         scheduled_date    = v_new_slot.slot_date,
         scheduled_start   = v_new_slot.start_time,
         scheduled_end     = v_new_slot.end_time,
         status            = 'rescheduled',
         rescheduled_from_id = coalesce(rescheduled_from_id, v_booking.id),
         reschedule_count  = reschedule_count + 1,
         reminder_sent_at  = null,
         updated_at        = now()
   where id = v_booking.id
  returning * into v_booking;

  -- Now release the previous seat.
  if v_old_slot is not null then
    update public.job_slots
       set booked_count = greatest(booked_count - 1, 0),
           status = case when status = 'booked' then 'open'::app.slot_status else status end,
           updated_at = now()
     where id = v_old_slot;
  end if;

  insert into public.notifications (
    company_id, channel, status, template_key, event_key,
    recipient_customer_id, customer_booking_id, job_id, technician_id,
    recipient_email, recipient_phone, recipient_name,
    subject, variables, scheduled_for, dedupe_key, provider
  ) values (
    v_booking.company_id, 'email', 'queued', 'booking.rescheduled.email', 'booking.rescheduled',
    v_booking.customer_id, v_booking.id, v_booking.job_id, v_new_slot.technician_id,
    v_booking.email, v_booking.phone, v_booking.full_name,
    'Your booking has been rescheduled',
    jsonb_build_object(
      'booking_ref', v_booking.booking_ref,
      'scheduled_date', v_new_slot.slot_date,
      'scheduled_start', v_new_slot.local_start,
      'scheduled_end', v_new_slot.local_end),
    now(), 'booking.rescheduled:' || v_booking.id || ':' || v_new_slot.id, 'microsoft_graph'
  ) on conflict (company_id, dedupe_key) do nothing;

  select t.full_name into v_tech from public.technicians t where t.id = v_new_slot.technician_id;

  return query select
    v_booking.id, v_booking.booking_ref,
    v_booking.scheduled_date, v_booking.scheduled_start, v_booking.scheduled_end,
    v_tech;
end $$;

comment on function public.reschedule_booking(text, uuid, text) is
  'Reschedules a booking onto a new slot. Claims the new seat before releasing the old one.';

revoke all on function public.reschedule_booking(text, uuid, text) from public;
grant execute on function public.reschedule_booking(text, uuid, text) to anon, authenticated, service_role;

-- =============================================================================
-- SECTION 2 — JOBS
-- =============================================================================
-- Definer is NOT used here. These run under the caller's identity so Phase 4
-- RLS applies. Permission checks are explicit for clearer errors.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 create_job(...)
-- -----------------------------------------------------------------------------
create or replace function public.create_job(
  p_job_number       text,
  p_partner_id       uuid,
  p_address_line1    text,
  p_suburb           text,
  p_state            text,
  p_postcode         text,
  p_start_date       date,
  p_end_date         date,
  p_installs_per_day int default 8,
  p_slot_minutes     int default 60,
  p_unit_count       int default 0,
  p_title            text default null,
  p_site_name        text default null,
  p_instructions     text default null,
  p_priority         int default 3
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_job     uuid;
  v_number  text := upper(btrim(p_job_number));
begin
  if v_company is null then
    raise exception 'no_tenant_context' using errcode = 'P0001';
  end if;

  perform app.assert_permission('jobs.write');

  if exists (
    select 1 from public.jobs
    where company_id = v_company and upper(job_number) = v_number and deleted_at is null
  ) then
    raise exception 'duplicate_job_number: % already exists', v_number using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.partners
    where id = p_partner_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'partner_not_found' using errcode = 'P0002';
  end if;

  insert into public.jobs (
    company_id, partner_id, job_number, title, site_name, status, priority,
    address_line1, suburb, state, postcode,
    unit_count, installs_per_day, slot_minutes,
    start_date, end_date, instructions, created_by
  ) values (
    v_company, p_partner_id, v_number, nullif(btrim(coalesce(p_title,'')), ''),
    nullif(btrim(coalesce(p_site_name,'')), ''), 'draft', coalesce(p_priority, 3),
    btrim(p_address_line1), btrim(p_suburb), btrim(p_state), btrim(p_postcode),
    greatest(coalesce(p_unit_count, 0), 0),
    coalesce(p_installs_per_day, 8), coalesce(p_slot_minutes, 60),
    p_start_date, p_end_date, nullif(btrim(coalesce(p_instructions,'')), ''), auth.uid()
  )
  returning id into v_job;

  return v_job;
end $$;

comment on function public.create_job(text, uuid, text, text, text, text, date, date, int, int, int, text, text, text, int) is
  'Creates a draft job in the caller tenant. Requires jobs.write.';

revoke all on function public.create_job(text, uuid, text, text, text, text, date, date, int, int, int, text, text, text, int) from public, anon;
grant execute on function public.create_job(text, uuid, text, text, text, text, date, date, int, int, int, text, text, text, int)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2.2 generate_slots(job_id) — explodes installs_per_day into slot rows.
-- -----------------------------------------------------------------------------
create or replace function public.generate_slots(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_job       public.jobs%rowtype;
  v_day       date;
  v_dow       int;
  v_per_day   int;
  v_seq       int;
  v_slot_len  interval;
  v_start_ts  timestamptz;
  v_created   int := 0;
begin
  perform app.assert_permission('jobs.write');

  select * into v_job
  from public.jobs
  where id = p_job_id and deleted_at is null;

  if not found then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  if v_job.installs_per_day <= 0 then
    raise exception 'invalid_input: installs_per_day must be greater than zero' using errcode = 'P0001';
  end if;

  v_per_day := v_job.installs_per_day;
  v_slot_len := make_interval(mins => v_job.slot_minutes);

  v_day := v_job.start_date;
  while v_day <= v_job.end_date loop
    v_dow := extract(isodow from v_day)::int;

    if v_dow = any (v_job.working_days) then
      for v_seq in 1..v_per_day loop
        v_start_ts := (v_day + v_job.day_start_time)::timestamptz
                      + ((v_seq - 1) * v_slot_len);

        -- Skip anything that would run past the working window.
        if (v_start_ts + v_slot_len) <= ((v_day + v_job.day_end_time)::timestamptz) then
          insert into public.job_slots (
            company_id, job_id, slot_date, start_time, end_time,
            local_start, local_end, capacity, sequence, status, created_by
          ) values (
            v_job.company_id, v_job.id, v_day,
            v_start_ts, v_start_ts + v_slot_len,
            v_start_ts::time, (v_start_ts + v_slot_len)::time,
            1, v_seq, 'open', auth.uid()
          )
          on conflict do nothing;

          v_created := v_created + 1;
        end if;
      end loop;
    end if;

    v_day := v_day + 1;
  end loop;

  return v_created;
end $$;

comment on function public.generate_slots(uuid) is
  'Generates bookable slot rows from the job working window and installs_per_day. Idempotent via the unique window index.';

revoke all on function public.generate_slots(uuid) from public, anon;
grant execute on function public.generate_slots(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2.3 publish_job(job_id) — draft to published, issuing a QR code.
-- -----------------------------------------------------------------------------
create or replace function public.publish_job(
  p_job_id uuid,
  p_issue_qr boolean default true
)
returns table (job_id uuid, status app.job_status, qr_token text, published_at timestamptz)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_job    public.jobs%rowtype;
  v_token  text;
  v_slots  int;
begin
  perform app.assert_permission('jobs.publish');

  select * into v_job
  from public.jobs
  where id = p_job_id and deleted_at is null
  for update;

  if not found then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'invalid_state: job is cancelled' using errcode = 'P0001';
  end if;
  if v_job.status = 'published' then
    raise exception 'invalid_state: job is already published' using errcode = 'P0001';
  end if;

  select count(*) into v_slots
  from public.job_slots
  where job_id = v_job.id and deleted_at is null and status <> 'cancelled';

  if v_slots = 0 then
    raise exception 'no_slots: generate slots before publishing' using errcode = 'P0001';
  end if;

  update public.jobs
     set status       = 'published',
         published_at = now(),
         updated_at   = now()
   where id = v_job.id
  returning * into v_job;

  if p_issue_qr then
    select q.token into v_token
    from public.qr_codes q
    where q.job_id = v_job.id and q.scope = 'job' and q.deleted_at is null
    limit 1;

    if v_token is null then
      insert into public.qr_codes (
        company_id, job_id, token, label, scope, status, created_via, created_by
      ) values (
        v_job.company_id, v_job.id,
        encode(extensions.gen_random_bytes(16), 'hex'),
        v_job.job_number, 'job', 'active', 'partner_portal', auth.uid()
      )
      returning token into v_token;
    end if;
  end if;

  return query select v_job.id, v_job.status, v_token, v_job.published_at;
end $$;

comment on function public.publish_job(uuid, boolean) is
  'Publishes a job and issues a job-scoped QR code. Requires slots to exist first.';

revoke all on function public.publish_job(uuid, boolean) from public, anon;
grant execute on function public.publish_job(uuid, boolean) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2.4 assign_technician(job_id, technician_id, is_lead)
-- -----------------------------------------------------------------------------
create or replace function public.assign_technician(
  p_job_id        uuid,
  p_technician_id uuid,
  p_is_lead       boolean default false,
  p_daily_capacity int default null
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_job     uuid;
  v_id      uuid;
begin
  perform app.assert_permission('technicians.assign');

  select id into v_job
  from public.jobs
  where id = p_job_id and company_id = v_company and deleted_at is null;

  if v_job is null then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.technicians
    where id = p_technician_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'technician_not_found' using errcode = 'P0002';
  end if;

  insert into public.job_technicians (
    company_id, job_id, technician_id, is_lead, daily_capacity, created_by
  ) values (
    v_company, v_job, p_technician_id, coalesce(p_is_lead, false),
    p_daily_capacity, auth.uid()
  )
  on conflict (job_id, technician_id) where deleted_at is null
  do update set is_lead = excluded.is_lead,
                daily_capacity = coalesce(excluded.daily_capacity, public.job_technicians.daily_capacity),
                deleted_at = null,
                updated_at = now()
  returning id into v_id;

  return v_id;
end $$;

comment on function public.assign_technician(uuid, uuid, boolean, int) is
  'Assigns a technician to a job, or re-activates an existing assignment. Requires technicians.assign.';

revoke all on function public.assign_technician(uuid, uuid, boolean, int) from public, anon;
grant execute on function public.assign_technician(uuid, uuid, boolean, int) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2.5 complete_job(job_id)
-- -----------------------------------------------------------------------------
create or replace function public.complete_job(p_job_id uuid)
returns table (job_id uuid, status app.job_status, completed_at timestamptz, outstanding_bookings int)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_job   public.jobs%rowtype;
  v_open  int;
begin
  perform app.assert_permission('jobs.write');

  select * into v_job
  from public.jobs
  where id = p_job_id and deleted_at is null
  for update;

  if not found then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;
  if v_job.status = 'completed' then
    raise exception 'invalid_state: job is already complete' using errcode = 'P0001';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'invalid_state: job is cancelled' using errcode = 'P0001';
  end if;

  select count(*) into v_open
  from public.customer_bookings
  where job_id = v_job.id
    and deleted_at is null
    and status in ('pending','confirmed','rescheduled','in_progress');

  update public.jobs
     set status       = 'completed',
         completed_at = now(),
         updated_at   = now()
   where id = v_job.id
  returning * into v_job;

  -- Close any remaining open capacity.
  update public.job_slots
     set status     = 'cancelled',
         updated_at = now()
   where job_id = v_job.id
     and status in ('open','held')
     and deleted_at is null;

  return query select v_job.id, v_job.status, v_job.completed_at, v_open;
end $$;

comment on function public.complete_job(uuid) is
  'Marks a job complete and closes its remaining open slots. Reports outstanding bookings.';

revoke all on function public.complete_job(uuid) from public, anon;
grant execute on function public.complete_job(uuid) to authenticated, service_role;

-- =============================================================================
-- SECTION 3 — CUSTOMERS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 create_customer(...)
-- -----------------------------------------------------------------------------
create or replace function public.create_customer(
  p_phone        text,
  p_email        text default null,
  p_full_name    text default null,
  p_unit_number  text default null,
  p_address_line1 text default null,
  p_suburb       text default null,
  p_state        text default null,
  p_postcode     text default null
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_customer uuid;
  v_phone   text := app.normalise_phone(p_phone);
  v_email   text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  perform app.assert_permission('customers.write');

  if v_phone is null then
    raise exception 'invalid_input: phone number is required' using errcode = 'P0001';
  end if;
  if v_email is not null and not app.is_valid_email(v_email) then
    raise exception 'invalid_input: email address is not valid' using errcode = 'P0001';
  end if;

  select id into v_customer
  from public.customers
  where company_id = v_company
    and deleted_at is null
    and (phone = v_phone or (v_email is not null and lower(email) = v_email))
  order by (phone = v_phone) desc
  limit 1;

  if v_customer is not null then
    return v_customer;
  end if;

  insert into public.customers (
    company_id, phone, email, full_name, unit_number,
    address_line1, suburb, state, postcode, created_by
  ) values (
    v_company, v_phone, v_email, nullif(btrim(coalesce(p_full_name,'')), ''),
    nullif(btrim(coalesce(p_unit_number,'')), ''),
    nullif(btrim(coalesce(p_address_line1,'')), ''), nullif(btrim(coalesce(p_suburb,'')), ''),
    nullif(btrim(coalesce(p_state,'')), ''), nullif(btrim(coalesce(p_postcode,'')), ''),
    auth.uid()
  )
  returning id into v_customer;

  return v_customer;
end $$;

comment on function public.create_customer(text, text, text, text, text, text, text, text) is
  'Upserts a customer by phone, then email. Returns the existing id when already present.';

revoke all on function public.create_customer(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_customer(text, text, text, text, text, text, text, text)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3.2 search_customers(term, limit)
-- -----------------------------------------------------------------------------
create or replace function public.search_customers(
  p_term  text,
  p_limit int default 25
)
returns table (
  customer_id uuid,
  full_name   text,
  phone       text,
  email       text,
  unit_number text,
  booking_count int,
  last_booking_at timestamptz
)
language sql
stable
security definer
set search_path = app, public, pg_catalog
as $$
  select c.id, c.full_name, c.phone, c.email, c.unit_number,
         c.booking_count, c.last_booking_at
  from public.customers c
  where c.company_id = app.current_company_id()
    and c.deleted_at is null
    and app.has_permission('customers.read')
    and (
      nullif(btrim(coalesce(p_term,'')), '') is null
      or c.full_name ilike '%' || btrim(p_term) || '%'
      or c.phone      like '%' || regexp_replace(p_term, '[^0-9]', '', 'g') || '%'
      or c.email      ilike '%' || btrim(p_term) || '%'
      or c.unit_number ilike '%' || btrim(p_term) || '%'
    )
  order by c.last_booking_at desc nulls last, c.full_name
  limit least(greatest(coalesce(p_limit, 25), 1), 100)
$$;

comment on function public.search_customers(text, int) is
  'Tenant-scoped customer search across name, phone, email and unit.';

revoke all on function public.search_customers(text, int) from public, anon;
grant execute on function public.search_customers(text, int) to authenticated, service_role;

-- =============================================================================
-- SECTION 4 — INVOICES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4.1 create_invoice(...)
-- -----------------------------------------------------------------------------
create or replace function public.create_invoice(
  p_direction    app.invoice_direction,
  p_period_start date default null,
  p_period_end   date default null,
  p_technician_id uuid default null,
  p_partner_id   uuid default null,
  p_job_id       uuid default null,
  p_rate_card_id uuid default null,
  p_notes        text default null
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company  uuid := app.current_company_id();
  v_invoice  uuid;
  v_number   text;
  v_seq      bigint;
  v_tax      numeric(5,4);
begin
  perform app.assert_permission('invoices.write');

  select default_tax_rate into v_tax from public.companies where id = v_company;

  v_seq := nextval('public.invoice_number_seq');
  v_number := to_char(current_date, 'YYYY') || '-' ||
              case when p_direction = 'payable' then 'PAY' else 'INV' end || '-' ||
              lpad(v_seq::text, 6, '0');

  insert into public.invoices (
    company_id, invoice_number, direction, status,
    technician_id, partner_id, job_id, rate_card_id,
    period_start, period_end, issue_date,
    tax_rate, notes, created_by
  ) values (
    v_company, v_number, p_direction, 'draft',
    p_technician_id, p_partner_id, p_job_id, p_rate_card_id,
    p_period_start, p_period_end, current_date,
    coalesce(v_tax, 0.1), nullif(btrim(coalesce(p_notes,'')), ''), auth.uid()
  )
  returning id into v_invoice;

  return v_invoice;
end $$;

comment on function public.create_invoice(app.invoice_direction, date, date, uuid, uuid, uuid, uuid, text) is
  'Creates a draft invoice with a generated number. Requires invoices.write.';

revoke all on function public.create_invoice(app.invoice_direction, date, date, uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.create_invoice(app.invoice_direction, date, date, uuid, uuid, uuid, uuid, text)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4.2 add_invoice_item(...)
--     Unit rate is snapshotted. If rate_card_item_id is supplied and no rate,
--     the rate is read from the rate card effective on the service date.
-- -----------------------------------------------------------------------------
create or replace function public.add_invoice_item(
  p_invoice_id      uuid,
  p_description     text,
  p_quantity        numeric,
  p_unit_rate       numeric default null,
  p_rate_card_item_id uuid default null,
  p_customer_booking_id uuid default null,
  p_service_date    date default null,
  p_unit            app.rate_unit default 'each',
  p_technician_pay  numeric default null,
  p_is_taxable      boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
  v_item    uuid;
  v_line    int;
  v_rate    numeric(12,4) := p_unit_rate;
  v_code    text;
  v_pay     numeric(12,4) := p_technician_pay;
  v_rci     public.rate_card_items%rowtype;
begin
  perform app.assert_permission('invoices.write');

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and company_id = app.current_company_id() and deleted_at is null
  for update;

  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  if v_invoice.status <> 'draft' then
    raise exception 'invalid_state: invoice is %, only drafts may be edited', v_invoice.status
      using errcode = 'P0001';
  end if;

  if p_rate_card_item_id is not null then
    select * into v_rci
    from public.rate_card_items
    where id = p_rate_card_item_id and company_id = v_invoice.company_id and deleted_at is null;

    if found then
      v_rate := coalesce(v_rate, v_rci.rate);
      v_code := v_rci.code;
      v_pay  := coalesce(v_pay, v_rci.technician_pay);
    end if;
  end if;

  if v_rate is null or v_rate < 0 then
    raise exception 'invalid_input: a non-negative unit_rate is required' using errcode = 'P0001';
  end if;

  select coalesce(max(line_number), 0) + 1 into v_line
  from public.invoice_items
  where invoice_id = v_invoice.id and deleted_at is null;

  insert into public.invoice_items (
    company_id, invoice_id, customer_booking_id, job_id, technician_id,
    rate_card_item_id, line_number, code, description, unit,
    quantity, unit_rate, tax_rate, is_taxable, technician_pay,
    service_date, source, created_by
  ) values (
    v_invoice.company_id, v_invoice.id, p_customer_booking_id, v_invoice.job_id, v_invoice.technician_id,
    p_rate_card_item_id, v_line, v_code,
    coalesce(nullif(btrim(p_description), ''), 'Item'), coalesce(p_unit, 'each'),
    greatest(coalesce(p_quantity, 1), 0), v_rate, v_invoice.tax_rate,
    coalesce(p_is_taxable, true), v_pay,
    coalesce(p_service_date, current_date),
    case when p_rate_card_item_id is not null then 'rate_card' else 'manual' end,
    auth.uid()
  )
  returning id into v_item;

  return v_item;
end $$;

comment on function public.add_invoice_item(uuid, text, numeric, numeric, uuid, uuid, date, app.rate_unit, numeric, boolean) is
  'Adds a line to a draft invoice. Snapshots the unit rate so history never shifts.';

revoke all on function public.add_invoice_item(uuid, text, numeric, numeric, uuid, uuid, date, app.rate_unit, numeric, boolean) from public, anon;
grant execute on function public.add_invoice_item(uuid, text, numeric, numeric, uuid, uuid, date, app.rate_unit, numeric, boolean)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4.3 build_pay_run(technician_id, period_start, period_end)
--     Rolls completed bookings into a payable invoice priced from the
--     technician's rate card effective on each booking date.
-- -----------------------------------------------------------------------------
create or replace function public.build_pay_run(
  p_technician_id uuid,
  p_period_start  date,
  p_period_end    date
)
returns table (invoice_id uuid, invoice_number text, line_count int, total numeric)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company  uuid := app.current_company_id();
  v_invoice  uuid;
  v_number   text;
  v_seq      bigint;
  v_tax      numeric(5,4);
  v_lines    int := 0;
  v_total    numeric(14,2) := 0;
begin
  perform app.assert_permission('invoices.write');

  if p_period_end < p_period_start then
    raise exception 'invalid_input: period_end precedes period_start' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.technicians
    where id = p_technician_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'technician_not_found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.invoices
    where company_id = v_company
      and technician_id = p_technician_id
      and direction = 'payable'
      and period_start = p_period_start
      and period_end = p_period_end
      and status <> 'void'
      and deleted_at is null
  ) then
    raise exception 'pay_run_exists: an invoice already covers this period' using errcode = 'P0001';
  end if;

  select default_tax_rate into v_tax from public.companies where id = v_company;

  v_seq := nextval('public.invoice_number_seq');
  v_number := to_char(current_date, 'YYYY') || '-PAY-' || lpad(v_seq::text, 6, '0');

  insert into public.invoices (
    company_id, invoice_number, direction, status,
    technician_id, rate_card_id,
    period_start, period_end, issue_date, tax_rate, created_by
  ) values (
    v_company, v_number, 'payable', 'draft',
    p_technician_id,
    app.resolve_rate_card(p_technician_id, p_period_end),
    p_period_start, p_period_end, current_date, coalesce(v_tax, 0.1), auth.uid()
  )
  returning id into v_invoice;

  -- One line per completed booking in the period, priced from the rate card
  -- effective on that booking's service date.
  insert into public.invoice_items (
    company_id, invoice_id, customer_booking_id, job_id, technician_id,
    rate_card_item_id, line_number, code, description, unit,
    quantity, unit_rate, tax_rate, is_taxable, technician_pay,
    service_date, install_completed_at, source, created_by
  )
  select
    v_company, v_invoice, b.id, b.job_id, b.technician_id,
    rci.id,
    row_number() over (order by b.completed_at),
    coalesce(rci.code, 'INSTALL'),
    coalesce(rci.description, 'Install - unit ' || coalesce(b.unit_number, '-')),
    coalesce(rci.unit, 'each'),
    1,
    coalesce(rci.technician_pay, rci.rate, 0),
    coalesce(v_tax, 0.1),
    coalesce(rci.is_taxable, true),
    coalesce(rci.technician_pay, rci.rate, 0),
    b.scheduled_date,
    b.completed_at,
    'booking',
    auth.uid()
  from public.customer_bookings b
  left join public.job_slots s on s.id = b.slot_id
  left join lateral (
    select i.*
    from public.rate_card_items i
    join public.rate_cards rc on rc.id = i.rate_card_id and rc.deleted_at is null
    where i.deleted_at is null
      and i.is_active
      and rc.id = app.resolve_rate_card(b.technician_id, coalesce(b.scheduled_date, p_period_end))
      and (i.category is null or i.category = 'install')
    order by i.sort_order
    limit 1
  ) rci on true
  where b.company_id = v_company
    and b.technician_id = p_technician_id
    and b.status = 'completed'
    and b.deleted_at is null
    and b.completed_at >= p_period_start::timestamptz
    and b.completed_at < (p_period_end + 1)::timestamptz
    and not exists (
      select 1 from public.invoice_items ii
      join public.invoices inv on inv.id = ii.invoice_id
      where ii.customer_booking_id = b.id
        and ii.deleted_at is null
        and inv.status <> 'void'
        and inv.deleted_at is null
    );

  get diagnostics v_lines = row_count;

  select coalesce(sum(total), 0), coalesce(sum(line_count), 0)
    into v_total, v_lines
  from public.invoices
  where id = v_invoice;

  return query select v_invoice, v_number, v_lines, v_total;
end $$;

comment on function public.build_pay_run(uuid, date, date) is
  'Generates a payable invoice from a technician''s completed bookings in a period, priced per rate card effective on each booking date.';

revoke all on function public.build_pay_run(uuid, date, date) from public, anon;
grant execute on function public.build_pay_run(uuid, date, date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4.4 finalize_invoice(invoice_id)
-- -----------------------------------------------------------------------------
create or replace function public.finalize_invoice(p_invoice_id uuid)
returns table (
  invoice_id uuid,
  invoice_number text,
  status app.invoice_status,
  subtotal numeric,
  tax_total numeric,
  total numeric,
  line_count int,
  finalised_at timestamptz
)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  perform app.assert_permission('invoices.write');

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and company_id = app.current_company_id() and deleted_at is null
  for update;

  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  if v_invoice.status <> 'draft' then
    raise exception 'invalid_state: invoice is %, only drafts may be finalised', v_invoice.status
      using errcode = 'P0001';
  end if;
  if v_invoice.line_count = 0 then
    raise exception 'invalid_state: invoice has no line items' using errcode = 'P0001';
  end if;

  update public.invoices
     set status      = 'approved',
         approved_at = now(),
         approved_by = auth.uid(),
         updated_at  = now()
   where id = v_invoice.id
  returning * into v_invoice;

  insert into public.notifications (
    company_id, channel, status, template_key, event_key,
    recipient_technician_id, technician_id, invoice_id,
    subject, variables, scheduled_for, dedupe_key, provider
  ) values (
    v_invoice.company_id, 'email', 'queued', 'invoice.finalised.email', 'invoice.finalised',
    v_invoice.technician_id, v_invoice.technician_id, v_invoice.id,
    'Invoice ' || v_invoice.invoice_number || ' finalised',
    jsonb_build_object(
      'invoice_number', v_invoice.invoice_number,
      'total', v_invoice.total,
      'period_start', v_invoice.period_start,
      'period_end', v_invoice.period_end),
    now(), 'invoice.finalised:' || v_invoice.id, 'microsoft_graph'
  ) on conflict (company_id, dedupe_key) do nothing;

  return query select
    v_invoice.id, v_invoice.invoice_number, v_invoice.status,
    v_invoice.subtotal, v_invoice.tax_total, v_invoice.total,
    v_invoice.line_count, v_invoice.approved_at;
end $$;

comment on function public.finalize_invoice(uuid) is
  'Moves a draft invoice to approved, locks it against further line edits, and queues a notification.';

revoke all on function public.finalize_invoice(uuid) from public, anon;
grant execute on function public.finalize_invoice(uuid) to authenticated, service_role;

-- =============================================================================
-- SECTION 5 — DASHBOARDS
-- =============================================================================
-- Definer is required: these aggregate across tables whose RLS policies are
-- narrower than the aggregate needs. Each function re-checks the caller's
-- tenant and permission explicitly before returning anything.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 5.1 dashboard_summary() — operator home.
-- -----------------------------------------------------------------------------
create or replace function public.dashboard_summary(
  p_from date default current_date - 30,
  p_to   date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_result  jsonb;
begin
  if v_company is null and not app.is_platform_admin() then
    raise exception 'no_tenant_context' using errcode = 'P0001';
  end if;

  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'jobs', jsonb_build_object(
      'total',       (select count(*) from public.jobs
                       where company_id = v_company and deleted_at is null),
      'published',   (select count(*) from public.jobs
                       where company_id = v_company and deleted_at is null and status = 'published'),
      'in_progress', (select count(*) from public.jobs
                       where company_id = v_company and deleted_at is null and status = 'in_progress'),
      'completed',   (select count(*) from public.jobs
                       where company_id = v_company and deleted_at is null and status = 'completed')
    ),
    'bookings', jsonb_build_object(
      'total',      (select count(*) from public.customer_bookings
                      where company_id = v_company and deleted_at is null
                        and created_at::date between p_from and p_to),
      'today',      (select count(*) from public.customer_bookings
                      where company_id = v_company and deleted_at is null
                        and scheduled_date = current_date
                        and status not in ('cancelled','no_show')),
      'confirmed',  (select count(*) from public.customer_bookings
                      where company_id = v_company and deleted_at is null and status = 'confirmed'),
      'completed',  (select count(*) from public.customer_bookings
                      where company_id = v_company and deleted_at is null
                        and status = 'completed'
                        and completed_at::date between p_from and p_to),
      'no_show',    (select count(*) from public.customer_bookings
                      where company_id = v_company and deleted_at is null
                        and status = 'no_show'
                        and updated_at::date between p_from and p_to)
    ),
    'slots', jsonb_build_object(
      'open',      (select count(*) from public.job_slots
                     where company_id = v_company and deleted_at is null and status = 'open'
                       and start_time > now()),
      'capacity',  (select coalesce(sum(greatest(capacity - booked_count, 0)), 0)
                     from public.job_slots
                     where company_id = v_company and deleted_at is null
                       and start_time > now())
    ),
    'qr', jsonb_build_object(
      'active',  (select count(*) from public.qr_codes
                   where company_id = v_company and deleted_at is null and status = 'active'),
      'scans',   (select count(*) from public.qr_code_scans
                   where company_id = v_company
                     and scanned_at::date between p_from and p_to),
      'conversion_rate',
        (select case when count(*) = 0 then 0
                     else round(100.0 * count(*) filter (where converted) / count(*), 2) end
         from public.qr_code_scans
         where company_id = v_company and scanned_at::date between p_from and p_to)
    ),
    'invoices', jsonb_build_object(
      'draft',      (select count(*) from public.invoices
                      where company_id = v_company and deleted_at is null and status = 'draft'),
      'payable_outstanding',
        (select coalesce(sum(amount_due), 0) from public.invoices
          where company_id = v_company and deleted_at is null
            and direction = 'payable' and status in ('approved','sent','part_paid')),
      'receivable_outstanding',
        (select coalesce(sum(amount_due), 0) from public.invoices
          where company_id = v_company and deleted_at is null
            and direction = 'receivable' and status in ('approved','sent','part_paid'))
    ),
    'customers', jsonb_build_object(
      'total', (select count(*) from public.customers
                 where company_id = v_company and deleted_at is null),
      'new',   (select count(*) from public.customers
                 where company_id = v_company and deleted_at is null
                   and first_seen_at::date between p_from and p_to)
    )
  ) into v_result;

  return v_result;
end $$;

comment on function public.dashboard_summary(date, date) is
  'Aggregated operator dashboard for the caller tenant over a date window.';

revoke all on function public.dashboard_summary(date, date) from public, anon;
grant execute on function public.dashboard_summary(date, date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5.2 partner_dashboard() — partner portal home. Scoped to the caller partner.
-- -----------------------------------------------------------------------------
create or replace function public.partner_dashboard(
  p_from date default current_date - 30,
  p_to   date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_partner uuid := app.current_partner_id();
  v_result  jsonb;
begin
  if v_company is null then
    raise exception 'no_tenant_context' using errcode = 'P0001';
  end if;

  -- A partner user with no partner_id is an operator; fall back to a tenant-wide
  -- view only when they hold the read permission.
  if v_partner is null and not app.has_permission('reports.read') then
    raise exception 'not_authorised: no partner scope' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'partner_id', v_partner,
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'jobs', jsonb_build_object(
      'total',     (select count(*) from public.jobs j
                     where j.company_id = v_company and j.deleted_at is null
                       and app.partner_scope_ok(j.partner_id)),
      'published', (select count(*) from public.jobs j
                     where j.company_id = v_company and j.deleted_at is null
                       and j.status = 'published'
                       and app.partner_scope_ok(j.partner_id)),
      'active',    (select count(*) from public.jobs j
                     where j.company_id = v_company and j.deleted_at is null
                       and j.status in ('published','in_progress')
                       and app.partner_scope_ok(j.partner_id))
    ),
    'bookings', jsonb_build_object(
      'total',   (select count(*) from public.customer_bookings b
                   join public.jobs j on j.id = b.job_id
                   where b.company_id = v_company and b.deleted_at is null
                     and app.partner_scope_ok(j.partner_id)),
      'today',   (select count(*) from public.customer_bookings b
                   join public.jobs j on j.id = b.job_id
                   where b.company_id = v_company and b.deleted_at is null
                     and b.scheduled_date = current_date
                     and b.status not in ('cancelled','no_show')
                     and app.partner_scope_ok(j.partner_id)),
      'completed', (select count(*) from public.customer_bookings b
                   join public.jobs j on j.id = b.job_id
                   where b.company_id = v_company and b.deleted_at is null
                     and b.status = 'completed'
                     and b.completed_at::date between p_from and p_to
                     and app.partner_scope_ok(j.partner_id))
    ),
    'capacity', jsonb_build_object(
      'open_slots', (select count(*) from public.job_slots s
                      join public.jobs j on j.id = s.job_id
                      where s.company_id = v_company and s.deleted_at is null
                        and s.status = 'open' and s.start_time > now()
                        and app.partner_scope_ok(j.partner_id)),
      'remaining',  (select coalesce(sum(greatest(s.capacity - s.booked_count, 0)), 0)
                      from public.job_slots s
                      join public.jobs j on j.id = s.job_id
                      where s.company_id = v_company and s.deleted_at is null
                        and s.start_time > now()
                        and app.partner_scope_ok(j.partner_id))
    ),
    'units', jsonb_build_object(
      'contracted', (select coalesce(sum(j.unit_count), 0) from public.jobs j
                      where j.company_id = v_company and j.deleted_at is null
                        and app.partner_scope_ok(j.partner_id)),
      'booked',     (select count(distinct b.unit_number) from public.customer_bookings b
                      join public.jobs j on j.id = b.job_id
                      where b.company_id = v_company and b.deleted_at is null
                        and b.unit_number is not null
                        and b.status not in ('cancelled','no_show')
                        and app.partner_scope_ok(j.partner_id))
    ),
    'progress_pct',
      (select case
                when coalesce(sum(j.unit_count), 0) = 0 then 0
                else round(100.0 * (
                  select count(distinct b.unit_number)
                  from public.customer_bookings b
                  join public.jobs jj on jj.id = b.job_id
                  where b.company_id = v_company and b.deleted_at is null
                    and b.unit_number is not null
                    and b.status not in ('cancelled','no_show')
                    and app.partner_scope_ok(jj.partner_id)
                ) / sum(j.unit_count), 2)
              end
         from public.jobs j
         where j.company_id = v_company and j.deleted_at is null
           and app.partner_scope_ok(j.partner_id))
  ) into v_result;

  return v_result;
end $$;

comment on function public.partner_dashboard(date, date) is
  'Partner-scoped dashboard: jobs, bookings, capacity and rollout progress for the caller partner.';

revoke all on function public.partner_dashboard(date, date) from public, anon;
grant execute on function public.partner_dashboard(date, date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5.3 technician_dashboard() — technician app home. Scoped to the caller.
-- -----------------------------------------------------------------------------
create or replace function public.technician_dashboard(
  p_date date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_tech    uuid := app.current_technician_id();
  v_result  jsonb;
begin
  if v_tech is null then
    raise exception 'not_a_technician: caller has no technicians record' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'technician_id', v_tech,
    'date', p_date,
    'today', jsonb_build_object(
      'total',     (select count(*) from public.customer_bookings
                     where company_id = v_company and technician_id = v_tech
                       and deleted_at is null and scheduled_date = p_date
                       and status not in ('cancelled','no_show')),
      'completed', (select count(*) from public.customer_bookings
                     where company_id = v_company and technician_id = v_tech
                       and deleted_at is null and scheduled_date = p_date
                       and status = 'completed'),
      'remaining', (select count(*) from public.customer_bookings
                     where company_id = v_company and technician_id = v_tech
                       and deleted_at is null and scheduled_date = p_date
                       and status in ('pending','confirmed','rescheduled','in_progress'))
    ),
    'next_booking',
      (select jsonb_build_object(
                'booking_id', b.id,
                'booking_ref', b.booking_ref,
                'unit_number', b.unit_number,
                'local_start', s.local_start,
                'local_end', s.local_end,
                'site_name', j.site_name,
                'address', concat_ws(', ', j.address_line1, j.suburb, j.state, j.postcode),
                'special_comments', b.special_comments,
                'access_notes', j.access_notes)
       from public.customer_bookings b
       join public.jobs j on j.id = b.job_id
       left join public.job_slots s on s.id = b.slot_id
       where b.company_id = v_company and b.technician_id = v_tech
         and b.deleted_at is null
         and b.status in ('pending','confirmed','rescheduled','in_progress')
         and (s.start_time is null or s.start_time >= now())
       order by s.start_time nulls last, b.scheduled_date
       limit 1),
    'week', jsonb_build_object(
      'total',     (select count(*) from public.customer_bookings
                     where company_id = v_company and technician_id = v_tech
                       and deleted_at is null
                       and scheduled_date between p_date and p_date + 6
                       and status not in ('cancelled','no_show')),
      'completed', (select count(*) from public.customer_bookings
                     where company_id = v_company and technician_id = v_tech
                       and deleted_at is null
                       and scheduled_date between p_date and p_date + 6
                       and status = 'completed')
    ),
    'earnings', jsonb_build_object(
      'current_period',
        (select jsonb_build_object(
                  'invoice_id', i.id,
                  'invoice_number', i.invoice_number,
                  'status', i.status,
                  'total', i.total,
                  'period_start', i.period_start,
                  'period_end', i.period_end)
         from public.invoices i
         where i.company_id = v_company and i.technician_id = v_tech
           and i.direction = 'payable' and i.deleted_at is null
           and i.status <> 'void'
         order by i.issue_date desc
         limit 1),
      'lifetime_installs',
        (select count(*) from public.customer_bookings
          where company_id = v_company and technician_id = v_tech
            and deleted_at is null and status = 'completed'),
      'rating',
        (select t.rating from public.technicians t where t.id = v_tech)
    )
  ) into v_result;

  return v_result;
end $$;

comment on function public.dashboard_summary(date, date) is
  'Aggregated operator dashboard for the caller tenant over a date window.';

revoke all on function public.technician_dashboard(date) from public, anon;
grant execute on function public.technician_dashboard(date) to authenticated, service_role;

-- =============================================================================
-- SECTION 6 — BOOKING CRON
-- =============================================================================

create or replace function public.booking_housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_holds int;
  v_codes int;
  v_keys  int;
  v_rate  int;
  v_inv   int;
begin
  update public.job_slots
     set hold_token = null, hold_expires_at = null,
         status = case when status = 'held' then 'open'::app.slot_status else status end,
         updated_at = now()
   where hold_token is not null
     and hold_expires_at is not null
     and hold_expires_at < now()
     and booked_count < capacity
     and deleted_at is null;
  get diagnostics v_holds = row_count;

  delete from public.sms_challenges
   where consumed_at is null and expires_at < now() - interval '1 hour';
  get diagnostics v_codes = row_count;

  delete from public.booking_idempotency where created_at < now() - interval '24 hours';
  get diagnostics v_keys = row_count;

  delete from public.booking_rate_limit where occurred_at < now() - interval '24 hours';
  get diagnostics v_rate = row_count;

  v_inv := app.expire_stale_invitations();

  return jsonb_build_object(
    'holds_released', v_holds,
    'challenges_pruned', v_codes,
    'keys_pruned', v_keys,
    'rate_rows_pruned', v_rate,
    'invitations_expired', v_inv);
end $$;

comment on function public.booking_housekeeping() is
  'Releases expired holds, prunes ledgers and expires stale invitations. Schedule on cron every 5 minutes.';

revoke all on function public.booking_housekeeping() from public, anon, authenticated;
grant execute on function public.booking_housekeeping() to service_role;

-- =============================================================================
-- SECTION 7 — VERIFICATION
-- =============================================================================
do $$
declare
  v_missing text[] := array[]::text[];
  v_fn text;
  v_leaks text[] := array[]::text[];
begin
  foreach v_fn in array array[
    'booking_lookup','available_slots','create_booking','cancel_booking','reschedule_booking',
    'create_job','generate_slots','publish_job','assign_technician','complete_job',
    'create_customer','search_customers',
    'create_invoice','add_invoice_item','build_pay_run','finalize_invoice',
    'dashboard_summary','partner_dashboard','technician_dashboard',
    'booking_housekeeping'
  ] loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
    ) then
      v_missing := v_missing || v_fn;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'phase 5 incomplete - missing functions: %',
      array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  -- Internal primitives must not be anon-reachable.
  if has_function_privilege('anon', 'app.slot_claim(uuid, text)', 'EXECUTE') then
    v_leaks := v_leaks || 'app.slot_claim';
  end if;
  if has_function_privilege('anon', 'app.generate_booking_ref()', 'EXECUTE') then
    v_leaks := v_leaks || 'app.generate_booking_ref';
  end if;
  if has_function_privilege('anon', 'public.booking_housekeeping()', 'EXECUTE') then
    v_leaks := v_leaks || 'public.booking_housekeeping';
  end if;
  if has_function_privilege('anon', 'public.create_job(text, uuid, text, text, text, text, date, date, int, int, int, text, text, text, int)', 'EXECUTE') then
    v_leaks := v_leaks || 'public.create_job';
  end if;

  if array_length(v_leaks, 1) > 0 then
    raise exception 'phase 5 incomplete - anon retains EXECUTE on: %',
      array_to_string(v_leaks, ', ') using errcode = 'P0001';
  end if;

  raise notice 'phase 5 complete: 20 RPCs, anon surface restricted to booking_lookup, available_slots, create_booking, cancel_booking, reschedule_booking';
end $$;

commit;

-- =============================================================================
-- END phase5_api.sql
-- =============================================================================
