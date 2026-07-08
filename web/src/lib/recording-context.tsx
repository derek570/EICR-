'use client';

import * as React from 'react';
import { startMicCapture, type MicCaptureHandle } from './recording/mic-capture';
import {
  DeepgramService,
  type DeepgramConnectionState,
  type SttModel,
} from './recording/deepgram-service';
import { ensureRuntimeConfigLoaded, DEFAULT_STT_MODEL } from '@/lib/runtime-config';
import { resampleTo16k } from './recording/resample';
import {
  SonnetSession,
  type ExtractedReading,
  type ExtractionResult,
  type SonnetConnectionState,
  type SonnetQuestion,
} from './recording/sonnet-session';
import {
  applyBoardOpsToJob,
  applyExtractionToJob,
  applyObservationUpdate,
} from './recording/apply-extraction';
import {
  OBSERVATION_PHOTO_LINK_WINDOW_MS,
  type PendingObservationPhoto,
  type RecentObservationRef,
} from './recording/observation-photo';
import { captureObservationPhoto as runCaptureObservationPhoto } from './recording/capture-observation-photo';
import { clearPendingPhoto, readPendingPhoto, writePendingPhoto } from './pwa/job-cache';
import { resizeImage } from './image-resize';
import { haptic } from './haptic';
import { applyRegexMatchToJob } from './recording/apply-regex-match';
import { TranscriptFieldMatcher } from './recording/transcript-field-matcher';
import { FieldSourceTracker } from './recording/field-source-tracker';
import {
  buildRegexSummary,
  isEmptyResult,
  type RegexResultsWire,
} from './recording/regex-match-result';
import { shouldForward } from './recording/transcript-gate';
import { InFlightQuestionTracker } from './recording/in-flight-question';
import { buildConfirmationDedupeKey } from './recording/confirmation-dedupe-key';
import {
  PendingReadingsBuffer,
  buildPendingReadingsQuestion,
  classifyReadingsForBuffer,
  type PendingReading,
} from './recording/pending-readings-buffer';
import { isNonCircuitField } from './recording/non-circuit-fields';
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
  getTtsAudioWindow,
  isDirectAudioActive,
  isTTSEcho,
  isWithinTtsWindow,
  primeTts,
  setTtsLifecycleObserver,
  speak as speakRaw,
  speakConfirmation,
  type SpeakOptions,
} from './recording/tts';
import {
  purge as ttsQueuePurge,
  resumeIfDeferred as ttsQueueResumeIfDeferred,
  setOnDiscarded as ttsQueueSetOnDiscarded,
  setShouldDeferPlayback as ttsQueueSetShouldDeferPlayback,
} from './recording/tts-queue';
import {
  handleCancelPendingTts,
  handleInspectorStoppedSpeaking,
} from './recording/tts-prompt-helpers';
import { setActiveSessionId as setTtsSessionId } from './recording/elevenlabs-tts';
import { clientDiagnostic, setDiagnosticSink } from './recording/client-diagnostic';
import { record as recordLifecycle } from './diagnostics/lifecycle-log';
import { pipelineLog } from './diagnostics/pipeline-log';
import {
  playAttentionTone,
  playConfirmationChime,
  playSentForProcessingChime,
} from './recording/tones';
import { api } from './api-client';
import { useJobContext } from './job-context';
import { applyVoiceCommand, parseVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';
import { mapServerActionToVoiceCommand } from './recording/voice-command-action';
import { useCurrentUser } from './use-current-user';
import { useUserDefaults } from '@/hooks/use-user-defaults';
import { toast } from 'sonner';
import {
  clearRecordingState,
  loadAndConsumeRecordingState,
  persistRecordingState,
  type PersistedRecordingState,
} from './recording/session-resume';

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
  /** Currently-active board id in a multi-board recording session.
   *  Driven by the unified `current_board_changed` WS broadcast from
   *  the backend (`src/extraction/sonnet-stream.js
   *  emitCurrentBoardChangedFromBoardOps`). Consumers (Board tab,
   *  Circuits tab, board-banner) filter their UI down to this id.
   *  Null when no session is active OR the job is single-board. */
  currentBoardId: string | null;
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
  /** L2 obs-photo sprint — capture an observation photo during a live
   *  recording session. Resizes locally to ≤ 2048 px at JPEG 0.80
   *  (EXIF + GPS dropped via canvas redraw), uploads to
   *  `/api/job/.../photos`, then either auto-links to a recent
   *  observation (within `OBSERVATION_PHOTO_LINK_WINDOW_MS`), enters
   *  the pending slot for the next observation to claim, or — when
   *  the 60 s window expires unclaimed — flows into
   *  `job.unassigned_photos[]` for later recovery via the picker on
   *  the observation edit sheet. No-op when `state !== 'active'`
   *  (matches iOS `:1505`). Phase 4 wires the body; Phase 2 ships the
   *  signature so Phase 5's Photo button can be authored without
   *  blocking on the upload-handler work. iOS canon:
   *  `DeepgramRecordingViewModel.swift:1504-1591`. */
  captureObservationPhoto: (file: File) => Promise<void>;
};

type RecordingCtx = RecordingSnapshot & RecordingActions;

const Ctx = React.createContext<RecordingCtx | null>(null);

// Deepgram Nova-3 streaming — $0.0077/min at the inspector tier. We tick
// cost in real time so the hero readout feels live; Phase 4d will splice
// Sonnet token costs in on top.
const DEEPGRAM_USD_PER_MIN = 0.0077;

// Bug K (2026-05-11) — Deepgram split-utterance buffer.
// Deepgram occasionally chunks "Circuit N is X" across two finals — the
// first ends with bare "Circuit N is" (no completion) and the
// designation arrives 1-3 seconds later in a separate final. Without
// buffering, Sonnet sees the two halves as unrelated utterances and
// (a) emits no tool calls for the first half, then (b) tries to route
// the second half via DESCRIPTION MATCHING against the existing
// schedule — which can mis-rename a previously-created circuit
// (production session sess_mp19b6tf_i5xc, 2026-05-11 13:48 UTC). The
// fix: detect the trailing-naming pattern, hold the first final for
// up to NAMING_BUFFER_TIMEOUT_MS, and either concatenate-and-flush on
// the next final OR timeout-and-flush alone.
//
// Pattern matches: "Circuit 1 is", "Circuit number 2 is", "Circuit one
// is", "Circuit two is", "Circuit 3 is.", trailing whitespace tolerated.
// Anchored to end-of-string — does NOT match if the utterance continues
// past "is" (e.g. "Circuit 1 is a cooker" → no buffer, normal dispatch).
//
// Same regex shape on the iOS side (DeepgramRecordingViewModel.swift) so
// the two clients buffer identically. Keep them in sync.
const TRAILING_CIRCUIT_NAMING_PATTERN =
  /\bcircuit\s+(?:number\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+is\s*\.?\s*$/i;
const NAMING_BUFFER_TIMEOUT_MS = 3000;

// Burst-buffer window. Holds every transcript final for this long
// before shipping to Sonnet, merging any second final that arrives
// inside the window. 500ms matches the typical end-of-sentence pause
// Deepgram inserts between back-to-back phrases said by the same
// speaker — long enough to coalesce "Observation." + "There is a
// crack…" when the inspector pauses briefly between trigger and
// description, short enough that single-utterance latency is barely
// perceptible (Sonnet's own response budget is ~3s).
const BURST_BUFFER_TIMEOUT_MS = 500;

/**
 * Heartbeat cadence — 5 s. Sized to be:
 *   - Frequent enough that the maximum freeze window we can MISS is bounded
 *     to <5s (any pause >5s lights up at least one gap), which is well
 *     below the 30-90s death window we're trying to characterise.
 *   - Infrequent enough that 200 heartbeats covers ~16 min of recording
 *     in the localStorage pipelineLog ring without churning the older
 *     domain events out of the window.
 *   - Off the same heartbeat cadence used by iOS DeepgramService.swift
 *     for the WS-ping path (every 5s); aligning gives us cross-platform
 *     comparable timelines.
 */
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Delay between ElevenLabs `ended` and resuming the PCM-send pipeline. Mirrors
 * the iOS `pauseAudioStream() → 500ms wait → resumeAudioStream()` cadence at
 * `DeepgramService.swift:566` / `DeepgramRecordingViewModel.swift:828` — long
 * enough to swallow the audio-out tail of the spoken question + any room
 * reverb before re-enabling mic-to-WS forwarding, short enough that the
 * inspector's immediate verbal answer to a question doesn't get clipped.
 */
const TTS_PCM_GATE_RESUME_DELAY_MS = 500;

function isTrailingCircuitNamingPattern(text: string): boolean {
  return TRAILING_CIRCUIT_NAMING_PATTERN.test(text);
}

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
  // H7 — user-scoped circuit-field defaults. iOS canon applies these to
  // any newly-created circuit (`DefaultsService.applyDefaults` +
  // `CertificateDefaultsService.applyCableDefaults`) so a Sonnet-
  // created row arrives with wiring type, ref method, OCPD/RCD BS EN,
  // IR test voltage, max disconnect time pre-filled — same as if the
  // inspector had added the row manually and tapped "Apply Defaults".
  // Held in a ref so the apply-extraction call-path can read the
  // current value synchronously (the recording callbacks fire outside
  // React's render cycle).
  const { user } = useCurrentUser();
  const { defaults: userDefaults } = useUserDefaults(user?.id);
  const userDefaultsRef = React.useRef(userDefaults);
  React.useEffect(() => {
    userDefaultsRef.current = userDefaults;
  }, [userDefaults]);
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
    // Mirror lifecycle events to CloudWatch via clientDiagnostic. The
    // localStorage tail (recordLifecycle) survives reloads but is invisible
    // outside Settings → Diagnostics. Field-tested 2026-05-15: PWA sessions
    // were dying at 30-90s during ElevenLabs audio playback with no JS
    // exception, no error_boundary, no `sonnet_ws_close` in the wire — the
    // page just stopped emitting. Hypothesis is iPad Safari BFCaching or
    // suspending the tab on audio playback; without these events on the
    // server side, the next field session can't disambiguate Safari-killed-
    // the-tab from a JS regression. clientDiagnostic is the only sink that
    // reaches CloudWatch from the recording pipeline.
    clientDiagnostic('recording_provider_mount', {
      url: window.location.pathname,
      visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    });
    const onShow = (e: PageTransitionEvent) => {
      recordLifecycle('page-show', { persisted: e.persisted });
      clientDiagnostic('recording_pageshow', {
        persisted: e.persisted,
        url: window.location.pathname,
      });
      // BFCache restore: if recording was active before the freeze AND
      // the page is being restored from the bfcache (persisted=true),
      // the WS sockets and AudioContext are in an undefined state.
      // Auto-restart silently would steal the inspector's attention if
      // they intentionally backgrounded the tab. Instead surface a
      // sonner toast offering a one-tap restart. Mirrors the iOS UX
      // pattern of "Recording suspended" alerts after interruption.
      if (e.persisted && wasActiveBeforeHideRef.current === 'active') {
        wasActiveBeforeHideRef.current = 'idle';
        toast('Recording was suspended', {
          description: 'iPad Safari paused the tab. Tap to restart.',
          duration: Infinity,
          action: {
            label: 'Restart',
            onClick: () => {
              const actions = lifecycleActionsRef.current;
              actions?.stop();
              setTimeout(() => actions?.pause(), 400);
            },
          },
        });
      }
    };
    const onHide = (e: PageTransitionEvent) => {
      recordLifecycle('page-hide', {
        persisted: e.persisted,
        status: statusRef.current,
      });
      clientDiagnostic('recording_pagehide', {
        persisted: e.persisted,
        url: window.location.pathname,
        status: statusRef.current,
      });
      // BFCache freeze: pause synchronously BEFORE the page freezes so
      // `session_pause` lands on the still-live Sonnet WS and the
      // backend can flush. Without this, the WS dies on freeze with
      // no graceful shutdown — the next reopen has to negotiate a
      // session_resume rebind against a backend that thinks the
      // session was abruptly disconnected.
      if (e.persisted) {
        wasActiveBeforeHideRef.current = statusRef.current;
        if (statusRef.current === 'active') {
          lifecycleActionsRef.current?.pause();
        }
      }
    };
    const onVisibility = () => {
      const state = document.visibilityState;
      recordLifecycle('visibility-change', { state });
      clientDiagnostic('recording_visibility_change', { state });
      if (state === 'hidden') {
        lastVisibilityHiddenAtRef.current = Date.now();
      } else if (state === 'visible' && lastVisibilityHiddenAtRef.current != null) {
        // On return: if we were hidden long enough for ALB to have
        // reaped the WS (now bounded by the 25s app-heartbeat from
        // commit 4015c5d) OR for iPad Safari to have BFCached us
        // (the persisted=true branch above usually handles this, but
        // sometimes visibilitychange fires without the matching
        // pagehide/pageshow pair), probe the WS sockets and surface a
        // recovery toast if either is disconnected.
        const hiddenMs = Date.now() - lastVisibilityHiddenAtRef.current;
        lastVisibilityHiddenAtRef.current = null;
        if (hiddenMs > VISIBILITY_HIDDEN_RECOVERY_THRESHOLD_MS) {
          const dgState = deepgramRef.current?.connectionState;
          const sonnetState = sonnetRef.current?.connectionState;
          const anyDown =
            (dgState != null && dgState !== 'connected') ||
            (sonnetState != null && sonnetState !== 'connected');
          clientDiagnostic('recording_visibility_recovery_check', {
            hiddenMs,
            deepgramState: dgState ?? 'no-service',
            sonnetState: sonnetState ?? 'no-service',
            anyDown,
            status: statusRef.current,
          });
          if (anyDown && statusRef.current === 'active') {
            toast('Connection lost while away', {
              description: 'The recording may need to resume manually.',
              duration: 10_000,
              action: {
                label: 'Resume',
                onClick: () => lifecycleActionsRef.current?.pause(),
              },
            });
          }
        }
      }
    };
    // Page Lifecycle API — `freeze` and `resume` only exist on Chromium-
    // based engines, but iOS Safari emits its analogue via pagehide
    // (persisted=true) which we already capture. Wired here so Android
    // Chrome PWA installs get the same recovery flow.
    const onFreeze = () => {
      recordLifecycle('page-freeze', { status: statusRef.current });
      clientDiagnostic('recording_page_freeze', { status: statusRef.current });
      // Parallel #69 — pause if active so session_pause lands BEFORE
      // the renderer is suspended. Practically Chromium-only; iPad
      // Safari routes through onHide(persisted=true) instead.
      wasActiveBeforeHideRef.current = statusRef.current;
      if (statusRef.current === 'active') {
        lifecycleActionsRef.current?.pause();
      }
    };
    const onResume = () => {
      recordLifecycle('page-resume', { wasActive: wasActiveBeforeHideRef.current });
      clientDiagnostic('recording_page_resume', {
        wasActive: wasActiveBeforeHideRef.current,
      });
      // Parallel #67 — same recovery toast as onShow(persisted=true).
      if (wasActiveBeforeHideRef.current === 'active') {
        wasActiveBeforeHideRef.current = 'idle';
        toast('Recording was suspended', {
          description: 'The browser paused the tab. Tap to restart.',
          duration: Infinity,
          action: {
            label: 'Restart',
            onClick: () => {
              const actions = lifecycleActionsRef.current;
              actions?.stop();
              setTimeout(() => actions?.pause(), 400);
            },
          },
        });
      }
    };
    // Network connectivity events (#64) — surfaced to the inspector as
    // a banner-style toast so a mid-session offline doesn't silently
    // break the WS retry ladder for an unbounded window. Recording
    // doesn't auto-pause on offline (the WS reconnect ladder handles
    // transient drops); the toast is purely UX so the inspector knows
    // why their dictation isn't being acknowledged.
    const onOnline = () => {
      clientDiagnostic('recording_network_online', { status: statusRef.current });
      if (statusRef.current === 'active' || statusRef.current === 'sleeping') {
        toast('Connection restored', {
          description: 'Recording will resume automatically.',
          duration: 3_000,
        });
      }
    };
    // Audio device-change observer (audit #15 + #5 + #6 + #7). iOS at
    // `AudioSessionManager.swift:138-166` handles Bluetooth pair/
    // unpair, headphone plug/unplug, and route-override by
    // re-activating the audio session and forcing speaker if no
    // input remains. PWA has no equivalent until this listener.
    // The fix is intentionally light: surface a toast offering manual
    // restart rather than auto-rebinding the mic stream. Auto-
    // rebinding loses ~500ms during getUserMedia → audio-worklet
    // re-wire which could clip a critical reading mid-dictation;
    // inspector judgement on whether the swap matters is safer.
    let lastDeviceChangeToastAt = 0;
    const onDeviceChange = () => {
      clientDiagnostic('recording_audio_devicechange', { status: statusRef.current });
      // Throttle: Bluetooth pair fires devicechange multiple times in
      // quick succession (device added, default route changed,
      // capabilities reported). One toast per 5s is enough.
      const now = Date.now();
      if (now - lastDeviceChangeToastAt < 5_000) return;
      lastDeviceChangeToastAt = now;
      if (statusRef.current === 'active') {
        toast('Audio device changed', {
          description:
            'A Bluetooth or headphone change may have affected recording. Tap to restart if needed.',
          duration: 8_000,
          action: {
            label: 'Restart',
            onClick: () => {
              const actions = lifecycleActionsRef.current;
              actions?.stop();
              setTimeout(() => actions?.pause(), 400);
            },
          },
        });
      }
    };
    const onOffline = () => {
      clientDiagnostic('recording_network_offline', { status: statusRef.current });
      if (statusRef.current === 'active' || statusRef.current === 'sleeping') {
        toast('No network connection', {
          description: 'Recording paused — Sonnet extraction unavailable until online.',
          duration: 10_000,
        });
      }
    };
    window.addEventListener('pageshow', onShow);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    }
    return () => {
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
      if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
        navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      }
      recordLifecycle('provider-unmount', {});
      clientDiagnostic('recording_provider_unmount', {});
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
  // Snapshot of the most recent persisted-recording-state slot. Updated
  // alongside `setState` for every transition so a WebContent-process
  // reap (iPad Safari) can be detected on the next mount and the
  // inspector offered a resume. The actual write to sessionStorage is
  // gated to 'active' / 'sleeping' transitions only — 'idle' / 'paused'
  // / 'error' / 'requesting-mic' clear the slot.
  const persistedSessionMetaRef = React.useRef<{
    clientSessionId: string;
    serverSessionId: string | null;
    jobId: string;
    certificateType: 'EICR' | 'EIC';
    startedAt: number;
  } | null>(null);
  const setState = React.useCallback((next: RecordingState) => {
    statusRef.current = next;
    setStateRaw(next);
    // Cross-reload session-resume persistence (audit-batch follow-up
    // for iPad Safari WebContent-process reap, 2026-05-17). Only
    // 'active' and 'sleeping' represent a recording the inspector
    // would WANT to resume after an autonomous reload — 'paused' is
    // intentional, 'error' is terminal, 'requesting-mic' / 'idle' are
    // not yet recording. Mirrors iOS where the
    // `DeepgramRecordingViewModel` only writes its restore-on-relaunch
    // sentinel when the inspector is actively dictating.
    const meta = persistedSessionMetaRef.current;
    if (meta && (next === 'active' || next === 'sleeping')) {
      persistRecordingState({
        clientSessionId: meta.clientSessionId,
        serverSessionId: meta.serverSessionId,
        jobId: meta.jobId,
        certificateType: meta.certificateType,
        status: next,
        startedAt: meta.startedAt,
        lastUpdatedAt: Date.now(),
      });
    } else if (next === 'idle') {
      // Explicit stop / unmount → clean up so a fresh mount tomorrow
      // doesn't see a stale "you were recording" entry from today.
      clearRecordingState();
      persistedSessionMetaRef.current = null;
    }
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

  // Cross-reload session-resume — fires ONCE on first mount with a
  // real job. Checks sessionStorage for a persisted snapshot left by
  // a previous instance of this provider (autonomous reload from
  // iPad Safari WebContent-process reap, manual refresh during
  // recording, etc.). If found AND within the 5-min Sonnet TTL AND
  // for the SAME job the inspector is currently viewing, surface a
  // sonner toast offering one-tap resume. Mirrors iOS's app-process
  // state-survival semantics — iOS's recording state survives
  // navigation-stack transitions but is gone after a full app kill;
  // this is the web analogue for "I was recording before the
  // process died, give me one tap to keep going". The
  // load-and-consume helper clears the slot on read so the toast
  // can't keep firing.
  const resumeCheckFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (resumeCheckFiredRef.current) return;
    if (!job?.id) return; // wait for job context to populate
    resumeCheckFiredRef.current = true;
    const persisted = loadAndConsumeRecordingState();
    if (!persisted) return;
    if (persisted.jobId !== job.id) {
      // The reload happened on a different job page — the inspector
      // already navigated. Don't auto-resume the old session here;
      // they can go back to that job and tap Start to mint a fresh
      // recording (the backend job state is preserved either way).
      clientDiagnostic('recording_resume_skipped_job_mismatch', {
        persistedJobId: persisted.jobId,
        currentJobId: job.id,
      });
      return;
    }
    clientDiagnostic('recording_resume_toast_offered', {
      clientSessionId: persisted.clientSessionId,
      serverSessionIdShort: persisted.serverSessionId?.slice(0, 16) ?? null,
      ageMs: Date.now() - persisted.lastUpdatedAt,
      priorStatus: persisted.status,
    });
    toast('Recording was interrupted', {
      description:
        'The page reloaded while recording. Tap to resume — Sonnet context is preserved for 5 minutes.',
      duration: Infinity,
      action: {
        label: 'Resume',
        onClick: () => {
          clientDiagnostic('recording_resume_tapped', {
            ageMs: Date.now() - persisted.lastUpdatedAt,
          });
          // Mirror iOS: tap-to-resume after an app process kill
          // mints a fresh recording session (backend job state is
          // preserved server-side, so the inspector keeps all
          // circuits + observations and just rebuilds the Sonnet
          // turn context from their next utterances).
          // Defer to next tick so the toast dismissal animation
          // doesn't race with start()'s mic-permission flow.
          setTimeout(() => {
            void lifecycleActionsRef.current?.start();
          }, 0);
        },
      },
    });
  }, [job?.id]);

  // L2 obs-photo sprint — pending tuple slot. Held in a ref because the
  // WS callback that drives `applyObservations` (Phase 3 reads this) and
  // the chrome button's onClick (Phase 5 writes this via
  // captureObservationPhoto) both need to see the *current* value
  // without depending on a re-render. iOS canon:
  // `DeepgramRecordingViewModel.swift:497`.
  const pendingPhotoRef = React.useRef<PendingObservationPhoto | null>(null);
  // Phase 6 — 60 s expiry timer. Fires once the auto-link window
  // plus a 10 s grace has elapsed for an unclaimed pending photo.
  // On fire: move the (already-uploaded) filename into
  // `job.unassigned_photos[]` so the inspector can recover it via
  // the From-Job picker on the observation edit sheet. iOS canon:
  // `DeepgramRecordingViewModel.swift:1564-1575`. Single timer slot
  // matches the single pending slot.
  const pendingPhotoTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Grace period added to the auto-link window so a pending record
  // rehydrated from IDB right at the boundary doesn't get flushed
  // by clock skew. iOS uses the same 60 s timer with no grace
  // because its timestamp lives in the same process; on PWA the
  // IDB record may have been written 60 s ago on a slightly-
  // different system clock, hence the 10 s pad. Sprint PLAN
  // §Risks §4.
  const PENDING_EXPIRY_GRACE_MS = 10_000;
  // Mirror of the LAST appended observation for the reverse-link path
  // in Phase 4's captureObservationPhoto. Updated by Phase 3's
  // `onLastObservationCreated` callback after a row appends — see the
  // applyExtractionToJob call site below. iOS canon: :499-500.
  const recentObservationRef = React.useRef<RecentObservationRef | null>(null);

  // Phase 6 — add a filename to `job.unassigned_photos[]`, deduping
  // against the existing pool. iOS canon: `JobViewModel.swift:510-525`
  // `addPhotosToUnassigned`. Used by (a) the rehydrate effect when an
  // expired IDB record carries a settled filename and (b) the expiry
  // timer below. No-op when `filename` is empty or already in the
  // pool.
  const moveToUnassignedPool = React.useCallback((filename: string | undefined) => {
    if (!filename) return;
    const currentJob = jobRef.current;
    if (!currentJob) return;
    const existing = currentJob.unassigned_photos ?? [];
    if (existing.includes(filename)) return;
    const next = [...existing, filename];
    updateJobRef.current({ unassigned_photos: next });
    jobRef.current = { ...currentJob, unassigned_photos: next };
    pipelineLog('observation_photo_moved_to_unassigned_pool', {
      filename,
      pool_size_after: next.length,
    });
  }, []);

  // Phase 6 — wrapper that writes pendingPhotoRef AND arms (or
  // cancels) the expiry timer in lockstep. Every consumer that
  // mutates the pending slot routes through this so the timer is
  // never orphaned. The capture-observation-photo orchestration's
  // `setPendingPhoto` dep below points at this same helper.
  const setPendingPhotoState = React.useCallback(
    (record: PendingObservationPhoto | null) => {
      pendingPhotoRef.current = record;
      if (pendingPhotoTimerRef.current != null) {
        clearTimeout(pendingPhotoTimerRef.current);
        pendingPhotoTimerRef.current = null;
      }
      if (!record) return;
      const elapsed = Date.now() - record.timestamp;
      const remaining = OBSERVATION_PHOTO_LINK_WINDOW_MS + PENDING_EXPIRY_GRACE_MS - elapsed;
      pendingPhotoTimerRef.current = setTimeout(
        () => {
          // Re-read at fire-time so a since-replaced or since-
          // cleared slot doesn't get inappropriately drained.
          const current = pendingPhotoRef.current;
          if (!current || current.blobId !== record.blobId) {
            return;
          }
          // The photo's bytes are already on S3 (the upload may
          // even have settled by now). Promote the filename into
          // the unassigned pool so the From-Job picker can surface
          // it — drop the slot regardless.
          moveToUnassignedPool(current.filename);
          pendingPhotoRef.current = null;
          const jobId = jobRef.current?.id;
          if (jobId) {
            void clearPendingPhoto(jobId);
          }
          pendingPhotoTimerRef.current = null;
        },
        Math.max(0, remaining)
      );
    },
    [moveToUnassignedPool]
  );

  // Rehydrate the pending tuple from IDB when the active job changes
  // (page reload or job switch). The 60 s + grace TTL is enforced
  // here: an expired record with a settled filename promotes into
  // the unassigned pool (Phase 6); an expired record without a
  // filename simply drops (the upload never settled, so there's
  // nothing in S3 to recover).
  React.useEffect(() => {
    const jobId = job?.id;
    if (!jobId) {
      setPendingPhotoState(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const record = await readPendingPhoto(jobId);
      if (cancelled) return;
      if (!record) {
        setPendingPhotoState(null);
        return;
      }
      const elapsed = Date.now() - record.timestamp;
      if (elapsed >= OBSERVATION_PHOTO_LINK_WINDOW_MS + PENDING_EXPIRY_GRACE_MS) {
        // Past TTL on rehydrate — same handling as the live timer.
        moveToUnassignedPool(record.filename);
        await clearPendingPhoto(jobId);
        setPendingPhotoState(null);
        return;
      }
      // Still within window — re-arm the timer for the remaining
      // duration. Phase 3 forward-link can still claim this tuple.
      setPendingPhotoState(record);
    })();
    return () => {
      cancelled = true;
    };
  }, [job?.id, setPendingPhotoState, moveToUnassignedPool]);

  // L2 obs-photo sprint Phase 4 — full capture handler. Resize on
  // device, upload, then either reverse-link (recent observation
  // within 60 s) or enter the pending slot. The orchestration lives
  // in `lib/recording/capture-observation-photo.ts` with injectable
  // deps so it can be unit-tested without a React tree. Here we just
  // adapt the recording-context refs / api-client / updateJob into
  // that contract. iOS canon: DeepgramRecordingViewModel.swift:1504-1591.
  const captureObservationPhoto = React.useCallback(
    async (file: File): Promise<void> => {
      // iOS isRecording gate (`:1505`). The button surface (Phase 5)
      // also enforces a `disabled={state !== 'active'}` but the
      // belt-and-brace check here covers programmatic invocations
      // (e.g. retry from a "Photo upload failed" toast).
      if (statusRef.current !== 'active') {
        pipelineLog('observation_photo_capture_skipped_not_recording', {
          status: statusRef.current,
        });
        return;
      }
      const userId = user?.id;
      const job = jobRef.current;
      if (!userId || !job?.id) {
        pipelineLog('observation_photo_capture_skipped_no_context', {
          has_user: Boolean(userId),
          has_job: Boolean(job?.id),
        });
        return;
      }
      await runCaptureObservationPhoto({
        userId,
        jobId: job.id,
        file,
        resize: (blob) => resizeImage(blob),
        uploadPhoto: async (uid, jid, blob) => {
          const response = await api.uploadObservationPhoto(uid, jid, blob);
          return { filename: response.photo.filename };
        },
        generateBlobId: () =>
          globalThis.crypto?.randomUUID?.() ?? `obs-photo-${Date.now()}-${Math.random()}`,
        now: () => Date.now(),
        writePendingPhoto,
        clearPendingPhoto,
        getRecentObservation: () => recentObservationRef.current,
        clearRecentObservation: () => {
          recentObservationRef.current = null;
        },
        getPendingPhoto: () => pendingPhotoRef.current,
        setPendingPhoto: setPendingPhotoState,
        getJob: () => jobRef.current ?? null,
        applyJobPatch: (patch) => {
          updateJobRef.current(patch);
          jobRef.current = {
            ...jobRef.current,
            ...(patch as Partial<typeof jobRef.current>),
          };
        },
        onError: (err) => {
          toast.error('Photo upload failed', {
            description: err.message,
          });
        },
        log: (event, payload) => pipelineLog(event, payload),
      });
    },
    [user?.id]
  );

  // Bug K (2026-05-11) — pending-naming utterance buffer. Holds at most
  // one Deepgram final whose text trailing-matches "Circuit N is" with
  // no completion. The setTimeout id lives alongside so a follow-up
  // final can cancel it cleanly. See TRAILING_CIRCUIT_NAMING_PATTERN
  // for the trigger shape and the full rationale.
  const pendingNamingBufferRef = React.useRef<{
    text: string;
    confidence: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  // Observation regression (2026-05-13, session sess_mp4jg2mt_231n) —
  // burst buffer. Holds every Deepgram final for 500ms before shipping
  // to Sonnet; if a second final arrives in that window, concat with
  // ' ... ' (server's legacy batching separator) and dispatch as one
  // turn. Symptom this fixes: "Observation." then "There is a crack in
  // a socket in a bedroom." arriving 1.3s apart (close to but past the
  // 500ms window). Sonnet only saw "Observation." in turn-3 and asked
  // "What's the observation?" with reason=missing_context — the
  // description was still queued for turn-4. The backend dispatcher
  // (sonnet-stream.js handleTranscript) processes one transcript at a
  // time with no batching; this is the legacy eicr-extraction-session
  // BATCH_SIZE=2 / BATCH_TIMEOUT_MS=2000 contract resurrected as a
  // client-side layer so iOS isn't affected.
  const burstBufferRef = React.useRef<{
    text: string;
    confidence: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  // Synchronous mirror of `questions`. Bug L (2026-05-11) — the dedup logic
  // in onQuestion used to live inside the setQuestions reducer, so dedup
  // and the `isNew`/`queueDepthAfter` outputs all depended on the reducer
  // committing. In a double-mount / Suspense-retry scenario (the audit
  // doc's open item "double-`provider-mount` 12 ms apart"), the setter
  // can belong to a fiber that never commits — React silently drops the
  // update, the reducer never runs, `isNew` stays at its `false` init
  // value, and the else-branch logs a phantom `dedup_hit` on a queue that
  // was actually empty. The TTS playback decision (which reads `isNew`)
  // also goes to the skip branch, so the inspector hears nothing for the
  // very first ask of the session. Pinned by sess_mp19b6tf_i5xc 13:48:48
  // UTC: first ask, `isNew:false, queueDepth:0, reason:dedup_hit` — a
  // combination [].some(...) cannot produce from a single reducer call.
  // The ref decouples dedup from React's commit lifecycle.
  const questionsRef = React.useRef<SonnetQuestion[]>([]);
  React.useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);

  // ── Audio pipeline ──────────────────────────────────────────────────────
  // Mic capture handle + elapsed/cost ticker. The mic handle owns the
  // AudioContext and Worklet; we keep it in a ref so `stop()` can tear it
  // down without tripping React's effect dependency machinery.
  const micRef = React.useRef<MicCaptureHandle | null>(null);
  const deepgramRef = React.useRef<DeepgramService | null>(null);
  // STT model resolved ONCE per RECORDING session by the runtime kill-switch
  // (parity WS4). Set in start() after the runtime-config fetch; read by
  // openDeepgram when constructing DeepgramService. Auto-sleep wake/resume
  // reconnects reuse this ref and MUST NOT refetch mid-recording; stop()
  // clears it so the next start() re-reads the ECS env (picking up an
  // emergency flip). null → not yet resolved → openDeepgram falls to
  // DEFAULT_STT_MODEL.
  const activeSttModelRef = React.useRef<SttModel | null>(null);
  const sonnetRef = React.useRef<SonnetSession | null>(null);
  // Debounced job-state push. iOS calls
  // `sonnetSession.sendJobStateUpdate(job)` after every applied
  // extraction / circuit_created / circuit_updated / field_corrected /
  // observation_update / observation_deleted so the backend's per-
  // session Sonnet snapshot stays in lock-step with the client's
  // mutated job. Without this, the server-side `stateSnapshot` Sonnet
  // reads on the NEXT turn is stale — circuits the inspector just
  // dictated aren't visible to subsequent reasoning, producing
  // spurious re-asks and duplicate `create_circuit` calls.
  // PWA pre-fix never called the method (the helper existed at
  // `sonnet-session.ts:871` but had zero callers); the H6 audit
  // 2026-05-12 surfaced this as the highest-impact gap. Debounced
  // (120ms) so a burst of three consecutive applies in the same React
  // tick coalesces into one wire frame.
  const pushJobStateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePushJobState = React.useCallback(() => {
    if (pushJobStateTimerRef.current) {
      clearTimeout(pushJobStateTimerRef.current);
    }
    pushJobStateTimerRef.current = setTimeout(() => {
      pushJobStateTimerRef.current = null;
      const session = sonnetRef.current;
      if (!session) return;
      try {
        session.sendJobStateUpdate(jobRef.current);
        pipelineLog('sonnet_job_state_pushed', {
          circuits: Array.isArray(jobRef.current.circuits) ? jobRef.current.circuits.length : 0,
          boards: Array.isArray(jobRef.current.boards) ? jobRef.current.boards.length : 0,
          observations: Array.isArray(jobRef.current.observations)
            ? jobRef.current.observations.length
            : 0,
        });
      } catch (err) {
        pipelineLog('sonnet_job_state_push_threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 120);
  }, []);
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
  // H1+H2 — active-board state, driven by `current_board_changed`
  // broadcasts. Exposed through the recording context so Board /
  // Circuits / banner consumers can filter to the active board
  // without separately decoding the WS message.
  const [currentBoardId, setCurrentBoardId] = React.useState<string | null>(null);
  const tickRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // 5-second heartbeat — pinpoints "did the JS event loop freeze" without
  // needing the WS to be alive. Each fire writes `pipelineLog('heartbeat',
  // {seq})` which lands in the in-browser ring + localStorage tail (always)
  // and the CloudWatch WS sink (when up). If the renderer is suspended by
  // iPad Safari (the b2 hypothesis from sess_mp7yyt76_lm4o, 2026-05-16),
  // the seq monotonicity breaks the instant the event loop stops dispatching
  // — the local ring captures the last live seq + timestamp, and a gap >5s
  // until any other event proves the freeze. Inspector exports via
  // /settings/diagnostics; on next reconnect the new pendingDiagnostics
  // buffer (commit 897dc51) drains the post-freeze heartbeats back to
  // CloudWatch with `replayed_from_pending: true` so the gap is queryable.
  const heartbeatIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatSeqRef = React.useRef(0);
  // TTS PCM gate — iOS parity for the freeze-trigger documented in
  // sess_mp9ep221_62n8 post-mortem (2026-05-17). Held true while
  // ElevenLabs playback is in flight; the mic-onSamples callback below
  // (~line 1765) early-returns when this is true, mirroring iOS's
  // `DeepgramService.pauseAudioStream()` (DeepgramService.swift:566).
  // Skips resample + ringBuffer.write + Deepgram.sendSamples + Silero
  // dispatch — three main-thread workloads that otherwise compete with
  // iPad Safari's audio decode during foreground playback. The
  // resume timer mirrors iOS's 500ms post-TTS drain window.
  const ttsActiveRef = React.useRef(false);
  const ttsResumeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Amplitude-based barge-in was attempted in commits cc4082e (initial)
  // and aca3327 (cooldown latch) but is fundamentally incompatible with
  // the web platform: on iOS the AVAudioSession voice-processing mode
  // provides hardware-grade acoustic echo cancellation, so the speaker
  // output of the TTS itself doesn't reach the mic input as audible
  // amplitude. On the web `getUserMedia({echoCancellation: true})` is
  // best-effort browser-side processing — the TTS audio bleeds through
  // and the amplitude detector trips on its own speaker output, killing
  // every TTS within milliseconds of `elevenlabs_audio_playing`. Field-
  // tested sess_mpathxlt_uwth (2026-05-18 06:22-06:27 UTC) showed all 6
  // TTS rounds barging themselves in inside 0-60ms.
  //
  // Barge-in on the web is delegated to the text-final-during-TTS path
  // in `dispatchFinal` (real Deepgram transcript words during an
  // in-flight ask_user → cancelSpeech + sendBargeIn). Deepgram's
  // server-side VAD is robust against the echo this client-side
  // amplitude check trips on.
  // Inspector-speaking tracker — mirrors iOS `isSpeaking` flag at
  // `DeepgramRecordingViewModel.swift:1607-1623`. Flipped TRUE on every
  // interim transcript (the inspector is mid-utterance); flipped FALSE
  // on `onUtteranceEnd`. Used by the deferred-TTS path so a Sonnet
  // question whose audio arrives mid-sentence doesn't talk over the
  // inspector. The phantom-VAD watchdog at `speechConfirmTimerRef`
  // flips it back to false if `onSpeechStarted` fires without any
  // subsequent interim (1.2s window) — guards against ambient breath /
  // van rumble triggering a permanent "speaking" stuck state.
  const isInspectorSpeakingRef = React.useRef(false);
  const speechConfirmTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpeechStartedTimeRef = React.useRef<number | null>(null);
  // Deferred-TTS slot — when `speakOrDefer` is called while
  // `isInspectorSpeakingRef.current === true`, the utterance is
  // stashed here instead of speaking over the inspector. Drained on
  // `onUtteranceEnd`. Single-slot (last-wins) so a backlog can't form;
  // the iOS canon at `AlertManager.swift:1144-1179` is similarly
  // single-slot. Cleared on session teardown.
  const deferredTtsRef = React.useRef<{ text: string; toolCallId: string | null } | null>(null);
  // In-flight TTS question tracker — single source of truth for the
  // `in_response_to` payload attached to outbound transcript frames.
  // Mirrors iOS DeepgramRecordingViewModel.swift:2474-2900 (the
  // InFlightQuestion slot + FIFO + takeInResponseToPayload). Enqueued
  // when `onQuestion` fires, promoted to the active slot on TTS-start,
  // re-anchored on TTS-end (Fix 2 — count the 10s stale window from when
  // the inspector could physically reply), consumed on dispatch.
  // Pre-fix the PWA had no equivalent, so backend
  // sonnet-stream.js:3193-3243 never saw the question context and bare
  // replies like "yes"/"no"/"code 2" lost attribution.
  const inFlightQuestionRef = React.useRef(new InFlightQuestionTracker());
  // Stamps the most-recent text passed to `speak()`. The TTS lifecycle
  // observer (event: 'start' | 'end') doesn't carry the spoken text,
  // but the in-flight tracker matches FIFO entries by exact question
  // text — we need to bridge those. The `speak` callback below shadows
  // the renamed `speakRaw` import so existing call sites in this file
  // stay unchanged and every spoken text lands here.
  const lastSpokenTextRef = React.useRef<string | null>(null);
  // Wrap the raw TTS so every spoken text is captured for the
  // TTS lifecycle observer (which only gets 'start' | 'end' events, no
  // text). The InFlightQuestionTracker matches FIFO entries by exact
  // question text, so the observer needs to know what's playing.
  // Naming: `speak` shadows the renamed import (`speakRaw`) so existing
  // call sites elsewhere in this file continue to work unchanged.
  const speak = React.useCallback((text: string, options?: SpeakOptions) => {
    lastSpokenTextRef.current = text;
    speakRaw(text, options);
  }, []);
  // Token-paired tracker for the currently-live DIRECT prompt (ask_user /
  // drained deferred prompt). Set by `speakDirectPrompt` at dispatch, cleared
  // on the prompt's terminal (token-guarded so a superseding prompt's stale
  // terminal can't clear the newer one's ref). Read by `handleCancelPendingTts`
  // to silence an in-flight script prompt — active from DISPATCH (before audio)
  // until terminal, NOT gated on the audio window.
  const activeDirectPromptToolCallIdRef = React.useRef<{
    toolCallId: string | null;
    token: symbol;
  } | null>(null);
  // The ONE direct-prompt dispatch site (immediate onQuestion branch AND the
  // deferred-drain). Sets the cancellable ref/token, then `speak()` (which
  // preempts the confirmation FIFO and sets the tts.ts 'direct' owner
  // transitively). On terminal, clears the ref (token-guarded) FIRST, THEN
  // resumes any confirmation head parked behind the prompt — order is
  // load-bearing (a resume while the owner is still 'direct' re-defers and
  // strands the head forever).
  const speakDirectPrompt = React.useCallback(
    (text: string, toolCallId: string | null) => {
      const token = Symbol('direct-prompt');
      activeDirectPromptToolCallIdRef.current = { toolCallId, token };
      const clearRefIfMine = () => {
        if (activeDirectPromptToolCallIdRef.current?.token === token) {
          activeDirectPromptToolCallIdRef.current = null;
        }
      };
      speak(text, {
        onEnd: () => {
          clearRefIfMine();
          ttsQueueResumeIfDeferred();
        },
        onError: () => {
          clearRefIfMine();
          ttsQueueResumeIfDeferred();
        },
      });
    },
    [speak]
  );
  // Shared "inspector finished a sentence" resume — called from BOTH
  // speaking-ended sites (`onUtteranceEnd` AND the phantom `speechConfirmTimer`
  // reset). Drains the deferred DIRECT prompt (Symptom-2b fix) AND releases a
  // deferred CONFIRMATION head (its Symptom-2b clone). Idempotent — safe if
  // both sites fire for the same utterance.
  const onInspectorStoppedSpeaking = React.useCallback(() => {
    handleInspectorStoppedSpeaking({
      deferredTtsRef,
      speakDirectPrompt,
      resumeIfDeferred: ttsQueueResumeIfDeferred,
    });
  }, [speakDirectPrompt]);
  // D4 — pending-readings buffer. iOS canon
  // `TranscriptProcessor.swift:52-287` + `askAboutPendingReadings` at
  // `DeepgramRecordingViewModel.swift:5417`. When Sonnet returns a
  // reading with circuit<1 (orphan — inspector said the value without
  // a circuit ref), buffer for 2 s and re-ask "Which circuit was that
  // <name> <value> for?". Pre-fix the PWA silently dropped orphans at
  // `apply-extraction.ts:588`, leaving the inspector to re-state.
  //
  // The timeout callback uses the same `speak` wrapper (which stamps
  // lastSpokenTextRef) + `inFlightQuestionRef.enqueue` so the
  // inspector's reply gets in_response_to context for Sonnet to apply
  // the buffered values to the named circuit. iOS-canon snapshot
  // resolution (`snapshotForQuestion` + apply-to-circuit-on-reply) is
  // a follow-up — for MVP the standard Sonnet round-trip with
  // in_response_to context lands the answer.
  const pendingReadingsBufferRef = React.useRef<PendingReadingsBuffer | null>(null);
  // D6 — per-session dedup set for Sonnet confirmations. iOS canon
  // `DeepgramRecordingViewModel.swift:303` `confirmedFieldKeys: Set<String>`
  // reset at line 799 on session start. Keyed by `<field>_<circuit>` so a
  // repeated overwrite of the same field+circuit pair doesn't re-announce
  // (a turn that re-extracts the same Zs reading on the same circuit
  // shouldn't TTS "Updated Zs to 0.42" twice). Field/circuit nulls fold
  // into the key as 'unknown'/'none' to match iOS line 3307.
  const confirmedFieldKeysRef = React.useRef<Set<string>>(new Set());
  if (pendingReadingsBufferRef.current === null) {
    pendingReadingsBufferRef.current = new PendingReadingsBuffer((readings) => {
      const buffer = pendingReadingsBufferRef.current;
      if (!buffer) return;
      const question = buildPendingReadingsQuestion(readings);
      if (!question) return;
      buffer.snapshotForQuestion();
      clientDiagnostic('pending_readings_ask', {
        count: readings.length,
        fieldsPreview: readings
          .map((r) => r.field)
          .slice(0, 5)
          .join(','),
      });
      // Anchor the re-ask in the in-flight tracker so the inspector's
      // reply ("circuit 3", "second one") carries in_response_to
      // context. type "circuit_disambiguation" matches iOS canon.
      inFlightQuestionRef.current.enqueue({
        type: 'circuit_disambiguation',
        question,
        field: readings[0]?.field ?? null,
      });
      playAttentionTone();
      speak(question);
    });
  }
  // Post-wake transcript monitor — mirrors iOS
  // `RecordingSessionCoordinator.swift:530-577 monitorPostWakeTranscript`.
  // 15s after sleep→active wake, if no final has arrived AND no
  // SpeechStarted fired post-wake (the inspector might be mid-sentence
  // when we wake), speak "Sorry, could you repeat that?". Cancelled by
  // the next final via `onSpeechActivity`. The `wakeTimeRef` snapshot
  // is what we compare `lastSpeechStartedTimeRef` against so a
  // pre-wake SpeechStarted doesn't suppress the prompt.
  const postWakeMonitorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeTimeRef = React.useRef<number | null>(null);
  // Post-wake monitor cadence: 15s after wake before the
  // "could you repeat that" prompt fires. Matches iOS at
  // `RecordingSessionCoordinator.swift:530`. Longer = inspector waits
  // in silence; shorter = false-positive prompts during natural pauses.
  const POST_WAKE_MONITOR_MS = 15_000;
  // Phantom-VAD watchdog: a `SpeechStarted` with no follow-up interim
  // within 1.2s is ambient noise, not the inspector. Same value iOS
  // uses at `DeepgramRecordingViewModel.swift:1620-1623`.
  const SPEECH_CONFIRM_TIMEOUT_MS = 1200;
  // Lifecycle action ref — populated below once `pause` / `stop` are
  // defined. Lets the lifecycle effect (which mounts ONCE on provider
  // mount, before those callbacks exist) reach back into the latest
  // pause/stop functions. The `wasActiveBeforeHideRef` snapshot
  // captures whether recording was live at the moment the page went
  // hidden — used on resume to decide if the inspector needs a
  // recovery toast.
  const lifecycleActionsRef = React.useRef<{
    pause: () => void;
    stop: () => void;
    start: () => Promise<void> | void;
    statusAtHide: RecordingState;
  } | null>(null);
  const wasActiveBeforeHideRef = React.useRef<RecordingState>('idle');
  const lastVisibilityHiddenAtRef = React.useRef<number | null>(null);
  // BFCache window threshold — if the tab was hidden longer than this
  // and we observe the WS sockets disconnected on return, we surface
  // the recovery toast rather than just logging. iPad Safari typically
  // BFCaches after 30-60s of foreground inactivity, so 30s catches the
  // common case without nagging the inspector for brief app-switches.
  const VISIBILITY_HIDDEN_RECOVERY_THRESHOLD_MS = 30_000;
  // Throttle setMicLevel to ~60Hz — audio callbacks fire every ~8ms at
  // 16kHz/128 samples which is overkill for a VU meter and would flood
  // React with renders.
  const lastLevelPushRef = React.useRef(0);

  const clearTick = React.useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    heartbeatIntervalRef.current = null;
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
    // 5s heartbeat shares the same start/stop lifetime as the cost timer
    // (only fires while a session is live). seq counter is monotonic for
    // the whole tab lifetime — NOT reset between sessions — so a freeze-
    // then-fresh-session can be correlated even across reload boundaries
    // via localStorage. Reset on session_stop would defeat that.
    heartbeatIntervalRef.current = setInterval(() => {
      const seq = heartbeatSeqRef.current++;
      pipelineLog('heartbeat', { seq });
    }, HEARTBEAT_INTERVAL_MS);
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
    // Clear the TTS PCM gate so a stale `ttsActiveRef = true` doesn't
    // outlive the recording session. If recording stops with TTS still
    // in flight, the lifecycle observer's pending 500ms resume timer
    // would fire AFTER teardown and call `resume()` on a null
    // `deepgramRef`. The gate flag itself is also reset so a future
    // session that starts before the timer fires won't inherit a
    // muted state.
    if (ttsResumeTimerRef.current) {
      clearTimeout(ttsResumeTimerRef.current);
      ttsResumeTimerRef.current = null;
    }
    ttsActiveRef.current = false;
    // Reset inspector-speaking + deferred-TTS state. A session that
    // teardown'd mid-utterance would otherwise leak `isInspectorSpeaking
    // = true` into the next session and silently defer its first TTS.
    isInspectorSpeakingRef.current = false;
    lastSpeechStartedTimeRef.current = null;
    deferredTtsRef.current = null;
    if (speechConfirmTimerRef.current) {
      clearTimeout(speechConfirmTimerRef.current);
      speechConfirmTimerRef.current = null;
    }
    if (postWakeMonitorTimerRef.current) {
      clearTimeout(postWakeMonitorTimerRef.current);
      postWakeMonitorTimerRef.current = null;
    }
    // Bug K — drop any pending naming-buffer timer so the deferred
    // dispatchFinal doesn't fire after the Sonnet WS is gone (which
    // would NPE on sonnetRef.current?.sendTranscript inside a logged
    // dispatch). Buffered text is discarded silently — by the time
    // the user stops the session, holding "Circuit N is" for a
    // never-arriving completion is correct.
    if (pendingNamingBufferRef.current) {
      clearTimeout(pendingNamingBufferRef.current.timer);
      pendingNamingBufferRef.current = null;
    }
    if (burstBufferRef.current) {
      clearTimeout(burstBufferRef.current.timer);
      burstBufferRef.current = null;
    }
  }, []);

  const teardownSonnet = React.useCallback(() => {
    sonnetRef.current?.disconnect();
    sonnetRef.current = null;
    setDiagnosticSink(null);
    setSonnetState('disconnected');
    // Cancel any pending debounced job-state push so a late-firing
    // timer doesn't try to send through the now-null session.
    if (pushJobStateTimerRef.current) {
      clearTimeout(pushJobStateTimerRef.current);
      pushJobStateTimerRef.current = null;
    }
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
  // live (route change, hot reload). Audit #61 (2026-05-17) flagged
  // that pre-fix this missed `cancelSpeech()` and
  // `setTtsLifecycleObserver(null)` from the explicit `stop()` path —
  // a route change mid-TTS would leave ElevenLabs audio playing past
  // unmount, and the lifecycle observer (pointing at functions
  // captured in the dead provider's closure) would fire on a freshly
  // mounted provider with stale data. Add both calls here so unmount
  // is symmetric with stop().
  React.useEffect(() => {
    return () => {
      clearTick();
      teardownMic();
      teardownDeepgram();
      teardownSonnet();
      teardownSleep();
      cancelSpeech();
      setTtsLifecycleObserver(null);
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

      // Bug K (2026-05-11) — extracted dispatch helper. The
      // pending-naming buffer above needs to flush a held final
      // either when a follow-up final arrives (the normal path,
      // already inline) OR when the 3 s timeout fires (the timer
      // closure below). Both routes call `dispatchFinal`. Defined
      // inside openDeepgram so it captures the same refs the inline
      // path uses; reconstructed each Deepgram-session open, which
      // matches when those refs are valid.
      //
      // dispatchFinalBurstBuffered (2026-05-13 observation regression)
      // wraps dispatchFinal with a 500ms hold so consecutive Deepgram
      // finals can be merged into one Sonnet turn. Existing call sites
      // route through this wrapper, not dispatchFinal directly. The
      // dispatchFinal closure stays unchanged so the actual send path
      // is one definition.
      const dispatchFinalBurstBuffered = (text: string, confidence: number) => {
        const pending = burstBufferRef.current;
        if (pending) {
          // Second final arrived inside the window — merge and fire
          // immediately. ' ... ' separator mirrors the server's legacy
          // batching (eicr-extraction-session.js
          // _processUtteranceBatch, line 1440) so the on-wire shape is
          // familiar to Sonnet.
          clearTimeout(pending.timer);
          burstBufferRef.current = null;
          const combinedText = `${pending.text} ... ${text}`;
          const combinedConfidence = Math.min(pending.confidence, confidence);
          clientDiagnostic('pipeline_burst_buffer_concat', {
            bufferedPreview: pending.text.slice(0, 40),
            followUpPreview: text.slice(0, 40),
            combinedPreview: combinedText.slice(0, 80),
            combinedLength: combinedText.length,
          });
          dispatchFinal(combinedText, combinedConfidence);
          return;
        }
        const timer = setTimeout(() => {
          const buffered = burstBufferRef.current;
          if (!buffered || buffered.timer !== timer) {
            // A fresher timer has armed in the meantime, or
            // teardownDeepgram cleared the slot. Drop the stale fire.
            return;
          }
          burstBufferRef.current = null;
          clientDiagnostic('pipeline_burst_buffer_timeout', {
            textPreview: buffered.text.slice(0, 80),
            timeoutMs: BURST_BUFFER_TIMEOUT_MS,
          });
          dispatchFinal(buffered.text, buffered.confidence);
        }, BURST_BUFFER_TIMEOUT_MS);
        burstBufferRef.current = { text, confidence, timer };
        clientDiagnostic('pipeline_burst_buffer_armed', {
          textPreview: text.slice(0, 80),
          timeoutMs: BURST_BUFFER_TIMEOUT_MS,
        });
      };

      const dispatchFinal = (rawText: string, confidence: number) => {
        // iOS canon (DeepgramRecordingViewModel.swift:1798): normalise
        // BEFORE every downstream pass. The web pipeline previously called
        // `normaliseTranscriptText(text)` only inside the regex-hints
        // branch, so the cumulative buffer + matcher saw normalised text
        // but Sonnet saw the raw Deepgram output. That gap surfaced as
        // sess_mp7yyt76_lm4o (2026-05-16): inspector answered Sonnet's
        // "Which circuit is the Zs of 0.65 for?" with the word "Second"
        // (Deepgram-recurring mis-hearing of "circuit", per Swift docblock
        // for `MISHEARED_CIRCUIT_PATTERN`). The web normaliser already
        // rewrites `\bsecond\b → circuit` (number-normaliser.ts:138) but
        // that rewrite never reached Sonnet because the send used `text`,
        // not `normalised`. Now the normalised string flows through every
        // path: local transcript display (parity with iOS line 1923),
        // voice-command parsing, cumulative regex buffer, sendTranscript,
        // and sendAskUserAnswered. The diagnostic `pipeline_text_normalised`
        // surfaces in CloudWatch whenever the substitution changed
        // anything, so the next session lets us verify "second" → "circuit"
        // actually fired.
        const text = normaliseTranscriptText(rawText);
        if (text !== rawText) {
          clientDiagnostic('pipeline_text_normalised', {
            rawPreview: rawText.slice(0, 80),
            normalisedPreview: text.slice(0, 80),
          });
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
          const outcome = applyVoiceCommand(command, jobRef.current as unknown as VoiceCommandJob);
          if (outcome.patch) {
            updateJobRef.current(outcome.patch);
            jobRef.current = {
              ...jobRef.current,
              ...(outcome.patch as Partial<typeof jobRef.current>),
            };
            if (outcome.changedKeys && outcome.changedKeys.length > 0) {
              liveFill.markUpdated(outcome.changedKeys);
            }
          }
          if (outcome.response) {
            if (outcome.patch) playConfirmationChime();
            speak(outcome.response);
          }
          sleepManagerRef.current?.onSpeechActivity();
          return;
        }
        const utteranceId =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        // WS3 item 7 (2026-07-02) — the in-flight-ask signal is computed
        // FIRST via a NON-consuming peek. It feeds BOTH (a) the regex
        // skip below (which guards the sess_mp79tvcj_6prk 2026-05-15
        // regression and MUST keep receiving the signal) and (b) the
        // transcript gate's hasPendingAsk input. Consumption of the
        // tool_call_id happens only on the gate-PASS path immediately
        // before the send — a gate REJECT must not burn ask state.
        const peekedToolCallId = sonnetRef.current?.peekInFlightToolCallId() ?? null;
        const isAnswerToAsk = Boolean(peekedToolCallId);
        let regexResults: RegexResultsWire | undefined = undefined;
        // Flag-independent match-presence signal for the gate: a
        // regex-matchable reading must never be silently gate-rejected in
        // a build where the HINTS flag is off (the flag gates hint
        // APPLICATION, not reading detection — prod sets it to 1 via
        // deploy.yml, but local/dev/test builds don't).
        let gateRegexHit = false;
        const regexHintsEnabled = process.env.NEXT_PUBLIC_REGEX_HINTS_ENABLED === '1';
        console.info(
          `[recording:pipeline] stage=regex enabled=${regexHintsEnabled} matcher=${Boolean(regexMatcherRef.current)} tracker=${Boolean(fieldSourceTrackerRef.current)}`
        );
        // Skip the regex pass entirely when this transcript is the answer
        // to an in-flight ask_user. Codex review of sess_mp79tvcj_6prk
        // (2026-05-15) flagged this: when the inspector said "It's a 100
        // amp." in response to "What's the BS standard?", the cumulative
        // matcher ran on the answer text + 30s of prior dialogue and
        // wrote `board.main_switch_bs_en` (it had matched the digit-run
        // "100" via the BS-EN pattern), competing with Sonnet's correct
        // `record_board_reading{field:"main_switch_current"}` extraction
        // that landed shortly after. Sonnet is the authority for ask_user
        // answers — it has the context_field, the question, and the
        // 5-min Anthropic-cached conversation tail. The regex shouldn't
        // race it. Also avoid extending `cumulativeTranscriptRef` so
        // subsequent utterances don't inherit the answer's text in their
        // sliding-match window (Sonnet wrote the value; the matcher
        // should remain unaware). When the regex pass is skipped for an
        // ask-answer, gateRegexHit stays false and the gate passes via
        // hasPendingAsk instead.
        if (regexMatcherRef.current && fieldSourceTrackerRef.current && !isAnswerToAsk) {
          // `text` is already normalised at the top of dispatchFinal; no
          // need to re-run normaliseTranscriptText. The matcher does its
          // OWN internal normalisation (transcript-field-matcher.ts:958
          // — normaliseBeforeMatch + normalizeTranscript) on the sliding
          // window so the cumulative buffer can stay in the same form
          // the matcher expects.
          cumulativeTranscriptRef.current += (cumulativeTranscriptRef.current ? ' ' : '') + text;
          const matchResult = regexMatcherRef.current.match(
            cumulativeTranscriptRef.current,
            jobRef.current
          );
          if (regexHintsEnabled) {
            const applied = applyRegexMatchToJob(
              jobRef.current,
              matchResult,
              fieldSourceTrackerRef.current
            );
            console.info(
              `[recording:pipeline] stage=regex_applied changedKeys=${applied?.changedKeys.length ?? 0} keys=${(applied?.changedKeys ?? []).slice(0, 5).join(',')}`
            );
            clientDiagnostic('pipeline_regex_applied', {
              normalisedPreview: text.slice(0, 80),
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
            gateRegexHit = Array.isArray(regexResults) && regexResults.length > 0;
          } else {
            // HINTS flag off (local/dev/test): the matcher still ran for
            // gate purposes — nothing is applied and no hints are sent,
            // but a matchable reading must still count as a regex hit so
            // the gate can't reject it.
            gateRegexHit = !isEmptyResult(matchResult);
          }
        } else if (regexMatcherRef.current && isAnswerToAsk) {
          clientDiagnostic('pipeline_regex_skipped_ask_answer', {
            toolCallIdShort: peekedToolCallId?.slice(0, 12) ?? null,
            textPreview: text.slice(0, 80),
          });
        }
        // ── WS3 item 7 — client-side transcript forward-gate ─────────────
        // Literal port of iOS TranscriptGate.shouldForward, inserted at
        // the same point in the pipeline: after the voice-command
        // short-circuit + regex pass, immediately before the send. The
        // audible contract: chime = "received and committed to
        // processing"; silence = "heard but won't extract, carry on".
        //
        // Gate inputs are NON-MUTATING peeks: `peekedToolCallId` (Stage 6
        // ask, peeked above) and `peekPayloadForTranscript()` (legacy
        // in_response_to slot with the same stale-window test as
        // takePayload but no burn/clear). Raw peekSlot() would be wrong
        // here — it has no stale-window check, so a stale TTS question
        // could force a PASS, chime, then send with a null payload.
        // iOS-canon consequence: a non-expired pending ask or a valid
        // in_response_to payload is a gate-PASS by definition.
        const peekedPayload = inFlightQuestionRef.current.peekPayloadForTranscript();
        const gatePassed = shouldForward({
          text,
          hasRegexHit: gateRegexHit,
          hasPendingAsk: isAnswerToAsk,
          inResponseTo: peekedPayload != null,
        });
        if (!gatePassed) {
          // REJECT: no chime, no send, no ask-state consumption, no
          // processing-count increment (the counter is decremented solely
          // by Sonnet response/error frames — a reject produces no server
          // round-trip, so an increment here would stick the indicator on
          // permanently). Housekeeping: clear ONLY an EXPIRED question
          // slot; valid ask state is consumed exclusively on the PASS
          // path after the send.
          inFlightQuestionRef.current.clearExpiredSlot();
          console.info(
            `[recording:pipeline] stage=transcript_gate_blocked text="${text.slice(0, 60)}"`
          );
          clientDiagnostic('transcript_gate_blocked', {
            textPreview: text.slice(0, 80),
            hadRegexHit: gateRegexHit,
          });
          sleepManagerRef.current?.onSpeechActivity();
          return;
        }
        // PASS: consume the Stage 6 tool_call_id (peeked earlier) — the
        // consume/peek pair is race-free inside this synchronous block.
        const inFlightToolCallId = sonnetRef.current?.consumeInFlightToolCallId() ?? null;
        console.info(
          `[recording:pipeline] stage=sonnet_send utteranceId=${utteranceId.slice(0, 8)} inFlightToolCallId=${inFlightToolCallId?.slice(0, 12) ?? 'none'} regexHints=${regexResults?.length ?? 0}`
        );
        clientDiagnostic('pipeline_sonnet_send', {
          textPreview: text.slice(0, 80),
          utteranceIdShort: utteranceId.slice(0, 12),
          hasInFlightAsk: Boolean(inFlightToolCallId),
          regexHintsCount: regexResults?.length ?? 0,
        });
        // iOS canon DeepgramRecordingViewModel.swift:2122 — attach
        // `in_response_to` when a TTS question is alive within the 10 s
        // stale window. takePayload() also burns the slot on substantive
        // transcripts so noise (uh, cough) doesn't drop the real reply.
        //
        // Branch parity with iOS: when a Stage 6 ask is being answered
        // (inFlightToolCallId set), the wire-canonical path is
        // ask_user_answered — the legacy in_response_to annotation is
        // suppressed to avoid double-attribution
        // (DeepgramRecordingViewModel.swift:1955-1964). We still call
        // takePayload to drain the slot so it can't mis-attach to the
        // NEXT unrelated transcript.
        const drainedPayload = inFlightQuestionRef.current.takePayload(text);
        const inResponseTo = inFlightToolCallId ? undefined : (drainedPayload ?? undefined);
        // Gate-pass chime — iOS chimes on BOTH branches (stage6_ask_answer
        // and legacy_free_text) before the send; TranscriptGate.playChime
        // parity.
        //
        // WS7 haptic parity: iOS DeepgramRecordingViewModel.playChime()
        // fires a heavy UIImpactFeedbackGenerator alongside the chime, so
        // the inspector feels the "sent for processing" beat in AirPods-only
        // hands-free use. Feature-detected no-op off Android/Chromium; iPhone
        // Safari (no Vibration API) is an accepted divergence (parent §6.4).
        // Deliberately NOT moved inside playSentForProcessingChime() — the
        // WS6 tour step replays that same tone and iOS tour playback has no
        // haptic; keeping the call here scopes the buzz to the live gate-pass.
        playSentForProcessingChime();
        haptic('heavy');
        sonnetRef.current?.sendTranscript(text, {
          confirmationsEnabled: getConfirmationModeEnabled(),
          utteranceId,
          regexResults,
          inResponseTo,
        });
        if (inFlightToolCallId) {
          // Force-clear: takePayload above only burned the slot on a
          // substantive transcript; a short reply ("0.6", "TT") would
          // leave it alive. The Stage 6 ask_user_answered is the
          // canonical resolution path, so we drop the legacy slot
          // unconditionally. iOS canon: line 2066 — explicit
          // `inFlightQuestion = nil` inside the stage6Substantive branch.
          inFlightQuestionRef.current.clear();
          console.info(
            `[recording:pipeline] stage=ask_user_answered toolCallId=${inFlightToolCallId.slice(0, 12)} userText="${text.slice(0, 40)}"`
          );
          sonnetRef.current?.sendAskUserAnswered(inFlightToolCallId, text, utteranceId);
          // iOS canon DeepgramRecordingViewModel.swift:2108-2113 — clear
          // the in-flight question slot the instant the wire emit is
          // sent. The card itself is no longer rendered (see
          // recording-chrome.tsx), but the questions[] state is still
          // observed by dedup and accounting; leaving the just-answered
          // question in the array would let the next onQuestion frame
          // dedup against it for the rest of the session. The
          // dismissTimersRef useEffect (~line 2334) reacts to the
          // questions state change and clears any pending dismiss
          // timer for the removed entry — no manual cleanup needed.
          setQuestions((prev) => {
            const next = prev.filter((q) => q.tool_call_id !== inFlightToolCallId);
            if (next.length === prev.length) return prev;
            questionsRef.current = next;
            clientDiagnostic('question_dismissed_after_voice_answer', {
              toolCallIdShort: inFlightToolCallId.slice(0, 12),
              userTextPreview: text.slice(0, 40),
            });
            return next;
          });
        }
        setProcessingCount((n) => n + 1);
        sleepManagerRef.current?.onSpeechActivity();
      };

      const service = new DeepgramService(
        {
          onStateChange: setDeepgramState,
          onInterimTranscript: (text) => {
            setInterim(text);
            // Mirror iOS `isSpeaking` flag — interim arrival proves the
            // inspector is mid-utterance. The phantom-VAD watchdog
            // armed by `onSpeechStarted` would otherwise un-flip the
            // ref after 1.2s of no interim, so we cancel it the moment
            // a real interim lands.
            isInspectorSpeakingRef.current = true;
            if (speechConfirmTimerRef.current) {
              clearTimeout(speechConfirmTimerRef.current);
              speechConfirmTimerRef.current = null;
            }
            // Inspector is speaking → cancel the post-wake "could you
            // repeat that" prompt. They're talking; the prompt would be
            // an interruption.
            if (postWakeMonitorTimerRef.current) {
              clearTimeout(postWakeMonitorTimerRef.current);
              postWakeMonitorTimerRef.current = null;
            }
          },
          onSpeechStarted: () => {
            // Stamp the time so the post-wake monitor (#53) can tell
            // a pre-wake SpeechStarted from a post-wake one.
            lastSpeechStartedTimeRef.current = Date.now();
            // Don't trust the SpeechStarted alone — Deepgram fires it on
            // ambient breath/rumble. Arm a 1.2s watchdog that un-flips
            // `isInspectorSpeakingRef` if no interim follows. Cancelled
            // by the first interim above. Mirrors iOS `speechConfirmTimer`
            // at DeepgramRecordingViewModel.swift:1620-1623.
            if (speechConfirmTimerRef.current) clearTimeout(speechConfirmTimerRef.current);
            speechConfirmTimerRef.current = setTimeout(() => {
              speechConfirmTimerRef.current = null;
              // If no interim fired in the window, the original
              // SpeechStarted was phantom — flip back to "not speaking"
              // so a deferred TTS isn't held indefinitely.
              isInspectorSpeakingRef.current = false;
              // Symptom-2b fix: a phantom SpeechStarted produces NO
              // `onUtteranceEnd`, so pre-fix this cleared the speaking flag
              // WITHOUT draining `deferredTtsRef` — the deferred question (and
              // any deferred confirmation head) was stranded forever. Drain
              // both from the shared helper here too.
              onInspectorStoppedSpeaking();
            }, SPEECH_CONFIRM_TIMEOUT_MS);
          },
          onUtteranceEnd: () => {
            // Inspector finished a sentence. Flip the flag back and drain any
            // deferred TTS so the question they were talking over plays now.
            // Mirrors iOS `resumeDeferredTTSIfNeeded` (AlertManager.swift:
            // 1144-1179). The shared helper drains the deferred DIRECT prompt
            // (via `speakDirectPrompt` so it stays cancellable) AND releases a
            // deferred CONFIRMATION head.
            isInspectorSpeakingRef.current = false;
            if (speechConfirmTimerRef.current) {
              clearTimeout(speechConfirmTimerRef.current);
              speechConfirmTimerRef.current = null;
            }
            onInspectorStoppedSpeaking();
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
            pipelineLog('recording_final_transcript', {
              textLength: text.length,
              textPreview: text.slice(0, 40),
              confidence: Math.round(confidence * 1000) / 1000,
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
                // Barge-in cancels ONLY the in-flight DIRECT prompt (the ask
                // the inspector is answering) — `resetQueue: false` leaves the
                // confirmation FIFO intact so read-backs still queued from a
                // prior turn aren't nuked (zero read-back). tts.ts owner-gates
                // this: it no-ops when a confirmation (not the question) owns
                // the audio.
                cancelSpeech({ resetQueue: false });
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
            // Bug K (2026-05-11) — pending-naming utterance buffer.
            // If a previous final was a bare "Circuit N is" without
            // completion, it's currently held in pendingNamingBufferRef
            // waiting for a follow-up. Concatenate so the regex matcher
            // sees both halves in the same cumulative-transcript pass
            // AND Sonnet sees them as a single turn — which is the only
            // way Sonnet routes "downstairs sockets" to circuit 2
            // rather than mis-renaming circuit 1 via DESCRIPTION
            // MATCHING. See TRAILING_CIRCUIT_NAMING_PATTERN for the
            // full rationale and the iOS-parity note.
            let effectiveText = text;
            let effectiveConfidence = confidence;
            const pending = pendingNamingBufferRef.current;
            if (pending) {
              clearTimeout(pending.timer);
              pendingNamingBufferRef.current = null;
              effectiveText = (pending.text + ' ' + text).trim();
              // Combined confidence is the LOWER of the two — pessimistic,
              // mirrors how a single transcript would carry one confidence.
              effectiveConfidence = Math.min(pending.confidence, confidence);
              clientDiagnostic('pipeline_naming_buffer_concat', {
                bufferedPreview: pending.text.slice(0, 40),
                followUpPreview: text.slice(0, 40),
                combinedPreview: effectiveText.slice(0, 80),
              });
            }
            // If the (possibly concatenated) text is itself a trailing
            // "Circuit N is" — i.e. the inspector paused again or just
            // re-stated the preface — buffer it and wait. This branch
            // covers: (a) the original buffer trigger when no pending
            // existed; (b) the rare case of two naming prefaces in a row
            // (e.g. "Circuit 2 is" + "Circuit 3 is" — user backed out).
            // Either way we want to hold for the completion.
            if (isTrailingCircuitNamingPattern(effectiveText)) {
              const armedAt = Date.now();
              const timer = setTimeout(() => {
                const buffered = pendingNamingBufferRef.current;
                if (!buffered || buffered.timer !== timer) {
                  // Either nothing pending (someone else cleared it) or
                  // a fresher timer is now in flight — drop the stale fire.
                  return;
                }
                pendingNamingBufferRef.current = null;
                clientDiagnostic('pipeline_naming_buffer_timeout', {
                  textPreview: buffered.text.slice(0, 80),
                  heldMs: Date.now() - armedAt,
                });
                // Flush the buffered final via the dispatch helper — the
                // TTS gates above already passed at buffer-time, and a
                // 3 s delay is short enough that re-running them would
                // be a no-op in the overwhelming majority of cases. iOS
                // canon ports the same single-gate model. Route through
                // dispatchFinalBurstBuffered so a subsequent final
                // within 500ms can still be merged.
                dispatchFinalBurstBuffered(buffered.text, buffered.confidence);
              }, NAMING_BUFFER_TIMEOUT_MS);
              pendingNamingBufferRef.current = {
                text: effectiveText,
                confidence: effectiveConfidence,
                timer,
              };
              clientDiagnostic('pipeline_naming_buffer_armed', {
                textPreview: effectiveText.slice(0, 80),
                timeoutMs: NAMING_BUFFER_TIMEOUT_MS,
              });
              return;
            }
            // Normal dispatch path — either the original final didn't
            // trigger the naming buffer OR it just resolved via
            // concatenation. Route through dispatchFinalBurstBuffered
            // so consecutive Deepgram finals within 500ms get merged
            // into a single Sonnet turn (mitigates the "Observation."
            // + "There is a crack…" split that prompted this fix).
            dispatchFinalBurstBuffered(effectiveText, effectiveConfidence);
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
            pipelineLog('recording_deepgram_on_error', {
              messageLength: err.message.length,
              messagePreview: err.message.slice(0, 80),
              hasService: deepgramRef.current != null,
            });
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
          // Flux-only (no-op on nova-3): log Configure success + RTT (parent
          // WS4 acceptance) and surface a ConfigureFailure/echo-mismatch. The
          // focused-answer narrowing path drives the Configure round-trips.
          onConfigureResult: (result) => {
            if (result.ok) {
              clientDiagnostic('flux_configure_success', { rttMs: result.rttMs });
            } else {
              clientDiagnostic('flux_configure_failed', {
                reason: result.reason,
                rttMs: result.rttMs,
              });
            }
          },
        },
        // No WebSocket factory override in production (tests inject one).
        undefined,
        // STT model for this session — resolved by the runtime kill-switch in
        // start(). openDeepgram re-runs on auto-sleep wake/resume; each rebuild
        // reads the same already-resolved ref (no refetch). DEFAULT_STT_MODEL
        // only if the ref is somehow unset (defensive — start() always sets it).
        activeSttModelRef.current ?? DEFAULT_STT_MODEL
      );
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
    [liveFill, onInspectorStoppedSpeaking]
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
      pipelineLog('recording_apply_extraction_call', {
        readings: result.readings?.length ?? 0,
        circuit_updates: result.circuit_updates?.length ?? 0,
        observations: result.observations?.length ?? 0,
        validation_alerts: result.validation_alerts?.length ?? 0,
        confirmations: result.confirmations?.length ?? 0,
        extraction_failed: Boolean(result.extraction_failed),
      });
      let applied: ReturnType<typeof applyExtractionToJob>;
      try {
        applied = applyExtractionToJob(jobRef.current, result, {
          userDefaults: userDefaultsRef.current,
          // L2 obs-photo sprint — thread the pending tuple so an
          // observation arriving within the 60 s auto-link window can
          // claim the photo. The callback drains both the in-memory
          // ref AND the IDB record so the next turn doesn't try to
          // attach the same photo twice. Phase 4 wires the capture
          // handler that populates this slot.
          pendingPhoto: pendingPhotoRef.current,
          onPhotoAttached: (blobId) => {
            const jobId = jobRef.current?.id;
            if (pendingPhotoRef.current && pendingPhotoRef.current.blobId === blobId) {
              // setPendingPhotoState(null) also clears the expiry
              // timer so a stale timer can't later move the just-
              // attached photo into the unassigned pool.
              setPendingPhotoState(null);
            }
            if (jobId) {
              void clearPendingPhoto(jobId);
            }
          },
          // Update the reverse-link feed so a fresh capture (Phase 4)
          // can attach to this just-created observation directly
          // without going through the pending slot. iOS canon: :5596.
          onLastObservationCreated: (id, timestamp) => {
            recentObservationRef.current = { id, timestamp };
          },
        });
      } catch (err) {
        pipelineLog('recording_apply_extraction_threw', {
          error: err instanceof Error ? err.message : String(err),
          stackPreview:
            err instanceof Error && typeof err.stack === 'string' ? err.stack.slice(0, 200) : null,
        });
        throw err;
      }
      pipelineLog('recording_apply_extraction_result', {
        appliedNull: applied === null,
        changed_keys: applied?.changedKeys.length ?? 0,
      });
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
        // Push the new job state back to the server (debounced, 120ms)
        // so Sonnet's next-turn snapshot sees the mutated circuits /
        // sections / observations. iOS parity — see schedulePushJobState
        // doc comment.
        schedulePushJobState();
      }
      // D6 — speak every confirmation through the confirmation-mode-
      // gated path, deduped per session via confirmedFieldKeysRef so a
      // re-extraction of the same field+circuit doesn't TTS twice.
      // Mirrors iOS `flushPendingConfirmations`
      // (DeepgramRecordingViewModel.swift:3290-3317): iterate the
      // confirmations array, build the shared dedupe key, skip on hit,
      // otherwise speak via the user-toggle-gated path.
      // Pre-fix the PWA only spoke the FIRST confirmation per turn —
      // the inspector lost audio feedback on a multi-reading turn
      // (two finals merged via the burst buffer can carry two field
      // updates, and only the first got announced).
      //
      // WS3 item 2 (2026-07-02): key re-keyed from field+circuit-only
      // (`<field>_none` degenerate fallback) to the full iOS
      // `buildConfirmationDedupeKey` shape — field + circuit + sorted
      // circuits + board_id + text-hash. The old fallback collided on
      // every board-level confirmation pair (84CE2125: second spd_bs_en
      // read-back swallowed) and on multi-circuit broadcasts (C0C21546:
      // turn-10 broadcast silenced by turn-9's key). The text IS the
      // value discriminator, so "same field, different value" now reads
      // back — audio-first invariant #1 (exactly once, never zero).
      const confirmations = Array.isArray(result.confirmations) ? result.confirmations : [];
      for (const conf of confirmations) {
        if (!conf || typeof conf.text !== 'string' || conf.text.trim().length === 0) continue;
        const dedupeKey = buildConfirmationDedupeKey(conf);
        if (confirmedFieldKeysRef.current.has(dedupeKey)) {
          clientDiagnostic('onExtraction_confirmation_deduped', {
            dedupeKey,
            sentencePreview: conf.text.slice(0, 80),
          });
          continue;
        }
        const sentence = confirmationToSentence(conf);
        if (!sentence) continue;
        confirmedFieldKeysRef.current.add(dedupeKey);
        clientDiagnostic('onExtraction_speaking_confirmation', {
          dedupeKey,
          sentencePreview: sentence.slice(0, 80),
        });
        // FIFO-enqueue (no longer clobbers a prior confirmation). Thread the
        // dedupeKey so the queue can un-record it via `onDiscarded` if this
        // confirmation is discarded before it ever plays (overflow / preempt /
        // purge / reset) — the sole "never a permanent read-back drop"
        // mechanism (Audio-First #1).
        speakConfirmation(sentence, { dedupeKey });
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
    [liveFill, schedulePushJobState]
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

    // Register the confirmation-FIFO session wiring (the ONLY registrations —
    // the player is injected per-enqueue by `speakConfirmation`). The defer
    // gate reads live refs/state: defer a confirmation while the inspector is
    // mid-utterance OR while a direct `speak()` prompt owns the audio (so a
    // lower-priority read-back can't cut off an urgent ask_user). `onDiscarded`
    // un-records a dedupe key for any confirmation discarded before it played,
    // so the backend can re-speak it on a later re-emit (Audio-First #1). Both
    // are restored to defaults by `ttsQueue.reset()` (run inside the
    // `cancelSpeech({resetQueue:true})` at stop/unmount).
    ttsQueueSetShouldDeferPlayback(() => isInspectorSpeakingRef.current || isDirectAudioActive());
    ttsQueueSetOnDiscarded((dedupeKey) => {
      confirmedFieldKeysRef.current.delete(dedupeKey);
    });

    const session = new SonnetSession({
      onStateChange: setSonnetState,
      onSessionAck: (status, sessionId) => {
        // Audit #35 + #36 wiring. SonnetSession already surfaces a
        // recoverable onError when status === 'new' arrives where a
        // 'resumed' was expected (sonnet-session.ts:1470-1475 — TTL
        // expired during a long pause), but the inspector never saw
        // a UI cue. Surface a sonner toast so they know context is
        // gone and the next few utterances will rebuild from scratch.
        clientDiagnostic('sonnet_session_ack_observed', {
          status,
          sessionIdShort: sessionId?.slice(0, 16) ?? null,
        });
        // Stamp the server-minted sessionId onto the cross-reload
        // resume slot. This is the rehydrate target — on a fresh
        // mount post-reload, passing this back via
        // `SonnetSession.connect({sessionId})` triggers the backend's
        // `session_resume` path, preserving the Anthropic prompt
        // cache within the 5-min TTL.
        if (sessionId && persistedSessionMetaRef.current) {
          persistedSessionMetaRef.current = {
            ...persistedSessionMetaRef.current,
            serverSessionId: sessionId,
          };
          // Persist now so a reload that happens BEFORE the next
          // setState transition still has the server id.
          if (statusRef.current === 'active' || statusRef.current === 'sleeping') {
            persistRecordingState({
              clientSessionId: persistedSessionMetaRef.current.clientSessionId,
              serverSessionId: sessionId,
              jobId: persistedSessionMetaRef.current.jobId,
              certificateType: persistedSessionMetaRef.current.certificateType,
              status: statusRef.current,
              startedAt: persistedSessionMetaRef.current.startedAt,
              lastUpdatedAt: Date.now(),
            });
          }
        }
        if (status === 'resumed' && statusRef.current === 'sleeping') {
          // A clean resume after wake-from-sleep — no UI needed.
          return;
        }
      },
      onResumeOutcome: (outcome) => {
        clientDiagnostic('sonnet_resume_outcome', { outcome });
        if (outcome === 'context_expired') {
          toast('Recording paused too long', {
            description:
              'Sonnet lost the recent context. The next few utterances will rebuild from scratch.',
            duration: 8_000,
          });
        }
      },
      onExtraction: (result) => {
        applyExtraction(result);
        // D4 — pending-readings buffer.
        // 1. Drop any pending entries that this extraction resolved
        //    (Sonnet found the circuit on a subsequent turn).
        // 2. Buffer any new orphans (circuit < 1) so the 2 s timer
        //    can ask "Which circuit was that for?" if nothing
        //    resolves them.
        const buffer = pendingReadingsBufferRef.current;
        if (!buffer) return;
        const readings = Array.isArray(result.readings) ? result.readings : [];
        // A2 (sess_mrbnds2d_jczh) — section-level fields need no circuit and
        // were already applied by applyExtraction above. iOS canon rescues
        // them from the buffer (`supplyFields` check inside the circuit == -1
        // branch, DeepgramRecordingViewModel.swift:5430); the web D4 port
        // omitted the rescue, so "customer is Michael Payden" produced a
        // false "Which circuit was that client_name reading for?" ask that
        // preempt-flushed the queued read-back.
        const { resolved, orphans, rescued } = classifyReadingsForBuffer(
          readings,
          isNonCircuitField
        );
        for (const r of rescued) {
          clientDiagnostic('non_circuit_field_rescued_from_buffer', {
            field: r.field,
            valuePreview: r.value.slice(0, 40),
          });
        }
        if (resolved.length > 0) buffer.removeResolved(resolved);
        if (orphans.length > 0) buffer.addAll(orphans);
      },
      onQuestion: (q) => {
        clientDiagnostic('onQuestion_entered', {
          questionType: q.question_type ?? null,
          questionLength: typeof q.question === 'string' ? q.question.length : 0,
          questionPreview: typeof q.question === 'string' ? q.question.slice(0, 80) : '',
          hasToolCallId: typeof q.tool_call_id === 'string' && q.tool_call_id.length > 0,
        });
        // Bug L (2026-05-11) — dedup synchronously against `questionsRef`
        // (not via the setQuestions reducer return value) so the TTS-vs-
        // skip decision survives the double-mount/Suspense-retry race
        // where setQuestions belongs to an unmounted fiber and the
        // reducer never runs. See questionsRef declaration for the full
        // sess_mp19b6tf_i5xc rationale.
        //
        // Sonnet occasionally re-asks the same question across turns
        // until the field is filled; iOS's AlertCardView doesn't
        // re-announce a queued question, so neither do we.
        const prevQs = questionsRef.current;
        const isDuplicate = prevQs.some((p) => p.question === q.question);
        if (isDuplicate) {
          clientDiagnostic('onQuestion_skipped_speak', {
            isNew: false,
            hasQuestionText: Boolean(q.question),
            queueDepth: prevQs.length,
            reason: 'dedup_hit',
          });
          // Still close the turn that produced it — same accounting
          // as the non-dedup path below.
          setProcessingCount((n) => Math.max(0, n - 1));
          return;
        }
        // Push to the queue, capped at 5. Write the ref synchronously
        // BEFORE setQuestions so a second onQuestion firing in the same
        // tick sees the fresh queue and dedups correctly even if the
        // useEffect mirror hasn't run yet.
        const appended = [...prevQs, q];
        const next = appended.length > 5 ? appended.slice(appended.length - 5) : appended;
        questionsRef.current = next;
        setQuestions(next);
        // A question frame also closes the turn that produced it — same
        // accounting as the extraction branch above.
        setProcessingCount((n) => Math.max(0, n - 1));
        // Orphaned-reading questions also roll into the pending-readings
        // counter: Sonnet sometimes reports an unassigned value via a
        // question frame (question_type === 'orphaned') rather than a
        // validation_alerts entry, and the banner would stay at 0 while
        // the UI simultaneously showed an orphaned-reading question.
        if (q.question_type === 'orphaned') {
          setPendingReadings((n) => n + 1);
          // D4 — server-side suppression hook. iOS canon
          // `TranscriptProcessor.suppressSelfRetry`
          // (`TranscriptProcessor.swift:259-263`). If the server has
          // ALREADY asked an equivalent disambiguation, cancel the
          // local 2 s timer so the two TTS prompts don't stack
          // (sess_80723FDE-style regression). Pending entries stay
          // in the buffer so the inspector's reply to the server's
          // question can still clear them via removeResolved on the
          // next extraction.
          if (typeof q.field === 'string' && q.field.length > 0) {
            pendingReadingsBufferRef.current?.suppressSelfRetry(q.field);
          }
        }
        // Speak only newly-appearing questions. The attention tone plays
        // BEFORE TTS to give the inspector a half-second of warning that
        // something needs their attention — same iOS ordering at
        // AlertManager.swift:717 (playAttentionTone() immediately before
        // speakAlertMessage()).
        if (q.question) {
          // Enqueue into the in-flight tracker. The active slot is only
          // promoted on TTS-start (handled in setTtsLifecycleObserver
          // below) so a dropped/skipped TTS doesn't anchor a question
          // the inspector never heard.
          inFlightQuestionRef.current.enqueue({
            type: q.question_type ?? 'unknown',
            question: q.question,
            field: q.field ?? null,
            circuit: q.circuit ?? null,
            toolCallId: typeof q.tool_call_id === 'string' ? q.tool_call_id : null,
          });
          clientDiagnostic('onQuestion_speaking', {
            queueDepth: next.length,
            questionPreview: q.question.slice(0, 80),
            inFlightPendingCount: inFlightQuestionRef.current.pendingCount,
          });
          // Switch the sleep timer to the 75s question-answer window
          // so the inspector has time to hear, think, and reply
          // without the standard 60s timer dropping us into sleep
          // mid-thought. Mirrors iOS SleepManager.swift:68.
          sleepManagerRef.current?.onQuestionAsked();
          playAttentionTone();
          // Defer the TTS if the inspector is currently speaking, so
          // we don't talk over their answer to the *previous* question.
          // Mirrors iOS `AlertManager.swift:877-880 shouldDeferPlayback`.
          // The deferred entry is drained on the next `onUtteranceEnd`.
          if (isInspectorSpeakingRef.current) {
            const toolCallId =
              typeof q.tool_call_id === 'string' && q.tool_call_id.length > 0
                ? q.tool_call_id
                : null;
            clientDiagnostic('tts_deferred_inspector_speaking', {
              toolCallIdShort: toolCallId?.slice(0, 12) ?? null,
              questionPreview: q.question.slice(0, 80),
            });
            deferredTtsRef.current = { text: q.question, toolCallId };
          } else {
            // Dispatch through `speakDirectPrompt` (NOT plain `speak`) so the
            // prompt stays cancellable — a later `cancel_pending_tts` during
            // its fetch/playback can silence it and clear its ask state.
            const toolCallId =
              typeof q.tool_call_id === 'string' && q.tool_call_id.length > 0
                ? q.tool_call_id
                : null;
            speakDirectPrompt(q.question, toolCallId);
          }
        } else {
          clientDiagnostic('onQuestion_skipped_speak', {
            isNew: true,
            hasQuestionText: false,
            queueDepth: next.length,
            reason: 'empty_text',
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
        const applied = applyExtractionToJob(jobRef.current, synthetic, {
          userDefaults: userDefaultsRef.current,
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
          schedulePushJobState();
        }
      },
      onCircuitCreated: (msg) => {
        // Stage 6 STI-06 — ensure the row exists. Route through the
        // circuit_updates path so both create + designation rename use
        // the same code (mirrors iOS where both create_circuit and
        // rename_circuit fire Stage6CircuitCreated/Updated events).
        // Forward msg.rating_amps as an `ocpd_rating` reading so the
        // OCPD-rating column on the new circuit row populates in the
        // same apply pass (iOS canon writes both designation + OCPD
        // rating to the Circuit model when create_circuit dispatches).
        const ratingReadings: ExtractedReading[] =
          msg.rating_amps != null
            ? [{ circuit: msg.circuit_ref, field: 'ocpd_rating', value: msg.rating_amps }]
            : [];
        const synthetic: ExtractionResult = {
          readings: ratingReadings,
          circuit_updates: [
            {
              circuit: msg.circuit_ref,
              designation: msg.designation ?? '',
              action: 'create',
            },
          ],
        };
        const applied = applyExtractionToJob(jobRef.current, synthetic, {
          userDefaults: userDefaultsRef.current,
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
          schedulePushJobState();
        }
      },
      onCircuitUpdated: (msg) => {
        // Stage 6 STI-07 — rename. Same wire shape as create; treat as
        // a rename action so the existing logic preserves any
        // already-typed designation only when the server isn't asking
        // for an explicit overwrite. Forward rating_amps (same
        // rationale as onCircuitCreated above).
        if (!msg.designation && msg.rating_amps == null) return;
        const ratingReadings: ExtractedReading[] =
          msg.rating_amps != null
            ? [{ circuit: msg.circuit_ref, field: 'ocpd_rating', value: msg.rating_amps }]
            : [];
        const circuitUpdates = msg.designation
          ? [
              {
                circuit: msg.circuit_ref,
                designation: msg.designation,
                action: 'rename' as const,
              },
            ]
          : [];
        const synthetic: ExtractionResult = {
          readings: ratingReadings,
          circuit_updates: circuitUpdates,
        };
        const applied = applyExtractionToJob(jobRef.current, synthetic, {
          userDefaults: userDefaultsRef.current,
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
          schedulePushJobState();
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
        schedulePushJobState();
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
        schedulePushJobState();
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
      onBoardOps: (ops) => {
        if (ops.length === 0) return;
        clientDiagnostic('board_ops_received', { count: ops.length });
        const boardsPatch = applyBoardOpsToJob(jobRef.current, ops);
        if (boardsPatch) {
          updateJobRef.current(boardsPatch);
          jobRef.current = {
            ...jobRef.current,
            ...(boardsPatch as Partial<typeof jobRef.current>),
          };
          schedulePushJobState();
        }
      },
      onCurrentBoardChanged: (msg) => {
        clientDiagnostic('current_board_changed_received', {
          source: msg.source,
          board_id_short: msg.board_id.slice(0, 8),
        });
        setCurrentBoardId(msg.board_id);
      },
      onSelectBoardAck: (msg) => {
        // PWA doesn't emit `select_board` today (banner-driven only),
        // so this is mostly diagnostic. iOS uses it to flag a failed
        // switch back to the user.
        clientDiagnostic('select_board_ack_received', {
          ok: msg.ok,
          hasError: !!msg.error,
        });
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
      onCancelPendingTts: ({ prefix }) => {
        // iOS Phase 6.3 parity. The cancelled focused-mode script prompt rides
        // the DIRECT `speak()`/`deferredTtsRef` path — silence THAT (deferred
        // OR in-flight, NOT gated on the audio window) and clear its ask state
        // everywhere it lingers. `ttsQueue.purge(prefix)` is a forward hook
        // (no-op today — confirmations carry no cancelKey). Pure helper so the
        // seam is unit-testable and dodges the dismiss-timer hooks TDZ.
        handleCancelPendingTts(prefix, {
          deferredTtsRef,
          activeDirectPromptToolCallIdRef,
          cancelSpeech,
          purgeQueue: ttsQueuePurge,
          isTtsWindowOpen: () => getTtsAudioWindow()?.endMs == null && getTtsAudioWindow() != null,
          clearSonnetInFlightByPrefix: (p) => sonnetRef.current?.clearInFlightToolCallIdByPrefix(p),
          removeInFlightQuestionByPrefix: (p) =>
            inFlightQuestionRef.current.removeByToolCallIdPrefix(p),
          questionsRef,
          setQuestions,
          dismissTimersRef,
        });
      },
      onError: (err, recoverable) => {
        pipelineLog('recording_sonnet_on_error', {
          recoverable,
          messageLength: err.message.length,
          messagePreview: err.message.slice(0, 80),
        });
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
  }, [applyExtraction, speakDirectPrompt]);

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
        // iOS-parity PCM gate during ElevenLabs playback. Mirrors
        // `DeepgramService.pauseAudioStream()` at DeepgramService.swift:566
        // — iOS stops pushing mic PCM to its STT WS the instant TTS plays,
        // resumes 500ms after playback ends. Without this the PWA does
        // resample + ring-buffer write + Deepgram send + (in sleep) Silero
        // inference on EVERY audio block while ElevenLabs is also
        // decoding on the same iPad Safari renderer process — the
        // observed cumulative-pressure trigger that froze the JS event
        // loop ~1s into the 2nd consecutive TTS playback in
        // sess_mp9ep221_62n8 (2026-05-17). Early-return BEFORE resample
        // so we also save those CPU cycles, not just the WS send.
        // Mic capture itself + the VU meter (onLevel below) keep
        // running so the inspector still sees they're being heard.
        if (ttsActiveRef.current) return;
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
        // Amplitude-based barge-in was attempted in commits cc4082e +
        // aca3327 but reverted after sess_mpathxlt_uwth (2026-05-18)
        // showed it killing every TTS within 0-60ms of `audio_playing`.
        // Web `getUserMedia` echoCancellation is software best-effort
        // and the speaker output bleeds back through the mic, tripping
        // the threshold on the TTS's own audio. iOS gets away with this
        // because AVAudioSession voice-processing mode is
        // hardware-grade AEC. Barge-in on the web is delegated to the
        // text-final-during-TTS path in `dispatchFinal` — Deepgram's
        // server-side VAD is robust against this echo.
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
        // Post-wake transcript monitor — mirror iOS
        // `RecordingSessionCoordinator.swift:530-577`. The inspector
        // may have spoken DURING the wake-from-sleep window and we
        // missed it. After 15s, if no final transcript landed AND no
        // SpeechStarted fired AFTER the wake, prompt them to retry.
        const wakeTime = Date.now();
        wakeTimeRef.current = wakeTime;
        if (postWakeMonitorTimerRef.current) {
          clearTimeout(postWakeMonitorTimerRef.current);
        }
        postWakeMonitorTimerRef.current = setTimeout(() => {
          postWakeMonitorTimerRef.current = null;
          // Session rotated → suppress
          if (sessionIdRef.current !== sessionId) return;
          if (statusRef.current !== 'active') return;
          // Inspector started speaking after we woke → they're mid-
          // utterance, suppress to avoid interrupting them.
          const speechAfterWake =
            lastSpeechStartedTimeRef.current != null &&
            lastSpeechStartedTimeRef.current >= wakeTime;
          if (speechAfterWake) {
            clientDiagnostic('post_wake_monitor_suppressed', {
              reason: 'speech_after_wake',
              wakeAgeMs: Date.now() - wakeTime,
            });
            return;
          }
          // Sonnet WS down → no point speaking, the answer can't be
          // captured anyway.
          if (sonnetRef.current?.connectionState !== 'connected') {
            clientDiagnostic('post_wake_monitor_suppressed', {
              reason: 'sonnet_disconnected',
              sonnetState: sonnetRef.current?.connectionState ?? 'no-service',
            });
            return;
          }
          clientDiagnostic('post_wake_monitor_fired', {
            wakeAgeMs: Date.now() - wakeTime,
          });
          speak('Sorry, could you repeat that?');
        }, POST_WAKE_MONITOR_MS);
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
        //
        // Ask backend to compact the Anthropic prompt cache BEFORE
        // tearing down Sonnet — mirrors iOS at
        // `RecordingSessionCoordinator.swift:394`. This collapses the
        // multi-turn history into a smaller summary that survives
        // Anthropic's 5-minute cache TTL, so the next wake-turn
        // doesn't repay the full prompt cost. Best-effort; the
        // backend's own 5-check + 60k-token guard rails decide
        // whether to actually compact.
        sonnetRef.current?.sendCompactRequest();
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
      pipelineLog('recording_start_blocked', { status: statusRef.current });
      return;
    }
    // Offline gate — iOS parity with `DeepgramRecordingViewModel.swift:601`
    // (`NetworkMonitor.shared.isConnected`). Pre-fix the PWA opened mic
    // capture + tried Deepgram + Sonnet WS handshakes anyway, burning
    // battery on retry loops with no recoverable signal for the
    // inspector. `navigator.onLine === false` is a hint (it can be
    // false-positive on captive portals) but the false-positive cost
    // is only "user re-taps Start once network returns" — much smaller
    // than the silent-failure cost of starting offline.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      recordLifecycle('recording-start-blocked', { reason: 'offline' });
      pipelineLog('recording_start_blocked', { reason: 'offline' });
      toast('No network connection', {
        description: 'Recording requires an internet connection. Try again once online.',
        duration: 6_000,
      });
      return;
    }
    recordLifecycle('recording-start', { jobId: jobRef.current?.id ?? null });
    pipelineLog('recording_start_invoked', {
      jobId: jobRef.current?.id ?? null,
      certType: jobRef.current?.certificate_type ?? null,
    });
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
    // Resolve the STT model for THIS recording session via the runtime
    // kill-switch (parity WS4) — once per recording, forced so an emergency
    // ECS `DEEPGRAM_STT_MODEL` flip is picked up without a page reload (the
    // RecordingProvider stays mounted across stop/start cycles, so an
    // app-session cache would ignore the flip until reload). Placed AFTER the
    // synchronous primeTts() gesture grant (which does not survive an await)
    // and BEFORE any await that starts mic/Sonnet/backend/Deepgram. A fetch
    // failure or a non-JSON (login-redirect) body resolves to the fail-safe
    // nova3 inside ensureRuntimeConfigLoaded. Auto-sleep reconnects reuse this
    // ref; stop() clears it.
    activeSttModelRef.current = await ensureRuntimeConfigLoaded({ force: true });
    pipelineLog('recording_stt_model_resolved', { model: activeSttModelRef.current });
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
      // iOS-parity PCM gate. On TTS start: cancel any pending resume
      // timer (a back-to-back ask_user pair would otherwise resume
      // mid-second-utterance), flip ttsActiveRef so onSamples early-
      // returns, and call DeepgramService.pause() as belt-and-braces.
      // On TTS end: delay 500ms before flipping the ref back + calling
      // resume() — matches iOS's post-TTS drain window
      // (DeepgramRecordingViewModel.swift:828). The 500ms swallows the
      // audio-out tail of the spoken question without clipping a fast
      // verbal answer.
      // In-flight question anchoring. iOS canon:
      //  - handleAlertTTSStarted (line 2572) — pop matching pending entry
      //    into the active slot and stamp askedAt = now.
      //  - handleAlertTTSFinished (line 2655) — re-anchor askedAt to TTS-
      //    end so the 10s stale window measures from when the inspector
      //    could physically reply, not from when ElevenLabs started.
      // Match-by-text — the tracker is a no-op when the spoken text
      // doesn't correspond to any pending entry (non-question TTS like
      // "Updated" or voice-command responses).
      const spokenText = lastSpokenTextRef.current;
      if (event === 'start' && spokenText) {
        const matched = inFlightQuestionRef.current.onTtsStart(spokenText);
        if (matched) {
          clientDiagnostic('inflight_question_anchored', {
            questionPreview: spokenText.slice(0, 80),
          });
        }
      } else if (event === 'end' && spokenText) {
        inFlightQuestionRef.current.onTtsEnd(spokenText);
      }
      if (event === 'start') {
        if (ttsResumeTimerRef.current) {
          clearTimeout(ttsResumeTimerRef.current);
          ttsResumeTimerRef.current = null;
        }
        ttsActiveRef.current = true;
        deepgramRef.current?.pause();
        clientDiagnostic('tts_pcm_gate_engaged', {});
      } else {
        if (ttsResumeTimerRef.current) {
          clearTimeout(ttsResumeTimerRef.current);
        }
        ttsResumeTimerRef.current = setTimeout(() => {
          ttsResumeTimerRef.current = null;
          ttsActiveRef.current = false;
          deepgramRef.current?.resume();
          clientDiagnostic('tts_pcm_gate_released', {
            delayMs: TTS_PCM_GATE_RESUME_DELAY_MS,
          });
        }, TTS_PCM_GATE_RESUME_DELAY_MS);
      }
    });
    setErrorMessage(null);
    setState('requesting-mic');
    setElapsedSec(0);
    setDeepgramCostUsd(0);
    setSonnetCostUsd(0);
    setTranscript([]);
    setInterim('');
    questionsRef.current = [];
    setQuestions([]);
    setProcessingCount(0);
    setPendingReadings(0);
    // D4 — drop any orphan readings carried over from a previous
    // session so the 2 s timer doesn't fire mid-warmup.
    pendingReadingsBufferRef.current?.reset();
    // D6 — clear the per-field confirmation dedup set. Same iOS
    // canon as line 799 (`confirmedFieldKeys = []`).
    confirmedFieldKeysRef.current.clear();
    liveFill.reset();
    // Capture the new session id synchronously and snapshot it locally so
    // that any async handler resolving below (mic permission prompt, WS
    // handshake) can compare the id it started with against the CURRENT
    // sessionIdRef.current. If they differ, a stop()+start() cycle has
    // rotated the session and the late-resolving await belongs to a
    // dead session — we bail and tear down the accidental resources.
    const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    sessionIdRef.current = sessionId;
    // Initialise the cross-reload session-resume slot. The
    // serverSessionId stays null until the first session_ack lands;
    // it gets populated via the onSessionAck callback wired in
    // openSonnet. From here on, every `setState('active'|'sleeping')`
    // transition will persist the snapshot via
    // `persistRecordingState`.
    const jobIdAtStart = jobRef.current?.id ?? null;
    const certTypeAtStart = (jobRef.current?.certificate_type ?? 'EICR') as 'EICR' | 'EIC';
    if (jobIdAtStart) {
      persistedSessionMetaRef.current = {
        clientSessionId: sessionId,
        serverSessionId: null,
        jobId: jobIdAtStart,
        certificateType: certTypeAtStart,
        startedAt: Date.now(),
      };
    }
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
    // Reset active board id at session start — the backend will
    // re-emit a `current_board_changed` once the session_resume / fresh
    // session_ack settles, populating this from the canonical
    // currentBoardId in the snapshot.
    setCurrentBoardId(null);
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
    pipelineLog('recording_stop_invoked', { status: statusRef.current });
    sessionIdRef.current = '';
    // Clear the TTS sessionId in lockstep so post-stop speak() calls
    // (e.g. an ask_user that arrived after the WS close) bypass the
    // ElevenLabs path and degrade to native TTS — mirrors the
    // sessionIdRef rotation guard everywhere else in this file.
    setTtsSessionId(null);
    // Clear active board id so the next recording session starts with
    // no banner state; the backend will re-broadcast on the new session.
    setCurrentBoardId(null);
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
    // Clear the resolved STT model so the next start() re-fetches the runtime
    // config and picks up any ECS `DEEPGRAM_STT_MODEL` flip (parity WS4).
    activeSttModelRef.current = null;
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
    questionsRef.current = [];
    setQuestions([]);
    setProcessingCount(0);
    setPendingReadings(0);
    // D4 — release the orphan buffer + cancel any armed timer so a
    // post-stop fire doesn't speak into a torn-down TTS pipeline.
    pendingReadingsBufferRef.current?.reset();
    // D6 — drop the per-field confirmation dedup set so the next
    // session starts with a clean slate.
    confirmedFieldKeysRef.current.clear();
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
          const next = prev.filter((_, i) => i !== index);
          questionsRef.current = next;
          return next;
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
          const next = prev.filter((_, i) => i !== index);
          questionsRef.current = next;
          return next;
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
          const next = prev.filter((_, i) => i !== index);
          questionsRef.current = next;
          return next;
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
        setQuestions((prev) => {
          const next = prev.filter((p) => p.question !== q.question);
          questionsRef.current = next;
          return next;
        });
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

  // Keep the lifecycle-actions ref in sync with the current `pause` /
  // `stop` references. The lifecycle effect at the top of the provider
  // mounts ONCE on mount with an empty dep array, so it captures the
  // INITIAL `pause` / `stop` closures — which would be stale after any
  // re-render. This effect refreshes the ref whenever those callbacks
  // get a new identity, so the BFCache / freeze / visibilitychange
  // handlers always reach the latest implementation.
  React.useEffect(() => {
    lifecycleActionsRef.current = {
      pause,
      stop,
      start,
      statusAtHide: statusRef.current,
    };
  }, [pause, stop, start]);

  // L2 obs-photo sprint Phase 6 — cleanup the expiry timer on
  // unmount too so a stray timer doesn't try to write
  // `unassigned_photos` after the provider is gone.
  React.useEffect(() => {
    return () => {
      if (pendingPhotoTimerRef.current != null) {
        clearTimeout(pendingPhotoTimerRef.current);
        pendingPhotoTimerRef.current = null;
      }
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
      currentBoardId,
      start,
      stop,
      pause,
      resume,
      dismissQuestion,
      acceptQuestion,
      rejectQuestion,
      resumeChitchat,
      captureObservationPhoto,
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
      currentBoardId,
      start,
      stop,
      pause,
      resume,
      dismissQuestion,
      acceptQuestion,
      rejectQuestion,
      resumeChitchat,
      captureObservationPhoto,
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
