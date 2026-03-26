'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Trash2, Link as LinkIcon } from 'lucide-react';
import type { Observation } from '@/lib/types';

interface ObservationCardProps {
  observation: Observation;
  index: number;
  onChange: (index: number, observation: Observation) => void;
  onDelete: (index: number) => void;
}

const codeLabels: Record<string, string> = {
  C1: 'Danger Present',
  C2: 'Potentially Dangerous',
  C3: 'Improvement Recommended',
  FI: 'Further Investigation',
};

const severityBorderColors: Record<string, string> = {
  C1: 'border-l-status-c1',
  C2: 'border-l-status-c2',
  C3: 'border-l-status-c3',
  FI: 'border-l-status-fi',
};

const severityBadgeStatus: Record<string, 'c1' | 'c2' | 'c3' | 'fi'> = {
  C1: 'c1',
  C2: 'c2',
  C3: 'c3',
  FI: 'fi',
};

export function ObservationCard({ observation, index, onChange, onDelete }: ObservationCardProps) {
  const updateField = (field: keyof Observation, value: string | string[]) => {
    onChange(index, { ...observation, [field]: value });
  };

  const isLinkedToSchedule = !!observation.schedule_item;

  return (
    <div
      className={`glass-card border-l-[3px] ${severityBorderColors[observation.code] || 'border-l-brand-blue'} p-4 space-y-3`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <select
            id={`obs-code-${index}`}
            aria-label="Observation severity code"
            value={observation.code}
            onChange={(e) => updateField('code', e.target.value as Observation['code'])}
            className="h-10 w-16 rounded-full font-bold text-center appearance-none cursor-pointer bg-L2 border border-white/10 text-foreground text-sm"
          >
            <option value="C1">C1</option>
            <option value="C2">C2</option>
            <option value="C3">C3</option>
            <option value="FI">FI</option>
          </select>
          <div>
            <StatusBadge status={severityBadgeStatus[observation.code] || 'blue'}>
              {codeLabels[observation.code]}
            </StatusBadge>
            {isLinkedToSchedule && (
              <div className="flex items-center gap-1 text-xs text-brand-blue mt-1">
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
          className="text-status-red hover:text-status-red hover:bg-status-red/10"
          aria-label="Delete observation"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Schedule description (if linked) */}
      {observation.schedule_description && (
        <div className="text-sm">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Regulation
          </label>
          <div className="mt-1 px-3 py-2 bg-L2 border border-white/8 rounded-[12px] text-sm text-foreground">
            {observation.schedule_item} - {observation.schedule_description}
          </div>
        </div>
      )}

      <div>
        <label
          htmlFor={`obs-location-${index}`}
          className="text-[11px] uppercase tracking-wider text-muted-foreground"
        >
          Location
        </label>
        <Input
          id={`obs-location-${index}`}
          value={observation.item_location}
          onChange={(e) => updateField('item_location', e.target.value)}
          placeholder="e.g., Kitchen socket, Consumer unit"
          className="mt-1"
        />
      </div>

      <div>
        <label
          htmlFor={`obs-text-${index}`}
          className="text-[11px] uppercase tracking-wider text-muted-foreground"
        >
          Observation
        </label>
        <Textarea
          id={`obs-text-${index}`}
          value={observation.observation_text}
          onChange={(e) => updateField('observation_text', e.target.value)}
          placeholder="Description of the issue..."
          className="mt-1 min-h-[80px]"
          autoResize={false}
        />
      </div>

      <div>
        <label
          htmlFor={`obs-schedule-${index}`}
          className="text-[11px] uppercase tracking-wider text-muted-foreground"
        >
          Schedule Item
        </label>
        <Input
          id={`obs-schedule-${index}`}
          value={observation.schedule_item || ''}
          onChange={(e) => updateField('schedule_item', e.target.value)}
          placeholder="e.g., 4.5, 5.3"
          className="mt-1"
          disabled={isLinkedToSchedule}
        />
        {isLinkedToSchedule && (
          <p className="text-xs text-muted-foreground mt-1">
            This observation is linked from the Inspection Schedule. Deleting it will set the
            schedule item to tick.
          </p>
        )}
      </div>
    </div>
  );
}
