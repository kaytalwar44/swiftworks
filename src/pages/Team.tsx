import { useNavigate } from 'react-router';
import { ShieldCheck } from 'lucide-react';

import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Team() {
  const navigate = useNavigate();
  const { company } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">
          Users, roles and permissions
          {company?.legal_name ? ` · ${company.legal_name}` : ''}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {['Active users', 'Invited', 'Roles', 'Platform admins'].map((label) => (
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
                <ShieldCheck className="h-5 w-5" />
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">User directory</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm font-medium">Coming soon</p>
          <p className="text-sm text-muted-foreground">
            Invite, revoke and role assignment. The{' '}
            <code>invite_user</code>, <code>revoke_invitation</code> and{' '}
            <code>accept_invitation</code> RPCs are deployed — signup is
            invitation-only by design, so there is no self-serve registration.
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
