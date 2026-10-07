import { useCallback, useEffect, useMemo, useState } from 'react';
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

/** One row from technician_upcoming_bookings(). */
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

/** Bookings grouped under the site they belong to. */
type PortalJob = {
  key: string;
  site_name: string | null;
  address: string | null;
  bookings: UpcomingBooking[];
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
  const [bookings, setBookings] = useState<UpcomingBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const loadBookings = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Resolves the calling technician server-side and returns their
    // non-finished bookings for the next 90 days, already date-ordered.
    const { data, error: rpcError } = await (supabase as any).rpc(
      'technician_upcoming_bookings',
    );

    if (rpcError) {
      console.error('technician_upcoming_bookings failed', rpcError);
      setError(rpcError.message);
      setLoading(false);
      return;
    }

    setBookings((data ?? []) as UpcomingBooking[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadBookings();
  }, [loadBookings]);

  // The RPC returns no job id, so a job card is the set of bookings sharing a
  // site and address. Insertion order is kept, so the job with the earliest
  // booking appears first.
  const jobs = useMemo<PortalJob[]>(() => {
    const map = new Map<string, PortalJob>();
    for (const b of bookings) {
      const key = (b.site_name ?? '') + '|' + (b.address ?? '');
      let job = map.get(key);
      if (!job) {
        job = {
          key,
          site_name: b.site_name,
          address: b.address,
          bookings: [],
        };
        map.set(key, job);
      }
      job.bookings.push(b);
    }
    return Array.from(map.values());
  }, [bookings]);

  function toggleBookings(key: string) {
    setOpenKey((current) => (current === key ? null : key));
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <HardHat className="h-6 w-6" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">My Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Upcoming work for the next 90 days
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
            No upcoming bookings are assigned to you.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const isOpen = openKey === job.key;
            const count = job.bookings.length;

            return (
              <Card key={job.key}>
                <CardContent className="space-y-3 p-4">
                  <div className="text-base font-semibold leading-tight">
                    {job.site_name || 'Scheduled site'}
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
                      {count} {count === 1 ? 'booking' : 'bookings'}
                    </span>
                  </div>

                  <Button
                    variant="outline"
                    className="h-11 w-full"
                    onClick={() => toggleBookings(job.key)}
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
                      {job.bookings.map((b) => (
                        <div
                          key={b.id}
                          className="rounded border bg-muted/30 p-3"
                        >
                          <div className="font-medium">
                            {b.customer_name || 'Unknown Customer'}
                          </div>

                          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                            <div>
                              <span className="text-muted-foreground">Date: </span>
                              {formatDate(b.scheduled_date)}
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

                          {b.phone_number ? (
                            <a
                              href={'tel:' + b.phone_number}
                              className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline"
                            >
                              <Phone className="h-4 w-4" />
                              {b.phone_number}
                            </a>
                          ) : (
                            <div className="mt-2 text-sm text-muted-foreground">
                              No phone
                            </div>
                          )}
                        </div>
                      ))}
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
