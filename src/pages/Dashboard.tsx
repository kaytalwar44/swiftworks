import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  Building2,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  Clock,
  DollarSign,
  HardHat,
  Info,
  Loader2,
  MapPin,
  Phone,
  Plus,
  QrCode,
  Star,
  TrendingUp,
  UserX,
  Users,
} from 'lucide-react';
import { supabase, unwrap } from '@/lib/supabase/client';
import type { DashboardSummary } from '@/lib/supabase/database.types';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Today as YYYY-MM-DD in the browser's own time zone, not UTC. */
function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function formatMoney(value: number, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

interface KpiCardProps {
  label: string;
  value: string | number;
  hint?: string;
  icon: LucideIcon;
  accent?: string;
}

function KpiCard({ label, value, hint, icon: Icon, accent }: KpiCardProps) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <span className={cn('rounded-lg p-2', accent ?? 'bg-primary/10 text-primary')}>
          <Icon className="h-5 w-5" />
        </span>
      </CardContent>
    </Card>
  );
}

/** Shape returned by technician_dashboard(), confirmed against the live RPC. */
type TechnicianDashboard = {
  date: string;
  today: {
    total: number;
    completed: number;
    remaining: number;
  };
  week: {
    total: number;
    completed: number;
  };
  earnings: {
    rating: number | null;
    current_period: number;
    lifetime_installs: number;
  };
  next_booking: {
    booking_ref: string | null;
    site_name: string | null;
    address: string | null;
    unit_number: string | null;
    local_start: string | null;
    local_end: string | null;
    access_notes: string | null;
    special_comments: string | null;
  } | null;
};

/** Shape returned by technician_upcoming_bookings(). */
type UpcomingBooking = {
  id: string;
  scheduled_date: string | null;
  local_start: string | null;
  local_end: string | null;
  site_name: string | null;
  address: string | null;
  unit_number: string | null;
  customer_name: string | null;
  phone_number: string | null;
};

/** "08:00:00" -> "08:00" */
function formatTime(value: string | null): string {
  return value ? value.slice(0, 5) : '-';
}

/** "2026-10-04" -> "Sun 04 Oct 2026" */
function formatDate(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value + 'T00:00:00');
  return d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Technician dashboard. Resolves the calling technician server-side through
 * app.current_technician_id(), so no id is passed and no tenant data beyond
 * their own assignments is reachable.
 */
function TechnicianDashboardView() {
  const { data, isPending } = useQuery({
    queryKey: ['dashboard', 'technician'],
    queryFn: async () => {
      const response = await (supabase as any).rpc('technician_dashboard', {
  p_date: new Date().toISOString().slice(0, 10),
});
      const rows = unwrap(response) as unknown as TechnicianDashboard[];
      return Array.isArray(rows) ? rows[0] : (rows as TechnicianDashboard);
    },
    refetchInterval: 60_000,
  });

  const queryClient = useQueryClient();

  /** booking id currently being actioned. */
  const [actingId, setActingId] = useState<string | null>(null);
  /** booking awaiting confirmation, with which action was requested. */
  const [pendingAction, setPendingAction] = useState<{
    booking: UpcomingBooking;
    kind: 'complete' | 'no_show';
  } | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: upcoming, isPending: upcomingPending } = useQuery({
    queryKey: ['dashboard', 'technician', 'upcoming'],
    queryFn: async () => {
      const response = await (supabase as any).rpc(
        'technician_upcoming_bookings',
      );
      const rows = unwrap(response) as unknown as UpcomingBooking[];
      return Array.isArray(rows) ? rows : [];
    },
    refetchInterval: 60_000,
  });

  /**
   * Marks a booking installed or a no-show.
   *
   * Scoped by id only: the RPC has already resolved this row for the calling
   * technician, and row-level security is what stops a technician touching
   * someone else's booking. .select('id') is deliberate — an update matching
   * no rows returns no error, so without it a blocked write would read as
   * success and the booking would silently stay on the list.
   */
  async function runAction() {
    if (!pendingAction) return;

    const { booking, kind } = pendingAction;
    setActingId(booking.id);
    setActionError(null);
    setActionNotice(null);

    const payload: Record<string, unknown> =
      kind === 'complete'
        ? { status: 'completed', completed_at: new Date().toISOString() }
        : { status: 'no_show' };
``

    const { data, error } = await (supabase as any)
      .from('customer_bookings')
      .update(payload)
      .eq('id', booking.id)
      .select('id');

    setActingId(null);

    if (error) {
      setActionError(error.message);
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
        : 'Booking marked as a no-show.',
    );

    // Refetch so the finished booking drops off the list.
    await queryClient.invalidateQueries({
      queryKey: ['dashboard', 'technician', 'upcoming'],
    });
  }

  if (isPending) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No dashboard data available. Your account may not be linked to a
          technician record.
        </CardContent>
      </Card>
    );
  }

  const booking = data.next_booking;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My day</h1>
        <p className="text-sm text-muted-foreground">{formatDate(data.date)}</p>
      </div>

      {/* KPI cards */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          label="Today's jobs"
          value={data.today.total}
          hint={`${data.today.completed} completed`}
          icon={CalendarCheck}
        />
        <KpiCard
          label="Remaining today"
          value={data.today.remaining}
          hint={data.today.remaining === 0 ? 'All done' : 'Still to visit'}
          icon={Clock}
          accent="bg-amber-500/10 text-amber-600"
        />
        <KpiCard
          label="Jobs this week"
          value={data.week.total}
          hint={`${data.week.completed} completed`}
          icon={CalendarDays}
        />
        <KpiCard
          label="Lifetime installs"
          value={data.earnings.lifetime_installs}
          hint={`${formatMoney(data.earnings.current_period)} this period`}
          icon={HardHat}
        />
      </div>

      {/* Rating */}
      <Card>
        <CardContent className="flex items-center justify-between gap-4 p-5">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Rating</p>
            <p className="text-2xl font-semibold tabular-nums">
              {data.earnings.rating != null
                ? data.earnings.rating.toFixed(1)
                : '—'}
            </p>
          </div>
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <Star className="h-5 w-5" />
          </span>
        </CardContent>
      </Card>

      {/* Next booking */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Next booking</CardTitle>
        </CardHeader>

        <CardContent>
          {!booking ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No upcoming bookings.
            </p>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-base font-medium">
                  {booking.site_name || 'Scheduled visit'}
                </p>
                {booking.booking_ref && (
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Ref {booking.booking_ref}
                  </p>
                )}
              </div>

              {booking.address && (
                <div className="flex items-start gap-2 text-sm">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>{booking.address}</span>
                </div>
              )}

              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Unit
                  </dt>
                  <dd className="mt-1 font-medium">
                    {booking.unit_number || '-'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Time
                  </dt>
                  <dd className="mt-1 font-medium tabular-nums">
                    {formatTime(booking.local_start)} -{' '}
                    {formatTime(booking.local_end)}
                  </dd>
                </div>
              </dl>

              {booking.access_notes && (
                <div className="flex items-start gap-2 rounded border bg-muted/40 p-3 text-sm">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Access notes
                    </p>
                    <p className="mt-0.5">{booking.access_notes}</p>
                  </div>
                </div>
              )}

              {booking.special_comments && (
                <div className="flex items-start gap-2 rounded border bg-muted/40 p-3 text-sm">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Special comments
                    </p>
                    <p className="mt-0.5">{booking.special_comments}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upcoming bookings, next 90 days */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarRange className="h-4 w-4" />
            Upcoming bookings (next 90 days)
          </CardTitle>
        </CardHeader>

        {actionNotice && (
          <div className="mx-6 mb-2 rounded border bg-muted/40 p-2 text-sm">
            {actionNotice}
          </div>
        )}

        {actionError && (
          <div
            role="alert"
            className="mx-6 mb-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
          >
            {actionError}
          </div>
        )}

        <CardContent>
          {upcomingPending ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !upcoming || upcoming.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing scheduled in the next 90 days.
            </p>
          ) : (
            <>
              {/* Card list on small screens, where a seven-column table would crush */}
              <div className="space-y-3 lg:hidden">
                {upcoming.map((b) => (
                  <div
                    key={b.id}
                    className="rounded border p-3"
                  >
                    <p className="font-medium">
                      {b.site_name || 'Scheduled visit'}
                    </p>

                    {b.address && (
                      <div className="mt-1 flex items-start gap-2 text-sm text-muted-foreground">
                        <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{b.address}</span>
                      </div>
                    )}

                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                          Date
                        </dt>
                        <dd className="tabular-nums">
                          {formatDate(b.scheduled_date)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                          Time
                        </dt>
                        <dd className="tabular-nums">
                          {formatTime(b.local_start)} -{' '}
                          {formatTime(b.local_end)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                          Unit
                        </dt>
                        <dd>{b.unit_number || '-'}</dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                          Customer
                        </dt>
                        <dd>{b.customer_name || '-'}</dd>
                      </div>
                    </dl>

                    {b.phone_number && (
                      <a
                        href={'tel:' + b.phone_number}
                        className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
                      >
                        <Phone className="h-4 w-4" />
                        {b.phone_number}
                      </a>
                    )}

                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <Button
                        size="sm"
                        className="h-10 flex-1"
                        disabled={actingId === b.id}
                        onClick={() =>
                          setPendingAction({ booking: b, kind: 'complete' })
                        }
                      >
                        {actingId === b.id ? (
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
                        disabled={actingId === b.id}
                        onClick={() =>
                          setPendingAction({ booking: b, kind: 'no_show' })
                        }
                      >
                        <UserX className="mr-2 h-4 w-4" />
                        No Show
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Table on wider screens */}
              <div className="hidden overflow-x-auto rounded border lg:block">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 font-medium">Site</th>
                      <th className="px-3 py-2 font-medium">Address</th>
                      <th className="px-3 py-2 font-medium">Unit</th>
                      <th className="px-3 py-2 font-medium">Customer</th>
                      <th className="px-3 py-2 font-medium">Phone</th>
                      <th className="px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.map((b) => (
                      <tr
                        key={b.id}
                        className="border-t"
                      >
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                          {formatDate(b.scheduled_date)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                          {formatTime(b.local_start)} -{' '}
                          {formatTime(b.local_end)}
                        </td>
                        <td className="px-3 py-2">{b.site_name || '-'}</td>
                        <td className="px-3 py-2">{b.address || '-'}</td>
                        <td className="px-3 py-2">{b.unit_number || '-'}</td>
                        <td className="px-3 py-2">{b.customer_name || '-'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {b.phone_number ? (
                            <a
                              href={'tel:' + b.phone_number}
                              className="text-primary underline-offset-2 hover:underline"
                            >
                              {b.phone_number}
                            </a>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-2 whitespace-nowrap">
                            <Button
                              size="sm"
                              disabled={actingId === b.id}
                              onClick={() =>
                                setPendingAction({ booking: b, kind: 'complete' })
                              }
                            >
                              {actingId === b.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                'Install Complete'
                              )}
                            </Button>

                            <Button
                              size="sm"
                              variant="outline"
                              disabled={actingId === b.id}
                              onClick={() =>
                                setPendingAction({ booking: b, kind: 'no_show' })
                              }
                            >
                              No Show
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Confirmation for the two booking actions */}
      {pendingAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-action-title"
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
              <h2 id="confirm-action-title" className="text-lg font-semibold">
                {pendingAction.kind === 'complete'
                  ? 'Mark as installed?'
                  : 'Mark as a no-show?'}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {pendingAction.booking.customer_name || 'This customer'}
                {pendingAction.booking.unit_number
                  ? ' \u00b7 Unit ' + pendingAction.booking.unit_number
                  : ''}
              </p>
              <p className="text-sm text-muted-foreground">
                {formatDate(pendingAction.booking.scheduled_date)} \u00b7{' '}
                {formatTime(pendingAction.booking.local_start)} -{' '}
                {formatTime(pendingAction.booking.local_end)}
              </p>
            </div>

            <p className="text-sm">
              {pendingAction.kind === 'complete'
                ? 'This marks the installation complete and removes it from your upcoming bookings.'
                : 'This records that nobody was on site and removes it from your upcoming bookings.'}
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
                  'Mark no-show'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { company, hasPermission, hasRole } = useAuth();

  // Technicians have their own view. Placed before the summary query so a
  // technician never fires dashboard_summary(), which aggregates at company
  // level and would read as zeros against their own assignments.
  if (hasRole('technician')) {
    return <TechnicianDashboardView />;
  }

  const { data, isPending } = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: async () => {
      // dashboard_summary() is a SECURITY DEFINER RPC from Phase 5. It
      // resolves the tenant server-side, so no company_id is passed.
      const response = await supabase.rpc('dashboard_summary');
      return unwrap(response) as unknown as DashboardSummary;
    },
    refetchInterval: 60_000,
  });

  // Booking rows drive two cards: Active jobs (latest booking date per job is
  // today or later) and Bookings today (the booking's own date is today).
  // dashboard_summary() carries no booking dates, so both are derived here.
  const { data: bookingStats } = useQuery({
    queryKey: ['dashboard', 'booking-stats'],
    queryFn: async () => {
      const { data: rows, error: rowsError } = await (supabase as any)
        .from('customer_bookings')
        .select('job_id, status, scheduled_date, job_slots ( slot_date )')
        .is('deleted_at', null)
        .neq('status', 'cancelled');

      if (rowsError) throw rowsError;

      // Each booking's own date. scheduled_date is null on rows written by the
      // old booking_create(), so the slot date is the fallback.
      const dated = ((rows ?? []) as any[])
        .map((r) => ({
          job_id: r.job_id as string | null,
          status: (r.status ?? null) as string | null,
          date: (r.scheduled_date ?? r.job_slots?.slot_date ?? null) as
            | string
            | null,
        }))
        .filter((r) => r.date !== null) as {
        job_id: string | null;
        status: string | null;
        date: string;
      }[];

      const today = localToday();

      // Active jobs: latest booking date per job, kept while today or later.
      const latest = new Map<string, string>();
      for (const r of dated) {
        if (!r.job_id) continue;
        const current = latest.get(r.job_id);
        if (!current || r.date > current) latest.set(r.job_id, r.date);
      }
      let active = 0;
      for (const date of latest.values()) {
        if (date >= today) active += 1;
      }

      // Today's bookings, counted from the booking's own date.
      const todayBookings = dated.filter((r) => r.date === today);

      return {
        active,
        today: todayBookings.length,
        // Confirmed and still awaiting an install.
        awaiting: todayBookings.filter(
  (r) => r.status === 'confirmed',
).length,
      };
    },
    refetchInterval: 60_000,
  });

  if (isPending) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No dashboard data available.
        </CardContent>
      </Card>
    );
  }

  const summary = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {company?.legal_name ?? 'Your workspace'}
          </p>
        </div>

        <div className="flex gap-2">
          {hasPermission('jobs.write') && (
            <Button onClick={() => navigate('/jobs/new')}>
              <Plus className="mr-2 h-4 w-4" />
              New job
            </Button>
          )}
          {hasPermission('invoices.write') && (
            <Button variant="outline" onClick={() => navigate('/invoices')}>
              <DollarSign className="mr-2 h-4 w-4" />
              Pay runs
            </Button>
          )}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Active jobs"
          value={bookingStats?.active ?? 0}
          hint="Bookings today or later"
          icon={Building2}
        />
        <KpiCard
          label="Bookings today"
          value={bookingStats?.today ?? 0}
          hint={`${bookingStats?.awaiting ?? 0} confirmed awaiting install`}
          icon={CalendarCheck}
        />

<KpiCard
  label="QR conversion"
  value={`${summary.qr.conversion_rate}%`}
  hint={`${summary.qr.scans} scans · ${summary.qr.active} active codes`}
  icon={QrCode}
/>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Financial position */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Financial position</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Owed to technicians</p>
              <p className="text-xl font-semibold tabular-nums">
                {formatMoney(summary.invoices.payable_outstanding, company?.currency)}
              </p>
              <p className="text-xs text-muted-foreground">
                {summary.invoices.draft} draft invoices
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Owed by partners</p>
              <p className="text-xl font-semibold tabular-nums">
                {formatMoney(summary.invoices.receivable_outstanding, company?.currency)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Customer growth */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-baseline gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-2xl font-semibold tabular-nums">
                {summary.customers.total}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TrendingUp className="h-4 w-4" />
              <span>+{summary.customers.new} in the last 30 days</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Booking health */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Booking health — last 30 days</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {[
              { label: 'Created', value: summary.bookings.total },
              { label: 'Confirmed', value: summary.bookings.confirmed },
              { label: 'Completed', value: summary.bookings.completed },
              { label: 'No-show', value: summary.bookings.no_show },
              {
                label: 'Completion rate',
                value:
                  summary.bookings.total === 0
                    ? '—'
                    : `${Math.round(
                        (summary.bookings.completed / summary.bookings.total) * 100,
                      )}%`,
              },
            ].map((stat) => (
              <div key={stat.label}>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {stat.label}
                </dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
