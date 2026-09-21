import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  Building2,
  CalendarCheck,
  CalendarDays,
  DollarSign,
  Loader2,
  Plus,
  QrCode,
  TrendingUp,
  Users,
} from 'lucide-react';
import { supabase, unwrap } from '@/lib/supabase/client';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

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

export default function Dashboard() {
  const navigate = useNavigate();
  const { company, hasPermission } = useAuth();

  const { data, isPending, error } = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: async () => {
      // dashboard_summary() is a SECURITY DEFINER RPC from Phase 5. It
      // resolves the tenant server-side, so no company_id is passed.
      const response = await supabase.rpc('dashboard_summary');
      return unwrap(response) as unknown as DashboardSummary;
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

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          Could not load the dashboard. {(error as Error).message}
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
          value={summary.jobs.published + summary.jobs.in_progress}
          hint={`${summary.jobs.total} total · ${summary.jobs.completed} complete`}
          icon={Building2}
        />
        <KpiCard
          label="Bookings today"
          value={summary.bookings.today}
          hint={`${summary.bookings.confirmed} confirmed awaiting install`}
          icon={CalendarCheck}
        />
        <KpiCard
          label="Open capacity"
          value={summary.slots.capacity}
          hint={`${summary.slots.open} open slots`}
          icon={CalendarDays}
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
