import { useNavigate } from 'react-router';
import { FileText } from 'lucide-react';

import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Invoices() {
  const navigate = useNavigate();
  const { company } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
        <p className="text-sm text-muted-foreground">
          Technician pay runs and partner billing
          {company?.legal_name ? ` · ${company.legal_name}` : ''}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {['Draft', 'Owed to technicians', 'Owed by partners', 'Overdue'].map(
          (label) => (
            <Card key={label}>
              <CardContent className="flex items-start justify-between gap-4 p-5">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p className="text-2xl font-semibold tabular-nums text-muted-foreground">
                    —
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Not yet wired up
                  </p>
                </div>
                <span className="rounded-lg bg-primary/10 p-2 text-primary">
                  <FileText className="h-5 w-5" />
                </span>
              </CardContent>
            </Card>
          ),
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoice register</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm font-medium">Coming soon</p>
          <p className="text-sm text-muted-foreground">
            Both directions — payable to technicians, receivable from partners —
            with the pay-run builder that prices completed bookings from the
            effective rate card. <code>build_pay_run</code> and{' '}
            <code>finalize_invoice</code> are deployed.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/dashboard')}
          >
            Back to dashboard
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
