import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadXlsx, type ExportCell } from '@/lib/export-xlsx';

export function ExportButton({ name, headers, rows, disabled = false }: {
  name: string; headers: string[]; rows: ExportCell[][]; disabled?: boolean;
}) {
  const [error, setError] = useState('');
  return <div className="my-2">
    <Button variant="outline" disabled={disabled || !rows.length} onClick={() => {
      setError('');
      try { downloadXlsx(name, headers, rows); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'Export failed.'); }
    }}><Download className="mr-2 h-4 w-4" />Export loaded rows (.xlsx)</Button>
    <p className="mt-1 text-xs text-muted-foreground">Exports only the rows currently loaded on this page.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
