import { useEffect, useState } from 'react';
import { HardHat } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Technician = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  employment_type: string | null;
  max_installs_per_day: number | null;
};

export default function Technicians() {
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadTechnicians() {
      const { data, error } = await supabase
        .from('technicians')
        .select(
          'id, full_name, email, phone, employment_type, max_installs_per_day'
        )
        .order('full_name');

      if (!error && data) {
        setTechnicians(data);
      }

      setLoading(false);
    }

    loadTechnicians();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Technicians
        </h1>
        <p className="text-sm text-muted-foreground">
          Field staff performing installations
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <HardHat className="h-5 w-5" />

            <div>
              <p className="text-sm text-muted-foreground">
                Total Technicians
              </p>

              <p className="text-3xl font-bold">
                {technicians.length}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Technician Directory</CardTitle>
        </CardHeader>

        <CardContent>
          {loading ? (
            <p>Loading technicians...</p>
          ) : technicians.length === 0 ? (
            <p>No technicians found.</p>
          ) : (
            <div className="space-y-3">
              {technicians.map((tech) => (
                <div
                  key={tech.id}
                  className="rounded border p-4"
                >
                  <div className="font-medium">
                    {tech.full_name || 'Unknown'}
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
                    Max installs/day:{' '}
                    {tech.max_installs_per_day ?? '-'}
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