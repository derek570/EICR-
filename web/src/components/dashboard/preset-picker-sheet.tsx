'use client';

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { CertificateDefaultPreset } from '@/lib/defaults/types';

/**
 * Preset picker shown after creating a job when 2+ named presets match
 * the certificate type — web port of iOS `PresetPickerSheet`
 * (CreateCertificateSheet.swift:158-199): "Apply Defaults" title,
 * "Choose which defaults to apply" header, one row per preset (name +
 * certificate type + chevron), Skip as the cancel action.
 *
 * Pure — the dashboard owns the apply/skip/navigate sequence
 * (`applyPickedPreset` / `skipPresetPick` in lib/defaults/job-creation).
 * Skip is the ONLY dismissal (no free-close): the inspector must make
 * an explicit choice so a stray backdrop tap can't leave the flow in
 * an ambiguous half-created state — same reason iOS puts Skip in the
 * toolbar rather than relying on sheet drag-down.
 */
export function PresetPickerSheet({
  open,
  presets,
  onSelect,
  onSkip,
}: {
  open: boolean;
  presets: CertificateDefaultPreset[];
  onSelect: (preset: CertificateDefaultPreset) => void;
  onSkip: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onSkip() : undefined)}>
      <DialogContent
        closeLabel="Skip"
        className="mx-4 w-[calc(100%-2rem)] max-w-md rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-5"
      >
        <DialogTitle>Apply Defaults</DialogTitle>
        <DialogDescription>Choose which defaults to apply</DialogDescription>

        <div className="mt-4 flex flex-col gap-2" role="list" aria-label="Default presets">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="listitem"
              onClick={() => onSelect(preset)}
              className="flex min-h-[56px] items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3 text-left transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                  {preset.name}
                </span>
                <span className="text-[12px] text-[var(--color-text-secondary)]">
                  {preset.certificate_type}
                </span>
              </span>
              <ChevronRight
                className="h-4 w-4 flex-shrink-0 text-[var(--color-text-tertiary)]"
                aria-hidden
              />
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onSkip}
          className="mt-3 w-full rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-3 py-2.5 text-[13px] font-semibold text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-3)]"
        >
          Skip
        </button>
      </DialogContent>
    </Dialog>
  );
}
