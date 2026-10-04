import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarDays, CheckCircle2, Loader2, MapPin } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type BookingLink = {
  id: string;
  job_id: string;
  token: string;
};

type Job = {
  id: string;
  title: string | null;
  job_number: string | null;
  site_name: string | null;
  address_line1: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
};

type Slot = {
  id: string;
  slot_date: string;
  local_start: string;
  local_end: string;
  capacity: number;
  booked_count: number;
  status: string;
};

type CustomerForm = {
  full_name: string;
  mobile: string;
  email: string;
  unit_number: string;
};

const EMPTY_FORM: CustomerForm = {
  full_name: '',
  mobile: '',
  email: '',
  unit_number: '',
};

/** Slots starting before midday are the morning window. */
function periodLabel(localStart: string): string {
  return localStart < '12:00' ? 'Morning' : 'Afternoon';
}

function formatTime(value: string): string {
  return value.slice(0, 5);
}

/** 2026-10-02 -> Fri 2 Oct 2026 */
function formatDate(value: string): string {
  const d = new Date(value + 'T00:00:00');
  return d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Today in the browser's local time, as YYYY-MM-DD. */
function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

/** Accepts 04xx xxx xxx or +614xx xxx xxx. */
function isValidAuMobile(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  return /^(04\d{8}|\+614\d{8})$/.test(digits);
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default function BookingPage() {
  const { token } = useParams<{ token: string }>();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [link, setLink] = useState<BookingLink | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);

  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Slot | null>(null);

  /**
   * Generated once per mount and reused for every retry of this booking. The
   * server maps it to the booking it already created, so a double submit
   * returns the original rather than booking a second slot.
   */
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const loadBooking = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    if (!token) {
      setLoadError('This booking link is incomplete.');
      setLoading(false);
      return;
    }

    // 1. Find the booking link by token.
    //
    // This runs through a SECURITY DEFINER function rather than a direct
    // select. Customers are signed out, so row-level security would hide the
    // row and the page would report "invalid or has expired" for a token that
    // exists. The function matches the token alone and returns only the one
    // job the link points at.
    const linkRes = await (supabase as any).rpc('booking_link_job', {
      p_token: token,
    });

    if (linkRes.error) {
      console.error('booking_link_job failed', linkRes.error);
      setLoadError('This booking link is invalid or has expired.');
      setLoading(false);
      return;
    }

    const linkRow = Array.isArray(linkRes.data) ? linkRes.data[0] : linkRes.data;

    if (!linkRow || !linkRow.job_id) {
      setLoadError('This booking link is invalid or has expired.');
      setLoading(false);
      return;
    }

    const foundLink = {
      id: String(linkRow.link_id ?? ''),
      job_id: String(linkRow.job_id),
      token,
    } as BookingLink;

    setLink(foundLink);

    // 2. The job details arrive with the link, so nothing further is needed.
    if (!linkRow.job_title && !linkRow.job_number) {
      setLoadError('The job for this booking link could not be found.');
      setLoading(false);
      return;
    }

    setJob({
      id: foundLink.job_id,
      title: linkRow.job_title ?? null,
      job_number: linkRow.job_number ?? null,
      site_name: linkRow.site_name ?? null,
      address_line1: linkRow.address_line1 ?? null,
      suburb: linkRow.suburb ?? null,
      state: linkRow.state ?? null,
      postcode: linkRow.postcode ?? null,
    } as Job);

    // 3. Load open, future slots for the job. Same reason as the link lookup:
    // the caller is signed out, so this is a definer function scoped to the
    // token rather than a direct select.
    const slotRes = await (supabase as any).rpc('booking_slots', {
      p_token: token,
      p_from: todayIso(),
    });

    if (slotRes.error) {
      console.error('booking_slots failed', slotRes.error);
      setLoadError(slotRes.error.message);
      setLoading(false);
      return;
    }

    const available = ((slotRes.data ?? []) as Slot[]).filter(
      (s) => s.capacity - s.booked_count > 0,
    );

    setSlots(available);
    setLoading(false);
  }, [token]);

  useEffect(() => {
    void loadBooking();
  }, [loadBooking]);

  const selectedSlot = useMemo(
    () => slots.find((s) => s.id === selectedSlotId) ?? null,
    [slots, selectedSlotId],
  );

  async function submitBooking(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);

    if (!link || !selectedSlot) {
      setSubmitError('Please choose a time slot.');
      return;
    }
    if (!form.full_name.trim()) {
      setSubmitError('Please enter your full name.');
      return;
    }
    if (!isValidAuMobile(form.mobile)) {
      setSubmitError('Please enter a valid Australian mobile, e.g. 0412 345 678.');
      return;
    }
    if (!isValidEmail(form.email.trim())) {
      setSubmitError('Please enter a valid email address.');
      return;
    }
    if (!form.unit_number.trim()) {
      setSubmitError('Please enter your unit number.');
      return;
    }

    setSubmitting(true);

    // Booking goes through the secure RPC so capacity is checked and
    // incremented atomically on the server.
    // create_booking() is the modern entry point. Unlike the legacy
    // booking_create(), it validates the QR token, rate-limits, claims the slot
    // under a row lock, upserts the customer and writes scheduled_date /
    // scheduled_start / scheduled_end plus the job's assigned technician onto
    // the booking — all in one transaction.
    const { error } = await (supabase as any).rpc('create_booking', {
      p_qr_token: link.token,
      p_slot_id: selectedSlot.id,
      p_unit_number: form.unit_number.trim(),
      p_phone: form.mobile.replace(/[\s-]/g, ''),
      p_email: form.email.trim().toLowerCase(),
      p_full_name: form.full_name.trim(),
      p_special_comments: null,
      // Reused across retries within this attempt so a double-tap on a slow
      // connection returns the original booking instead of creating a second.
      p_idempotency_key: idempotencyKey,
      p_ip_address: null,
      p_user_agent: null,
      p_session_id: null,
    });

    setSubmitting(false);

    if (error) {
      const msg = String(error.message || '');
      if (
        msg.toLowerCase().includes('full') ||
        msg.toLowerCase().includes('capacity')
      ) {
        setSubmitError('Sorry, that slot has just filled. Please choose another.');
        setSelectedSlotId(null);
        void loadBooking();
        return;
      }
      setSubmitError(msg || 'Booking failed. Please try again.');
      return;
    }

    setConfirmed(selectedSlot);
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center">
            <h1 className="text-lg font-semibold">Booking unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="space-y-3 p-6 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" />
            <h1 className="text-xl font-semibold">Appointment booked</h1>
            <p className="text-sm text-muted-foreground">
              {formatDate(confirmed.slot_date)} ·{' '}
              {periodLabel(confirmed.local_start)} (
              {formatTime(confirmed.local_start)}–
              {formatTime(confirmed.local_end)})
            </p>
            <p className="text-sm text-muted-foreground">
              A confirmation will be sent to {form.email.trim()}.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const address = job
    ? [job.address_line1, job.suburb, job.state, job.postcode]
        .filter(Boolean)
        .join(', ')
    : '';

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">SwiftWorks</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {job?.title || job?.job_number || 'Book an appointment'}
          </h1>
          {(job?.site_name || address) && (
            <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="h-4 w-4" />
              {[job?.site_name, address].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              Available Slots
            </CardTitle>
          </CardHeader>

          <CardContent>
            {slots.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                There are no available slots right now. Please check back later.
              </p>
            ) : (
              <div className="overflow-hidden rounded border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Remaining
                      </th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {slots.map((slot) => {
                      const remaining = slot.capacity - slot.booked_count;
                      const isSelected = slot.id === selectedSlotId;

                      return (
                        <tr
                          key={slot.id}
                          className={
                            'cursor-pointer border-t ' +
                            (isSelected ? 'bg-primary/10' : 'hover:bg-muted/40')
                          }
                          onClick={() => setSelectedSlotId(slot.id)}
                        >
                          <td className="px-3 py-2">
                            {formatDate(slot.slot_date)}
                          </td>
                          <td className="px-3 py-2">
                            {periodLabel(slot.local_start)}
                            <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                              {formatTime(slot.local_start)}–
                              {formatTime(slot.local_end)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {remaining}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant={isSelected ? 'default' : 'outline'}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedSlotId(slot.id);
                              }}
                            >
                              {isSelected ? 'Selected' : 'Select'}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {slots.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Your Details</CardTitle>
            </CardHeader>

            <CardContent>
              <form onSubmit={submitBooking} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    className="rounded border p-2 sm:col-span-2"
                    placeholder="Full Name"
                    autoComplete="name"
                    value={form.full_name}
                    onChange={(e) =>
                      setForm({ ...form, full_name: e.target.value })
                    }
                    required
                  />
                  <input
                    type="tel"
                    className="rounded border p-2"
                    placeholder="Mobile Number"
                    autoComplete="tel"
                    inputMode="tel"
                    value={form.mobile}
                    onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                    required
                  />
                  <input
                    type="email"
                    className="rounded border p-2"
                    placeholder="Email"
                    autoComplete="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                  />
                  <input
                    className="rounded border p-2 sm:col-span-2"
                    placeholder="Unit Number"
                    value={form.unit_number}
                    onChange={(e) =>
                      setForm({ ...form, unit_number: e.target.value })
                    }
                    required
                  />
                </div>

                {selectedSlot && (
                  <p className="rounded border bg-muted/40 p-3 text-sm">
                    Selected: {formatDate(selectedSlot.slot_date)} ·{' '}
                    {periodLabel(selectedSlot.local_start)}
                  </p>
                )}

                {submitError && (
                  <p
                    role="alert"
                    className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                  >
                    {submitError}
                  </p>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting || !selectedSlot}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Booking...
                    </>
                  ) : (
                    'Book Appointment'
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
