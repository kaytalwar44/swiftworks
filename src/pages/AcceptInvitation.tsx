import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link } from 'react-router';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Invitation = {
  email: string | null;
  company_name: string | null;
  company_slug: string | null;
  role_name: string | null;
  member_type: string | null;
  invited_at: string | null;
  expires_at: string | null;
  is_valid: boolean;
  reason: string | null;
};

/** Maps invitation_lookup's reason codes to something a person can act on. */
const REASON_TEXT: Record<string, string> = {
  already_accepted: 'This invitation has already been accepted. Try signing in instead.',
  revoked: 'This invitation has been revoked. Ask your administrator to send a new one.',
  expired: 'This invitation has expired. Ask your administrator to send a new one.',
};

/** 2026-10-18T04:00:00Z -> 18 Oct 2026 */
function formatExpiry(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  return d.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function AcceptInvitation() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const loadInvitation = useCallback(async () => {
    setLoading(true);
    setLookupError(null);

    if (!token) {
      setLookupError('This invitation link is incomplete.');
      setLoading(false);
      return;
    }

    const { data, error: rpcError } = await (supabase as any).rpc(
      'invitation_lookup',
      { p_token: token },
    );

    if (rpcError) {
      setLookupError(rpcError.message);
      setLoading(false);
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Invitation | undefined;

    if (!row) {
      setLookupError('This invitation link is not valid.');
      setLoading(false);
      return;
    }

    setInvitation(row);
    setLoading(false);
  }, [token]);

  useEffect(() => {
    void loadInvitation();
  }, [loadInvitation]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!invitation?.email) {
      setError('This invitation has no email address attached.');
      return;
    }

    if (password.length < 8) {
      setError('Please choose a password of at least 8 characters.');
      return;
    }

    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setSubmitting(true);

    const invitedEmail = invitation.email.trim().toLowerCase();

    // 1. Create the auth account. The email is taken from the invitation, not
    //    from a field the visitor could edit.
    const { error: signUpError } = await supabase.auth.signUp({
      email: invitedEmail,
      password,
    });

    if (signUpError) {
      // A pre-existing account is the common case on a re-sent invitation.
      if (signUpError.message.toLowerCase().includes('already registered')) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: invitedEmail,
          password,
        });

        if (signInError) {
          setSubmitting(false);
          setError(
            'An account already exists for this email. Sign in with your existing password, or ask for a new invitation.',
          );
          return;
        }
      } else {
        setSubmitting(false);
        setError(signUpError.message);
        return;
      }
    } else {
      // 2. Sign in immediately, so the session exists before accept_invitation
      //    runs. That function calls auth.uid() and needs a live session.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: invitedEmail,
        password,
      });

      if (signInError) {
        setSubmitting(false);
        setError(
          'Your account was created. Please check your email to confirm it, then sign in.',
        );
        return;
      }
    }

    // 3. Bind the invitation to this user and grant the role.
    const { error: acceptError } = await (supabase as any).rpc(
      'accept_invitation',
      { p_token: token },
    );

    setSubmitting(false);

    if (acceptError) {
      const msg = String(acceptError.message || '');
      if (msg.includes('email_mismatch')) {
        setError(
          'This invitation was issued to a different email address. Sign out and use the address it was sent to.',
        );
        return;
      }
      if (msg.includes('expired')) {
        setError('This invitation has expired.');
        return;
      }
      setError(msg || 'The invitation could not be accepted.');
      return;
    }

    setDone(true);

    // 4. Hand over to the app. A short pause lets the success state render
    //    rather than snapping straight to the dashboard.
    window.setTimeout(() => {
      navigate('/dashboard', { replace: true });
    }, 1200);
  }

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-md space-y-6">{children}</div>
    </div>
  );

  if (loading) {
    return shell(
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>,
    );
  }

  if (lookupError) {
    return shell(
      <div className="space-y-3 rounded-lg border bg-background p-6 text-center shadow-sm">
        <AlertCircle className="mx-auto h-8 w-8 text-destructive" />
        <h1 className="text-xl font-semibold tracking-tight">
          Invitation unavailable
        </h1>
        <p className="text-sm text-muted-foreground">{lookupError}</p>
        <Link
          to="/login"
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Go to sign in
        </Link>
      </div>,
    );
  }

  if (invitation && !invitation.is_valid) {
    return shell(
      <div className="space-y-3 rounded-lg border bg-background p-6 text-center shadow-sm">
        <AlertCircle className="mx-auto h-8 w-8 text-destructive" />
        <h1 className="text-xl font-semibold tracking-tight">
          Invitation unavailable
        </h1>
        <p className="text-sm text-muted-foreground">
          {REASON_TEXT[invitation.reason ?? ''] ||
            'This invitation can no longer be used.'}
        </p>
        <Link
          to="/login"
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Go to sign in
        </Link>
      </div>,
    );
  }

  if (done) {
    return shell(
      <div className="space-y-3 rounded-lg border bg-background p-6 text-center shadow-sm">
        <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" />
        <h1 className="text-xl font-semibold tracking-tight">You're in</h1>
        <p className="text-sm text-muted-foreground">
          Taking you to your dashboard...
        </p>
      </div>,
    );
  }

  return shell(
    <>
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">SwiftWorks</h1>
        <p className="text-sm text-muted-foreground">
          You have been invited to join
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-background p-6 shadow-sm">
        <div>
          <p className="text-lg font-medium">
            {invitation?.company_name || 'A SwiftWorks workspace'}
          </p>
          {invitation?.role_name && (
            <p className="text-sm text-muted-foreground">
              as {invitation.role_name}
            </p>
          )}
        </div>

        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="text-right font-medium break-all">
              {invitation?.email || '-'}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Expires</dt>
            <dd className="text-right font-medium">
              {formatExpiry(invitation?.expires_at ?? null)}
            </dd>
          </div>
        </dl>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-lg border bg-background p-6 shadow-sm"
      >
        <div className="space-y-1.5">
          <Label htmlFor="password">Choose a password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Setting up your account...
            </>
          ) : (
            'Accept invitation'
          )}
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          Use the email address this invitation was sent to.
        </p>
      </form>
    </>,
  );
}
