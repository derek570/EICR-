/**
 * A02D — every shared freshness sequence in `config/regex-freshness-vectors.json`
 * driven through the REAL mounted `RecordingProvider` (real Deepgram frame
 * parsing behind a captive socket, real `SonnetSession` decoder behind a
 * captive socket, real matcher / freshness / hold / apply / TTS FIFO), in
 * BOTH hint lanes. The module lane (`tests/regex-freshness-fixture.test.ts`)
 * pins the same vectors against the pure helpers; this lane pins that the
 * provider actually wires them (Codex diff-review cycle 1, IMPORTANT 5).
 *
 * Stream positions: the fixture's sample offsets are quantised UP to the
 * sender's 80 ms Flux frame (1,280 samples) — every vector's ordering and
 * equality relations survive that mapping (asserted in the module lane's
 * sibling). Delivery order in the fixture is not time order: a final listed
 * after a tap with an onset BEFORE the tap has its onset noted before the
 * tap here, exactly as the field produces it.
 *
 * Not asserted here (module lane only): `occurrence_fragments` and the
 * `bounded` retention metric — the provider exposes neither.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { JobProvider, useJobContext } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import {
  __resetHeldFragmentClarificationForTests,
  __resetModeStatusCuesForTests,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
  __resetUplinkLossDisclosureForTests,
  setConfirmationModeEnabled,
} from '@/lib/recording/tts';
import {
  destinationKeyFromChangedKey,
  readRegexDestinationValue,
} from '@/lib/recording/regex-fresh-occurrence';
import { buildHarnessServices, type FakeDeepgramService } from './fake-services';
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type RecordingApi = ReturnType<typeof useRecording>;
type JobApi = ReturnType<typeof useJobContext>;

function RecordingProbe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  // eslint-disable-next-line react-hooks/refs -- house harness pattern
  apiRef.current = useRecording();
  return null;
}
function JobProbe({ jobRef }: { jobRef: { current: JobApi | null } }) {
  // eslint-disable-next-line react-hooks/refs -- house harness pattern
  jobRef.current = useJobContext();
  return null;
}

const require = createRequire(import.meta.url);
const FIXTURE_PATH = require.resolve('../../../config/regex-freshness-vectors.json');

interface FixtureJob {
  circuits: Array<{ ref: string; designation: string; board_id?: string }>;
  boards?: Array<{ id: string; designation: string; slug: string }>;
}
interface FinalStep {
  kind: 'final';
  id: string;
  text: string;
  epoch: number;
  speech_start: number | null;
  window_end: number | null;
  session?: string;
  expect: {
    admitted: boolean;
    held: boolean;
    writes: Array<{ destination: string; value: string }>;
    clarification: string | null;
    job_value?: Record<string, string | null>;
    ask_pending?: boolean;
  };
}
type Step =
  | FinalStep
  | {
      kind: 'manual_clear' | 'manual_replace' | 'rejected_clear';
      destination: string;
      epoch: number;
      dispatched_offset: number;
      value?: string;
    }
  | {
      kind: 'server_clear' | 'server_replace';
      destination: string;
      causative: string;
      value?: string;
      expect?: { buffer_cutoff?: string };
    }
  | { kind: 'reconnect'; epoch: number }
  | { kind: 'new_session'; session: string; epoch: number }
  | { kind: 'bypass_final'; text: string }
  | { kind: 'open_ask'; question: string };
interface Sequence {
  id: string;
  description: string;
  job: FixtureJob;
  steps: Step[];
  lanes: Array<'hints_on' | 'hints_off'>;
}
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  freshness_sequences: Sequence[];
};

const FRAME = 1280;

function buildJob(fj: FixtureJob): JobDetail {
  return {
    id: 'job_a02d_fx',
    job_id: 'job_a02d_fx',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Harness Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: fj.circuits.map((c) => ({
      id: `row_${c.ref}${c.board_id ? `_${c.board_id}` : ''}`,
      circuit_ref: c.ref,
      circuit_designation: c.designation,
      ...(c.board_id ? { board_id: c.board_id } : {}),
    })),
    ...(fj.boards ? { boards: fj.boards } : {}),
    supply_characteristics: {},
    board_info: {},
    installation_details: {},
  } as unknown as JobDetail;
}

/** `circuit:<ref>:<field>[@<slug>]` | `supply:<f>` | `board:<f>` | `install:<f>` → canonical key. */
function destinationKey(dest: string, job: JobDetail): string {
  const [scope, ...rest] = dest.split(':');
  if (scope !== 'circuit') return `${scope}.${rest.join(':')}`;
  const [ref, fieldAndBoard] = rest;
  const [field, boardSlug] = fieldAndBoard.split('@');
  const rows = (job.circuits ?? []).filter((c) => c.circuit_ref === ref);
  let row = rows[0];
  if (boardSlug) {
    const board = (job.boards ?? []).find((b) => (b as { slug?: string }).slug === boardSlug);
    row =
      rows.find((c) => (c as { board_id?: string }).board_id === (board as { id?: string })?.id) ??
      row;
  }
  if (!row) throw new Error(`no circuit row for ${dest}`);
  return `circuit.${row.id}.${field}`;
}

const SECTION: Record<string, keyof JobDetail> = {
  supply: 'supply_characteristics',
  board: 'board_info',
  install: 'installation_details',
};

const LANES: Array<{ lane: 'hints_on' | 'hints_off'; env: string | undefined }> = [
  { lane: 'hints_on', env: '1' },
  { lane: 'hints_off', env: undefined },
];

for (const { lane, env } of LANES) {
  describe(`[invariant] A02D freshness sequences — mounted provider, ${lane}`, () => {
    let container: HTMLDivElement;
    let root: Root | null = null;

    beforeEach(() => {
      resetTtsQueue();
      __resetTtsFingerprintsForTests();
      __resetTtsWindowForTests();
      __resetModeStatusCuesForTests();
      __resetHeldFragmentClarificationForTests();
      __resetUplinkLossDisclosureForTests();
      setConfirmationModeEnabled(true);
      vi.stubEnv('NEXT_PUBLIC_REGEX_HINTS_ENABLED', env ?? '');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new TypeError('network disabled in harness'))
      );
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
      __resetHeldFragmentClarificationForTests();
      __resetUplinkLossDisclosureForTests();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    async function mount(initial: JobDetail) {
      const harness = buildHarnessServices({ sonnet: 'real-decoder' });
      const writes: Array<{ source: string; changedKeys: string[] }> = [];
      const baseObserver = harness.services.jobStateObserver;
      harness.services.jobStateObserver = (change) => {
        writes.push({ source: change.source, changedKeys: [...(change.changedKeys ?? [])] });
        baseObserver?.(change);
      };
      __setRecordingTestServices(harness.services);
      setDiagnosticTap(harness.services.diagnosticTap!);
      const apiRef: { current: RecordingApi | null } = { current: null };
      const jobRef: { current: JobApi | null } = { current: null };
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <JobProvider initial={initial}>
            <RecordingProvider>
              <RecordingProbe apiRef={apiRef} />
              <JobProbe jobRef={jobRef} />
            </RecordingProvider>
          </JobProvider>
        );
      });
      await act(async () => {
        await apiRef.current!.start();
      });
      expect(apiRef.current!.state).toBe('active');
      return { harness, apiRef, jobRef, writes };
    }

    async function runSequence(seq: Sequence) {
      const m = await mount(buildJob(seq.job));
      const dg = () => m.harness.refs.deepgram!;
      const sonnet = () => m.harness.refs.sonnet!;
      const diag = (c: string) => m.harness.diagnostics.filter((d) => d.category === c);
      const clarifications = () =>
        m.harness.tts.played.filter(
          (p) => p.kind === 'confirmation' && p.text.startsWith('I heard something')
        );
      const job = () => m.jobRef.current!.job;

      /** Let queued TTS / gate timers settle (a spoken question pauses the sender). */
      const settle = async () => {
        for (let i = 0; i < 3; i++) {
          await act(async () => {
            vi.advanceTimersByTime(600);
            await Promise.resolve();
          });
        }
        __resetTtsWindowForTests();
      };
      /** Advance the CURRENT service's dispatched stream to ⌈X / frame⌉ frames. */
      const position = async (samples: number) => {
        const target = Math.ceil(samples / FRAME) * FRAME;
        for (let guard = 0; guard < 6 && dg().dispatchedStreamOffset < target; guard++) {
          const before = dg().dispatchedStreamOffset;
          await act(async () => {
            dg().advanceDispatchedStream((target - before) / FRAME);
          });
          if (dg().dispatchedStreamOffset === before) await settle(); // sender paused behind TTS
        }
        expect(dg().dispatchedStreamOffset, `position ${samples}`).toBeGreaterThanOrEqual(target);
      };
      const readValue = (key: string): string | null => {
        const v = readRegexDestinationValue(job(), key);
        return v == null ? null : String(v);
      };
      const manualWrite = async (key: string, value: string | null) => {
        await act(async () => {
          m.jobRef.current!.updateJob((prev) => {
            if (key.startsWith('circuit.')) {
              const rest = key.slice('circuit.'.length);
              const dot = rest.lastIndexOf('.');
              const rowId = rest.slice(0, dot);
              const field = rest.slice(dot + 1);
              return {
                circuits: (prev.circuits ?? []).map((c) =>
                  c.id === rowId ? { ...c, [field]: value ?? '' } : c
                ),
              };
            }
            const dot = key.indexOf('.');
            const sectionName = SECTION[key.slice(0, dot)];
            return {
              [sectionName]: {
                ...((prev[sectionName] as Record<string, unknown>) ?? {}),
                [key.slice(dot + 1)]: value ?? '',
              },
            } as Partial<JobDetail>;
          });
        });
      };

      const services: FakeDeepgramService[] = [dg()];
      let currentEpoch = 1;
      let currentSession =
        seq.steps.find((s): s is FinalStep => s.kind === 'final')?.session ?? 'S1';
      const sequenceOf = new Map<string, number>();
      const utteranceOf = new Map<string, string>();
      const onsetNoted = new Set<string>();
      let laneStepIndex = 0;

      const done = new Set<number>();
      const runFinal = async (step: FinalStep, i: number) => {
        const at = `${seq.id}/${lane}/#${i} ${step.id}`;
        done.add(i);
        const stepSession = step.session ?? currentSession;
        const fromCurrent = step.epoch === currentEpoch && stepSession === currentSession;
        // The emitting service: the current one, or a superseded one for
        // an old-epoch / old-session final (its socket still answers).
        const emitter = fromCurrent ? dg() : services[Math.min(step.epoch, services.length) - 1];
        const windowsBefore = diag('a02d_final_window').length;
        const droppedBefore = diag('a02d_final_dropped_at_admission').length;
        const heldBefore = diag('a02d_final_held').length;
        const clarBefore = clarifications().length;
        const regexWritesBefore = m.writes.filter((w) => w.source === 'regex').length;
        const gateWritesBefore = diag('a02d_gate_only_fresh_writes').length;
        const sentBefore = sonnet().sentTranscripts.length;
        const askBefore = sonnet().sentAskAnswers.length;
        const savedAuto = emitter.autoConfirmOnset;
        emitter.autoConfirmOnset = false;
        if (fromCurrent && !onsetNoted.has(step.id)) {
          if (step.speech_start !== null) {
            // A new run whose onset confirms (StartOfTurn) at ITS position.
            await position(step.speech_start);
            await act(async () => {
              emitter.noteLocalSpeechOnset();
              emitter.emitSpeechStarted();
            });
          } else {
            // `unbounded`: a new run whose onset never receives provider
            // evidence (no StartOfTurn, no interim) before its EndOfTurn.
            await act(async () => {
              emitter.noteLocalSpeechOnset();
            });
          }
          onsetNoted.add(step.id);
        }
        await act(async () => {
          emitter.emitEndOfTurn(step.text, 0.9, (step.window_end ?? 0) / 16000);
          vi.advanceTimersByTime(700);
          await Promise.resolve();
        });
        emitter.autoConfirmOnset = savedAuto;
        await settle();
        const admitted = diag('a02d_final_window').length === windowsBefore + 1;
        expect(admitted, `${at} admitted`).toBe(step.expect.admitted);
        if (!step.expect.admitted) {
          expect(diag('a02d_final_dropped_at_admission').length, `${at} dropped`).toBe(
            droppedBefore + 1
          );
          expect(diag('a02d_final_held').length, `${at} no hold`).toBe(heldBefore);
          expect(clarifications().length, `${at} no clarification`).toBe(clarBefore);
          expect(sonnet().sentTranscripts.length, `${at} no send`).toBe(sentBefore);
          return;
        }
        sequenceOf.set(
          step.id,
          diag('a02d_final_window').slice(-1)[0].payload.finalSequence as number
        );
        const held = diag('a02d_final_held').length === heldBefore + 1;
        expect(held, `${at} held`).toBe(step.expect.held);
        if (held) {
          expect(
            clarifications()
              .slice(clarBefore)
              .map((p) => p.text),
            `${at} clarification`
          ).toEqual([step.expect.clarification]);
          expect(sonnet().sentTranscripts.length, `${at} held → no send`).toBe(sentBefore);
          expect(m.writes.filter((w) => w.source === 'regex').length, `${at} held → no write`).toBe(
            regexWritesBefore
          );
          if (step.expect.ask_pending !== undefined)
            expect(sonnet().peekInFlightToolCallId() !== null, `${at} ask pending`).toBe(
              step.expect.ask_pending
            );
          return;
        }
        expect(step.expect.clarification, `${at} no clarification expected`).toBeNull();
        expect(clarifications().length, `${at} no clarification`).toBe(clarBefore);
        // Remember this final's outbound identity (transcript or ask answer).
        if (sonnet().sentTranscripts.length > sentBefore) {
          const opts = sonnet().sentTranscripts.slice(-1)[0].options as { utteranceId?: string };
          if (opts.utteranceId) utteranceOf.set(step.id, opts.utteranceId);
        } else if (sonnet().sentAskAnswers.length > askBefore) {
          const u = sonnet().sentAskAnswers.slice(-1)[0].utteranceId;
          if (u) utteranceOf.set(step.id, u);
        }
        if (step.expect.ask_pending !== undefined)
          expect(sonnet().peekInFlightToolCallId() !== null, `${at} ask pending`).toBe(
            step.expect.ask_pending
          );
        const expected = step.expect.writes
          .map((w) => ({ destination: destinationKey(w.destination, job()), value: w.value }))
          .sort((a, b) => a.destination.localeCompare(b.destination));
        let actual: Array<{ destination: string; value: string }>;
        if (lane === 'hints_on') {
          actual = m.writes
            .filter((w) => w.source === 'regex')
            .slice(regexWritesBefore)
            .flatMap((w) => w.changedKeys)
            .map((k) => destinationKeyFromChangedKey(k))
            .filter((k): k is string => k !== null)
            .map((k) => ({ destination: k, value: readValue(k) ?? '' }));
        } else {
          actual = diag('a02d_gate_only_fresh_writes')
            .slice(gateWritesBefore)
            .flatMap((d) => d.payload.writes as Array<{ key: string; value: string }>)
            .map((w) => ({ destination: w.key, value: w.value }));
          expect(
            m.writes.filter((w) => w.source === 'regex').length,
            `${at} hints-off never writes`
          ).toBe(regexWritesBefore);
        }
        actual.sort((a, b) => a.destination.localeCompare(b.destination));
        expect(actual, `${at} writes`).toEqual(expected);
        if (step.expect.job_value && lane === 'hints_on') {
          for (const [dest, value] of Object.entries(step.expect.job_value)) {
            expect(readValue(destinationKey(dest, job())), `${at} job value ${dest}`).toBe(value);
          }
        }
      };

      for (let i = 0; i < seq.steps.length; i++) {
        const step = seq.steps[i];
        if (done.has(i)) continue;
        const at = `${seq.id}/${lane}/#${i} ${'id' in step ? step.id : step.kind}`;
        laneStepIndex = i;
        switch (step.kind) {
          case 'final': {
            await runFinal(step, i);
            break;
          }
          case 'manual_clear':
          case 'manual_replace': {
            // Look-ahead: finals delivered AFTER this tap whose onset precedes
            // it are in flight now — note ONE onset for them at the earliest
            // position (a confirmed onset serves every turn of its run).
            const pending: FinalStep[] = [];
            for (let j = i + 1; j < seq.steps.length; j++) {
              const later = seq.steps[j];
              if (later.kind === 'reconnect' || later.kind === 'new_session') break;
              if (later.kind !== 'final') continue;
              if (later.epoch !== currentEpoch || onsetNoted.has(later.id)) continue;
              if (later.speech_start !== null && later.speech_start < step.dispatched_offset)
                pending.push(later);
              else break; // a post-tap final ends the in-flight run
            }
            if (pending.length > 0) {
              await position(Math.min(...pending.map((f) => f.speech_start!)));
              await act(async () => {
                dg().noteLocalSpeechOnset();
                dg().emitSpeechStarted();
              });
              for (const f of pending) onsetNoted.add(f.id);
            }
            await position(step.dispatched_offset);
            const key = destinationKey(step.destination, job());
            if (step.kind === 'manual_clear' && readValue(key) === null) {
              // The fixture clears a destination the sequence never filled:
              // seed it so the tap is a real change (the seed's own
              // replacement cutoff names the same destination).
              await manualWrite(key, '0.99');
            }
            const boundariesBefore = diag('a02d_manual_boundary').length;
            await manualWrite(key, step.kind === 'manual_clear' ? null : (step.value ?? null));
            expect(diag('a02d_manual_boundary').length, `${at} boundary recorded`).toBe(
              boundariesBefore + 1
            );
            expect(
              diag('a02d_manual_boundary').slice(-1)[0].payload.destination,
              `${at} destination`
            ).toBe(key);
            break;
          }
          case 'rejected_clear':
            // A rejected/pending edit never reaches the mutation observer.
            break;
          case 'server_clear':
          case 'server_replace': {
            const key = destinationKey(step.destination, job());
            const [, ref, field] = step.destination.split(':');
            // The causative final's outbound identity. A final the gate did
            // NOT forward (e.g. `old_overlap_then_unrelated_speech`'s chatter
            // "What do you think of the weather today." is transcript-gate
            // blocked) has none: the server frame then carries no echo and
            // the mounted lane pins the plan's no-identity rule — the cutoff
            // does not advance (`causativeSequence` null) — instead of the
            // module lane's sequence-based cutoff.
            const utteranceId = utteranceOf.get(step.causative);
            const boundariesBefore = diag('a02d_server_boundary').length;
            await act(async () => {
              sonnet().emitRaw({
                type: 'field_corrected',
                circuit: Number(ref),
                field: field.split('@')[0],
                previous_value: readValue(key),
                ...(utteranceId ? { utterance_id: utteranceId } : {}),
              });
              if (step.kind === 'server_replace') {
                sonnet().emitRaw({
                  type: 'extraction',
                  result: {
                    ...(utteranceId ? { utterance_id: utteranceId } : {}),
                    readings: [{ circuit: Number(ref), field: 'zs', value: step.value ?? '' }],
                    confirmations: [
                      {
                        field: 'zs',
                        circuit: Number(ref),
                        text: `Circuit ${ref} Zs ${step.value}`,
                      },
                    ],
                  },
                });
              }
            });
            await settle();
            expect(diag('a02d_server_boundary').length, `${at} boundary`).toBeGreaterThan(
              boundariesBefore
            );
            if (step.expect?.buffer_cutoff) {
              const last = diag('a02d_server_boundary').slice(-1)[0].payload;
              expect(last.causativeSequence, `${at} buffer cutoff`).toBe(
                utteranceId ? sequenceOf.get(step.expect.buffer_cutoff) : null
              );
            }
            expect(readValue(key), `${at} value after`).toBe(
              step.kind === 'server_clear' ? null : (step.value ?? null)
            );
            break;
          }
          case 'reconnect': {
            // A service replacement (the provider's pause/resume constructs a
            // new DeepgramService under a new epoch); the old one keeps
            // answering inside its close grace.
            await act(async () => {
              m.apiRef.current!.pause();
            });
            await act(async () => {
              await m.apiRef.current!.resume();
            });
            expect(dg(), `${at} new service`).not.toBe(services[services.length - 1]);
            services.push(dg());
            currentEpoch = step.epoch;
            await settle();
            break;
          }
          case 'new_session': {
            await act(async () => {
              m.apiRef.current!.stop();
            });
            await act(async () => {
              await m.apiRef.current!.start();
            });
            services.push(dg());
            currentSession = step.session;
            currentEpoch = step.epoch;
            __resetHeldFragmentClarificationForTests();
            await settle();
            break;
          }
          case 'bypass_final': {
            // Deepgram delivers a socket's finals in order, so an in-flight
            // pre-tap final (its onset already noted by a tap's look-ahead)
            // reaches the client BEFORE a question spoken after the tap; the
            // fixture lists the boundary first because the module lane has
            // no clock. Deliver those finals now, then the question in a
            // new run of its own.
            for (let j = i + 1; j < seq.steps.length; j++) {
              const later = seq.steps[j];
              if (later.kind === 'reconnect' || later.kind === 'new_session') break;
              if (later.kind === 'final' && onsetNoted.has(later.id) && !done.has(j))
                await runFinal(later, j);
            }
            const sentBefore = sonnet().sentTranscripts.length;
            const heldBefore = diag('a02d_final_held').length;
            await act(async () => {
              dg().noteLocalSpeechOnset();
              dg().emitSpeechStarted();
              dg().emitEndOfTurn(step.text);
              vi.advanceTimersByTime(700);
              await Promise.resolve();
            });
            await settle();
            expect(sonnet().sentTranscripts.length, `${at} question forwarded`).toBe(
              sentBefore + 1
            );
            expect(diag('a02d_final_held').length, `${at} question not held`).toBe(heldBefore);
            expect(
              diag('conversation_admission_matcher_reset').some(
                (d) => d.payload.boundary === 'bypassed_final'
              ),
              `${at} bypass boundary`
            ).toBe(true);
            break;
          }
          case 'open_ask': {
            await act(async () => {
              sonnet().emitQuestion({
                question: step.question,
                question_type: 'clarification',
                tool_call_id: `tool_${i}`,
              });
              vi.advanceTimersByTime(50);
              await Promise.resolve();
            });
            await settle();
            expect(sonnet().peekInFlightToolCallId(), `${at} ask open`).toBe(`tool_${i}`);
            break;
          }
        }
      }
      void laneStepIndex;
    }

    for (const seq of fixture.freshness_sequences) {
      if (!seq.lanes.includes(lane)) continue;
      it(`${seq.id}`, async () => {
        await runSequence(seq);
      });
    }
  });
}
