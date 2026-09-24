import { useEffect, useState } from 'react';
import { Handshake } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Partner = {
  id: string;
  code: string | null;
  name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  payment_terms_days: number | null;
};

export default function Partners() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadPartners() {
      const { data, error } = await supabase
        .from('partners')
        .select(
          'id, code, name, contact_name, contact_email, contact_phone, payment_terms_days'
        )
        .order('name');

      if (!error && data) {
        setPartners(data);
      }

      setLoading(false);
    }

    loadPartners();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Partners
        </h1>
        <p className="text-sm text-muted-foreground">
          Installation and service partners
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <Handshake className="h-5 w-5" />

            <div>
              <p className="text-sm text-muted-foreground">
                Total Partners
              </p>

              <p className="text-3xl font-bold">
                {partners.length}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Partner Directory</CardTitle>
        </CardHeader>

        <CardContent>
          {loading ? (
            <p>Loading partners...</p>
          ) : partners.length === 0 ? (
            <p>No partners found.</p>
          ) : (
            <div className="space-y-3">
              {partners.map((partner) => (
                <div
                  key={partner.id}
                  className="rounded border p-4"
                >
                  <div className="font-medium">
                    {partner.name || 'Unnamed Partner'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Code: {partner.code || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Contact: {partner.contact_name || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Email: {partner.contact_email || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Phone: {partner.contact_phone || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Payment Terms: {partner.payment_terms_days ?? '-'} days
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