/**
 * Unit tests for the chitchat pause state machine (slice 1).
 * Covers counter increment/reset, threshold trigger, and wake-word
 * matching. WS plumbing is mocked via a `sendEnvelope` capture array.
 */

import {
  CHITCHAT_PAUSE_THRESHOLD,
  CHITCHAT_REPLAY_HORIZON_MS,
  CHITCHAT_SUPPRESS_LOG_INTERVAL_MS,
  WAKE_REGEX,
  ensureChitchatState,
  turnHadEngagement,
  recordTurn,
  enterChitchatPause,
  exitChitchatPause,
  isWakeWordTranscript,
  bufferTranscript,
  drainReplayBuffer,
  shouldLogSuppression,
} from '../extraction/chitchat-pause.js';

function makeEntry() {
  return {};
}

function makeCapture() {
  const sent = [];
  return {
    sent,
    sendEnvelope: (e) => sent.push(e),
  };
}

const noop = () => {};
const silentLogger = { info: noop, warn: noop };

describe('ensureChitchatState', () => {
  test('initialises a fresh state with counter 0 and not paused', () => {
    const e = makeEntry();
    const s = ensureChitchatState(e);
    expect(s.turnsSinceExtraction).toBe(0);
    expect(s.paused).toBe(false);
    expect(e.chitchatState).toBe(s);
  });

  test('idempotent — preserves existing state on second call', () => {
    const e = makeEntry();
    const s1 = ensureChitchatState(e);
    s1.turnsSinceExtraction = 5;
    const s2 = ensureChitchatState(e);
    expect(s2).toBe(s1);
    expect(s2.turnsSinceExtraction).toBe(5);
  });

  test('returns null on falsy entry', () => {
    expect(ensureChitchatState(null)).toBeNull();
  });
});

describe('turnHadEngagement', () => {
  test('readings present → engaged', () => {
    expect(turnHadEngagement({ extracted_readings: [{ field: 'ze' }] })).toBe(true);
  });

  test('observations present → engaged', () => {
    expect(turnHadEngagement({ observations: [{ code: 'C2' }] })).toBe(true);
  });

  test('questions present → engaged', () => {
    expect(turnHadEngagement({ questions_for_user: [{ question: 'What rating?' }] })).toBe(true);
  });

  test('empty result → NOT engaged', () => {
    expect(turnHadEngagement({})).toBe(false);
    expect(
      turnHadEngagement({ extracted_readings: [], observations: [], questions_for_user: [] })
    ).toBe(false);
  });

  test('null/undefined result → not engaged', () => {
    expect(turnHadEngagement(null)).toBe(false);
    expect(turnHadEngagement(undefined)).toBe(false);
  });
});

describe('recordTurn — counter behaviour', () => {
  test('increments on no-engagement turn', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    recordTurn({
      state,
      result: {},
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
    });
    expect(state.turnsSinceExtraction).toBe(1);
    expect(state.paused).toBe(false);
    expect(cap.sent).toEqual([]);
  });

  test('resets counter on engagement', () => {
    const state = ensureChitchatState(makeEntry());
    state.turnsSinceExtraction = 4;
    const cap = makeCapture();
    recordTurn({
      state,
      result: { extracted_readings: [{ field: 'ze' }] },
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
    });
    expect(state.turnsSinceExtraction).toBe(0);
  });

  test('fires chitchat_paused at threshold', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    for (let i = 0; i < CHITCHAT_PAUSE_THRESHOLD; i += 1) {
      recordTurn({
        state,
        result: {},
        sendEnvelope: cap.sendEnvelope,
        logger: silentLogger,
      });
    }
    expect(state.paused).toBe(true);
    expect(cap.sent).toEqual([{ type: 'chitchat_paused', threshold: CHITCHAT_PAUSE_THRESHOLD }]);
  });

  test('does not double-fire chitchat_paused if already paused', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    state.paused = true;
    state.turnsSinceExtraction = CHITCHAT_PAUSE_THRESHOLD;
    recordTurn({
      state,
      result: {},
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
    });
    expect(cap.sent).toEqual([]);
  });

  test('engagement during build-up never triggers pause', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    for (let i = 0; i < 6; i += 1) {
      recordTurn({
        state,
        result: {},
        sendEnvelope: cap.sendEnvelope,
        logger: silentLogger,
      });
    }
    expect(state.turnsSinceExtraction).toBe(6);
    recordTurn({
      state,
      result: { observations: [{ code: 'C2' }] },
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
    });
    expect(state.turnsSinceExtraction).toBe(0);
    for (let i = 0; i < CHITCHAT_PAUSE_THRESHOLD - 1; i += 1) {
      recordTurn({
        state,
        result: {},
        sendEnvelope: cap.sendEnvelope,
        logger: silentLogger,
      });
    }
    expect(state.paused).toBe(false);
  });

  test('active question stream blocks pause — questions_for_user keeps the counter at 0', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    for (let i = 0; i < 50; i += 1) {
      recordTurn({
        state,
        result: { questions_for_user: [{ question: 'What rating?' }] },
        sendEnvelope: cap.sendEnvelope,
        logger: silentLogger,
      });
    }
    expect(state.paused).toBe(false);
    expect(state.turnsSinceExtraction).toBe(0);
  });
});

describe('enterChitchatPause / exitChitchatPause', () => {
  test('enter sets paused + pausedAt', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    enterChitchatPause({ state, sendEnvelope: cap.sendEnvelope, logger: silentLogger });
    expect(state.paused).toBe(true);
    expect(typeof state.pausedAt).toBe('number');
    expect(cap.sent[0].type).toBe('chitchat_paused');
  });

  test('exit clears paused + counter, emits resumed envelope with reason', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    state.paused = true;
    state.pausedAt = Date.now() - 1000;
    state.turnsSinceExtraction = CHITCHAT_PAUSE_THRESHOLD;
    exitChitchatPause({
      state,
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
      reason: 'wake_word',
    });
    expect(state.paused).toBe(false);
    expect(state.pausedAt).toBe(null);
    expect(state.turnsSinceExtraction).toBe(0);
    expect(cap.sent).toEqual([{ type: 'chitchat_resumed', reason: 'wake_word' }]);
  });

  test('exit on already-resumed state is a no-op', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    exitChitchatPause({
      state,
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
      reason: 'manual',
    });
    expect(cap.sent).toEqual([]);
  });

  test('enter on already-paused state is a no-op', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    state.paused = true;
    enterChitchatPause({ state, sendEnvelope: cap.sendEnvelope, logger: silentLogger });
    expect(cap.sent).toEqual([]);
  });
});

describe('isWakeWordTranscript / WAKE_REGEX', () => {
  test.each([
    ['resume', true],
    ['Resume', true],
    ['carry on', true],
    ['continue', true],
    ['wake up', true],
    ['go on', true],
    ['back to it', true],
    ['CertMate, resume', true],
    ['CertMate listen', true],
    ['CertMate keep listening', false], // outside the bounded form
    ['I think the answer is forty-two', false],
    ['the resume of the inspection', true], // contains "resume" — accepted
    ['', false],
  ])('%j → %s', (text, expected) => {
    expect(isWakeWordTranscript(text)).toBe(expected);
  });

  test('null / undefined inputs are safe', () => {
    expect(isWakeWordTranscript(null)).toBe(false);
    expect(isWakeWordTranscript(undefined)).toBe(false);
  });

  test('exported WAKE_REGEX matches the helper', () => {
    expect(WAKE_REGEX.test('carry on')).toBe(true);
    expect(WAKE_REGEX.test('idle banter')).toBe(false);
  });
});

describe('slice 2 — regex hits reset the counter at transcript-receipt time', () => {
  // Slice 2's regex-hit engagement signal is implemented in the host
  // (sonnet-stream.js `case 'transcript'` block) by direct counter
  // manipulation when `msg.regexResults.length > 0` arrives, NOT via a
  // parameter on `recordTurn` / `turnHadEngagement`. Reasoning: regex
  // hits are per-transcript signals; recordTurn runs once per Sonnet
  // result which can aggregate multiple transcripts, so attribution
  // would be lossy if it tried to thread regex counts through here.
  // The transcript-receipt reset is exercised by integration tests in
  // src/__tests__/sonnet-stream-chitchat.integration.test.js (M2).

  test('recordTurn alone — empty result increments without regex consideration', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    recordTurn({ state, result: {}, sendEnvelope: cap.sendEnvelope, logger: silentLogger });
    expect(state.turnsSinceExtraction).toBe(1);
  });

  test('direct counter reset (the slice-2 transcript-receipt path simulated)', () => {
    const state = ensureChitchatState(makeEntry());
    state.turnsSinceExtraction = 7;
    // Simulate what the host does when a transcript with regexResults
    // arrives while the session is NOT yet paused: direct reset.
    state.turnsSinceExtraction = 0;
    expect(state.turnsSinceExtraction).toBe(0);
  });
});

describe('slice 3 — cache keep-alive delegated to EICRExtractionSession', () => {
  // Slice 3 is delivered by the session's existing 4-min keepalive
  // (`_sendCacheKeepalive`), which runs for the lifetime of
  // session.isActive. The chitchat helpers must NOT touch any session
  // lifecycle methods, otherwise they'd accidentally tear down the
  // keepalive timer that's keeping Anthropic's 5-min cache hot.
  // This is a guard test — if a future refactor adds a session
  // dependency to enter/exit, the test will surface the issue.

  // Manual call-counter spy. ESM Jest doesn't expose `jest.fn()` as a
  // global (pure-ESM tests use plain JS), so build the stub by hand.
  function makeSessionSpy() {
    const calls = { pause: 0, resume: 0, stop: 0 };
    return {
      session: {
        pause: () => {
          calls.pause += 1;
        },
        resume: () => {
          calls.resume += 1;
        },
        stop: () => {
          calls.stop += 1;
        },
      },
      calls,
    };
  }

  test('enterChitchatPause does not call session.pause()', () => {
    const { session, calls } = makeSessionSpy();
    const entry = { session };
    const state = ensureChitchatState(entry);
    const cap = makeCapture();
    enterChitchatPause({ state, sendEnvelope: cap.sendEnvelope, logger: silentLogger });
    expect(calls).toEqual({ pause: 0, resume: 0, stop: 0 });
  });

  test('exitChitchatPause does not call session.resume()', () => {
    const { session, calls } = makeSessionSpy();
    const entry = { session };
    const state = ensureChitchatState(entry);
    state.paused = true;
    state.pausedAt = Date.now();
    const cap = makeCapture();
    exitChitchatPause({
      state,
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
      reason: 'wake_word',
    });
    expect(calls).toEqual({ pause: 0, resume: 0, stop: 0 });
  });

  test('chitchatState shape contains no session reference / no timer handles', () => {
    const state = ensureChitchatState(makeEntry());
    // The whole state object is data, not behaviour. Should never carry
    // setTimeout / setInterval handles or session references — those
    // belong on the session itself, owned by EICRExtractionSession.
    expect(state).toMatchObject({
      turnsSinceExtraction: 0,
      paused: false,
      pausedAt: null,
      replayBuffer: [],
      lastSuppressLogAt: 0,
    });
    expect(Object.keys(state).sort()).toEqual([
      'lastSuppressLogAt',
      'paused',
      'pausedAt',
      'replayBuffer',
      'turnsSinceExtraction',
    ]);
  });
});

describe('slice 2 — replay buffer (bufferTranscript / drainReplayBuffer)', () => {
  test('appends in order, drains in chronological order with period boundaries', () => {
    const state = ensureChitchatState(makeEntry());
    bufferTranscript(state, 'first', 1000);
    bufferTranscript(state, 'second', 2000);
    bufferTranscript(state, 'third', 3000);
    expect(drainReplayBuffer(state, 3500)).toBe('first. second. third.');
    expect(state.replayBuffer).toEqual([]); // cleared after drain
  });

  test('preserves existing terminal punctuation rather than appending another', () => {
    const state = ensureChitchatState(makeEntry());
    bufferTranscript(state, 'is the kitchen on circuit 3?', 1000);
    bufferTranscript(state, 'right then', 2000);
    expect(drainReplayBuffer(state, 2500)).toBe('is the kitchen on circuit 3? right then.');
  });

  test('drops entries older than CHITCHAT_REPLAY_HORIZON_MS on append', () => {
    const state = ensureChitchatState(makeEntry());
    bufferTranscript(state, 'ancient', 1000);
    // Append at a timestamp far beyond the horizon — old entry evicted.
    bufferTranscript(state, 'fresh', 1000 + CHITCHAT_REPLAY_HORIZON_MS + 5_000);
    expect(state.replayBuffer.length).toBe(1);
    expect(state.replayBuffer[0].text).toBe('fresh');
  });

  test('drain filters out stale entries that slipped past append-time eviction', () => {
    const state = ensureChitchatState(makeEntry());
    // Force two entries into the buffer with widely separated timestamps;
    // simulate a long pause where drain happens far after the first push.
    state.replayBuffer.push({ ts: 1000, text: 'ancient' });
    state.replayBuffer.push({ ts: 1000 + CHITCHAT_REPLAY_HORIZON_MS - 500, text: 'borderline' });
    // Drain at a time where 'ancient' is stale, 'borderline' just inside.
    expect(drainReplayBuffer(state, 1000 + CHITCHAT_REPLAY_HORIZON_MS + 100)).toBe('borderline.');
  });

  test('drain on empty buffer returns empty string, not throw', () => {
    const state = ensureChitchatState(makeEntry());
    expect(drainReplayBuffer(state)).toBe('');
  });

  test('whitespace-only / empty texts are skipped by bufferTranscript', () => {
    const state = ensureChitchatState(makeEntry());
    bufferTranscript(state, '');
    bufferTranscript(state, '   ');
    bufferTranscript(state, null);
    expect(state.replayBuffer.length).toBe(0);
  });

  test('null state is safe — does not throw on either helper', () => {
    expect(() => bufferTranscript(null, 'x')).not.toThrow();
    expect(drainReplayBuffer(null)).toBe('');
  });
});

describe('shouldLogSuppression — throttle for transcript_suppressed log', () => {
  test('first call always logs (lastSuppressLogAt: 0 sentinel)', () => {
    const state = ensureChitchatState(makeEntry());
    expect(shouldLogSuppression(state, 1_000)).toBe(true);
    expect(state.lastSuppressLogAt).toBe(1_000);
  });

  test('rapid second call within the interval skips', () => {
    const state = ensureChitchatState(makeEntry());
    state.lastSuppressLogAt = 1_000;
    expect(shouldLogSuppression(state, 1_500)).toBe(false);
    // sentinel unchanged
    expect(state.lastSuppressLogAt).toBe(1_000);
  });

  test('call past the interval boundary logs again and updates the sentinel', () => {
    const state = ensureChitchatState(makeEntry());
    state.lastSuppressLogAt = 1_000;
    const after = 1_000 + CHITCHAT_SUPPRESS_LOG_INTERVAL_MS;
    expect(shouldLogSuppression(state, after)).toBe(true);
    expect(state.lastSuppressLogAt).toBe(after);
  });

  test('exitChitchatPause resets the sentinel so the next pause cycle logs first-suppression', () => {
    const state = ensureChitchatState(makeEntry());
    state.paused = true;
    state.pausedAt = Date.now();
    state.lastSuppressLogAt = Date.now();
    const cap = makeCapture();
    exitChitchatPause({
      state,
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
      reason: 'wake_word',
    });
    expect(state.lastSuppressLogAt).toBe(0);
  });

  test('null state is safe', () => {
    expect(shouldLogSuppression(null)).toBe(false);
  });
});
