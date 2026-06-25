/**
 * sonnet-stream-observation-update-regulation.test.js
 *
 * Plan 06-23 obs-#52 Fix B — every `observation_update` wire payload must carry
 * the canonical BS 7671 `regulation_title` / `regulation_description` so the iOS
 * observation card can prefer the authoritative table wording over the model's
 * `suggested_regulation` string on a table HIT.
 *
 * This file pins the RULE-6 code-correction edit path
 * (`dispatchObservationUpdates`), exported as a test seam. It is the cleanest of
 * the three observation_update emitters (a pure `ws.send` loop with no async
 * web-search dependency). The two refinement-path payloads
 * (`sonnet-stream.js` live + replayed-cached) use the byte-identical
 * `lookupRegulation(ref)?.title ?? null` idiom; that idiom's HIT/MISS behaviour
 * is locked by `regulation-lookup.test.js`, so this test + the lookup unit test
 * jointly cover all three payloads' canonical-wording contract.
 *
 * REQUIREMENT: obs-#52 Fix B end-to-end (Resolved decision 2).
 */

import { jest } from '@jest/globals';

// sonnet-stream.js is a WS-server entrypoint; importing it cascades into
// storage.js (`import.meta.dirname`, undefined under jest's experimental-vm-
// modules) and the logger. Mock those side-effect modules then dynamic-import,
// exactly as the sibling sonnet-stream-*.test.js files do. CRUCIALLY do NOT
// mock regulation-lookup.js — the whole point is to exercise the REAL canonical
// table lookup (it reads config/bs7671-regulations.json via fileURLToPath, which
// works fine under jest).
jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { _test_dispatchObservationUpdates } = await import('../extraction/sonnet-stream.js');

/** Minimal fake ws that captures the JSON payloads passed to ws.send. */
function makeFakeWs() {
  const sent = [];
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(raw)),
    sent,
  };
}

describe('dispatchObservationUpdates — canonical regulation wording (obs-#52 Fix B)', () => {
  test('RULE-6 edit whose ref is a table HIT carries canonical title + description', () => {
    const ws = makeFakeWs();
    _test_dispatchObservationUpdates(ws, 'sess-1', [
      {
        observation_id: 'obs-1',
        observation_text: 'Exposed-conductive-parts not connected to earth',
        code: 'C2',
        // 411.3.3 is present in config/bs7671-regulations.json (a table HIT).
        regulation: '411.3.3',
        rationale: 'no protective earthing on exposed metalwork',
      },
    ]);
    expect(ws.sent).toHaveLength(1);
    const payload = ws.sent[0];
    expect(payload.type).toBe('observation_update');
    expect(payload.source).toBe('rule_6_edit');
    expect(payload.regulation).toBe('411.3.3');
    // Canonical BS 7671:2018+A2:2022 wording from the table.
    expect(payload.regulation_title).toBe('ADS - Protective earthing');
    expect(payload.regulation_description).toMatch(/protective conductor/i);
  });

  test('RULE-6 edit whose ref MISSES the table falls back to null (iOS shows model wording)', () => {
    const ws = makeFakeWs();
    _test_dispatchObservationUpdates(ws, 'sess-2', [
      {
        observation_id: 'obs-2',
        observation_text: 'Some defect',
        code: 'C3',
        // 411.3.4 is NOT in the table (the tool schema cites it but the table is
        // versioned BS 7671:2018+A2:2022) — a deliberate MISS.
        regulation: '411.3.4',
      },
    ]);
    const payload = ws.sent[0];
    expect(payload.regulation).toBe('411.3.4');
    expect(payload.regulation_title).toBeNull();
    expect(payload.regulation_description).toBeNull();
  });

  test('RULE-6 edit with no regulation carries null canonical fields (no crash)', () => {
    const ws = makeFakeWs();
    _test_dispatchObservationUpdates(ws, 'sess-3', [
      { observation_id: 'obs-3', observation_text: 'Defect', code: 'C2' /* no regulation */ },
    ]);
    const payload = ws.sent[0];
    expect(payload.regulation).toBeNull();
    expect(payload.regulation_title).toBeNull();
    expect(payload.regulation_description).toBeNull();
  });
});
