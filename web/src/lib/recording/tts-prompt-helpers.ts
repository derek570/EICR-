'use client';

/**
 * Pure, importable helpers extracted from `recording-context.tsx` so the
 * seams the field bug lived in are unit-testable directly (they otherwise
 * live inside the `openSonnet()`/`openDeepgram()` closures and aren't
 * exported). Each receives its refs/setters explicitly rather than closing
 * over later-declared callbacks — this also sidesteps the hooks TDZ where
 * `handleCancelPendingTts` would reference dismiss-timer helpers declared far
 * below `openSonnet` (§3.3e).
 *
 * Two helpers:
 *  - `handleInspectorStoppedSpeaking` — the shared "inspector finished a
 *    sentence" resume: drains the `deferredTtsRef` question (Symptom-2b fix)
 *    AND releases a deferred CONFIRMATION head (its Symptom-2b clone).
 *  - `handleCancelPendingTts` — the inbound `cancel_pending_tts` handler:
 *    silences the DIRECT prompt (deferred OR in-flight, NOT gated on the
 *    audio window) and clears the cancelled ask STATE everywhere it lingers.
 */

import { clientDiagnostic } from './client-diagnostic';

/** Minimal shape of a deferred direct-prompt (mirror of `deferredTtsRef`). */
export interface DeferredTts {
  text: string;
  toolCallId: string | null;
}

/** Token-paired direct-prompt tracker (mirror of `activeDirectPromptToolCallIdRef`). */
export interface ActiveDirectPrompt {
  toolCallId: string | null;
  token: symbol;
}

/** Minimal question shape (mirror of `SonnetQuestion` — only the fields the
 *  helpers touch). */
export interface CancellableQuestion {
  question?: string;
  tool_call_id?: string | null;
}

interface MutableRef<T> {
  current: T;
}

export interface InspectorStoppedSpeakingDeps {
  deferredTtsRef: MutableRef<DeferredTts | null>;
  /** Dispatch a direct prompt that stays cancellable (sets the direct-prompt
   *  ref/token). MUST be `speakDirectPrompt`, NOT plain `speak` — a plain
   *  drain leaves no active-prompt id so a later `cancel_pending_tts` during
   *  the drained prompt's fetch/playback couldn't silence it. */
  speakDirectPrompt: (text: string, toolCallId: string | null) => void;
  /** Release any CONFIRMATION head deferred while the inspector was speaking. */
  resumeIfDeferred: () => void;
}

/**
 * Inspector stopped speaking (real `onUtteranceEnd` OR the phantom-VAD
 * `speechConfirmTimer` reset). Idempotent — the two sites are normally
 * mutually exclusive per utterance, but a brief real utterance whose first
 * interim lands after the 1.2s confirm timeout can fire BOTH. Safe on
 * double-invocation: the deferred drain nulls the ref BEFORE speaking and
 * `resumeIfDeferred` nulls the deferred head BEFORE playing, so the second
 * call is a no-op (no double-play).
 */
export function handleInspectorStoppedSpeaking(deps: InspectorStoppedSpeakingDeps): void {
  const deferred = deps.deferredTtsRef.current;
  if (deferred) {
    deps.deferredTtsRef.current = null; // null BEFORE speak — idempotency
    clientDiagnostic('tts_deferred_drain', {
      toolCallIdShort: deferred.toolCallId?.slice(0, 12) ?? null,
      textPreview: deferred.text.slice(0, 80),
    });
    deps.speakDirectPrompt(deferred.text, deferred.toolCallId);
  }
  // Release a deferred CONFIRMATION head too — without this it is stranded
  // forever (a Symptom-2b clone for confirmations). Both the question slot and
  // the confirmation queue must resume from the same site.
  deps.resumeIfDeferred();
}

export interface CancelPendingTtsDeps<T extends CancellableQuestion = CancellableQuestion> {
  deferredTtsRef: MutableRef<DeferredTts | null>;
  activeDirectPromptToolCallIdRef: MutableRef<ActiveDirectPrompt | null>;
  /** Cancel the direct prompt's audio, leaving the confirmation FIFO intact. */
  cancelSpeech: (opts?: { resetQueue?: boolean }) => void;
  /** Forward-looking FIFO purge (no-op today — confirmations carry no cancelKey). */
  purgeQueue: (prefix: string) => void;
  /** True iff TTS audio is actively playing (window open) — for the
   *  pending-vs-playing DIAGNOSTIC only; the cancel itself is NOT gated on it. */
  isTtsWindowOpen: () => boolean;
  /** Clear `SonnetSession.inFlightToolCallId` if it starts with prefix. */
  clearSonnetInFlightByPrefix: (prefix: string) => void;
  /** Remove matching pending+active entries from the InFlightQuestionTracker. */
  removeInFlightQuestionByPrefix: (prefix: string) => void;
  /** Generic over the host's concrete question type (e.g. `SonnetQuestion`) so
   *  the real `setQuestions` setter threads through without a type widening. */
  questionsRef: MutableRef<T[]>;
  setQuestions: (qs: T[]) => void;
  dismissTimersRef: MutableRef<Map<string, ReturnType<typeof setTimeout>>>;
}

/**
 * Handle an inbound `cancel_pending_tts { prefix }`. The cancelled focused-mode
 * script prompt rides the DIRECT `speak()`/`deferredTtsRef` path, so:
 *  (b) SILENCE the audio in BOTH direct-path states — a deferred prompt held
 *      in `deferredTtsRef`, and an in-flight (fetching OR playing) prompt
 *      tracked by `activeDirectPromptToolCallIdRef`. The in-flight cancel is
 *      NOT gated on the audio window (gating would miss the pre-audio fetch
 *      window — exactly when a fast backend cancel arrives).
 *  (c) CLEAR the ask STATE everywhere the tool_call_id lingers:
 *      `SonnetSession.inFlightToolCallId`, the InFlightQuestionTracker
 *      pending+active entries, and the visible `questions` (+ dismiss timers).
 *  (d) FORWARD HOOK — `ttsQueue.purge(prefix)` for future fast-path TTS
 *      (no-op today; confirmations carry no cancelKey).
 */
export function handleCancelPendingTts<T extends CancellableQuestion = CancellableQuestion>(
  prefix: string,
  deps: CancelPendingTtsDeps<T>
): void {
  if (!prefix) return;
  let matched: 'deferred' | 'pending' | 'playing' | 'none' = 'none';

  // (b) Deferred prompt.
  const deferred = deps.deferredTtsRef.current;
  if (
    deferred &&
    typeof deferred.toolCallId === 'string' &&
    deferred.toolCallId.startsWith(prefix)
  ) {
    deps.deferredTtsRef.current = null;
    matched = 'deferred';
  }

  // (b) In-flight (fetching OR playing) prompt — active from DISPATCH until its
  // terminal callback. NOT gated on the audio window.
  const active = deps.activeDirectPromptToolCallIdRef.current;
  if (active && typeof active.toolCallId === 'string' && active.toolCallId.startsWith(prefix)) {
    if (matched === 'none') matched = deps.isTtsWindowOpen() ? 'playing' : 'pending';
    // cancelSpeech({resetQueue:false}) fires the prompt's terminal onEnd/onError
    // → recording-context's speakDirectPrompt clears the ref token-guarded.
    deps.cancelSpeech({ resetQueue: false });
  }

  // (d) Forward hook — purge the confirmation FIFO by prefix (no-op today).
  deps.purgeQueue(prefix);

  // (c) Clear the ask STATE.
  deps.clearSonnetInFlightByPrefix(prefix);
  deps.removeInFlightQuestionByPrefix(prefix);

  const prevQs = deps.questionsRef.current;
  const matchesPrefix = (q: CancellableQuestion) =>
    typeof q.tool_call_id === 'string' && q.tool_call_id.startsWith(prefix);
  const removed = prevQs.filter(matchesPrefix);
  if (removed.length > 0) {
    for (const q of removed) {
      if (q.question) {
        const handle = deps.dismissTimersRef.current.get(q.question);
        if (handle) {
          clearTimeout(handle);
          deps.dismissTimersRef.current.delete(q.question);
        }
      }
    }
    const next = prevQs.filter((q) => !matchesPrefix(q));
    deps.questionsRef.current = next;
    deps.setQuestions(next);
  }

  clientDiagnostic('cancel_pending_tts_received', {
    prefixPreview: prefix.slice(0, 24),
    matched,
    questionsRemoved: removed.length,
  });
}
