/**
 * A01P (2026-09-08) — Board tab Ze labels. The stored board cell is labelled
 * "Board Ze override"; a read-only "Origin Ze" shows the supply value the
 * override shadows and is never persisted through `patchActive` /
 * `buildBoardInfoSummary`. Mount pattern mirrors canonical-main-board.test.tsx.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
    { has: () => true, get: (_t, prop) => (prop === '__esModule' ? true : stub) }
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

function Probe() {
  const { job } = useJobContext();
  return (
    <>
      <div data-testid="board-info">{JSON.stringify(job.board_info ?? null)}</div>
      <div data-testid="boards">{JSON.stringify(job.boards ?? null)}</div>
    </>
  );
}

let mounted: { container: HTMLElement; root: Root } | null = null;
afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

function mount(job: JobDetail) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <JobProvider initial={job}>
        <BoardPage />
        <Probe />
      </JobProvider>
    );
  });
  mounted = { container, root };
  return container;
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const labelEl = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent?.trim() === label
  );
  expect(labelEl, `label "${label}"`).toBeTruthy();
  const input = container.querySelector<HTMLInputElement>(`#${CSS.escape(labelEl!.htmlFor)}`);
  expect(input, `input for "${label}"`).toBeTruthy();
  return input!;
}

const job = {
  id: 'job-1',
  user_id: 'u1',
  certificate_type: 'EICR',
  folder_name: 'job-1',
  boards: [{ id: 'b-main', designation: 'CU-A', board_type: 'main', ze: '0.28' }],
  supply_characteristics: { earth_loop_impedance_ze: '0.50', ze: '0.50' },
  circuits: [],
  observations: [],
} as unknown as JobDetail;

describe('[invariant] A01P — Board tab Ze labels', () => {
  it('labels the stored cell "Board Ze override" and shows a read-only "Origin Ze" from supply', () => {
    const container = mount(job);
    expect(inputByLabel(container, 'Board Ze override (Ω)').value).toBe('0.28');
    const origin = inputByLabel(container, 'Origin Ze (Ω)');
    expect(origin.value).toBe('0.50');
    expect(origin.readOnly).toBe(true);
    // The old ambiguous label is gone.
    expect(
      Array.from(container.querySelectorAll('label')).some(
        (l) => l.textContent?.trim() === 'Ze (Ω)'
      )
    ).toBe(false);
  });

  it('editing the override persists boards[main].ze and board_info.ze; the origin fallback is never persisted', () => {
    const container = mount(job);
    const override = inputByLabel(container, 'Board Ze override (Ω)');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(override, '0.31');
      override.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const boards = JSON.parse(
      container.querySelector('[data-testid="boards"]')!.textContent!
    ) as Array<Record<string, unknown>>;
    const boardInfo = JSON.parse(
      container.querySelector('[data-testid="board-info"]')!.textContent!
    ) as Record<string, unknown>;
    expect(boards[0].ze).toBe('0.31');
    expect(boardInfo.ze).toBe('0.31');
    for (const record of [boards[0], boardInfo]) {
      expect(Object.keys(record).some((k) => /origin/i.test(k))).toBe(false);
      expect(record.earth_loop_impedance_ze).toBeUndefined();
    }
  });

  it('a blank override shows an empty override cell while the origin still reads the supply value', () => {
    const container = mount({
      ...job,
      boards: [{ id: 'b-main', designation: 'CU-A', board_type: 'main' }],
    } as unknown as JobDetail);
    expect(inputByLabel(container, 'Board Ze override (Ω)').value).toBe('');
    expect(inputByLabel(container, 'Origin Ze (Ω)').value).toBe('0.50');
  });
});
