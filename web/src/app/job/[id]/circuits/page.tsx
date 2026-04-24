'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Calculator,
  Camera,
  CircuitBoard,
  FileDown,
  FlipHorizontal2,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  SlidersHorizontal,
  Table2,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  applyDefaultsToCircuits,
  applyR1R2Calculation,
  applyZsCalculation,
  matchCircuits,
  type BulkCalcOutcome,
  type CalcSkipReason,
  type CircuitMatch,
} from '@certmate/shared-utils';
import { api } from '@/lib/api-client';
import { useJobContext } from '@/lib/job-context';
import { useCurrentUser } from '@/lib/use-current-user';
import { useUserDefaults } from '@/hooks/use-user-defaults';
import { ApiError, type CCUAnalysisCircuit, type CircuitRow } from '@/lib/types';
import { applyCcuAnalysisToJob, type CcuApplyMode } from '@/lib/recording/apply-ccu-analysis';
import { applyDocumentExtractionToJob } from '@/lib/recording/apply-document-extraction';
import { writeMatchHandoff } from '@/lib/recording/ccu-match-handoff';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { IconButton } from '@/components/ui/icon-button';
import { SectionCard } from '@/components/ui/section-card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SelectChips } from '@/components/ui/select-chips';
import { CircuitsStickyTable } from '@/components/job/circuits-sticky-table';
import { CcuModeSheet } from '@/components/job/ccu-mode-sheet';

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

/** Stored preference key for the Cards ↔ Table view toggle. */
const VIEW_PREF_KEY = 'cm-circuits-view';
type CircuitView = 'cards' | 'table';

function readInitialView(): CircuitView {
  // Default to `cards` on narrow viewports (< 1024) and `table` on
  // desktop. Persisted preference wins over both. SSR / non-browser
  // contexts default to `cards` so the initial paint is identical on
  // mobile where inspectors spend most of their time.
  if (typeof window === 'undefined') return 'cards';
  try {
    const stored = window.localStorage.getItem(VIEW_PREF_KEY);
    if (stored === 'cards' || stored === 'table') return stored;
  } catch {
    /* ignore private-mode quota etc. */
  }
  return window.matchMedia?.('(min-width: 1024px)').matches ? 'table' : 'cards';
}

export default function CircuitsPage() {
  const { job, updateJob } = useJobContext();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  // Phase 6 — thread user-scoped circuit-field defaults into
  // `applyDefaultsToCircuits`. iOS reads these from `DefaultsService`;
  // the web hook hydrates from IDB cache first (instant paint offline)
  // then from the backend. When `user.id` is undefined (logged-out /
  // still loading), `defaults` is an empty map and apply-defaults
  // falls back to the schema-only path — identical to iOS when the
  // inspector hasn't configured any user defaults yet.
  const { user } = useCurrentUser();
  const { defaults: userDefaults } = useUserDefaults(user?.id);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [actionHint, setActionHint] = React.useState<string | null>(null);
  const [ccuBusy, setCcuBusy] = React.useState(false);
  const [ccuError, setCcuError] = React.useState<string | null>(null);
  const [ccuQuestions, setCcuQuestions] = React.useState<string[]>([]);
  const ccuInputRef = React.useRef<HTMLInputElement>(null);
  /**
   * Phase 7 — CCU extraction flow now starts with a mode sheet. The
   * inspector picks Names Only / Hardware Update / Full Capture
   * BEFORE the file picker opens. We store the chosen mode in a ref
   * between the sheet dismissal and the picker onChange handler so
   * the same hidden `<input>` can serve all three modes.
   */
  const [ccuModeSheetOpen, setCcuModeSheetOpen] = React.useState(false);
  const pendingCcuModeRef = React.useRef<CcuApplyMode | null>(null);
  const [docBusy, setDocBusy] = React.useState(false);
  const [docError, setDocError] = React.useState<string | null>(null);
  const docInputRef = React.useRef<HTMLInputElement>(null);
  const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = React.useState(false);
  // Per-circuit delete confirmation — iOS surfaces a tap-confirm on the
  // row trash button (CircuitsTab.swift:L220-L235). Without a guard, a
  // mis-tap on the tight row action wipes the circuit and any linked
  // observations without warning. Ledger row "Per-circuit trash guard"
  // flipped to match in Phase 9.
  const [pendingDeleteCircuitId, setPendingDeleteCircuitId] = React.useState<string | null>(null);
  const [calcMenuOpen, setCalcMenuOpen] = React.useState(false);
  const calcMenuRef = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState<CircuitView>('cards');
  // Resolve the persisted/desktop-default view on mount so SSR hydration
  // matches. Reading localStorage / matchMedia during render would
  // produce divergent markup between server + first client render.
  React.useEffect(() => {
    setView(readInitialView());
  }, []);
  const setViewPersisted = (next: CircuitView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_PREF_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const circuits = (job.circuits ?? []) as unknown as Circuit[];
  const boards = ((job.board as { boards?: { id: string; designation?: string }[] } | undefined)
    ?.boards ?? []) as { id: string; designation?: string }[];
  const [selectedBoardId, setSelectedBoardId] = React.useState<string | null>(
    boards[0]?.id ?? null
  );

  const visible = selectedBoardId
    ? circuits.filter((c) => c.board_id === selectedBoardId || c.board_id == null)
    : circuits;

  // Bulk actions (Apply Defaults / Calculate Zs / Calculate R1+R2 /
  // Delete all) must only target circuits that are DEFINITELY on the
  // active board. `visible` intentionally includes legacy boardless
  // rows (board_id == null) so they stay editable from any board, but
  // sweeping them into a bulk action is collateral — "Delete all on
  // Board 2" must not silently wipe legacy unassigned circuits. When
  // no board is selected, the bulk target is the whole list.
  const boardScoped = selectedBoardId
    ? circuits.filter((c) => c.board_id === selectedBoardId)
    : circuits;

  /**
   * Resolve the Ze to use for Zs / R1+R2 calculations. iOS reads the
   * per-board Ze when available, falling back to the supply-level Ze.
   * Sub-boards often record their own Ze on the Board tab that differs
   * from the supply value, and a missing supply Ze would otherwise
   * turn Calculate into a no-op for those jobs.
   */
  const activeBoard = boards.find((b) => b.id === selectedBoardId) as
    | { ze?: string; earth_loop_impedance_ze?: string }
    | undefined;
  const supplyLevelZe = ((job.supply as { earth_loop_impedance_ze?: string } | undefined)
    ?.earth_loop_impedance_ze ?? '') as string;
  const supplyZe =
    activeBoard?.ze?.toString().trim() ||
    activeBoard?.earth_loop_impedance_ze?.toString().trim() ||
    supplyLevelZe;

  const persist = (next: Circuit[]) =>
    updateJob({ circuits: next as unknown as typeof job.circuits });

  const patchCircuit = (id: string, patch: Partial<Circuit>) => {
    persist(circuits.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  // Table-view patch adapter — the sticky table passes `{key: value}`
  // patches with string values only (no undefined), so this is a
  // narrow alias rather than a duplicate state handler.
  const patchCircuitTable = (id: string, patch: Record<string, string>) =>
    patchCircuit(id, patch as Partial<Circuit>);

  const addCircuit = () => {
    const nextRef = String(visible.length + 1);
    const c = newCircuit(nextRef, selectedBoardId ?? undefined);
    persist([...circuits, c]);
    setExpandedId(c.id);
  };

  /** Queue a per-circuit delete through ConfirmDialog (Phase 9). */
  const requestDeleteCircuit = (id: string) => setPendingDeleteCircuitId(id);
  const cancelPendingDelete = () => setPendingDeleteCircuitId(null);
  const confirmPendingDelete = () => {
    const id = pendingDeleteCircuitId;
    if (!id) return;
    persist(circuits.filter((c) => c.id !== id));
    if (expandedId === id) setExpandedId(null);
    setPendingDeleteCircuitId(null);
  };
  const pendingDeleteCircuit = pendingDeleteCircuitId
    ? (circuits.find((c) => c.id === pendingDeleteCircuitId) ?? null)
    : null;

  const reverse = () => persist([...circuits].reverse());

  /**
   * Apply Defaults — fills empty fields from the field_schema subset.
   * Non-overwrite invariant is enforced inside
   * `applyDefaultsToCircuits`; see `packages/shared-utils/src/apply-defaults.ts`.
   * We only apply to the currently-filtered board so an inspector
   * working on Board #2 doesn't accidentally stomp Board #1.
   */
  const handleApplyDefaults = () => {
    const visibleIds = new Set(boardScoped.map((c) => c.id));
    // Strip scoped/cable-type keys (e.g. `lighting.live_csa_mm2`) before
    // passing to the generic applier — otherwise the helper would write
    // those dotted strings as if they were Circuit field names. Cable
    // size defaults are applied by a separate per-circuit-type flow.
    const flatDefaults: Record<string, string> = {};
    for (const [k, v] of Object.entries(userDefaults)) {
      if (!k.includes('.')) flatDefaults[k] = v;
    }
    const { circuits: updatedVisible, summary } = applyDefaultsToCircuits(boardScoped, {
      userDefaults: flatDefaults as Partial<Record<keyof Circuit, string>>,
    });
    if (summary.filledFields === 0) {
      setActionHint('Apply Defaults — nothing to fill (all fields already set).');
      return;
    }
    const updatedById = new Map(updatedVisible.map((c) => [c.id, c]));
    const merged = circuits.map((c) => (visibleIds.has(c.id) ? (updatedById.get(c.id) ?? c) : c));
    persist(merged);
    const circuitsWord = summary.touchedCircuits === 1 ? 'circuit' : 'circuits';
    const suffix =
      summary.ambiguousCircuits > 0
        ? ` · ${summary.ambiguousCircuits} skipped (type not inferred)`
        : '';
    setActionHint(
      `Apply Defaults — filled ${summary.filledFields} field${
        summary.filledFields === 1 ? '' : 's'
      } across ${summary.touchedCircuits} ${circuitsWord}${suffix}.`
    );
  };

  /** Turn a bulk calc outcome into the user-facing banner copy. */
  const formatCalcBanner = (op: 'Zs' | 'R1+R2', res: BulkCalcOutcome<Circuit>): string => {
    if (res.terminalReason === 'missing-ze') {
      return `${op} — no Ze on Supply tab. Set “Earth loop impedance Ze” first.`;
    }
    if (res.terminalReason === 'invalid-ze') {
      return `${op} — Ze is not a number. Check the Supply tab.`;
    }
    if (res.updated === 0) {
      const reason: CalcSkipReason | undefined = Object.keys(res.skippedReasons)[0] as
        | CalcSkipReason
        | undefined;
      const why =
        reason === 'missing-r1r2'
          ? 'no circuits had R1+R2'
          : reason === 'missing-zs'
            ? 'no circuits had measured Zs'
            : reason === 'negative-r1r2'
              ? 'all would have been negative'
              : 'no eligible circuits';
      return `${op} — nothing updated (${why}).`;
    }
    const parts = [`Updated ${res.updated} circuit${res.updated === 1 ? '' : 's'}`];
    if (res.skipped > 0) {
      const neg = res.skippedReasons['negative-r1r2'] ?? 0;
      const missR1R2 = res.skippedReasons['missing-r1r2'] ?? 0;
      const missZs = res.skippedReasons['missing-zs'] ?? 0;
      const bits: string[] = [];
      if (missR1R2) bits.push(`${missR1R2} missing R1+R2`);
      if (missZs) bits.push(`${missZs} missing Zs`);
      if (neg) bits.push(`${neg} negative (skipped)`);
      if (bits.length === 0) bits.push(`${res.skipped}`);
      parts.push(`skipped ${bits.join(', ')}`);
    }
    return `${op} — ${parts.join('; ')}.`;
  };

  const handleCalculateZs = () => {
    setCalcMenuOpen(false);
    const visibleIds = new Set(boardScoped.map((c) => c.id));
    const res = applyZsCalculation(boardScoped, supplyZe);
    if (res.updated > 0) {
      const byId = new Map(res.circuits.map((c) => [c.id, c]));
      const merged = circuits.map((c) => (visibleIds.has(c.id) ? (byId.get(c.id) ?? c) : c));
      persist(merged);
    }
    setActionHint(formatCalcBanner('Zs', res));
  };

  const handleCalculateR1R2 = () => {
    setCalcMenuOpen(false);
    const visibleIds = new Set(boardScoped.map((c) => c.id));
    const res = applyR1R2Calculation(boardScoped, supplyZe);
    if (res.updated > 0) {
      const byId = new Map(res.circuits.map((c) => [c.id, c]));
      const merged = circuits.map((c) => (visibleIds.has(c.id) ? (byId.get(c.id) ?? c) : c));
      persist(merged);
    }
    setActionHint(formatCalcBanner('R1+R2', res));
  };

  // Close calc menu on outside click — a tiny floating menu doesn't
  // need a full Radix portal; we wire a click-outside listener only
  // while it's open to keep the component cheap on idle.
  React.useEffect(() => {
    if (!calcMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!calcMenuRef.current) return;
      if (!calcMenuRef.current.contains(e.target as Node)) setCalcMenuOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [calcMenuOpen]);

  /**
   * Delete-all for the current board. iOS exposes a multi-select bulk
   * delete; web simplifies to "delete all on this board" because the
   * wider desktop viewport makes per-row delete trivially accessible
   * and multi-select-mode machinery adds a lot of state for a rarely-
   * used path. See the parity ledger note flipping the row from
   * `missing` to `match` with this simplification recorded.
   */
  const handleConfirmDeleteAll = () => {
    const removedCount = boardScoped.length;
    if (removedCount === 0) {
      setActionHint('Delete all — no circuits to remove.');
      setConfirmDeleteAllOpen(false);
      return;
    }
    const scopedIds = new Set(boardScoped.map((c) => c.id));
    persist(circuits.filter((c) => !scopedIds.has(c.id)));
    if (expandedId && scopedIds.has(expandedId)) setExpandedId(null);
    setConfirmDeleteAllOpen(false);
    setActionHint(`Deleted ${removedCount} circuit${removedCount === 1 ? '' : 's'}.`);
  };

  /** CCU button click — open the mode sheet instead of the picker
   *  directly. The sheet's onSelect handler wires the chosen mode
   *  into the ref and then opens the file picker. */
  const openCcuPicker = () => {
    setCcuError(null);
    setCcuModeSheetOpen(true);
  };

  const onCcuModeSelected = (mode: CcuApplyMode) => {
    pendingCcuModeRef.current = mode;
    // Defer the click by a tick so iOS Safari's sheet-close animation
    // doesn't race with the file picker popup (same rationale as the
    // setTimeout inside the sheet's own click handler — belt-and-braces).
    window.setTimeout(() => ccuInputRef.current?.click(), 0);
  };

  const handleCcuFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input immediately so the same file can be chosen again
    // after a failure (otherwise onChange won't fire a second time).
    event.target.value = '';
    const mode: CcuApplyMode = pendingCcuModeRef.current ?? 'full_capture';
    pendingCcuModeRef.current = null;
    if (!file) return;

    setCcuBusy(true);
    setCcuError(null);
    setActionHint(
      mode === 'names_only'
        ? 'Analysing board labels…'
        : mode === 'hardware_update'
          ? 'Analysing new board hardware…'
          : 'Analysing consumer unit…'
    );
    try {
      const analysis = await api.analyzeCCU(file);

      if (mode === 'hardware_update') {
        // Run the matcher locally, stash the result in sessionStorage,
        // and navigate to the Match Review screen. The apply step runs
        // there once the inspector confirms / reassigns.
        //
        // Candidates MUST be strictly board-scoped — legacy boardless
        // circuits would otherwise get pulled into the match, and
        // accepting the match would silently migrate them onto the
        // active board along with their readings. That's the same
        // cross-board-collateral trap that `boardScoped` protects the
        // other bulk actions from. When no board is selected (e.g.
        // single-board jobs on the pre-Phase-4 schema) we fall back
        // to the unscoped list.
        const boardCircuits = (
          selectedBoardId
            ? (job.circuits ?? []).filter(
                (c) => (c.board_id as string | undefined) === selectedBoardId
              )
            : (job.circuits ?? [])
        ) as CircuitRow[];
        const initialMatches: CircuitMatch<CCUAnalysisCircuit, CircuitRow>[] = matchCircuits(
          analysis.circuits ?? [],
          boardCircuits
        );
        // Even if the matcher returned 0 candidates, we still hand
        // off — the review screen will show every circuit as "new"
        // which is the correct state and lets the inspector double-
        // check before we touch the job.
        const patchedBoardsSnapshot = (job.board as { boards?: { id: string }[] } | undefined)
          ?.boards;
        const boardId =
          selectedBoardId ??
          (patchedBoardsSnapshot && patchedBoardsSnapshot[0]?.id) ??
          'board-pending';
        const nonce = writeMatchHandoff(jobId, {
          analysis,
          matches: initialMatches,
          boardId,
          existingBoardCircuits: boardCircuits,
        });
        router.push(`/job/${jobId}/circuits/match-review?nonce=${nonce}`);
        setActionHint(
          `Review ${initialMatches.length} proposed match${initialMatches.length === 1 ? '' : 'es'}…`
        );
        return;
      }

      // Names Only + Full Capture — apply immediately.
      const { patch, questions } = applyCcuAnalysisToJob(job, analysis, {
        mode,
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
      const suffix = mode === 'names_only' ? ' (labels only)' : mode === 'full_capture' ? '' : '';
      setActionHint(
        added > 0
          ? `CCU analysed — ${added} circuit${added === 1 ? '' : 's'} merged${suffix}.`
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
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
              <Zap className="h-3.5 w-3.5 text-[var(--color-brand-blue)]" aria-hidden />
              Circuits
            </h2>
            <div className="flex items-center gap-3">
              {/*
               * Cards / Table toggle — iOS ships landscape-only sticky
               * grid, but the web client has no orientation signal (the
               * same Next page serves phones AND 32" monitors), so we
               * expose both layouts and persist the user's choice. Mobile
               * default is `cards`; desktop default is `table`; the first
               * explicit click sticks in localStorage.
               */}
              <ViewToggle view={view} onChange={setViewPersisted} />
              <span className="text-[11px] text-[var(--color-text-tertiary)]">
                {visible.length} {visible.length === 1 ? 'circuit' : 'circuits'}
              </span>
            </div>
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
          ) : view === 'table' ? (
            <CircuitsStickyTable
              circuits={visible}
              onPatch={patchCircuitTable}
              onRemove={requestDeleteCircuit}
            />
          ) : (
            visible.map((c) => (
              <CircuitCard
                key={c.id}
                circuit={c}
                expanded={expandedId === c.id}
                onToggle={() => setExpandedId((p) => (p === c.id ? null : c.id))}
                onPatch={(patch) => patchCircuit(c.id, patch)}
                onRemove={() => requestDeleteCircuit(c.id)}
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
            onClick={() => setConfirmDeleteAllOpen(true)}
            disabled={boardScoped.length === 0}
          />
          <RailButton
            Icon={SlidersHorizontal}
            label="Defaults"
            colour="#ff375f"
            onClick={handleApplyDefaults}
            disabled={boardScoped.length === 0}
          />
          <RailButton
            Icon={FlipHorizontal2}
            label="Reverse"
            colour="#ec4899"
            onClick={reverse}
            disabled={visible.length < 2}
          />
          <div ref={calcMenuRef} className="relative">
            <RailButton
              Icon={Calculator}
              label="Calculate"
              colour="var(--color-brand-green)"
              onClick={() => setCalcMenuOpen((v) => !v)}
              disabled={boardScoped.length === 0}
            />
            {calcMenuOpen ? (
              <div
                role="menu"
                aria-label="Calculate menu"
                className="absolute right-full top-0 z-30 mr-2 w-56 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleCalculateZs}
                  className="block w-full px-3 py-2 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
                >
                  <span className="block font-semibold">Calculate Zs</span>
                  <span className="block text-[11px] text-[var(--color-text-tertiary)]">
                    Zs = Ze + R1+R2
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleCalculateR1R2}
                  className="block w-full border-t border-[var(--color-border-subtle)] px-3 py-2 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
                >
                  <span className="block font-semibold">Calculate R1+R2</span>
                  <span className="block text-[11px] text-[var(--color-text-tertiary)]">
                    R1+R2 = Zs − Ze
                  </span>
                </button>
              </div>
            ) : null}
          </div>
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

      {/*
       * Delete-all confirmation — required because the button is
       * terminal and iOS parity expects a guard even on its more
       * elaborate multi-select flow. See the parity ledger note on
       * the UX simplification: one button + one confirm replaces the
       * iOS enter-mode / tap-rows / confirm-count cascade.
       */}
      <CcuModeSheet
        open={ccuModeSheetOpen}
        onOpenChange={setCcuModeSheetOpen}
        onSelect={onCcuModeSelected}
        existingCircuitCount={boardScoped.length}
      />

      <ConfirmDialog
        open={confirmDeleteAllOpen}
        onOpenChange={setConfirmDeleteAllOpen}
        title={`Delete all circuits on this board?`}
        description={
          <>
            This will remove {boardScoped.length}{' '}
            {boardScoped.length === 1 ? 'circuit' : 'circuits'}
            {selectedBoardId ? ` on the selected board` : ''}. This cannot be undone.
          </>
        }
        confirmLabel="Delete all"
        destructive
        onConfirm={handleConfirmDeleteAll}
      />

      {/*
       * Per-circuit delete confirmation (Phase 9). The trash button on
       * each row / card is a high-risk tap target — a single mis-tap
       * would silently wipe a circuit plus any observations linked via
       * `schedule_item`. Routing through ConfirmDialog matches the
       * bulk-delete and observations-delete patterns and closes the
       * ledger gap for cross-cutting destructive guards.
       */}
      <ConfirmDialog
        open={pendingDeleteCircuitId !== null}
        onOpenChange={(open) => {
          if (!open) cancelPendingDelete();
        }}
        title="Delete this circuit?"
        description={
          pendingDeleteCircuit ? (
            <>
              Remove circuit{' '}
              <strong>
                {pendingDeleteCircuit.circuit_ref ||
                  pendingDeleteCircuit.circuit_designation ||
                  'this row'}
              </strong>
              ? Any readings recorded for it will be lost. This cannot be undone.
            </>
          ) : undefined
        }
        confirmLabel="Delete"
        confirmLabelBusy="Deleting…"
        destructive
        onConfirm={confirmPendingDelete}
      />
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function ViewToggle({ view, onChange }: { view: CircuitView; onChange: (v: CircuitView) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Circuit view"
      className="inline-flex items-center rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-0.5 text-[11px]"
    >
      <button
        type="button"
        role="radio"
        aria-checked={view === 'cards'}
        onClick={() => onChange('cards')}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold transition ${
          view === 'cards'
            ? 'bg-[var(--color-brand-blue)] text-white'
            : 'text-[var(--color-text-secondary)]'
        }`}
      >
        <LayoutGrid className="h-3 w-3" aria-hidden />
        Cards
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={view === 'table'}
        onClick={() => onChange('table')}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold transition ${
          view === 'table'
            ? 'bg-[var(--color-brand-blue)] text-white'
            : 'text-[var(--color-text-secondary)]'
        }`}
      >
        <Table2 className="h-3 w-3" aria-hidden />
        Table
      </button>
    </div>
  );
}

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
