/**
 * Transcript-injection harness for the PWA audio pipeline.
 *
 * Mirrors the dispatch path inside `recording-context.tsx` (`dispatchFinal`
 * → matcher → applyRegexMatchToJob → buildRegexSummary →
 * SonnetSession.sendTranscript) without React, without the mic, without
 * Deepgram. Lets a parity test drive a scripted transcript through the
 * exact same matcher + wire-shape builder + sonnet-session as production
 * code, and capture every frame the WS would send.
 *
 * What it covers:
 *  - normaliseTranscriptText (number-normaliser)
 *  - TranscriptFieldMatcher.match() on cumulative transcript
 *  - applyRegexMatchToJob → FieldSourceTracker.consumeTurnWrites()
 *  - buildRegexSummary → regexResults wire shape
 *  - SonnetSession.sendTranscript() → mocked WS
 *  - SonnetSession.sendAskUserAnswered() round-trip for in-flight asks
 *
 * What it does NOT cover (yet):
 *  - 500ms burst buffer (recording-context.tsx:803-807)
 *  - 3s naming buffer for "Circuit N is" (recording-context.tsx:784-788)
 *  - isTTSEcho() gate (recording-context.tsx:1561)
 *  - sleep/wake state machine
 *  - barge-in (TTS-active gate)
 *
 * Those live inside the React provider. A Tier-2 harness that mounts the
 * provider is a later upgrade; the Tier-1 harness here is enough to verify
 * wire-shape parity with iOS (the highest-impact divergences).
 */

import WS from 'jest-websocket-mock';
import {
  SonnetSession,
  type SonnetSessionCallbacks,
  type ExtractionResult,
  type SonnetQuestion,
} from '@/lib/recording/sonnet-session';
import { TranscriptFieldMatcher } from '@/lib/recording/transcript-field-matcher';
import { FieldSourceTracker } from '@/lib/recording/field-source-tracker';
import { applyRegexMatchToJob } from '@/lib/recording/apply-regex-match';
import { buildRegexSummary, type RegexResultsWire } from '@/lib/recording/regex-match-result';
import { normalise as normaliseTranscriptText } from '@/lib/recording/number-normaliser';
import { BurstBuffer, NamingBuffer } from '@/lib/recording/dispatch-buffers';
import type { JobDetail } from '@/lib/types';

const SONNET_URL = 'ws://localhost:3000/api/sonnet-stream';

export interface InjectOptions {
  /** Optional UUID for the dedup anchor. Pre-generated so the test can also
   *  send a matching `consumed_utterance_id` on an ask answer. */
  utteranceId?: string;
  /** Mirror iOS `confirmations_enabled` toggle. Defaults to false. */
  confirmationsEnabled?: boolean;
  /** If set, the dispatch path also emits `ask_user_answered(toolCallId)`
   *  AFTER the transcript — matches recording-context.tsx:1396 ordering
   *  for inspector replies to a Stage 6 ask. */
  inFlightToolCallId?: string;
  /** Preceding-TTS-question context. Mirrors iOS
   *  `ServerWebSocketService.sendTranscript(inResponseTo:)`. Set when a
   *  scenario wants to model "TTS asked Q, inspector replied" — the
   *  outbound `transcript` frame will carry an `in_response_to` payload
   *  identical to what iOS sends. */
  inResponseTo?: {
    type: string;
    question: string;
    field?: string | null;
    circuit?: number | null;
  };
}

export interface InjectResult {
  rawText: string;
  normalisedText: string;
  cumulativeTranscript: string;
  /** Matcher emission for THIS turn (pre-apply). Keys are circuit_ref-
   *  keyed; same shape as `apply-regex-match` consumes. */
  changedKeys: string[];
  /** `regexResults` wire payload built from FieldSourceTracker turn-writes —
   *  what gets stamped on the outbound transcript frame. */
  regexResults: RegexResultsWire | undefined;
  /** The updated JobDetail after applying the matcher patch. */
  job: JobDetail;
}

export interface HarnessOptions {
  job: JobDetail;
  jobId?: string;
  sessionId?: string;
  callbacks?: SonnetSessionCallbacks;
  /** When true, swallow `session_start` and `session_resume` frames from
   *  the wire trace so the trace begins at the first injected transcript.
   *  Default true. */
  swallowHandshake?: boolean;
  /** When true, dispatch buffers use a deterministic controlled
   *  scheduler. Tests drive timers via `advance(ms)`. Default true so
   *  tests are deterministic. */
  controlledScheduler?: boolean;
  /** Override the burst-buffer window length. Default 500 ms (production
   *  value). */
  burstBufferWindowMs?: number;
  /** Override the naming-buffer window length. Default 3000 ms. */
  namingBufferWindowMs?: number;
}

export interface Harness {
  session: SonnetSession;
  server: WS;
  /** Mutable job snapshot — updated as injectFinal applies regex patches. */
  getJob(): JobDetail;
  /** Inject a single Deepgram final. Runs normalise → cumulative buffer →
   *  matcher → apply patch → tracker → buildRegexSummary → sendTranscript.
   *  Returns the per-turn diagnostics for assertion. */
  injectFinal(text: string, opts?: InjectOptions): InjectResult;
  /**
   * Tier-2 injection: routes the final through the naming buffer first
   * (catches "Circuit N is" prefaces and holds for completion) then
   * through the burst buffer (merges consecutive finals within 500 ms
   * with the ' ... ' separator), then dispatches via `injectFinal`.
   *
   * Use this for scenarios that need to validate the provider-side
   * buffering behaviour without mounting `RecordingProvider`. Pair with
   * `advance(ms)` to drive buffer timeouts and `flushBuffers()` on
   * teardown.
   */
  feedDeepgramFinal(text: string, confidence?: number, opts?: InjectOptions): void;
  /** Fast-forward all pending buffer timers by `ms`, firing any that
   *  expire. Available only when the harness was built with
   *  `controlledScheduler: true`. */
  advance(ms: number): void;
  /** Force-flush any pending buffered final (naming then burst).
   *  Use during teardown so a buffered text isn't silently dropped. */
  flushBuffers(): void;
  /** Resolve when the WS server receives the next frame; returns parsed JSON
   *  and appends to `wireTrace`. */
  nextWireMessage(): Promise<Record<string, unknown>>;
  /** Read all frames received so far, parsed. */
  wireTrace(): Record<string, unknown>[];
  /** Drain every frame currently queued on the mock server. Useful when
   *  the test wants to assert "exactly N frames" without awaiting one at a
   *  time. */
  drainWireTrace(): Promise<Record<string, unknown>[]>;
  /** Server-side helpers — push an extraction/question to the client. */
  pushExtraction(result: ExtractionResult): void;
  pushQuestion(q: SonnetQuestion & { tool_call_id?: string | null }): void;
  /** Tear down the WS + session. Call from `afterEach`. */
  teardown(): void;
}

/** Build a fully-wired harness. Must be `await`ed because the mock WS
 *  handshake is microtask-driven (jest-websocket-mock). */
export async function buildHarness(options: HarnessOptions): Promise<Harness> {
  // SonnetSession's getToken() reads localStorage('cm_token').
  localStorage.setItem('cm_token', 'parity-harness-token');

  const server = new WS(SONNET_URL);
  const session = new SonnetSession(options.callbacks ?? {});

  const certType =
    (options.job as unknown as { certificate_type?: string }).certificate_type === 'EIC'
      ? 'EIC'
      : 'EICR';

  session.connect({
    sessionId: options.sessionId ?? 'parity-session-id',
    jobId: options.jobId ?? (options.job as unknown as { id?: string }).id ?? 'parity-job-id',
    certificateType: certType,
    jobState: options.job,
  });
  await server.connected;

  const swallowHandshake = options.swallowHandshake !== false;
  const trace: Record<string, unknown>[] = [];

  // Drain the session_start frame so the trace begins clean.
  if (swallowHandshake) {
    const handshake = await server.nextMessage;
    JSON.parse(handshake as string); // discard
  }

  // Mutable harness state — must use refs-via-closure because the helpers
  // are exposed as object methods.
  const matcher = new TranscriptFieldMatcher();
  const tracker = new FieldSourceTracker();
  let cumulativeTranscript = '';
  let jobSnapshot: JobDetail = options.job;

  // Controlled scheduler for the dispatch buffers — fires deterministically
  // when `advance(ms)` is called. Each entry tracks its remaining time so
  // simultaneous timers expire in arm-order.
  const useControlled = options.controlledScheduler !== false;
  interface TimerEntry {
    cb: () => void;
    remainingMs: number;
  }
  const timers = new Map<number, TimerEntry>();
  let nextTimerId = 1;
  const schedulerDeps = useControlled
    ? {
        scheduler: (cb: () => void, ms: number): unknown => {
          const id = nextTimerId++;
          timers.set(id, { cb, remainingMs: ms });
          return id;
        },
        clearScheduler: (handle: unknown): void => {
          timers.delete(handle as number);
        },
      }
    : {};
  const advance = (ms: number): void => {
    if (!useControlled) {
      throw new Error('advance() unavailable when controlledScheduler is false');
    }
    // Walk a snapshot — timer fires may schedule new timers; we don't
    // want to advance those by the same tick.
    const entries = Array.from(timers.entries());
    for (const [id, entry] of entries) {
      entry.remainingMs -= ms;
      if (entry.remainingMs <= 0) {
        timers.delete(id);
        entry.cb();
      }
    }
  };

  // `pendingInjectOptions` — captured by feedDeepgramFinal so that when
  // a buffer eventually fires, the options threaded from the original
  // caller (utteranceId / inResponseTo) reach the dispatcher. Single-
  // slot, last-wins — matches the provider's behaviour where each
  // dispatched final is treated independently.
  let pendingInjectOptions: InjectOptions | null = null;
  const _injectFinalImpl = (text: string, opts: InjectOptions): InjectResult => {
    const normalisedText = normaliseTranscriptText(text);
    cumulativeTranscript = cumulativeTranscript
      ? `${cumulativeTranscript} ${normalisedText}`
      : normalisedText;
    const matchResult = matcher.match(cumulativeTranscript, jobSnapshot);
    const applied = applyRegexMatchToJob(jobSnapshot, matchResult, tracker);
    let changedKeys: string[] = [];
    if (applied) {
      changedKeys = applied.changedKeys;
      jobSnapshot = {
        ...jobSnapshot,
        ...(applied.patch as Partial<JobDetail>),
      };
    }
    const writtenKeys = tracker.consumeTurnWrites();
    const regexResults = buildRegexSummary(writtenKeys, jobSnapshot);
    session.sendTranscript(normalisedText, {
      utteranceId: opts.utteranceId,
      confirmationsEnabled: opts.confirmationsEnabled ?? false,
      regexResults,
      inResponseTo: opts.inResponseTo,
    });
    if (opts.inFlightToolCallId) {
      session.sendAskUserAnswered(opts.inFlightToolCallId, normalisedText, opts.utteranceId);
    }
    return {
      rawText: text,
      normalisedText,
      cumulativeTranscript,
      changedKeys,
      regexResults,
      job: jobSnapshot,
    };
  };

  // Burst buffer feeds into the dispatcher; naming buffer feeds into
  // the burst buffer. Wire order mirrors recording-context.tsx:
  // Deepgram final → naming buffer → burst buffer → dispatch.
  const burstBuffer = new BurstBuffer(
    (text) => {
      _injectFinalImpl(text, pendingInjectOptions ?? {});
    },
    options.burstBufferWindowMs ?? 500,
    schedulerDeps
  );
  const namingBuffer = new NamingBuffer(
    (text, confidence) => {
      burstBuffer.feed(text, confidence);
    },
    options.namingBufferWindowMs ?? 3000,
    schedulerDeps
  );

  return {
    session,
    server,
    getJob: () => jobSnapshot,

    injectFinal(text: string, opts: InjectOptions = {}): InjectResult {
      return _injectFinalImpl(text, opts);
    },

    feedDeepgramFinal(text: string, confidence = 0.9, opts: InjectOptions = {}): void {
      pendingInjectOptions = opts;
      namingBuffer.feed(text, confidence);
    },

    advance,

    flushBuffers(): void {
      namingBuffer.flush();
      burstBuffer.flush();
    },

    async nextWireMessage(): Promise<Record<string, unknown>> {
      const raw = await server.nextMessage;
      const parsed = JSON.parse(raw as string) as Record<string, unknown>;
      trace.push(parsed);
      return parsed;
    },

    async drainWireTrace(): Promise<Record<string, unknown>[]> {
      // jest-websocket-mock queues each `send()` as one entry on
      // `server.messages` (an array of stringified frames). Drain that
      // directly instead of awaiting one-at-a-time so tests can assert
      // batch-shape (e.g. transcript followed immediately by ask_user_answered).
      const all = (server.messages as string[]).slice(trace.length + (swallowHandshake ? 1 : 0));
      const parsed = all.map((raw) => JSON.parse(raw) as Record<string, unknown>);
      trace.push(...parsed);
      return parsed;
    },

    wireTrace: () => trace.slice(),

    pushExtraction(result: ExtractionResult): void {
      server.send(JSON.stringify({ type: 'extraction', result }));
    },

    pushQuestion(q: SonnetQuestion & { tool_call_id?: string | null }): void {
      server.send(JSON.stringify({ type: 'question', ...q }));
    },

    teardown(): void {
      session.disconnect();
      WS.clean();
      localStorage.removeItem('cm_token');
    },
  };
}

/** Build a minimal EICR JobDetail suitable for the harness. Mirrors the
 *  factory in `tests/transcript-field-matcher.test.ts`. */
export function makeHarnessJob(
  circuits: Array<{ ref: string; designation: string }> = []
): JobDetail {
  return {
    id: 'parity-job-id',
    job_id: 'parity-job-id',
    user_id: 'parity-user',
    folder_name: 'parity',
    certificate_type: 'EICR',
    job_address: '1 Parity Lane',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: circuits.map((c, i) => ({
      id: `r${i}`,
      circuit_ref: c.ref,
      circuit_designation: c.designation,
    })),
  } as unknown as JobDetail;
}
