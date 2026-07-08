/**
 * A4 — FeedbackCapture unit tests (pwa-replay-harness Wave 6).
 * iOS canon: TranscriptProcessor.swift HEAD (processDebugCommand +
 * rolling finals + closeDebugCapture). NO inactivity-timeout tests by
 * design — the 20s timeout exists only on unmerged iOS PR #17.
 */
import { describe, it, expect } from 'vitest';
import { FeedbackCapture } from '@/lib/recording/feedback-capture';

describe('FeedbackCapture — entry marker', () => {
  it('sentence-opener "feedback" starts capture', () => {
    const fc = new FeedbackCapture();
    expect(fc.processCommand('Feedback. The chime is too loud.')).toEqual({
      kind: 'capture_started',
    });
    expect(fc.isCapturing).toBe(true);
  });

  it('legacy "debug" alias starts capture', () => {
    const fc = new FeedbackCapture();
    expect(fc.processCommand('Debug. Um, feedback.').kind).toBe('capture_started');
    expect(fc.isCapturing).toBe(true);
  });

  it('mid-sentence "feedback" does NOT start capture (sentence-opener anchor)', () => {
    const fc = new FeedbackCapture();
    const r = fc.processCommand('The feedback on circuit 3 is ok.');
    expect(r.kind).toBe('normal');
    expect(fc.isCapturing).toBe(false);
  });
});

describe('FeedbackCapture — exit paths (all three)', () => {
  it('multi-utterance close via "end feedback"', () => {
    const fc = new FeedbackCapture();
    fc.processCommand('Feedback.');
    expect(fc.processCommand('The read-back is cutting off early.').kind).toBe(
      'capture_continuing'
    );
    const r = fc.processCommand('End feedback.');
    // iOS-verbatim: the entry final "Feedback." leaves its trailing "."
    // in the buffer (iOS trims whitespace only) — kept for parity.
    expect(r).toEqual({
      kind: 'issue_complete',
      issue: '. The read-back is cutting off early.',
      singleUtterance: false,
    });
    expect(fc.isCapturing).toBe(false);
  });

  it('garble-tolerant utterance-final "and feedback" closes (session 15B88D6B)', () => {
    const fc = new FeedbackCapture();
    fc.processCommand('Feedback. The chime is too loud');
    const r = fc.processCommand('and feedback.');
    expect(r.kind).toBe('issue_complete');
    if (r.kind === 'issue_complete') expect(r.issue).toContain('chime is too loud');
  });

  it('mid-sentence "and feedback" does NOT close (only utterance-final)', () => {
    const fc = new FeedbackCapture();
    fc.processCommand('Feedback.');
    const r = fc.processCommand('the confirmation played and feedback was lost afterwards');
    expect(r.kind).toBe('capture_continuing');
    expect(fc.isCapturing).toBe(true);
  });

  it('single-utterance form: entry + exit in one final', () => {
    const fc = new FeedbackCapture();
    const r = fc.processCommand('Feedback. The Zs read-back repeated twice. End feedback.');
    expect(r).toEqual({
      kind: 'issue_complete',
      issue: '. The Zs read-back repeated twice.', // iOS-verbatim leading dot
      singleUtterance: true,
    });
    expect(fc.isCapturing).toBe(false);
  });
});

describe('FeedbackCapture — session-stop auto-close', () => {
  it('closeCapture returns the open issue (performStopCleanup parity)', () => {
    const fc = new FeedbackCapture();
    fc.processCommand('Feedback. The gate blocked my client name');
    expect(fc.closeCapture()).toBe('. The gate blocked my client name'); // iOS-verbatim
    expect(fc.isCapturing).toBe(false);
  });

  it('closeCapture is null when nothing is open; a bare "Feedback." leaves iOS-verbatim "."', () => {
    const fc = new FeedbackCapture();
    expect(fc.closeCapture()).toBeNull();
    fc.processCommand('Feedback.');
    // iOS-verbatim: buffer holds the trailing "." — iOS uploads it and the
    // BACKEND's >=3-char guard rejects it (the voice_feedback id 7
    // incident that guard exists for). Web matches iOS; the server is the
    // noise filter.
    expect(fc.closeCapture()).toBe('.');
  });
});

describe('FeedbackCapture — 30s rolling pre-trigger window', () => {
  it('keeps only the 30s window, oldest first, max 20 entries', () => {
    let now = 0;
    const fc = new FeedbackCapture({ now: () => now });
    fc.appendRollingFinal('too old', 0);
    now = 40_000;
    fc.appendRollingFinal('recent one', 35_000);
    fc.appendRollingFinal('recent two', 40_000);
    const snap = fc.snapshotRollingFinals();
    expect(snap.map((e) => e.text)).toEqual(['recent one', 'recent two']);
    // entry cap
    for (let i = 0; i < 30; i++) fc.appendRollingFinal(`x${i}`, 40_000 + i);
    expect(fc.snapshotRollingFinals().length).toBeLessThanOrEqual(20);
  });

  it('snapshot is ISO-stamped and reset clears it', () => {
    const fc = new FeedbackCapture({ now: () => 1_700_000_000_000 });
    fc.appendRollingFinal('Ze is 0.35.');
    const snap = fc.snapshotRollingFinals();
    expect(snap[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    fc.resetRollingFinals();
    expect(fc.snapshotRollingFinals()).toEqual([]);
  });
});
