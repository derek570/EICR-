/**
 * P1 hotfix regression — auto-seed-on-unhydrated-job data loss
 * (web/audit/INDEX-2026-07.md, "THIRD frontend bug FOUND 2026-07-02").
 *
 * The bug: `/job/[id]` paints from the IDB cache before the network
 * fetch lands. The Installation + Supply tabs auto-seed defaults on
 * mount (`ensureDateOfInspection` / `next_inspection_years=5` / the
 * supply N/A coercions), and the debounced `queueSaveJob` then PUTs
 * that state. If the job-detail GET fails or the doc painted was a
 * blank/summary cache entry, the seeders run against an EMPTY doc and
 * the save WIPES the job's sections server-side. Worse, the seed marks
 * the doc dirty, so JobProvider's dirty-guard then REJECTS the fresh
 * network doc — the wipe is self-reinforcing.
 *
 * The fix (mirrors iOS, which seeds only after `load()` succeeds):
 *   - `/job/[id]/layout.tsx` tracks `networkHydrated` and passes it as
 *     `<JobProvider hydrated>`.
 *   - `JobProvider` exposes `isHydrated`, flipped true only once a
 *     network doc has actually been ACCEPTED into provider state (so
 *     child seeder effects can never observe hydrated=true alongside a
 *     stale cached doc).
 *   - Both seeders gate on `isHydrated`.
 *
 * Mount strategy: inline `createRoot` (no RTL) per the dual-React
 * hazard documented in `vitest.config.ts` / `job-context.test.tsx`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobProvider, useJobContext } from '@/lib/job-context';
import type { JobDetail } from '@/lib/types';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// ---------------------------------------------------------------------------
// Module mocks — keep the page mounts unit-sized (same boundaries as
// `job-staff-tab.test.tsx`, but lucide is proxied so the icon list can't
// drift out of date with the pages' imports).
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const makeIcon = (name: string) =>
    // eslint-disable-next-line react/display-name
    React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) => (
      <span ref={ref} data-icon={name} {...props} />
    ));
  // Union of the Installation + Supply pages' icons and the shared UI
  // components they mount (chevrons for steppers/selects).
  const names = [
    'Building2',
    'Cable',
    'Calendar',
    'CheckCircle',
    'ChevronDown',
    'ChevronUp',
    'ClipboardList',
    'FileText',
    'Gauge',
    'Home',
    'Layers',
    'Power',
    'Ruler',
    'ShieldCheck',
    'Sigma',
    'User',
    'Wrench',
    'Zap',
  ];
  return Object.fromEntries(names.map((n) => [n, makeIcon(n)]));
});

vi.mock('@/hooks/use-postcode-lookup', () => ({
  usePostcodeLookup: () => ({ onChange: vi.fn() }),
}));

const queueSaveJobMock = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock('@/lib/pwa/queue-save-job', () => ({
  queueSaveJob: (...args: unknown[]) => queueSaveJobMock(...args),
}));

vi.mock('@/lib/auth', () => ({
  getUser: () => ({ id: 'user-1', email: 't@t.t', name: 'Tester' }),
}));

import InstallationPage from '@/app/job/[id]/installation/page';
import SupplyPage from '@/app/job/[id]/supply/page';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A blank/summary-shaped doc — what a bad cache paint delivers. */
const BLANK_CACHED: JobDetail = {
  id: 'job-1',
  address: '1 Test Road',
  status: 'pending',
  created_at: '2026-06-01T00:00:00Z',
  certificate_type: 'EICR',
};

/** The real server doc for the same job — populated sections. */
const SERVER_DOC: JobDetail = {
  ...BLANK_CACHED,
  updated_at: '2026-07-01T09:00:00Z',
  installation_details: {
    client_name: 'Mrs Field-Test',
    date_of_inspection: '2026-06-20',
    next_inspection_years: 10,
    next_inspection_due_date: '2036-06-20',
  },
  supply_characteristics: {
    earthing_arrangement: 'TN-C-S',
    spd_bs_en: 'BS EN 61643',
  },
} as JobDetail;

/** A server doc that is legitimately blank (brand-new job). */
const SERVER_BLANK: JobDetail = {
  ...BLANK_CACHED,
  updated_at: '2026-07-01T09:00:00Z',
};

// ---------------------------------------------------------------------------
// Harness — JobProvider + probe + optional page under test, with a
// rerender handle so tests can drive the cached → hydrated transition
// exactly the way the job layout does (new `initial` identity + the
// `hydrated` prop flipping in the same commit).
// ---------------------------------------------------------------------------

interface Harness {
  unmount: () => void;
  rerender: (initial: JobDetail, hydrated?: boolean) => void;
  ctxRef: React.MutableRefObject<ReturnType<typeof useJobContext> | null>;
}

function mount(
  initial: JobDetail,
  hydrated: boolean | undefined,
  Page?: React.ComponentType
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctxRef: Harness['ctxRef'] = { current: null };
  let root: Root | null = null;

  const Probe: React.FC = () => {
    const ctx = useJobContext();
    React.useLayoutEffect(() => {
      ctxRef.current = ctx;
    });
    return null;
  };

  const Host: React.FC<{ value: JobDetail; hyd?: boolean }> = ({ value, hyd }) => (
    <JobProvider initial={value} {...(hyd === undefined ? {} : { hydrated: hyd })}>
      <Probe />
      {Page ? <Page /> : null}
    </JobProvider>
  );

  act(() => {
    root = createRoot(container);
    root.render(<Host value={initial} hyd={hydrated} />);
  });

  return {
    unmount: () => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
    rerender: (next, hyd) => {
      act(() => {
        root?.render(<Host value={next} hyd={hyd} />);
      });
    },
    ctxRef,
  };
}

/** Run out the 800ms save debounce + the async flush. */
async function drainSaveWindow() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
}

describe('P1 hotfix · JobProvider hydration contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T10:00:00Z'));
    queueSaveJobMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults hydrated=true for callers that do not cache-then-hydrate', () => {
    const h = mount(SERVER_DOC, undefined);
    expect(h.ctxRef.current?.isHydrated).toBe(true);
    h.unmount();
  });

  it('hydrated={false} at mount → isHydrated stays false', () => {
    const h = mount(BLANK_CACHED, false);
    expect(h.ctxRef.current?.isHydrated).toBe(false);
    h.unmount();
  });

  it('flips true when the network doc replaces the cache paint', () => {
    const h = mount(BLANK_CACHED, false);
    h.rerender(SERVER_DOC, true);
    expect(h.ctxRef.current?.isHydrated).toBe(true);
    expect(h.ctxRef.current?.job.installation_details).toEqual(SERVER_DOC.installation_details);
    h.unmount();
  });

  it('flips true when the network doc matches the cached version (fresh cache, same updated_at)', () => {
    const cachedButCurrent: JobDetail = { ...SERVER_DOC };
    const h = mount(cachedButCurrent, false);
    expect(h.ctxRef.current?.isHydrated).toBe(false);
    // Network lands with the SAME id + updated_at — no replacement
    // needed, but the doc we hold IS the server version.
    h.rerender({ ...SERVER_DOC }, true);
    expect(h.ctxRef.current?.isHydrated).toBe(true);
    h.unmount();
  });

  it('stays false when dirty local edits force the network doc to be rejected', () => {
    const h = mount(BLANK_CACHED, false);
    act(() => {
      h.ctxRef.current!.updateJob({ address: 'user typed pre-hydration' });
    });
    h.rerender(SERVER_DOC, true);
    // Dirty-guard rejected the doc → state is cache+edits, NOT the
    // server doc → seeders must stay off.
    expect(h.ctxRef.current?.job.address).toBe('user typed pre-hydration');
    expect(h.ctxRef.current?.isHydrated).toBe(false);
    h.unmount();
  });
});

describe('P1 hotfix · Installation tab seeder gates on hydration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T10:00:00Z'));
    queueSaveJobMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('unhydrated blank paint → NO seed, NO dirty flag, NO save (the incident scenario)', async () => {
    const h = mount(BLANK_CACHED, false, InstallationPage);
    await drainSaveWindow();
    expect(h.ctxRef.current?.job.installation_details).toBeUndefined();
    expect(h.ctxRef.current?.isDirty).toBe(false);
    expect(queueSaveJobMock).not.toHaveBeenCalled();
    h.unmount();
  });

  it('hydration lands on a genuinely blank job → seed runs against the SERVER doc and saves', async () => {
    const h = mount(BLANK_CACHED, false, InstallationPage);
    await drainSaveWindow();
    expect(queueSaveJobMock).not.toHaveBeenCalled();

    h.rerender(SERVER_BLANK, true);
    const seeded = h.ctxRef.current?.job.installation_details as Record<string, unknown>;
    expect(seeded?.date_of_inspection).toBe('2026-07-02');
    expect(seeded?.next_inspection_years).toBe(5);
    expect(seeded?.next_inspection_due_date).toBe('2031-07-02');

    await drainSaveWindow();
    expect(queueSaveJobMock).toHaveBeenCalledTimes(1);
    const patch = queueSaveJobMock.mock.calls[0]![2] as Partial<JobDetail>;
    expect((patch.installation_details as Record<string, unknown>).next_inspection_years).toBe(5);
    h.unmount();
  });

  it('hydration lands on a POPULATED job → existing values survive, nothing to save', async () => {
    const h = mount(BLANK_CACHED, false, InstallationPage);
    h.rerender(SERVER_DOC, true);
    await drainSaveWindow();
    const details = h.ctxRef.current?.job.installation_details as Record<string, unknown>;
    // The pre-existing per-field guards keep server values intact …
    expect(details?.date_of_inspection).toBe('2026-06-20');
    expect(details?.next_inspection_years).toBe(10);
    expect(details?.client_name).toBe('Mrs Field-Test');
    // … and with no seed applied there is nothing to PUT.
    expect(queueSaveJobMock).not.toHaveBeenCalled();
    h.unmount();
  });

  it('regression: hydrated-at-mount (network won the race) still seeds exactly as before', async () => {
    const h = mount(SERVER_BLANK, true, InstallationPage);
    const seeded = h.ctxRef.current?.job.installation_details as Record<string, unknown>;
    expect(seeded?.date_of_inspection).toBe('2026-07-02');
    expect(seeded?.next_inspection_years).toBe(5);
    await drainSaveWindow();
    expect(queueSaveJobMock).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});

describe('P1 hotfix · Supply tab N/A coercions gate on hydration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T10:00:00Z'));
    queueSaveJobMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('unhydrated blank paint → NO N/A coercion, NO save', async () => {
    const h = mount(BLANK_CACHED, false, SupplyPage);
    await drainSaveWindow();
    expect(h.ctxRef.current?.job.supply_characteristics).toBeUndefined();
    expect(h.ctxRef.current?.isDirty).toBe(false);
    expect(queueSaveJobMock).not.toHaveBeenCalled();
    h.unmount();
  });

  it('hydration lands → N/A defaults seed empty fields but keep server values', async () => {
    const h = mount(BLANK_CACHED, false, SupplyPage);
    h.rerender(SERVER_DOC, true);
    const supply = h.ctxRef.current?.job.supply_characteristics as Record<string, unknown>;
    // Server value untouched by the coercion sweep …
    expect(supply?.spd_bs_en).toBe('BS EN 61643');
    expect(supply?.earthing_arrangement).toBe('TN-C-S');
    // … while genuinely-absent defaultable fields seed to N/A.
    expect(supply?.rcd_operating_current).toBe('N/A');
    expect(supply?.main_bonding_material).toBe('N/A');
    await drainSaveWindow();
    expect(queueSaveJobMock).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});
