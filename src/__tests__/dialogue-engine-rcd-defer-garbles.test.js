/**
 * RCD defer-trigger garble coverage (2026-05-31).
 *
 * Field repro — session E8C6B716-547A-454C-A507-5D3079F7E24D:
 * inspector heard "What's the BS number? Or do you want to fill that
 * in later?" and tried to defer four times in 12 seconds with
 * Deepgram-garbled replies that the pre-2026-05-31 regex set didn't
 * recognise:
 *
 *   "you filled in."         (intended: "fill it in [later]")
 *   "in later."              (intended: "fill it in later" — lead clipped)
 *
 * Each reply reached the engine (gate forwarded, `ask_user_answered_
 * routed_to_engine` event fired) but the defer regex set in
 * rcd.js's `deferTriggers` matched none, so the engine re-emitted
 * the same prompt every ~6 seconds. The session ended at "Oh, fuck
 * off." then "I give up. Stop." (cancel).
 *
 * Fix widens the regex set:
 *   - Leading-"later" anchor now tolerates ≤ 2 lead words so "in
 *     later.", "and later.", "uh later." defer.
 *   - Short-reply "leave it/that/them" and Deepgram garbles of
 *     "filled in" / "filed in" / "skip for later" all defer too.
 *
 * Negative coverage stays explicit: anything ≥ 3 lead words or a
 * sentence containing "later" in a non-defer context must NOT
 * defer.
 */

import { processProtectiveDeviceTurn } from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_rcd_defer_garbles';

class FakeWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
  };
}

function enterRcdAt(ws, session, time = 1000) {
  processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: 'RCD on circuit 5.',
    now: time,
  });
}

function expectDeferred(ws, session) {
  expect(ws.sent.at(-1).reason).toBe('info');
  expect(ws.sent.at(-1).question).toBe("Okay, I'll come back to that later.");
  expect(session.dialogueScriptState).toBeFalsy();
}

describe('RCD defer — Deepgram garble coverage (positive)', () => {
  test.each([
    // Field-observed garbles.
    'in later.',
    'in later',
    'you filled in.',
    'filled in.',
    'filed in.',
    'fill it in.',
    // Leading-prefix variants.
    'and later.',
    'uh later.',
    'okay later.',
    // "leave it" family.
    'leave it.',
    'leave that.',
    'leave it for later.',
    'leave them.',
    // skip-for-later variant.
    'skip for later.',
    'skip until later.',
  ])('inspector reply %p triggers defer', (transcriptText) => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    enterRcdAt(ws, session);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText,
      now: 2000,
    });
    expectDeferred(ws, session);
  });

  test('canonical "later." still defers (regression guard)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    enterRcdAt(ws, session);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'later.',
      now: 2000,
    });
    expectDeferred(ws, session);
  });

  test('canonical "fill it in later" still defers (regression guard)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    enterRcdAt(ws, session);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'fill it in later',
      now: 2000,
    });
    expectDeferred(ws, session);
  });
});

describe('RCD defer — negative cases (must NOT defer)', () => {
  // Scope note: the pre-existing verb-prefix patterns (`fill … later`,
  // `do … later`, `(?:come\s+)?back … later`) match wherever they
  // appear in the utterance — not at the end. That means a sentence
  // like "we can come back to it later but right now the BS is
  // 60898" still defers today, which is wrong. Fixing that requires
  // tightening every verb-prefix regex to require near-end-of-string
  // and validating against the existing canonical tests in
  // dialogue-engine-pd.test.js. Tracked separately; out of scope for
  // the 2026-05-31 garble-coverage fix below.
  test.each([
    // ≥ 3 lead words before "later" — the prefix-bound regex must reject.
    "I'll deal with that later",
    'remind me about that later please',
    // "later" embedded mid-sentence (not at end).
    'later that night we tested the circuit',
    // Long sentence containing "filled" in a non-defer context must not
    // match the short-reply `filled in` clause (cap is 30 chars + 20).
    'we left the cover off and filled in the gap with mastic from the back',
  ])('inspector reply %p does NOT defer', (transcriptText) => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    enterRcdAt(ws, session);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText,
      now: 2000,
    });
    // No defer info TTS, script stays alive.
    expect(ws.sent.some((m) => m.question === "Okay, I'll come back to that later.")).toBe(false);
    expect(session.dialogueScriptState).toBeTruthy();
    expect(session.dialogueScriptState.active).toBe(true);
  });
});
