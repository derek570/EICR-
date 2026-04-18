'use client';

import * as React from 'react';
import {
  Calculator,
  Camera,
  CircuitBoard,
  FileDown,
  FlipHorizontal2,
  List,
  Loader2,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useJobContext } from '@/lib/job-context';
import { ApiError } from '@/lib/types';
import { applyCcuAnalysisToJob } from '@/lib/recording/apply-ccu-analysis';
import { applyDocumentExtractionToJob } from '@/lib/recording/apply-document-extraction';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { IconButton } from '@/components/ui/icon-button';
import { SectionCard } from '@/components/ui/section-card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SelectChips } from '@/components/ui/select-chips';

/**
 * Circuits tab — mirrors iOS `CircuitsTab.swift` + `Circuit.swift`.
 *
 * iOS renders all 29 circuit fields as a horizontally-scrolling table with
 * a sticky left column. The web rebuild takes a different shape: each
 * circuit is a collapsible card with its fields grouped by concern
 * (Identity, Cable, OCPD, RCD, Test readings). The card view trades
 * side-by-side scanning for much better mobile ergonomics — inspectors
 * overwhelmingly edit one circuit at a time in the field, so we optimise
 * for depth rather than breadth.
 *
 * The right-hand action rail mirrors the iOS "Circuits action rail" exactly:
 *   + Add (blue) · Delete (red) · Apply Defaults (magenta) · Reverse (pink)
 *   · Calculate (green) · CCU Photo (orange) · Extract Doc (blue)
 * Colour tokens match `memory/ios_design_parity.md §"Circuits action rail"`.
 *
 * Data is stored in `job.circuits: CircuitRow[]`. Every field edit calls
 * `updateJob` with a re-built array (immutable update) and flips the dirty
 * flag. Persistence is deferred to Phase 4.
 */

type Circuit = Record<string, string | undefined> & { id: string };

const OCPD_TYPES = [
  { value: 'B', label: 'Type B' },
  { value: 'C', label: 'Type C' },
  { value: 'D', label: 'Type D' },
];

const RCD_TYPES = [
  { value: 'AC', label: 'AC' },
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'F', label: 'F' },
];

const POLARITY_OPTIONS = [
  { value: 'pass', label: 'Pass', variant: 'pass' as const },
  { value: 'fail', label: 'Fail', variant: 'fail' as const },
  { value: 'na', label: 'N/A', variant: 'neutral' as const },
];

function newCircuit(ref: string, boardId?: string): Circuit {
  return {
    id: (globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random()}`).toString(),
    board_id: boardId,
    circuit_ref: ref,
    circuit_designation: '',
  };
}

export default function CircuitsPage() {
  const { job, updateJob } = useJobContext();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [actionHint, setActionHint] = React.useState<string | null>(null);
  const [ccuBusy, setCcuBusy] = React.useState(false);
  const [ccuError, setCcuError] = React.useState<string | null>(null);
  const [ccuQuestions, setCcuQuestions] = React.useState<string[]>([]);
  const ccuInputRef = React.useRef<HTMLInputElement>(null);
  const [docBusy, setDocBusy] = React.useState(false);
  const [docError, setDocError] = React.useState<string | null>(null);
  const docInputRef = React.useRef<HTMLInputElement>(null);

  const circuits = (job.circuits ?? []) as unknown as Circuit[];
  const boards = ((job.board as { boards?: { id: string; designation?: string }[] } | undefined)
    ?.boards ?? []) as { id: string; designation?: string }[];
  const [selectedBoardId, setSelectedBoardId] = React.useState<string | null>(
    boards[0]?.id ?? null
  );

  const visible = selectedBoardId
    ? circuits.filter((c) => c.board_id === selectedBoardId || c.board_id == null)
    : circuits;

  const persist = (next: Circuit[]) =>
    updateJob({ circuits: next as unknown as typeof job.circuits });

  const patchCircuit = (id: string, patch: Partial<Circuit>) => {
    persist(circuits.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const addCircuit = () => {
    const nextRef = String(visible.length + 1);
    const c = newCircuit(nextRef, selectedBoardId ?? undefined);
    persist([...circuits, c]);
    setExpandedId(c.id);
  };

  const removeCircuit = (id: string) => {
    persist(circuits.filter((c) => c.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  const reverse = () => persist([...circuits].reverse());

  const stub = (label: string) => () => setActionHint(`${label} — wires up in Phase 5.`);

  const openCcuPicker = () => {
    setCcuError(null);
    ccuInputRef.current?.click();
  };

  const handleCcuFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input immediately so the same file can be chosen again
    // after a failure (otherwise onChange won't fire a second time).
    event.target.value = '';
    if (!file) return;

    setCcuBusy(true);
    setCcuError(null);
    setActionHint('Analysing consumer unit…');
    try {
      const analysis = await api.analyzeCCU(file);
      const { patch, questions } = applyCcuAnalysisToJob(job, analysis, {
        targetBoardId: selectedBoardId,
      });
      updateJob(patch);
      // If we just synthesised a board, surface it as the active one
      // so the new circuits are visible under the selector.
      const patchedBoards = (patch.board as { boards?: { id: string }[] } | undefined)?.boards;
      if (!selectedBoardId && patchedBoards && patchedBoards.length > 0) {
        setSelectedBoardId(patchedBoards[0].id);
      }
      const added = analysis.circuits?.length ?? 0;
      setActionHint(
        added > 0
          ? `CCU analysed — ${added} circuit${added === 1 ? '' : 's'} merged.`
          : 'CCU analysed — no circuits detected.'
      );
      setCcuQuestions(questions);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `Analysis failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Analysis failed.';
      setCcuError(message);
      setActionHint(null);
    } finally {
      setCcuBusy(false);
    }
  };

  const dismissQuestion = (idx: number) => {
    setCcuQuestions((prev) => prev.filter((_, i) => i !== idx));
  };

  const openDocPicker = () => {
    setDocError(null);
    docInputRef.current?.click();
  };

  const handleDocFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setDocBusy(true);
    setDocError(null);
    setActionHint('Reading document…');
    try {
      const response = await api.analyzeDocument(file);
      const { patch, summary } = applyDocumentExtractionToJob(job, response, {
        targetBoardId: selectedBoardId,
      });
      updateJob(patch);
      // If the extractor just synthesised a board, surface it as the
      // active one so the new circuits land under a visible selector.
      const patchedBoards = (patch.board as { boards?: { id: string }[] } | undefined)?.boards;
      if (!selectedBoardId && patchedBoards && patchedBoards.length > 0) {
        setSelectedBoardId(patchedBoards[0].id);
      }
      const bits: string[] = [];
      if (summary.circuits > 0) {
        bits.push(`${summary.circuits} circuit${summary.circuits === 1 ? '' : 's'}`);
      }
      if (summary.observations > 0) {
        bits.push(`${summary.observations} observation${summary.observations === 1 ? '' : 's'}`);
      }
      setActionHint(
        bits.length > 0
          ? `Document read — ${bits.join(', ')} merged.`
          : 'Document read — no new data.'
      );
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `Extraction failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Extraction failed.';
      setDocError(message);
      setActionHint(null);
    } finally {
      setDocBusy(false);
    }
  };

  return (
    <div
      className="mx-auto flex w-full flex-col gap-4 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '1080px' }}
    >
      {/* Board selector */}
      {boards.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          {boards.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelectedBoardId(b.id)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
                selectedBoardId === b.id
                  ? 'bg-[var(--color-brand-blue)] text-white'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <CircuitBoard className="h-3.5 w-3.5" aria-hidden />
              {b.designation ?? b.id.slice(0, 6)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex gap-4 md:gap-5">
        {/* Circuit list column */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
              <Zap className="h-3.5 w-3.5 text-[var(--color-brand-blue)]" aria-hidden />
              Circuits
            </h2>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {visible.length} {visible.length === 1 ? 'circuit' : 'circuits'}
            </span>
          </div>

          {/* Hidden file input for CCU capture. `capture="environment"`
              is the iOS Safari hint to open the rear camera; the
              browser falls back to the library picker if the user
              denies camera permission. */}
          <input
            ref={ccuInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleCcuFile}
            className="sr-only"
            aria-hidden
          />

          {/* Doc extraction picker — no `capture` hint because
              documents (prior certs, handwritten sheets) are usually
              photographed ahead of time and a library picker is more
              ergonomic. Image only: the backend (/api/analyze-document)
              hard-codes the image/jpeg data URL so PDFs can't be
              rendered server-side. PDF support is a separate follow-up
              (requires a client-side pdfjs-dist render). */}
          <input
            ref={docInputRef}
            type="file"
            accept="image/*"
            onChange={handleDocFile}
            className="sr-only"
            aria-hidden
          />

          {actionHint ? (
            <p
              className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]"
              role="status"
            >
              {actionHint}
            </p>
          ) : null}

          {ccuError ? (
            <p
              className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-[12px] text-[var(--color-status-failed)]"
              role="alert"
            >
              {ccuError}
            </p>
          ) : null}

          {docError ? (
            <p
              className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-[12px] text-[var(--color-status-failed)]"
              role="alert"
            >
              {docError}
            </p>
          ) : null}

          {ccuQuestions.length > 0 ? (
            <ul
              className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3"
              aria-label="CCU questions for inspector"
            >
              {ccuQuestions.map((q, i) => (
                <li
                  key={`${i}-${q.slice(0, 32)}`}
                  className="flex items-start justify-between gap-2 text-[12px] text-[var(--color-text-primary)]"
                >
                  <span className="flex-1">{q}</span>
                  {/* D8: 44×44 (was 20×20 — h-5 w-5). Hit area expands into
                   * the row padding; visible glyph is unchanged at 12px. */}
                  <IconButton
                    onClick={() => dismissQuestion(i)}
                    aria-label="Dismiss question"
                    className="flex-shrink-0 text-[var(--color-text-tertiary)]"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}

          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-1)] px-6 py-10 text-center">
              <List className="h-8 w-8 text-[var(--color-text-tertiary)]" aria-hidden />
              <p className="text-[13px] text-[var(--color-text-secondary)]">
                No circuits yet. Tap &ldquo;Add&rdquo; on the action rail to create one, or use CCU
                Photo to auto-populate from a consumer-unit image.
              </p>
            </div>
          ) : (
            visible.map((c) => (
              <CircuitCard
                key={c.id}
                circuit={c}
                expanded={expandedId === c.id}
                onToggle={() => setExpandedId((p) => (p === c.id ? null : c.id))}
                onPatch={(patch) => patchCircuit(c.id, patch)}
                onRemove={() => removeCircuit(c.id)}
              />
            ))
          )}
        </div>

        {/* Action rail — iOS parity */}
        <aside className="flex w-24 flex-shrink-0 flex-col gap-2 md:w-28">
          <RailButton
            Icon={Plus}
            label="Add"
            colour="var(--color-brand-blue)"
            onClick={addCircuit}
          />
          <RailButton
            Icon={Trash2}
            label="Delete"
            colour="var(--color-status-failed)"
            onClick={stub('Delete all')}
          />
          <RailButton
            Icon={SlidersHorizontal}
            label="Defaults"
            colour="#ff375f"
            onClick={stub('Apply defaults')}
          />
          <RailButton Icon={FlipHorizontal2} label="Reverse" colour="#ec4899" onClick={reverse} />
          <RailButton
            Icon={Calculator}
            label="Calculate"
            colour="var(--color-brand-green)"
            onClick={stub('Calculate Zs / R1+R2')}
          />
          <RailButton
            Icon={ccuBusy ? Loader2 : Camera}
            label={ccuBusy ? 'Analysing' : 'CCU'}
            colour="#ff9f0a"
            onClick={openCcuPicker}
            disabled={ccuBusy}
            spin={ccuBusy}
          />
          <RailButton
            Icon={docBusy ? Loader2 : FileDown}
            label={docBusy ? 'Reading' : 'Extract'}
            colour="var(--color-brand-blue)"
            onClick={openDocPicker}
            disabled={docBusy}
            spin={docBusy}
          />
        </aside>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function RailButton({
  Icon,
  label,
  colour,
  onClick,
  disabled,
  spin,
}: {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  label: string;
  colour: string;
  onClick: () => void;
  disabled?: boolean;
  spin?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center gap-1 rounded-[var(--radius-md)] px-2 py-2 text-white shadow-[0_4px_12px_rgba(0,0,0,0.35)] transition active:scale-95 ${
        disabled ? 'cursor-not-allowed opacity-60' : ''
      }`}
      style={{ background: colour }}
    >
      <Icon className={`h-5 w-5 ${spin ? 'animate-spin' : ''}`} strokeWidth={2.25} aria-hidden />
      <span className="text-[10px] font-bold uppercase tracking-[0.04em]">{label}</span>
    </button>
  );
}

function CircuitCard({
  circuit,
  expanded,
  onToggle,
  onPatch,
  onRemove,
}: {
  circuit: Circuit;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<Circuit>) => void;
  onRemove: () => void;
}) {
  const text = (k: keyof Circuit) => circuit[k] ?? '';
  const ref = text('circuit_ref') || '—';
  const designation = text('circuit_designation') || 'Untitled circuit';
  const rating = text('ocpd_rating_a');

  return (
    <article className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]">
      <header className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <span
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-blue)]/15 text-[13px] font-bold text-[var(--color-brand-blue)]"
            aria-hidden
          >
            {ref}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
              {designation}
            </span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {text('wiring_type') || 'no cable set'} · {rating ? `${rating} A` : 'no OCPD set'}
            </span>
          </span>
        </button>
        {/* D8: 44×44 (was 32×32 — h-8 w-8). Destructive variant styling
         * matches the old bespoke red; hit area now WCAG-compliant. */}
        <IconButton
          variant="destructive"
          onClick={onRemove}
          aria-label={`Remove circuit ${ref}`}
          className="flex-shrink-0"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </IconButton>
      </header>

      {expanded ? (
        <div className="flex flex-col gap-4 border-t border-[var(--color-border-subtle)] p-4">
          <SectionCard accent="blue" title="Identity">
            <div className="grid gap-3 md:grid-cols-2">
              <FloatingLabelInput
                label="Circuit ref"
                value={text('circuit_ref')}
                onChange={(e) => onPatch({ circuit_ref: e.target.value })}
              />
              <FloatingLabelInput
                label="Designation"
                value={text('circuit_designation')}
                onChange={(e) => onPatch({ circuit_designation: e.target.value })}
              />
              <FloatingLabelInput
                label="Number of points"
                inputMode="numeric"
                value={text('number_of_points')}
                onChange={(e) => onPatch({ number_of_points: e.target.value })}
              />
              <FloatingLabelInput
                label="Max disconnect time (s)"
                inputMode="decimal"
                value={text('max_disconnect_time_s')}
                onChange={(e) => onPatch({ max_disconnect_time_s: e.target.value })}
              />
            </div>
          </SectionCard>

          <SectionCard accent="blue" title="Cable">
            <div className="grid gap-3 md:grid-cols-2">
              <FloatingLabelInput
                label="Wiring type"
                value={text('wiring_type')}
                onChange={(e) => onPatch({ wiring_type: e.target.value })}
              />
              <FloatingLabelInput
                label="Reference method"
                value={text('ref_method')}
                onChange={(e) => onPatch({ ref_method: e.target.value })}
              />
              <FloatingLabelInput
                label="Live CSA (mm²)"
                inputMode="decimal"
                value={text('live_csa_mm2')}
                onChange={(e) => onPatch({ live_csa_mm2: e.target.value })}
              />
              <FloatingLabelInput
                label="CPC CSA (mm²)"
                inputMode="decimal"
                value={text('cpc_csa_mm2')}
                onChange={(e) => onPatch({ cpc_csa_mm2: e.target.value })}
              />
            </div>
          </SectionCard>

          <SectionCard accent="amber" title="OCPD">
            <div className="grid gap-3 md:grid-cols-2">
              <FloatingLabelInput
                label="BS EN"
                value={text('ocpd_bs_en')}
                onChange={(e) => onPatch({ ocpd_bs_en: e.target.value })}
              />
              <SelectChips
                label="Type"
                value={text('ocpd_type') || null}
                options={OCPD_TYPES}
                onChange={(v) => onPatch({ ocpd_type: v })}
              />
              <FloatingLabelInput
                label="Rating (A)"
                inputMode="decimal"
                value={text('ocpd_rating_a')}
                onChange={(e) => onPatch({ ocpd_rating_a: e.target.value })}
              />
              <FloatingLabelInput
                label="Breaking capacity (kA)"
                inputMode="decimal"
                value={text('ocpd_breaking_capacity_ka')}
                onChange={(e) => onPatch({ ocpd_breaking_capacity_ka: e.target.value })}
              />
              <FloatingLabelInput
                label="Max Zs (Ω)"
                inputMode="decimal"
                value={text('ocpd_max_zs_ohm')}
                onChange={(e) => onPatch({ ocpd_max_zs_ohm: e.target.value })}
              />
            </div>
          </SectionCard>

          <SectionCard accent="amber" title="RCD">
            <div className="grid gap-3 md:grid-cols-2">
              <FloatingLabelInput
                label="BS EN"
                value={text('rcd_bs_en')}
                onChange={(e) => onPatch({ rcd_bs_en: e.target.value })}
              />
              <SelectChips
                label="Type"
                value={text('rcd_type') || null}
                options={RCD_TYPES}
                onChange={(v) => onPatch({ rcd_type: v })}
              />
              <FloatingLabelInput
                label="Operating current (mA)"
                inputMode="decimal"
                value={text('rcd_operating_current_ma')}
                onChange={(e) => onPatch({ rcd_operating_current_ma: e.target.value })}
              />
              <FloatingLabelInput
                label="Rating (A)"
                inputMode="decimal"
                value={text('rcd_rating_a')}
                onChange={(e) => onPatch({ rcd_rating_a: e.target.value })}
              />
            </div>
          </SectionCard>

          <SectionCard accent="green" title="Test readings">
            <div className="grid gap-3 md:grid-cols-3">
              <FloatingLabelInput
                label="Ring R1 (Ω)"
                inputMode="decimal"
                value={text('ring_r1_ohm')}
                onChange={(e) => onPatch({ ring_r1_ohm: e.target.value })}
              />
              <FloatingLabelInput
                label="Ring Rn (Ω)"
                inputMode="decimal"
                value={text('ring_rn_ohm')}
                onChange={(e) => onPatch({ ring_rn_ohm: e.target.value })}
              />
              <FloatingLabelInput
                label="Ring R2 (Ω)"
                inputMode="decimal"
                value={text('ring_r2_ohm')}
                onChange={(e) => onPatch({ ring_r2_ohm: e.target.value })}
              />
              <FloatingLabelInput
                label="R1+R2 (Ω)"
                inputMode="decimal"
                value={text('r1_r2_ohm')}
                onChange={(e) => onPatch({ r1_r2_ohm: e.target.value })}
              />
              <FloatingLabelInput
                label="R2 (Ω)"
                inputMode="decimal"
                value={text('r2_ohm')}
                onChange={(e) => onPatch({ r2_ohm: e.target.value })}
              />
              <FloatingLabelInput
                label="Measured Zs (Ω)"
                inputMode="decimal"
                value={text('measured_zs_ohm')}
                onChange={(e) => onPatch({ measured_zs_ohm: e.target.value })}
              />
              <FloatingLabelInput
                label="IR test voltage (V)"
                inputMode="decimal"
                value={text('ir_test_voltage_v')}
                onChange={(e) => onPatch({ ir_test_voltage_v: e.target.value })}
              />
              <FloatingLabelInput
                label="IR L-L (MΩ)"
                inputMode="decimal"
                value={text('ir_live_live_mohm')}
                onChange={(e) => onPatch({ ir_live_live_mohm: e.target.value })}
              />
              <FloatingLabelInput
                label="IR L-E (MΩ)"
                inputMode="decimal"
                value={text('ir_live_earth_mohm')}
                onChange={(e) => onPatch({ ir_live_earth_mohm: e.target.value })}
              />
              <FloatingLabelInput
                label="RCD time (ms)"
                inputMode="decimal"
                value={text('rcd_time_ms')}
                onChange={(e) => onPatch({ rcd_time_ms: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                Polarity
              </label>
              <SegmentedControl
                aria-label="Polarity confirmed"
                value={text('polarity_confirmed') || null}
                onChange={(v) => onPatch({ polarity_confirmed: v })}
                options={POLARITY_OPTIONS}
              />
            </div>
          </SectionCard>
        </div>
      ) : null}
    </article>
  );
}
