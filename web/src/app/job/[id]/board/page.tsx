'use client';

import * as React from 'react';
import { Boxes, Cable, CircuitBoard, MapPin, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { SectionCard } from '@/components/ui/section-card';
import { SelectChips } from '@/components/ui/select-chips';

/**
 * Board tab — mirrors iOS `BoardTab.swift` + `BoardInfo.swift`.
 *
 * iOS supports multiple boards per job (main + sub-distribution); the web
 * stores the list in `job.board.boards`. We default to a single synthesized
 * main board if the array is empty so inspectors can start filling straight
 * away. Adding / removing boards is a Phase 3a feature — the full parent /
 * sub-main hierarchy editing lands with Phase 3b (Circuits) because that's
 * when the feed-circuit reference actually matters.
 *
 * Fields mapped 1-1 with `BoardInfo` (snake_case keys):
 *   designation, name, location, manufacturer, phases, earthing_arrangement,
 *   ze, zs_at_db, ipf_at_db, main_switch_bs_en, voltage_rating, rated_current,
 *   rcd_rating_ma, rcd_trip_time, spd_type, spd_status, notes.
 */

type BoardRecord = Record<string, string | undefined> & {
  id: string;
  board_type?: 'main' | 'sub_distribution' | 'sub_main';
};

type BoardShape = {
  boards?: BoardRecord[];
};

const BOARD_TYPE_OPTIONS = [
  { value: 'main', label: 'Main board' },
  { value: 'sub_distribution', label: 'Sub-distribution' },
  { value: 'sub_main', label: 'Sub-main' },
];

const PHASES_OPTIONS = [
  { value: 'Single', label: 'Single-phase' },
  { value: 'Three', label: 'Three-phase' },
];

const EARTHING_OPTIONS = [
  { value: 'TN-S', label: 'TN-S' },
  { value: 'TN-C-S', label: 'TN-C-S' },
  { value: 'TT', label: 'TT' },
  { value: 'IT', label: 'IT' },
];

function newBoard(designation = 'DB1'): BoardRecord {
  return {
    id: (globalThis.crypto?.randomUUID?.() ?? `board-${Date.now()}`).toString(),
    designation,
    board_type: 'main',
  };
}

export default function BoardPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const boardState = (job.board ?? {}) as BoardShape;
  const boards =
    boardState.boards && boardState.boards.length > 0 ? boardState.boards : [newBoard()];

  const [activeId, setActiveId] = React.useState(boards[0].id);
  const active = boards.find((b) => b.id === activeId) ?? boards[0];

  const persistBoards = (next: BoardRecord[]) => {
    updateJob({ board: { ...boardState, boards: next } });
  };

  const patchActive = (patch: Partial<BoardRecord>) => {
    const next = boards.map((b) => (b.id === active.id ? { ...b, ...patch } : b));
    persistBoards(next);
  };

  const addBoard = () => {
    const b = newBoard(`DB${boards.length + 1}`);
    persistBoards([...boards, b]);
    setActiveId(b.id);
  };

  const removeActive = () => {
    if (boards.length <= 1) return;
    const remaining = boards.filter((b) => b.id !== active.id);
    persistBoards(remaining);
    setActiveId(remaining[0].id);
  };

  const text = (k: keyof BoardRecord) => (active[k] as string | undefined) ?? '';

  return (
    <div
      className="mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroBanner certificateType={certificateType} count={boards.length} />

      {/* Board selector pills */}
      <div className="flex flex-wrap items-center gap-2">
        {boards.map((b) => {
          const isActive = b.id === active.id;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => setActiveId(b.id)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
                isActive
                  ? 'bg-[var(--color-brand-blue)] text-white'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <CircuitBoard className="h-3.5 w-3.5" aria-hidden />
              {b.designation ?? 'New board'}
            </button>
          );
        })}
        <button
          type="button"
          onClick={addBoard}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-brand-blue)] hover:bg-[var(--color-surface-2)]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add board
        </button>
        {boards.length > 1 ? (
          <button
            type="button"
            onClick={removeActive}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-status-failed)]/40 px-3 py-1.5 text-[12px] font-semibold text-[var(--color-status-failed)] hover:bg-[var(--color-status-failed)]/10"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Remove
          </button>
        ) : null}
      </div>

      <SectionCard accent="blue" icon={Boxes} title="Identity">
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Designation"
            value={text('designation')}
            onChange={(e) => patchActive({ designation: e.target.value })}
          />
          <FloatingLabelInput
            label="Name"
            value={text('name')}
            onChange={(e) => patchActive({ name: e.target.value })}
          />
          <FloatingLabelInput
            label="Manufacturer"
            value={text('manufacturer')}
            onChange={(e) => patchActive({ manufacturer: e.target.value })}
          />
          <FloatingLabelInput
            label="Model"
            value={text('model')}
            onChange={(e) => patchActive({ model: e.target.value })}
          />
        </div>
        <SelectChips
          label="Board type"
          value={active.board_type ?? null}
          options={BOARD_TYPE_OPTIONS}
          onChange={(v) => patchActive({ board_type: v as BoardRecord['board_type'] })}
        />
      </SectionCard>

      <SectionCard accent="blue" icon={MapPin} title="Location">
        <FloatingLabelInput
          label="Location on site"
          value={text('location')}
          onChange={(e) => patchActive({ location: e.target.value })}
        />
        <FloatingLabelInput
          label="Supplied from"
          value={text('supplied_from')}
          onChange={(e) => patchActive({ supplied_from: e.target.value })}
        />
      </SectionCard>

      <SectionCard accent="green" icon={Cable} title="Supply to board">
        <div className="grid gap-3 md:grid-cols-2">
          <SelectChips
            label="Phases"
            value={text('phases') || null}
            options={PHASES_OPTIONS}
            onChange={(v) => patchActive({ phases: v })}
          />
          <SelectChips
            label="Earthing arrangement"
            value={text('earthing_arrangement') || null}
            options={EARTHING_OPTIONS}
            onChange={(v) => patchActive({ earthing_arrangement: v })}
          />
          <FloatingLabelInput
            label="Ze (Ω)"
            inputMode="decimal"
            value={text('ze')}
            onChange={(e) => patchActive({ ze: e.target.value })}
          />
          <FloatingLabelInput
            label="Zs at DB (Ω)"
            inputMode="decimal"
            value={text('zs_at_db')}
            onChange={(e) => patchActive({ zs_at_db: e.target.value })}
          />
          <FloatingLabelInput
            label="Ipf at DB (kA)"
            inputMode="decimal"
            value={text('ipf_at_db')}
            onChange={(e) => patchActive({ ipf_at_db: e.target.value })}
          />
          <FloatingLabelInput
            label="RCD trip time (ms)"
            inputMode="decimal"
            value={text('rcd_trip_time')}
            onChange={(e) => patchActive({ rcd_trip_time: e.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard accent="blue" icon={ShieldCheck} title="Main switch / protection">
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Main switch BS EN"
            value={text('main_switch_bs_en')}
            onChange={(e) => patchActive({ main_switch_bs_en: e.target.value })}
          />
          <FloatingLabelInput
            label="Voltage rating (V)"
            inputMode="decimal"
            value={text('voltage_rating')}
            onChange={(e) => patchActive({ voltage_rating: e.target.value })}
          />
          <FloatingLabelInput
            label="Rated current (A)"
            inputMode="decimal"
            value={text('rated_current')}
            onChange={(e) => patchActive({ rated_current: e.target.value })}
          />
          <FloatingLabelInput
            label="IPF rating (kA)"
            inputMode="decimal"
            value={text('ipf_rating')}
            onChange={(e) => patchActive({ ipf_rating: e.target.value })}
          />
          <FloatingLabelInput
            label="RCD rating (mA)"
            inputMode="decimal"
            value={text('rcd_rating_ma')}
            onChange={(e) => patchActive({ rcd_rating_ma: e.target.value })}
          />
          <FloatingLabelInput
            label="SPD type"
            value={text('spd_type')}
            onChange={(e) => patchActive({ spd_type: e.target.value })}
          />
        </div>
      </SectionCard>

      {active.board_type === 'sub_distribution' || active.board_type === 'sub_main' ? (
        <SectionCard accent="magenta" icon={Cable} title="Sub-main cable">
          <div className="grid gap-3 md:grid-cols-2">
            <FloatingLabelInput
              label="Material"
              value={text('sub_main_cable_material')}
              onChange={(e) => patchActive({ sub_main_cable_material: e.target.value })}
            />
            <FloatingLabelInput
              label="Live CSA (mm²)"
              inputMode="decimal"
              value={text('sub_main_cable_csa')}
              onChange={(e) => patchActive({ sub_main_cable_csa: e.target.value })}
            />
            <FloatingLabelInput
              label="Length (m)"
              inputMode="decimal"
              value={text('sub_main_cable_length')}
              onChange={(e) => patchActive({ sub_main_cable_length: e.target.value })}
            />
            <FloatingLabelInput
              label="CPC CSA (mm²)"
              inputMode="decimal"
              value={text('sub_main_cpc_csa')}
              onChange={(e) => patchActive({ sub_main_cpc_csa: e.target.value })}
            />
            <FloatingLabelInput
              label="Feed circuit ref"
              value={text('feed_circuit_ref')}
              onChange={(e) => patchActive({ feed_circuit_ref: e.target.value })}
            />
          </div>
        </SectionCard>
      ) : null}

      <SectionCard accent="amber" icon={CircuitBoard} title="Notes" showCodeChip>
        <textarea
          value={text('notes')}
          onChange={(e) => patchActive({ notes: e.target.value })}
          rows={3}
          placeholder="Anything the PDF should surface verbatim about this board."
          className="w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-2 text-[15px] font-medium text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]/60 focus:border-[var(--color-brand-blue)] focus:outline-none"
        />
      </SectionCard>
    </div>
  );
}

function HeroBanner({
  certificateType,
  count,
}: {
  certificateType: 'EICR' | 'EIC';
  count: number;
}) {
  return (
    <div
      className="relative flex items-center justify-between overflow-hidden rounded-[var(--radius-xl)] px-5 py-5 md:px-6 md:py-6"
      style={{
        background:
          'linear-gradient(135deg, var(--color-brand-blue) 0%, var(--color-brand-green) 100%)',
      }}
    >
      <div className="flex flex-col gap-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-white/75">{certificateType}</p>
        <h2 className="text-[22px] font-bold text-white md:text-[26px]">Distribution Boards</h2>
        <p className="text-[13px] text-white/85">
          {count === 1 ? '1 board' : `${count} boards`} · make, model &amp; protection
        </p>
      </div>
      <Boxes className="h-10 w-10 text-white/30" strokeWidth={2} aria-hidden />
    </div>
  );
}
