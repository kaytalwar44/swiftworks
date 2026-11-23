import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
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
  company_name?: string | null;
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

    const linkRow = Array.isArray(linkRes.data)
      ? linkRes.data[0]
      : linkRes.data;

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
      company_name:
        typeof linkRow.company_name === 'string' ? linkRow.company_name : null,
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
      setSubmitError(
        'Please enter a valid Australian mobile, e.g. 0412 345 678.',
      );
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
    const { error } = await (supabase as any).rpc('booking_create', {
      p_token: link.token,
      p_slot_id: selectedSlot.id,
      p_full_name: form.full_name.trim(),
      p_mobile: form.mobile.replace(/[\s-]/g, ''),
      p_email: form.email.trim().toLowerCase(),
      p_unit_number: form.unit_number.trim(),
    });

    console.log('RPC ERROR:', error);
    setSubmitting(false);

    if (error) {
      const msg = String(error.message || '');
      if (
        msg.toLowerCase().includes('full') ||
        msg.toLowerCase().includes('capacity')
      ) {
        console.error('BOOKING ERROR:', error);
        console.error('BOOKING MESSAGE:', msg);

        setSubmitError(`RAW ERROR: ${msg}`);
        return;
      }

      setSubmitError(msg || 'Booking failed. Please try again.');
      return;
    }

    setConfirmed(selectedSlot);
  }

  if (loading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-slate-50 p-4 text-slate-600"
        style={{ colorScheme: 'light' }}
      >
        <span role="status" className="flex items-center gap-3">
          <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin" />
          Loading appointments…
        </span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-slate-50 p-4 text-slate-900"
        style={{ colorScheme: 'light' }}
      >
        <Card className="w-full min-w-0 max-w-md border-slate-200 bg-white text-slate-900">
          <CardContent className="break-words p-6 text-center">
            <h1 className="text-lg font-semibold">Booking unavailable</h1>
            <p
              role="alert"
              className="mt-2 text-sm leading-relaxed text-slate-600"
            >
              {loadError}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-slate-50 p-4 text-slate-900"
        style={{ colorScheme: 'light' }}
      >
        <Card className="w-full min-w-0 max-w-md border-slate-200 bg-white text-slate-900">
          <CardContent
            role="status"
            className="space-y-3 break-words p-6 text-center"
          >
            <CheckCircle2
              aria-hidden="true"
              className="mx-auto h-10 w-10 text-green-600"
            />
            <h1 className="text-xl font-semibold">Appointment booked</h1>
            <p className="text-sm leading-relaxed text-slate-600">
              {formatDate(confirmed.slot_date)} ·{' '}
              {periodLabel(confirmed.local_start)} (
              {formatTime(confirmed.local_start)}–
              {formatTime(confirmed.local_end)})
            </p>
            <p className="text-sm leading-relaxed text-slate-600">
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
    <main
      className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900 sm:px-6 sm:py-10"
      style={{ colorScheme: 'light' }}
    >
      <div className="mx-auto w-full min-w-0 max-w-2xl space-y-5 break-words sm:space-y-6">
        <header className="min-w-0 space-y-3">
          <p className="text-sm font-semibold text-slate-600">
            SwiftWorks · Appointment booking
          </p>
          {job?.company_name && (
            <p className="text-base font-semibold text-slate-900">
              {job.company_name}
            </p>
          )}
          <h1 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
            {job?.title || job?.job_number || 'Book an appointment'}
          </h1>
          {job?.job_number && (
            <p className="text-sm text-slate-600">
              Job reference:{' '}
              <span className="font-medium text-slate-900">
                {job.job_number}
              </span>
            </p>
          )}
          {(job?.site_name || address) && (
            <div className="flex min-w-0 items-start gap-2 text-sm leading-relaxed text-slate-600">
              <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                {job?.site_name && (
                  <p className="font-medium text-slate-900">{job.site_name}</p>
                )}
                {address && <p>{address}</p>}
              </div>
            </div>
          )}
        </header>

        <Card className="min-w-0 border-slate-200 bg-white text-slate-900">
          <CardHeader className="p-4 sm:p-6">
            <CardTitle>
              <h2 className="flex items-center gap-2 text-lg">
                <CalendarDays
                  aria-hidden="true"
                  className="h-5 w-5 shrink-0 text-blue-700"
                />
                Available slots
              </h2>
            </CardTitle>
            <p className="text-sm font-normal leading-relaxed text-slate-600">
              Choose an appointment time, then enter your details below.
            </p>
          </CardHeader>

          <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
            {slots.length === 0 ? (
              <p className="py-6 text-center text-sm leading-relaxed text-slate-600">
                There are no available slots right now. Please check back later.
              </p>
            ) : (
              <ul
                aria-label="Available appointment times"
                className="grid min-w-0 gap-3 sm:grid-cols-2"
              >
                {slots.map((slot) => {
                  const remaining = slot.capacity - slot.booked_count;
                  const isSelected = slot.id === selectedSlotId;

                  return (
                    <li key={slot.id} className="min-w-0">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        className={
                          'flex h-full min-h-12 w-full min-w-0 flex-col items-start gap-2 rounded-lg border p-4 text-left text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ' +
                          (isSelected
                            ? 'border-blue-600 bg-blue-50 text-slate-900'
                            : 'border-slate-200 bg-white text-slate-900 hover:border-blue-400 hover:bg-slate-50')
                        }
                        onClick={() => setSelectedSlotId(slot.id)}
                      >
                        <span className="font-semibold">
                          {formatDate(slot.slot_date)}
                        </span>
                        <span className="text-sm text-slate-600">
                          {periodLabel(slot.local_start)} ·{' '}
                          <span className="tabular-nums">
                            {formatTime(slot.local_start)}–
                            {formatTime(slot.local_end)}
                          </span>
                        </span>
                        <span className="text-sm text-slate-600">
                          {remaining} {remaining === 1 ? 'place' : 'places'}{' '}
                          remaining
                        </span>
                        <span
                          className={
                            'mt-1 flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ' +
                            (isSelected
                              ? 'bg-blue-700 text-white'
                              : 'bg-slate-100 text-slate-900')
                          }
                        >
                          {isSelected && (
                            <CheckCircle2
                              aria-hidden="true"
                              className="h-4 w-4 shrink-0"
                            />
                          )}
                          {isSelected ? 'Selected' : 'Select time'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {slots.length > 0 && (
          <Card className="min-w-0 border-slate-200 bg-white text-slate-900">
            <CardHeader className="p-4 sm:p-6">
              <CardTitle>
                <h2 className="text-lg">Customer details</h2>
              </CardTitle>
              <p className="text-sm font-normal leading-relaxed text-slate-600">
                Enter your contact details for this appointment.
              </p>
            </CardHeader>

            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <form onSubmit={submitBooking} className="space-y-4">
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1.5 sm:col-span-2">
                    <label
                      htmlFor="booking-full-name"
                      className="block text-sm font-medium"
                    >
                      Full name
                    </label>
                    <input
                      id="booking-full-name"
                      className="min-h-12 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                      placeholder="Full Name"
                      autoComplete="name"
                      value={form.full_name}
                      onChange={(e) =>
                        setForm({ ...form, full_name: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <label
                      htmlFor="booking-mobile"
                      className="block text-sm font-medium"
                    >
                      Mobile number
                    </label>
                    <input
                      id="booking-mobile"
                      type="tel"
                      className="min-h-12 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                      placeholder="Mobile Number"
                      autoComplete="tel"
                      inputMode="tel"
                      value={form.mobile}
                      onChange={(e) =>
                        setForm({ ...form, mobile: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <label
                      htmlFor="booking-email"
                      className="block text-sm font-medium"
                    >
                      Email address
                    </label>
                    <input
                      id="booking-email"
                      type="email"
                      className="min-h-12 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                      placeholder="Email"
                      autoComplete="email"
                      value={form.email}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="min-w-0 space-y-1.5 sm:col-span-2">
                    <label
                      htmlFor="booking-unit"
                      className="block text-sm font-medium"
                    >
                      Unit number
                    </label>
                    <input
                      id="booking-unit"
                      className="min-h-12 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                      placeholder="Unit Number"
                      value={form.unit_number}
                      onChange={(e) =>
                        setForm({ ...form, unit_number: e.target.value })
                      }
                      required
                    />
                  </div>
                </div>

                {selectedSlot && (
                  <p
                    role="status"
                    className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm leading-relaxed text-blue-900"
                  >
                    Selected: {formatDate(selectedSlot.slot_date)} ·{' '}
                    {periodLabel(selectedSlot.local_start)} (
                    {formatTime(selectedSlot.local_start)}–
                    {formatTime(selectedSlot.local_end)})
                  </p>
                )}

                {submitError && (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-relaxed text-red-800"
                  >
                    {submitError}
                  </p>
                )}

                <Button
                  type="submit"
                  className="min-h-12 w-full bg-blue-700 text-base text-white hover:bg-blue-800 focus-visible:ring-blue-600"
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
    </main>
  );
}
