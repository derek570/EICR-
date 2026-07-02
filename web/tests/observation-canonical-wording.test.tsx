/**
 * WS3 item 3 — observation canonical wording + rationale (2026-07-02).
 *
 * Backend PRs #66/#68 thread `lookupRegulation`'s canonical BS 7671
 * `regulation_title`/`regulation_description` onto the initial
 * extraction's observations[] AND every `observation_update` path; iOS
 * shipped decode + apply + card render on 2026-06-25
 * (ObservationCardView.swift:71-88). Web previously decoded NEITHER key
 * and rendered none of ref/title/description/rationale.
 *
 * Coverage per the parent plan's item-3 test list:
 *   1. initial extraction persists title/description/rationale onto the row
 *   2. update HIT applies the refined canonical wording
 *   3. update MISS (null title/description) CLEARS stale wording — iOS
 *      unconditional-assignment parity; rationale keeps its
 *      non-empty-overwrite-only semantics
 *   4. card render: ref → canonical title → canonical description →
 *      italic "Because {rationale}", same order as iOS.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// Proxy-stub lucide icons (same rationale as ws6-board-offpeak.test.tsx).
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

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'job-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/job/job-1/observations',
}));

vi.mock('@/lib/auth', () => ({
  getUser: () => ({ id: 'u1', email: 'test@example.com' }),
}));

// The sheet + photo components pull authed fetch / Radix machinery that
// is tangential to card rendering — stub them inert.
vi.mock('@/components/observations/observation-sheet', () => ({
  ObservationSheet: () => null,
}));
vi.mock('@/components/observations/observation-photo', () => ({
  ObservationPhoto: () => <span data-mock="obs-photo" />,
}));
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

import ObservationsPage from '@/app/job/[id]/observations/page';
import { JobProvider } from '@/lib/job-context';
import { applyExtractionToJob, applyObservationUpdate } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail, ObservationRow } from '@/lib/types';

function makeJob(observations: ObservationRow[] = []): JobDetail {
  return {
    id: 'job-1',
    user_id: 'u1',
    address: '1 Test Road',
    status: 'pending',
    created_at: '2026-07-02T00:00:00.000Z',
    certificate_type: 'EICR',
    folder_name: 'job-1',
    observations,
  } as unknown as JobDetail;
}

describe('applyObservations — canonical wording + rationale from initial extraction', () => {
  it('persists regulation_title / regulation_description / rationale onto the new row', () => {
    const job = makeJob();
    const result: ExtractionResult = {
      readings: [],
      observations: [
        {
          observation_id: 'srv-1',
          observation_text: 'No RCD protection to socket outlets',
          code: 'C2',
          regulation: '411.3.3',
          regulation_title: 'Additional protection by RCD',
          regulation_description:
            'Socket-outlets rated up to 32 A shall have additional protection by an RCD.',
          rationale: 'sockets may supply portable equipment outdoors',
        },
      ],
    };
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const rows = applied!.patch.observations as ObservationRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].regulation).toBe('411.3.3');
    expect(rows[0].regulation_title).toBe('Additional protection by RCD');
    expect(rows[0].regulation_description).toContain('Socket-outlets rated up to 32 A');
    expect(rows[0].rationale).toBe('sockets may supply portable equipment outdoors');
  });

  it('leaves title/description/rationale absent on a table MISS (nulls on the wire)', () => {
    const job = makeJob();
    const result: ExtractionResult = {
      readings: [],
      observations: [
        {
          observation_id: 'srv-2',
          observation_text: 'Broken accessory faceplate in kitchen',
          code: 'C2',
          regulation: '134.1.1',
          regulation_title: null,
          regulation_description: null,
          rationale: null,
        },
      ],
    };
    const rows = applyExtractionToJob(job, result)!.patch.observations as ObservationRow[];
    expect(rows[0].regulation_title).toBeUndefined();
    expect(rows[0].regulation_description).toBeUndefined();
    expect(rows[0].rationale).toBeUndefined();
  });
});

describe('applyObservationUpdate — refinement HIT applies, MISS clears stale wording', () => {
  const baseRow: ObservationRow = {
    id: 'row-1',
    server_id: 'srv-9',
    code: 'C3',
    description: 'Consumer unit enclosure damaged',
    regulation: '416.2.1',
    regulation_title: 'Stale title from prior ref',
    regulation_description: 'Stale description from prior ref',
    rationale: 'original rationale',
  };

  it('update HIT overwrites canonical wording + rationale', () => {
    const job = makeJob([{ ...baseRow }]);
    const next = applyObservationUpdate(job, {
      observation_id: 'srv-9',
      observation_text: 'Consumer unit enclosure damaged',
      code: 'C3',
      regulation: '421.1.201',
      regulation_title: 'Consumer unit enclosure material',
      regulation_description: 'Enclosures shall comply with BS EN 61439-3.',
      rationale: 'non-compliant enclosure increases fire risk',
    });
    expect(next).not.toBeNull();
    expect(next![0].regulation).toBe('421.1.201');
    expect(next![0].regulation_title).toBe('Consumer unit enclosure material');
    expect(next![0].regulation_description).toBe('Enclosures shall comply with BS EN 61439-3.');
    expect(next![0].rationale).toBe('non-compliant enclosure increases fire risk');
  });

  it('update MISS (null title/description) CLEARS the stale canonical wording (iOS parity)', () => {
    const job = makeJob([{ ...baseRow }]);
    const next = applyObservationUpdate(job, {
      observation_id: 'srv-9',
      observation_text: 'Consumer unit enclosure damaged',
      code: 'C3',
      regulation: '999.9.9',
      regulation_title: null,
      regulation_description: null,
      rationale: null,
    });
    expect(next).not.toBeNull();
    // Stale HIT wording must not outlive its ref — the card falls back
    // to the bare `regulation` string.
    expect(next![0].regulation_title).toBeUndefined();
    expect(next![0].regulation_description).toBeUndefined();
    // Rationale keeps non-empty-overwrite-only semantics (iOS
    // `if let newRationale, !newRationale.isEmpty`).
    expect(next![0].rationale).toBe('original rationale');
  });

  it('CREATE-from-miss carries canonical wording + rationale onto the appended row', () => {
    const job = makeJob([]);
    const next = applyObservationUpdate(job, {
      observation_id: 'srv-new',
      observation_text: 'Undersized bonding conductor to water service',
      code: 'C2',
      regulation: '544.1.1',
      regulation_title: 'Main protective bonding conductor sizing',
      regulation_description: 'Cross-sectional area shall be not less than half that required.',
      rationale: 'bonding below minimum csa',
    });
    expect(next).not.toBeNull();
    expect(next).toHaveLength(1);
    expect(next![0].regulation_title).toBe('Main protective bonding conductor sizing');
    expect(next![0].regulation_description).toContain('Cross-sectional area');
    expect(next![0].rationale).toBe('bonding below minimum csa');
  });
});

describe('observation card render — iOS ObservationCardView order/emphasis', () => {
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

  function mount(element: React.ReactElement): { container: HTMLElement; root: Root } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(element);
    });
    return { container, root };
  }

  it('renders ref, canonical title, canonical description, then italic "Because {rationale}" in order', () => {
    const job = makeJob([
      {
        id: 'row-1',
        code: 'C2',
        description: 'No RCD protection to socket outlets',
        regulation: '411.3.3',
        regulation_title: 'Additional protection by RCD',
        regulation_description: 'Socket-outlets rated up to 32 A shall have RCD protection.',
        rationale: 'sockets may supply portable equipment outdoors',
      },
    ]);
    mounted = mount(
      <JobProvider initial={job}>
        <ObservationsPage />
      </JobProvider>
    );
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('411.3.3');
    expect(text).toContain('Additional protection by RCD');
    expect(text).toContain('Socket-outlets rated up to 32 A shall have RCD protection.');
    expect(text).toContain('Because sockets may supply portable equipment outdoors');
    // Order matches iOS ObservationCardView.swift:71-88: ref → title →
    // description → rationale.
    const refIdx = text.indexOf('411.3.3');
    const titleIdx = text.indexOf('Additional protection by RCD');
    const descIdx = text.indexOf('Socket-outlets rated up to 32 A');
    const ratIdx = text.indexOf('Because sockets');
    expect(refIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeGreaterThan(refIdx);
    expect(descIdx).toBeGreaterThan(titleIdx);
    expect(ratIdx).toBeGreaterThan(descIdx);
    // Rationale is italicised (iOS `.italic()`).
    const rationaleEl = Array.from(mounted.container.querySelectorAll('p')).find((p) =>
      (p.textContent ?? '').startsWith('Because ')
    );
    expect(rationaleEl?.className ?? '').toContain('italic');
  });

  it('table MISS renders only ref + rationale (no stale canonical lines)', () => {
    const job = makeJob([
      {
        id: 'row-2',
        code: 'C3',
        description: 'Broken accessory faceplate',
        regulation: '134.1.1',
        rationale: 'damaged accessory exposes live parts risk over time',
      },
    ]);
    mounted = mount(
      <JobProvider initial={job}>
        <ObservationsPage />
      </JobProvider>
    );
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('134.1.1');
    expect(text).toContain('Because damaged accessory exposes live parts risk over time');
  });
});
