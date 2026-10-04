import { useCallback, useEffect, useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  ChevronUp,
  HardHat,
  Loader2,
  MapPin,
  Phone,
} from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
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
  const [jobs, setJobs] = useState<PortalJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [bookings, setBookings] = useState<Record<string, PortalBooking[]>>({});
  const [bookingsLoadingId, setBookingsLoadingId] = useState<string | null>(null);
  const [bookingsError, setBookingsError] = useState<string | null>(null);

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

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <HardHat className="h-6 w-6" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">My Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Jobs assigned to you
          </p>
        </div>
      </div>

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
    </div>
  );
}
