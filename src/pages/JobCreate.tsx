import { useState } from 'react';
import { useNavigate } from 'react-router';

import { supabase } from '@/lib/supabase/client';

export default function JobCreatePage() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);

  const [jobNumber, setJobNumber] = useState('');
  const [title, setTitle] = useState('');
  const [reference, setReference] = useState('');
  const [priority, setPriority] = useState('Normal');

  const [siteName, setSiteName] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [suburb, setSuburb] = useState('');
  const [state, setState] = useState('');
  const [postcode, setPostcode] = useState('');

  async function handleSubmit(
    e: React.FormEvent<HTMLFormElement>
  ) {
    e.preventDefault();

    setLoading(true);

   const { error } = await (supabase as any)
  .from('jobs')
  .insert([
    {
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
    },
  ]);

    setLoading(false);

    if (error) {
      alert(error.message);
      return;
    }

    navigate('/jobs');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">
          Create Job
        </h1>

        <p className="text-muted-foreground">
          Create a new installation campaign
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-6 rounded-lg border p-6"
      >
        <div>
          <h2 className="mb-4 text-lg font-semibold">
            Job Details
          </h2>

          <div className="grid gap-4 md:grid-cols-2">
            <input
              className="rounded border p-2"
              placeholder="Job Number"
              value={jobNumber}
              onChange={(e) =>
                setJobNumber(e.target.value)
              }
            />

            <input
              className="rounded border p-2"
              placeholder="Title"
              value={title}
              onChange={(e) =>
                setTitle(e.target.value)
              }
            />

            <input
              className="rounded border p-2"
              placeholder="Reference"
              value={reference}
              onChange={(e) =>
                setReference(e.target.value)
              }
            />

            <select
              className="rounded border p-2"
              value={priority}
              onChange={(e) =>
                setPriority(e.target.value)
              }
            >
              <option>Low</option>
              <option>Normal</option>
              <option>High</option>
              <option>Urgent</option>
            </select>
          </div>
        </div>

        <div>
          <h2 className="mb-4 text-lg font-semibold">
            Site Information
          </h2>

          <div className="grid gap-4">
            <input
              className="rounded border p-2"
              placeholder="Site Name"
              value={siteName}
              onChange={(e) =>
                setSiteName(e.target.value)
              }
            />

            <input
              className="rounded border p-2"
              placeholder="Address Line 1"
              value={addressLine1}
              onChange={(e) =>
                setAddressLine1(e.target.value)
              }
            />

            <input
              className="rounded border p-2"
              placeholder="Address Line 2"
              value={addressLine2}
              onChange={(e) =>
                setAddressLine2(e.target.value)
              }
            />

            <div className="grid gap-4 md:grid-cols-3">
              <input
                className="rounded border p-2"
                placeholder="Suburb"
                value={suburb}
                onChange={(e) =>
                  setSuburb(e.target.value)
                }
              />

              <input
                className="rounded border p-2"
                placeholder="State"
                value={state}
                onChange={(e) =>
                  setState(e.target.value)
                }
              />

              <input
                className="rounded border p-2"
                placeholder="Postcode"
                value={postcode}
                onChange={(e) =>
                  setPostcode(e.target.value)
                }
              />
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded bg-blue-600 px-4 py-2 text-white"
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