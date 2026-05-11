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
import { applyRegexMatchToJob } from './recording/apply-regex-match';
import { TranscriptFieldMatcher } from './recording/transcript-field-matcher';
import { FieldSourceTracker } from './recording/field-source-tracker';
import { buildRegexSummary, type RegexResultsWire } from './recording/regex-match-result';
import { normalise as normaliseTranscriptText } from './recording/number-normaliser';
import { AudioRingBuffer } from './recording/audio-ring-buffer';
import { SleepManager, type SleepState } from './recording/sleep-manager';
import { SileroVAD } from './recording/silero-vad';
import {
  createVadAccumulator,
  dispatchSamplesToVad,
  resetVadAccumulator,
  type VadAccumulator,
} from './recording/vad-accumulator';
import { useLiveFillStore } from './recording/live-fill-state';
import {
  cancelSpeech,
  confirmationToSentence,
  getConfirmationModeEnabled,
  isTTSEcho,
  isWithinTtsWindow,
  primeTts,
  setTtsLifecycleObserver,
  speak,
  speakConfirmation,
} from './recording/tts';
import { setActiveSessionId as setTtsSessionId } from './recording/elevenlabs-tts';
import { clientDiagnostic, setDiagnosticSink } from './recording/client-diagnostic';
import { record as recordLifecycle } from './diagnostics/lifecycle-log';
import { playAttentionTone, playConfirmationChime } from './recording/tones';
import { api } from './api-client';
import { useJobContext } from './job-context';
import { applyVoiceCommand, parseVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';
import { mapServerActionToVoiceCommand } from './recording/voice-command-action';

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
 * State machine — mirrors iOS `RecordingSessionCoordinator` (Stage 4c
 * 2-tier model, 2026-04-27):
 *
 *   idle ──► requesting-mic ──► active ──► stopped (back to idle)
 *                                ▲  │
 *                          wake  │  ▼ 60s no-final / manual pause
 *                                sleeping
 *
 *   error — surfaced when permission is denied or a WS drops.
 *
 * `start()` opens the mic via AudioWorklet and drives `micLevel` off
 * the real RMS signal. Transcripts will be emitted by the Deepgram
 * Nova-3 WebSocket wired in Phase 4c; until then the overlay renders
 * the "Listening…" placeholder and the transcript log stays empty.
 */

export type RecordingState = 'idle' | 'requesting-mic' | 'active' | 'sleeping' | 'error';

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
  /** True when the backend has paused Sonnet forwarding because of
   *  10 consecutive zero-engagement transcript turns (chitchat). iOS
   *  parity (DeepgramRecordingViewModel.swift:92). Drives the top
   *  `<ChitchatPauseBanner>` overlay during a recording session. */
  chitchatPaused: boolean;
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
  /** Accept a Stage 6 ask_user question via tap (mirrors iOS
   *  handleTapResponse(accepted: true), AlertManager.swift:610). Sends
   *  `ask_user_answered` with user_text="yes" through the same wire
   *  path a spoken "yes" would, plays the confirmation chime, and
   *  speaks "Updated". No-op for legacy questions without a
   *  tool_call_id. */
  acceptQuestion: (index: number) => void;
  /** Reject a Stage 6 ask_user question via tap (handleTapResponse(
   *  accepted: false)). Sends `ask_user_answered` with user_text="no"
   *  and speaks "Okay, keeping it." No chime — iOS line 788 mirrors
   *  this (rejection is silent except for TTS). */
  rejectQuestion: (index: number) => void;
  /** Manual wake from the chitchat-pause banner. Optimistically clears
   *  the banner, sends `chitchat_resume` over the WS, and arms a 5s
   *  watchdog — if the backend doesn't confirm via `chitchat_resumed`
   *  within that window, the banner re-shows so the inspector knows
   *  Sonnet is still paused (network drop / backend stall). Mirrors iOS
   *  `resumeFromChitchatPause` (DeepgramRecordingViewModel.swift:6880). */
  resumeChitchat: () => void;
};

type RecordingCtx = RecordingSnapshot & RecordingActions;

const Ctx = React.createContext<RecordingCtx | null>(null);

// Deepgram Nova-3 streaming — $0.0077/min at the inspector tier. We tick
// cost in real time so the hero readout feels live; Phase 4d will splice
// Sonnet token costs in on top.
const DEEPGRAM_USD_PER_MIN = 0.0077;

/** T20 — Silero VAD master enable. Defaults ON; the env var is now an
 *  emergency kill switch — set `NEXT_PUBLIC_SILERO_VAD=0` at build
 *  time (Dockerfile build-arg or `web/.env.production`) to disable
 *  the Silero path and revert every session to the RMS gate.
 *
 *  Originally landed defaulting OFF behind a soak window; flipped ON
 *  by direct user instruction skipping the soak. If a regression
 *  shows up in field use (false sleep, battery drain on a specific
 *  iOS version, model load failure pattern), redeploy with the kill
 *  switch set to '0' — single env var change, no code redeploy.
 *
 *  Read once at module load — runtime mid-session toggling isn't
 *  supported (and shouldn't be — recording context wires up state
 *  refs at session start that wouldn't reconfigure cleanly). */
const SILERO_VAD_ENABLED = process.env.NEXT_PUBLIC_SILERO_VAD !== '0';

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const { job, updateJob } = useJobContext();
  const liveFill = useLiveFillStore();

  // One-time page-lifecycle listener — captures pageshow / pagehide /
  // visibilitychange to the diagnostics lifecycle log. iOS Safari (and
  // PWAs in standalone mode) can suspend a backgrounded tab and either
  // restore it from the BFCache (`pageshow.persisted === true`) or
  // reload it from network. Both look like a "refresh" to the inspector
  // mid-recording but produce different diagnostic signatures, so the
  // log lets us tell them apart in the field. The provider is mounted
  // once at the app root (see app/layout.tsx) so a single listener
  // covers the whole session lifecycle.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    recordLifecycle('provider-mount', {});
    const onShow = (e: PageTransitionEvent) => {
      recordLifecycle('page-show', { persisted: e.persisted });
    };
    const onHide = (e: PageTransitionEvent) => {
      recordLifecycle('page-hide', { persisted: e.persisted });
    };
    const onVisibility = () => {
      recordLifecycle('visibility-change', {
        state: document.visibilityState,
      });
    };
    window.addEventListener('pageshow', onShow);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      recordLifecycle('provider-unmount', {});
    };
  }, []);

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
  // Chitchat-pause flag (iOS parity, 2026-05-06 slice 4). Set true when the
  // backend emits `chitchat_paused` after 10 consecutive zero-engagement
  // turns; cleared on `chitchat_resumed` from the backend OR optimistically
  // on Resume-button tap (with a 5s watchdog re-show if the backend doesn't
  // confirm). iOS canon `DeepgramRecordingViewModel.swift:92,6849-6912`.
  const [chitchatPaused, setChitchatPaused] = React.useState(false);
  // Tracks an in-flight optimistic Resume tap — distinct from `chitchatPaused`
  // because we clear the banner instantly on tap but want to re-show it if
  // the backend never confirms.
  const chitchatPendingResumeRef = React.useRef(false);
  const chitchatResumeWatchdogRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // iOS-parity pre-extraction state. The matcher is stateful — it owns
  // `lastProcessedOffset` for sliding-window scanning + a 30s active-
  // circuit-ref window for ring-continuity carryover. Instantiated in
  // `openSonnet` (so a fresh session starts with an empty matcher) and
  // nullified in `teardownSonnet`. Mirrors iOS DeepgramRecordingViewModel
  // where the matcher is owned by the ViewModel for the session lifetime.
  // Cumulative transcript is the contract the matcher requires (every
  // call receives all finals so far joined by spaces) — feeding isolated
  // utterances breaks the offset arithmetic and silently suppresses
  // cross-utterance matches like ring-continuity carryover (codex
  // review finding F2).
  const regexMatcherRef = React.useRef<TranscriptFieldMatcher | null>(null);
  const fieldSourceTrackerRef = React.useRef<FieldSourceTracker | null>(null);
  const cumulativeTranscriptRef = React.useRef<string>('');
  // Phase 4e — 3-second pre-wake PCM ring buffer + state machine driving
  // doze/sleep transitions. The ring buffer is always written while the
  // mic is live so a wake from sleeping can replay the words the
  // inspector spoke _just before_ VAD fired.
  const ringBufferRef = React.useRef<AudioRingBuffer | null>(null);
  const sleepManagerRef = React.useRef<SleepManager | null>(null);
  // T20 — Silero v5 ONNX VAD wake gate. Loaded at session start, fed
  // 512-sample chunks (32ms @ 16kHz) by the accumulator below. When
  // `null`, the SleepManager falls back to its RMS path
  // (`processAudioLevel`); when set, every 512-sample chunk drives
  // `processVadFrame(score)` instead. The reset() in teardown is
  // idempotent so leaving the wrapper alive across sessions is safe,
  // but we deliberately rebuild it per-session to mirror iOS's
  // session-start lifecycle and to avoid carrying inter-session state
  // across long-running tabs.
  const sileroRef = React.useRef<SileroVAD | null>(null);
  // Rolling 512-sample buffer for VAD inference. Implementation lives
  // in `recording/vad-accumulator.ts` so unit tests can drive it
  // without a full provider mount; we just hold the mutable state
  // payload here.
  const vadAccumulatorRef = React.useRef<VadAccumulator>(createVadAccumulator());
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
    setDiagnosticSink(null);
    setSonnetState('disconnected');
    // Tear down the matcher state alongside the WS session — both have
    // the same lifetime by design. reset() clears lastProcessedOffset
    // and activeCircuitRef so a brand-new session starts fresh; we then
    // null the ref so any stray caller hits an explicit "no matcher"
    // path instead of a stale offset.
    regexMatcherRef.current?.reset();
    regexMatcherRef.current = null;
    fieldSourceTrackerRef.current = null;
    cumulativeTranscriptRef.current = '';
  }, []);

  const teardownSleep = React.useCallback(() => {
    sleepManagerRef.current?.stop();
    sleepManagerRef.current = null;
    ringBufferRef.current?.reset();
    ringBufferRef.current = null;
    // VAD wrapper goes with the sleep state machine — neither serves
    // any purpose without the other. Reset() drains in-flight inference
    // before zeroing the recurrent state so a stale stateN doesn't
    // land on top after teardown.
    sileroRef.current?.reset();
    sileroRef.current = null;
    resetVadAccumulator(vadAccumulatorRef.current);
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
          // Stage 1 of the recording pipeline — verbose log so we can
          // confirm at the field-test console that the transcript
          // actually reached the host before any gating runs.
          console.info(
            `[recording:pipeline] stage=onFinalTranscript text="${text.slice(0, 80)}" len=${text.length} conf=${confidence.toFixed(2)}`
          );
          clientDiagnostic('pipeline_final_transcript', {
            textLength: text.length,
            textPreview: text.slice(0, 80),
            confidence,
          });
          // Mic-feedback gate (iOS parity) — discard finals that
          // arrived while the device's own TTS was audible. Without
          // this, the speaker plays "Should I create circuit 1?", the
          // mic picks it up, Deepgram emits a transcript, and Sonnet
          // processes the question as if the inspector said it.
          //
          // iOS canon barges in (AlertManager.swift:1369): when the
          // inspector starts speaking ON TOP of a question's TTS audio,
          // the question's audio is cancelled and the inspector's reply
          // is honoured. The PWA previously discarded the reply
          // unconditionally — exactly the "no way to add an answer"
          // symptom reported in the field. Match iOS: if there is an
          // in-flight ask_user (tool_call_id pending) AND the heard
          // text is plausibly a content reply (not just a 1-word burp
          // that's more likely the mic catching its own speaker), then
          // BARGE IN — cancel TTS and let the transcript through.
          if (isWithinTtsWindow()) {
            const hasInFlightAsk = Boolean(sonnetRef.current?.peekInFlightToolCallId());
            const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
            // Single-token replies ARE legitimate ("yes", "no", "0.6",
            // "TT"). iOS uses a separate VAD gate; we approximate by
            // letting any non-empty reply through when there is an
            // in-flight ask, but suppress when there isn't (no ask =
            // any TTS-window utterance is almost certainly self-feedback).
            if (hasInFlightAsk) {
              console.info(
                `[recording:barge-in] cancelling TTS, accepting reply text="${text.slice(0, 80)}" words=${wordCount}`
              );
              clientDiagnostic('pipeline_barge_in', {
                textLength: text.length,
                textPreview: text.slice(0, 80),
                wordCount,
              });
              cancelSpeech();
              // Fall through — don't return — so the transcript routes
              // to Sonnet AND fires ask_user_answered below.
            } else {
              console.info(
                `[recording:final-suppressed] inside TTS window, no in-flight ask text="${text.slice(0, 60)}"`
              );
              clientDiagnostic('pipeline_final_suppressed', {
                textLength: text.length,
                textPreview: text.slice(0, 60),
                reason: 'tts_window_no_ask',
              });
              return;
            }
          }
          // Belt-and-braces — fingerprint echo gate (iOS canon
          // DeepgramRecordingViewModel.swift:2823). The wall-clock TTS
          // window above catches finals whose timing overlaps the
          // current TTS audio. The fingerprint check catches finals
          // that arrived OUTSIDE the wall-clock window but match a
          // recently-spoken TTS phrase — Deepgram processing latency
          // can delay finals by 500-1500ms, putting them past the
          // 300ms cooldown but still inside the 15-second fingerprint
          // window. Without this, the user reported "keeps asking the
          // same question" because the mic picked up its own
          // question through the speaker, Deepgram transcribed
          // fragments, and Sonnet processed those fragments as the
          // inspector's reply.
          if (isTTSEcho(text)) {
            console.info(`[recording:tts-echo-discarded] text="${text.slice(0, 60)}"`);
            clientDiagnostic('pipeline_tts_echo_discarded', {
              textLength: text.length,
              textPreview: text.slice(0, 60),
            });
            return;
          }
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
              // Confirmation chime before the spoken response — same
              // ordering as iOS resolveWithCorrection
              // (AlertManager.swift:552 chime then speakResponse).
              // Only fires for commands that produced a patch (queries
              // shouldn't chime — they're read-only).
              if (outcome.patch) playConfirmationChime();
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
          // iOS-parity pre-extraction pipeline. Mirrors Swift
          // DeepgramRecordingViewModel.handleFinalTranscript at the
          // matcher → field-source-tracker → buildRegexSummary boundary.
          // Gated on NEXT_PUBLIC_REGEX_HINTS_ENABLED so a misfiring
          // pattern in prod can be killed via Vercel env var without a
          // redeploy — see PLAN validation/rollout.
          let regexResults: RegexResultsWire | undefined = undefined;
          const regexHintsEnabled = process.env.NEXT_PUBLIC_REGEX_HINTS_ENABLED === '1';
          console.info(
            `[recording:pipeline] stage=regex enabled=${regexHintsEnabled} matcher=${Boolean(regexMatcherRef.current)} tracker=${Boolean(fieldSourceTrackerRef.current)}`
          );
          if (regexHintsEnabled && regexMatcherRef.current && fieldSourceTrackerRef.current) {
            const normalised = normaliseTranscriptText(text);
            cumulativeTranscriptRef.current +=
              (cumulativeTranscriptRef.current ? ' ' : '') + normalised;
            const matchResult = regexMatcherRef.current.match(
              cumulativeTranscriptRef.current,
              jobRef.current
            );
            const applied = applyRegexMatchToJob(
              jobRef.current,
              matchResult,
              fieldSourceTrackerRef.current
            );
            console.info(
              `[recording:pipeline] stage=regex_applied changedKeys=${applied?.changedKeys.length ?? 0} keys=${(applied?.changedKeys ?? []).slice(0, 5).join(',')}`
            );
            clientDiagnostic('pipeline_regex_applied', {
              normalisedPreview: normalised.slice(0, 80),
              changedKeysCount: applied?.changedKeys.length ?? 0,
              changedKeysPreview: (applied?.changedKeys ?? []).slice(0, 5),
            });
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
            const writtenKeys = fieldSourceTrackerRef.current.consumeTurnWrites();
            regexResults = buildRegexSummary(writtenKeys, jobRef.current);
          }
          // Pass the ORIGINAL text to Sonnet (not the normalised form) —
          // iOS sends unnormalised text on the wire and the regex
          // summary alongside (Swift sendTranscript:494,504). Backend
          // has its own dialogue-engine normalisation; double-normalising
          // would diverge from iOS.
          console.info(
            `[recording:pipeline] stage=sonnet_send utteranceId=${utteranceId.slice(0, 8)} inFlightToolCallId=${inFlightToolCallId?.slice(0, 12) ?? 'none'} regexHints=${regexResults?.length ?? 0}`
          );
          clientDiagnostic('pipeline_sonnet_send', {
            textPreview: text.slice(0, 80),
            utteranceIdShort: utteranceId.slice(0, 12),
            hasInFlightAsk: Boolean(inFlightToolCallId),
            regexHintsCount: regexResults?.length ?? 0,
          });
          sonnetRef.current?.sendTranscript(text, {
            confirmationsEnabled: getConfirmationModeEnabled(),
            utteranceId,
            regexResults,
          });
          if (inFlightToolCallId) {
            console.info(
              `[recording:pipeline] stage=ask_user_answered toolCallId=${inFlightToolCallId.slice(0, 12)} userText="${text.slice(0, 40)}"`
            );
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
      // Diagnostic — log every extraction envelope received so we can see
      // what session_resume rehydrate replays vs what fresh turns produce.
      // First confirmation text is captured because the sess_moytejkn_8bsl
      // bug (2026-05-09) showed the same stale "I don't know the field 'is'."
      // string firing twice without a matching server-side extraction log
      // — we need to see if it came in via this handler.
      const firstConfirmationPreview =
        result.confirmations && result.confirmations[0]
          ? (result.confirmations[0].text ?? '').slice(0, 80)
          : '';
      clientDiagnostic('onExtraction_entered', {
        readings: result.readings?.length ?? 0,
        confirmations: result.confirmations?.length ?? 0,
        validation_alerts: result.validation_alerts?.length ?? 0,
        observations: result.observations?.length ?? 0,
        field_clears: result.field_clears?.length ?? 0,
        circuit_updates: result.circuit_updates?.length ?? 0,
        firstConfirmationPreview,
        extraction_failed: Boolean(result.extraction_failed),
      });
      const applied = applyExtractionToJob(jobRef.current, result);
      if (applied) {
        updateJobRef.current(applied.patch);
        // Mirror the patch into jobRef.current synchronously so a
        // second extraction landing in the same React tick reads the
        // freshly-patched circuits[] / sections rather than the pre-patch
        // snapshot. Without this, the next applyExtractionToJob call
        // re-creates each circuit row with a new UUID and the patch
        // REPLACES the circuits array (apply-extraction.ts always
        // returns a full circuits array, not a delta), so only the most
        // recently dictated circuit survives. Every other apply-path in
        // this file (voice-command, regex-apply, onFieldCorrected,
        // onCircuitCreated, onCircuitUpdated) already mirrors — this
        // is the path that was missed.
        jobRef.current = {
          ...jobRef.current,
          ...(applied.patch as Partial<typeof jobRef.current>),
        };
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
        if (sentence) {
          clientDiagnostic('onExtraction_speaking_confirmation', {
            sentencePreview: sentence.slice(0, 80),
          });
          speakConfirmation(sentence);
        }
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
    // Instantiate the matcher + tracker alongside the WS session. Try/
    // catch the matcher construction so a Safari < 16.4 lookbehind-throw
    // (NumberNormaliser step 8d) degrades gracefully to the no-regex-
    // hints path — same behaviour as today, no regression. See PLAN
    // risks #2.
    try {
      regexMatcherRef.current = new TranscriptFieldMatcher();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recording] feature.regex_lookbehind_unsupported', err);
      regexMatcherRef.current = null;
    }
    fieldSourceTrackerRef.current = new FieldSourceTracker();
    fieldSourceTrackerRef.current.seedFromJob(jobRef.current);
    cumulativeTranscriptRef.current = '';

    const session = new SonnetSession({
      onStateChange: setSonnetState,
      onExtraction: (result) => {
        applyExtraction(result);
      },
      onQuestion: (q) => {
        clientDiagnostic('onQuestion_entered', {
          questionType: q.question_type ?? null,
          questionLength: typeof q.question === 'string' ? q.question.length : 0,
          questionPreview: typeof q.question === 'string' ? q.question.slice(0, 80) : '',
          hasToolCallId: typeof q.tool_call_id === 'string' && q.tool_call_id.length > 0,
        });
        let isNew = false;
        let queueDepthAfter = 0;
        setQuestions((prev) => {
          // Dedup by text — Sonnet occasionally re-asks the same
          // question across turns until the field is filled.
          if (prev.some((p) => p.question === q.question)) {
            queueDepthAfter = prev.length;
            return prev;
          }
          isNew = true;
          const next = [...prev, q];
          queueDepthAfter = next.length > 5 ? 5 : next.length;
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
        // doesn't re-announce a queued question. The attention tone
        // plays BEFORE TTS to give the inspector a half-second of
        // warning that something needs their attention — same iOS
        // ordering at AlertManager.swift:717 (playAttentionTone()
        // immediately before speakAlertMessage()).
        if (isNew && q.question) {
          clientDiagnostic('onQuestion_speaking', {
            queueDepth: queueDepthAfter,
            questionPreview: q.question.slice(0, 80),
          });
          // Switch the sleep timer to the 75s question-answer window
          // so the inspector has time to hear, think, and reply
          // without the standard 60s timer dropping us into sleep
          // mid-thought. Mirrors iOS SleepManager.swift:68.
          sleepManagerRef.current?.onQuestionAsked();
          playAttentionTone();
          speak(q.question);
        } else {
          clientDiagnostic('onQuestion_skipped_speak', {
            isNew,
            hasQuestionText: Boolean(q.question),
            queueDepth: queueDepthAfter,
            reason: !isNew ? 'dedup_hit' : !q.question ? 'empty_text' : 'unknown',
          });
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
      onVoiceCommandResponse: (response) => {
        // iOS canon: DeepgramRecordingViewModel.handleVoiceCommandResponse
        // (DeepgramRecordingViewModel.swift:7446). Execute the action via
        // the same applier the local Calculate/Apply intents use, then
        // speak the server's spoken_response through the confirmation TTS
        // gate. Pre-2026-05-10 the web decoded these messages and dropped
        // them on the floor (the callback was never bound).
        clientDiagnostic('voice_command_response_received', {
          understood: response.understood,
          actionType: response.action?.type ?? 'none',
          responsePreview: (response.spoken_response ?? '').slice(0, 80),
        });
        if (response.understood && response.action) {
          const command = mapServerActionToVoiceCommand(response.action);
          if (command) {
            const outcome = applyVoiceCommand(
              command,
              jobRef.current as unknown as VoiceCommandJob
            );
            if (outcome.patch) {
              updateJobRef.current(outcome.patch);
              jobRef.current = {
                ...jobRef.current,
                ...(outcome.patch as Partial<typeof jobRef.current>),
              };
              if (outcome.changedKeys && outcome.changedKeys.length > 0) {
                liveFill.markUpdated(outcome.changedKeys);
              }
              playConfirmationChime();
            }
          } else {
            clientDiagnostic('voice_command_action_unmapped', {
              actionType: response.action?.type ?? 'none',
            });
          }
        }
        if (response.spoken_response) {
          speakConfirmation(response.spoken_response);
        }
        sleepManagerRef.current?.onSpeechActivity();
      },
      onChitchatPaused: () => {
        // iOS canon: serverDidEnterChitchatPause (DeepgramRecordingViewModel.swift:6849).
        clientDiagnostic('chitchat_paused_received', {});
        setChitchatPaused(true);
      },
      onChitchatResumed: (reason) => {
        // iOS canon: serverDidExitChitchatPause (line 6855). Clear the
        // banner + cancel the optimistic-resume watchdog so a confirm
        // that arrives after a tap doesn't leave a stale timer armed.
        clientDiagnostic('chitchat_resumed_received', { reason });
        setChitchatPaused(false);
        chitchatPendingResumeRef.current = false;
        if (chitchatResumeWatchdogRef.current) {
          clearTimeout(chitchatResumeWatchdogRef.current);
          chitchatResumeWatchdogRef.current = null;
        }
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
    // Wire the diagnostic sink so deep modules (tts.ts, elevenlabs-tts.ts)
    // can fire `client_diagnostic` envelopes without plumbing the session
    // reference through every layer. Cleared on teardownSonnet.
    setDiagnosticSink(session);
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
        // T20 — feed the VAD chunk accumulator. Only run while sleeping;
        // the SleepManager ignores VAD frames in `active` (the timer is
        // what drives sleep entry there) so doing inference on every
        // active-state frame would be ~2ms of WASM compute per 32ms
        // burned for nothing. While sleeping we DO want every chunk so
        // the wake gate fires as soon as the inspector starts speaking.
        const silero = sileroRef.current;
        const sleep = sleepManagerRef.current;
        if (silero && sleep && sleep.currentState === 'sleeping') {
          dispatchSamplesToVad(samples16k, silero, sleep, vadAccumulatorRef.current);
        }
      },
      onLevel: (level) => {
        const now = performance.now();
        // SleepManager's RMS fallback path — only reachable if the
        // Silero load failed at session start (offline first run + no
        // PWA cache, ORT crash, model 404). When silero is loaded, the
        // primary `processVadFrame` path in onSamples drives the wake
        // gate and this RMS feed is a no-op (the SleepManager just
        // ignores frames whose state already matched). We still call
        // unconditionally so a mid-session Silero failure (rare) leaves
        // the RMS fallback running.
        if (!sileroRef.current?.loaded) {
          sleepManagerRef.current?.processAudioLevel(level);
        }
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
      onEnterSleeping: () => {
        // Stage 4c collapsed model — direct active → sleeping after
        // the 60s no-final timer (or via manual pause). Mirrors iOS
        // SleepManager.swift:21–24. Tell Sonnet to pause cost
        // tracking, fully disconnect Deepgram, and stop the elapsed-
        // tick. The mic stream keeps running so the ring buffer
        // still captures pre-wake audio for the replay on next
        // speech.
        sonnetRef.current?.pause();
        teardownDeepgram();
        teardownSonnet();
        clearTick();
        setMicLevel(0);
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
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') {
      recordLifecycle('recording-start-blocked', { status: statusRef.current });
      return;
    }
    recordLifecycle('recording-start', { jobId: jobRef.current?.id ?? null });
    // Unlock SpeechSynthesis inside the user-gesture stack frame BEFORE
    // any await — iOS Safari only grants TTS autoplay when the first
    // speak() lands inside a click/touchend/keydown handler, and the
    // gesture grant does not survive across `await`. This is the web
    // analogue of iOS's `AudioSessionManager.setupSession()` call at
    // RecordingSessionCoordinator.swift:149 which configures
    // .playAndRecord at the same lifecycle moment to unlock the audio
    // output path. Without this prime, the first ask_user question is
    // silent on iPhone — the inspector sees the question on screen but
    // cannot hear it, the conversation stalls, and the session ends
    // with near-empty extraction (see sess_mox58v7n_kpr9, 2026-05-08).
    primeTts();
    // Wire the SleepManager TTS-active gate. Every TTS dispatch (question,
    // confirmation, voice-command response) flips the no-transcript timer
    // off while the device speaker is producing artificial silence on the
    // mic. iOS canon: AlertManager fires
    // `sessionCoordinator.sleepManager.onTTSStarted/Finished` at
    // DeepgramRecordingViewModel.swift:813,866. Without this, the web's
    // 60s timer kept counting while TTS spoke a 5-8s question + the
    // inspector's think-time, fired sleep entry mid-conversation, and
    // tore down Deepgram + Sonnet exactly when the inspector started
    // their answer.
    setTtsLifecycleObserver((event) => {
      sleepManagerRef.current?.setTtsActive(event === 'start');
    });
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
    // Wire the same sessionId into the ElevenLabs TTS proxy so the
    // backend's CostTracker attributes character usage to this session
    // (mirrors iOS AlertManager.sessionIdProvider). Without this every
    // ElevenLabs round-trip is unattributed and the per-session cost
    // readout under-reports — and the proxy short-circuits to the
    // SpeechSynthesis fallback because tts.ts requires an active
    // sessionId before routing through ElevenLabs.
    setTtsSessionId(sessionId);
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
    // T20 — kick off Silero VAD load in parallel with mic permission +
    // WS handshake. Fetch + WASM init typically lands in 50–200ms cold
    // (and effectively 0 once Serwist's `models` cache fills), well
    // inside the time the user spends acknowledging the permission
    // prompt. Don't await: a slow load shouldn't gate the recording UX,
    // and if it eventually fails we already have the RMS fallback in
    // onLevel. If the session is torn down before load() resolves, the
    // wrapper is dropped on the floor — sileroRef.current is the source
    // of truth, so a stale assignment can't reactivate inference.
    if (SILERO_VAD_ENABLED) {
      const vad = new SileroVAD();
      void vad
        .load()
        .then(() => {
          if (sessionIdRef.current !== sessionId) return;
          sileroRef.current = vad;
        })
        .catch((err) => {
          if (sessionIdRef.current !== sessionId) return;
          // Drop to RMS for this session. Console-warn only — the
          // SleepManager's RMS path is already armed via onLevel,
          // so the inspector loses the noise-rejection benefit but
          // still gets functional wake-from-sleep.
          console.warn('[recording] SileroVAD load failed; falling back to RMS wake gate:', err);
        });
    }
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
    recordLifecycle('recording-stop', { status: statusRef.current });
    sessionIdRef.current = '';
    // Clear the TTS sessionId in lockstep so post-stop speak() calls
    // (e.g. an ask_user that arrived after the WS close) bypass the
    // ElevenLabs path and degrade to native TTS — mirrors the
    // sessionIdRef rotation guard everywhere else in this file.
    setTtsSessionId(null);
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
    // Drop the TTS lifecycle observer so any post-stop speak() (e.g.
    // the tour controller used outside a recording session) doesn't
    // attempt to mutate a torn-down sleep manager. Mirrors the symmetric
    // pairing with setTtsLifecycleObserver in start().
    setTtsLifecycleObserver(null);
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
    // double-emit the sleep transition (and so a late resume() closure
    // from a pre-stop session can't flip sleeping → active on a freshly
    // restarted session).
    if (statusRef.current !== 'active') return;
    // Stage 4c collapse: manual pause is the same effect as the 60s
    // timer firing. SleepManager owns the transition so the WS
    // teardown + state mutation flow through onEnterSleeping
    // identically to the auto-doze path. Mirrors iOS where pause is
    // a thin wrapper over `enterSleeping()`.
    sleepManagerRef.current?.enterSleeping();
  }, []);

  /** Manual resume — mirrors the wake path. If Deepgram was torn down
   *  (sleeping), reopen it; otherwise just unpause and replay the ring
   *  buffer so any audio captured while paused reaches the ASR. The mic
   *  + ring buffer keep running through both doze and sleep, so the
   *  replay is always valid. */
  const resume = React.useCallback(async () => {
    // Synchronous guard. resume() is legal only from the paused/sleeping
    // states — anything else (including a late retry from the overlay
    // while we've already rotated to a fresh session) must no-op.
    if (statusRef.current !== 'sleeping') return;
    // Re-prime TTS inside the Resume-button user gesture stack frame
    // BEFORE any await. iPad Safari can drop the audio gesture grant
    // during a long pause (autoplay policy expires it), so a Resume
    // tap is the next user gesture and is our chance to refresh both
    // the SpeechSynthesis voices cache and the shared audio element's
    // play() grant. Without this, the first ask_user after a Resume
    // is silent in exactly the same way the very-first ask_user
    // would be without start()'s primeTts.
    primeTts();
    const fromSleeping = true;
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

  // Auto-dismiss timer registry — keyed by question text (the same key
  // the dedup logic in onQuestion uses). Mirrors iOS's per-alert
  // autoDismissTask (AlertManager.swift:151) which fires 15s AFTER
  // TTS finishes for interactive alerts. The PWA uses a coarser
  // 15-from-arrival because we don't track per-question TTS-finish
  // events; in practice the inspector either responds within 5s or
  // doesn't respond at all, so the extra grace from arrival-vs-TTS-
  // end timing is minor.
  //
  // Why a ref of Map (not state): timer handles are imperative and
  // changing them shouldn't trigger a re-render. Cleared on dismiss
  // (manual or auto) so we don't leak handles when the inspector
  // dismisses faster than the timeout fires.
  const dismissTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /** Per-question timeout in ms. Mirrors iOS's three-tier policy
   *  (interactive 15s / informational 4s / visual-only 6s,
   *  AlertManager.swift:1295/1308/758). Only the interactive tier
   *  exists today on the PWA — every onQuestion is ask-shaped — but
   *  the switch is here so adding informational/visual paths later
   *  is a one-line change. */
  const autoDismissMsFor = React.useCallback((q: SonnetQuestion): number => {
    // Visual-only / informational shapes don't fire onQuestion today,
    // so this branch is dead but kept for forward-compat.
    if (q.question_type === 'visual_only') return 6000;
    if (q.question_type === 'informational') return 4000;
    return 15000;
  }, []);

  const cancelDismissTimer = React.useCallback((key: string) => {
    const existing = dismissTimersRef.current.get(key);
    if (existing) {
      clearTimeout(existing);
      dismissTimersRef.current.delete(key);
    }
  }, []);

  const dismissQuestion = React.useCallback(
    (index: number) => {
      try {
        clientDiagnostic('tap_dismiss_entered', { index });
        setQuestions((prev) => {
          const removed = prev[index];
          if (removed?.question) cancelDismissTimer(removed.question);
          return prev.filter((_, i) => i !== index);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
        console.error('[recording:tap_dismiss] threw', err);
        clientDiagnostic('tap_dismiss_threw', { message });
      }
    },
    [cancelDismissTimer]
  );

  /**
   * Tap-accept on a question — mirrors iOS handleTapResponse(accepted:
   * true) (AlertManager.swift:610 + line 785 "Updated"). Wires the
   * accept through the same `ask_user_answered` channel a spoken "yes"
   * would, so the backend's tool-call resolver sees one canonical
   * answer shape regardless of whether the inspector tapped or spoke.
   * Plays the confirmation chime BEFORE TTS — same iOS ordering at
   * line 784–785.
   *
   * Idempotency: SonnetSession's firedToolCallIds Set already guards
   * against double-emit, so a second tap on the same question is a
   * silent no-op on the wire.
   *
   * Rejected (no tool_call_id): legacy questions don't have a wire
   * back path — fall back to a silent dismiss.
   */
  const acceptQuestion = React.useCallback(
    (index: number) => {
      // Wrap the entire body in a try/catch so a JS exception inside any
      // of the three sub-paths (wire send / chime / TTS / setQuestions)
      // cannot bubble up to the React error boundary and look like a
      // page crash. iOS's handleTapResponse has implicit Obj-C exception
      // safety; the PWA needs explicit guarding. Mirrors the
      // best-effort posture iOS takes around speakWithTTS.
      try {
        const target = questions[index];
        clientDiagnostic('tap_accept_entered', {
          index,
          haveTarget: Boolean(target),
          haveToolCallId: Boolean(target?.tool_call_id),
          haveSonnetRef: Boolean(sonnetRef.current),
          questionPreview: target?.question?.slice(0, 80) ?? '',
        });
        if (!target) return;
        const toolCallId = target.tool_call_id;
        if (toolCallId && sonnetRef.current) {
          const utteranceId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `u_${Date.now()}_tap`;
          // Send a placeholder transcript so the wire ordering invariant
          // holds (transcript-then-ask) — the backend's seenTranscript
          // Utterances Set must be populated before the ask answer
          // arrives, otherwise the fast-path dedupe misses and we burn
          // the fuzzy fallback. Empty user_text would defeat the
          // anchor; "yes" is the canonical positive shape.
          sonnetRef.current.sendTranscript('yes', {
            confirmationsEnabled: getConfirmationModeEnabled(),
            utteranceId,
          });
          sonnetRef.current.sendAskUserAnswered(toolCallId, 'yes', utteranceId);
        }
        playConfirmationChime();
        speak('Updated');
        // Drop the question from the queue + clear the auto-dismiss
        // timer.
        setQuestions((prev) => {
          if (target.question) cancelDismissTimer(target.question);
          return prev.filter((_, i) => i !== index);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
        console.error('[recording:tap_accept] threw', err);
        clientDiagnostic('tap_accept_threw', { message });
      }
    },
    [cancelDismissTimer, questions]
  );

  const rejectQuestion = React.useCallback(
    (index: number) => {
      try {
        const target = questions[index];
        clientDiagnostic('tap_reject_entered', {
          index,
          haveTarget: Boolean(target),
          haveToolCallId: Boolean(target?.tool_call_id),
          haveSonnetRef: Boolean(sonnetRef.current),
          questionPreview: target?.question?.slice(0, 80) ?? '',
        });
        if (!target) return;
        const toolCallId = target.tool_call_id;
        if (toolCallId && sonnetRef.current) {
          const utteranceId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `u_${Date.now()}_tap`;
          sonnetRef.current.sendTranscript('no', {
            confirmationsEnabled: getConfirmationModeEnabled(),
            utteranceId,
          });
          sonnetRef.current.sendAskUserAnswered(toolCallId, 'no', utteranceId);
        }
        // No chime on reject — iOS line 788 only speaks the response.
        speak('Okay, keeping it.');
        setQuestions((prev) => {
          if (target.question) cancelDismissTimer(target.question);
          return prev.filter((_, i) => i !== index);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
        console.error('[recording:tap_reject] threw', err);
        clientDiagnostic('tap_reject_threw', { message });
      }
    },
    [cancelDismissTimer, questions]
  );

  // Manual wake from the chitchat-pause banner Resume button. Mirrors iOS
  // `resumeFromChitchatPause` (DeepgramRecordingViewModel.swift:6880-6912):
  // optimistically clear the banner so the inspector sees instant
  // acknowledgement, send `chitchat_resume` over the WS, then arm a 5s
  // watchdog. If the backend doesn't confirm via `chitchat_resumed`
  // within that window, we re-show the banner — the inspector knows
  // their tap didn't reach Sonnet (network drop / backend stall) and
  // can retry rather than dictating into a silently-still-paused
  // session. The watchdog is cancelled by `onChitchatResumed`.
  const resumeChitchat = React.useCallback(() => {
    setChitchatPaused(false);
    chitchatPendingResumeRef.current = true;
    if (chitchatResumeWatchdogRef.current) {
      clearTimeout(chitchatResumeWatchdogRef.current);
    }
    chitchatResumeWatchdogRef.current = setTimeout(() => {
      // If `chitchat_resumed` arrived, pendingResume is already false
      // and we leave the cleared banner alone.
      if (chitchatPendingResumeRef.current) {
        chitchatPendingResumeRef.current = false;
        setChitchatPaused(true);
        clientDiagnostic('chitchat_resume_watchdog_fired', { timeoutSec: 5 });
      }
      chitchatResumeWatchdogRef.current = null;
    }, 5000);
    sonnetRef.current?.sendChitchatResume();
    clientDiagnostic('chitchat_resume_manual', {});
  }, []);

  // Schedule the auto-dismiss whenever a NEW question lands at the
  // tail of the questions queue. Driven off the questions state (not
  // onQuestion) so a re-render race that drops a question mid-fire
  // can't leak its timer; the cleanup loop below also clears any
  // stragglers when the question text disappears from the queue.
  React.useEffect(() => {
    const known = new Set(questions.map((q) => q.question));
    // Drop timers whose question is no longer in the queue.
    for (const [key, handle] of dismissTimersRef.current.entries()) {
      if (!known.has(key)) {
        clearTimeout(handle);
        dismissTimersRef.current.delete(key);
      }
    }
    // Schedule one for any newly-added question.
    questions.forEach((q, idx) => {
      if (!q.question) return;
      if (dismissTimersRef.current.has(q.question)) return;
      const ms = autoDismissMsFor(q);
      const handle = setTimeout(() => {
        dismissTimersRef.current.delete(q.question);
        // Re-resolve the index by text in case the queue shifted
        // between schedule and fire (a manual dismiss earlier in the
        // list would have changed the absolute index).
        setQuestions((prev) => prev.filter((p) => p.question !== q.question));
      }, ms);
      dismissTimersRef.current.set(q.question, handle);
      void idx;
    });
  }, [questions, autoDismissMsFor]);

  // Cleanup on unmount — drop any pending timers so we don't fire
  // setQuestions after the provider has gone.
  React.useEffect(() => {
    const timers = dismissTimersRef.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
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
      chitchatPaused,
      errorMessage,
      backendSessionId,
      start,
      stop,
      pause,
      resume,
      dismissQuestion,
      acceptQuestion,
      rejectQuestion,
      resumeChitchat,
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
      chitchatPaused,
      errorMessage,
      backendSessionId,
      start,
      stop,
      pause,
      resume,
      dismissQuestion,
      acceptQuestion,
      rejectQuestion,
      resumeChitchat,
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
