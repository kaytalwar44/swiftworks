import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Job = {
  id: string;
  job_number: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  site_name: string | null;
  suburb: string | null;
};

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadJobs() {
  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id, job_number, title, status, priority, site_name, suburb'
    )
    .order('job_number');

  console.log('Jobs Data:', data);
  console.log('Jobs Error:', error);

  if (error) {
    console.error(error);
  }

  if (!error && data) {
    setJobs(data);
  }

  setLoading(false);
}

    loadJobs();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Jobs
        </h1>
        <p className="text-sm text-muted-foreground">
          Installation campaigns and work orders
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <Building2 className="h-5 w-5" />

            <div>
              <p className="text-sm text-muted-foreground">
                Total Jobs
              </p>

              <p className="text-3xl font-bold">
                {jobs.length}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Job List</CardTitle>
        </CardHeader>

        <CardContent>
          {loading ? (
            <p>Loading jobs...</p>
          ) : jobs.length === 0 ? (
            <p>No jobs found.</p>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="rounded border p-4"
                >
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
                    Priority: {job.priority || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Site: {job.site_name || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Suburb: {job.suburb || '-'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}