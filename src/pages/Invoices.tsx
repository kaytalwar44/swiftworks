import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Invoice = {
  id: string;
  invoice_number: string | null;
  direction: string | null;
  status: string | null;
  issue_date: string | null;
  period_start: string | null;
  period_end: string | null;
};

export default function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadInvoices() {
      const { data, error } = await supabase
        .from('invoices')
        .select(
          'id, invoice_number, direction, status, issue_date, period_start, period_end'
        )
        .order('issue_date', { ascending: false });

      if (!error && data) {
        setInvoices(data);
      }

      setLoading(false);
    }

    loadInvoices();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Invoices
        </h1>
        <p className="text-sm text-muted-foreground">
          Invoice and billing management
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5" />
            <div>
              <p className="text-sm text-muted-foreground">
                Total Invoices
              </p>
              <p className="text-3xl font-bold">
                {invoices.length}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoice List</CardTitle>
        </CardHeader>

        <CardContent>
          {loading ? (
            <p>Loading invoices...</p>
          ) : invoices.length === 0 ? (
            <p>No invoices found.</p>
          ) : (
            <div className="space-y-3">
              {invoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className="rounded border p-4"
                >
                  <div className="font-medium">
                    {invoice.invoice_number || 'No Number'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Direction: {invoice.direction || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Status: {invoice.status || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Issue Date: {invoice.issue_date || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Period Start: {invoice.period_start || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Period End: {invoice.period_end || '-'}
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