import { useNavigate } from 'react-router';
import { Building2, Plus } from 'lucide-react';

import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Jobs() {
  const navigate = useNavigate();
  const { company, hasPermission } = useAuth();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Installation campaigns across your partner sites
            {company?.legal_name ? ` · ${company.legal_name}` : ''}
          </p>
        </div>

        {hasPermission('jobs.write') && (
          <Button disabled>
            <Plus className="mr-2 h-4 w-4" />
            New job
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {['Draft', 'Published', 'In progress', 'Completed'].map((label) => (
          <Card key={label}>
            <CardContent className="flex items-start justify-between gap-4 p-5">
              <div className="min-w-0 space-y-1">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-semibold tabular-nums text-muted-foreground">
                  —
                </p>
                <p className="text-xs text-muted-foreground">Not yet wired up</p>
              </div>
              <span className="rounded-lg bg-primary/10 p-2 text-primary">
                <Building2 className="h-5 w-5" />
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job list</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm font-medium">Coming soon</p>
          <p className="text-sm text-muted-foreground">
            Job listing, slot generation and QR publishing land in the next
            build. The <code>jobs</code> table and the Phase 5 RPCs
            (<code>create_job</code>, <code>generate_slots</code>,{' '}
            <code>publish_job</code>) are already deployed and ready to wire in.
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
