'use client';

import * as React from 'react';
import { X, FileText, ArrowRight } from 'lucide-react';
import { useCurrentUser } from '@/lib/use-current-user';
import { usePresets } from '@/lib/defaults/hooks';
import type { CertificateDefaultPreset } from '@/lib/defaults/types';

/**
 * ApplyDefaultsSheet — port of iOS `ApplyDefaultsSheet.swift`.
 *
 * Modal preset picker. Filters presets by the current job's
 * certificate type (EICR/EIC) so the inspector doesn't accidentally
 * apply an EIC preset to an EICR job.
 *
 * iOS canon copy: "Apply Preset" title, "No Saved Presets" empty
 * state pointing to the Defaults manager.
 */
export interface ApplyDefaultsSheetProps {
  open: boolean;
  certificateType: string;
  onClose: () => void;
  onApply: (preset: CertificateDefaultPreset) => void;
}

export function ApplyDefaultsSheet({
  open,
  certificateType,
  onClose,
  onApply,
}: ApplyDefaultsSheetProps) {
  const { user } = useCurrentUser();
  const { presets, loading, error } = usePresets(open ? user?.id : undefined, certificateType);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="apply-defaults-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-md flex-col bg-[var(--color-surface-1)] sm:rounded-[var(--radius-lg)] sm:border sm:border-[var(--color-border-subtle)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
          <span
            id="apply-defaults-title"
            className="text-[16px] font-semibold text-[var(--color-text-primary)]"
          >
            Apply Preset
          </span>
          <button
            type="button"
            onClick={onClose}
            className="cm-tap-target rounded-full p-1.5 text-[var(--color-text-tertiary)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="py-6 text-center text-[var(--color-text-tertiary)]">
              Loading presets…
            </div>
          ) : error ? (
            <div className="rounded-[var(--radius-md)] border border-[color:color-mix(in_oklab,var(--color-status-failed)_30%,transparent)] bg-[color:color-mix(in_oklab,var(--color-status-failed)_8%,transparent)] p-3 text-[13px] text-[var(--color-status-failed)]">
              {error}
            </div>
          ) : presets.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-full"
                style={{
                  background: 'color-mix(in oklab, var(--color-brand-blue) 12%, transparent)',
                  color: 'var(--color-brand-blue)',
                }}
              >
                <FileText className="h-6 w-6" aria-hidden />
              </div>
              <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                No Saved Presets
              </span>
              <p className="px-4 text-[12px] text-[var(--color-text-secondary)]">
                Create presets from the Default Values manager first.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onApply(p);
                      onClose();
                    }}
                    className="flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3 text-left transition hover:bg-[var(--color-surface-3)]"
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
                      style={{
                        background: 'color-mix(in oklab, var(--color-brand-blue) 12%, transparent)',
                        color: 'var(--color-brand-blue)',
                      }}
                    >
                      <FileText className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                        {p.name}
                      </span>
                      <span className="text-[12px] text-[var(--color-text-secondary)]">
                        {p.certificate_type}
                      </span>
                    </span>
                    <ArrowRight className="h-5 w-5 text-[var(--color-brand-blue)]" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
