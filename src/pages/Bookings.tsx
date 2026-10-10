import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Booking = {
  id: string;
  site_address: string | null;
  booking_ref: string | null;
  status: string | null;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  unit_number: string | null;
  equipment_serial: string | null;
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
    address: string | null;
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

/**
 * Colours per booking status. Deliberately a plain map rather than a Badge
 * variant: the values come from the database, and an unknown one has to fall
 * through to a neutral chip rather than render nothing.
 */
const STATUS_STYLES: Record<
  string,
  { label: string; className: string }
> = {
  confirmed: {
    label: 'Confirmed',
    className: 'bg-blue-100 text-blue-800 ring-blue-600/20',
  },
  completed: {
    label: 'Completed',
    className: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20',
  },
  customer_refused: {
    label: 'Customer Refused',
    className: 'bg-red-100 text-red-800 ring-red-600/20',
  },
  no_show: {
    label: 'Customer Not At Home',
    className: 'bg-amber-100 text-amber-900 ring-amber-600/20',
  },
  rescheduled: {
    label: 'Rescheduled',
    className: 'bg-violet-100 text-violet-800 ring-violet-600/20',
  },
};

function statusStyle(status: string | null) {
  const key = String(status ?? '').trim();
  return (
    STATUS_STYLES[key] ?? {
      label: key === '' ? '-' : key.replace(/_/g, ' '),
      className: 'bg-muted text-muted-foreground ring-border',
    }
  );
}

export default function Bookings() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadBookings() {
      const { data, error } = await (supabase as any)
        .from('customer_bookings')
        .select(
          'id, booking_ref, status, full_name, phone, email, unit_number, equipment_serial, slot_id, job_id, ' +
            'job_slots ( slot_date, local_start, local_end ), ' +
            'jobs ( title, job_number, address )',
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

  // Earliest booking first. Sorted on the joined slot's date and local start
  // rather than server-side, because PostgREST orders on the parent table and
  // cannot order by an embedded resource's columns. Rows with no slot fall to
  // the end so they do not push real bookings down the list.
  const sortedBookings = [...bookings].sort((a, b) => {
    const dateA = a.job_slots?.slot_date ?? '';
    const dateB = b.job_slots?.slot_date ?? '';

    if (dateA !== dateB) {
      if (!dateA) return 1;
      if (!dateB) return -1;
      return dateA < dateB ? -1 : 1;
    }

    const startA = a.job_slots?.local_start ?? '';
    const startB = b.job_slots?.local_start ?? '';

    if (startA === startB) return 0;
    if (!startA) return 1;
    if (!startB) return -1;
    return startA < startB ? -1 : 1;
  });

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
                    <th className="px-3 py-2 font-medium">Job Number</th>
                    <th className="px-3 py-2 font-medium">Site Address</th>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Phone Number</th>
                    <th className="px-3 py-2 font-medium">Email Address</th>
                    <th className="px-3 py-2 font-medium">Unit</th>
                    <th className="px-3 py-2 font-medium">Date &amp; Time</th>
                    <th className="px-3 py-2 font-medium">Serial Number</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedBookings.map((booking) => (
                    <tr key={booking.id} className="border-t align-top">
                      <td className="px-3 py-2 whitespace-nowrap font-medium">
                        {booking.jobs?.job_number || '-'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {booking.site_address ||
                          booking.jobs?.address ||
                          booking.jobs?.title ||
                          '-'}
                      </td>
                      <td className="px-3 py-2 font-medium">
                        {booking.full_name || 'Unknown Customer'}
                      </td>
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
                      <td className="px-3 py-2 text-muted-foreground">
                        {booking.email || '-'}
                      </td>
                      <td className="px-3 py-2">{booking.unit_number || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {formatBookingDate(booking.job_slots?.slot_date ?? null)}
                        <span className="ml-1 text-muted-foreground">
                          {formatTimeRange(
                            booking.job_slots?.local_start ?? null,
                            booking.job_slots?.local_end ?? null,
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {booking.equipment_serial || '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {(() => {
                          const status = statusStyle(booking.status);
                          return (
                            <span
                              className={
                                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                                status.className
                              }
                            >
                              {status.label}
                            </span>
                          );
                        })()}
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
