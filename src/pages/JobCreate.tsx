import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { supabase } from '@/lib/supabase/client';

export default function JobCreatePage() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobNumber, setJobNumber] = useState('');
  const [title, setTitle] = useState('');
  const [reference, setReference] = useState('');
  const [priority, setPriority] = useState(2);

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
          company_id: '45584402-8893-4028-93d6-477d7d6f2ce2',
          partner_id: '761d03bf-e6ba-46cf-8f0e-037fdeb908cd',

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
            disabled={loading}
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
