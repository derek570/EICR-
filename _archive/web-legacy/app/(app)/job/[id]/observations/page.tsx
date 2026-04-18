'use client';

import { useMemo } from 'react';
import { useJobContext } from '../layout';
import { ObservationCard } from '@/components/observations/observation-card';
import { Button } from '@/components/ui/button';
import { Plus, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Observation } from '@/lib/types';

/** iOS-parity summary badge component — matches C1/C2/C3/FI color scheme */
function ObsBadge({
  label,
  count,
  variant,
}: {
  label: string;
  count: number;
  variant: 'total' | 'c1' | 'c2' | 'c3' | 'fi';
}) {
  const colors = {
    total: 'bg-white/10 text-white border-white/20',
    c1: 'bg-red-500/15 text-red-400 border-red-500/30',
    c2: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    c3: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    fi: 'bg-green-500/15 text-green-400 border-green-500/30',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold tabular-nums',
        colors[variant]
      )}
    >
      <span className="text-[10px] opacity-70">{label}</span>
      {count}
    </span>
  );
}

export default function ObservationsPage() {
  const { job, updateJob, user } = useJobContext();

  const counts = useMemo(() => {
    const obs = job.observations || [];
    return {
      total: obs.length,
      c1: obs.filter((o) => o.code === 'C1').length,
      c2: obs.filter((o) => o.code === 'C2').length,
      c3: obs.filter((o) => o.code === 'C3').length,
      fi: obs.filter((o) => o.code === 'FI').length,
    };
  }, [job.observations]);

  const handleObservationChange = (index: number, observation: Observation) => {
    const updated = [...job.observations];
    updated[index] = observation;
    updateJob({ observations: updated });
  };

  const handleDelete = (index: number) => {
    const observationToDelete = job.observations[index];
    const scheduleItem = observationToDelete.schedule_item;

    const updatedObservations = job.observations.filter((_, i) => i !== index);

    // If linked to a schedule item, reset it to "tick"
    if (scheduleItem && job.inspection_schedule) {
      const updatedSchedule = {
        ...job.inspection_schedule,
        items: {
          ...job.inspection_schedule.items,
          [scheduleItem]: { outcome: 'tick' as const },
        },
      };
      updateJob({
        observations: updatedObservations,
        inspection_schedule: updatedSchedule,
      });
    } else {
      updateJob({ observations: updatedObservations });
    }
  };

  const addObservation = () => {
    const newObs: Observation = {
      code: 'C3',
      item_location: '',
      observation_text: '',
      schedule_item: '',
      photos: [],
    };
    updateJob({ observations: [...job.observations, newObs] });
  };

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      {/* Hero header — matches iOS Observations tab */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/15">
            <AlertTriangle className="h-5 w-5 text-yellow-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Observations</h2>
            <p className="text-xs text-gray-500">Defects, recommendations &amp; notes</p>
          </div>
        </div>
        <Button size="sm" onClick={addObservation}>
          <Plus className="h-4 w-4 mr-1" />
          Add Observation
        </Button>
      </div>

      {/* Summary badges — mirrors iOS C1/C2/C3/FI count badges */}
      <div className="flex flex-wrap gap-2">
        <ObsBadge label="Total" count={counts.total} variant="total" />
        <ObsBadge label="C1" count={counts.c1} variant="c1" />
        <ObsBadge label="C2" count={counts.c2} variant="c2" />
        <ObsBadge label="C3" count={counts.c3} variant="c3" />
        <ObsBadge label="FI" count={counts.fi} variant="fi" />
      </div>

      {job.observations.some((obs) => obs.schedule_item) && (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-800">
          <strong>Note:</strong> Some observations are linked to items in the Inspection Schedule.
          Deleting a linked observation will set its schedule item back to tick.
        </div>
      )}

      {job.observations.length === 0 ? (
        <div className="text-center py-12 bg-[#1e293b] rounded-lg border border-white/8">
          <p className="text-gray-500 mb-4">No observations recorded</p>
          <p className="text-sm text-gray-500 mb-4">
            Tip: You can add observations directly from the Inspection Schedule by selecting C1, C2,
            or C3.
          </p>
          <Button onClick={addObservation}>
            <Plus className="h-4 w-4 mr-2" />
            Add First Observation
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {job.observations.map((obs, index) => (
            <ObservationCard
              key={index}
              observation={obs}
              index={index}
              onChange={handleObservationChange}
              onDelete={handleDelete}
              userId={user?.id ?? ''}
              jobId={job.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
