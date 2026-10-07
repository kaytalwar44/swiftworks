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
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Address</th>
                    <th className="px-3 py-2 font-medium">Date / Time</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Unit</th>
                    <th className="px-3 py-2 font-medium">Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((booking) => (
                    <tr key={booking.id} className="border-t align-top">
                      <td className="px-3 py-2 font-medium">
                        {booking.full_name || 'Unknown Customer'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {booking.jobs?.title || booking.jobs?.job_number || '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {formatBookingDate(booking.job_slots?.slot_date ?? null)}
                        <span className="ml-1 text-muted-foreground">
                          {formatTimeRange(
                            booking.job_slots?.local_start ?? null,
                            booking.job_slots?.local_end ?? null,
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {booking.email || '-'}
                      </td>
                      <td className="px-3 py-2">{booking.unit_number || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {booking.phone ? (
                          <a
                            href={'tel:' + booking.phone}
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            {booking.phone}
                          </a>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
