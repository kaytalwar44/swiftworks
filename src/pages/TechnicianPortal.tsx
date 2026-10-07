import { useCallback, useEffect, useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  HardHat,
  Loader2,
  LogOut,
  MapPin,
  Phone,
  UserX,
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
};

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
  const { user, signOut } = useAuth();

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
    kind: 'complete' | 'rejected';
  } | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

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

    const { booking, jobId, kind } = pendingAction;
    setActingId(booking.booking_id);
    setActionError(null);
    setActionNotice(null);

    const payload: Record<string, unknown> =
      kind === 'complete'
        ? { status: 'completed', completed_at: new Date().toISOString() }
        : { status: 'no_show' };

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
      kind === 'complete'
        ? 'Booking marked as installed.'
        : 'Booking marked as rejected.',
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
                              <Button
                                size="sm"
                                className="h-10 flex-1"
                                disabled={actingId === b.booking_id}
                                onClick={() =>
                                  setPendingAction({
                                    booking: b,
                                    jobId: job.job_id,
                                    kind: 'complete',
                                  })
                                }
                              >
                                {actingId === b.booking_id ? (
                                  <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Saving...
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle2 className="mr-2 h-4 w-4" />
                                    Install Complete
                                  </>
                                )}
                              </Button>

                              <Button
                                size="sm"
                                variant="outline"
                                className="h-10 flex-1"
                                disabled={actingId === b.booking_id}
                                onClick={() =>
                                  setPendingAction({
                                    booking: b,
                                    jobId: job.job_id,
                                    kind: 'rejected',
                                  })
                                }
                              >
                                <UserX className="mr-2 h-4 w-4" />
                                Customer Rejected
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
                {pendingAction.kind === 'complete'
                  ? 'Mark as installed?'
                  : 'Mark as customer rejected?'}
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
              {pendingAction.kind === 'complete'
                ? 'This marks the installation complete and removes it from this job.'
                : 'This records that the customer refused the installation and removes it from this job.'}
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
                ) : pendingAction.kind === 'complete' ? (
                  'Mark installed'
                ) : (
                  'Mark rejected'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
