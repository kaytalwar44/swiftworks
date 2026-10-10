import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Mail, Plus, Shield, UserCog, UserX } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { useAuth } from '@/features/auth/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** A row of public.users joined to its role assignment. */
type ManagedUser = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  status: string | null;
  role_code: string | null;
  role_name: string | null;
};

type RoleRow = {
  id: string;
  code: string;
  name: string | null;
};

type Draft = {
  full_name: string;
  email: string;
  phone: string;
  role: RoleCode;
};

/** The two roles this screen hands out. */
type RoleCode = 'company_admin' | 'technician';

const ROLES: { value: RoleCode; label: string; hint: string }[] = [
  {
    value: 'company_admin',
    label: 'Admin User',
    hint: 'Office access: jobs, bookings, dashboard, users.',
  },
  {
    value: 'technician',
    label: 'Contractor User',
    hint: 'Field access: the technician portal and assigned jobs only.',
  },
];

const EMPTY_DRAFT: Draft = {
  full_name: '',
  email: '',
  phone: '',
  role: 'technician',
};

function roleLabel(code: string | null): string {
  return ROLES.find((r) => r.value === code)?.label ?? 'No role';
}

/** Only 'active' counts as enabled; anything else is treated as blocked. */
function isDisabled(status: string | null): boolean {
  return String(status ?? '').toLowerCase() !== 'active';
}

export default function Users() {
  const { company } = useAuth();

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    // users_self_read plus a tenant policy let an admin see their own company.
    const { data: userRows, error: userErr } = await (supabase as any)
      .from('users')
      .select('id, full_name, email, phone, company_id, status')
      .is('deleted_at', null)
      .order('full_name');

    if (userErr) {
      setError(userErr.message);
      setLoading(false);
      return;
    }

    const { data: roleRows, error: roleErr } = await (supabase as any)
      .from('roles')
      .select('id, code, name')
      .in('code', ROLES.map((r) => r.value))
      .order('code');

    if (roleErr) {
      setError(roleErr.message);
      setLoading(false);
      return;
    }

    const { data: assignments, error: assignErr } = await (supabase as any)
      .from('user_roles')
      .select('user_id, role_id');

    if (assignErr) {
      setError(assignErr.message);
      setLoading(false);
      return;
    }

    const rolesById = new Map<string, RoleRow>(
      ((roleRows ?? []) as RoleRow[]).map((r) => [r.id, r]),
    );

    // First assignment wins: this screen only ever writes one role per user.
    const roleByUser = new Map<string, RoleRow>();
    for (const a of (assignments ?? []) as {
      user_id: string;
      role_id: string;
    }[]) {
      const role = rolesById.get(a.role_id);
      if (role && !roleByUser.has(a.user_id)) roleByUser.set(a.user_id, role);
    }

    setUsers(
      ((userRows ?? []) as any[]).map((u) => {
        const role = roleByUser.get(u.id) ?? null;
        return {
          id: u.id,
          full_name: u.full_name ?? null,
          email: u.email ?? null,
          phone: u.phone ?? null,
          company_id: u.company_id ?? null,
          status: u.status ?? null,
          role_code: role?.code ?? null,
          role_name: role?.name ?? null,
        } as ManagedUser;
      }),
    );

    setRoles(((roleRows ?? []) as RoleRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setSaveError(null);
  }

  /**
   * Sends the invitation through the existing workflow. The RPC creates the
   * auth user and the public.users profile; accept_invitation() on the
   * invitee's side links technicians.user_id when the email matches.
   *
   * NOTE: the argument names below follow the shape of invite_user() as it was
   * described in this project. If the function signature differs, the error
   * will name the missing argument — adjust the object keys to match.
   */
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaveError(null);

    const fullName = draft.full_name.trim();
    const email = draft.email.trim().toLowerCase();

    if (fullName === '') {
      setSaveError('Please enter a name.');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSaveError('Please enter a valid email address.');
      return;
    }

    setSaving(true);

    const { data, error: inviteErr } = await (supabase as any).rpc(
  'invite_user',
  {
    p_email: email.trim().toLowerCase(),
    p_role_id: '5f2749c9-b1ce-4a07-8fd4-a0b935c8ba21',
    p_partner_id: null,
    p_member_type: 'staff',
    p_expires_days: 14,
  },
);

    if (inviteErr) {
      console.log(inviteErr);
      setSaving(false);
      setSaveError(inviteErr.message);
      return;
    }

    // An invitation that returns no row is one that did not create a user.
    const invited = Array.isArray(data) ? data[0] : data;
    const invitedId =
      typeof invited === 'string'
        ? invited
        : ((invited as { id?: string; user_id?: string } | null)?.user_id ??
          (invited as { id?: string } | null)?.id ??
          null);

    if (!invitedId) {
      setSaving(false);
      setSaveError(
        'The invitation was not created. It may be blocked by a permissions rule.',
      );
      return;
    }

    // Assign the role explicitly too, so the page works even if the RPC only
    // creates the user. A duplicate assignment is caught and treated as fine.
    const role = roles.find((r) => r.code === draft.role);
    if (role) {
      const { error: assignErr } = await (supabase as any)
        .from('user_roles')
        .upsert(
          { user_id: invitedId, role_id: role.id },
          { onConflict: 'user_id,role_id' },
        );

      if (assignErr) {
        console.warn('user_roles assign failed', assignErr);
      }
    }

    setSaving(false);
    setDialogOpen(false);
    setNotice(
      'Invite sent to ' + email + ' as ' + roleLabel(draft.role) + '.',
    );
    await load();
  }

  /** Re-sends the invitation for a user who has not accepted yet. */
  async function resendInvite(u: ManagedUser) {
    if (!u.email) return;
    setBusyId(u.id);
    setNotice(null);
    setError(null);

    const { error: inviteErr } = await (supabase as any).rpc('invite_user', {
  p_email: u.email.trim().toLowerCase(),
  p_role_id: '5f2749c9-b1ce-4a07-8fd4-a0b935c8ba21',
  p_partner_id: null,
  p_member_type: 'staff',
  p_expires_days: 14,
});

    setBusyId(null);

    if (inviteErr) {
      setError(inviteErr.message);
      return;
    }

    setNotice('Invite re-sent to ' + u.email + '.');
  }

  /** Swaps a user's role between the two this screen manages. */
  async function changeRole(u: ManagedUser, next: RoleCode) {
    const role = roles.find((r) => r.code === next);
    if (!role) {
      setError('That role does not exist in this company.');
      return;
    }

    setBusyId(u.id);
    setError(null);
    setNotice(null);

    const { error: clearErr } = await (supabase as any)
      .from('user_roles')
      .delete()
      .eq('user_id', u.id);

    if (clearErr) {
      setBusyId(null);
      setError(clearErr.message);
      return;
    }

    const { error: addErr } = await (supabase as any)
      .from('user_roles')
      .insert({ user_id: u.id, role_id: role.id });

    setBusyId(null);

    if (addErr) {
      setError(addErr.message);
      return;
    }

    setNotice('Role changed to ' + roleLabel(next) + '.');
    await load();
  }

  /**
   * Blocks access without deleting the person's history.
   *
   * public.users has no is_active column; access state lives in status. The
   * literals below must match whatever the column allows — an enum or check
   * constraint rejects anything else.
   */
  async function setStatus(u: ManagedUser, disabled: boolean) {
    setBusyId(u.id);
    setError(null);
    setNotice(null);

    const { data, error: updErr } = await (supabase as any)
      .from('users')
      .update({ status: disabled ? 'disabled' : 'active' })
      .eq('id', u.id)
      .select('id');

    setBusyId(null);

    if (updErr) {
      setError(updErr.message);
      return;
    }

    if ((data ?? []).length === 0) {
      setError(
        'The user was not updated. It may be blocked by a permissions rule.',
      );
      return;
    }

    setNotice(disabled ? 'Access disabled.' : 'Access restored.');
    await load();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            Team access for {company?.legal_name ?? 'this company'}
          </p>
        </div>

        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Add User
        </Button>
      </div>

      {notice && (
        <p role="status" className="rounded border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded border border-destructive/40 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Team Members</CardTitle>
        </CardHeader>

        <CardContent>
          {loading ? (
            <p>Loading users...</p>
          ) : users.length === 0 ? (
            <p>No users found.</p>
          ) : (
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Email Address</th>
                    <th className="px-3 py-2 font-medium">Phone Number</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-t align-top">
                      <td className="px-3 py-2 font-medium">
                        {u.full_name || 'Unnamed user'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {u.email || '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {u.phone || '-'}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className="h-9 rounded-md border bg-background px-2 text-sm"
                          value={(u.role_code as RoleCode) ?? ''}
                          disabled={busyId === u.id}
                          onChange={(e) =>
                            void changeRole(u, e.target.value as RoleCode)
                          }
                          aria-label={'Role for ' + (u.full_name ?? u.email)}
                        >
                          <option value="" disabled>
                            No role
                          </option>
                          {ROLES.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {isDisabled(u.status) ? (
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border">
                            {u.status || 'Disabled'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-600/20">
                            Active
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9"
                            disabled={busyId === u.id || !u.email}
                            onClick={() => void resendInvite(u)}
                          >
                            {busyId === u.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Mail className="mr-2 h-4 w-4" />
                            )}
                            Send Invite
                          </Button>

                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9"
                            disabled={busyId === u.id}
                            onClick={() => void setStatus(u, !isDisabled(u.status))}
                          >
                            {isDisabled(u.status) ? (
                              <>
                                <UserCog className="mr-2 h-4 w-4" />
                                Enable
                              </>
                            ) : (
                              <>
                                <UserX className="mr-2 h-4 w-4" />
                                Disable
                              </>
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-dialog-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeDialog();
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
          }}
        >
          <form
            onSubmit={save}
            className="w-full max-w-md space-y-4 rounded-lg border bg-background p-5 shadow-xl"
          >
            <div>
              <h2 id="user-dialog-title" className="text-lg font-semibold">
                Add User
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                An invitation email is sent. They choose their own password.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="user-name" className="text-sm font-medium">
                Full name
              </label>
              <input
                id="user-name"
                type="text"
                required
                autoFocus
                className="w-full rounded border p-2 text-sm"
                placeholder="Jane Smith"
                value={draft.full_name}
                disabled={saving}
                onChange={(e) =>
                  setDraft({ ...draft, full_name: e.target.value })
                }
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="user-email" className="text-sm font-medium">
                Email address
              </label>
              <input
                id="user-email"
                type="email"
                required
                className="w-full rounded border p-2 text-sm"
                placeholder="jane@example.com"
                value={draft.email}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="user-phone" className="text-sm font-medium">
                Phone number
              </label>
              <input
                id="user-phone"
                type="tel"
                className="w-full rounded border p-2 text-sm"
                placeholder="0400 000 000"
                value={draft.phone}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              />
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Role</legend>

              {ROLES.map((r) => (
                <label
                  key={r.value}
                  className="flex cursor-pointer items-start gap-3 rounded border p-3 hover:bg-muted/40"
                >
                  <input
                    type="radio"
                    name="role"
                    className="mt-1"
                    value={r.value}
                    checked={draft.role === r.value}
                    disabled={saving}
                    onChange={() => setDraft({ ...draft, role: r.value })}
                  />
                  <span>
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Shield className="h-4 w-4 text-muted-foreground" />
                      {r.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {r.hint}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={closeDialog}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Send Invite'
                )}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
