'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Observation } from '@/lib/types';

interface ObservationCardProps {
  observation: Observation;
  index: number;
  userId: string;
  jobId: string;
  onChange: (index: number, observation: Observation) => void;
  onDelete: (index: number) => void;
}

const codeColors: Record<string, string> = {
  C1: 'bg-red-500',
  C2: 'bg-orange-500',
  C3: 'bg-blue-500',
  FI: 'bg-purple-500',
  NC: 'bg-gray-500',
};

const codeLabels: Record<string, string> = {
  C1: 'Danger Present',
  C2: 'Potentially Dangerous',
  C3: 'Improvement Recommended',
  FI: 'Further Investigation',
  NC: 'Non-Conformity',
};

export function ObservationCard({ observation, index, onChange, onDelete }: ObservationCardProps) {
  const [expanded, setExpanded] = useState(true);

  const updateField = (field: keyof Observation, value: string | string[]) => {
    onChange(index, { ...observation, [field]: value });
  };

  const isLinkedToSchedule = !!observation.schedule_item;

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50">
        <div className="flex items-center gap-3">
          <select
            value={observation.code}
            onChange={(e) => updateField('code', e.target.value)}
            aria-label="Observation severity code"
            className={cn(
              'h-8 w-14 rounded-full text-white font-bold text-center text-xs appearance-none cursor-pointer',
              codeColors[observation.code] || 'bg-gray-500'
            )}
          >
            <option value="C1">C1</option>
            <option value="C2">C2</option>
            <option value="C3">C3</option>
            <option value="FI">FI</option>
          </select>
          <div>
            <span className="text-sm text-gray-600">{codeLabels[observation.code]}</span>
            {isLinkedToSchedule && (
              <span className="ml-2 text-xs text-blue-600">
                (linked to {observation.schedule_item})
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 text-gray-400 hover:text-gray-600"
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(index)}
            className="text-red-500 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="p-4 space-y-3">
          {observation.schedule_description && (
            <div className="text-sm px-3 py-2 bg-slate-50 border rounded-md text-slate-700">
              {observation.schedule_item} - {observation.schedule_description}
            </div>
          )}

          <div>
            <label className="text-xs text-gray-500">Location</label>
            <Input
              value={observation.item_location}
              onChange={(e) => updateField('item_location', e.target.value)}
              placeholder="e.g., Kitchen socket, Consumer unit"
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-xs text-gray-500">Observation</label>
            <textarea
              value={observation.observation_text}
              onChange={(e) => updateField('observation_text', e.target.value)}
              placeholder="Description of the issue..."
              className="mt-1 w-full min-h-[80px] rounded-md border border-input px-3 py-2 text-sm resize-y"
            />
          </div>

          <div>
            <label className="text-xs text-gray-500">Schedule Item</label>
            <Input
              value={observation.schedule_item || ''}
              onChange={(e) => updateField('schedule_item', e.target.value)}
              placeholder="e.g., 4.5, 5.3"
              className="mt-1"
              disabled={isLinkedToSchedule}
            />
          </div>
        </div>
      )}
    </div>
  );
}
