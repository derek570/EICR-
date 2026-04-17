'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  Loader2,
  Share2,
} from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { SectionCard } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';

/**
 * PDF tab — mirrors iOS `PDFTab.swift`.
 *
 * Surfaces the "is this certificate ready to publish?" state: hero banner
 * with a status dot (pending or ready), a warnings card listing missing
 * data, and a primary Generate / Preview / Share action row.
 *
 * Data: inferred from the current `job` — checks that every tab that must
 * be populated (installation address + inspection date, at least one
 * board, at least one circuit, at least one staff role) has a value.
 *
 * Generation itself still lives on the backend (`POST /api/pdf/:jobId`).
 * Wiring the actual generation call is deferred to Phase 5 (capture/flows)
 * so this tab today is a read-only status + stub.
 */

type PdfJobShape = {
  installation?: Record<string, unknown>;
  supply?: Record<string, unknown>;
  board?: { boards?: unknown[] } & Record<string, unknown>;
  circuits?: unknown[];
  observations?: unknown[];
  inspector_id?: string;
  authorised_by_id?: string;
  designer_id?: string;
  constructor_id?: string;
};

export default function PdfPage() {
  const { job, certificateType } = useJobContext();
  const data = job as unknown as PdfJobShape;

  const warnings = React.useMemo(
    () => computeWarnings(data, certificateType === 'EIC'),
    [data, certificateType]
  );
  const ready = warnings.length === 0;

  return (
    <div
      className="mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <div
        className="relative flex items-center justify-between overflow-hidden rounded-[var(--radius-xl)] px-5 py-5 md:px-6 md:py-6"
        style={{
          background:
            'linear-gradient(135deg, var(--color-brand-blue) 0%, var(--color-brand-green) 100%)',
        }}
      >
        <div className="flex flex-col gap-2">
          <p className="text-[11px] uppercase tracking-[0.14em] text-white/75">{certificateType}</p>
          <h2 className="text-[22px] font-bold text-white md:text-[26px]">PDF Certificate</h2>
          <p className="text-[13px] text-white/85">Generate, preview &amp; share</p>
          <div className="mt-1 flex items-center gap-2">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                ready ? 'bg-[var(--color-brand-green)]' : 'bg-amber-300'
              )}
              aria-hidden
            />
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/85">
              {ready ? 'Ready to generate' : 'Not yet generated'}
            </span>
          </div>
        </div>
        <FileText className="h-10 w-10 text-white/30" strokeWidth={2} aria-hidden />
      </div>

      {warnings.length > 0 ? (
        <SectionCard accent="amber" icon={AlertTriangle} title="Missing data">
          <ul className="flex flex-col gap-1.5">
            {warnings.map((w) => (
              <li
                key={w}
                className="flex items-start gap-2 text-[13px] text-[var(--color-text-secondary)]"
              >
                <span
                  className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: 'var(--color-status-processing)' }}
                  aria-hidden
                />
                {w}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : (
        <SectionCard accent="green" icon={CheckCircle2} title="All sections complete">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            This certificate has every section populated and is ready to render. Tap{' '}
            <span className="font-semibold">Generate PDF</span> to build the final document.
          </p>
        </SectionCard>
      )}

      <SectionCard accent="blue" icon={FileText} title="Actions">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <ActionButton primary disabled label="Generate PDF" icon={Loader2} />
          <ActionButton disabled label="Preview" icon={Eye} />
          <ActionButton disabled label="Share" icon={Share2} />
        </div>
        <p className="pt-1 text-[11.5px] text-[var(--color-text-tertiary)]">
          PDF generation wires up in Phase 5 — this tab currently shows readiness only.
        </p>
      </SectionCard>
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function computeWarnings(data: PdfJobShape, isEIC: boolean): string[] {
  const w: string[] = [];
  const inst = (data.installation ?? {}) as Record<string, unknown>;
  if (!str(inst.address_line1) && !str(inst.address)) {
    w.push('Installation address not set');
  }
  if (!str(inst.date_of_inspection)) {
    w.push('Inspection date not set');
  }

  const boards = data.board?.boards ?? [];
  if (!Array.isArray(boards) || boards.length === 0) {
    w.push('No boards added (Board tab)');
  }

  const circuits = data.circuits ?? [];
  if (!Array.isArray(circuits) || circuits.length === 0) {
    w.push('No circuits added (Circuits tab)');
  }

  if (isEIC) {
    if (!data.designer_id) w.push('Designer not assigned (Staff tab)');
    if (!data.constructor_id) w.push('Constructor not assigned (Staff tab)');
    if (!data.inspector_id) w.push('Inspection & testing not assigned (Staff tab)');
  } else {
    if (!data.inspector_id) w.push('Inspector not assigned (Staff tab)');
    if (!data.authorised_by_id) w.push('Authoriser not assigned (Staff tab)');
  }

  return w;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function ActionButton({
  label,
  icon: Icon,
  primary,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'flex items-center justify-center gap-2 rounded-[var(--radius-md)] px-4 py-3 text-[14px] font-semibold transition',
        primary
          ? 'bg-[var(--color-brand-blue)] text-white hover:opacity-90'
          : 'border border-[var(--color-border-default)] bg-[var(--color-surface-2)] text-[var(--color-text-primary)] hover:border-[var(--color-border-strong)]',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

// Download icon kept imported so future Phase 5 "Download" button wires up
// without an import churn. Suppress unused-import warning.
void Download;
