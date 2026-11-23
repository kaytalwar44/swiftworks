import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { useAuth } from '@/features/auth/providers/auth-provider';
import { supabase } from '@/lib/supabase/client';

type JobPartner = { id: string; company_id: string; name: string | null };
type PartnerOptions = {
  companyId: string;
  userId: string;
  rows: JobPartner[];
  error: string | null;
};

export default function JobCreatePage() {
  const navigate = useNavigate();
  const { authUser, user, company, isLoading: isAuthLoading, error: authError } = useAuth();
  const companyId =
    !isAuthLoading && !authError && authUser && user?.id === authUser.id &&
    user.company_id && company?.id === user.company_id
      ? user.company_id
      : null;
  const authUserId = authUser?.id ?? null;
  const [partnerOptions, setPartnerOptions] = useState<PartnerOptions | null>(null);
  const [selectedPartnerId, setSelectedPartnerId] = useState('');
  const currentPartnerOptions =
    partnerOptions?.companyId === companyId && partnerOptions?.userId === authUserId
      ? partnerOptions
      : null;
  const partners = currentPartnerOptions?.rows ?? [];
  const partnersLoading = !!companyId && !currentPartnerOptions;
  const partnerLoadError = currentPartnerOptions?.error ?? null;
  const selectedPartner = partners.find((partner) => partner.id === selectedPartnerId);

  useEffect(() => {
    let current = true;
    setPartnerOptions(null);
    setSelectedPartnerId('');
    if (!companyId || !authUserId) return;

    async function loadPartners(tenantId: string, userId: string) {
      try {
        const { data, error: failure } = await supabase
          .from('partners')
          .select('id, company_id, name')
          .eq('company_id', tenantId)
          .is('deleted_at', null)
          .order('name')
          .order('id');
        if (failure) throw failure;
        if (!current) return;
        // Keep the UI tenant-scoped even if a broader response is ever returned.
        const rows = ((data ?? []) as unknown as JobPartner[])
          .filter((partner) => partner.company_id === tenantId);
        setPartnerOptions({ companyId: tenantId, userId, rows, error: null });
        setSelectedPartnerId(rows[0]?.id ?? '');
      } catch {
        if (!current) return;
        setPartnerOptions({
          companyId: tenantId, userId, rows: [],
          error: 'Unable to load partners for your company. Please reload and try again.',
        });
      }
    }
    void loadPartners(companyId, authUserId);
    return () => { current = false; };
  }, [companyId, authUserId]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobNumber, setJobNumber] = useState('');
  const [title, setTitle] = useState('');
  const [reference, setReference] = useState('');
  const [priority, setPriority] = useState(2);
  const [unitCount, setUnitCount] = useState(16);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [siteName, setSiteName] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [suburb, setSuburb] = useState('');
  const [state, setState] = useState('');
  const [postcode, setPostcode] = useState('');

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Never submit with a missing tenant or a stale profile/company from another session.
    if (!companyId) {
      setError('Your company context is unavailable. Please sign in again before creating a job.');
      setLoading(false);
      return;
    }

    if (partnersLoading || partnerLoadError || !selectedPartner) {
      setError(partnerLoadError ?? (partnersLoading
        ? 'Wait for your company partners to finish loading.'
        : 'Select a partner belonging to your company. If none exists, create a company partner first.'));
      setLoading(false);
      return;
    }

    // jobs.start_date and end_date are NOT NULL with no default, so an insert
    // without them fails at the database even when the form looks complete.
    if (!startDate || !endDate) {
      setError('Start date and end date are required.');
      setLoading(false);
      return;
    }

    if (endDate < startDate) {
      setError('End date cannot be before the start date.');
      setLoading(false);
      return;
    }

    const { error: insertError } = await (supabase as any)
      .from('jobs')
      .insert([
        {
          company_id: companyId,
          partner_id: selectedPartner.id,

          job_number: jobNumber,
          title,
          reference,
          priority,

          site_name: siteName,
          address_line1: addressLine1,
          address_line2: addressLine2,
          suburb,
          state,
          postcode,

          unit_count: unitCount,

          start_date: startDate,
          end_date: endDate,
        },
      ]);

    setLoading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    navigate('/jobs');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Create Job</h1>
        <p className="text-muted-foreground">
          Create a new installation campaign
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-6 rounded-lg border p-6"
      >
        <div className="space-y-2">
          <label htmlFor="job-partner" className="block text-sm font-medium">
            Partner
          </label>
          <select
            id="job-partner"
            className="w-full rounded border p-2"
            value={selectedPartner?.id ?? ''}
            onChange={(event) => setSelectedPartnerId(event.target.value)}
            disabled={loading || !companyId || partnersLoading || !!partnerLoadError || partners.length === 0}
            required
          >
            <option value="" disabled>
              {partnersLoading ? 'Loading partners...' : 'Select a partner'}
            </option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name || 'Unnamed Partner'}
              </option>
            ))}
          </select>
          {partnerLoadError && <p role="alert" className="text-sm text-destructive">{partnerLoadError}</p>}
          {companyId && !partnersLoading && !partnerLoadError && partners.length === 0 && (
            <p role="alert" className="text-sm text-destructive">
              No partners exist for your company. Create a company partner before creating a job.
            </p>
          )}
        </div>

        <div>
          <h2 className="mb-4 text-lg font-semibold">Job Details</h2>

          <div className="grid gap-4 md:grid-cols-2">
            <input
              className="rounded border p-2"
              placeholder="Job Number"
              value={jobNumber}
              onChange={(e) => setJobNumber(e.target.value)}
            />

            <input
              className="rounded border p-2"
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            <input
              className="rounded border p-2"
              placeholder="Reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />

            <select
              className="rounded border p-2"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            >
              <option value={1}>Low</option>
              <option value={2}>Normal</option>
              <option value={3}>High</option>
              <option value={4}>Urgent</option>
            </select>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Units Per Day</span>
              <select
                className="rounded border p-2"
                value={unitCount}
                onChange={(e) => setUnitCount(Number(e.target.value))}
              >
                <option value={2}>2</option>
                <option value={4}>4</option>
                <option value={6}>6</option>
                <option value={8}>8</option>
                <option value={10}>10</option>
                <option value={12}>12</option>
                <option value={16}>16</option>
                <option value={18}>18</option>
                <option value={20}>20</option>
                <option value={22}>22</option>
                <option value={24}>24</option>
                <option value={26}>26</option>
                <option value={28}>28</option>
                <option value={30}>30</option>
              </select>
            </label>
          </div>
        </div>

        <div>
          <h2 className="mb-4 text-lg font-semibold">Schedule</h2>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Start Date</span>
              <input
                type="date"
                className="rounded border p-2"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">End Date</span>
              <input
                type="date"
                className="rounded border p-2"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                required
              />
            </label>
          </div>
        </div>

        <div>
          <h2 className="mb-4 text-lg font-semibold">Site Information</h2>

          <div className="grid gap-4">
            <input
              className="rounded border p-2"
              placeholder="Site Name"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
            />

            <input
              className="rounded border p-2"
              placeholder="Address Line 1"
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
            />

            <input
              className="rounded border p-2"
              placeholder="Address Line 2"
              value={addressLine2}
              onChange={(e) => setAddressLine2(e.target.value)}
            />

            <div className="grid gap-4 md:grid-cols-3">
              <input
                className="rounded border p-2"
                placeholder="Suburb"
                value={suburb}
                onChange={(e) => setSuburb(e.target.value)}
              />

              <input
                className="rounded border p-2"
                placeholder="State"
                value={state}
                onChange={(e) => setState(e.target.value)}
              />

              <input
                className="rounded border p-2"
                placeholder="Postcode"
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
              />
            </div>
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading || !companyId || partnersLoading || !!partnerLoadError || !selectedPartner}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Job'}
          </button>

          <button
            type="button"
            onClick={() => navigate('/jobs')}
            className="rounded border px-4 py-2"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
