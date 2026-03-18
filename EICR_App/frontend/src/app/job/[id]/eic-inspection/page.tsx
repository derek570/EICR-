'use client';

import { useJob } from '../layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InspectionSchedule } from '@/lib/api';
import { EIC_SCHEDULE_ITEMS } from '@/lib/constants';
import { cn } from '@/lib/utils';

type EICOutcome = 'tick' | 'N/A';

const outcomeLabels: Record<EICOutcome, string> = {
  tick: '\u2713',
  'N/A': 'N/A',
};

export default function EICInspectionPage() {
  const { job, updateJob, certificateType } = useJob();

  // This page is for EIC certificates
  if (certificateType !== 'EIC') {
    return (
      <div className="p-4">
        <p className="text-muted-foreground">
          This page is for EIC certificates. Use the EICR Inspection tab for EICR certificates.
        </p>
      </div>
    );
  }

  const schedule = job.inspection_schedule || { items: {} };

  const updateItem = (itemId: string, outcome: EICOutcome) => {
    const updatedItems = {
      ...schedule.items,
      [itemId]: { ...schedule.items[itemId], outcome },
    };
    updateJob({ inspection_schedule: { items: updatedItems } });
  };

  const getOutcome = (itemId: string): EICOutcome => {
    const outcome = schedule.items[itemId]?.outcome;
    return outcome === 'N/A' ? 'N/A' : 'tick';
  };

  const markAllTick = () => {
    const updatedItems: Record<string, { outcome: EICOutcome }> = {};
    Object.keys(EIC_SCHEDULE_ITEMS).forEach((itemId) => {
      updatedItems[itemId] = { outcome: 'tick' };
    });
    updateJob({ inspection_schedule: { items: updatedItems } });
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">EIC Inspection Schedule</h2>
        <button onClick={markAllTick} className="text-sm text-primary hover:underline">
          Mark All as Satisfactory
        </button>
      </div>

      <p className="text-sm text-muted-foreground">
        For new installations, verify each item has been inspected and is satisfactory, or mark as
        N/A if not applicable.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inspection Items</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {Object.entries(EIC_SCHEDULE_ITEMS).map(([itemId, description]) => {
              const outcome = getOutcome(itemId);

              return (
                <div key={itemId} className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm mr-2">{itemId}</span>
                    <span className="text-sm text-muted-foreground">{description}</span>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => updateItem(itemId, 'tick')}
                      className={cn(
                        'px-3 py-1 text-sm font-medium rounded border transition-colors',
                        outcome === 'tick'
                          ? 'bg-green-100 text-green-800 border-green-300'
                          : 'bg-card border-border text-muted-foreground hover:border-muted-foreground'
                      )}
                    >
                      \u2713
                    </button>
                    <button
                      onClick={() => updateItem(itemId, 'N/A')}
                      className={cn(
                        'px-3 py-1 text-sm font-medium rounded border transition-colors',
                        outcome === 'N/A'
                          ? 'bg-muted text-muted-foreground border-border'
                          : 'bg-card border-border text-muted-foreground hover:border-muted-foreground'
                      )}
                    >
                      N/A
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground">
        <p>
          <span className="font-medium">\u2713</span> = Inspected and verified compliant
        </p>
        <p>
          <span className="font-medium">N/A</span> = Not applicable to this installation
        </p>
      </div>
    </div>
  );
}
