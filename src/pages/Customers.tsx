import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Customer = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  unit_number: string | null;
};

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadCustomers() {
      const { data, error } = await supabase
        .from('customers')
        .select('id, full_name, email, phone, unit_number')
        .order('full_name');

      if (!error && data) {
        setCustomers(data);
      }

      setLoading(false);
    }

    loadCustomers();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Customers
        </h1>
        <p className="text-sm text-muted-foreground">
          Customer directory
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5" />
            <div>
              <p className="text-sm text-muted-foreground">
                Total Customers
              </p>
              <p className="text-3xl font-bold">
                {customers.length}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customer List</CardTitle>
        </CardHeader>

        <CardContent>
          {loading ? (
            <p>Loading customers...</p>
          ) : customers.length === 0 ? (
            <p>No customers found.</p>
          ) : (
            <div className="space-y-3">
              {customers.map((customer) => (
                <div
                  key={customer.id}
                  className="rounded border p-4"
                >
                  <div className="font-medium">
                    {customer.full_name || 'Unknown'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    {customer.email || 'No email'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    {customer.phone || 'No phone'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Unit: {customer.unit_number || '-'}
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