import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Building2, CalendarPlus, Loader2, Pencil } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Job = {
  id: string;
  company_id: string;
  job_number: string | null;
  title: string | null;
  reference: string | null;
  status: string | null;
  priority: number | null;
  site_name: string | null;
  address_line1: string;
  address_line2: string | null;
  suburb: string;
  state: string;
  postcode: string;
  start_date: string;
  end_date: string;
  unit_count: number;
};

/** The twelve editable fields, as a flat draft object. */
type JobDraft = {
  job_number: string;
  title: string;
  reference: string;
  start_date: string;
  end_date: string;
  unit_count: number;
  site_name: string;
  address_line1: string;
  address_line2: string;
  suburb: string;
  state: string;
  postcode: string;
};

function toDraft(job: Job): JobDraft {
  return {
    job_number: job.job_number ?? '',
    title: job.title ?? '',
    reference: job.reference ?? '',
    start_date: job.start_date ?? '',
    end_date: job.end_date ?? '',
    unit_count: job.unit_count ?? 0,
    site_name: job.site_name ?? '',
    address_line1: job.address_line1 ?? '',
    address_line2: job.address_line2 ?? '',
    suburb: job.suburb ?? '',
    state: job.state ?? '',
    postcode: job.postcode ?? '',
  };
}

/** 08:00–12:00 and 12:00–16:00 on every day of the job window. */
const SLOT_WINDOWS = [
  { local_start: '08:00:00', local_end: '12:00:00' },
  { local_start: '12:00:00', local_end: '16:00:00' },
] as const;

/**
 * Splits unit_count across the two daily windows.
 * An odd count gives the extra booking to the morning.
 *   6 -> 3/3 · 18 -> 9/9 · 25 -> 13/12 · 30 -> 15/15
 */
function splitCapacity(unitCount: number): [number, number] {
  const base = Math.floor(unitCount / 2);
  const remainder = unitCount % 2;
  return [base + remainder, base];
}

/** Every date from start to end inclusive, as YYYY-MM-DD. */
function eachDate(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [draft, setDraft] = useState<JobDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setLoading(true);

    const { data, error } = await (supabase as any)
      .from('jobs')
      .select(
        'id, company_id, job_number, title, reference, status, priority, site_name, address_line1, address_line2, suburb, state, postcode, start_date, end_date, unit_count',
      )
      .order('job_number');

    if (error) {
      console.error(error);
      setNotice(error.message);
    }

    if (!error && data) {
      setJobs(data as unknown as Job[]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  function openEdit(job: Job) {
    setEditingJob(job);
    setDraft(toDraft(job));
    setSaveError(null);
  }

  function closeEdit() {
    setEditingJob(null);
    setDraft(null);
    setSaveError(null);
    setSaving(false);
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!editingJob || !draft) return;

    setSaving(true);
    setSaveError(null);

    if (!draft.start_date || !draft.end_date) {
      setSaveError('Start date and end date are required.');
      setSaving(false);
      return;
    }

    if (draft.end_date < draft.start_date) {
      setSaveError('End date cannot be before the start date.');
      setSaving(false);
      return;
    }

    const { error } = await (supabase as any)
      .from('jobs')
      .update({
        job_number: draft.job_number.trim(),
        title: draft.title.trim() || null,
        reference: draft.reference.trim() || null,
        start_date: draft.start_date,
        end_date: draft.end_date,
        unit_count: draft.unit_count,
        site_name: draft.site_name.trim() || null,
        address_line1: draft.address_line1.trim(),
        address_line2: draft.address_line2.trim() || null,
        suburb: draft.suburb.trim(),
        state: draft.state.trim(),
        postcode: draft.postcode.trim(),
      })
      .eq('id', editingJob.id);

    setSaving(false);

    if (error) {
      setSaveError(error.message);
      return;
    }

    closeEdit();
    setNotice('Job updated.');
    await loadJobs();
  }

  async function generateSlots(job: Job) {
    setGeneratingId(job.id);
    setNotice(null);

    if (!job.start_date || !job.end_date) {
      setNotice('This job has no start or end date.');
      setGeneratingId(null);
      return;
    }

    if (job.unit_count <= 0) {
      setNotice('This job has no units to schedule.');
      setGeneratingId(null);
      return;
    }

    const [morningCapacity, afternoonCapacity] = splitCapacity(job.unit_count);
    const dates = eachDate(job.start_date, job.end_date);

    // start_time and end_time are NOT NULL with no default, so they are
    // derived from the slot date and the local window. The +10:00 offset is
    // Sydney time.
    const payload = dates.flatMap((slot_date) =>
      SLOT_WINDOWS.map((window, index) => ({
        company_id: job.company_id,
        job_id: job.id,
        slot_date,
        local_start: window.local_start,
        local_end: window.local_end,
        start_time: `${slot_date}T${window.local_start}+10:00`,
        end_time: `${slot_date}T${window.local_end}+10:00`,
        capacity: index === 0 ? morningCapacity : afternoonCapacity,
        booked_count: 0,
        status: 'open',
        sequence: index + 1,
      })),
    );

    const { error } = await (supabase as any)
      .from('job_slots')
      .insert(payload);

    setGeneratingId(null);

    if (error) {
      // The exclusion constraint is the duplicate guard. It fires when a second
      // batch would collide with existing rows at identical timestamps, so
      // translate it rather than showing raw Postgres output.
      if (
        error.message.includes('job_slots_no_seq_overlap') ||
        error.message.includes(
          'conflicting key value violates exclusion constraint',
        )
      ) {
        setNotice('Slots already exist for this job.');
        return;
      }

      setNotice(error.message);
      return;
    }

    setNotice(
      `Created ${payload.length} slots across ${dates.length} days (${morningCapacity} morning, ${afternoonCapacity} afternoon).`,
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p className="text-sm text-muted-foreground">
          Installation campaigns and work orders
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <Building2 className="h-5 w-5" />

            <div>
              <p className="text-sm text-muted-foreground">Total Jobs</p>
              <p className="text-3xl font-bold">{jobs.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Job List</CardTitle>
        </CardHeader>

        <CardContent>
          {notice && (
            <p className="mb-4 rounded border bg-muted/40 p-3 text-sm">
              {notice}
            </p>
          )}

          {loading ? (
            <p>Loading jobs...</p>
          ) : jobs.length === 0 ? (
            <p>No jobs found.</p>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.id} className="rounded border p-4">
                  <div className="font-medium">
                    {job.title || 'Untitled Job'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Job #: {job.job_number || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Status: {job.status || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Priority: {job.priority ?? '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Site: {job.site_name || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Suburb: {job.suburb || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Schedule: {job.start_date || '-'} to {job.end_date || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Units: {job.unit_count ?? '-'}
                  </div>

                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={generatingId === job.id}
                      onClick={() => generateSlots(job)}
                    >
                      {generatingId === job.id ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <CalendarPlus className="mr-2 h-4 w-4" />
                          Generate Slots
                        </>
                      )}
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEdit(job)}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {editingJob && draft && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-job-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeEdit();
          }}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEdit();
          }}
        >
          <form
            onSubmit={saveEdit}
            className="w-full max-w-2xl space-y-5 rounded-lg border bg-background p-6 shadow-xl"
          >
            <div>
              <h2 id="edit-job-title" className="text-lg font-semibold">
                Edit Job
              </h2>
              <p className="text-sm text-muted-foreground">
                {editingJob.job_number || 'Untitled'}
              </p>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Job Details</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  className="rounded border p-2"
                  placeholder="Job Number"
                  value={draft.job_number}
                  onChange={(e) =>
                    setDraft({ ...draft, job_number: e.target.value })
                  }
                />
                <input
                  className="rounded border p-2"
                  placeholder="Title"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
                <input
                  className="rounded border p-2"
                  placeholder="Reference"
                  value={draft.reference}
                  onChange={(e) =>
                    setDraft({ ...draft, reference: e.target.value })
                  }
                />
                <input
                  type="number"
                  min={0}
                  className="rounded border p-2"
                  placeholder="Unit count"
                  value={draft.unit_count}
                  onChange={(e) =>
                    setDraft({ ...draft, unit_count: Number(e.target.value) })
                  }
                />
              </div>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Schedule</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  type="date"
                  className="rounded border p-2"
                  value={draft.start_date}
                  onChange={(e) =>
                    setDraft({ ...draft, start_date: e.target.value })
                  }
                  required
                />
                <input
                  type="date"
                  className="rounded border p-2"
                  min={draft.start_date || undefined}
                  value={draft.end_date}
                  onChange={(e) =>
                    setDraft({ ...draft, end_date: e.target.value })
                  }
                  required
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Changing dates does not regenerate existing slots.
              </p>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Site Information</h3>
              <div className="grid gap-3">
                <input
                  className="rounded border p-2"
                  placeholder="Site Name"
                  value={draft.site_name}
                  onChange={(e) =>
                    setDraft({ ...draft, site_name: e.target.value })
                  }
                />
                <input
                  className="rounded border p-2"
                  placeholder="Address Line 1"
                  value={draft.address_line1}
                  onChange={(e) =>
                    setDraft({ ...draft, address_line1: e.target.value })
                  }
                />
                <input
                  className="rounded border p-2"
                  placeholder="Address Line 2"
                  value={draft.address_line2}
                  onChange={(e) =>
                    setDraft({ ...draft, address_line2: e.target.value })
                  }
                />
                <div className="grid gap-3 sm:grid-cols-3">
                  <input
                    className="rounded border p-2"
                    placeholder="Suburb"
                    value={draft.suburb}
                    onChange={(e) =>
                      setDraft({ ...draft, suburb: e.target.value })
                    }
                  />
                  <input
                    className="rounded border p-2"
                    placeholder="State"
                    value={draft.state}
                    onChange={(e) => setDraft({ ...draft, state: e.target.value })}
                  />
                  <input
                    className="rounded border p-2"
                    placeholder="Postcode"
                    value={draft.postcode}
                    onChange={(e) =>
                      setDraft({ ...draft, postcode: e.target.value })
                    }
                  />
                </div>
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
              <Button type="button" variant="outline" onClick={closeEdit}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
