import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  ClipboardList,
  QrCode,
  ScanLine,
  HardHat,
  Loader2,
  LogOut,
  MapPin,
  Phone,
} from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type PortalJob = {
  job_id: string;
  job_title: string | null;
  job_number: string | null;
  address: string | null;
  booking_count: number;
};

type PortalBooking = {
  booking_id: string;
  customer_name: string | null;
  slot_date: string | null;
  local_start: string | null;
  local_end: string | null;
  unit_number: string | null;
  phone: string | null;
  status: string | null;
  equipment_serial: string | null;
};

/** Booking outcomes a technician can record, mapped to customer_bookings.status. */
const OUTCOMES = [
  { value: 'completed', label: 'Install Completed' },
  { value: 'customer_refused', label: 'Customer Refused' },
  { value: 'no_show', label: 'Customer Not At Home' },
  { value: 'rescheduled', label: 'Rescheduled - Customer Requested' },
] as const;

type OutcomeValue = (typeof OUTCOMES)[number]['value'];

function outcomeLabel(value: OutcomeValue): string {
  return OUTCOMES.find((o) => o.value === value)?.label ?? value;
}

/** Today as YYYY-MM-DD in the browser's own time zone, not UTC. */
function localIsoDate(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

/** 2026-10-05 -> Mon 05 Oct */
function formatDate(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value + 'T00:00:00');
  return d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
}

/** 08:00:00, 12:00:00 -> 08:00 - 12:00 */
function formatTimeRange(start: string | null, end: string | null): string {
  if (!start && !end) return '-';
  const s = start ? start.slice(0, 5) : '';
  const e = end ? end.slice(0, 5) : '';
  return s && e ? s + ' - ' + e : s || e;
}

export default function TechnicianPortal() {
  const { user, company, signOut } = useAuth();

  /**
   * The technicians row for the signed-in user.
   *
   * users.id and technicians.id are different values: the technician id lives
   * on public.technicians and is matched by user_id. app.current_technician_id()
   * does this server-side, but the BOG insert is a client write, so it is
   * resolved here once on mount.
   */
  const [technicianId, setTechnicianId] = useState<string | null>(null);

  // Resolved through a SECURITY DEFINER RPC rather than a direct select on
  // public.technicians. The table's RLS does not expose a technician's own row
  // to them, so a client query returns zero rows and .maybeSingle() reports
  // null — indistinguishable from "no technician record". The RPC runs as its
  // owner and answers with app.current_technician_id(), the same function
  // technician_portal_jobs() already uses.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data, error: rpcError } = await (supabase as any).rpc(
        'current_technician',
      );

      if (cancelled) return;

      if (rpcError) {
        console.error('current_technician failed', rpcError);
        setTechnicianId(null);
        return;
      }

      // A scalar-returning RPC arrives unwrapped; a table-returning one arrives
      // as an array. Handle both so the return shape can change without a
      // client edit.
      const rows = Array.isArray(data) ? data : [data];
      const first = rows[0];
      const id =
        typeof first === 'string'
          ? first
          : ((first as { technician_id?: string | null } | null)
              ?.technician_id ?? null);

      setTechnicianId(id);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // company_id for the BOG insert, taken from the auth context exactly as Jobs
  // and Bookings do. technician_portal_jobs() does not return it, so reading it
  // off the job row would send undefined and fail the NOT NULL constraint.
  const companyId = company?.id ?? null;



  const [jobs, setJobs] = useState<PortalJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [bookings, setBookings] = useState<Record<string, PortalBooking[]>>({});
  const [bookingsLoadingId, setBookingsLoadingId] = useState<string | null>(null);
  const [bookingsError, setBookingsError] = useState<string | null>(null);

  /** booking id mid-request, so only that row's button spins. */
  const [actingId, setActingId] = useState<string | null>(null);
  /** booking awaiting confirmation, with which action was asked for. */
  const [pendingAction, setPendingAction] = useState<{
    booking: PortalBooking;
    jobId: string;
    outcome: OutcomeValue;
  } | null>(null);
  /** Outcome picked in each booking's dropdown, keyed by booking id. */
  const [outcomeById, setOutcomeById] = useState<Record<string, OutcomeValue | ''>>({});
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  /** BOG Report dialog: which job, the date, and the technician count. */
  const [bogReportJob, setBogReportJob] = useState<PortalJob | null>(null);
  const [bogReportDate, setBogReportDate] = useState('');
  const [bogReportCount, setBogReportCount] = useState('');
  const [bogReportError, setBogReportError] = useState<string | null>(null);
  const [bogReportSaving, setBogReportSaving] = useState(false);
  const [bogReportNotice, setBogReportNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /** Equipment scan dialog: which booking is being scanned, and its state. */
  const [scanTarget, setScanTarget] = useState<{
    booking: PortalBooking;
    jobId: string;
  } | null>(null);
  const [scanValue, setScanValue] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanSaving, setScanSaving] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [scanActive, setScanActive] = useState(false);
  /** The running html5-qrcode instance, kept so it can be stopped on close. */
  const scannerRef = useRef<any>(null);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { data, error: rpcError } = await (supabase as any).rpc(
      'technician_portal_jobs',
    );

    if (rpcError) {
      console.error('technician_portal_jobs failed', rpcError);
      setError(rpcError.message);
      setLoading(false);
      return;
    }

    setJobs(
      ((data ?? []) as any[]).map((row) => ({
        ...row,
        booking_count: Number(row.booking_count ?? 0),
      })) as PortalJob[],
    );
    setLoading(false);
  }, []);

  /**
   * Re-reads one job's bookings. Uses the same RPC as toggleBookings so a
   * refreshed list can never show a different set of rows than the first load.
   */
  const loadBookings = useCallback(async (jobId: string) => {
    const { data, error: rpcError } = await (supabase as any).rpc(
      'technician_portal_bookings',
      { p_job_id: jobId },
    );

    if (rpcError) {
      console.error('technician_portal_bookings failed', rpcError);
      setBookingsError(rpcError.message);
      return;
    }

    setBookings((prev) => ({
      ...prev,
      [jobId]: (data ?? []) as PortalBooking[],
    }));
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  /**
   * Starts the camera in the dialog's reader div. The library is imported
   * lazily so it never lands in the initial bundle — the portal is opened on
   * phones over mobile data.
   */
  async function startScanner() {
    setScanError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setScanError(
        'This browser cannot open the camera. Enter the serial by hand below.',
      );
      return;
    }

    try {
      // Typed locally: html5-qrcode's declaration file is not resolvable in
      // every install (no "types" field on some published builds), which turns
      // the import into an implicit-any error under "noImplicitAny".
      const mod: any = await import('html5-qrcode');
      const Html5Qrcode = mod.Html5Qrcode ?? mod.default ?? mod;

      const reader = document.getElementById('equipment-reader');
      if (!reader) return;

      const scanner = new Html5Qrcode('equipment-reader');
      scannerRef.current = scanner;
      setScanActive(true);

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText: string) => {
          // One good read is enough; stop before the callback fires again.
          setScanValue(decodedText.trim());
          setScanNotice('QR code read.');
          void stopScanner();
        },
        (_errorMessage: string) => {
          // Frames that hold no code arrive here constantly; not an error.
        },
      );
    } catch (err: any) {
      setScanActive(false);
      scannerRef.current = null;
      const message = String(err?.message ?? err ?? '');
      setScanError(
        /permission|denied|NotAllowed/i.test(message)
          ? 'Camera access was refused. Allow it in the browser, or enter the serial by hand below.'
          : 'The camera could not be started. Enter the serial by hand below.',
      );
    }
  }

  async function stopScanner() {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    setScanActive(false);
    if (!scanner) return;
    try {
      await scanner.stop();
      scanner.clear();
    } catch {
      // Already stopped, or the camera was never acquired.
    }
  }

  function closeScanner() {
    void stopScanner();
    setScanTarget(null);
    setScanValue('');
    setScanError(null);
    setScanNotice(null);
  }

  /** Writes the scanned serial to the booking and refreshes that job's list. */
  async function saveSerial() {
    if (!scanTarget) return;

    const serial = scanValue.trim();
    if (serial === '') {
      setScanError('Scan a code or type the serial first.');
      return;
    }

    const { booking, jobId } = scanTarget;
    setScanSaving(true);
    setScanError(null);

    const { data, error: updError } = await (supabase as any)
      .from('customer_bookings')
      .update({ equipment_serial: serial })
      .eq('id', booking.booking_id)
      .select('id');

    setScanSaving(false);

    if (updError) {
      setScanError(updError.message);
      return;
    }

    // An update matching no rows returns no error, so check the row came back.
    if ((data ?? []).length === 0) {
      setScanError(
        'The serial was not saved. It may be blocked by a permissions rule.',
      );
      return;
    }

    closeScanner();
    setActionNotice('Equipment serial saved.');
    await loadBookings(jobId);
  }

  async function toggleBookings(jobId: string) {
    setBookingsError(null);

    if (openJobId === jobId) {
      setOpenJobId(null);
      return;
    }

    setOpenJobId(jobId);

    // Already loaded this session.
    if (bookings[jobId]) return;

    setBookingsLoadingId(jobId);

    const { data, error: rpcError } = await (supabase as any).rpc(
      'technician_portal_bookings',
      { p_job_id: jobId },
    );

    setBookingsLoadingId(null);

    if (rpcError) {
      console.error('technician_portal_bookings failed', rpcError);
      setBookingsError(rpcError.message);
      return;
    }

    setBookings((prev) => ({
      ...prev,
      [jobId]: (data ?? []) as PortalBooking[],
    }));
  }

  /**
   * Marks a booking installed or rejected, then reloads that job's bookings so
   * the finished row leaves the expanded list straight away.
   *
   * Scoped by id only: technician_portal_bookings already refused to return the
   * row unless the job belongs to the caller, and row-level security is what
   * stops a write to anyone else's booking. .select('id') is deliberate — an
   * update matching no rows returns no error, so without it a blocked write
   * would read as success and the row would stay on screen.
   */
  async function runAction() {
    if (!pendingAction) return;

    const { booking, jobId, outcome } = pendingAction;
    setActingId(booking.booking_id);
    setActionError(null);
    setActionNotice(null);

    // Outcome only. BOG is recorded separately through the BOG Report dialog.
    const payload: Record<string, unknown> =
      outcome === 'completed'
        ? { status: outcome, completed_at: new Date().toISOString() }
        : { status: outcome };

    const { data, error: updError } = await (supabase as any)
      .from('customer_bookings')
      .update(payload)
      .eq('id', booking.booking_id)
      .select('id');

    setActingId(null);

    if (updError) {
      setActionError(updError.message);
      setPendingAction(null);
      return;
    }

    if ((data ?? []).length === 0) {
      setActionError(
        'The booking was not updated. It may be blocked by a permissions rule.',
      );
      setPendingAction(null);
      return;
    }

    setPendingAction(null);
    setActionNotice(
      'Outcome saved: ' + outcomeLabel(outcome) + '.',
    );

    // Drop this job's cached bookings so the row disappears at once, then
    // refetch the job list so the card's booking count follows.
    setBookings((prev) => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
    await loadJobs();
  }

  /**
   * Submits a BOG report for a job. This writes to public.bog_reports and
   * deliberately does not touch customer_bookings — it is a separate record of
   * who was on site, not a change to a booking's status.
   */
  async function submitBogReport() {
    if (!bogReportJob) return;

    setBogReportError(null);

    const countTrimmed = bogReportCount.trim();
    if (countTrimmed === '' || !/^\d+$/.test(countTrimmed)) {
      setBogReportError('Technicians on site must be 0 or greater.');
      return;
    }

    if (!bogReportDate) {
      setBogReportError('Please choose a report date.');
      return;
    }

    if (!companyId) {
      setBogReportError(
        'Could not determine your company. Try reloading the page.',
      );
      return;
    }

    if (!technicianId) {
      setBogReportError(
        'No technician record is linked to your account. Ask an administrator to link it.',
      );
      return;
    }

    setBogReportSaving(true);

    const { data, error: insertError } = await (supabase as any)
      .from('bog_reports')
      .insert([
        {
          company_id: companyId,
          job_id: bogReportJob.job_id,
          technician_id: technicianId,
          report_date: bogReportDate,
          technician_count: Number(countTrimmed),
        },
      ])
      .select('id');

    setBogReportSaving(false);

    if (insertError) {
      setBogReportError(insertError.message);
      return;
    }

    // An insert filtered out by RLS returns no error and no rows.
    if ((data ?? []).length === 0) {
      setBogReportError(
        'The BOG report was not saved. It may be blocked by a permissions rule.',
      );
      return;
    }

    setBogReportJob(null);
    setBogReportCount('');
    setBogReportNotice('BOG report submitted.');
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
      {/* Header: brand, then sign out */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <HardHat className="h-6 w-6 text-primary" />
          <span className="text-lg font-semibold tracking-tight">
            SwiftWorks
          </span>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => void signOut()}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign Out
        </Button>
      </div>

      {/* Who this portal belongs to */}
      <div>
        <p className="text-base font-medium">
          Welcome, {user?.full_name || 'Technician'}
        </p>
        {user?.email && (
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
        )}
      </div>

      <div className="border-t pt-4">
        <h1 className="text-xl font-semibold tracking-tight">My Jobs</h1>
        <p className="text-sm text-muted-foreground">
          Jobs assigned to you
        </p>
      </div>

      {bogReportNotice && (
        <div className="rounded border bg-muted/40 p-3 text-sm">
          {bogReportNotice}
        </div>
      )}

      {actionNotice && (
        <div className="rounded border bg-muted/40 p-3 text-sm">
          {actionNotice}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {actionError}
        </div>
      )}

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : jobs.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No jobs are assigned to you yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const isOpen = openJobId === job.job_id;
            const jobBookings = bookings[job.job_id] ?? [];

            return (
              <Card key={job.job_id}>
                <CardContent className="space-y-3 p-4">
                  <div>
                    <div className="text-base font-semibold leading-tight">
                      {job.job_title || 'Untitled Job'}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Job #: {job.job_number || '-'}
                    </div>
                  </div>

                  {job.address && (
                    <div className="flex items-start gap-2 text-sm">
                      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span>{job.address}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2 text-sm">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    <span>
                      {job.booking_count}{' '}
                      {job.booking_count === 1 ? 'booking' : 'bookings'}
                    </span>
                  </div>

                  <Button
                    variant="outline"
                    className="h-11 w-full"
                    onClick={() => toggleBookings(job.job_id)}
                  >
                    {isOpen ? (
                      <>
                        <ChevronUp className="mr-2 h-4 w-4" />
                        Hide Bookings
                      </>
                    ) : (
                      <>
                        <ChevronDown className="mr-2 h-4 w-4" />
                        View Bookings
                      </>
                    )}
                  </Button>

                  <Button
                    variant="outline"
                    className="h-11 w-full"
                    onClick={() => {
                      setBogReportJob(job);
                      setBogReportCount('');
                      setBogReportError(null);
                      setBogReportDate(localIsoDate());
                    }}
                  >
                    <ClipboardList className="mr-2 h-4 w-4" />
                    BOG Report
                  </Button>

                  {isOpen && (
                    <div className="space-y-2 border-t pt-3">
                      {bookingsLoadingId === job.job_id ? (
                        <div className="flex h-16 items-center justify-center">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : bookingsError ? (
                        <p
                          role="alert"
                          className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                        >
                          {bookingsError}
                        </p>
                      ) : jobBookings.length === 0 ? (
                        <p className="py-2 text-center text-sm text-muted-foreground">
                          No bookings for this job.
                        </p>
                      ) : (
                        jobBookings.map((b) => (
                          <div
                            key={b.booking_id}
                            className="rounded border bg-muted/30 p-3"
                          >
                            <div className="font-medium">
                              {b.customer_name || 'Unknown Customer'}
                            </div>

                            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                              <div>
                                <span className="text-muted-foreground">Date: </span>
                                {formatDate(b.slot_date)}
                              </div>
                              <div>
                                <span className="text-muted-foreground">Time: </span>
                                {formatTimeRange(b.local_start, b.local_end)}
                              </div>
                              <div>
                                <span className="text-muted-foreground">Unit: </span>
                                {b.unit_number || '-'}
                              </div>
                            </div>

                            <div className="mt-2 flex items-center gap-2 text-sm">
                              <ScanLine className="h-4 w-4 text-muted-foreground" />
                              <span className="text-muted-foreground">Serial: </span>
                              {b.equipment_serial ? (
                                <span className="font-medium">{b.equipment_serial}</span>
                              ) : (
                                <span className="text-muted-foreground">
                                  Not scanned
                                </span>
                              )}
                            </div>

                            {b.phone ? (
                              <a
                                href={'tel:' + b.phone}
                                className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
                              >
                                <Phone className="h-4 w-4" />
                                {b.phone}
                              </a>
                            ) : (
                              <div className="mt-2 text-sm text-muted-foreground">
                                No phone
                              </div>
                            )}

                            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                              <label htmlFor={'outcome-' + b.booking_id} className="sr-only">
                                Outcome
                              </label>
                              <select
                                id={'outcome-' + b.booking_id}
                                className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"
                                value={outcomeById[b.booking_id] ?? ''}
                                disabled={actingId === b.booking_id}
                                onChange={(e) =>
                                  setOutcomeById((prev) => ({
                                    ...prev,
                                    [b.booking_id]: e.target.value as OutcomeValue | '',
                                  }))
                                }
                              >
                                <option value="">Select outcome…</option>
                                {OUTCOMES.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>

                              <Button
                                size="sm"
                                className="h-10 sm:w-36"
                                disabled={
                                  actingId === b.booking_id || !outcomeById[b.booking_id]
                                }
                                onClick={() => {
                                  const outcome = outcomeById[b.booking_id];
                                  if (!outcome) return;
                                  setPendingAction({ booking: b, jobId: job.job_id, outcome });
                                }}
                              >
                                {actingId === b.booking_id ? (
                                  <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Saving...
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle2 className="mr-2 h-4 w-4" />
                                    Save Outcome
                                  </>
                                )}
                              </Button>

                              <Button
                                size="sm"
                                variant="outline"
                                className="h-10 sm:w-36"
                                disabled={actingId === b.booking_id}
                                onClick={() => {
                                  setScanTarget({ booking: b, jobId: job.job_id });
                                  setScanValue(b.equipment_serial ?? '');
                                  setScanError(null);
                                  setScanNotice(null);
                                }}
                              >
                                <QrCode className="mr-2 h-4 w-4" />
                                Scan QR Code
                              </Button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Confirmation for the two booking actions */}
      {pendingAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="portal-confirm-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPendingAction(null);
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingAction(null);
          }}
        >
          <div className="w-full max-w-sm space-y-4 rounded-lg border bg-background p-5 shadow-xl">
            <div>
              <h2 id="portal-confirm-title" className="text-lg font-semibold">
                Save outcome: {outcomeLabel(pendingAction.outcome)}?
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {pendingAction.booking.customer_name || 'This customer'}
                {pendingAction.booking.unit_number
                  ? ' - Unit ' + pendingAction.booking.unit_number
                  : ''}
              </p>
              <p className="text-sm text-muted-foreground">
                {formatDate(pendingAction.booking.slot_date)} -{' '}
                {formatTimeRange(
                  pendingAction.booking.local_start,
                  pendingAction.booking.local_end,
                )}
              </p>
            </div>

            <p className="text-sm">
              This records the outcome for this booking and removes it from this job.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPendingAction(null)}>
                Cancel
              </Button>
              <Button
                disabled={actingId !== null}
                onClick={() => void runAction()}
              >
                {actingId !== null ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save Outcome'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Equipment scan — writes equipment_serial on the booking */}
      {scanTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="scan-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeScanner();
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeScanner();
          }}
        >
          <div className="w-full max-w-sm space-y-4 rounded-lg border bg-background p-5 shadow-xl">
            <div>
              <h2 id="scan-title" className="text-lg font-semibold">
                Scan equipment QR code
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {scanTarget.booking.customer_name || 'This customer'}
                {scanTarget.booking.unit_number
                  ? ' - Unit ' + scanTarget.booking.unit_number
                  : ''}
              </p>
            </div>

            {/* The library renders its video into this element. */}
            <div
              id="equipment-reader"
              className="aspect-square w-full overflow-hidden rounded border bg-muted/40"
            />

            {scanActive ? (
              <Button variant="outline" className="w-full" onClick={() => void stopScanner()}>
                Stop camera
              </Button>
            ) : (
              <Button className="w-full" onClick={() => void startScanner()}>
                <QrCode className="mr-2 h-4 w-4" />
                Start camera
              </Button>
            )}

            <div className="space-y-1.5">
              <label htmlFor="equipment-serial" className="text-sm font-medium">
                Equipment serial
              </label>
              <input
                id="equipment-serial"
                type="text"
                className="w-full rounded border p-2 text-sm"
                placeholder="Scan a code, or type the serial"
                value={scanValue}
                disabled={scanSaving}
                onChange={(e) => {
                  setScanValue(e.target.value);
                  setScanError(null);
                }}
              />
              {scanNotice && (
                <p className="text-sm text-muted-foreground">{scanNotice}</p>
              )}
              {scanError && (
                <p role="alert" className="text-sm text-destructive">
                  {scanError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeScanner}>
                Cancel
              </Button>
              <Button
                disabled={scanSaving || scanValue.trim() === ''}
                onClick={() => void saveSerial()}
              >
                {scanSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save Serial'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* BOG Report — writes to bog_reports, never to customer_bookings */}
      {bogReportJob && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bog-report-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setBogReportJob(null);
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) setBogReportJob(null);
          }}
        >
          <div className="w-full max-w-sm space-y-4 rounded-lg border bg-background p-5 shadow-xl">
            <div>
              <h2 id="bog-report-title" className="text-lg font-semibold">
                BOG Report
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {bogReportJob.job_title || 'Untitled Job'}
                {bogReportJob.job_number
                  ? ' - ' + bogReportJob.job_number
                  : ''}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="bog-report-date" className="text-sm font-medium">
                Date
              </label>
              <input
                id="bog-report-date"
                type="date"
                className="w-full rounded border p-2 text-sm"
                value={bogReportDate}
                disabled={bogReportSaving}
                onChange={(e) => {
                  setBogReportDate(e.target.value);
                  setBogReportError(null);
                }}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="bog-report-count"
                className="text-sm font-medium"
              >
                Technicians On Site
              </label>
              <input
                id="bog-report-count"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                autoFocus
                className="w-full rounded border p-2 text-sm"
                placeholder="0"
                value={bogReportCount}
                disabled={bogReportSaving}
                onChange={(e) => {
                  setBogReportCount(e.target.value);
                  setBogReportError(null);
                }}
              />
            </div>

            {bogReportError && (
              <p role="alert" className="text-sm text-destructive">
                {bogReportError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setBogReportJob(null)}
              >
                Cancel
              </Button>
                            <Button
                // technicianId is deliberately not part of this gate. When the
                // signed-in user has no technicians row linked, disabling the
                // button leaves no way to find out why; the guard inside
                // submitBogReport() explains it on click instead.
                disabled={bogReportSaving || bogReportCount.trim() === ''}
                onClick={() => void submitBogReport()}
              >
                {bogReportSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Submit BOG'
                )}
              </Button>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
