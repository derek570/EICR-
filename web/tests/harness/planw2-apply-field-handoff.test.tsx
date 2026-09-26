/**
 * PLAN-W2 (Decision 7 wrong-value wave) — the web apply-field routing table,
 * through the REAL RecordingProvider and the REAL SonnetSession decoder.
 *
 * A recognised apply-field command executes locally only when the job has
 * 0–1 boards, the value contract accepted its value, and the field is not a
 * W2.7 measured reading or cable size. Every other one is declined:
 *   1 capture open → capture lag line; 2 no session → session lag line;
 *   3 unresolved + ask live → ask lag line (Decision 15);
 *   4 unresolved → hand-off with CD1 authority;
 *   5 two or more boards → forward through the ordinary routing (W-1.4);
 *   6 W2.7 field → forward with no authority (Decision W-1.3).
 * A declined command writes nothing by ANY path: the local applier, the regex
 * layer (hints ON in this suite, so a regex write would show up in the job)
 * and the forwarded frame's regex summary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { JobProvider, useJobContext } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import {
  __resetModeStatusCuesForTests,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
  setConfirmationModeEnabled,
} from '@/lib/recording/tts';
import type { JobDetail } from '@/lib/types';
import { buildHarnessServices, type RealDecoderSonnetSession } from './fake-services';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const askFixture = JSON.parse(
  readFileSync(
    path.join(__dirname, '..', '..', '..', 'config', 'ask-class-lifetimes-v1.json'),
    'utf8'
  )
) as { vectors: Array<{ id: string; tool_call_id: string }> };
const LIVE_ASK_ID = askFixture.vectors.find((v) => v.id === 'live_openai_call')!.tool_call_id;

const ASK_TAIL = 'Answer the question first, then say it again.';
const CAPTURE_TAIL = 'Finish the feedback first, then say it again.';

type Row = Record<string, unknown>;

function makeJob(opts: { twoBoards?: boolean } = {}): JobDetail {
  const circuits: Row[] = opts.twoBoards
    ? [
        { id: 'm3', circuit_ref: '3', circuit_designation: 'Sockets', board_id: 'main' },
        { id: 'g3', circuit_ref: '3', circuit_designation: 'Garage sockets', board_id: 'garage' },
      ]
    : [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Lights',
          r1_r2_ohm: '0.45',
        },
        { id: 'c3', circuit_ref: '3', circuit_designation: 'Sockets' },
        { id: 'c4', circuit_ref: '4', circuit_designation: 'Kitchen' },
      ];
  return {
    id: 'job_planw2',
    job_id: 'job_planw2',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Contract Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    supply_characteristics: { ze: '0.35' },
    ...(opts.twoBoards
      ? {
          boards: [
            { id: 'main', designation: 'Main DB', board_type: 'main' },
            { id: 'garage', designation: 'Garage CU', board_type: 'sub_distribution' },
          ],
        }
      : {}),
    circuits,
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;
type JobApi = ReturnType<typeof useJobContext>;
function Probe({
  apiRef,
  jobRef,
}: {
  apiRef: { current: RecordingApi | null };
  jobRef: { current: JobApi | null };
}) {
  // eslint-disable-next-line react-hooks/refs -- house harness pattern
  apiRef.current = useRecording();
  // eslint-disable-next-line react-hooks/refs -- house harness pattern
  jobRef.current = useJobContext();
  return null;
}

type Bundle = ReturnType<typeof buildHarnessServices>;

describe('PLAN-W2 — web apply-field routing (Decision 7)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTtsQueue();
    __resetModeStatusCuesForTests();
    __resetTtsFingerprintsForTests();
    __resetTtsWindowForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    vi.stubEnv('NEXT_PUBLIC_REGEX_HINTS_ENABLED', '1');
    setConfirmationModeEnabled(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    __setRecordingTestServices(null);
    setDiagnosticTap(null);
    resetTtsQueue();
    __resetModeStatusCuesForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  let teardownSonnet: (() => void) | null = null;
  async function mount(opts: { twoBoards?: boolean } = {}) {
    const h = buildHarnessServices({ sonnet: 'real-decoder' }) as unknown as Bundle;
    teardownSonnet = null;
    h.services.exposeSonnetTeardown = (teardown) => {
      teardownSonnet = teardown;
    };
    __setRecordingTestServices(h.services);
    setDiagnosticTap(h.services.diagnosticTap!);
    const apiRef: { current: RecordingApi | null } = { current: null };
    const jobRef: { current: JobApi | null } = { current: null };
    await act(async () => {
      root.render(
        <JobProvider initial={makeJob(opts)}>
          <RecordingProvider>
            <Probe apiRef={apiRef} jobRef={jobRef} />
          </RecordingProvider>
        </JobProvider>
      );
    });
    await act(async () => {
      await apiRef.current!.start();
    });
    expect(apiRef.current!.state).toBe('active');
    return {
      h,
      sonnet: () => h.refs.sonnet as unknown as RealDecoderSonnetSession,
      api: () => apiRef.current!,
      job: () => jobRef.current!,
    };
  }
  type Mounted = Awaited<ReturnType<typeof mount>>;

  const final = async (h: Bundle, text: string) => {
    await act(async () => {
      h.refs.deepgram!.emitEndOfTurn(text);
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
  };
  const played = (h: Bundle) => h.tts.played.map((p) => p.text);
  const wire = (s: RealDecoderSonnetSession, type: string) => {
    void s.wireTranscripts;
    return s.wireFrames.filter((f) => f.type === type);
  };
  const circuits = (m: Mounted) =>
    JSON.parse(JSON.stringify((m.job().job as unknown as { circuits?: Row[] }).circuits ?? []));
  const diag = (m: Mounted, category: string) =>
    m.h.diagnostics.filter((d) => d.category === category);

  async function openAsk(s: RealDecoderSonnetSession) {
    await act(async () => {
      s.emitRaw({
        type: 'ask_user_started',
        tool_call_id: LIVE_ASK_ID,
        question: 'What is the observation about?',
        reason: 'observation_clarify',
        expected_answer_shape: 'free_text',
        context_field: null,
        context_circuit: null,
      });
    });
  }

  /** Acceptance 2 — nothing written by any path, no regex summary on the
   *  frame, and the matcher never admitted the final. */
  function expectNoLocalWrite(m: Mounted, before: Row[], text: string) {
    expect(circuits(m)).toEqual(before);
    for (const f of wire(m.sonnet(), 'transcript').filter((x) => x.text === text)) {
      expect(f.regexResults ?? f.regex_results).toBeUndefined();
    }
    const sendDiag = diag(m, 'pipeline_sonnet_send').filter(
      (d) => d.payload.textPreview === text.slice(0, 80)
    );
    for (const d of sendDiag) expect(d.payload.regexHintsCount).toBe(0);
    expect(diag(m, 'a02d_occurrence_decisions')).toEqual([]);
    expect(diag(m, 'pipeline_regex_applied')).toEqual([]);
  }

  // ── Row 4 — single board, no ask: hand off ─────────────────────────────
  it.each([
    'Polarity not correct for circuit 3',
    'RCD trip time 25 to 30 for circuit 3',
    'Number of points for circuit 4 is 6 plus 2 spurs',
  ])(
    'row 4 — "%s": nothing written by any path, one ordinary transcript, nothing spoken',
    async (text) => {
      const m = await mount();
      const before = circuits(m);
      await final(m.h, text);
      expectNoLocalWrite(m, before, text);
      const sent = wire(m.sonnet(), 'transcript');
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty('client_command');
      expect(sent[0]).not.toHaveProperty('in_response_to');
      expect(played(m.h)).toEqual([]);
      expect(m.h.chimes.count).toBe(1);
      expect(diag(m, 'apply_field_value_unresolved_routed').at(-1)?.payload).toMatchObject({
        route: 'handoff',
      });
    }
  );

  // ── Row 3 — ask live: lag line, nothing forwarded ──────────────────────
  it('row 3 — ask live: one lag line with the ask tail, zero transcripts, the ask still live', async () => {
    const m = await mount();
    await openAsk(m.sonnet());
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    const before = circuits(m);
    const sentBefore = wire(m.sonnet(), 'transcript').length;
    const spokenBefore = played(m.h).length;
    await final(m.h, 'Polarity not correct for circuit 3');
    expect(circuits(m)).toEqual(before);
    expect(wire(m.sonnet(), 'transcript')).toHaveLength(sentBefore);
    expect(wire(m.sonnet(), 'ask_user_answered')).toHaveLength(0);
    expect(m.sonnet().hasUnresolvedBackendAsk()).toBe(true);
    expect(played(m.h).slice(spokenBefore)).toEqual([
      `I couldn't record polarity 'not correct'. ${ASK_TAIL}`,
    ]);
  });

  // ── Row 1 — capture open: lag line, capture untouched ──────────────────
  it('row 1 — feedback capture open: one capture lag line, nothing written, the capture does not absorb it', async () => {
    const m = await mount();
    await final(m.h, 'feedback the polarity column is confusing');
    const before = circuits(m);
    const sentBefore = wire(m.sonnet(), 'transcript').length;
    const continuingBefore = diag(m, 'feedback_capture_continuing').length;
    await final(m.h, 'Polarity not correct for circuit 3');
    expect(circuits(m)).toEqual(before);
    expect(wire(m.sonnet(), 'transcript')).toHaveLength(sentBefore);
    expect(played(m.h)).toContain(`I couldn't record polarity 'not correct'. ${CAPTURE_TAIL}`);
    expect(diag(m, 'feedback_capture_continuing')).toHaveLength(continuingBefore);
  });

  // ── Accepted value, one board: still local ─────────────────────────────
  it('an accepted value on a one-board job still executes locally with one read-back and no send', async () => {
    const m = await mount();
    await final(m.h, 'RCD trip time 25 ms for circuit 3');
    expect(circuits(m).find((c: Row) => c.circuit_ref === '3').rcd_time_ms).toBe('25');
    expect(wire(m.sonnet(), 'transcript')).toHaveLength(0);
    expect(played(m.h)).toHaveLength(1);
  });

  it('W2-2 — "Polarity correct for circuit 3" stores ✓ and the read-back says "correct"', async () => {
    const m = await mount();
    await final(m.h, 'Polarity correct for circuit 3');
    expect(circuits(m).find((c: Row) => c.circuit_ref === '3').polarity_confirmed).toBe('✓');
    expect(played(m.h)).toHaveLength(1);
    expect(played(m.h)[0]).toContain('correct');
    expect(played(m.h)[0]).not.toContain('✓');
  });

  // ── Row 5 — two boards ──────────────────────────────────────────────────
  it.each(['RCD trip time 25 for circuit 3', 'RCD trip time 25 ms for all circuits'])(
    'row 5 — two boards, "%s": neither board written, one transcript, no client_command, nothing spoken',
    async (text) => {
      const m = await mount({ twoBoards: true });
      const before = circuits(m);
      await final(m.h, text);
      expectNoLocalWrite(m, before, text);
      const sent = wire(m.sonnet(), 'transcript');
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty('client_command');
      expect(played(m.h)).toEqual([]);
      expect(diag(m, 'apply_field_forwarded').at(-1)?.payload).toMatchObject({
        reason: 'multi_board',
        boardCount: 2,
      });
    }
  );

  it('row 5 — two boards with an ask live: forwarded through the ordinary routing, Stage 6 routing kept', async () => {
    const m = await mount({ twoBoards: true });
    await openAsk(m.sonnet());
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    const before = circuits(m);
    const spokenBefore = played(m.h).length;
    await final(m.h, 'RCD trip time 25 for circuit 3');
    expect(circuits(m)).toEqual(before);
    expect(played(m.h).slice(spokenBefore)).toEqual([]);
    const sent = wire(m.sonnet(), 'transcript');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('client_command');
    const send = diag(m, 'pipeline_sonnet_send').at(-1)!.payload;
    expect(send.cd1LocalForwardAuthority).toBe(false);
    expect(send.hasInFlightAsk).toBe(true);
    expect(wire(m.sonnet(), 'ask_user_answered')).toHaveLength(1);
  });

  it('W2-6 — two boards, capture open: one capture lag line, no write, nothing forwarded', async () => {
    const m = await mount({ twoBoards: true });
    await final(m.h, 'feedback the board picker is slow');
    const before = circuits(m);
    const sentBefore = wire(m.sonnet(), 'transcript').length;
    const continuingBefore = diag(m, 'feedback_capture_continuing').length;
    for (const [text, label, heard] of [
      ['RCD trip time 25 for circuit 3', 'RCD trip time', '25'],
      ['Zs 0.35 for circuit 3', 'Zs', '0.35'],
    ] as const) {
      await final(m.h, text);
      expect(played(m.h)).toContain(`I couldn't record ${label} '${heard}'. ${CAPTURE_TAIL}`);
    }
    expect(circuits(m)).toEqual(before);
    expect(wire(m.sonnet(), 'transcript')).toHaveLength(sentBefore);
    expect(diag(m, 'feedback_capture_continuing')).toHaveLength(continuingBefore);
  });

  // ── Row 2 / W2-4 — no Sonnet session ───────────────────────────────────
  // No production path dispatches a final with the session null (it is torn
  // down only alongside Deepgram, and a buffered final is dropped at teardown),
  // so the harness nulls it through the `exposeSonnetTeardown` seam while the
  // fake Deepgram stays live. Without the row, the forward would chime and then
  // vanish in `sonnetRef.current?.sendTranscript`.
  it.each([
    ['RCD trip time 25 for circuit 3', 'RCD trip time', '25'],
    ['Zs 0.35 for circuit 3', 'Zs', '0.35'],
  ] as const)(
    'row 2 — two boards, no session, "%s": one session lag line, no chime, no patch',
    async (text, label, heard) => {
      const m = await mount({ twoBoards: true });
      await act(async () => {
        teardownSonnet!();
      });
      const before = circuits(m);
      const chimesBefore = m.h.chimes.count;
      const spokenBefore = played(m.h).length;
      await final(m.h, text);
      expect(circuits(m)).toEqual(before);
      expect(m.h.chimes.count).toBe(chimesBefore);
      expect(played(m.h).slice(spokenBefore)).toEqual([
        `I couldn't record ${label} '${heard}'. I'm not connected. Say it again in a moment.`,
      ]);
      expect(diag(m, 'pipeline_sonnet_send')).toEqual([]);
    }
  );

  it('row 2 — one board, no session, a W2.7 field: the session lag line, no chime, no patch', async () => {
    const m = await mount();
    await act(async () => {
      teardownSonnet!();
    });
    const before = circuits(m);
    await final(m.h, 'IR live earth 200 MΩ for circuit 3');
    expect(circuits(m)).toEqual(before);
    expect(m.h.chimes.count).toBe(0);
    expect(played(m.h)).toEqual([
      "I couldn't record insulation resistance live-earth '200 mω'. I'm not connected. Say it again in a moment.",
    ]);
  });

  // Review cycle 1 (routing BLOCKER) — a recognised W2.7 command with no digit
  // and only a weak trigger must still reach the model, not be gate-dropped.
  it('row 6 — "cable n/a for all": forwarded once with gate authority, nothing written, nothing spoken', async () => {
    const m = await mount();
    const before = circuits(m);
    const text = 'cable n/a for all';
    await final(m.h, text);
    expectNoLocalWrite(m, before, text);
    expect(wire(m.sonnet(), 'transcript').map((f) => f.text)).toEqual([text]);
    expect(m.h.chimes.count).toBe(1);
    expect(played(m.h)).toEqual([]);
    const send = diag(m, 'pipeline_sonnet_send').at(-1)!.payload;
    expect(send.cd1LocalForwardAuthority).toBe(false);
    expect(send.clientCommand).toBeNull();
  });

  // ── Row 6 — W2.7 fields forward as on iOS ──────────────────────────────
  it.each(['IR live earth 200 MΩ for all circuits', 'IR live earth 200 MΩ for circuit 3'])(
    'row 6 — "%s": no local patch and no regex write, one ordinary transcript',
    async (text) => {
      const m = await mount();
      const before = circuits(m);
      await final(m.h, text);
      expectNoLocalWrite(m, before, text);
      const sent = wire(m.sonnet(), 'transcript');
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty('client_command');
      expect(played(m.h)).toEqual([]);
      expect(diag(m, 'pipeline_sonnet_send').at(-1)!.payload.cd1LocalForwardAuthority).toBe(false);
    }
  );

  // ── W2-16 — trailing text after the scope ──────────────────────────────
  it('W2-16 — "RCD trip time 25 for circuit 3 and 4": job unchanged, no lag line, one transcript with no regex results', async () => {
    const m = await mount();
    const before = circuits(m);
    const text = 'RCD trip time 25 for circuit 3 and 4';
    await final(m.h, text);
    expectNoLocalWrite(m, before, text);
    expect(wire(m.sonnet(), 'transcript').map((f) => f.text)).toEqual([text]);
    expect(played(m.h)).toEqual([]);
  });

  it('W2-16 — with a capture open the same final is ordinary capture text: no lag line, no write', async () => {
    const m = await mount();
    await final(m.h, 'feedback trip times are odd');
    const before = circuits(m);
    const continuingBefore = diag(m, 'feedback_capture_continuing').length;
    await final(m.h, 'RCD trip time 25 for circuit 3 and 4');
    expect(circuits(m)).toEqual(before);
    expect(played(m.h).some((t) => t.startsWith("I couldn't record"))).toBe(false);
    expect(diag(m, 'feedback_capture_continuing')).toHaveLength(continuingBefore + 1);
  });

  // ── W2-11 — the protected FIFO ─────────────────────────────────────────
  it('W2-11 — a queued read-back survives a later apply-field read-back and a lag line', async () => {
    const m = await mount();
    m.h.tts.manual = true;
    await final(m.h, 'calculate Zs for circuit 1');
    await final(m.h, 'RCD trip time 25 ms for circuit 3');
    await openAsk(m.sonnet());
    await final(m.h, 'Polarity not correct for circuit 3');
    await act(async () => {
      m.h.tts.releaseAll();
      vi.advanceTimersByTime(50);
      m.h.tts.releaseAll();
      vi.advanceTimersByTime(50);
      m.h.tts.releaseAll();
    });
    const heard = played(m.h);
    const zs = heard.findIndex((t) => t.includes('Zs calculated'));
    const trip = heard.findIndex((t) => t.includes('RCD trip time') && t.includes('25'));
    const lag = heard.findIndex((t) => t.startsWith("I couldn't record polarity"));
    expect(zs).toBeGreaterThanOrEqual(0);
    expect(trip).toBeGreaterThan(zs);
    expect(lag).toBeGreaterThan(trip);
  });
});
