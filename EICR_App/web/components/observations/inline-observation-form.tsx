'use client';

import { Input } from '@/components/ui/input';
import type { Observation } from '@/lib/types';
import { cn } from '@/lib/utils';

interface InlineObservationFormProps {
  observation: Observation;
  scheduleItem: string;
  scheduleDescription: string;
  onChange: (observation: Observation) => void;
}

export function InlineObservationForm({
  observation,
  scheduleItem,
  scheduleDescription,
  onChange,
}: InlineObservationFormProps) {
  const updateField = (field: keyof Observation, value: string | string[]) => {
    onChange({ ...observation, [field]: value });
  };

  return (
    <div className="bg-white/[0.03] border-t border-white/8 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
        <span
          className={cn(
            'px-2 py-0.5 rounded text-white text-xs font-bold',
            observation.code === 'C1' && 'bg-red-500',
            observation.code === 'C2' && 'bg-orange-500',
            observation.code === 'C3' && 'bg-blue-500'
          )}
        >
          {observation.code}
        </span>
        <span>Observation</span>
      </div>

      {/* Regulation line (read-only) */}
      <div className="text-sm">
        <label className="text-xs text-gray-500">Regulation</label>
        <div className="mt-1 px-3 py-2 bg-white/5 border border-white/10 rounded-md text-sm text-gray-300">
          {scheduleItem} - {scheduleDescription}
        </div>
      </div>

      {/* Location input */}
      <div>
        <label className="text-xs text-gray-500">Location</label>
        <Input
          value={observation.item_location}
          onChange={(e) => updateField('item_location', e.target.value)}
          placeholder="e.g., Kitchen, Consumer unit, First floor"
          className="mt-1 bg-white/5 border-white/10 text-white placeholder:text-gray-500"
        />
      </div>

      {/* Observation text */}
      <div>
        <label className="text-xs text-gray-500">Observation</label>
        <textarea
          value={observation.observation_text}
          onChange={(e) => updateField('observation_text', e.target.value)}
          placeholder="Describe the issue observed..."
          className="mt-1 w-full min-h-[80px] rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-gray-500 resize-y"
        />
      </div>
    </div>
  );
}
