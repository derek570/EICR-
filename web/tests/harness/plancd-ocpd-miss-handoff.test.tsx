/**
 * PLAN-CD (feedback-2026-09-17 wave) — the Decision 7 handoff for a failed
 * client-local `ocpd_bs_en` canonicalisation, through the REAL
 * RecordingProvider and the REAL SonnetSession decoder (B0 harness recipe;
 * `RealDecoderSonnetSession` pushes every backend frame through production
 * `handleMessage`, so the CD2 latch under test is the production one).
 *
 * The fixture utterance is "OCPD standard grey square for all": the only one
 * that both parses as an apply-field command AND is blocked by the client
 * gate without CD1 (plan finding 5). "for all circuits" and "for circuit N"
 * pass the gate on their own and would go green with CD1 missing.
 *
 * Acceptance items covered here (web): 1 (the miss at real ingress, no ask
 * live), 2 (the paired success), 4 (the ask-pending case, its negative
 * control, the windows web can reach, the second ask class, the live-provider
 * and unknown-prefix vectors, and the interactive-only admission pair).
 *
 * No ask-class prefix and no lifetime is written in this file: ids come from
 * the fixture's vectors, lifetimes from the latched entry at test time.
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
import { classifyAskId } from '@/lib/recording/unresolved-ask-authority';
import type { JobDetail } from '@/lib/types';
import { buildHarnessServices, type RealDecoderSonnetSession } from './fake-services';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = JSON.parse(
  readFileSync(
    path.join(__dirname, '..', '..', '..', 'config', 'ask-class-lifetimes-v1.json'),
    'utf8'
  )
) as { vectors: Array<{ id: string; tool_call_id: string; expect_class: string }> };
const vectorId = (id: string): string => {
  const v = fixture.vectors.find((x) => x.id === id);
  if (!v) throw new Error(`fixture has no vector ${id}`);
  return v.tool_call_id;
};

const MISS = 'OCPD standard grey square for all';
const SUCCESS = 'OCPD standard 60898 for all circuits';
const MODEL_LINE = 'I could not match grey square to a standard. Which BS number is on the device?';

function makeJob(): JobDetail {
  return {
    id: 'job_plancd',
    job_id: 'job_plancd',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Handoff Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [
      { id: 'row-1', circuit_ref: '1', designation: 'Sockets', circuit_designation: 'Sockets' },
      { id: 'row-2', circuit_ref: '2', designation: 'Lights', circuit_designation: 'Lights' },
    ],
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

describe('PLAN-CD — ocpd_bs_en canonicalisation miss at the local command boundary (web)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTtsQueue();
    __resetModeStatusCuesForTests();
    __resetTtsFingerprintsForTests();
    __resetTtsWindowForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
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
  });

  async function mount(): Promise<{
    h: Bundle;
    sonnet: () => RealDecoderSonnetSession;
    api: () => RecordingApi;
    job: () => JobApi;
  }> {
    const h = buildHarnessServices({ sonnet: 'real-decoder' }) as unknown as Bundle;
    __setRecordingTestServices(h.services);
    setDiagnosticTap(h.services.diagnosticTap!);
    const apiRef: { current: RecordingApi | null } = { current: null };
    const jobRef: { current: JobApi | null } = { current: null };
    await act(async () => {
      root.render(
        <JobProvider initial={makeJob()}>
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

  /** The final's burst-buffer window: the dispatch (and the CD2 read) runs
   *  this long after the end of turn. */
  const BURST_MS = 500;
  const final = async (h: Bundle, text: string) => {
    await act(async () => {
      h.refs.deepgram!.emitEndOfTurn(text);
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };
  const played = (h: Bundle) => h.tts.played.map((p) => p.text);
  const count = (list: string[], pred: (t: string) => boolean) => list.filter(pred).length;
  const isReask = (t: string) =>
    t.includes("'grey square'") && t.includes("isn't a valid standard");
  const wire = (s: RealDecoderSonnetSession, type: string) => {
    void s.wireTranscripts; // collect everything written so far
    return s.wireFrames.filter((f) => f.type === type);
  };
  const ocpdValues = (j: JobApi) =>
    ((j.job as unknown as { circuits?: Array<{ ocpd_bs_en?: string }> }).circuits ?? []).map(
      (c) => c.ocpd_bs_en ?? null
    );
  const visibleEntries = (api: RecordingApi, text: string) =>
    api.transcript.filter((u) => u.text === text).length;

  async function openAsk(
    s: RealDecoderSonnetSession,
    toolCallId: string,
    frame: Record<string, unknown> = {}
  ) {
    await act(async () => {
      s.emitRaw({
        type: 'ask_user_started',
        tool_call_id: toolCallId,
        question: 'What is the observation about?',
        reason: 'observation_clarify',
        expected_answer_shape: 'free_text',
        context_field: null,
        context_circuit: null,
        ...frame,
      });
    });
  }

  /** The Decision 15 early return: the refusal, one spoken re-ask, nothing
   *  forwarded, and the ask exactly as live as before. */
  async function expectReaskKeptAskLive(
    m: Awaited<ReturnType<typeof mount>>,
    askId: string,
    before: { chimes: number; transcripts: number; answers: number }
  ) {
    const s = m.sonnet();
    expect(ocpdValues(m.job())).toEqual([null, null]);
    expect(count(played(m.h), isReask)).toBe(1);
    expect(m.h.chimes.count).toBe(before.chimes);
    expect(wire(s, 'transcript')).toHaveLength(before.transcripts);
    expect(wire(s, 'ask_user_answered')).toHaveLength(before.answers);
    expect(s.hasUnresolvedBackendAsk()).toBe(true);
    // Not consumed, not burned: the attribution latch is untouched too.
    expect(s.peekInFlightToolCallId()).toBe(askId);
    expect(visibleEntries(m.api(), MISS)).toBe(1);
    const routed = m.h.diagnostics.filter((d) => d.category === 'cd2_ocpd_miss_routed');
    expect(routed.at(-1)?.payload).toMatchObject({ route: 'reask', reason: 'ask_live' });
  }

  function snapshot(m: Awaited<ReturnType<typeof mount>>) {
    const s = m.sonnet();
    return {
      chimes: m.h.chimes.count,
      transcripts: wire(s, 'transcript').length,
      answers: wire(s, 'ask_user_answered').length,
    };
  }

  // ── Acceptance 1 ────────────────────────────────────────────────────────
  it('acceptance 1 — no ask live: nothing written, nothing spoken locally, one chime, one outbound transcript, one visible entry, one model-owned outcome', async () => {
    const m = await mount();
    const s = m.sonnet();
    expect(s.hasUnresolvedBackendAsk()).toBe(false);
    await final(m.h, MISS);
    expect(ocpdValues(m.job())).toEqual([null, null]);
    // No local speech of ANY kind — no re-ask and no success line.
    expect(played(m.h)).toEqual([]);
    expect(m.h.chimes.count).toBe(1);
    const sent = wire(s, 'transcript');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(MISS);
    // The authority stayed LOCAL: no marker, no hint for the field.
    expect(sent[0]).not.toHaveProperty('client_command');
    const hints = (sent[0].regexResults as Array<{ field: string }> | undefined) ?? [];
    expect(hints.filter((r) => r.field.includes('ocpd_bs_en'))).toEqual([]);
    expect(wire(s, 'ask_user_answered')).toHaveLength(0);
    expect(visibleEntries(m.api(), MISS)).toBe(1);
    const routed = m.h.diagnostics.filter((d) => d.category === 'cd2_ocpd_miss_routed');
    expect(routed).toHaveLength(1);
    expect(routed[0].payload).toMatchObject({ route: 'handoff', reason: 'no_ask_live' });
    // The model owns the turn: its one spoken outcome is the only speech.
    await act(async () => {
      s.emitVoiceCommandResponse({ understood: true, spoken_response: MODEL_LINE });
    });
    await advance(50);
    expect(played(m.h)).toEqual([MODEL_LINE]);
  });

  it('acceptance 1 — the two scope forms that already pass the gate still forward exactly once and speak nothing locally', async () => {
    for (const text of [
      'OCPD standard grey square for all circuits',
      'OCPD standard grey square for circuit 1',
    ]) {
      const m = await mount();
      await final(m.h, text);
      expect(ocpdValues(m.job())).toEqual([null, null]);
      expect(played(m.h)).toEqual([]);
      expect(wire(m.sonnet(), 'transcript').map((f) => f.text)).toEqual([text]);
      expect(m.h.chimes.count).toBe(1);
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
    }
  });

  // ── Acceptance 2 ────────────────────────────────────────────────────────
  it('acceptance 2 — a canonicalised apply still writes locally, reads back once, and forwards nothing', async () => {
    const m = await mount();
    await final(m.h, SUCCESS);
    expect(ocpdValues(m.job())).toEqual(['BS EN 60898', 'BS EN 60898']);
    expect(wire(m.sonnet(), 'transcript')).toHaveLength(0);
    expect(m.h.chimes.count).toBe(0);
    expect(played(m.h)).toHaveLength(1);
    expect(m.h.diagnostics.filter((d) => d.category === 'cd2_ocpd_miss_routed')).toEqual([]);
  });

  // ── Acceptance 4 ────────────────────────────────────────────────────────
  it('acceptance 4 — an unrelated observation_clarify ask live: one re-ask, nothing forwarded, the ask still live; negative control hands off', async () => {
    const m = await mount();
    const askId = vectorId('live_openai_call');
    await openAsk(m.sonnet(), askId);
    const before = snapshot(m);
    await final(m.h, MISS);
    await expectReaskKeptAskLive(m, askId, before);
  });

  it('acceptance 4 — an inverted pending-value ask live: one re-ask, nothing forwarded, the ask still live', async () => {
    const m = await mount();
    const askId = vectorId('broker_pvr');
    await openAsk(m.sonnet(), askId, {
      question: 'What was the rating?',
      reason: 'missing_value',
      expected_answer_shape: 'number',
      context_field: 'ocpd_rating_a',
      context_circuit: 1,
    });
    const before = snapshot(m);
    await final(m.h, MISS);
    await expectReaskKeptAskLive(m, askId, before);
  });

  it('acceptance 4 window — pre-TTS: the ask arrives while the inspector is speaking, before its prompt plays', async () => {
    const m = await mount();
    const askId = vectorId('live_openai_call');
    await act(async () => {
      m.h.refs.deepgram!.emitSpeechStarted();
    });
    await openAsk(m.sonnet(), askId);
    const before = snapshot(m);
    await final(m.h, MISS);
    const s = m.sonnet();
    expect(ocpdValues(m.job())).toEqual([null, null]);
    expect(count(played(m.h), isReask)).toBe(1);
    expect(m.h.chimes.count).toBe(before.chimes);
    expect(wire(s, 'transcript')).toHaveLength(before.transcripts);
    expect(wire(s, 'ask_user_answered')).toHaveLength(before.answers);
    expect(s.hasUnresolvedBackendAsk()).toBe(true);
  });

  it('acceptance 4 windows — client-stale and pending-FIFO purge: attribution state has expired, the backend ask has not', async () => {
    // Past the attribution stale window (10 s) and past the FIFO purge
    // (2 × stale window), both inside the dispatcher class's lifetime.
    for (const elapsedMs of [11_000, 21_000]) {
      const m = await mount();
      const askId = vectorId('live_openai_call');
      await openAsk(m.sonnet(), askId);
      await advance(elapsedMs);
      const [entry] = (
        m.sonnet().inner as unknown as {
          unresolvedAsks: { liveEntries(): Array<{ lifetimeMs: number }> };
        }
      ).unresolvedAsks.liveEntries();
      expect(elapsedMs).toBeLessThan(entry.lifetimeMs);
      // The attribution peek has gone empty — that is the window.
      const before = snapshot(m);
      await final(m.h, MISS);
      const s = m.sonnet();
      expect(ocpdValues(m.job())).toEqual([null, null]);
      expect(count(played(m.h), isReask)).toBe(1);
      expect(wire(s, 'transcript')).toHaveLength(before.transcripts);
      expect(wire(s, 'ask_user_answered')).toHaveLength(before.answers);
      expect(m.h.chimes.count).toBe(before.chimes);
      expect(s.hasUnresolvedBackendAsk()).toBe(true);
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      resetTtsQueue();
      __resetTtsFingerprintsForTests();
      __resetTtsWindowForTests();
    }
  });

  // The per-class timer path, asserted as ELAPSED TIME against the lifetime
  // recorded ON THE ENTRY: the second ask class, the live provider's form
  // and a form the fixture has no row for (its `default`). The CD2 read runs
  // BURST_MS after the end of turn, so the dictation is timed to land that
  // read exactly one tick before, then one tick past, the entry's lifetime.
  for (const id of ['script_srv_rcs_slot', 'live_openai_call', 'zzz_unknown_1']) {
    for (const side of ['before', 'past'] as const) {
      it(`acceptance 4 — ${id}: a read one tick ${side === 'before' ? 'before' : 'past'} the entry's lifetime ${side === 'before' ? 'keeps the re-ask' : 'hands off'}`, async () => {
        const askId = vectorId(id);
        const m = await mount();
        await openAsk(m.sonnet(), askId);
        const inner = m.sonnet().inner as unknown as {
          unresolvedAsks: { liveEntries(): Array<{ lifetimeMs: number; askClass: string }> };
        };
        const [entry] = inner.unresolvedAsks.liveEntries();
        expect(entry).toMatchObject(classifyAskId(askId));
        const readAt = side === 'before' ? entry.lifetimeMs - 1 : entry.lifetimeMs + 1;
        await advance(readAt - BURST_MS);
        const before = snapshot(m);
        await act(async () => {
          m.h.refs.deepgram!.emitEndOfTurn(MISS);
        });
        await advance(BURST_MS);
        const routed = m.h.diagnostics.filter((d) => d.category === 'cd2_ocpd_miss_routed');
        expect(routed).toHaveLength(1);
        if (side === 'before') {
          expect(routed[0].payload).toMatchObject({ route: 'reask', reason: 'ask_live' });
          expect(count(played(m.h), isReask)).toBe(1);
          expect(wire(m.sonnet(), 'transcript')).toHaveLength(before.transcripts);
          expect(m.h.chimes.count).toBe(before.chimes);
          expect(m.sonnet().hasUnresolvedBackendAsk()).toBe(true);
        } else {
          expect(routed[0].payload).toMatchObject({ route: 'handoff', reason: 'no_ask_live' });
          expect(count(played(m.h), isReask)).toBe(0);
          expect(wire(m.sonnet(), 'transcript').map((f) => f.text)).toContain(MISS);
          expect(m.h.chimes.count).toBe(before.chimes + 1);
        }
      });
    }
  }

  it('acceptance 4 — admission pair: an expected_answer_shape "none" frame never gates the handoff; an interactive one does', async () => {
    const m = await mount();
    const ackId = vectorId('script_srv_rcs_slot');
    await openAsk(m.sonnet(), ackId, { question: 'Got it.', expected_answer_shape: 'none' });
    expect(m.sonnet().hasUnresolvedBackendAsk()).toBe(false);
    await final(m.h, MISS);
    expect(count(played(m.h), isReask)).toBe(0);
    expect(wire(m.sonnet(), 'transcript').map((f) => f.text)).toEqual([MISS]);

    const m2 = await (async () => {
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      resetTtsQueue();
      __resetTtsFingerprintsForTests();
      __resetTtsWindowForTests();
      return mount();
    })();
    await openAsk(m2.sonnet(), ackId);
    expect(m2.sonnet().hasUnresolvedBackendAsk()).toBe(true);
    const before = snapshot(m2);
    await final(m2.h, MISS);
    expect(count(played(m2.h), isReask)).toBe(1);
    expect(wire(m2.sonnet(), 'transcript')).toHaveLength(before.transcripts);
  });

  it('the latch clears on cancel_pending_tts, and the next miss hands off', async () => {
    const m = await mount();
    const scriptId = vectorId('script_srv_ocpd_which');
    await openAsk(m.sonnet(), scriptId);
    expect(m.sonnet().hasUnresolvedBackendAsk()).toBe(true);
    const prefix = scriptId.slice(0, scriptId.indexOf('-', scriptId.indexOf('-') + 1) + 1);
    await act(async () => {
      m.sonnet().emitRaw({ type: 'cancel_pending_tts', prefix });
    });
    expect(m.sonnet().hasUnresolvedBackendAsk()).toBe(false);
    // Past the prompt's post-playback echo window, so the dictation is not
    // suppressed as the phone hearing itself.
    await advance(1_000);
    await final(m.h, MISS);
    expect(count(played(m.h), isReask)).toBe(0);
    expect(wire(m.sonnet(), 'transcript').map((f) => f.text)).toEqual([MISS]);
  });

  it('the latch clears when the inspector answers the ask, and the next miss hands off', async () => {
    const m = await mount();
    const askId = vectorId('live_openai_call');
    await openAsk(m.sonnet(), askId);
    await advance(1_000);
    await final(m.h, 'The socket faceplate is cracked');
    expect(wire(m.sonnet(), 'ask_user_answered').map((f) => f.tool_call_id)).toEqual([askId]);
    expect(m.sonnet().hasUnresolvedBackendAsk()).toBe(false);
    await advance(1_000);
    await final(m.h, MISS);
    expect(count(played(m.h), isReask)).toBe(0);
    expect(wire(m.sonnet(), 'transcript').map((f) => f.text)).toContain(MISS);
  });
});
