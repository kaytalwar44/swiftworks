import { useNavigate } from 'react-router';
import { Receipt } from 'lucide-react';

import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function RateCards() {
  const navigate = useNavigate();
  const { company } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Rate cards</h1>
        <p className="text-sm text-muted-foreground">
          Version-dated pricing per technician
          {company?.legal_name ? ` · ${company.legal_name}` : ''}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {['Active cards', 'Line items', 'Imported this month', 'Expiring'].map(
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
                  <Receipt className="h-5 w-5" />
                </span>
              </CardContent>
            </Card>
          ),
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rate card library</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm font-medium">Coming soon</p>
          <p className="text-sm text-muted-foreground">
            CSV and XLSX import with a column-mapping step, because real rate
            cards arrive in whatever shape the partner accountant made. Cards are
            version-dated — an invoice always reprices to the card effective on
            the job date.
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
