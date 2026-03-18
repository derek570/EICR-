'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Trash2, Link as LinkIcon } from 'lucide-react';
import type { Observation } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ObservationCardProps {
  observation: Observation;
  index: number;
  onChange: (index: number, observation: Observation) => void;
  onDelete: (index: number) => void;
}

const codeColors: Record<string, string> = {
  C1: 'bg-red-500',
  C2: 'bg-orange-500',
  C3: 'bg-blue-500',
  FI: 'bg-purple-500',
};

const codeLabels: Record<string, string> = {
  C1: 'Danger Present',
  C2: 'Potentially Dangerous',
  C3: 'Improvement Recommended',
  FI: 'Further Investigation',
};

export function ObservationCard({ observation, index, onChange, onDelete }: ObservationCardProps) {
  const updateField = (field: keyof Observation, value: string | string[]) => {
    onChange(index, { ...observation, [field]: value });
  };

  const isLinkedToSchedule = !!observation.schedule_item;

  return (
    <div className="bg-[#1e293b] border border-white/8 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <select
            value={observation.code}
            onChange={(e) => updateField('code', e.target.value as Observation['code'])}
            className={cn(
              'h-10 w-16 rounded-full text-white font-bold text-center appearance-none cursor-pointer',
              codeColors[observation.code]
            )}
          >
            <option value="C1">C1</option>
            <option value="C2">C2</option>
            <option value="C3">C3</option>
            <option value="FI">FI</option>
          </select>
          <div>
            <span className="text-sm text-gray-400">{codeLabels[observation.code]}</span>
            {isLinkedToSchedule && (
              <div className="flex items-center gap-1 text-xs text-blue-400 mt-0.5">
                <LinkIcon className="h-3 w-3" />
                <span>Linked to {observation.schedule_item}</span>
              </div>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(index)}
          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Schedule description (if linked) */}
      {observation.schedule_description && (
        <div className="text-sm">
          <label className="text-xs text-gray-500">Regulation</label>
          <div className="mt-1 px-3 py-2 bg-white/5 border border-white/10 rounded-md text-sm text-gray-300">
            {observation.schedule_item} - {observation.schedule_description}
          </div>
        </div>
      )}

      <div>
        <label className="text-xs text-gray-500">Location</label>
        <Input
          value={observation.item_location}
          onChange={(e) => updateField('item_location', e.target.value)}
          placeholder="e.g., Kitchen socket, Consumer unit"
          className="mt-1 bg-white/5 border-white/10 text-white placeholder:text-gray-500"
        />
      </div>

      <div>
        <label className="text-xs text-gray-500">Observation</label>
        <textarea
          value={observation.observation_text}
          onChange={(e) => updateField('observation_text', e.target.value)}
          placeholder="Description of the issue..."
          className="mt-1 w-full min-h-[80px] rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-gray-500 resize-y"
        />
      </div>

      <div>
        <label className="text-xs text-gray-500">Schedule Item</label>
        <Input
          value={observation.schedule_item || ''}
          onChange={(e) => updateField('schedule_item', e.target.value)}
          placeholder="e.g., 4.5, 5.3"
          className="mt-1 bg-white/5 border-white/10 text-white placeholder:text-gray-500"
          disabled={isLinkedToSchedule}
        />
        {isLinkedToSchedule && (
          <p className="text-xs text-gray-500 mt-1">
            This observation is linked from the Inspection Schedule. Deleting it will set the
            schedule item to tick.
          </p>
        )}
      </div>
    </div>
  );
}
