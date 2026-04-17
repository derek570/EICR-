'use client';

import * as React from 'react';
import {
  Calculator,
  Camera,
  CircuitBoard,
  FileDown,
  FlipHorizontal2,
  List,
  Plus,
  SlidersHorizontal,
  Trash2,
  Zap,
} from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
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

          {actionHint ? (
            <p
              className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]"
              role="status"
            >
              {actionHint}
            </p>
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
          <RailButton Icon={Camera} label="CCU" colour="#ff9f0a" onClick={stub('CCU photo')} />
          <RailButton
            Icon={FileDown}
            label="Extract"
            colour="var(--color-brand-blue)"
            onClick={stub('Extract doc')}
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
}: {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  label: string;
  colour: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-[var(--radius-md)] px-2 py-2 text-white shadow-[0_4px_12px_rgba(0,0,0,0.35)] transition active:scale-95"
      style={{ background: colour }}
    >
      <Icon className="h-5 w-5" strokeWidth={2.25} aria-hidden />
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
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove circuit ${ref}`}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-status-failed)]/80 transition hover:bg-[var(--color-status-failed)]/10 hover:text-[var(--color-status-failed)]"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
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
