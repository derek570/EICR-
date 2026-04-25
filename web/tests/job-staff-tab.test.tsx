/**
 * Job → Staff tab regression — Wave B parity follow-up.
 *
 * Locks the two behaviours the Wave-A audit flagged as the open P0 on the
 * Staff tab (Phase 5 Gap #5.1 + #5.3):
 *
 *   1. The roster is fetched from `api.inspectorProfiles(user.id)` on
 *      mount, **not** read from `(job as any).inspectors`. Pre-fix the
 *      page read an embedded `inspectors` field that nothing wrote, so
 *      every role picker was permanently empty and inspectors had to
 *      fall back to iOS to pick a signatory.
 *
 *   2. The picker rows + Test Equipment card consume the canonical
 *      `InspectorProfile` shape from `@/lib/types` — single `name` field
 *      (not `full_name`) and `*_serial_number` keys (not `*_serial`).
 *      The previous local `Inspector` type used drifted keys that
 *      crashed iOS round-trips for any field it tried to render.
 *
 * Mount strategy mirrors `pdf-tab.test.tsx` — inline `createRoot` rather
 * than RTL to dodge the React dual-copy hazard documented in
 * `vitest.config.ts`. lucide-react / next/navigation / job-context /
 * use-current-user / api-client are stubbed at module boundaries so the
 * test stays unit-sized.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('lucide-react', () => {
  const makeIcon = (name: string) =>
    // eslint-disable-next-line react/display-name
    React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) => (
      <span ref={ref} data-icon={name} {...props} />
    ));
  return {
    CheckCircle2: makeIcon('CheckCircle2'),
    ClipboardCheck: makeIcon('ClipboardCheck'),
    Gauge: makeIcon('Gauge'),
    Hammer: makeIcon('Hammer'),
    Info: makeIcon('Info'),
    PencilRuler: makeIcon('PencilRuler'),
    ShieldCheck: makeIcon('ShieldCheck'),
    Signature: makeIcon('Signature'),
    UserCheck: makeIcon('UserCheck'),
    Wrench: makeIcon('Wrench'),
    Zap: makeIcon('Zap'),
  };
});

const updateJobMock = vi.fn();
let jobStub: Record<string, unknown> = {};
let certificateTypeStub: 'EICR' | 'EIC' = 'EICR';

vi.mock('@/lib/job-context', () => ({
  useJobContext: () => ({
    job: jobStub,
    certificateType: certificateTypeStub,
    updateJob: updateJobMock,
    setJob: vi.fn(),
    isDirty: false,
    isSaving: false,
    saveError: null,
  }),
}));

let currentUserStub: { id: string; email: string; name: string } | null = null;
vi.mock('@/lib/use-current-user', () => ({
  useCurrentUser: () => ({ user: currentUserStub, loading: false, refresh: vi.fn() }),
}));

const inspectorProfilesMock =
  vi.fn<(userId: string) => Promise<import('@/lib/types').InspectorProfile[]>>();
vi.mock('@/lib/api-client', () => ({
  api: {
    inspectorProfiles: (userId: string) => inspectorProfilesMock(userId),
  },
}));

import StaffPage from '@/app/job/[id]/staff/page';

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<StaffPage />);
  });
  return { container, root };
}

let harness: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  inspectorProfilesMock.mockReset();
  updateJobMock.mockReset();
  currentUserStub = { id: 'user-7', email: 't@e.st', name: 'Tester' };
  certificateTypeStub = 'EICR';
  jobStub = { id: 'job-42', certificate_type: 'EICR' };
});

afterEach(() => {
  if (harness) {
    act(() => {
      harness!.root.unmount();
    });
    harness.container.remove();
    harness = null;
  }
});

describe('Wave B parity · Staff tab roster fetch + InspectorProfile shape', () => {
  it('fetches the roster from api.inspectorProfiles(user.id) on mount', async () => {
    inspectorProfilesMock.mockResolvedValueOnce([
      {
        id: 'insp-1',
        name: 'Alice Engineer',
        position: 'Approved Electrician',
      },
    ]);

    harness = mount();
    await act(async () => {
      // Allow the useEffect microtask + setState flush.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inspectorProfilesMock).toHaveBeenCalledTimes(1);
    expect(inspectorProfilesMock).toHaveBeenCalledWith('user-7');
    // Picker rows render the fetched roster — the empty-state card
    // ("No staff profiles configured yet") is gone.
    expect(harness.container.textContent).toContain('Alice Engineer');
    expect(harness.container.textContent).not.toContain('No staff profiles configured yet');
  });

  it('reads InspectorProfile.name (not full_name) for the picker label + avatar initial', async () => {
    inspectorProfilesMock.mockResolvedValueOnce([{ id: 'insp-2', name: 'Bob Wireman' }]);

    harness = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Display name comes through.
    expect(harness.container.textContent).toContain('Bob Wireman');
    // Avatar initial — first character of `name` after trim.
    const avatar = Array.from(harness.container.querySelectorAll('span')).find(
      (s) => s.textContent?.trim() === 'B'
    );
    expect(avatar).toBeDefined();
  });

  it('renders the Test Equipment card from *_serial_number / *_calibration_date keys', async () => {
    // The page's "active inspector" lookup matches `id === job.inspector_id`,
    // so the Equipment card mounts iff the inspector_id is set on the job
    // *and* the same id is in the fetched roster.
    jobStub = { id: 'job-42', certificate_type: 'EICR', inspector_id: 'insp-3' };
    inspectorProfilesMock.mockResolvedValueOnce([
      {
        id: 'insp-3',
        name: 'Carol Tester',
        mft_serial_number: 'MFT-001',
        mft_calibration_date: '2026-01-15',
        continuity_serial_number: 'CON-002',
        continuity_calibration_date: '2026-01-16',
        insulation_serial_number: 'IR-003',
        insulation_calibration_date: '2026-01-17',
        earth_fault_serial_number: 'EFL-004',
        earth_fault_calibration_date: '2026-01-18',
        rcd_serial_number: 'RCD-005',
        rcd_calibration_date: '2026-01-19',
      },
    ]);

    harness = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = harness.container.textContent ?? '';
    // All five serial numbers + calibration dates surface — confirming
    // the card reads the canonical `_number` keys, not the drifted
    // `*_serial` keys the local type used.
    expect(text).toContain('MFT-001');
    expect(text).toContain('CON-002');
    expect(text).toContain('IR-003');
    expect(text).toContain('EFL-004');
    expect(text).toContain('RCD-005');
    expect(text).toContain('2026-01-15');
    expect(text).toContain('2026-01-19');
  });

  it('does not call api.inspectorProfiles when no user is signed in', async () => {
    currentUserStub = null;
    harness = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspectorProfilesMock).not.toHaveBeenCalled();
  });

  it('falls back to the empty-state card when the API rejects', async () => {
    inspectorProfilesMock.mockRejectedValueOnce(new Error('roster fetch failed'));
    harness = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Empty-state copy still renders — error is intentionally swallowed
    // since the Settings → Staff page is the canonical place to debug.
    expect(harness.container.textContent).toContain('No staff profiles configured yet');
  });

  it('writes designer_id / constructor_id / inspector_id when EIC role pickers are clicked', async () => {
    certificateTypeStub = 'EIC';
    jobStub = { id: 'job-42', certificate_type: 'EIC' };
    inspectorProfilesMock.mockResolvedValueOnce([{ id: 'insp-9', name: 'Dan Designer' }]);

    harness = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Three EIC role buttons exist; clicking each writes the right field.
    const buttons = Array.from(harness.container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('Dan Designer')
    );
    expect(buttons).toHaveLength(3);

    // The "Responsible for Design" picker is rendered first.
    await act(async () => {
      buttons[0].click();
    });
    expect(updateJobMock).toHaveBeenLastCalledWith({ designer_id: 'insp-9' });

    await act(async () => {
      buttons[1].click();
    });
    expect(updateJobMock).toHaveBeenLastCalledWith({ constructor_id: 'insp-9' });

    await act(async () => {
      buttons[2].click();
    });
    expect(updateJobMock).toHaveBeenLastCalledWith({ inspector_id: 'insp-9' });
  });
});
