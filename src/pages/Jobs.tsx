import { useEffect, useState } from 'react';
import { Building2, CalendarPlus, Loader2 } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Job = {
  id: string;
  company_id: string;
  job_number: string | null;
  title: string | null;
  status: string | null;
  priority: number | null;
  site_name: string | null;
  suburb: string | null;
  start_date: string;
  end_date: string;
  unit_count: number;
};

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

  useEffect(() => {
    async function loadJobs() {
      const { data, error } = await supabase
        .from('jobs')
        .select(
          'id, company_id, job_number, title, status, priority, site_name, suburb, start_date, end_date, unit_count',
        )
        .order('job_number');

      if (error) {
        console.error(error);
      }

      if (!error && data) {
        setJobs(data as unknown as Job[]);
      }

      setLoading(false);
    }

    loadJobs();
  }, []);

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

    const { error } = await supabase
      .from('job_slots')
      .insert(payload as unknown as never[]);

    setGeneratingId(null);

    if (error) {
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

                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
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
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
