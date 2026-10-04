import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Booking = {
  id: string;
  booking_ref: string | null;
  status: string | null;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  unit_number: string | null;
  slot_id: string | null;
  job_id: string | null;
  job_slots: {
    slot_date: string | null;
    local_start: string | null;
    local_end: string | null;
  } | null;
  jobs: {
    title: string | null;
    job_number: string | null;
  } | null;
};

/** 2026-10-05 -> 05 Oct 2026 */
function formatBookingDate(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value + 'T00:00:00');
  return d.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** 08:00:00 -> 08:00 */
function formatShortTime(value: string | null): string {
  return value ? value.slice(0, 5) : '';
}

/** 08:00:00, 12:00:00 -> 08:00 - 12:00 */
function formatTimeRange(start: string | null, end: string | null): string {
  if (!start && !end) return '-';
  if (start && end) {
    return formatShortTime(start) + ' - ' + formatShortTime(end);
  }
  return formatShortTime(start) || formatShortTime(end);
}

export default function Bookings() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadBookings() {
      const { data, error } = await (supabase as any)
        .from('customer_bookings')
        .select(
          'id, booking_ref, status, full_name, phone, email, unit_number, slot_id, job_id, ' +
            'job_slots ( slot_date, local_start, local_end ), ' +
            'jobs ( title, job_number )',
        )
        .order('booking_ref');

      if (error) {
        console.error(error);
      }

      if (!error && data) {
        setBookings(data as Booking[]);
      }

      setLoading(false);
    }

    loadBookings();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bookings</h1>
        <p className="text-sm text-muted-foreground">
          Customer booking management
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-5 w-5" />

            <div>
              <p className="text-sm text-muted-foreground">Total Bookings</p>

              <p className="text-3xl font-bold">{bookings.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Booking List</CardTitle>
        </CardHeader>

        <CardContent>
          {loading ? (
            <p>Loading bookings...</p>
          ) : bookings.length === 0 ? (
            <p>No bookings found.</p>
          ) : (
            <div className="space-y-3">
              {bookings.map((booking) => (
                <div key={booking.id} className="rounded border p-4">
                  <div className="font-medium">
                    {booking.full_name || 'Unknown Customer'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Ref: {booking.booking_ref || '-'}
                  </div>

                  <div className="mt-2">
                    <p className="text-sm font-medium text-muted-foreground">
                      Job
                    </p>
                    <p className="text-sm">
                      {booking.jobs?.title || booking.jobs?.job_number || '-'}
                    </p>
                  </div>

                  <div className="mt-2">
                    <p className="text-sm font-medium text-muted-foreground">
                      Date
                    </p>
                    <p className="text-sm tabular-nums">
                      {formatBookingDate(booking.job_slots?.slot_date ?? null)}
                    </p>
                  </div>

                  <div className="mt-2">
                    <p className="text-sm font-medium text-muted-foreground">
                      Time
                    </p>
                    <p className="text-sm tabular-nums">
                      {formatTimeRange(
                        booking.job_slots?.local_start ?? null,
                        booking.job_slots?.local_end ?? null,
                      )}
                    </p>
                  </div>

                  <div className="mt-2 text-sm text-muted-foreground">
                    Status: {booking.status || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Email: {booking.email || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Phone: {booking.phone || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Unit: {booking.unit_number || '-'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
