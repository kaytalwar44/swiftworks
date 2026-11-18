import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Mail, Plus, UserCog } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';
import { useAuth } from '@/features/auth/providers/auth-provider';
import { assignableRoles, ROLE_LABELS, type HierarchyRole } from '@/features/auth/hierarchy';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ExportButton } from '@/components/shared/export-button';

type ManagedUser = {
  id: string;
  full_name: string | null;
  email: string;
  status: string;
  role_code: HierarchyRole;
  can_manage: boolean;
  company_name: string;
  created_at: string | null;
  last_login: string | null;
};
type Snapshot = {
  actor_role: HierarchyRole;
  company_id: string;
  companies: { id: string; legal_name: string }[];
  users: ManagedUser[];
};

// New functions use the existing Supabase client. The generated schema has not
// been refreshed from production; keep this narrow RPC boundary explicit.
const rpc = (name: string, args: Record<string, unknown> = {}) =>
  (supabase as any).rpc(name, args);

function displayDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString('en-AU');
}

export default function Users() {
  const { user, company, refresh } = useAuth();
  const [selectedCompany, setSelectedCompany] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('technician');
  const [legalName, setLegalName] = useState('');
  const [slug, setSlug] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setSnapshot(null); // Never display the previous company's members while loading.
    const { data, error: failure } = await rpc('hierarchy_snapshot', {
      p_company_id: selectedCompany || null,
    });
    if (failure) setError(failure.message);
    else setSnapshot(data as Snapshot);
    setLoading(false);
  }, [selectedCompany]);

  useEffect(() => {
    let current = true;
    // Ignore stale responses after switching company or leaving this screen.
    setLoading(true);
    setError('');
    setSnapshot(null);
    void rpc('hierarchy_snapshot', { p_company_id: selectedCompany || null }).then(
      ({ data, error: failure }: { data: unknown; error: { message: string } | null }) => {
        if (!current) return;
        if (failure) setError(failure.message);
        else setSnapshot(data as Snapshot);
        setLoading(false);
      },
    );
    return () => { current = false; };
  }, [selectedCompany]);

  const choices = assignableRoles(snapshot?.actor_role ?? 'legacy');

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || !choices.includes(role as 'owner' | 'admin' | 'technician')) return;
    setBusy(true);
    setError('');
    setNotice('');
    const { data, error: failure } = await rpc('hierarchy_invite', {
      p_company_id: snapshot.company_id,
      p_email: email.trim().toLowerCase(),
      p_role_code: role,
    });
    const invitation = Array.isArray(data) ? data[0] : data;
    if (failure || !invitation?.token) {
      setError(failure?.message ?? 'The invitation could not be created.');
    } else {
      const { error: deliveryError } = await supabase.functions.invoke('send-invitation', {
        body: { token: invitation.token },
      });
      if (deliveryError) {
        setError('Invitation saved, but email delivery failed. Retry the invitation to resend it.');
      } else {
        setNotice(`Invitation sent to ${email.trim().toLowerCase()}.`);
        setEmail('');
      }
    }
    setBusy(false);
  }

  async function update(target: ManagedUser, nextRole: string | null, status: string | null) {
    setBusy(true);
    setError('');
    setNotice('');
    const { error: failure } = await rpc('hierarchy_set_user', {
      p_user_id: target.id, p_role_code: nextRole, p_status: status,
    });
    if (failure) setError(failure.message);
    else {
      setNotice('User access updated.');
      await load();
      await refresh();
    }
    setBusy(false);
  }

  async function createCompany(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const { data, error: failure } = await rpc('hierarchy_create_company', {
      p_legal_name: legalName.trim(), p_slug: slug.trim(),
    });
    if (failure) setError(failure.message);
    else {
      setLegalName('');
      setSlug('');
      setSelectedCompany(String(data));
      setRole('owner');
      setNotice('Company created. Invite its Super Admin below.');
    }
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage company access. Customer booking does not require an account.
        </p>
      </div>
      {error && <p role="alert" className="rounded border border-destructive/30 p-3 text-sm">{error}</p>}
      {notice && <p role="status" className="rounded border p-3 text-sm">{notice}</p>}
      {loading && <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading users" />}
      {snapshot?.actor_role === 'ultra_admin' && (
        <Card>
          <CardHeader><CardTitle>Customer companies</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <label className="block text-sm">Company
              <select className="mt-1 block w-full rounded border bg-background p-2"
                value={snapshot.company_id} disabled={busy}
                onChange={(event) => { setSelectedCompany(event.target.value); setNotice(''); }}>
                {snapshot.companies.map((item) => <option key={item.id} value={item.id}>{item.legal_name}</option>)}
              </select>
            </label>
            <form onSubmit={createCompany} className="flex flex-wrap items-end gap-3">
              <label className="text-sm">New company name
                <input required value={legalName} onChange={(event) => setLegalName(event.target.value)}
                  className="mt-1 block rounded border bg-background p-2" disabled={busy} />
              </label>
              <label className="text-sm">Company slug
                <input required pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]" value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  className="mt-1 block rounded border bg-background p-2" disabled={busy} />
              </label>
              <Button disabled={busy}><Plus className="mr-2 h-4 w-4" />Create company</Button>
            </form>
          </CardContent>
        </Card>
      )}
      {snapshot && (
        <>
          <Card>
            <CardHeader><CardTitle>Invite a user</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                {snapshot.companies.find((item) => item.id === snapshot.company_id)?.legal_name ?? company?.legal_name}
                {' · '}{ROLE_LABELS[snapshot.actor_role]}
              </p>
              <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
                <label className="text-sm">Email
                  <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)}
                    className="mt-1 block rounded border bg-background p-2" disabled={busy} />
                </label>
                <label className="text-sm">Role
                  <select value={role} onChange={(event) => setRole(event.target.value)}
                    className="mt-1 block rounded border bg-background p-2" disabled={busy}>
                    {choices.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
                  </select>
                </label>
                <Button disabled={busy || !choices.length}><Mail className="mr-2 h-4 w-4" />Send invitation</Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><UserCog className="h-5 w-5" />Company users</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <ExportButton name="swiftworks-users" disabled={loading || busy}
                headers={['Name', 'Email', 'Company', 'Role', 'Status', 'Created Date', 'Last Login']}
                rows={snapshot.users.map((target) => [target.full_name, target.email, target.company_name,
                  ROLE_LABELS[target.role_code] ?? 'Review required',
                  target.status === 'active' ? 'Active' : 'Inactive',
                  target.created_at ?? '', target.last_login ?? 'Never'])} />
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b">{['Name', 'Email', 'Company', 'Role', 'Status', 'Created Date', 'Last Login', 'Access'].map((heading) => <th key={heading} className="p-2">{heading}</th>)}</tr></thead>
                <tbody>{snapshot.users.map((target) => {
                  const editable = target.can_manage && target.id !== user?.id;
                  return (
                    <tr key={target.id} className="border-b">
                      <td className="p-2">{target.full_name || '—'}</td>
                      <td className="p-2">{target.email}</td>
                      <td className="p-2">{target.company_name}</td>
                      <td className="p-2">{editable ? (
                        <select value={target.role_code} disabled={busy}
                          aria-label={`Role for ${target.email}`}
                          className="rounded border bg-background p-2"
                          onChange={(event) => void update(target, event.target.value, null)}>
                          {!choices.includes(target.role_code as 'owner' | 'admin' | 'technician') &&
                            <option value={target.role_code}>{ROLE_LABELS[target.role_code] ?? 'Review required'}</option>}
                          {choices.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
                        </select>
                      ) : ROLE_LABELS[target.role_code] ?? 'Review required'}</td>
                      <td className="p-2">{target.status === 'active' ? 'Active' : 'Inactive'}</td>
                      <td className="p-2">{displayDate(target.created_at, 'Unavailable')}</td>
                      <td className="p-2">{displayDate(target.last_login, 'Never')}</td>
                      <td className="p-2">{editable && (
                        <Button variant="outline" disabled={busy} onClick={() => void update(target, null, target.status === 'active' ? 'disabled' : 'active')}>
                          {target.status === 'active' ? 'Set inactive' : 'Set active'}
                        </Button>
                      )}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {!snapshot.users.length && <p className="mt-3 text-sm text-muted-foreground">No users yet. Send an invitation to get started.</p>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
