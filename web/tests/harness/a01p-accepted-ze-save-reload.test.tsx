/**
 * A01P (Codex EP cycle-1) — the mandated save/reload proof through the REAL
 * boundaries, not an in-memory spread:
 *
 *   mounted RecordingProvider + JobProvider
 *     → final "Ze is 0.35" (regex prefill, hints ON) → accepted 0.35 (server
 *       reading + confirmation echo)
 *     → server correction 0.50 WITHOUT a fresh regex hit (+ echo)
 *     → JobProvider's debounced `flushSave` → real `queueSaveJob` (IDB outbox
 *       via fake-indexeddb, then `api.saveJob` PUT over a fetch-level fake
 *       server, then outbox removal + cache write-through)
 *     → reload: real `api.job()` GET → `JobDetailSchema.parse` → a FRESH
 *       JobProvider hydrated from that document (the app's own
 *       `job/[id]/layout.tsx` path)
 *     → both supply aliases and the Supply / Board tab displays read 0.50
 *     → "calculate Zs for circuit 1" writes 0.70 and speaks it exactly once.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

import { api } from '@/lib/api-client';
import { JobProvider, useJobContext } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import {
  setConfirmationModeEnabled,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
  __resetModeStatusCuesForTests,
} from '@/lib/recording/tts';
import BoardPage from '@/app/job/[id]/board/page';
import SupplyPage from '@/app/job/[id]/supply/page';
import { buildHarnessServices } from './fake-services';
import type { JobDetail } from '@/lib/types';

const USER_ID = 'user-1';
const JOB_ID = 'job_save_reload_1';

/** The GET shape the backend returns for this job (src/routes/jobs.js). */
function initialServerDoc(): Record<string, unknown> {
  return {
    id: JOB_ID,
    address: '1 Harness Way',
    status: 'done',
    created_at: '2026-09-01T09:00:00.000Z',
    updated_at: '2026-09-01T09:00:00.000Z',
    certificate_type: 'EICR',
    circuits: [{ id: 'row-1', circuit_ref: '1', circuit_designation: 'Cooker', r1_r2_ohm: '0.20' }],
    observations: [],
    board_info: {},
    boards: [{ id: 'main', designation: 'Main', board_type: 'main' }],
    installation_details: null,
    supply_characteristics: null,
    inspection_schedule: null,
    inspector_id: null,
    extent_and_type: null,
    design_construction: null,
    unassigned_photos: null,
  };
}

/** Fetch-level fake server: PUT merges the patch into the stored doc, GET
 *  returns it. Everything else is unreachable (network disabled). */
function fakeServer(doc: Record<string, unknown>) {
  const puts: Array<Record<string, unknown>> = [];
  const jobPath = `/api/job/${USER_ID}/${JOB_ID}`;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(jobPath) && (init?.method ?? 'GET').toUpperCase() === 'PUT') {
      const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      puts.push(patch);
      Object.assign(doc, patch);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith(jobPath)) {
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new TypeError('network disabled in harness');
  });
  return { fetchImpl, puts, doc };
}

type RecordingApi = ReturnType<typeof useRecording>;
function RecordingProbe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  apiRef.current = useRecording();
  return null;
}
function JobProbe() {
  const { job } = useJobContext();
  return <div data-testid="supply-probe">{JSON.stringify(job.supply_characteristics ?? null)}</div>;
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const labelEl = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent?.trim() === label
  );
  expect(labelEl, `label "${label}"`).toBeTruthy();
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(labelEl!.htmlFor)}`)!;
}

/** Pump real setImmediate/microtask work (IDB + fetch + promise chains)
 *  while the FAKE setTimeout clock is advanced in small steps. */
async function pump(ms: number) {
  for (let i = 0; i < Math.max(1, Math.ceil(ms / 100)); i++) {
    await act(async () => {
      vi.advanceTimersByTime(100);
      await new Promise<void>((r) => setImmediate(r));
      await Promise.resolve();
    });
  }
}

describe('[invariant] A01P — accepted Ze survives the REAL save and reload boundary; Calculate then speaks 0.70 once', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetTtsQueue();
    __resetTtsFingerprintsForTests();
    __resetTtsWindowForTests();
    __resetModeStatusCuesForTests();
    setConfirmationModeEnabled(true);
    window.localStorage.setItem('cm_user', JSON.stringify({ id: USER_ID, email: 'd@example.com' }));
    window.localStorage.setItem('cm_token', 'harness-token');
    vi.stubEnv('NEXT_PUBLIC_REGEX_HINTS_ENABLED', '1');
    // Fake ONLY the timers the pipeline's burst buffer and the JobProvider
    // debounce use; setImmediate stays real so fake-indexeddb and fetch
    // promise chains make progress.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    __setRecordingTestServices(null);
    setDiagnosticTap(null);
    resetTtsQueue();
    __resetModeStatusCuesForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    window.localStorage.removeItem('cm_user');
    window.localStorage.removeItem('cm_token');
  });

  async function mountRecording(initial: JobDetail) {
    const harness = buildHarnessServices();
    // Full patches (the harness bundle keeps only source + changedKeys).
    const changes: Array<{ source: string; patch: Record<string, unknown> }> = [];
    const baseObserver = harness.services.jobStateObserver;
    harness.services.jobStateObserver = (change) => {
      changes.push({ source: change.source, patch: change.patch as Record<string, unknown> });
      baseObserver?.(change);
    };
    __setRecordingTestServices(harness.services);
    setDiagnosticTap(harness.services.diagnosticTap!);
    const apiRef: { current: RecordingApi | null } = { current: null };
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <JobProvider initial={initial}>
          <RecordingProvider>
            <RecordingProbe apiRef={apiRef} />
            <JobProbe />
          </RecordingProvider>
        </JobProvider>
      );
    });
    await act(async () => {
      await apiRef.current!.start();
    });
    expect(apiRef.current!.state).toBe('active');
    return { harness, apiRef, changes };
  }

  async function dictate(harness: ReturnType<typeof buildHarnessServices>, text: string) {
    await act(async () => {
      harness.refs.deepgram!.emitSpeechStarted();
      harness.refs.deepgram!.emitEndOfTurn(text);
      vi.advanceTimersByTime(700);
    });
  }

  it('regex 0.35 → accepted → echo → server 0.50 (no fresh regex) → echo → SAVE → RELOAD → displays 0.50 → Calculate 0.70 spoken once', async () => {
    const server = fakeServer(initialServerDoc());
    vi.stubGlobal('fetch', server.fetchImpl);

    // ── Session 1: the accepted-Ze sequence, hydrated exactly as the app
    // does it (real GET through the adapter).
    const first = await api.job(USER_ID, JOB_ID);
    const { harness, changes } = await mountRecording(first);
    const sonnet = harness.refs.sonnet!;

    await dictate(harness, 'Ze is 0.35');
    // Regex prefill landed the short key (hints ON) before the server replied.
    expect(changes.some((c) => c.source === 'regex')).toBe(true);
    await act(async () => {
      sonnet.emitExtraction({
        readings: [{ circuit: 0, field: 'ze', value: '0.35' }],
        confirmations: [{ field: 'ze', circuit: 0, text: 'Ze 0.35' }],
      });
    });
    await dictate(harness, 'Actually make that nought point five');
    // No fresh regex hit for the correction — the server owns it.
    const regexChangesBefore = changes.filter((c) => c.source === 'regex').length;
    await act(async () => {
      sonnet.emitExtraction({
        readings: [{ circuit: 0, field: 'ze', value: '0.50' }],
        confirmations: [{ field: 'ze', circuit: 0, text: 'Ze 0.50' }],
      });
    });
    expect(changes.filter((c) => c.source === 'regex').length).toBe(regexChangesBefore);
    const played = () =>
      harness.tts.played.filter((p) => p.kind === 'confirmation').map((p) => p.text);
    expect(played()).toEqual(['Ze 0.35', 'Ze 0.50']);
    // No implicit derivation before an explicit Calculate.
    expect(changes.some((c) => JSON.stringify(c.patch).includes('"measured_zs_ohm":"0.55"'))).toBe(
      false
    );

    // ── REAL save boundary: the JobProvider debounce fires flushSave →
    // queueSaveJob → IDB outbox → api.saveJob PUT → outbox cleared.
    await pump(2_500);
    expect(server.puts.length).toBeGreaterThan(0);
    const persistedSupply = server.doc.supply_characteristics as Record<string, unknown>;
    expect(persistedSupply.ze).toBe('0.50');
    expect(persistedSupply.earth_loop_impedance_ze).toBe('0.50');
    expect(Object.values(persistedSupply)).not.toContain('0.35');

    // ── RELOAD: tear the session down and hydrate a fresh provider from the
    // real GET (JobDetailSchema.parse inside api.job).
    await act(async () => {
      root!.unmount();
    });
    root = null;
    __setRecordingTestServices(null);
    setDiagnosticTap(null);
    resetTtsQueue();
    __resetTtsFingerprintsForTests();
    __resetTtsWindowForTests();

    const reloaded = await api.job(USER_ID, JOB_ID);
    const reloadedSupply = reloaded.supply_characteristics as Record<string, unknown>;
    expect(reloadedSupply.ze).toBe('0.50');
    expect(reloadedSupply.earth_loop_impedance_ze).toBe('0.50');

    // Displays: the Supply tab's Ze input and the Board tab's Origin Ze.
    const displayRoot = createRoot(container);
    await act(async () => {
      displayRoot.render(
        <JobProvider initial={reloaded}>
          <SupplyPage />
          <BoardPage />
        </JobProvider>
      );
    });
    expect(inputByLabel(container, 'Earth loop impedance Ze (Ω)').value).toBe('0.50');
    expect(inputByLabel(container, 'Origin Ze (Ω)').value).toBe('0.50');
    await act(async () => {
      displayRoot.unmount();
    });

    // ── Session 2 on the reloaded document: the explicit Calculate.
    const second = await mountRecording(reloaded);
    await dictate(second.harness, 'calculate Zs for circuit 1');
    const calcPlayed = second.harness.tts.played
      .filter((p) => p.kind === 'confirmation')
      .map((p) => p.text);
    expect(calcPlayed).toEqual(['Circuit 1, Zs calculated as 0.70 ohms']);
    expect(second.harness.refs.sonnet!.sentTranscripts).toHaveLength(0);
    const local = second.changes.filter((c) => c.source === 'local_command');
    expect(local).toHaveLength(1);
    const row = (local[0].patch.circuits as Array<Record<string, unknown>>)[0];
    expect(row.measured_zs_ohm).toBe('0.70');

    // …and that write persists through the same real save path.
    const putsBefore = server.puts.length;
    await pump(2_500);
    expect(server.puts.length).toBeGreaterThan(putsBefore);
    const persistedRows = server.doc.circuits as Array<Record<string, unknown>>;
    expect(persistedRows[0].measured_zs_ohm).toBe('0.70');
  });
});
