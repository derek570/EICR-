'use client';

import * as React from 'react';
import { startMicCapture, type MicCaptureHandle } from './recording/mic-capture';
import { DeepgramService, type DeepgramConnectionState } from './recording/deepgram-service';
import { resampleTo16k } from './recording/resample';
import {
  SonnetSession,
  type ExtractionResult,
  type SonnetConnectionState,
  type SonnetQuestion,
} from './recording/sonnet-session';
import { applyExtractionToJob, applyObservationUpdate } from './recording/apply-extraction';
import { AudioRingBuffer } from './recording/audio-ring-buffer';
import { SleepManager, type SleepState } from './recording/sleep-manager';
import { useLiveFillStore } from './recording/live-fill-state';
import {
  cancelSpeech,
  confirmationToSentence,
  getConfirmationModeEnabled,
  speak,
  speakConfirmation,
} from './recording/tts';
import { api } from './api-client';
import { useJobContext } from './job-context';
import { applyVoiceCommand, parseVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';

/**
 * Recording context.
 *
 * Holds the UI state that every surface needs while the inspector is
 * recording. Phase 4b added real microphone capture via AudioWorklet.
 * Phase 4c connects Deepgram Nova-3 directly from the browser: mic
 * samples stream to Deepgram, interim + final transcripts land in the
 * rolling transcript log. Phase 4d adds the server-side Sonnet
 * multi-turn extraction WebSocket — each final Deepgram transcript
 * fires at the Sonnet session, structured readings flow back and merge
 * into the active `JobDetail` via `updateJob`. VAD sleep/wake (Phase
 * 4e) still to come.
 *
 * State machine — mirrors iOS `RecordingSessionCoordinator`:
 *
 *   idle ──► requesting-mic ──► active ──► stopped (back to idle)
 *                                ▲  │
 *                          wake  │  ▼ 60s silence
 *                                dozing
 *                                   │
 *                                   ▼ 5m dozing
 *                                sleeping
 *
 *   error — surfaced when permission is denied or a WS drops.
 *
 * `start()` opens the mic via AudioWorklet and drives `micLevel` off
 * the real RMS signal. Transcripts will be emitted by the Deepgram
 * Nova-3 WebSocket wired in Phase 4c; until then the overlay renders
 * the "Listening…" placeholder and the transcript log stays empty.
 */

export type RecordingState = 'idle' | 'requesting-mic' | 'active' | 'dozing' | 'sleeping' | 'error';

export type TranscriptUtterance = {
  id: string;
  text: string;
  /** `true` once Deepgram flags the utterance as final. Interim utterances
   *  are rolled into the single "latest interim" slot; finals are appended
   *  to the rolling transcript log. */
  final: boolean;
  confidence: number;
  timestamp: number;
};

export type RecordingSnapshot = {
  state: RecordingState;
  /** 0.0 – 1.0, driven by RMS from the live mic stream. */
  micLevel: number;
  elapsedSec: number;
  /** Running USD cost (Deepgram streaming + Sonnet tokens in Phase 4d). */
  costUsd: number;
  /** Last ~10 final utterances. Newest last. Interim text sits in `interim`
   *  so the UI can render a grey-italic "typing" line without mutating
   *  the final log. */
  transcript: TranscriptUtterance[];
  /** Current interim transcript (latest partial). Empty string when
   *  Deepgram has no pending partial — including right after a final. */
  interim: string;
  /** Deepgram WebSocket connection state (disconnected | connecting |
   *  connected | error). Surface in the overlay for debugability. */
  deepgramState: DeepgramConnectionState;
  /** Sonnet multi-turn extraction WebSocket state. Mirrors
   *  `deepgramState` so the overlay can show both wires independently. */
  sonnetState: SonnetConnectionState;
  /** Gated questions surfaced by Sonnet (unclear value, orphaned reading,
   *  out-of-range). FIFO — oldest first. Phase 4d renders these inline
   *  under the transcript log; Phase 8 pipes them to TTS so they get
   *  read aloud when the voice-feedback toggle is on. */
  questions: SonnetQuestion[];
  /** Count of in-flight transcripts currently being processed by Sonnet
   *  (sent but no extraction / question response received yet). Drives
   *  the <ProcessingBadge>; iOS parity. */
  processingCount: number;
  /** Count of validation alerts / orphaned readings Sonnet flagged during
   *  the session. Drives the <PendingDataBanner>; iOS parity. */
  pendingReadings: number;
  /** Error string when `state === 'error'`. */
  errorMessage: string | null;
  /** Phase E — backend recording session id from POST /api/recording/start.
   *  `null` until the backend responds (which it usually does <50ms after
   *  start()). Consumers that want to attach photos via
   *  `/api/recording/{sessionId}/photo` should fall back to plain
   *  `/api/analyze-ccu` when this is null so a slow start endpoint
   *  doesn't block CCU capture. */
  backendSessionId: string | null;
};

export type RecordingActions = {
  start: () => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  /** Dismiss a question from the queue without sending a correction.
   *  Used when the inspector taps the × on a question bubble. */
  dismissQuestion: (index: number) => void;
};

type RecordingCtx = RecordingSnapshot & RecordingActions;

const Ctx = React.createContext<RecordingCtx | null>(null);

// Deepgram Nova-3 streaming — $0.0077/min at the inspector tier. We tick
// cost in real time so the hero readout feels live; Phase 4d will splice
// Sonnet token costs in on top.
const DEEPGRAM_USD_PER_MIN = 0.0077;

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const { job, updateJob } = useJobContext();
  const liveFill = useLiveFillStore();
  const [state, setStateRaw] = React.useState<RecordingState>('idle');
  // Mirror of `state` in a ref so that synchronous double-taps of
  // start/stop/pause/resume see the *just-set* status instead of the
  // closed-over React value from the previous render. Without this, two
  // rapid Start taps both observe `state === 'idle'` and both enter the
  // mic-request path, racing each other and leaking a second mic stream.
  // The ref is written synchronously *inside* the state setter below.
  const statusRef = React.useRef<RecordingState>('idle');
  const setState = React.useCallback((next: RecordingState) => {
    statusRef.current = next;
    setStateRaw(next);
  }, []);
  const [micLevel, setMicLevel] = React.useState(0);
  const [elapsedSec, setElapsedSec] = React.useState(0);
  // Realtime Deepgram streaming cost — ticked at 10Hz off the elapsed
  // timer. Sonnet token cost is maintained separately from server-side
  // `cost_update` messages and summed into the user-facing readout.
  const [deepgramCostUsd, setDeepgramCostUsd] = React.useState(0);
  const [sonnetCostUsd, setSonnetCostUsd] = React.useState(0);
  const [transcript, setTranscript] = React.useState<TranscriptUtterance[]>([]);
  const [interim, setInterim] = React.useState('');
  const [deepgramState, setDeepgramState] = React.useState<DeepgramConnectionState>('disconnected');
  const [sonnetState, setSonnetState] = React.useState<SonnetConnectionState>('disconnected');
  const [questions, setQuestions] = React.useState<SonnetQuestion[]>([]);
  // Processing count = transcripts dispatched to Sonnet minus extraction
  // replies observed. We increment in the final-transcript callback and
  // decrement when a result / question / validation alert arrives. Used
  // by <ProcessingBadge> on the recording chrome so the inspector can
  // see Sonnet is still thinking between turns.
  const [processingCount, setProcessingCount] = React.useState(0);
  // Cumulative count of validation-alerts / orphaned readings Sonnet has
  // flagged during the session. Mirrors iOS `PendingDataBanner`.
  const [pendingReadings, setPendingReadings] = React.useState(0);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // Job snapshot kept in a ref so we can send the latest `jobState` on
  // session_start / reconnect without making every Sonnet call depend on
  // a render cycle. updateJob callers still trigger the normal React
  // update path — we just *also* mirror into this ref.
  const jobRef = React.useRef(job);
  React.useEffect(() => {
    jobRef.current = job;
  }, [job]);
  const updateJobRef = React.useRef(updateJob);
  React.useEffect(() => {
    updateJobRef.current = updateJob;
  }, [updateJob]);

  // ── Audio pipeline ──────────────────────────────────────────────────────
  // Mic capture handle + elapsed/cost ticker. The mic handle owns the
  // AudioContext and Worklet; we keep it in a ref so `stop()` can tear it
  // down without tripping React's effect dependency machinery.
  const micRef = React.useRef<MicCaptureHandle | null>(null);
  const deepgramRef = React.useRef<DeepgramService | null>(null);
  const sonnetRef = React.useRef<SonnetSession | null>(null);
  // Phase 4e — 3-second pre-wake PCM ring buffer + state machine driving
  // doze/sleep transitions. The ring buffer is always written while the
  // mic is live so a wake from dozing/sleeping can replay the words the
  // inspector spoke _just before_ VAD fired.
  const ringBufferRef = React.useRef<AudioRingBuffer | null>(null);
  const sleepManagerRef = React.useRef<SleepManager | null>(null);
  // Monotonic session id — used when requesting a scoped Deepgram token
  // and (Phase 4d) as the Sonnet extraction session id.
  const sessionIdRef = React.useRef<string>('');
  // Phase E (2026-05-03) — backend recording session id, returned from
  // POST /api/recording/start and used to:
  //   (a) close the session on stop via /api/recording/{sessionId}/finish
  //   (b) attach CCU photos via /api/recording/{sessionId}/photo so the
  //       debug-report viewer sees them on the timeline
  // Distinct from `sessionIdRef.current` which is purely client-side
  // for cross-tap correlation. iOS uses one id (the backend's) for both.
  const backendSessionIdRef = React.useRef<string | null>(null);
  const [backendSessionId, setBackendSessionId] = React.useState<string | null>(null);
  const tickRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Throttle setMicLevel to ~60Hz — audio callbacks fire every ~8ms at
  // 16kHz/128 samples which is overkill for a VU meter and would flood
  // React with renders.
  const lastLevelPushRef = React.useRef(0);

  const clearTick = React.useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  const beginTick = React.useCallback(() => {
    // 10Hz is fine for the timer + cost — the mic VU meter runs
    // independently off audio callbacks.
    tickRef.current = setInterval(() => {
      setElapsedSec((s) => s + 0.1);
      // Deepgram cost accrues linearly with elapsed time. Sonnet cost
      // is authoritative from server-side `cost_update` snapshots.
      setDeepgramCostUsd((c) => c + DEEPGRAM_USD_PER_MIN / 60 / 10);
    }, 100);
  }, []);

  const teardownMic = React.useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
  }, []);

  const teardownDeepgram = React.useCallback(() => {
    deepgramRef.current?.disconnect();
    deepgramRef.current = null;
    setDeepgramState('disconnected');
    setInterim('');
  }, []);

  const teardownSonnet = React.useCallback(() => {
    sonnetRef.current?.disconnect();
    sonnetRef.current = null;
    setSonnetState('disconnected');
  }, []);

  const teardownSleep = React.useCallback(() => {
    sleepManagerRef.current?.stop();
    sleepManagerRef.current = null;
    ringBufferRef.current?.reset();
    ringBufferRef.current = null;
  }, []);

  // Belt-and-braces cleanup if the provider unmounts while a session is
  // live (route change, hot reload).
  React.useEffect(() => {
    return () => {
      clearTick();
      teardownMic();
      teardownDeepgram();
      teardownSonnet();
      teardownSleep();
    };
  }, [clearTick, teardownMic, teardownDeepgram, teardownSonnet, teardownSleep]);

  /** Open the Deepgram WS using a freshly-minted scoped token. Shared
   *  between `start()` and `resume()` so the reconnect path after doze
   *  does not duplicate code.
   *
   *  Uses the DeepgramService fetcher mode so a 1006/1011 mid-session
   *  (typically JWT expiry — backend mints 30s tokens, matching iOS) is
   *  transparently recovered via auto-reconnect + fresh key. See
   *  `recording/deepgram-service.ts` connect() docblock for the full
   *  rationale (shared backend with iOS is why the fix is client-side,
   *  not a TTL bump). */
  const openDeepgram = React.useCallback(
    async (sourceSampleRate: number) => {
      const sessionId = sessionIdRef.current;
      const service = new DeepgramService({
        onStateChange: setDeepgramState,
        onInterimTranscript: (text) => {
          setInterim(text);
        },
        onFinalTranscript: (text, confidence) => {
          setInterim('');
          setTranscript((prev) => {
            const next: TranscriptUtterance[] = [
              ...prev,
              {
                id: `u_${Date.now()}_${prev.length + 1}`,
                text,
                confidence,
                final: true,
                timestamp: Date.now(),
              },
            ];
            return next.length > 10 ? next.slice(next.length - 10) : next;
          });
          // Client-side voice command dispatch (Phase 8). Attempt the MVP
          // parser; when it matches, apply the patch, speak the response
          // synchronously, and SKIP forwarding to Sonnet — otherwise
          // Sonnet would produce a second, conflicting extraction from
          // the same transcript. Anything the parser doesn't recognise
          // continues to the server-side extraction path.
          const command = parseVoiceCommand(text);
          if (command) {
            const outcome = applyVoiceCommand(
              command,
              jobRef.current as unknown as VoiceCommandJob
            );
            if (outcome.patch) {
              updateJobRef.current(outcome.patch);
              // Mirror the patch into jobRef.current synchronously so a
              // second rapid-fire voice command sees the updated state.
              // Without this, the useEffect-driven `jobRef.current = job`
              // only lands on the next render and two consecutive updates
              // against the same top-level section (e.g. "set ze 0.35"
              // then "set pfc 1.5" both patch `supply`) would overwrite
              // each other because the second applyVoiceCommand reads a
              // stale section snapshot. The patch already contains full
              // section replacements, so a shallow merge is correct.
              jobRef.current = {
                ...jobRef.current,
                ...(outcome.patch as Partial<typeof jobRef.current>),
              };
              // Feed the live-fill flash so voice-driven edits animate
              // the same as Sonnet-driven ones. Empty-list calls are a
              // no-op, so guarding is unnecessary.
              if (outcome.changedKeys && outcome.changedKeys.length > 0) {
                liveFill.markUpdated(outcome.changedKeys);
              }
            }
            if (outcome.response) {
              speak(outcome.response);
            }
            sleepManagerRef.current?.onSpeechActivity();
            return;
          }
          // Fire the final utterance at the Sonnet session so server-side
          // multi-turn extraction can fill form fields. No-op if the WS
          // isn't open — the Sonnet client queues messages while
          // disconnected.
          //
          // `confirmationsEnabled` mirrors iOS (DeepgramRecordingViewModel.
          // swift:1863): the same boolean that gates client-side
          // `speakConfirmation` is forwarded to the backend so Sonnet
          // only generates a confirmations[] array when the user wants
          // them. Reading the storage value here (rather than caching it
          // in a React state) means flipping the toggle mid-recording
          // takes effect on the very next utterance without a re-render
          // round-trip.
          //
          // `utteranceId` is a per-final UUID that doubles as the
          // dedupe anchor at the backend (sonnet-stream.js:2092). It's
          // stamped on every transcript so any subsequent Stage 6 ask
          // can echo it back as `consumed_utterance_id` and hit the
          // fast-path Set lookup at sonnet-stream.js:1013.
          //
          // Stage 6 STI-04 — if a Stage 6 ask is in flight (toolCallId
          // captured from an `ask_user_started` payload), the wire
          // ordering MUST be transcript→ask_user_answered with the
          // SAME utteranceId so the backend's seenTranscriptUtterances
          // Set is populated before the ask's lookup runs. Mirrors
          // DeepgramRecordingViewModel.swift:1820–1883.
          //
          // The `consume…` call is read-and-clear; if no ask is in
          // flight we just send the transcript. Idempotency for split
          // hesitation finals ("uh" → "cooker" in two finals) lives
          // inside SonnetSession's firedToolCallIds Set — only the
          // first non-empty final after an ask emits the answer.
          const utteranceId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
          const inFlightToolCallId = sonnetRef.current?.consumeInFlightToolCallId() ?? null;
          sonnetRef.current?.sendTranscript(text, {
            confirmationsEnabled: getConfirmationModeEnabled(),
            utteranceId,
          });
          if (inFlightToolCallId) {
            sonnetRef.current?.sendAskUserAnswered(inFlightToolCallId, text, utteranceId);
          }
          // Each dispatched transcript is one outstanding Sonnet turn
          // until an extraction / question frame arrives to clear it.
          setProcessingCount((n) => n + 1);
          // Reset the SleepManager's no-final-transcript timer. Interim
          // partials deliberately don't — iOS does the same so the mic's
          // AGC can't self-feed and keep the doze timer permanently armed.
          sleepManagerRef.current?.onSpeechActivity();
        },
        onReconnected: () => {
          // Socket just reopened after an auto-reconnect. Replay the
          // ring buffer so words spoken during the backoff gap aren't
          // lost — mirrors the iOS wake path. drain() returns undefined
          // if the buffer is empty or unavailable, in which case the
          // live sample loop picks up on its own.
          const replay = ringBufferRef.current?.drain();
          if (replay && replay.length > 0) {
            deepgramRef.current?.sendInt16PCM(replay);
          }
        },
        onError: (err) => {
          // Only surface in the UI if we're not already closing down — a
          // normal CloseStream can race with `stop()` and emit a spurious
          // error that would otherwise flip the overlay red. In fetcher
          // mode onError fires only for terminal failures (first-connect
          // key fetch fail) — transient close codes are absorbed by the
          // service's auto-reconnect and don't bubble here at all.
          if (deepgramRef.current) {
            setErrorMessage(err.message);
          }
        },
      });
      // Bind the ref BEFORE starting the async connect so a concurrent
      // stop()/teardownDeepgram can call service.disconnect() and abort
      // the in-flight key fetch via `shouldReconnect=false`.
      deepgramRef.current = service;
      service.connect(async () => {
        // Per-attempt guard: if stop() rotated the session while we were
        // waiting for backoff + key fetch, bail so the service aborts
        // reconnection cleanly (throw flows into openWithFreshKey's
        // catch → suppressed reconnect reschedule, and disconnect() has
        // already flipped shouldReconnect=false to short-circuit).
        if (sessionIdRef.current !== sessionId) {
          throw new Error('recording session rotated — aborting key fetch');
        }
        const { key } = await api.deepgramKey(sessionIdRef.current);
        return key;
      }, sourceSampleRate);
    },
    [liveFill]
  );

  /** Apply a structured Sonnet extraction to the active JobDetail.
   *  Kept in a stable callback so the Sonnet WS callbacks don't rebind
   *  every render. Reads the current job from `jobRef` to decide whether
   *  to overwrite (3-tier priority: pre-existing manual data wins over
   *  Sonnet unless Sonnet is explicitly clearing / correcting).
   *
   *  Also clears one slot of the processingCount (an extraction result
   *  is the positive acknowledgement that Sonnet finished a turn) and
   *  rolls any server-side `confirmations` into the TTS pipeline +
   *  validation_alerts into the pending-readings counter. */
  const applyExtraction = React.useCallback(
    (result: ExtractionResult) => {
      const applied = applyExtractionToJob(jobRef.current, result);
      if (applied) {
        updateJobRef.current(applied.patch);
        // Feed LiveFillState so <LiveFillView> can flash the fields
        // Sonnet actually filled. No-op if the list is empty (the patch
        // only had `field_clears`, which we deliberately don't flash).
        if (applied.changedKeys.length > 0) {
          liveFill.markUpdated(applied.changedKeys);
        }
      }
      // Speak the first confirmation (if any) through the
      // confirmation-mode-gated path — mirrors iOS where
      // speakBriefConfirmation is the only TTS entry point gated by
      // the user toggle (AlertManager.swift:889). Sonnet should also
      // be honouring the matching `confirmations_enabled` wire flag
      // and not emitting confirmations when the toggle is off, but
      // we belt-and-brace here so a regression on either side fails
      // safe (silent) rather than surprising the inspector with
      // unexpected speech. Only the first is spoken so stacked
      // readings don't backlog stale news.
      const first = result.confirmations?.[0];
      if (first) {
        const sentence = confirmationToSentence(first);
        if (sentence) speakConfirmation(sentence);
      }
      // Surface validation alerts in the pending-readings counter so
      // the inspector sees them in the recording chrome even if they
      // haven't yet opened the question stack.
      const alertCount = result.validation_alerts?.length ?? 0;
      if (alertCount > 0) {
        setPendingReadings((n) => n + alertCount);
      }
      // Each extraction frame closes one outstanding turn — clamp at
      // zero so a spurious extra frame doesn't push the count negative.
      setProcessingCount((n) => Math.max(0, n - 1));
    },
    [liveFill]
  );

  /** Open the Sonnet extraction WebSocket. Runs alongside Deepgram —
   *  Deepgram feeds transcripts, Sonnet turns them into structured
   *  readings + questions + cost. Shared between `start()` and
   *  `resume()` so the Phase 4e wake path reuses exactly this logic. */
  const openSonnet = React.useCallback(() => {
    const sessionId = sessionIdRef.current;
    const jobId = jobRef.current.id;
    const session = new SonnetSession({
      onStateChange: setSonnetState,
      onExtraction: (result) => {
        applyExtraction(result);
      },
      onQuestion: (q) => {
        let isNew = false;
        setQuestions((prev) => {
          // Dedup by text — Sonnet occasionally re-asks the same
          // question across turns until the field is filled.
          if (prev.some((p) => p.question === q.question)) return prev;
          isNew = true;
          const next = [...prev, q];
          return next.length > 5 ? next.slice(next.length - 5) : next;
        });
        // A question frame also closes the turn that produced it — same
        // accounting as the extraction branch above.
        setProcessingCount((n) => Math.max(0, n - 1));
        // Orphaned-reading questions also roll into the pending-readings
        // counter: Sonnet sometimes reports an unassigned value via a
        // question frame (question_type === 'orphaned') rather than a
        // validation_alerts entry, and the banner would stay at 0 while
        // the UI simultaneously showed an orphaned-reading question.
        if (isNew && q.question_type === 'orphaned') {
          setPendingReadings((n) => n + 1);
        }
        // Speak only newly-appearing questions. Re-asks are suppressed
        // by the dedup above, matching iOS where the AlertCardView
        // doesn't re-announce a queued question.
        if (isNew && q.question) {
          speak(q.question);
        }
      },
      onFieldCorrected: (msg) => {
        // Stage 6 STI-05 — clear the slot Sonnet asked us to forget. Route
        // through the existing field_clears extraction path so the
        // mutation + flash fire through the same single code path as
        // bundled field_clears (mirrors iOS handleFieldCorrected which
        // delegates to the same Stage6FieldClearer used by the bundled
        // path). The next record_reading typically lands ms later via
        // the normal extraction frame.
        const synthetic: ExtractionResult = {
          readings: [],
          field_clears: [{ circuit: msg.circuit, field: msg.field }],
        };
        const applied = applyExtractionToJob(jobRef.current, synthetic);
        if (applied) {
          updateJobRef.current(applied.patch);
          jobRef.current = {
            ...jobRef.current,
            ...(applied.patch as Partial<typeof jobRef.current>),
          };
          if (applied.changedKeys.length > 0) {
            liveFill.markUpdated(applied.changedKeys);
          }
        }
      },
      onCircuitCreated: (msg) => {
        // Stage 6 STI-06 — ensure the row exists. Route through the
        // circuit_updates path so both create + designation rename use
        // the same code (mirrors iOS where both create_circuit and
        // rename_circuit fire Stage6CircuitCreated/Updated events).
        const synthetic: ExtractionResult = {
          readings: [],
          circuit_updates: [
            {
              circuit: msg.circuit_ref,
              designation: msg.designation ?? '',
              action: 'create',
            },
          ],
        };
        const applied = applyExtractionToJob(jobRef.current, synthetic);
        if (applied) {
          updateJobRef.current(applied.patch);
          jobRef.current = {
            ...jobRef.current,
            ...(applied.patch as Partial<typeof jobRef.current>),
          };
          if (applied.changedKeys.length > 0) {
            liveFill.markUpdated(applied.changedKeys);
          }
        }
      },
      onCircuitUpdated: (msg) => {
        // Stage 6 STI-07 — rename. Same wire shape as create; treat as
        // a rename action so the existing logic preserves any
        // already-typed designation only when the server isn't asking
        // for an explicit overwrite.
        if (!msg.designation) return;
        const synthetic: ExtractionResult = {
          readings: [],
          circuit_updates: [
            {
              circuit: msg.circuit_ref,
              designation: msg.designation,
              action: 'rename',
            },
          ],
        };
        const applied = applyExtractionToJob(jobRef.current, synthetic);
        if (applied) {
          updateJobRef.current(applied.patch);
          jobRef.current = {
            ...jobRef.current,
            ...(applied.patch as Partial<typeof jobRef.current>),
          };
          if (applied.changedKeys.length > 0) {
            liveFill.markUpdated(applied.changedKeys);
          }
        }
      },
      onObservationDeleted: (msg) => {
        // Stage 6 STI-08 — remove the observation row that Sonnet
        // deleted server-side. Match by server_id; silent no-op if the
        // row was never created on this client (common: a delete races
        // ahead of the initial extraction). Mirrors iOS where the row
        // is dropped from job.observations.
        const before =
          (jobRef.current.observations as { id: string; server_id?: string }[] | undefined) ?? [];
        const next = before.filter((o) => o.server_id !== msg.observation_id);
        if (next.length === before.length) return;
        updateJobRef.current({ observations: next });
        jobRef.current = {
          ...jobRef.current,
          observations: next,
        };
        liveFill.markUpdated(['observations']);
      },
      onToolCallStarted: (msg) => {
        // Decode-only on iOS — log so prod traces show the tool loop
        // shape. No UI surface today; Phase 7 will add a progress
        // affordance ("Recording Zs for circuit 3…").
        console.info(
          `[stage6] tool_call_started tool=${msg.tool_name} id=${msg.tool_call_id} preview=${
            msg.input_preview ?? ''
          }`
        );
      },
      onToolCallCompleted: (msg) => {
        console.info(
          `[stage6] tool_call_completed tool=${msg.tool_name} outcome=${msg.outcome} duration_ms=${
            msg.duration_ms ?? ''
          }`
        );
      },
      onObservationUpdate: (update) => {
        // BPG4 / regulation refinement of a previously-extracted
        // observation. Mirrors iOS handleObservationUpdate
        // (DeepgramRecordingViewModel.swift:4954). Patches the matching
        // row by server_id (preferred) → fuzzy text → CREATE-from-miss.
        // Server may also stamp schedule_item which feeds the inspection
        // schedule auto-tick on next save.
        const next = applyObservationUpdate(jobRef.current, update);
        if (!next) return;
        updateJobRef.current({ observations: next });
        // Keep jobRef in lock-step so a rapid second update reads the
        // patched array, not the stale React snapshot.
        jobRef.current = {
          ...jobRef.current,
          observations: next,
        };
        // Flash the observations section so the inspector sees the
        // refinement land. We don't have per-row flash keys here (the
        // section flash is enough — the row text itself is the
        // affordance) so emit a section-level key.
        liveFill.markUpdated(['observations']);
      },
      onCostUpdate: (update) => {
        // Server sends totalJobCost in USD. We keep Sonnet cost
        // separate from Deepgram so the UI ticker stays smooth between
        // extraction turns.
        if (typeof update.totalJobCost === 'number') {
          setSonnetCostUsd(update.totalJobCost);
        }
      },
      onError: (err, recoverable) => {
        // Only surface non-recoverable errors in the overlay. Transient
        // server errors (rate-limit, API blip) should not flip the UI
        // red mid-recording.
        if (!recoverable && sonnetRef.current) {
          setErrorMessage(err.message);
        }
      },
    });
    // Route certificate type off the live job snapshot, not a hardcoded
    // default. An EIC job sent as EICR would silently run against the
    // wrong Sonnet extraction schema and drop the design-section fields.
    // Fallback to 'EICR' only when the backend somehow omitted the type
    // (legacy jobs created before the column existed); defensive, but we
    // log so the drift is visible during QA.
    const certificateType = jobRef.current.certificate_type ?? 'EICR';
    session.connect({
      sessionId,
      jobId,
      certificateType,
      jobState: jobRef.current,
    });
    sonnetRef.current = session;
  }, [applyExtraction]);

  /** Open the mic stream and forward audio to Deepgram. Shared between
   *  `start()` and `resume()`. Also owns the SleepManager + ring buffer
   *  writes so Phase 4e wake/replay works without duplicating the mic
   *  plumbing. */
  const beginMicPipeline = React.useCallback(async () => {
    // Fresh ring buffer on every mic open — the previous session's tail
    // is irrelevant after a teardown. 3s @ 16kHz mirrors iOS.
    //
    // The ring buffer is intentionally fixed at 16kHz: every consumer
    // (Deepgram, the ASR wake-replay, iOS) speaks 16kHz natively, so we
    // resample ONCE at the ingress boundary below and everything
    // downstream is already in the correct rate. Prior to this, the
    // ring buffer was sized for 16kHz but written with raw mic-rate
    // samples (48kHz on most iOS builds), so a "3-second" replay was
    // really ~1 second of audio labelled at the wrong rate — Deepgram
    // heard a chipmunk and the first few seconds after wake were lost.
    ringBufferRef.current = new AudioRingBuffer(3, 16000);
    const handle = await startMicCapture({
      onSamples: (samples) => {
        // Single resample point. `handle.sampleRate` is the AudioContext's
        // ACTUAL rate (browsers honour the 16000 hint only on some builds).
        // Post-resample data is 16kHz Float32 regardless of the hardware
        // rate, so both downstream sinks can trust the sample count.
        const samples16k = resampleTo16k(samples, handle.sampleRate);
        // Always write to the ring buffer, even while paused. That's
        // what lets wake-from-doze replay the 3 seconds leading up to
        // the VAD fire.
        ringBufferRef.current?.writeFloat32(samples16k);
        deepgramRef.current?.sendSamples(samples16k);
      },
      onLevel: (level) => {
        const now = performance.now();
        // ~60Hz UI cap, but the SleepManager sees every sample so the
        // wake heuristic isn't under-sampled.
        sleepManagerRef.current?.processAudioLevel(level);
        if (now - lastLevelPushRef.current < 16) return;
        lastLevelPushRef.current = now;
        setMicLevel(level);
      },
      onError: (err) => {
        setErrorMessage(err.message);
        setState('error');
        teardownMic();
        teardownDeepgram();
        teardownSleep();
        clearTick();
      },
    });
    micRef.current = handle;
    // Samples arrive at DeepgramService already resampled to 16kHz (see
    // the onSamples callback above), so declare the source rate as 16k
    // regardless of `handle.sampleRate`. Otherwise DeepgramService would
    // resample a second time with a ratio based on the raw device rate
    // and produce double-transformed audio.
    await openDeepgram(16000);
    // Sonnet session opens alongside Deepgram. Run sequentially so the
    // scoped Deepgram token fetch doesn't contend with the Sonnet
    // handshake on slow networks; both are cheap so this is fine.
    openSonnet();
  }, [setState, clearTick, openDeepgram, openSonnet, teardownDeepgram, teardownMic, teardownSleep]);

  /** Auto-wake from doze/sleep. Invoked by the SleepManager when VAD
   *  spots speech — reopens whatever layers were torn down and drains
   *  the ring buffer into Deepgram so the words spoken just before wake
   *  aren't lost. The mic + ring buffer keep running through both doze
   *  AND sleep (only Deepgram/Sonnet are torn down), so the ring
   *  buffer's contents are valid in every wake case. Swallows failures
   *  rather than flipping the UI red: wake is best-effort, and the next
   *  user action will surface any real problem. */
  const handleWake = React.useCallback(
    async (from: Exclude<SleepState, 'active'>) => {
      // Snapshot sessionId + initial status — the SleepManager fires
      // onWake asynchronously from a VAD tick; if stop() races us before
      // openDeepgram() resolves, the late await must not revive state.
      const sessionId = sessionIdRef.current;
      // No sessionId → the session was already stopped. Don't re-open WS.
      if (!sessionId) return;
      try {
        if (from === 'sleeping') {
          // Deepgram + Sonnet were disconnected; reopen them but DON'T
          // touch the mic or ring buffer — mic is still running and the
          // ring buffer holds the pre-wake audio we want to replay. The
          // Sonnet server preserves conversation state for 5 min (see
          // sonnet-stream.js) so the new WS picks up where we left off.
          const mic = micRef.current;
          if (!mic) {
            // Mic died while sleeping — start a fresh pipeline. Rare.
            await beginMicPipeline();
          } else {
            // Ring buffer is already 16kHz (see beginMicPipeline) and
            // the onSamples callback keeps resampling upstream, so
            // DeepgramService always speaks 16kHz for this session.
            await openDeepgram(16000);
            openSonnet();
            const replay = ringBufferRef.current?.drain();
            if (replay && replay.length > 0) {
              deepgramRef.current?.sendInt16PCM(replay);
            }
          }
        } else {
          // Doze — Deepgram + Sonnet are still open, just paused.
          // Resume with the ring-buffer replay so pre-wake audio
          // reaches the ASR.
          const replay = ringBufferRef.current?.drain();
          deepgramRef.current?.resume(replay);
          sonnetRef.current?.resume();
        }
        // Session rotated while awaiting mic/WS reopen — drop the work
        // so a dead session doesn't resurrect into `active`.
        if (sessionIdRef.current !== sessionId) {
          teardownDeepgram();
          teardownSonnet();
          return;
        }
        setState('active');
        beginTick();
      } catch (err) {
        if (sessionIdRef.current !== sessionId) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg);
        setState('error');
        teardownMic();
        teardownDeepgram();
        teardownSonnet();
        teardownSleep();
      }
    },
    [
      setState,
      beginMicPipeline,
      beginTick,
      openDeepgram,
      openSonnet,
      teardownMic,
      teardownDeepgram,
      teardownSonnet,
      teardownSleep,
    ]
  );

  /** Build a fresh SleepManager wired up to pause Deepgram + Sonnet on
   *  doze, fully disconnect on sleep, and reconnect + replay on wake.
   *  Called once per session from `start()` — the manager survives the
   *  doze/wake cycles internally and only stops on `stop()`. */
  const buildSleepManager = React.useCallback(() => {
    const mgr = new SleepManager({
      onEnterDozing: () => {
        // Tell the server to pause cost tracking BEFORE pausing the
        // Deepgram stream (iOS fix 4c75ccf). Pause keeps the WS alive
        // with KeepAlive frames so wake re-latches in <100ms.
        sonnetRef.current?.pause();
        deepgramRef.current?.pause();
        clearTick();
        setMicLevel(0);
        setState('dozing');
      },
      onEnterSleeping: () => {
        // Full disconnect after 30min dozing — matches iOS. The mic
        // stream keeps running so the ring buffer still captures pre-
        // wake audio for the replay on next speech.
        teardownDeepgram();
        teardownSonnet();
        setState('sleeping');
      },
      onWake: (from) => {
        void handleWake(from);
      },
    });
    sleepManagerRef.current = mgr;
    mgr.start();
  }, [setState, clearTick, handleWake, teardownDeepgram, teardownSonnet]);

  const start = React.useCallback(async () => {
    // Guard on the status ref (synchronous), not the closed-over `state`
    // value from React. Two rapid start() calls land in the same React
    // tick; the second one sees `state === 'idle'` via its closure even
    // though the first has already called setState('requesting-mic'). The
    // ref is updated synchronously inside setState, so the second tap
    // sees `requesting-mic` and bails. Double-tap on Start now no-ops.
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') return;
    setErrorMessage(null);
    setState('requesting-mic');
    setElapsedSec(0);
    setDeepgramCostUsd(0);
    setSonnetCostUsd(0);
    setTranscript([]);
    setInterim('');
    setQuestions([]);
    setProcessingCount(0);
    setPendingReadings(0);
    liveFill.reset();
    // Capture the new session id synchronously and snapshot it locally so
    // that any async handler resolving below (mic permission prompt, WS
    // handshake) can compare the id it started with against the CURRENT
    // sessionIdRef.current. If they differ, a stop()+start() cycle has
    // rotated the session and the late-resolving await belongs to a
    // dead session — we bail and tear down the accidental resources.
    const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    sessionIdRef.current = sessionId;
    // Phase E — open a backend recording session in parallel with the
    // mic pipeline. Fire-and-forget: if the call fails (network blip,
    // server hot-reload), recording continues without a backend
    // session — debug-report won't capture the timeline but the
    // Sonnet WS extraction is unaffected. Mirrors iOS, which logs and
    // moves on if /recording/start 5xxs.
    backendSessionIdRef.current = null;
    setBackendSessionId(null);
    void api
      .recordingStart({
        jobId: jobRef.current?.id,
        address: jobRef.current?.address ?? undefined,
      })
      .then((resp) => {
        // Late-arriving response from a session we've already torn
        // down (rapid stop()) — drop it silently.
        if (sessionIdRef.current !== sessionId) return;
        backendSessionIdRef.current = resp.sessionId;
        setBackendSessionId(resp.sessionId);
      })
      .catch((err) => {
        if (sessionIdRef.current !== sessionId) return;
        // Don't surface to the user — recording works without it.
        // Log for the debug-report (collected on its own channel).
        console.warn('[recording] /recording/start failed:', err);
      });
    try {
      await beginMicPipeline();
      // sessionId rotated while awaiting the mic / WS handshake — drop
      // the pipeline we just built on the floor so the fresh session
      // isn't cross-contaminated. Without this guard, a rapid
      // stop() → start() after a slow permission prompt would leave
      // TWO DeepgramService / SonnetSession instances live.
      if (sessionIdRef.current !== sessionId) {
        teardownMic();
        teardownDeepgram();
        teardownSonnet();
        return;
      }
      buildSleepManager();
      setState('active');
      beginTick();
    } catch (err) {
      if (sessionIdRef.current !== sessionId) {
        // Error belongs to a superseded session — swallow silently so
        // the new session's UI isn't flipped red by a stale error.
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Most common: NotAllowedError (permission denied). Surface a
      // friendlier message — the raw DOMException name is hidden behind
      // "Permission denied" which inspectors can act on.
      setErrorMessage(
        /NotAllowed|denied|dismiss/i.test(msg)
          ? 'Microphone permission was denied. Enable it in your browser settings to record.'
          : msg
      );
      setState('error');
      teardownMic();
      teardownDeepgram();
      teardownSonnet();
      teardownSleep();
    }
  }, [
    setState,
    beginMicPipeline,
    beginTick,
    buildSleepManager,
    teardownMic,
    teardownDeepgram,
    teardownSonnet,
    teardownSleep,
    liveFill,
  ]);

  const stop = React.useCallback(() => {
    // Guard against double-tap of Stop. Also rotate the sessionId so any
    // async handler still in flight (mic prompt, WS handshake) will see a
    // mismatch and tear down its own accidental resources rather than
    // racing through to setState('active'). Setting to empty string is
    // enough — any string-compare against a real sessionId will differ.
    if (statusRef.current === 'idle') return;
    sessionIdRef.current = '';
    // Phase E — close the backend session asynchronously. Fire-and-
    // forget so a slow finish() call doesn't block the UI rolling
    // back to idle. iOS does the same. Snapshot the id BEFORE
    // clearing so the request still goes out with the right path.
    const finishingId = backendSessionIdRef.current;
    backendSessionIdRef.current = null;
    setBackendSessionId(null);
    if (finishingId) {
      void api
        .recordingFinish(finishingId, {
          address: jobRef.current?.address ?? undefined,
          certificateType: jobRef.current?.certificate_type ?? undefined,
        })
        .catch((err) => {
          console.warn('[recording] /recording/{id}/finish failed:', err);
        });
    }
    clearTick();
    teardownMic();
    teardownDeepgram();
    teardownSonnet();
    teardownSleep();
    // Cancel any in-flight TTS so the last confirmation doesn't keep
    // speaking after the inspector has ended the session.
    cancelSpeech();
    setState('idle');
    setMicLevel(0);
    setQuestions([]);
    setProcessingCount(0);
    setPendingReadings(0);
    liveFill.reset();
  }, [setState, clearTick, teardownMic, teardownDeepgram, teardownSonnet, teardownSleep, liveFill]);

  /** Manual pause — the inspector tapped the Pause button. Routes
   *  through the same doze handler the SleepManager would use when the
   *  15s timer fires, so pause behaviour is consistent with automatic
   *  sleep: Deepgram WS stays alive, Sonnet pauses, cost tracker stops,
   *  and the mic keeps filling the ring buffer so resume can replay. */
  const pause = React.useCallback(() => {
    // Synchronous guard via statusRef so pause()+pause() doesn't
    // double-emit the doze transition (and so a late resume() closure
    // from a pre-stop session can't flip `dozing → active` on a freshly
    // restarted session).
    if (statusRef.current !== 'active') return;
    sonnetRef.current?.pause();
    deepgramRef.current?.pause();
    clearTick();
    setMicLevel(0);
    setState('dozing');
  }, [setState, clearTick]);

  /** Manual resume — mirrors the wake path. If Deepgram was torn down
   *  (sleeping), reopen it; otherwise just unpause and replay the ring
   *  buffer so any audio captured while paused reaches the ASR. The mic
   *  + ring buffer keep running through both doze and sleep, so the
   *  replay is always valid. */
  const resume = React.useCallback(async () => {
    // Synchronous guard. resume() is legal only from the paused/sleeping
    // states — anything else (including a late retry from the overlay
    // while we've already rotated to a fresh session) must no-op.
    if (statusRef.current !== 'dozing' && statusRef.current !== 'sleeping') return;
    const fromSleeping = statusRef.current === 'sleeping';
    // Snapshot sessionId so the late-resolving openDeepgram / beginMic
    // paths below can detect if a stop() raced them.
    const sessionId = sessionIdRef.current;
    setErrorMessage(null);
    try {
      if (fromSleeping) {
        const mic = micRef.current;
        if (!mic) {
          await beginMicPipeline();
        } else {
          // Ingress resample in `beginMicPipeline` keeps the ring buffer
          // + DeepgramService in 16kHz for this session — no need to
          // forward the raw device rate here.
          await openDeepgram(16000);
          openSonnet();
          const replay = ringBufferRef.current?.drain();
          if (replay && replay.length > 0) {
            deepgramRef.current?.sendInt16PCM(replay);
          }
        }
      } else {
        const replay = ringBufferRef.current?.drain();
        deepgramRef.current?.resume(replay);
        sonnetRef.current?.resume();
      }
      // stop() ran while we awaited openDeepgram / beginMicPipeline —
      // drop the work on the floor. Otherwise we'd flip `idle → active`
      // on a dead session.
      if (sessionIdRef.current !== sessionId) {
        teardownDeepgram();
        teardownSonnet();
        return;
      }
      setState('active');
      beginTick();
    } catch (err) {
      if (sessionIdRef.current !== sessionId) return;
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setState('error');
      teardownMic();
      teardownDeepgram();
      teardownSonnet();
      teardownSleep();
    }
  }, [
    setState,
    beginMicPipeline,
    beginTick,
    openDeepgram,
    openSonnet,
    teardownMic,
    teardownDeepgram,
    teardownSonnet,
    teardownSleep,
  ]);

  const dismissQuestion = React.useCallback((index: number) => {
    setQuestions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Total user-facing cost — Deepgram streaming + Sonnet tokens. Kept
  // as a derived value so callers always see a consistent sum.
  const costUsd = deepgramCostUsd + sonnetCostUsd;

  const value = React.useMemo<RecordingCtx>(
    () => ({
      state,
      micLevel,
      elapsedSec,
      costUsd,
      transcript,
      interim,
      deepgramState,
      sonnetState,
      questions,
      processingCount,
      pendingReadings,
      errorMessage,
      backendSessionId,
      start,
      stop,
      pause,
      resume,
      dismissQuestion,
    }),
    [
      state,
      micLevel,
      elapsedSec,
      costUsd,
      transcript,
      interim,
      deepgramState,
      sonnetState,
      questions,
      processingCount,
      pendingReadings,
      errorMessage,
      backendSessionId,
      start,
      stop,
      pause,
      resume,
      dismissQuestion,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRecording(): RecordingCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error(
      'useRecording must be used inside a <RecordingProvider>. ' +
        'Wrap your job route (or any surface that records) in the provider.'
    );
  }
  return ctx;
}

/** Utility for the transcript bar: format 123.4 → "02:03". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Utility for the cost chip: £~0.02. iOS surfaces cost in GBP because the
 *  inspector base is UK-only; Deepgram + OpenAI/Anthropic pricing is quoted
 *  in USD but at these session-level magnitudes (pence) the FX difference
 *  is noise — we label with £~ to show it's an approximate conversion
 *  rather than attempting a live FX lookup every tick. Clamps to 0 so
 *  "-£~0.00" never shows after a stop/start glitch. */
export function formatCost(usd: number): string {
  const n = Math.max(0, usd);
  return `£~${n.toFixed(2)}`;
}
