'use client';

import * as React from 'react';
import { Boxes, Cable, CircuitBoard, MapPin, ShieldCheck, Zap } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { SectionCard } from '@/components/ui/section-card';
import { SelectChips } from '@/components/ui/select-chips';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { BoardSelectorBar } from '@/components/job/board-selector-bar';

/**
 * Board tab — mirrors iOS `BoardTab.swift` + `BoardInfo.swift`.
 *
 * iOS supports multiple boards per job (main + sub-distribution); the web
 * stores the list in `job.board.boards`. We default to a single synthesized
 * main board if the array is empty so inspectors can start filling straight
 * away.
 *
 * Phase 4 additions (iOS parity):
 *   - Move Left / Move Right reorder actions on the selector toolbar.
 *   - Remove-with-confirm dialog surfacing the cascade (N circuits + M
 *     observations removed with the board).
 *   - Parent-board SelectChips for sub-boards (mirrors `fedFromPicker`
 *     at BoardTab.swift:L322-L342). Picking a parent auto-populates
 *     `supplied_from` with the parent's designation + inherits earthing
 *     if not yet set (BoardTab.swift:L370-L389 parentBoardBinding).
 *   - Overcurrent Device section (BS EN + voltage + current).
 *   - Polarity confirmed + Phases confirmed toggles on the Protection
 *     section (BoardTab.swift:L259-L260).
 *   - Star-for-main indicator on the selector pill.
 */

type BoardRecord = Record<string, string | undefined> & {
  id: string;
  board_type?: 'main' | 'sub_distribution' | 'sub_main';
  parent_board_id?: string;
  /** Truthy-ish ('✓' / 'yes' / 'true') when polarity has been confirmed. */
  polarity_confirmed?: string;
  phases_confirmed?: string;
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

/** iOS `Constants.isTruthyBooleanValue` — we mirror the check tree
 *  wholesale so a round-tripped '✓' from the iOS client reads as
 *  confirmed on web. */
function isTruthyBoardValue(v: string | undefined): boolean {
  if (!v) return false;
  const trimmed = v.trim().toLowerCase();
  return trimmed === '✓' || trimmed === 'yes' || trimmed === 'true' || trimmed === '1';
}

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
  // Memo-wrap so `boards` has a stable identity unless the underlying
  // job state actually changed — needed by the selected-id guard
  // effect below, and keeps downstream filters from re-running.
  const boards: BoardRecord[] = React.useMemo(
    () => (boardState.boards && boardState.boards.length > 0 ? boardState.boards : [newBoard()]),
    [boardState.boards]
  );

  const [activeId, setActiveId] = React.useState(boards[0].id);
  const active = boards.find((b) => b.id === activeId) ?? boards[0];

  // When the user switches job (different id in URL) we'd get a stale
  // activeId. Watch boards identity and fall back to the first board if
  // the active id has been removed (parent save races etc).
  React.useEffect(() => {
    if (!boards.some((b) => b.id === activeId)) {
      setActiveId(boards[0].id);
    }
  }, [boards, activeId]);

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

  /**
   * Reorder — moves the active board within the array and preserves
   * selection. iOS uses `viewModel.moveBoard(from:direction:)` at
   * BoardTab.swift:L27-L40; the web equivalent is a plain array splice.
   */
  const moveActive = (direction: -1 | 1) => {
    const idx = boards.findIndex((b) => b.id === active.id);
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= boards.length) return;
    const next = boards.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    persistBoards(next);
  };

  // Remove flow — open confirm, compute cascade counts, commit.
  const [removeConfirmOpen, setRemoveConfirmOpen] = React.useState(false);
  const openRemoveConfirm = () => {
    if (boards.length <= 1) return;
    setRemoveConfirmOpen(true);
  };

  // Count circuits + observations tagged to this board. Cheap enough
  // that a plain closure per-render is fine — React Compiler will
  // memo it if the inputs don't change. Wrapping in useMemo clashes
  // with the compiler's manual-memoization detector because
  // `active.id` reads through a derived object; computing inline
  // sidesteps that while keeping the same intent (show N / M in the
  // confirm dialog copy).
  const circuitsOnActive = (
    (job.circuits ?? []) as unknown as Array<Record<string, unknown>>
  ).filter((c) => c.board_id === active.id).length;
  const observationsOnActive = (
    (job.observations ?? []) as unknown as Array<Record<string, unknown>>
  ).filter((o) => o.board_id === active.id).length;

  const confirmRemove = () => {
    if (boards.length <= 1) return;
    const remaining = boards.filter((b) => b.id !== active.id);
    persistBoards(remaining);
    setActiveId(remaining[0].id);
    setRemoveConfirmOpen(false);
  };

  /**
   * Parent-board binding. Setting the parent auto-populates
   * supplied_from with the parent's designation and inherits the
   * parent's earthing arrangement when the child doesn't have one
   * yet. Mirrors iOS parentBoardBinding at BoardTab.swift:L370-L389.
   */
  const setParent = (parentId: string | null) => {
    const patch: Partial<BoardRecord> = { parent_board_id: parentId ?? undefined };
    if (parentId) {
      const parent = boards.find((b) => b.id === parentId);
      if (parent) {
        patch.supplied_from = parent.designation ?? undefined;
        if (!active.earthing_arrangement && parent.earthing_arrangement) {
          patch.earthing_arrangement = parent.earthing_arrangement;
        }
      }
    } else {
      patch.supplied_from = undefined;
    }
    patchActive(patch);
  };

  const text = (k: keyof BoardRecord) => (active[k] as string | undefined) ?? '';
  const isSubBoard = active.board_type === 'sub_distribution' || active.board_type === 'sub_main';
  const parentOptions = boards
    .filter((b) => b.id !== active.id)
    .map((b, idx) => ({ value: b.id, label: b.designation || `DB-${idx + 1}` }));

  return (
    <div
      className="mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroBanner certificateType={certificateType} count={boards.length} />

      <BoardSelectorBar
        boards={boards.map((b) => ({
          id: b.id,
          designation: b.designation,
          is_main: b.board_type === 'main' || b.board_type === undefined,
        }))}
        activeId={active.id}
        onSelect={setActiveId}
        onAdd={addBoard}
        onMoveLeft={() => moveActive(-1)}
        onMoveRight={() => moveActive(1)}
        onRemove={openRemoveConfirm}
      />

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
          onChange={(v) => {
            // Mirror iOS boardTypeBinding (L356-L368): clearing the
            // parent when the user flips back to "main" avoids
            // orphaned supplied-from references.
            const patch: Partial<BoardRecord> = { board_type: v as BoardRecord['board_type'] };
            if (v === 'main') {
              patch.parent_board_id = undefined;
              patch.supplied_from = undefined;
            }
            patchActive(patch);
          }}
        />
      </SectionCard>

      <SectionCard accent="blue" icon={MapPin} title="Location">
        <FloatingLabelInput
          label="Location on site"
          value={text('location')}
          onChange={(e) => patchActive({ location: e.target.value })}
        />
        {isSubBoard ? (
          // Parent-board picker. When there are no other boards yet we
          // degrade gracefully with a hint — inspectors often create a
          // sub-board before filling in its parent.
          parentOptions.length > 0 ? (
            <SelectChips
              label="Fed from"
              value={active.parent_board_id ?? null}
              options={parentOptions}
              onChange={setParent}
            />
          ) : (
            <p className="text-[12px] text-[var(--color-text-tertiary)]">
              Add another board first to pick a parent.
            </p>
          )
        ) : (
          <FloatingLabelInput
            label="Supplied from"
            value={text('supplied_from')}
            onChange={(e) => patchActive({ supplied_from: e.target.value })}
          />
        )}
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
        </div>

        {/*
          Polarity + Phases confirmed. iOS stores these as string fields
          that encode a truthy value ('✓' / 'yes' / free-form for
          phases). Web uses a SegmentedControl for polarity (explicit
          Yes / No) and a plain text input for phases-confirmed because
          the latter sometimes carries free-text like "L1-L2-L3 OK".
        */}
        <div className="flex flex-col gap-2">
          <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            Polarity confirmed?
          </label>
          <SegmentedControl
            aria-label="Polarity confirmed"
            value={
              isTruthyBoardValue(text('polarity_confirmed'))
                ? 'yes'
                : text('polarity_confirmed')
                  ? 'no'
                  : null
            }
            onChange={(v) =>
              patchActive({ polarity_confirmed: v === 'yes' ? '✓' : v === 'no' ? 'no' : undefined })
            }
            options={[
              { value: 'yes', label: 'Yes', variant: 'pass' },
              { value: 'no', label: 'No', variant: 'fail' },
            ]}
          />
        </div>
        <FloatingLabelInput
          label="Phases confirmed"
          value={text('phases_confirmed')}
          onChange={(e) => patchActive({ phases_confirmed: e.target.value })}
        />
      </SectionCard>

      <SectionCard accent="magenta" icon={Zap} title="Overcurrent device">
        {/* Overcurrent protective device — BoardTab.swift:L279-L286. */}
        <div className="grid gap-3 md:grid-cols-3">
          <FloatingLabelInput
            label="BS EN"
            value={text('overcurrent_bs_en')}
            onChange={(e) => patchActive({ overcurrent_bs_en: e.target.value })}
          />
          <FloatingLabelInput
            label="Voltage (V)"
            inputMode="decimal"
            value={text('overcurrent_voltage')}
            onChange={(e) => patchActive({ overcurrent_voltage: e.target.value })}
          />
          <FloatingLabelInput
            label="Current (A)"
            inputMode="decimal"
            value={text('overcurrent_current')}
            onChange={(e) => patchActive({ overcurrent_current: e.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard accent="blue" icon={ShieldCheck} title="SPD">
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="SPD type"
            value={text('spd_type')}
            onChange={(e) => patchActive({ spd_type: e.target.value })}
          />
          <FloatingLabelInput
            label="SPD status"
            value={text('spd_status')}
            onChange={(e) => patchActive({ spd_status: e.target.value })}
          />
        </div>
      </SectionCard>

      {isSubBoard ? (
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

      <ConfirmDialog
        open={removeConfirmOpen}
        onOpenChange={setRemoveConfirmOpen}
        title="Remove this board?"
        description={
          <>
            This will remove {active.designation || 'the board'} and
            {circuitsOnActive > 0
              ? ` its ${circuitsOnActive} circuit${circuitsOnActive === 1 ? '' : 's'}`
              : ' any circuits tagged to it'}
            {observationsOnActive > 0
              ? ` and ${observationsOnActive} observation${observationsOnActive === 1 ? '' : 's'}`
              : ''}
            . This cannot be undone.
          </>
        }
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemove}
      />
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
