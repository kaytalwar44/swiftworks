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
};

export default function Bookings() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadBookings() {
      const { data, error } = await supabase
        .from('customer_bookings')
        .select(
          'id, booking_ref, status, full_name, phone, email, unit_number'
        )
        .order('booking_ref');

      if (!error && data) {
        setBookings(data);
      }

      setLoading(false);
    }

    loadBookings();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Bookings
        </h1>
        <p className="text-sm text-muted-foreground">
          Customer booking management
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-5 w-5" />

            <div>
              <p className="text-sm text-muted-foreground">
                Total Bookings
              </p>

              <p className="text-3xl font-bold">
                {bookings.length}
              </p>
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
                <div
                  key={booking.id}
                  className="rounded border p-4"
                >
                  <div className="font-medium">
                    {booking.full_name || 'Unknown Customer'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Ref: {booking.booking_ref || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
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