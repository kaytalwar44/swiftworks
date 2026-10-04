import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  HardHat,
  Loader2,
  Mail,
  Pencil,
  Plus,
  UserCheck,
  UserX,
} from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Technician = {
  id: string;
  company_id: string;
  partner_id: string | null;
  user_id: string | null;
  code: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  employment_type: string | null;
  skills: string[] | null;
  service_areas: string[] | null;
  max_installs_per_day: number | null;
  colour: string | null;
  is_available: boolean;
  rating: number | null;
  notes: string | null;
};

/** The fields this page edits. The rest of the row is left untouched. */
type TechnicianDraft = {
  code: string;
  full_name: string;
  email: string;
  phone: string;
  employment_type: string;
  skills: string;
  service_areas: string;
  max_installs_per_day: string;
  colour: string;
  notes: string;
};

const EMPTY_DRAFT: TechnicianDraft = {
  code: '',
  full_name: '',
  email: '',
  phone: '',
  employment_type: '',
  skills: '',
  service_areas: '',
  max_installs_per_day: '',
  colour: '',
  notes: '',
};

function toDraft(t: Technician): TechnicianDraft {
  return {
    code: t.code ?? '',
    full_name: t.full_name ?? '',
    email: t.email ?? '',
    phone: t.phone ?? '',
    employment_type: t.employment_type ?? '',
    skills: (t.skills ?? []).join(', '),
    service_areas: (t.service_areas ?? []).join(', '),
    max_installs_per_day:
      t.max_installs_per_day === null ? '' : String(t.max_installs_per_day),
    colour: t.colour ?? '',
    notes: t.notes ?? '',
  };
}

/** "a, b ,c" -> ["a","b","c"] ; "" -> null so the column stays NULL not '{}'. */
function parseList(value: string): string[] | null {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

export default function Technicians() {
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [companyId, setCompanyId] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Technician | null>(null);
  const [draft, setDraft] = useState<TechnicianDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { data, error: loadErr } = await (supabase as any)
      .from('technicians')
      .select(
        'id, company_id, partner_id, user_id, code, full_name, email, phone, employment_type, skills, service_areas, max_installs_per_day, colour, is_available, rating, notes',
      )
      .is('deleted_at', null)
      .order('full_name');

    if (loadErr) {
      setError(loadErr.message);
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as Technician[];
    setTechnicians(rows);
    if (rows.length > 0) setCompanyId(rows[0].company_id);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * company_id is required on insert and is not part of the form, so it is read
   * from the caller's own profile row — users_self_read allows this.
   */
  const resolveCompanyId = useCallback(async (): Promise<string | null> => {
    if (companyId) return companyId;

    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) return null;

    const { data: profile } = await (supabase as any)
      .from('users')
      .select('company_id')
      .eq('id', authData.user.id)
      .maybeSingle();

    const id =
      (profile as { company_id: string | null } | null)?.company_id ?? null;

    if (id) setCompanyId(id);
    return id;
  }, [companyId]);

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDialogOpen(true);
  }

  function openEdit(t: Technician) {
    setEditing(t);
    setDraft(toDraft(t));
    setSaveError(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditing(null);
    setSaving(false);
    setSaveError(null);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaveError(null);

    const fullName = draft.full_name.trim();

    if (!fullName) {
      setSaveError('Full name is required.');
      return;
    }

    const email = draft.email.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSaveError('Please enter a valid email address.');
      return;
    }

    const maxInstalls = draft.max_installs_per_day.trim();
    if (maxInstalls && !/^\d+$/.test(maxInstalls)) {
      setSaveError('Max installs per day must be a whole number.');
      return;
    }

    setSaving(true);

    const payload = {
      code: draft.code.trim() || null,
      full_name: fullName,
      email: email || null,
      phone: draft.phone.trim() || null,
      employment_type: draft.employment_type.trim() || null,
      skills: parseList(draft.skills),
      service_areas: parseList(draft.service_areas),
      max_installs_per_day: maxInstalls ? Number(maxInstalls) : null,
      colour: draft.colour.trim() || null,
      notes: draft.notes.trim() || null,
    };

    if (editing) {
      const { data, error: updErr } = await (supabase as any)
        .from('technicians')
        .update(payload)
        .eq('id', editing.id)
        .select('id');

      setSaving(false);

      if (updErr) {
        setSaveError(updErr.message);
        return;
      }

      // A write filtered out by RLS returns no error and no rows.
      if ((data ?? []).length === 0) {
        setSaveError(
          'The technician was not saved. It may be blocked by a permissions rule.',
        );
        return;
      }

      closeDialog();
      setNotice('Technician updated.');
      await load();
      return;
    }

    const targetCompanyId = await resolveCompanyId();

    if (!targetCompanyId) {
      setSaving(false);
      setSaveError('Could not determine your company. Try reloading the page.');
      return;
    }

    const { data, error: insErr } = await (supabase as any)
      .from('technicians')
      .insert([{ ...payload, company_id: targetCompanyId, is_available: true }])
      .select('id');

    setSaving(false);

    if (insErr) {
      setSaveError(insErr.message);
      return;
    }

    if ((data ?? []).length === 0) {
      setSaveError(
        'The technician was not added. It may be blocked by a permissions rule.',
      );
      return;
    }

    closeDialog();
    setNotice('Technician added.');
    await load();
  }

  /**
   * Issues a technician invitation through the existing invite_user() RPC.
   *
   * The technician role id is the confirmed id for this tenant. p_partner_id and
   * p_member_type are sent explicitly to match the current invitation contract.
   *
   * Reuses busyId to prevent a double submit and notice to report the outcome.
   */
  async function sendInvite(t: Technician) {
    setBusyId(t.id);
    setNotice(null);

    if (!t.email) {
      setBusyId(null);
      setNotice('This technician has no email address.');
      return;
    }

    const { data, error: rpcError } = await (supabase as any).rpc('invite_user', {
      p_email: t.email.trim().toLowerCase(),
      p_role_id: '5f2749c9-b1ce-4a07-8fd4-a0b935c8ba21',
      p_partner_id: null,
      p_member_type: 'staff',
      p_expires_days: 14,
    });

    setBusyId(null);

    if (rpcError) {
      // invite_user raises named errors; translate the ones a user can act on.
      const msg = String(rpcError.message || '');
      if (msg.includes('user_already_exists')) {
        setNotice('That email already belongs to a user in this company.');
        return;
      }
      if (msg.includes('insufficient_privilege')) {
        setNotice('You do not have permission to invite users.');
        return;
      }
      if (msg.includes('invalid_email')) {
        setNotice('That email address is not valid.');
        return;
      }
      if (msg.includes('no_tenant_context')) {
        setNotice('No company context found for your account.');
        return;
      }
      setNotice(msg || 'The invitation could not be sent.');
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    setNotice(
      row?.is_resend
        ? 'Invitation resent to ' + t.email + '.'
        : 'Invitation sent to ' + t.email + '.',
    );
    await load();
  }

  async function toggleAvailability(t: Technician) {
    const next = !t.is_available;
    setBusyId(t.id);
    setNotice(null);

    const { data, error: updErr } = await (supabase as any)
      .from('technicians')
      .update({ is_available: next })
      .eq('id', t.id)
      .select('id');

    setBusyId(null);

    if (updErr) {
      setNotice(updErr.message);
      return;
    }

    if ((data ?? []).length === 0) {
      setNotice(
        'Availability was not changed. It may be blocked by a permissions rule.',
      );
      return;
    }

    setNotice(
      next ? 'Technician marked available.' : 'Technician marked unavailable.',
    );
    await load();
  }


  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Technicians</h1>
          <p className="text-sm text-muted-foreground">
            Field staff performing installations
          </p>
        </div>

        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Add Technician
        </Button>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <HardHat className="h-5 w-5" />

            <div>
              <p className="text-sm text-muted-foreground">
                Total Technicians
              </p>

              <p className="text-3xl font-bold">{technicians.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Technician Directory</CardTitle>
        </CardHeader>

        <CardContent>
          {notice && (
            <p className="mb-4 rounded border bg-muted/40 p-3 text-sm">
              {notice}
            </p>
          )}

          {loading ? (
            <p>Loading technicians...</p>
          ) : error ? (
            <p
              role="alert"
              className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : technicians.length === 0 ? (
            <p>No technicians found.</p>
          ) : (
            <div className="space-y-3">
              {technicians.map((tech) => (
                <div key={tech.id} className="rounded border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 font-medium">
                        {tech.colour && (
                          <span
                            className="inline-block h-3 w-3 rounded-full border"
                            style={{ backgroundColor: tech.colour }}
                            aria-hidden="true"
                          />
                        )}
                        {tech.full_name || 'Unknown'}
                        {!tech.is_available && (
                          <span className="rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                            Unavailable
                          </span>
                        )}
                      </div>

                      <div className="text-sm text-muted-foreground">
                        {tech.code ? 'Code: ' + tech.code : 'No code'}
                      </div>

                      <div className="text-sm text-muted-foreground">
                        {tech.email || 'No email'}
                      </div>

                      <div className="text-sm text-muted-foreground">
                        {tech.phone || 'No phone'}
                      </div>

                      <div className="text-sm text-muted-foreground">
                        Employment: {tech.employment_type || '-'}
                      </div>

                      <div className="text-sm text-muted-foreground">
                        Max installs/day: {tech.max_installs_per_day ?? '-'}
                      </div>

                      {tech.skills && tech.skills.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {tech.skills.map((s) => (
                            <span
                              key={s}
                              className="rounded bg-muted px-2 py-0.5 text-xs"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(tech)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </Button>

                      {!tech.user_id && tech.email && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === tech.id}
                          onClick={() => sendInvite(tech)}
                        >
                          {busyId === tech.id ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Sending...
                            </>
                          ) : (
                            <>
                              <Mail className="mr-2 h-4 w-4" />
                              Send Invite
                            </>
                          )}
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === tech.id}
                        onClick={() => toggleAvailability(tech)}
                      >
                        {busyId === tech.id ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Saving...
                          </>
                        ) : tech.is_available ? (
                          <>
                            <UserX className="mr-2 h-4 w-4" />
                            Set Unavailable
                          </>
                        ) : (
                          <>
                            <UserCheck className="mr-2 h-4 w-4" />
                            Set Available
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="technician-dialog-title"
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
            className="w-full max-w-2xl space-y-5 rounded-lg border bg-background p-6 shadow-xl"
          >
            <div>
              <h2
                id="technician-dialog-title"
                className="text-lg font-semibold"
              >
                {editing ? 'Edit Technician' : 'Add Technician'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {editing ? editing.full_name || 'Technician' : 'Field staff details'}
              </p>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Identity</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  className="rounded border p-2"
                  placeholder="Code"
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                />
                <input
                  className="rounded border p-2"
                  placeholder="Full Name"
                  value={draft.full_name}
                  onChange={(e) =>
                    setDraft({ ...draft, full_name: e.target.value })
                  }
                  required
                />
                <input
                  type="email"
                  className="rounded border p-2"
                  placeholder="Email"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                />
                <input
                  type="tel"
                  className="rounded border p-2"
                  placeholder="Phone"
                  value={draft.phone}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                />
                <input
                  className="rounded border p-2"
                  placeholder="Employment Type"
                  value={draft.employment_type}
                  onChange={(e) =>
                    setDraft({ ...draft, employment_type: e.target.value })
                  }
                />
                <input
                  type="number"
                  min={0}
                  className="rounded border p-2"
                  placeholder="Max Installs / Day"
                  value={draft.max_installs_per_day}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      max_installs_per_day: e.target.value,
                    })
                  }
                />
                <label className="flex items-center gap-3 rounded border p-2 sm:col-span-2">
                  <span className="text-sm">Display colour</span>
                  <input
                    type="color"
                    className="h-8 w-14 cursor-pointer rounded border"
                    value={draft.colour || '#2563eb'}
                    onChange={(e) =>
                      setDraft({ ...draft, colour: e.target.value })
                    }
                  />
                  {draft.colour && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline"
                      onClick={() => setDraft({ ...draft, colour: '' })}
                    >
                      Clear
                    </button>
                  )}
                </label>
              </div>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Coverage</h3>
              <div className="grid gap-3">
                <input
                  className="rounded border p-2"
                  placeholder="Skills (comma separated)"
                  value={draft.skills}
                  onChange={(e) => setDraft({ ...draft, skills: e.target.value })}
                />
                <input
                  className="rounded border p-2"
                  placeholder="Service Areas (comma separated)"
                  value={draft.service_areas}
                  onChange={(e) =>
                    setDraft({ ...draft, service_areas: e.target.value })
                  }
                />
                <textarea
                  className="rounded border p-2"
                  rows={3}
                  placeholder="Notes"
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
              </div>
            </div>

            {saveError && (
              <p
                role="alert"
                className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {saveError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving
                  ? 'Saving...'
                  : editing
                    ? 'Save changes'
                    : 'Add technician'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
