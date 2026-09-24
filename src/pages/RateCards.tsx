import { useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';

import { supabase } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type RateCard = {
  id: string;
  name: string | null;
  code: string | null;
  scope: string | null;
  currency: string | null;
  is_active: boolean | null;
  tax_rate: number | null;
};

export default function RateCards() {
  const [rateCards, setRateCards] = useState<RateCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadRateCards() {
      const { data, error } = await supabase
        .from('rate_cards')
        .select(
          'id, name, code, scope, currency, is_active, tax_rate'
        )
        .order('name');

      if (!error && data) {
        setRateCards(data);
      }

      setLoading(false);
    }

    loadRateCards();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Rate Cards
        </h1>
        <p className="text-sm text-muted-foreground">
          Pricing schedules and technician rates
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <Receipt className="h-5 w-5" />
            <div>
              <p className="text-sm text-muted-foreground">
                Total Rate Cards
              </p>
              <p className="text-3xl font-bold">
                {rateCards.length}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rate Card List</CardTitle>
        </CardHeader>

        <CardContent>
          {loading ? (
            <p>Loading rate cards...</p>
          ) : rateCards.length === 0 ? (
            <p>No rate cards found.</p>
          ) : (
            <div className="space-y-3">
              {rateCards.map((card) => (
                <div
                  key={card.id}
                  className="rounded border p-4"
                >
                  <div className="font-medium">
                    {card.name || 'Unnamed Rate Card'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Code: {card.code || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Scope: {card.scope || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Currency: {card.currency || '-'}
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Tax Rate: {card.tax_rate ?? 0}%
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Status:{' '}
                    {card.is_active ? 'Active' : 'Inactive'}
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