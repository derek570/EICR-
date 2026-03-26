'use client';

import { useJobContext } from '../layout';
import { ObservationCard } from '@/components/observations/observation-card';
import { Button } from '@/components/ui/button';
import { GlassCard, GlassCardContent } from '@/components/ui/glass-card';
import { Plus, AlertTriangle } from 'lucide-react';
import type { Observation } from '@/lib/types';

export default function ObservationsPage() {
  const { job, updateJob } = useJobContext();

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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-status-amber" />
          <h2 className="text-lg font-semibold text-foreground">Observations</h2>
          <span className="text-sm text-muted-foreground">({job.observations.length})</span>
        </div>
        <Button size="sm" onClick={addObservation}>
          <Plus className="h-4 w-4 mr-1" />
          Add Observation
        </Button>
      </div>

      {job.observations.some((obs) => obs.schedule_item) && (
        <GlassCard className="border-l-[3px] border-l-brand-blue">
          <GlassCardContent className="py-3 px-4">
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">Note:</strong> Some observations are linked to
              items in the Inspection Schedule. Deleting a linked observation will set its schedule
              item back to tick.
            </p>
          </GlassCardContent>
        </GlassCard>
      )}

      {job.observations.length === 0 ? (
        <GlassCard>
          <GlassCardContent className="text-center py-12">
            <AlertTriangle className="h-10 w-10 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground mb-2">No observations recorded</p>
            <p className="text-sm text-muted-foreground/70 mb-4">
              Tip: You can add observations directly from the Inspection Schedule by selecting C1,
              C2, or C3.
            </p>
            <Button onClick={addObservation}>
              <Plus className="h-4 w-4 mr-2" />
              Add First Observation
            </Button>
          </GlassCardContent>
        </GlassCard>
      ) : (
        <div className="space-y-4 stagger-in">
          {job.observations.map((obs, index) => (
            <div key={index} className="animate-stagger-in">
              <ObservationCard
                observation={obs}
                index={index}
                onChange={handleObservationChange}
                onDelete={handleDelete}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
