/**
 * Integration tests for the two pure helpers extracted from
 * `recording-context.tsx` (§4 test seam): `handleInspectorStoppedSpeaking`
 * (the Symptom-2b deferred-question drain + confirmation resume) and
 * `handleCancelPendingTts` (the `cancel_pending_tts` silence + ask-state clear).
 * These are the seams the field bug lived in; driving them directly (rather
 * than a full provider harness) is the plan's preferred, actionable seam.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCancelPendingTts,
  handleInspectorStoppedSpeaking,
  type ActiveDirectPrompt,
  type CancellableQuestion,
  type DeferredTts,
} from '@/lib/recording/tts-prompt-helpers';

function ref<T>(value: T): { current: T } {
  return { current: value };
}

describe('handleInspectorStoppedSpeaking', () => {
  it('drains a deferred DIRECT prompt via speakDirectPrompt (Symptom-2b fix) and resumes the FIFO', () => {
    const deferredTtsRef = ref<DeferredTts | null>({
      text: 'Which circuit?',
      toolCallId: 'srv-ir-1',
    });
    const speakDirectPrompt = vi.fn();
    const resumeIfDeferred = vi.fn();
    handleInspectorStoppedSpeaking({ deferredTtsRef, speakDirectPrompt, resumeIfDeferred });
    expect(speakDirectPrompt).toHaveBeenCalledWith('Which circuit?', 'srv-ir-1');
    expect(deferredTtsRef.current).toBeNull(); // nulled BEFORE speak
    expect(resumeIfDeferred).toHaveBeenCalledTimes(1);
  });

  it('resumes the confirmation FIFO even when there is no deferred question', () => {
    const deferredTtsRef = ref<DeferredTts | null>(null);
    const speakDirectPrompt = vi.fn();
    const resumeIfDeferred = vi.fn();
    handleInspectorStoppedSpeaking({ deferredTtsRef, speakDirectPrompt, resumeIfDeferred });
    expect(speakDirectPrompt).not.toHaveBeenCalled();
    expect(resumeIfDeferred).toHaveBeenCalledTimes(1); // Symptom-2b clone fix
  });

  it('is idempotent — both speaking-ended sites firing for one utterance drains ONCE', () => {
    const deferredTtsRef = ref<DeferredTts | null>({ text: 'Q', toolCallId: null });
    const speakDirectPrompt = vi.fn();
    const resumeIfDeferred = vi.fn();
    const deps = { deferredTtsRef, speakDirectPrompt, resumeIfDeferred };
    handleInspectorStoppedSpeaking(deps); // e.g. phantom-reset
    handleInspectorStoppedSpeaking(deps); // e.g. onUtteranceEnd
    expect(speakDirectPrompt).toHaveBeenCalledTimes(1); // no double-play
  });
});

describe('handleCancelPendingTts', () => {
  interface Harness {
    deferredTtsRef: { current: DeferredTts | null };
    activeDirectPromptToolCallIdRef: { current: ActiveDirectPrompt | null };
    cancelSpeech: ReturnType<typeof vi.fn<(opts?: { resetQueue?: boolean }) => void>>;
    purgeQueue: ReturnType<typeof vi.fn<(prefix: string) => void>>;
    clearSonnetInFlightByPrefix: ReturnType<typeof vi.fn<(prefix: string) => void>>;
    removeInFlightQuestionByPrefix: ReturnType<typeof vi.fn<(prefix: string) => void>>;
    questionsRef: { current: CancellableQuestion[] };
    setQuestions: ReturnType<typeof vi.fn<(qs: CancellableQuestion[]) => void>>;
    dismissTimersRef: { current: Map<string, ReturnType<typeof setTimeout>> };
    windowOpen: boolean;
  }

  let h: Harness;

  function deps() {
    return {
      deferredTtsRef: h.deferredTtsRef,
      activeDirectPromptToolCallIdRef: h.activeDirectPromptToolCallIdRef,
      cancelSpeech: h.cancelSpeech,
      purgeQueue: h.purgeQueue,
      isTtsWindowOpen: () => h.windowOpen,
      clearSonnetInFlightByPrefix: h.clearSonnetInFlightByPrefix,
      removeInFlightQuestionByPrefix: h.removeInFlightQuestionByPrefix,
      questionsRef: h.questionsRef,
      setQuestions: h.setQuestions,
      dismissTimersRef: h.dismissTimersRef,
    };
  }

  beforeEach(() => {
    h = {
      deferredTtsRef: ref<DeferredTts | null>(null),
      activeDirectPromptToolCallIdRef: ref<ActiveDirectPrompt | null>(null),
      cancelSpeech: vi.fn<(opts?: { resetQueue?: boolean }) => void>(),
      purgeQueue: vi.fn<(prefix: string) => void>(),
      clearSonnetInFlightByPrefix: vi.fn<(prefix: string) => void>(),
      removeInFlightQuestionByPrefix: vi.fn<(prefix: string) => void>(),
      questionsRef: ref<CancellableQuestion[]>([]),
      setQuestions: vi.fn<(qs: CancellableQuestion[]) => void>(),
      dismissTimersRef: ref(new Map<string, ReturnType<typeof setTimeout>>()),
      windowOpen: false,
    };
  });

  it('(a) clears a DEFERRED matching prompt', () => {
    h.deferredTtsRef.current = { text: 'BS number?', toolCallId: 'srv-ir-1' };
    handleCancelPendingTts('srv-ir-', deps());
    expect(h.deferredTtsRef.current).toBeNull();
    // No in-flight prompt → no audio cancel needed.
    expect(h.cancelSpeech).not.toHaveBeenCalled();
  });

  it('(b) IN-FLIGHT FETCH (pre-onStart, window CLOSED) still cancels — NOT gated on the window (Codex R1 BLOCKER)', () => {
    h.activeDirectPromptToolCallIdRef.current = { toolCallId: 'srv-ir-1', token: Symbol() };
    h.windowOpen = false; // fetch in flight, no audio yet
    handleCancelPendingTts('srv-ir-', deps());
    expect(h.cancelSpeech).toHaveBeenCalledWith({ resetQueue: false });
  });

  it('(b) PLAYING (window open) cancels too', () => {
    h.activeDirectPromptToolCallIdRef.current = { toolCallId: 'srv-ir-1', token: Symbol() };
    h.windowOpen = true;
    handleCancelPendingTts('srv-ir-', deps());
    expect(h.cancelSpeech).toHaveBeenCalledWith({ resetQueue: false });
  });

  it('does NOT cancel a NON-matching in-flight prompt', () => {
    h.activeDirectPromptToolCallIdRef.current = { toolCallId: 'srv-other-9', token: Symbol() };
    handleCancelPendingTts('srv-ir-', deps());
    expect(h.cancelSpeech).not.toHaveBeenCalled();
  });

  it('(c) clears the ask STATE everywhere + (d) purges the FIFO by prefix', () => {
    const timer = setTimeout(() => {}, 10_000);
    h.dismissTimersRef.current.set('BS number?', timer);
    h.questionsRef.current = [
      { question: 'BS number?', tool_call_id: 'srv-ir-1' },
      { question: 'unrelated', tool_call_id: 'other-2' },
    ];
    handleCancelPendingTts('srv-ir-', deps());
    // (d) forward hook
    expect(h.purgeQueue).toHaveBeenCalledWith('srv-ir-');
    // (c) SonnetSession + tracker
    expect(h.clearSonnetInFlightByPrefix).toHaveBeenCalledWith('srv-ir-');
    expect(h.removeInFlightQuestionByPrefix).toHaveBeenCalledWith('srv-ir-');
    // (c) questions UI — the matching entry removed, the other kept
    expect(h.setQuestions).toHaveBeenCalledTimes(1);
    const next = h.setQuestions.mock.calls[0][0] as CancellableQuestion[];
    expect(next.map((q) => q.tool_call_id)).toEqual(['other-2']);
    expect(h.questionsRef.current.map((q) => q.tool_call_id)).toEqual(['other-2']);
    // (c) dismiss timer for the removed question cleared
    expect(h.dismissTimersRef.current.has('BS number?')).toBe(false);
    clearTimeout(timer);
  });

  it('an empty prefix is a no-op', () => {
    h.deferredTtsRef.current = { text: 'x', toolCallId: 'srv-ir-1' };
    handleCancelPendingTts('', deps());
    expect(h.deferredTtsRef.current).not.toBeNull();
    expect(h.cancelSpeech).not.toHaveBeenCalled();
    expect(h.purgeQueue).not.toHaveBeenCalled();
  });

  it('deferred-drain stays cancellable (round-3/4): a drained prompt is then silenced pre-onStart', () => {
    // Simulate: the inspector stopped speaking → the deferred prompt was drained
    // via speakDirectPrompt, which set activeDirectPromptToolCallIdRef and left
    // deferredTtsRef null. A cancel_pending_tts then arrives DURING the drained
    // prompt's fetch (pre-onStart). The in-flight cancel must fire.
    h.deferredTtsRef.current = null; // already drained
    h.activeDirectPromptToolCallIdRef.current = { toolCallId: 'srv-ir-1', token: Symbol() };
    h.windowOpen = false; // pre-audio fetch
    handleCancelPendingTts('srv-ir-', deps());
    expect(h.cancelSpeech).toHaveBeenCalledWith({ resetQueue: false });
    expect(h.clearSonnetInFlightByPrefix).toHaveBeenCalledWith('srv-ir-');
    expect(h.removeInFlightQuestionByPrefix).toHaveBeenCalledWith('srv-ir-');
  });
});
