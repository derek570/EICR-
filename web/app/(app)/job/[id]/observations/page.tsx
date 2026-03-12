'use client';

import { useJobContext } from '../layout';
import { ObservationCard } from '@/components/observations/observation-card';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
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
        <h2 className="text-lg font-semibold">Observations ({job.observations.length})</h2>
        <Button size="sm" onClick={addObservation}>
          <Plus className="h-4 w-4 mr-1" />
          Add Observation
        </Button>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}
