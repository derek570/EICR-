'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileText,
  Loader2,
  Share2,
  Sparkles,
  Trash2,
  XOctagon,
} from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PdfPreview } from '@/components/job/pdf-preview';
import { api } from '@/lib/api-client';
import { ApiError } from '@/lib/types';
import { getUser } from '@/lib/auth';
import { downloadBlob } from '@certmate/shared-utils';
import { cn } from '@/lib/utils';

/**
 * PDF tab — mirrors iOS `PDFTab.swift`.
 *
 * Surfaces the "is this certificate ready to publish?" state: hero banner
 * with a pulsing status dot (green once generated this session, amber
 * otherwise), a warnings card listing any missing data, and the
 * Generate / Preview / Share / Delete action row.
 *
 * Generation pipeline (Phase 2, matches iOS behaviour):
 *   1. Click Generate → `POST /api/job/:userId/:jobId/generate-pdf`.
 *      Backend returns raw PDF bytes (`application/pdf`).
 *   2. Bytes are wrapped in a `Blob` and held in component state for the
 *      session. We intentionally do NOT persist the Blob anywhere —
 *      iOS re-generates each time (`PDFTab.swift:L270-L292`) so the
 *      web tab does the same. This also means a navigation away +
 *      back returns to the amber "not yet generated" state, matching
 *      the iOS tab on re-entry.
 *   3. PdfPreview renders the Blob via an object URL in an iframe;
 *      URL lifecycle is owned by that component.
 *   4. Share uses the Web Share API (`navigator.canShare` + a `File`
 *      payload) on supported browsers; falls back to an anchor
 *      download on desktop Safari / Firefox where Web Share for files
 *      is unsupported.
 *   5. Delete is session-scoped — discards the Blob and flips the
 *      hero dot back to amber.
 *
 * Warnings card:
 *   Computed client-side from the same `job` object the tabs edit.
 *   The iOS equivalent (`JobViewModel.pdfWarnings()`) covers a smaller
 *   surface — company-details-configured and inspector-selected — but
 *   the web list is intentionally richer (installation address,
 *   inspection date, at least one board / circuit, staff role
 *   assignment per certificate type). Richer warnings help the web
 *   inspector catch tab-level omissions before hitting Generate;
 *   iOS users typically complete tabs linearly and don't need the
 *   granularity.
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
  const params = useParams<{ id: string }>();
  const jobId = params?.id ?? '';
  const userId = React.useMemo(() => getUser()?.id ?? null, []);

  const data = job as unknown as PdfJobShape;

  const warnings = React.useMemo(
    () => computeWarnings(data, certificateType === 'EIC'),
    [data, certificateType]
  );

  // Session-scoped PDF state. The Blob intentionally does not persist
  // across tab navigation — see class doc above. `error` carries the
  // last backend error so the "try again" card can render it.
  const [pdfBlob, setPdfBlob] = React.useState<Blob | null>(null);
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const previewRef = React.useRef<HTMLDivElement | null>(null);

  const hasPdf = pdfBlob !== null;

  const filename = `${certificateType}_${jobId}.pdf`;

  const handleGenerate = React.useCallback(async () => {
    if (!userId || !jobId || isGenerating) return;
    setIsGenerating(true);
    setError(null);
    try {
      const blob = await api.generatePdf(userId, jobId);
      setPdfBlob(blob);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'PDF generation failed';
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  }, [userId, jobId, isGenerating]);

  const handleScrollToPreview = React.useCallback(() => {
    previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleShare = React.useCallback(async () => {
    if (!pdfBlob) return;
    const file = new File([pdfBlob], filename, { type: 'application/pdf' });

    let canShareFiles = false;
    try {
      canShareFiles =
        typeof navigator !== 'undefined' &&
        typeof navigator.canShare === 'function' &&
        typeof navigator.share === 'function' &&
        navigator.canShare({ files: [file] });
    } catch {
      // canShare can throw on non-secure origins — treat as "unsupported".
      canShareFiles = false;
    }

    if (!canShareFiles) {
      downloadBlob(pdfBlob, filename);
      return;
    }

    try {
      await navigator.share({ files: [file], title: `${certificateType} Certificate` });
    } catch (err) {
      // User cancelled the native share sheet (AbortError) or the OS
      // denied the share — do NOT silently fall through to a download,
      // which would save a file the user just declined to share.
      if (err instanceof Error && err.name === 'AbortError') return;
      // Any other share error: surface via download fallback so the
      // user can still get the file out.
      downloadBlob(pdfBlob, filename);
    }
  }, [pdfBlob, filename, certificateType]);

  const handleConfirmDelete = React.useCallback(() => {
    setPdfBlob(null);
    setError(null);
    setConfirmDelete(false);
  }, []);

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroBanner certificateType={certificateType} hasPdf={hasPdf} isGenerating={isGenerating} />

      {warnings.length > 0 ? (
        <SectionCard accent="test-results" icon={AlertTriangle} title="Missing data">
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

      {error ? (
        <SectionCard accent="red" icon={XOctagon} title="Generation failed">
          <p className="text-[13px] text-[var(--color-status-failed)]">{error}</p>
          <div>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isGenerating}
              className={cn(
                'inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-status-failed)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-status-failed)] transition hover:bg-[var(--color-status-failed)]/10',
                isGenerating && 'cursor-not-allowed opacity-50'
              )}
            >
              Try again
            </button>
          </div>
        </SectionCard>
      ) : null}

      {/* Actions card — "generating" overlay scoped to this card so other
          tabs stay interactive (the tab nav lives outside this tree). */}
      <div className="relative">
        <SectionCard accent="board" icon={Sparkles} title="Actions">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <GenerateButton
              onClick={handleGenerate}
              isGenerating={isGenerating}
              label={hasPdf ? 'Regenerate PDF' : 'Generate PDF'}
            />
            <SecondaryActionButton
              onClick={handleScrollToPreview}
              disabled={!hasPdf}
              icon={Eye}
              label="Preview PDF"
            />
            <SecondaryActionButton
              onClick={handleShare}
              disabled={!hasPdf}
              icon={Share2}
              label="Share PDF"
            />
            <SecondaryActionButton
              onClick={() => setConfirmDelete(true)}
              disabled={!hasPdf}
              icon={Trash2}
              label="Delete"
              variant="danger"
            />
          </div>
        </SectionCard>

        {isGenerating ? (
          <div
            className="absolute inset-0 flex items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-surface-1)]/80 backdrop-blur-sm"
            aria-live="polite"
            aria-busy
          >
            <div className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-6 py-5 shadow-lg">
              <Loader2
                className="h-6 w-6 animate-spin text-[var(--color-brand-blue)]"
                aria-hidden
              />
              <p className="text-[13px] font-medium text-[var(--color-text-primary)]">
                Generating PDF…
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {hasPdf ? (
        <div ref={previewRef}>
          <SectionCard accent="blue" icon={FileText} title="Preview">
            <div
              className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-white"
              style={{ height: '70vh', minHeight: '520px' }}
            >
              <PdfPreview blob={pdfBlob!} />
            </div>
          </SectionCard>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Discard the generated PDF?"
        description="The file will be cleared from this session. You can regenerate it at any time."
        confirmLabel="Discard"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * HeroBanner — keep the gradient banner inline rather than using the
 * shared `<HeroHeader>` primitive because this banner needs the
 * iOS-style pulsing status dot (generated vs not-yet-generated) which
 * the shared hero does not expose. The gradient, padding, and typography
 * stay byte-identical to the shared hero so the two banners are visually
 * interchangeable.
 */
function HeroBanner({
  certificateType,
  hasPdf,
  isGenerating,
}: {
  certificateType: string;
  hasPdf: boolean;
  isGenerating: boolean;
}) {
  const statusLabel = isGenerating ? 'Generating…' : hasPdf ? 'PDF generated' : 'Not yet generated';

  return (
    <HeroHeader
      eyebrow={certificateType}
      title="PDF Certificate"
      subtitle="Generate, preview & share"
      accent="test-results"
      icon={<FileText className="h-10 w-10" strokeWidth={2} aria-hidden />}
    >
      <div className="mt-1 flex items-center gap-2">
        <StatusDot hasPdf={hasPdf} />
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/85">
          {statusLabel}
        </span>
      </div>
    </HeroHeader>
  );
}

/**
 * StatusDot — pulsing amber dot until the session has a generated PDF,
 * then a solid brand-green dot. Mirrors
 * `PDFTab.swift:L86-L104` — SwiftUI uses a `.easeOut(duration: 1.5)`
 * repeating animation on a stroked overlay. Here we use Tailwind's
 * `animate-ping` on an absolutely-positioned ring span so the resting
 * dot stays sharp underneath.
 */
function StatusDot({ hasPdf }: { hasPdf: boolean }) {
  if (hasPdf) {
    return (
      <span aria-hidden className="relative inline-flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--color-brand-green)]" />
      </span>
    );
  }
  return (
    <span aria-hidden className="relative inline-flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-300" />
    </span>
  );
}

function GenerateButton({
  onClick,
  isGenerating,
  label,
}: {
  onClick: () => void;
  isGenerating: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isGenerating}
      className={cn(
        'group relative flex items-center justify-center gap-2 overflow-hidden rounded-[var(--radius-md)] px-4 py-3 text-[14px] font-semibold text-white transition',
        'shadow-[0_8px_24px_-12px_var(--color-brand-green)]',
        isGenerating && 'cursor-not-allowed opacity-60'
      )}
      style={{
        background:
          'linear-gradient(90deg, var(--color-brand-green) 0%, var(--color-brand-blue) 100%)',
      }}
    >
      {isGenerating ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Sparkles className="h-4 w-4" aria-hidden />
      )}
      {isGenerating ? 'Generating…' : label}
    </button>
  );
}

function SecondaryActionButton({
  onClick,
  disabled,
  icon: Icon,
  label,
  variant = 'default',
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  variant?: 'default' | 'danger';
}) {
  const danger = variant === 'danger';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center justify-center gap-2 rounded-[var(--radius-md)] border px-4 py-3 text-[14px] font-semibold transition',
        danger
          ? 'border-[var(--color-status-failed)]/40 bg-transparent text-[var(--color-status-failed)] hover:bg-[var(--color-status-failed)]/10'
          : 'border-[var(--color-border-default)] bg-[var(--color-surface-2)] text-[var(--color-text-primary)] hover:border-[var(--color-border-strong)]',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
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
