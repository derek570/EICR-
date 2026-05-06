/**
 * Unit tests for the chitchat pause state machine (slice 1).
 * Covers counter increment/reset, threshold trigger, and wake-word
 * matching. WS plumbing is mocked via a `sendEnvelope` capture array.
 */

import {
  CHITCHAT_PAUSE_THRESHOLD,
  CHITCHAT_REPLAY_HORIZON_MS,
  WAKE_REGEX,
  ensureChitchatState,
  turnHadEngagement,
  recordTurn,
  enterChitchatPause,
  exitChitchatPause,
  isWakeWordTranscript,
  bufferTranscript,
  drainReplayBuffer,
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
    expect(turnHadEngagement({ extracted_readings: [{ field: 'ze' }] }, false)).toBe(true);
  });

  test('observations present → engaged', () => {
    expect(turnHadEngagement({ observations: [{ code: 'C2' }] }, false)).toBe(true);
  });

  test('questions present → engaged', () => {
    expect(turnHadEngagement({ questions_for_user: [{ question: 'What rating?' }] }, false)).toBe(
      true
    );
  });

  test('pending ask_user → engaged even with empty result', () => {
    expect(turnHadEngagement({}, true)).toBe(true);
  });

  test('empty result + no pending ask → NOT engaged', () => {
    expect(turnHadEngagement({}, false)).toBe(false);
    expect(
      turnHadEngagement({ extracted_readings: [], observations: [], questions_for_user: [] }, false)
    ).toBe(false);
  });

  test('null/undefined result → not engaged', () => {
    expect(turnHadEngagement(null, false)).toBe(false);
    expect(turnHadEngagement(undefined, false)).toBe(false);
  });
});

describe('recordTurn — counter behaviour', () => {
  test('increments on no-engagement turn', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    recordTurn({
      state,
      result: {},
      pendingAskUser: false,
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
      pendingAskUser: false,
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
        pendingAskUser: false,
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
      pendingAskUser: false,
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
        pendingAskUser: false,
        sendEnvelope: cap.sendEnvelope,
        logger: silentLogger,
      });
    }
    expect(state.turnsSinceExtraction).toBe(6);
    recordTurn({
      state,
      result: { observations: [{ code: 'C2' }] },
      pendingAskUser: false,
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
    });
    expect(state.turnsSinceExtraction).toBe(0);
    for (let i = 0; i < CHITCHAT_PAUSE_THRESHOLD - 1; i += 1) {
      recordTurn({
        state,
        result: {},
        pendingAskUser: false,
        sendEnvelope: cap.sendEnvelope,
        logger: silentLogger,
      });
    }
    expect(state.paused).toBe(false);
  });

  test('pendingAskUser blocks increment — no pause during ask round-trips', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    for (let i = 0; i < 50; i += 1) {
      recordTurn({
        state,
        result: {},
        pendingAskUser: true,
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

describe('slice 2 — regexHintCount in turnHadEngagement / recordTurn', () => {
  test('regexHintCount > 0 alone counts as engagement', () => {
    expect(turnHadEngagement({}, false, 1)).toBe(true);
    expect(turnHadEngagement({}, false, 5)).toBe(true);
  });

  test('regexHintCount === 0 leaves engagement on extraction signals only', () => {
    expect(turnHadEngagement({}, false, 0)).toBe(false);
    expect(turnHadEngagement({ extracted_readings: [{}] }, false, 0)).toBe(true);
  });

  test('recordTurn resets counter when regex hits even on empty Sonnet result', () => {
    const state = ensureChitchatState(makeEntry());
    state.turnsSinceExtraction = 7;
    const cap = makeCapture();
    recordTurn({
      state,
      result: {},
      pendingAskUser: false,
      regexHintCount: 2,
      sendEnvelope: cap.sendEnvelope,
      logger: silentLogger,
    });
    expect(state.turnsSinceExtraction).toBe(0);
    expect(state.paused).toBe(false);
    expect(cap.sent).toEqual([]);
  });

  test('regex-only sessions never pause', () => {
    const state = ensureChitchatState(makeEntry());
    const cap = makeCapture();
    for (let i = 0; i < 50; i += 1) {
      recordTurn({
        state,
        result: {}, // Sonnet caught nothing
        pendingAskUser: false,
        regexHintCount: 1, // regex caught a value every turn
        sendEnvelope: cap.sendEnvelope,
        logger: silentLogger,
      });
    }
    expect(state.paused).toBe(false);
    expect(state.turnsSinceExtraction).toBe(0);
  });
});

describe('slice 2 — replay buffer (bufferTranscript / drainReplayBuffer)', () => {
  test('appends in order, drains in chronological order', () => {
    const state = ensureChitchatState(makeEntry());
    bufferTranscript(state, 'first', 1000);
    bufferTranscript(state, 'second', 2000);
    bufferTranscript(state, 'third', 3000);
    expect(drainReplayBuffer(state, 3500)).toBe('first second third');
    expect(state.replayBuffer).toEqual([]); // cleared after drain
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
    expect(drainReplayBuffer(state, 1000 + CHITCHAT_REPLAY_HORIZON_MS + 100)).toBe('borderline');
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
