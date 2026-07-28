/**
 * A2-multiboard (2026-07-28) scope item 5 — CANONICAL-MAIN ATTRIBUTION on web.
 *
 * `board_info` is the single-board summary every non-Board-tab consumer reads
 * as "the board": the Overview hero strip, the PDF, and — the one that makes
 * this a correctness bug rather than a cosmetic one — the backend's own
 * `_applyTopLevelBoardInfo` job-state ingest, which merges it into the main
 * board record and into `circuits[0]`.
 *
 * The Board tab derived that summary from `boards[0]`. But the Board tab also
 * ships Move left / Move right (`moveActive`), so array index 0 is a
 * UI-ordering artefact: one reorder and every `board_info` consumer starts
 * reading a SUB-board's designation and fields as the main board's. The fix
 * routes both derivation sites (`persistBoards` and `confirmRemove`) through
 * the shared canonical-main helper, whose rule is stated once and mirrored on
 * backend (`src/extraction/stage6-multi-board-shape.js`) and iOS.
 *
 * Mounted with `createRoot` + module-boundary stubs for lucide-react and the
 * Radix dialog — same pattern/rationale as `ws6-board-offpeak.test.tsx`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKEND_DEFAULT_MAIN_BOARD_ID,
  findCanonicalMainBoard,
  resolveCanonicalMainBoardId,
} from '@/lib/boards/canonical-main';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('lucide-react', () => {
  const stub = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
    (props, ref) => <span ref={ref} data-icon {...props} />
  );
  stub.displayName = 'LucideStub';
  return new Proxy(
    {},
    {
      has: () => true,
      get: (_target, prop) => (prop === '__esModule' ? true : stub),
    }
  );
});

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-mock="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import BoardPage from '@/app/job/[id]/board/page';
import { JobProvider, useJobContext } from '@/lib/job-context';
import type { JobDetail } from '@/lib/types';

const MAIN = { id: 'b-main', designation: 'CU-A', board_type: 'main', ze: '0.28' };
const SUB = {
  id: 'b-sub',
  designation: 'Loft DB',
  board_type: 'sub_distribution',
  parent_board_id: 'b-main',
  ze: '0.55',
};

function makeJob(boards: Array<Record<string, unknown>>): JobDetail {
  return {
    id: 'job-1',
    user_id: 'u1',
    certificate_type: 'EICR',
    folder_name: 'job-1',
    boards,
    circuits: [],
    observations: [],
  } as unknown as JobDetail;
}

/** Renders the live job state so assertions read exactly what the page wrote. */
function BoardInfoProbe() {
  const { job } = useJobContext();
  return (
    <>
      <div data-testid="probe">{JSON.stringify(job.board_info ?? null)}</div>
      <div data-testid="boards-probe">{JSON.stringify(job.boards ?? null)}</div>
    </>
  );
}

function mount(element: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

let mounted: { container: HTMLElement; root: Root } | null = null;

beforeEach(() => {
  mounted = null;
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

function textOf(el: Element | null): string {
  return el?.textContent ?? '';
}

function boardInfoOf(): Record<string, unknown> {
  return JSON.parse(textOf(mounted!.container.querySelector('[data-testid="probe"]')) || 'null');
}

function boardsOf(): Array<Record<string, unknown>> {
  return JSON.parse(
    textOf(mounted!.container.querySelector('[data-testid="boards-probe"]')) || 'null'
  );
}

function click(el: Element | null | undefined, what: string) {
  expect(el, `no element for ${what}`).toBeTruthy();
  act(() => {
    (el as HTMLElement).click();
  });
}

/** Board pills carry only their designation as text (the star/icon stubs are empty). */
function clickPill(designation: string) {
  click(
    Array.from(mounted!.container.querySelectorAll('button')).find(
      (b) => textOf(b).trim() === designation
    ),
    `pill "${designation}"`
  );
}

function clickByAriaLabel(label: string) {
  click(mounted!.container.querySelector(`button[aria-label="${label}"]`), `button "${label}"`);
}

describe('findCanonicalMainBoard — web mirror of the shared rule', () => {
  it('a REORDERED [sub, main] resolves to the main record, not to index 0', () => {
    expect(findCanonicalMainBoard([SUB, MAIN])).toBe(MAIN);
    expect(resolveCanonicalMainBoardId([SUB, MAIN])).toBe('b-main');
  });

  it('board_type ABSENT counts as main — legacy rows predate the field', () => {
    const legacy = { id: 'db-1', designation: 'DB1' };
    expect(findCanonicalMainBoard([legacy])).toBe(legacy);
    expect(resolveCanonicalMainBoardId([legacy])).toBe('db-1');
  });

  it('[sub, off_peak] has NO main — never crown the first sub-board', () => {
    const offPeak = { id: 'op-1', board_type: 'off_peak' };
    expect(findCanonicalMainBoard([SUB, offPeak])).toBeNull();
    expect(resolveCanonicalMainBoardId([SUB, offPeak])).toBe(BACKEND_DEFAULT_MAIN_BOARD_ID);
  });

  it('an ID-LESS main-shaped record is not usable — nothing can address a write to it', () => {
    expect(findCanonicalMainBoard([{}, SUB])).toBeNull();
    expect(findCanonicalMainBoard([{ board_type: 'main' }, SUB])).toBeNull();
    expect(resolveCanonicalMainBoardId([{}, SUB])).toBe(BACKEND_DEFAULT_MAIN_BOARD_ID);
  });

  it('junk entries are skipped rather than short-circuiting the search', () => {
    const messy = [null, undefined, 'junk', MAIN] as unknown as Array<typeof MAIN>;
    expect(findCanonicalMainBoard(messy)).toBe(MAIN);
  });

  it('a non-array / empty list resolves to the backend default identity', () => {
    for (const bad of [null, undefined, [] as never[]]) {
      expect(findCanonicalMainBoard(bad)).toBeNull();
      expect(resolveCanonicalMainBoardId(bad)).toBe('main');
    }
  });
});

describe('Board tab — board_info follows the canonical main board, never array index 0', () => {
  it('a reorder that moves a SUB-board to index 0 keeps board_info as the MAIN summary', () => {
    // The defect in one gesture: pre-fix this reorder published `Loft DB` and
    // the sub-board's Ze as "the board" to every board_info consumer,
    // including the backend's own single-board ingest.
    mounted = mount(
      <JobProvider initial={makeJob([MAIN, SUB])}>
        <BoardPage />
        <BoardInfoProbe />
      </JobProvider>
    );

    clickPill('Loft DB');
    clickByAriaLabel('Move board left');

    const info = boardInfoOf();
    expect(info.designation).toBe('CU-A');
    expect(info.ze).toBe('0.28');
    // …and the summary still carries no client-only identity keys.
    expect('id' in info).toBe(false);
    expect('board_type' in info).toBe(false);
  });

  it('an ordinary field edit on an already-reordered job still summarises the main board', () => {
    // Same bug reached by the commonest path: the job arrives already
    // reordered, and ANY Board-tab edit re-publishes board_info.
    mounted = mount(
      <JobProvider initial={makeJob([SUB, MAIN])}>
        <BoardPage />
        <BoardInfoProbe />
      </JobProvider>
    );

    const input = Array.from(mounted.container.querySelectorAll('input')).find(
      (i) => (i as HTMLInputElement).value === 'Loft DB'
    ) as HTMLInputElement | undefined;
    expect(input, 'no designation input for the active sub-board').toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!;
      setter.call(input!, 'Loft DB (rev)');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The edit lands on the sub-board record…
    expect(boardsOf().map((b) => b.designation)).toEqual(['Loft DB (rev)', 'CU-A']);
    // …while board_info keeps describing the MAIN board.
    expect(boardInfoOf().designation).toBe('CU-A');
  });

  it('removing a board re-derives board_info from whatever main REMAINS', () => {
    // Two mains + a sub: removing the first main must summarise the SECOND
    // main, not `remaining[0]` — which here is the sub-board.
    const MAIN_2 = { id: 'b-main-2', designation: 'CU-B', board_type: 'main' };
    mounted = mount(
      <JobProvider initial={makeJob([MAIN, SUB, MAIN_2])}>
        <BoardPage />
        <BoardInfoProbe />
      </JobProvider>
    );

    clickPill('CU-A');
    clickByAriaLabel('Remove board');
    // The stubbed dialog renders only when open; its confirm button carries
    // the destructive label (the toolbar trigger is matched by aria-label
    // above, so the two same-text buttons don't collide).
    click(
      Array.from(mounted.container.querySelectorAll('[role="dialog"] button')).find(
        (b) => textOf(b).trim() === 'Remove'
      ),
      'confirm-dialog Remove'
    );

    expect(boardInfoOf().designation).toBe('CU-B');
  });
});
