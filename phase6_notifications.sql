-- =============================================================================
-- phase6_notifications_v2.sql
-- SwiftWorks — Phase 6: Notification Delivery Layer (corrected)
--
-- Depends on: bootstrap.sql, phase2_tables.sql, phase3_auth.sql,
--             phase4_rls.sql, phase5_prerequisites.sql, phase5_api.sql
--
-- Assumes app.notification_status already contains:
--   queued, sending, sent, delivered, failed, cancelled, read,
--   processing, dead_letter
-- No enum creation, no ALTER TYPE, no migration helpers.
--
-- Status vocabulary
--   queued       waiting for a worker
--   processing   claimed by a worker, delivery in flight
--   sent         provider accepted the message
--   delivered    provider delivery receipt (set by the webhook handler)
--   failed       retryable failure, backoff scheduled
--   dead_letter  attempts exhausted, no further retries
--   cancelled    expired before delivery
--
-- Corrections in this revision
--   * Loop records declare the variable actually used by the FOR statement.
--   * app.next_retry_at() is STABLE, not IMMUTABLE — it calls now().
--   * No enum casts in partial index predicates.
--   * No ALTER TYPE statements.
-- =============================================================================

begin;

set client_min_messages = warning;

-- =============================================================================
-- SECTION 1 — HELPERS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1.1 app.next_retry_at(attempt_count)
--     STABLE: depends on now(), so it cannot be IMMUTABLE.
--     Exponential backoff: attempt squared minutes, capped at 6 hours.
-- -----------------------------------------------------------------------------
create or replace function app.next_retry_at(p_attempt_count int)
returns timestamptz
language sql
stable
as $$
  select now() + make_interval(secs => least(
    power(greatest(p_attempt_count, 1), 2) * 60,
    21600
  )::int)
$$;

comment on function app.next_retry_at(int) is
  'Exponential backoff cursor for a retry: attempt squared minutes, capped at 6 hours. STABLE because it reads now().';

-- -----------------------------------------------------------------------------
-- 1.2 app.notification_provider(channel)
--     IMMUTABLE is correct here: a pure mapping from channel to provider.
-- -----------------------------------------------------------------------------
create or replace function app.notification_provider(p_channel app.notification_channel)
returns text
language sql
immutable
as $$
  select case p_channel
    when 'email'  then 'microsoft_graph'
    when 'sms'    then 'twilio'
    when 'push'   then 'webpush'
    when 'in_app' then 'internal'
    else 'webhook'
  end
$$;

comment on function app.notification_provider(app.notification_channel) is
  'Default provider for a channel. Pure mapping, therefore IMMUTABLE.';

-- -----------------------------------------------------------------------------
-- 1.3 app.notification_due_window()
--     Returns the retry ceiling used by the worker scan.
-- -----------------------------------------------------------------------------
create or replace function app.notification_max_backoff()
returns interval
language sql
immutable
as $$ select interval '6 hours' $$;

comment on function app.notification_max_backoff() is
  'Upper bound on retry backoff, matching app.next_retry_at().';

revoke execute on function app.next_retry_at(int) from public, anon, authenticated;
revoke execute on function app.notification_provider(app.notification_channel) from public, anon, authenticated;
revoke execute on function app.notification_max_backoff() from public, anon, authenticated;
grant execute on function app.next_retry_at(int) to service_role;
grant execute on function app.notification_provider(app.notification_channel) to service_role;
grant execute on function app.notification_max_backoff() to service_role;

-- =============================================================================
-- SECTION 2 — QUEUE FUNCTIONS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 queue_email()
-- -----------------------------------------------------------------------------
create or replace function public.queue_email(
  p_to                     text,
  p_subject                text,
  p_body                   text,
  p_body_html              text default null,
  p_template_key           text default null,
  p_event_key              text default null,
  p_variables              jsonb default '{}'::jsonb,
  p_dedupe_key             text default null,
  p_recipient_name         text default null,
  p_recipient_user_id      uuid default null,
  p_recipient_customer_id  uuid default null,
  p_customer_booking_id    uuid default null,
  p_job_id                 uuid default null,
  p_invoice_id             uuid default null,
  p_scheduled_for          timestamptz default now(),
  p_priority               int default 3,
  p_expires_at             timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid;
  v_email   text := nullif(lower(btrim(coalesce(p_to, ''))), '');
  v_id      uuid;
begin
  v_company := app.current_company_id();

  if v_company is null then
    v_company := app.user_company_id(p_recipient_user_id);
  end if;

  if v_company is null and p_customer_booking_id is not null then
    select company_id into v_company
    from public.customer_bookings where id = p_customer_booking_id;
  end if;

  if v_company is null then
    raise exception 'no_tenant_context: unable to resolve a company for this email'
      using errcode = 'P0001';
  end if;

  if v_email is null or not app.is_valid_email(v_email) then
    raise exception 'invalid_input: a valid recipient email is required' using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(p_subject, '')), '') is null then
    raise exception 'invalid_input: subject is required' using errcode = 'P0001';
  end if;

  insert into public.notifications (
    company_id, channel, status, template_key, event_key,
    subject, body, body_html, variables,
    recipient_user_id, recipient_customer_id,
    recipient_email, recipient_name,
    customer_booking_id, job_id, invoice_id,
    priority, scheduled_for, expires_at,
    dedupe_key, provider, metadata
  ) values (
    v_company, 'email', 'queued', p_template_key, p_event_key,
    btrim(p_subject), p_body, p_body_html, coalesce(p_variables, '{}'::jsonb),
    p_recipient_user_id, p_recipient_customer_id,
    v_email, nullif(btrim(coalesce(p_recipient_name, '')), ''),
    p_customer_booking_id, p_job_id, p_invoice_id,
    least(greatest(coalesce(p_priority, 3), 1), 5),
    coalesce(p_scheduled_for, now()), p_expires_at,
    p_dedupe_key, app.notification_provider('email'), '{}'::jsonb
  )
  on conflict (company_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is null and p_dedupe_key is not null then
    select id into v_id
    from public.notifications
    where company_id = v_company and dedupe_key = p_dedupe_key
    limit 1;
  end if;

  return v_id;
end $$;

comment on function public.queue_email(text, text, text, text, text, text, jsonb, text, text, uuid, uuid, uuid, uuid, uuid, timestamptz, int, timestamptz) is
  'Queues an email. Idempotent when dedupe_key is supplied: a collision returns the existing notification id.';

revoke all on function public.queue_email(text, text, text, text, text, text, jsonb, text, text, uuid, uuid, uuid, uuid, uuid, timestamptz, int, timestamptz) from public, anon;
grant execute on function public.queue_email(text, text, text, text, text, text, jsonb, text, text, uuid, uuid, uuid, uuid, uuid, timestamptz, int, timestamptz)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2.2 queue_sms()
-- -----------------------------------------------------------------------------
create or replace function public.queue_sms(
  p_to                     text,
  p_body                   text,
  p_template_key           text default null,
  p_event_key              text default null,
  p_variables              jsonb default '{}'::jsonb,
  p_dedupe_key             text default null,
  p_recipient_name         text default null,
  p_recipient_user_id      uuid default null,
  p_recipient_customer_id  uuid default null,
  p_customer_booking_id    uuid default null,
  p_job_id                 uuid default null,
  p_scheduled_for          timestamptz default now(),
  p_priority               int default 2,
  p_expires_at             timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_phone   text := app.normalise_phone(p_to);
  v_id      uuid;
begin
  if v_company is null then
    v_company := app.user_company_id(p_recipient_user_id);
  end if;
  if v_company is null and p_customer_booking_id is not null then
    select company_id into v_company
    from public.customer_bookings where id = p_customer_booking_id;
  end if;
  if v_company is null then
    raise exception 'no_tenant_context: unable to resolve a company for this SMS'
      using errcode = 'P0001';
  end if;

  if v_phone is null or length(v_phone) < 8 then
    raise exception 'invalid_input: a valid recipient phone number is required' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'invalid_input: body is required' using errcode = 'P0001';
  end if;

  insert into public.notifications (
    company_id, channel, status, template_key, event_key,
    body, variables,
    recipient_user_id, recipient_customer_id,
    recipient_phone, recipient_name,
    customer_booking_id, job_id,
    priority, scheduled_for, expires_at,
    dedupe_key, provider, metadata
  ) values (
    v_company, 'sms', 'queued', p_template_key, p_event_key,
    btrim(p_body), coalesce(p_variables, '{}'::jsonb),
    p_recipient_user_id, p_recipient_customer_id,
    v_phone, nullif(btrim(coalesce(p_recipient_name, '')), ''),
    p_customer_booking_id, p_job_id,
    least(greatest(coalesce(p_priority, 2), 1), 5),
    coalesce(p_scheduled_for, now()), p_expires_at,
    p_dedupe_key, app.notification_provider('sms'), '{}'::jsonb
  )
  on conflict (company_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is null and p_dedupe_key is not null then
    select id into v_id from public.notifications
    where company_id = v_company and dedupe_key = p_dedupe_key limit 1;
  end if;

  return v_id;
end $$;

comment on function public.queue_sms(text, text, text, text, jsonb, text, text, uuid, uuid, uuid, uuid, timestamptz, int, timestamptz) is
  'Queues an SMS. Idempotent when dedupe_key is supplied.';

revoke all on function public.queue_sms(text, text, text, text, jsonb, text, text, uuid, uuid, uuid, uuid, timestamptz, int, timestamptz) from public, anon;
grant execute on function public.queue_sms(text, text, text, text, jsonb, text, text, uuid, uuid, uuid, uuid, timestamptz, int, timestamptz)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2.3 queue_push()
-- -----------------------------------------------------------------------------
create or replace function public.queue_push(
  p_recipient_user_id       uuid default null,
  p_recipient_technician_id uuid default null,
  p_title                   text default null,
  p_body                    text default null,
  p_template_key            text default null,
  p_event_key               text default null,
  p_variables               jsonb default '{}'::jsonb,
  p_dedupe_key              text default null,
  p_technician_id           uuid default null,
  p_customer_booking_id     uuid default null,
  p_job_id                  uuid default null,
  p_scheduled_for           timestamptz default now(),
  p_priority                int default 2,
  p_expires_at              timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid := app.current_company_id();
  v_id      uuid;
begin
  if v_company is null then
    v_company := app.user_company_id(p_recipient_user_id);
  end if;
  if v_company is null and p_recipient_technician_id is not null then
    select company_id into v_company
    from public.technicians where id = p_recipient_technician_id;
  end if;
  if v_company is null and p_job_id is not null then
    select company_id into v_company from public.jobs where id = p_job_id;
  end if;
  if v_company is null then
    raise exception 'no_tenant_context: unable to resolve a company for this push'
      using errcode = 'P0001';
  end if;

  if p_recipient_user_id is null and p_recipient_technician_id is null then
    raise exception 'invalid_input: a user or technician recipient is required' using errcode = 'P0001';
  end if;

  insert into public.notifications (
    company_id, channel, status, template_key, event_key,
    subject, body, variables,
    recipient_user_id, recipient_technician_id, technician_id,
    customer_booking_id, job_id,
    priority, scheduled_for, expires_at,
    dedupe_key, provider, metadata
  ) values (
    v_company, 'push', 'queued', p_template_key, p_event_key,
    nullif(btrim(coalesce(p_title, '')), ''), p_body, coalesce(p_variables, '{}'::jsonb),
    p_recipient_user_id, p_recipient_technician_id, p_technician_id,
    p_customer_booking_id, p_job_id,
    least(greatest(coalesce(p_priority, 2), 1), 5),
    coalesce(p_scheduled_for, now()), p_expires_at,
    p_dedupe_key, app.notification_provider('push'), '{}'::jsonb
  )
  on conflict (company_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is null and p_dedupe_key is not null then
    select id into v_id from public.notifications
    where company_id = v_company and dedupe_key = p_dedupe_key limit 1;
  end if;

  return v_id;
end $$;

comment on function public.queue_push(uuid, uuid, text, text, text, text, jsonb, text, uuid, uuid, uuid, timestamptz, int, timestamptz) is
  'Queues a push notification for a user or technician. Idempotent when dedupe_key is supplied.';

revoke all on function public.queue_push(uuid, uuid, text, text, text, text, jsonb, text, uuid, uuid, uuid, timestamptz, int, timestamptz) from public, anon;
grant execute on function public.queue_push(uuid, uuid, text, text, text, text, jsonb, text, uuid, uuid, uuid, timestamptz, int, timestamptz)
  to authenticated, service_role;

-- =============================================================================
-- SECTION 3 — WORKER
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 app.claim_notifications(batch_size)
--     Atomically moves due rows into 'processing' using SKIP LOCKED, so
--     concurrent workers never take the same row.
-- -----------------------------------------------------------------------------
create or replace function app.claim_notifications(p_batch_size int default 50)
returns setof public.notifications
language sql
security definer
set search_path = app, public, pg_catalog
as $$
  with claimed as (
    select n.id
    from public.notifications n
    where n.status = 'queued'
      and n.scheduled_for <= now()
      and (n.expires_at is null or n.expires_at > now())
      and (n.next_attempt_at is null or n.next_attempt_at <= now())
    order by n.priority, n.scheduled_for
    limit least(greatest(coalesce(p_batch_size, 50), 1), 500)
    for update skip locked
  )
  update public.notifications n
     set status          = 'processing',
         last_attempt_at = now(),
         attempt_count   = n.attempt_count + 1,
         updated_at      = now(),
         updated_by      = auth.uid()
    from claimed c
   where n.id = c.id
  returning n.*;
$$;

comment on function app.claim_notifications(int) is
  'Claims a batch of due notifications for delivery, incrementing attempt_count. SKIP LOCKED makes it safe for concurrent workers.';

revoke execute on function app.claim_notifications(int) from public, anon, authenticated;
grant  execute on function app.claim_notifications(int) to service_role;

-- -----------------------------------------------------------------------------
-- 3.2 public.process_notifications(batch_size, dispatch)
--     Worker entry point. Delivery happens outside the database (Microsoft
--     Graph / Twilio / web push), so this prepares the batch and records
--     outcomes.
--
--     p_dispatch = false  claim and return rows ready to send
--     p_dispatch = true   additionally confirm the claimed batch as sent
-- -----------------------------------------------------------------------------
create or replace function public.process_notifications(
  p_batch_size int default 50,
  p_dispatch   boolean default false
)
returns table (
  notification_id uuid,
  channel         app.notification_channel,
  provider        text,
  recipient       text,
  subject         text,
  body            text,
  variables       jsonb,
  attempt_count   int,
  max_attempts    int,
  action          text
)
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_claimed int := 0;
begin
  create temporary table if not exists _claimed_notifications (
    id uuid primary key
  ) on commit drop;

  truncate table _claimed_notifications;

  insert into _claimed_notifications (id)
  select c.id from app.claim_notifications(p_batch_size) c;

  get diagnostics v_claimed = row_count;

  -- Expire anything in the batch that went stale between queueing and now.
  update public.notifications n
     set status        = 'cancelled',
         error_code    = 'expired',
         error_message = 'notification expired before delivery',
         updated_at    = now(),
         updated_by    = auth.uid()
   where n.id in (select id from _claimed_notifications)
     and n.expires_at is not null
     and n.expires_at <= now();

  if p_dispatch then
    update public.notifications n
       set status        = 'sent',
           sent_at       = now(),
           error_code    = null,
           error_message = null,
           failed_at     = null,
           updated_at    = now(),
           updated_by    = auth.uid()
     where n.id in (select id from _claimed_notifications)
       and n.status = 'processing';
  end if;

  -- Dead-letter rows that exhausted retries while claimed.
  update public.notifications n
     set status     = 'dead_letter',
         failed_at  = coalesce(n.failed_at, now()),
         updated_at = now(),
         updated_by = auth.uid()
   where n.status = 'processing'
     and n.attempt_count >= n.max_attempts
     and n.last_attempt_at < now() - app.notification_max_backoff();

  return query
    select n.id,
           n.channel,
           n.provider,
           coalesce(n.recipient_email, n.recipient_phone, n.recipient_name, ''),
           n.subject,
           n.body,
           n.variables,
           n.attempt_count,
           n.max_attempts,
           case
             when p_dispatch then 'dispatched'
             when n.status = 'cancelled' then 'expired'
             when n.status = 'dead_letter' then 'dead_lettered'
             else 'ready'
           end
    from public.notifications n
    where n.id in (select id from _claimed_notifications)
    order by n.priority, n.scheduled_for;
end $$;

comment on function public.process_notifications(int, boolean) is
  'Worker entry point. Claims due notifications, expires stale ones, optionally confirms dispatch, and dead-letters exhausted rows.';

revoke all on function public.process_notifications(int, boolean) from public, anon, authenticated;
grant execute on function public.process_notifications(int, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 3.3 public.complete_notification(id, success, error, ...)
--     Called once per message by the delivery worker, so outcomes are recorded
--     per row rather than in a batch update.
-- -----------------------------------------------------------------------------
create or replace function public.complete_notification(
  p_notification_id     uuid,
  p_success             boolean,
  p_error_code          text default null,
  p_error_message       text default null,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_n public.notifications%rowtype;
begin
  select * into v_n
  from public.notifications
  where id = p_notification_id
  for update;

  if not found then
    raise exception 'notification_not_found' using errcode = 'P0002';
  end if;

  if v_n.status not in ('processing','queued') then
    raise exception 'invalid_state: notification is already %', v_n.status using errcode = 'P0001';
  end if;

  if p_success then
    update public.notifications
       set status              = 'sent',
           sent_at             = now(),
           provider_message_id = coalesce(p_provider_message_id, provider_message_id),
           error_code          = null,
           error_message       = null,
           failed_at           = null,
           updated_at          = now(),
           updated_by          = auth.uid()
     where id = v_n.id
    returning * into v_n;

    return jsonb_build_object(
      'notification_id', v_n.id,
      'status', v_n.status,
      'attempt_count', v_n.attempt_count,
      'action', 'sent');
  end if;

  -- Failure: retry with backoff, or dead-letter once exhausted.
  if v_n.attempt_count >= v_n.max_attempts then
    update public.notifications
       set status        = 'dead_letter',
           failed_at     = now(),
           error_code    = coalesce(p_error_code, 'delivery_failed'),
           error_message = left(coalesce(p_error_message, 'delivery failed'), 1000),
           updated_at    = now(),
           updated_by    = auth.uid()
     where id = v_n.id
    returning * into v_n;

    return jsonb_build_object(
      'notification_id', v_n.id,
      'status', v_n.status,
      'attempt_count', v_n.attempt_count,
      'action', 'dead_lettered');
  end if;

  update public.notifications
     set status          = 'failed',
         failed_at       = now(),
         error_code      = coalesce(p_error_code, 'delivery_failed'),
         error_message   = left(coalesce(p_error_message, 'delivery failed'), 1000),
         next_attempt_at = app.next_retry_at(v_n.attempt_count),
         updated_at      = now(),
         updated_by      = auth.uid()
   where id = v_n.id
  returning * into v_n;

  return jsonb_build_object(
    'notification_id', v_n.id,
    'status', v_n.status,
    'attempt_count', v_n.attempt_count,
    'next_attempt_at', v_n.next_attempt_at,
    'action', 'retry_scheduled');
end $$;

comment on function public.complete_notification(uuid, boolean, text, text, text) is
  'Records a delivery outcome. Schedules a backoff retry on failure, or dead-letters once max_attempts is exhausted.';

revoke all on function public.complete_notification(uuid, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_notification(uuid, boolean, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 3.4 public.retry_failed_notifications(limit)
-- -----------------------------------------------------------------------------
create or replace function public.retry_failed_notifications(p_limit int default 200)
returns integer
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_count int;
begin
  update public.notifications
     set status        = 'queued',
         scheduled_for = now(),
         updated_at    = now(),
         updated_by    = auth.uid()
   where id in (
     select n.id from public.notifications n
     where n.status = 'failed'
       and n.attempt_count < n.max_attempts
       and (n.next_attempt_at is null or n.next_attempt_at <= now())
       and (n.expires_at is null or n.expires_at > now())
     order by n.priority, n.next_attempt_at
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)
     for update skip locked
   );

  get diagnostics v_count = row_count;
  return v_count;
end $$;

comment on function public.retry_failed_notifications(int) is
  'Requeues failed notifications whose backoff window has elapsed and whose retries are not exhausted.';

revoke all on function public.retry_failed_notifications(int) from public, anon, authenticated;
grant execute on function public.retry_failed_notifications(int) to service_role;

-- =============================================================================
-- SECTION 4 — SCHEDULERS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4.1 schedule_booking_reminders(days_ahead)
--     Declares v_booking record and loops with "for v_booking in".
-- -----------------------------------------------------------------------------
create or replace function public.schedule_booking_reminders(
  p_days_ahead int default 1
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_target  date := current_date + greatest(coalesce(p_days_ahead, 1), 0);
  v_email   int := 0;
  v_sms     int := 0;
  v_id      uuid;
  v_booking record;
begin
  for v_booking in
    select b.id,
           b.company_id,
           b.booking_ref,
           b.unit_number,
           b.phone,
           b.email,
           b.full_name,
           b.customer_id,
           b.job_id,
           coalesce(b.scheduled_date, s.slot_date) as slot_date,
           coalesce(b.scheduled_start, s.start_time) as start_ts,
           coalesce(s.local_start, (b.scheduled_start)::time) as local_start,
           j.job_number,
           j.site_name,
           j.address_line1,
           j.suburb,
           j.state,
           j.postcode
    from public.customer_bookings b
    join public.jobs j on j.id = b.job_id
    left join public.job_slots s on s.id = b.slot_id
    where b.deleted_at is null
      and j.deleted_at is null
      and b.status in ('pending','confirmed','rescheduled')
      and b.reminder_sent_at is null
      and coalesce(b.scheduled_date, s.slot_date) = v_target
  loop
    if v_booking.email is not null then
      v_id := public.queue_email(
        p_to                => v_booking.email,
        p_subject           => 'Reminder: your installation is tomorrow',
        p_body              => format(
          'Your installation for unit %s is booked for %s. Reference %s.',
          coalesce(v_booking.unit_number, '-'),
          to_char(v_booking.slot_date, 'DD Mon YYYY'),
          v_booking.booking_ref),
        p_template_key      => 'booking.reminder.email',
        p_event_key         => 'booking.reminder',
        p_variables         => jsonb_build_object(
          'booking_ref', v_booking.booking_ref,
          'unit_number', v_booking.unit_number,
          'slot_date', v_booking.slot_date,
          'local_start', v_booking.local_start,
          'job_number', v_booking.job_number,
          'address', concat_ws(', ', v_booking.address_line1, v_booking.suburb,
                               v_booking.state, v_booking.postcode)),
        p_dedupe_key        => 'booking.reminder:' || v_booking.id || ':email',
        p_recipient_name    => v_booking.full_name,
        p_recipient_customer_id => v_booking.customer_id,
        p_customer_booking_id => v_booking.id,
        p_job_id            => v_booking.job_id,
        p_priority          => 2
      );
      if v_id is not null then v_email := v_email + 1; end if;
    end if;

    if v_booking.phone is not null then
      v_id := public.queue_sms(
        p_to                => v_booking.phone,
        p_body              => format(
          'SwiftWorks: installation tomorrow %s. Ref %s.',
          to_char(v_booking.slot_date, 'DD Mon'), v_booking.booking_ref),
        p_template_key      => 'booking.reminder.sms',
        p_event_key         => 'booking.reminder',
        p_variables         => jsonb_build_object(
          'booking_ref', v_booking.booking_ref,
          'slot_date', v_booking.slot_date,
          'local_start', v_booking.local_start),
        p_dedupe_key        => 'booking.reminder:' || v_booking.id || ':sms',
        p_recipient_name    => v_booking.full_name,
        p_recipient_customer_id => v_booking.customer_id,
        p_customer_booking_id => v_booking.id,
        p_job_id            => v_booking.job_id,
        p_priority          => 2
      );
      if v_id is not null then v_sms := v_sms + 1; end if;
    end if;

    update public.customer_bookings
       set reminder_sent_at = now(),
           updated_at       = now(),
           updated_by       = auth.uid()
     where id = v_booking.id;
  end loop;

  return jsonb_build_object(
    'target_date', v_target,
    'emails_queued', v_email,
    'sms_queued', v_sms);
end $$;

comment on function public.schedule_booking_reminders(int) is
  'Queues day-before reminders for confirmed bookings and stamps reminder_sent_at so a re-run is a no-op.';

revoke all on function public.schedule_booking_reminders(int) from public, anon, authenticated;
grant execute on function public.schedule_booking_reminders(int) to service_role;

-- -----------------------------------------------------------------------------
-- 4.2 schedule_technician_run_sheets()
--     Declares v_tech record and loops with "for v_tech in".
-- -----------------------------------------------------------------------------
create or replace function public.schedule_technician_run_sheets()
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_tomorrow date := current_date + 1;
  v_queued   int := 0;
  v_id       uuid;
  v_tech     record;
begin
  for v_tech in
    select t.id as technician_id,
           t.company_id,
           t.user_id,
           t.full_name,
           count(b.id) as installs,
           min(s.local_start) as first_slot
    from public.technicians t
    join public.customer_bookings b
      on b.technician_id = t.id
     and b.deleted_at is null
     and b.scheduled_date = v_tomorrow
     and b.status in ('pending','confirmed','rescheduled')
    left join public.job_slots s on s.id = b.slot_id
    where t.deleted_at is null
      and t.is_available
    group by t.id, t.company_id, t.user_id, t.full_name
    having count(b.id) > 0
  loop
    v_id := public.queue_push(
      p_recipient_user_id       => v_tech.user_id,
      p_recipient_technician_id => v_tech.technician_id,
      p_title                   => 'Tomorrow: ' || v_tech.installs || ' installs',
      p_body                    => format('%s installs from %s.',
                                   v_tech.installs,
                                   to_char(v_tech.first_slot, 'HH24:MI')),
      p_template_key            => 'technician.runsheet.push',
      p_event_key               => 'technician.runsheet',
      p_variables               => jsonb_build_object(
        'date', v_tomorrow,
        'installs', v_tech.installs,
        'first_slot', v_tech.first_slot),
      p_dedupe_key              => 'technician.runsheet:' || v_tech.technician_id || ':' || v_tomorrow,
      p_technician_id           => v_tech.technician_id,
      p_priority                => 2
    );
    if v_id is not null then v_queued := v_queued + 1; end if;
  end loop;

  return jsonb_build_object('target_date', v_tomorrow, 'run_sheets_queued', v_queued);
end $$;

comment on function public.schedule_technician_run_sheets() is
  'Queues one evening push per technician summarising tomorrow''s work. Idempotent per technician per day.';

revoke all on function public.schedule_technician_run_sheets() from public, anon, authenticated;
grant execute on function public.schedule_technician_run_sheets() to service_role;

-- =============================================================================
-- SECTION 5 — REAPER
-- =============================================================================

create or replace function public.expire_notifications(p_grace_hours int default 24)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_stale   int := 0;
  v_expired int := 0;
  v_dead    int := 0;
begin
  -- 5.1 Queued past their expiry.
  update public.notifications
     set status        = 'cancelled',
         error_code    = 'expired',
         error_message = 'notification expired before delivery',
         updated_at    = now(),
         updated_by    = auth.uid()
   where status = 'queued'
     and expires_at is not null
     and expires_at <= now();
  get diagnostics v_expired = row_count;

  -- 5.2 Stuck in 'processing': a worker died between claim and completion.
  update public.notifications
     set status          = case
                             when attempt_count >= max_attempts then 'dead_letter'::app.notification_status
                             else 'failed'::app.notification_status
                           end,
         failed_at       = coalesce(failed_at, now()),
         error_code      = 'worker_timeout',
         error_message   = 'no delivery outcome recorded within the grace window',
         next_attempt_at = case
                             when attempt_count >= max_attempts then next_attempt_at
                             else app.next_retry_at(attempt_count)
                           end,
         updated_at      = now(),
         updated_by      = auth.uid()
   where status = 'processing'
     and last_attempt_at < now() - make_interval(hours => greatest(coalesce(p_grace_hours, 24), 1));
  get diagnostics v_stale = row_count;

  -- 5.3 Failed rows whose retries are exhausted.
  update public.notifications
     set status     = 'dead_letter',
         failed_at  = coalesce(failed_at, now()),
         updated_at = now(),
         updated_by = auth.uid()
   where status = 'failed'
     and attempt_count >= max_attempts;
  get diagnostics v_dead = row_count;

  return jsonb_build_object(
    'queued_expired', v_expired,
    'stuck_recovered', v_stale,
    'dead_lettered', v_dead);
end $$;

comment on function public.expire_notifications(int) is
  'Reaps the queue: expires stale queued rows, recovers rows stuck in processing after a worker crash, and dead-letters exhausted retries.';

revoke all on function public.expire_notifications(int) from public, anon, authenticated;
grant execute on function public.expire_notifications(int) to service_role;

-- =============================================================================
-- SECTION 6 — METRICS
-- =============================================================================

create or replace function public.notification_metrics(
  p_from    timestamptz default now() - interval '24 hours',
  p_to      timestamptz default now(),
  p_company uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = app, public, pg_catalog
as $$
declare
  v_company uuid;
  v_result  jsonb;
begin
  if p_company is not null then
    if not app.is_platform_admin() and not app.can_access_company(p_company) then
      raise exception 'not_authorised: company outside caller scope' using errcode = '42501';
    end if;
    v_company := p_company;
  elsif app.is_platform_admin() then
    v_company := null;
  else
    v_company := app.current_company_id();
    if v_company is null then
      raise exception 'no_tenant_context' using errcode = 'P0001';
    end if;
  end if;

  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'company_id', v_company,
    'totals', jsonb_build_object(
      'queued',      (select count(*) from public.notifications
                       where (v_company is null or company_id = v_company)
                         and created_at between p_from and p_to
                         and status = 'queued'),
      'processing',  (select count(*) from public.notifications
                       where (v_company is null or company_id = v_company)
                         and created_at between p_from and p_to
                         and status = 'processing'),
      'sent',        (select count(*) from public.notifications
                       where (v_company is null or company_id = v_company)
                         and created_at between p_from and p_to
                         and status = 'sent'),
      'failed',      (select count(*) from public.notifications
                       where (v_company is null or company_id = v_company)
                         and created_at between p_from and p_to
                         and status = 'failed'),
      'dead_letter', (select count(*) from public.notifications
                       where (v_company is null or company_id = v_company)
                         and created_at between p_from and p_to
                         and status = 'dead_letter'),
      'cancelled',   (select count(*) from public.notifications
                       where (v_company is null or company_id = v_company)
                         and created_at between p_from and p_to
                         and status = 'cancelled'),
      'delivered',   (select count(*) from public.notifications
                       where (v_company is null or company_id = v_company)
                         and created_at between p_from and p_to
                         and status = 'delivered')
    ),
    'by_channel', (
      select coalesce(jsonb_object_agg(channel, stats), '{}'::jsonb)
      from (
        select n.channel::text as channel,
               jsonb_build_object(
                 'total', count(*),
                 'sent', count(*) filter (where n.status = 'sent'),
                 'failed', count(*) filter (where n.status = 'failed'),
                 'dead_letter', count(*) filter (where n.status = 'dead_letter'),
                 'success_rate',
                   case when count(*) = 0 then 0
                        else round(100.0 * count(*) filter (where n.status = 'sent') / count(*), 2)
                   end
               ) as stats
        from public.notifications n
        where (v_company is null or n.company_id = v_company)
          and n.created_at between p_from and p_to
        group by n.channel
      ) t
    ),
    'top_failures', (
      select coalesce(jsonb_agg(f), '[]'::jsonb)
      from (
        select n.error_code as code,
               n.channel::text as channel,
               count(*) as count
        from public.notifications n
        where (v_company is null or n.company_id = v_company)
          and n.created_at between p_from and p_to
          and n.error_code is not null
        group by n.error_code, n.channel
        order by count(*) desc
        limit 10
      ) f
    ),
    'retry_pressure', (
      select jsonb_build_object(
        'attempt_1', count(*) filter (where attempt_count = 1),
        'attempt_2', count(*) filter (where attempt_count = 2),
        'attempt_3_plus', count(*) filter (where attempt_count >= 3)
      )
      from public.notifications
      where (v_company is null or company_id = v_company)
        and created_at between p_from and p_to
        and attempt_count > 0
    ),
    'latency', (
      select jsonb_build_object(
        'avg_seconds', round(coalesce(avg(extract(epoch from (sent_at - created_at))), 0), 2),
        'p95_seconds', round(coalesce(
          percentile_disc(0.95) within group (order by extract(epoch from (sent_at - created_at))),
          0), 2)
      )
      from public.notifications
      where (v_company is null or company_id = v_company)
        and created_at between p_from and p_to
        and sent_at is not null
    )
  ) into v_result;

  return v_result;
end $$;

comment on function public.notification_metrics(timestamptz, timestamptz, uuid) is
  'Delivery observability: per-channel totals, success rates, top failure codes, retry distribution and send latency.';

revoke all on function public.notification_metrics(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.notification_metrics(timestamptz, timestamptz, uuid)
  to authenticated, service_role;

-- =============================================================================
-- SECTION 7 — INDEXES
-- =============================================================================
-- No enum casts in any predicate. Postgres requires index predicate functions
-- to be IMMUTABLE, and an enum cast is resolved through a type input function
-- that does not qualify. Full-column predicates are used instead.
-- =============================================================================

-- Queue scan: status, scheduled_for and next_attempt_at are all columns.
create index if not exists notifications_worker_idx
  on public.notifications (priority, scheduled_for);

create index if not exists notifications_status_idx
  on public.notifications (status, scheduled_for);

-- Worker crash recovery: rows sitting in processing.
create index if not exists notifications_processing_idx
  on public.notifications (status, last_attempt_at);

-- Dead-letter inspection.
create index if not exists notifications_dead_letter_idx
  on public.notifications (company_id, failed_at desc);

-- Retry sweep.
create index if not exists notifications_retry_idx
  on public.notifications (status, next_attempt_at);

-- Reminder scan on the booking side. No enum casts here either.
create index if not exists customer_bookings_reminder_idx
  on public.customer_bookings (scheduled_date, status)
  where reminder_sent_at is null;

-- =============================================================================
-- SECTION 8 — VERIFICATION
-- =============================================================================
do $$
declare
  v_missing text[] := array[]::text[];
  v_fn text;
  v_leaks text[] := array[]::text[];
  v_enum text;
  v_enums text[] := array[]::text[];
begin
  -- 8.1 Required statuses must exist in the enum.
  foreach v_enum in array array[
    'queued','sending','sent','delivered','failed','cancelled','read','processing','dead_letter'
  ] loop
    if not exists (
      select 1 from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'app' and t.typname = 'notification_status' and e.enumlabel = v_enum
    ) then
      v_enums := v_enums || v_enum;
    end if;
  end loop;

  if array_length(v_enums, 1) > 0 then
    raise exception 'phase 6 incomplete - app.notification_status missing values: %',
      array_to_string(v_enums, ', ') using errcode = 'P0001';
  end if;

  -- 8.2 All functions present.
  foreach v_fn in array array[
    'process_notifications','complete_notification','retry_failed_notifications',
    'schedule_booking_reminders','schedule_technician_run_sheets',
    'queue_email','queue_sms','queue_push',
    'expire_notifications','notification_metrics'
  ] loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
    ) then
      v_missing := v_missing || ('public.' || v_fn);
    end if;
  end loop;

  foreach v_fn in array array[
    'claim_notifications','next_retry_at','notification_provider','notification_max_backoff'
  ] loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = v_fn
    ) then
      v_missing := v_missing || ('app.' || v_fn);
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'phase 6 incomplete - missing functions: %',
      array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  -- 8.3 app.next_retry_at must be STABLE, not IMMUTABLE, because it reads now().
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'next_retry_at' and p.provolatile = 'i'
  ) then
    raise exception 'phase 6 incomplete - app.next_retry_at is marked IMMUTABLE but calls now()'
      using errcode = 'P0001';
  end if;

  -- 8.4 Worker paths must not be reachable by anon or authenticated.
  if has_function_privilege('anon', 'public.process_notifications(int, boolean)', 'EXECUTE') then
    v_leaks := v_leaks || 'public.process_notifications (anon)';
  end if;
  if has_function_privilege('authenticated', 'app.claim_notifications(int)', 'EXECUTE') then
    v_leaks := v_leaks || 'app.claim_notifications (authenticated)';
  end if;
  if has_function_privilege('anon', 'public.expire_notifications(int)', 'EXECUTE') then
    v_leaks := v_leaks || 'public.expire_notifications (anon)';
  end if;
  if has_function_privilege('anon', 'public.complete_notification(uuid, boolean, text, text, text)', 'EXECUTE') then
    v_leaks := v_leaks || 'public.complete_notification (anon)';
  end if;

  if array_length(v_leaks, 1) > 0 then
    raise exception 'phase 6 incomplete - over-permissive grants on: %',
      array_to_string(v_leaks, ', ') using errcode = 'P0001';
  end if;

  raise notice 'phase 6 complete: 10 public functions, 4 helpers, 9 enum statuses present, worker paths service_role only';
end $$;

commit;

-- =============================================================================
-- END phase6_notifications_v2.sql
--
-- Cron schedule
--   */5 * * * *   public.expire_notifications()
--   */1 * * * *   public.retry_failed_notifications()
--   0 9 * * *     public.schedule_booking_reminders(1)
--   0 17 * * *    public.schedule_technician_run_sheets()
--   Edge Function drives public.process_notifications() and
--   public.complete_notification() on its own cadence.
-- =============================================================================
