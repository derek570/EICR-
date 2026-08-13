/**
 * Codex diff-review cycle 5 (G2a) — `runShadowHarness`'s Plan 00 evaluation
 * binding of the regex fast-path correlation id(s) onto the OPEN turn scope
 * (stage6-shadow-harness.js, the `plan00MutationObserver.bindFastCorrelation`
 * call near the top of `runShadowHarness`, right after `enterTurnScope`).
 *
 * THE BUG: that call site checked `typeof options.regexFastCorrelationId ===
 * 'string'` only. Plan B's B1.1 wire shape is `regexFastCorrelationIds:
 * [String]?` — iOS can fast-dispatch MULTIPLE correlations in one utterance
 * (one per slot in a multi-write turn), and `options.regexFastCorrelationId`
 * carries that same string-OR-ARRAY value at every call site that reads it
 * (see `mergeFastPathCorrelationIds`'s own doc comment). A turn with an
 * array value failed the `typeof === 'string'` guard entirely, so NONE of
 * its correlations were bound for evaluation — only the production
 * turn-tracking map (`entry.fastPathCorrelationIdByTurn`, seeded separately
 * inside `runLiveMode` via `mergeFastPathCorrelationIds`, which already
 * handled the array shape) ever learned about them.
 *
 * THE FIX: the call site now uses the SAME shared `coerceFastPathCorrelationIds`
 * coercion `mergeFastPathCorrelationIds` uses, and calls `bindFastCorrelation`
 * once per coerced id (that method binds ONE id at a time by design).
 *
 * This drives `runShadowHarness` directly with `toolCallsMode: 'off'` (the
 * same minimal "Anchor A" seam `plan00-turn-scope-latch.test.js` uses) so the
 * dispatch reduces to one `session.extractFromUtterance` call — isolating the
 * turn-scope-entry binding site from the (separately tested) live tool loop.
 */

import { jest, describe, test, expect } from '@jest/globals';

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { createMutationObserver, attachMutationObserver } =
  await import('../extraction/plan00-semantic-capture.js');

function makeSession() {
  return {
    sessionId: 'sess-g2a-eval-bind',
    toolCallsMode: 'off',
    costTracker: { recordInspectorExtractionTurn: jest.fn() },
    extractFromUtterance: jest.fn(async () => ({
      extracted_readings: [],
      observations: [],
      questions_for_user: [],
    })),
  };
}

describe('Codex diff-review cycle 5 (G2a) — evaluation binding of ALL fast-path correlation ids', () => {
  test('an ARRAY of correlation ids binds every one, not just the first', async () => {
    const observer = createMutationObserver({ sessionId: 'sess-g2a-eval-bind' });
    const session = makeSession();
    attachMutationObserver(session, observer);

    await runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], {
      extractionTurnId: 'turn-g2a-1',
      regexFastCorrelationId: ['cid-a', 'cid-b', 'cid-c'],
    });

    expect(observer.fastCorrelationTurn('cid-a')).toBe('turn-g2a-1');
    expect(observer.fastCorrelationTurn('cid-b')).toBe('turn-g2a-1');
    expect(observer.fastCorrelationTurn('cid-c')).toBe('turn-g2a-1');
    expect(observer.invalid).toBeNull();
  });

  test('the legacy single-string shape still binds (no regression from the coercion refactor)', async () => {
    const observer = createMutationObserver({ sessionId: 'sess-g2a-eval-bind' });
    const session = makeSession();
    attachMutationObserver(session, observer);

    await runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], {
      extractionTurnId: 'turn-g2a-2',
      regexFastCorrelationId: 'cid-solo',
    });

    expect(observer.fastCorrelationTurn('cid-solo')).toBe('turn-g2a-2');
    expect(observer.invalid).toBeNull();
  });

  test('a malformed array entry (non-string / empty) is silently dropped, valid siblings still bind', async () => {
    const observer = createMutationObserver({ sessionId: 'sess-g2a-eval-bind' });
    const session = makeSession();
    attachMutationObserver(session, observer);

    await runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], {
      extractionTurnId: 'turn-g2a-3',
      regexFastCorrelationId: ['cid-valid', 42, null, '', 'cid-valid-2'],
    });

    expect(observer.fastCorrelationTurn('cid-valid')).toBe('turn-g2a-3');
    expect(observer.fastCorrelationTurn('cid-valid-2')).toBe('turn-g2a-3');
    expect(observer.invalid).toBeNull();
  });

  test('no correlation id at all — no bind attempted, no error', async () => {
    const observer = createMutationObserver({ sessionId: 'sess-g2a-eval-bind' });
    const session = makeSession();
    attachMutationObserver(session, observer);

    const out = await runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], {
      extractionTurnId: 'turn-g2a-4',
    });

    expect(out).toBeTruthy();
    expect(observer.invalid).toBeNull();
  });
});
