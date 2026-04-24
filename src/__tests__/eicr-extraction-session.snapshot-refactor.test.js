/**
 * Stage 6 Plan 04-02 — cached-prefix state-snapshot refactor tests.
 *
 * Locks the mode-gated behaviour from Plan 04-02:
 *
 *   (a) `off` mode: snapshot appears in the MESSAGES array (legacy path),
 *       system array is a single block, byte-identical to pre-Phase-4.
 *   (b) `shadow`/`live` modes: snapshot lives in the SYSTEM array as a
 *       second cache_control ephemeral 5m block; messages array contains
 *       ONLY the sliding-window exchanges.
 *   (c) Empty snapshot in non-off mode → system is a SINGLE-element array
 *       (never two-element with empty-string block — that would break
 *       Anthropic's cache key).
 *   (d) `_sendCacheKeepalive` mirrors the split.
 *   (e) `buildUserMessage` in non-off mode omits CIRCUIT SCHEDULE,
 *       "Already asked", and "Observations already created" — those live
 *       in the cached prefix.
 *
 * The Plan-02-01 regression tests (updateStateSnapshot atoms) remain here
 * too because the refactor must not disturb them.
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}));

const {
  EICRExtractionSession,
  EICR_SYSTEM_PROMPT,
  EIC_SYSTEM_PROMPT,
  EICR_AGENTIC_SYSTEM_PROMPT,
} = await import('../extraction/eicr-extraction-session.js');

// ---------------------------------------------------------------------------
// Plan 02-01 Task 4 regression guard — shared snapshot mutator atoms.
// Kept from the prior version of this file. If these break, something
// more fundamental than Plan 04-02 has moved.
// ---------------------------------------------------------------------------
describe('eicr-extraction-session.updateStateSnapshot — Plan 02-01 Task 4 refactor', () => {
  test('extracted_readings + field_clears round-trip through shared mutator atoms', () => {
    const session = new EICRExtractionSession('test-key-unused', 'test-session-01');
    expect(session.stateSnapshot.circuits).toEqual({});

    session.updateStateSnapshot({
      extracted_readings: [{ circuit: 3, field: 'Ze_ohms', value: '0.35' }],
    });
    expect(session.stateSnapshot.circuits[3]).toEqual({ Ze_ohms: '0.35' });

    session.updateStateSnapshot({
      field_clears: [{ circuit: 3, field: 'Ze_ohms' }],
    });
    expect(session.stateSnapshot.circuits[3]).toEqual({});
  });

  test('null result is a noop (legacy guard preserved)', () => {
    const session = new EICRExtractionSession('test-key-unused', 'test-session-02');
    session.updateStateSnapshot(null);
    expect(session.stateSnapshot).toEqual({
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Plan 04-02 — new mode-gated suites.
// ---------------------------------------------------------------------------

describe('Plan 04-02 — constructor prompt selection (mode-gated)', () => {
  test("toolCallsMode='off' + certType='eicr' selects legacy EICR prompt", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    expect(s.systemPrompt).toBe(EICR_SYSTEM_PROMPT);
    expect(s.toolCallsMode).toBe('off');
  });

  test("toolCallsMode='off' + certType='eic' selects legacy EIC prompt", () => {
    const s = new EICRExtractionSession('k', 's', 'eic', { toolCallsMode: 'off' });
    expect(s.systemPrompt).toBe(EIC_SYSTEM_PROMPT);
  });

  test("toolCallsMode='shadow' selects the agentic prompt (cert-agnostic)", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    expect(s.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
    expect(s.systemPrompt).not.toBe(EICR_SYSTEM_PROMPT);
  });

  test("toolCallsMode='live' + certType='eic' also selects agentic (cert-agnostic)", () => {
    const s = new EICRExtractionSession('k', 's', 'eic', { toolCallsMode: 'live' });
    expect(s.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
    expect(s.systemPrompt).not.toBe(EIC_SYSTEM_PROMPT);
  });
});

describe('Plan 04-02 — buildSystemBlocks', () => {
  test("off mode: always single-block array with base prompt + cache_control ephemeral 5m", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    // Seed snapshot so, if off-mode logic leaked, a second block would appear.
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    const blocks = s.buildSystemBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toBe(EICR_SYSTEM_PROMPT);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  test("shadow mode + empty snapshot → single-block array (empty snapshot collapses)", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    // No circuits, no schedule, no observations — snapshot is null.
    const blocks = s.buildSystemBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  test("shadow mode + non-empty snapshot → two-block array; block[1] is the snapshot", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    const blocks = s.buildSystemBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].text).toContain('EXTRACTED');
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  test("live mode behaves identically to shadow for buildSystemBlocks", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'live' });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    const blocks = s.buildSystemBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
    expect(blocks[1].text).toContain('EXTRACTED');
  });
});

describe('Plan 04-02 — buildMessageWindow mode gating', () => {
  test("off mode: snapshot appears as user/assistant pair in the window (legacy)", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    const window = s.buildMessageWindow();
    // Pre-Phase-4 behaviour: snapshot pair + empty conversationHistory.
    expect(window).toHaveLength(2);
    expect(window[0].role).toBe('user');
    expect(window[0].content[0].text).toContain('EXTRACTED');
    expect(window[1].role).toBe('assistant');
    expect(window[1].content[0].text).toBe('{"acknowledged": true}');
  });

  test("shadow mode: window is ONLY the conversationHistory slice, no snapshot pair", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    const window = s.buildMessageWindow();
    // No snapshot pair. conversationHistory is empty, so window length 0.
    expect(window).toHaveLength(0);
    // Extra guard: if any message DID land in the window, its text must not
    // include the snapshot marker — the snapshot lives in the system array.
    for (const msg of window) {
      const text = Array.isArray(msg.content)
        ? msg.content.map((b) => b.text || '').join('')
        : String(msg.content);
      expect(text).not.toContain('EXTRACTED');
    }
  });

  test("live mode: same as shadow — no snapshot pair in window", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'live' });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    const window = s.buildMessageWindow();
    expect(window).toHaveLength(0);
  });

  test("shadow mode: circuit schedule never leaks into any window message", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.updateJobState({
      circuits: [{ ref: '1', designation: 'Ring Final', ocpd_type: 'B', ocpd_rating: 32 }],
    });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    const window = s.buildMessageWindow();
    const asJson = JSON.stringify(window);
    expect(asJson).not.toContain('CIRCUIT SCHEDULE');
  });

  test("off + shadow: conversationHistory slice is identical across modes given the same input", () => {
    const seed = (mode) => {
      const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: mode });
      // Push a fake user/assistant exchange.
      s.conversationHistory.push(
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"acknowledged":true}' }] }
      );
      return s;
    };
    const off = seed('off');
    const shadow = seed('shadow');
    // In off mode: snapshot is null → no snapshot pair → window is [user, assistant].
    // In shadow mode: window is [user, assistant] (conv history verbatim).
    // Both slice the same tail; assert the final two entries match.
    const offWindow = off.buildMessageWindow();
    const shadowWindow = shadow.buildMessageWindow();
    expect(offWindow.slice(-2)).toEqual(shadowWindow.slice(-2));
  });
});

describe('Plan 04-02 — _sendCacheKeepalive mode gating', () => {
  beforeEach(() => mockCreate.mockReset());

  test("off mode keepalive: snapshot user/assistant pair PLUS [keepalive], system is single-block", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"acknowledged":true}' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    s.isActive = true;
    await s._sendCacheKeepalive();
    s.isActive = false;
    s._clearCacheKeepalive();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0][0];
    // System = single block (legacy).
    expect(payload.system).toHaveLength(1);
    expect(payload.system[0].text).toBe(EICR_SYSTEM_PROMPT);
    // Messages = [snapshot user, ack assistant, keepalive user].
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0].role).toBe('user');
    expect(payload.messages[0].content[0].text).toContain('EXTRACTED');
    expect(payload.messages[1].role).toBe('assistant');
    expect(payload.messages[2].role).toBe('user');
    expect(payload.messages[2].content[0].text).toBe('[keepalive]');
  });

  test("shadow mode keepalive: messages is ONLY [keepalive], system is two-block when snapshot non-empty", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"acknowledged":true}' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    s.isActive = true;
    await s._sendCacheKeepalive();
    s.isActive = false;
    s._clearCacheKeepalive();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0][0];
    // System = two blocks (base prompt + snapshot).
    expect(payload.system).toHaveLength(2);
    expect(payload.system[0].text).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
    expect(payload.system[1].text).toContain('EXTRACTED');
    // Messages = [keepalive] only.
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].role).toBe('user');
    expect(payload.messages[0].content[0].text).toBe('[keepalive]');
  });
});

describe('Plan 04-02 — buildUserMessage per-turn minimalism in non-off mode', () => {
  test("off mode: circuit schedule appears on first call (unchanged)", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.circuitSchedule = '  Circuit 1: Kitchen Sockets []';
    const msg = s.buildUserMessage('test utterance');
    expect(msg).toContain('CIRCUIT SCHEDULE');
    expect(msg).toContain('Circuit 1: Kitchen Sockets');
  });

  test("shadow mode: circuit schedule NEVER appears in buildUserMessage output", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.circuitSchedule = '  Circuit 1: Kitchen Sockets []';
    const msg = s.buildUserMessage('test utterance');
    expect(msg).not.toContain('CIRCUIT SCHEDULE');
    expect(msg).not.toContain('Circuit 1: Kitchen Sockets');
    // Transcript text still present — this is the per-turn surface.
    expect(msg).toContain('test utterance');
  });

  test("shadow mode: 'Already asked' and 'Observations already created' are suppressed", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.askedQuestions = ['zs:1', 'r2:2'];
    s.extractedObservations = [
      { id: 'id-a', text: 'missing earth bond at kitchen', code: 'C2' },
    ];
    const msg = s.buildUserMessage('hello');
    expect(msg).not.toContain('Already asked');
    expect(msg).not.toContain('Observations already created');
  });
});

// ---------------------------------------------------------------------------
// Plan 04-08 (r2-#1) — cached-prefix digest regression.
//
// WHY THIS GROUP EXISTS: Codex r2 (2026-04-23) found that Plan 04-02's
// buildUserMessage refactor suppresses the `Already asked` + `Observations
// already created` digests in non-off modes but does NOT re-home them into
// the cached prefix (buildStateSnapshotMessage / buildSystemBlocks). Shadow
// + live lost two existing anti-re-ask / dedup guards that off-mode still
// enjoys. These are the backstops that tell Sonnet (a) don't re-ask
// field:circuit pairs you've already asked about, (b) don't re-emit
// observations you've already produced (server-side dedup still runs, but
// the model wastes tokens and the UI sees spurious churn).
//
// Fix: extend buildStateSnapshotMessage to include two new optional
// sections populated from this.askedQuestions + this.extractedObservations
// when non-empty. Cache-control semantics unchanged.
// ---------------------------------------------------------------------------

describe('Plan 04-08 r2-#1 — cached-prefix digest regression', () => {
  test("r2-1a: non-off buildSystemBlocks() INCLUDES 'ASKED QUESTIONS' when askedQuestions non-empty", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.askedQuestions = ['measured_zs_ohm:1', 'r1_r2_ohm:2', 'polarity_confirmed:3'];
    const blocks = s.buildSystemBlocks();
    // Snapshot block is index 1 when non-empty; must exist because
    // askedQuestions alone should make buildStateSnapshotMessage
    // return non-null.
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toContain('ASKED QUESTIONS');
    expect(blocks[1].text).toContain('measured_zs_ohm:1');
    expect(blocks[1].text).toContain('r1_r2_ohm:2');
    expect(blocks[1].text).toContain('polarity_confirmed:3');
  });

  test("r2-1b: non-off buildSystemBlocks() INCLUDES 'EXTRACTED OBSERVATIONS' when extractedObservations non-empty", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.extractedObservations = [
      { id: 'id-a', text: 'missing earth bond at kitchen', code: 'C2' },
      { id: 'id-b', text: 'loose neutral in upstairs consumer unit', code: 'C2' },
    ];
    const blocks = s.buildSystemBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toContain('EXTRACTED OBSERVATIONS');
    // Truncated-to-60 text from buildUserMessage parity
    expect(blocks[1].text).toContain('missing earth bond at kitchen');
    expect(blocks[1].text).toContain('loose neutral in upstairs consumer unit');
  });

  test("r2-1c: combined — snapshot includes schedule + extracted + observations + asked + extractedObs in order", () => {
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.circuitSchedule = '  Circuit 1: Kitchen Sockets []';
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.35' }],
      observations: [{ observation_text: 'scorched neutral busbar', code: 'C2' }],
    });
    s.askedQuestions = ['polarity_confirmed:1'];
    s.extractedObservations = [{ id: 'id-x', text: 'cover damaged on mcb', code: 'C3' }];
    const blocks = s.buildSystemBlocks();
    expect(blocks).toHaveLength(2);
    const text = blocks[1].text;
    // Ordering contract — cache key sensitivity.
    const iSched = text.indexOf('CIRCUIT SCHEDULE');
    const iExtracted = text.indexOf('EXTRACTED (field IDs');
    const iObs = text.indexOf('OBSERVATIONS ALREADY RECORDED');
    const iAsked = text.indexOf('ASKED QUESTIONS');
    const iExtractedObs = text.indexOf('EXTRACTED OBSERVATIONS');
    expect(iSched).toBeGreaterThanOrEqual(0);
    expect(iExtracted).toBeGreaterThan(iSched);
    expect(iObs).toBeGreaterThan(iExtracted);
    expect(iAsked).toBeGreaterThan(iObs);
    expect(iExtractedObs).toBeGreaterThan(iAsked);
  });

  test("r2-1d: off-mode buildUserMessage output is byte-identical to pre-r2 behaviour", () => {
    // Locks the STR-01 rollback invariant — adding the digests into the
    // cached prefix on non-off MUST NOT disturb the off-mode per-turn
    // injection of those same digests in buildUserMessage.
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.circuitSchedule = 'Circuit 1: Kitchen Sockets []';
    s.askedQuestions = ['measured_zs_ohm:1', 'r1_r2_ohm:2'];
    s.extractedObservations = [{ id: 'id-a', text: 'missing earth bond at kitchen', code: 'C2' }];
    const msg = s.buildUserMessage('new utterance');
    const expected = [
      'NEW utterance: new utterance',
      'CIRCUIT SCHEDULE (confirmed values -- do NOT question these):\nCircuit 1: Kitchen Sockets []',
      'Already asked (skip): measured_zs_ohm:1; r1_r2_ohm:2',
      'Observations already created (do NOT re-extract): missing earth bond at kitchen',
    ].join('\n\n');
    expect(msg).toBe(expected);
  });

  test("r2-1e: non-off — session with only askedQuestions + no readings/schedule returns non-null snapshot containing just ASKED QUESTIONS", () => {
    // Before r2, buildStateSnapshotMessage returned null when circuits +
    // pending + obs + alerts + schedule were all empty — even though
    // askedQuestions was non-empty. Fix: widen the non-null gate to include
    // askedQuestions / extractedObservations.
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.askedQuestions = ['measured_zs_ohm:1'];
    const blocks = s.buildSystemBlocks();
    expect(blocks).toHaveLength(2);
    const text = blocks[1].text;
    expect(text).toContain('ASKED QUESTIONS');
    expect(text).toContain('measured_zs_ohm:1');
    // Sanity: nothing else was included because nothing else was set.
    expect(text).not.toContain('CIRCUIT SCHEDULE');
    expect(text).not.toContain('EXTRACTED (field IDs');
    expect(text).not.toContain('OBSERVATIONS ALREADY RECORDED');
    expect(text).not.toContain('EXTRACTED OBSERVATIONS');
  });
});

describe('Plan 04-02 — legacy off-mode regression guard (Group 6)', () => {
  beforeEach(() => mockCreate.mockReset());

  test("off mode extractFromUtterance: system stays single-block; snapshot in messages", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'record_extraction',
          input: {
            extracted_readings: [],
            field_clears: [],
            circuit_updates: [],
            observations: [],
            validation_alerts: [],
            questions_for_user: [],
            confirmations: [],
          },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 10 },
      stop_reason: 'tool_use',
    });

    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.start(null);
    // Seed a circuit so the snapshot is non-empty on the next turn.
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
    });
    await s.extractFromUtterance('first utterance');
    const result = await s.flushUtteranceBuffer();
    expect(result).toBeTruthy();

    const payload = mockCreate.mock.calls[0][0];
    // Off mode: system is a single-block array.
    expect(payload.system).toHaveLength(1);
    expect(payload.system[0].text).toBe(EICR_SYSTEM_PROMPT);
    // Off mode: snapshot rides in messages array as the first user/assistant pair.
    const snapshotMsg = payload.messages.find(
      (m) => m.role === 'user' &&
        Array.isArray(m.content) &&
        typeof m.content[0]?.text === 'string' &&
        m.content[0].text.includes('EXTRACTED')
    );
    expect(snapshotMsg).toBeTruthy();

    s.stop();
  });
});

// ---------------------------------------------------------------------------
// Plan 04-10 (r4-#1) — r2 regression: off-mode byte-identical.
//
// WHY THIS GROUP EXISTS: Codex r4 (2026-04-23) found that Plan 04-08 r2's
// fix (re-home ASKED QUESTIONS + EXTRACTED OBSERVATIONS digests into the
// cached prefix for non-off modes) unconditionally added those two
// sections to buildStateSnapshotMessage() — including when called from
// off-mode's buildMessageWindow() path. Net effect: off-mode now emits
// DUPLICATES of both digests in each turn (once via the snapshot pair
// that buildMessageWindow pushes into messages, once via buildUserMessage's
// own legacy-path emission).
//
// SC #7 ("off-mode path is byte-identical to pre-Phase-4 behaviour") is a
// hard invariant — breaking it compromises STR-01 rollback.
//
// Fix: gate the new ASKED QUESTIONS + EXTRACTED OBSERVATIONS sections in
// buildStateSnapshotMessage() behind `this.toolCallsMode !== 'off'`. In
// off mode these sections are emitted only by buildUserMessage() per
// legacy behaviour. Also restore the pre-r2 "empty-sections" null gate
// for off-mode so off-mode snapshot returns null when only askedQuestions
// / extractedObservations are populated (pre-r2 semantic).
// ---------------------------------------------------------------------------

describe('Plan 04-10 r4-#1 — off-mode snapshot byte-identical regression', () => {
  beforeEach(() => mockCreate.mockReset());

  test("r4-1a: off-mode buildStateSnapshotMessage() with ONLY askedQuestions returns null (pre-r2 semantic)", () => {
    // Pre-r2: off-mode snapshot returned null when circuits + pending +
    // observations + alerts + schedule were all empty, even if
    // askedQuestions was non-empty — askedQuestions was NOT a
    // snapshot-source surface in off-mode (it lived in buildUserMessage).
    // r2 widened the gate to include askedQuestions for non-off, but
    // applied the widening to off-mode too — causing off-mode to emit
    // a snapshot message where pre-r2 it would have been silent.
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.askedQuestions = ['measured_zs_ohm:1'];
    const snapshot = s.buildStateSnapshotMessage();
    // Pre-r2 (and post-r4 fix): null, because off-mode considers only the
    // five legacy sections when deciding whether to emit a snapshot.
    expect(snapshot).toBeNull();
  });

  test("r4-1b: off-mode buildStateSnapshotMessage() with seeded state omits ASKED QUESTIONS + EXTRACTED OBSERVATIONS", () => {
    // Off mode: even with circuits seeded (so snapshot is non-null), the
    // ASKED QUESTIONS + EXTRACTED OBSERVATIONS sections must NOT appear
    // in the snapshot text — they live in buildUserMessage for off-mode.
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.35' }],
    });
    s.askedQuestions = ['polarity_confirmed:2'];
    s.extractedObservations = [{ id: 'id-a', text: 'missing earth bond', code: 'C2' }];
    const snapshot = s.buildStateSnapshotMessage();
    expect(snapshot).toBeTruthy();
    expect(snapshot).toContain('EXTRACTED');
    // Off mode: new r2 sections MUST NOT appear — they duplicate
    // buildUserMessage's off-mode output.
    expect(snapshot).not.toContain('ASKED QUESTIONS');
    expect(snapshot).not.toContain('EXTRACTED OBSERVATIONS');
  });

  test("r4-1c: shadow-mode preservation — ASKED QUESTIONS + EXTRACTED OBSERVATIONS still ride the cached prefix", () => {
    // Regression guard: the off-mode gate must NOT break the non-off
    // cached-prefix behaviour that r2-1a / r2-1b locked. Shadow mode
    // still emits both sections via buildStateSnapshotMessage.
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'shadow' });
    s.askedQuestions = ['measured_zs_ohm:1'];
    s.extractedObservations = [{ id: 'id-a', text: 'missing earth bond', code: 'C2' }];
    const snapshot = s.buildStateSnapshotMessage();
    expect(snapshot).toBeTruthy();
    expect(snapshot).toContain('ASKED QUESTIONS');
    expect(snapshot).toContain('EXTRACTED OBSERVATIONS');
    expect(snapshot).toContain('measured_zs_ohm:1');
    expect(snapshot).toContain('missing earth bond');
  });

  test("r4-1d: off-mode extractFromUtterance — each digest appears EXACTLY ONCE across messages", async () => {
    // The duplication bug is only visible end-to-end: buildUserMessage in
    // off-mode emits 'Already asked (skip)' + 'Observations already
    // created', and buildMessageWindow pushes the snapshot (which pre-fix
    // ALSO contained those digests under r2 section headers) as a
    // user/assistant pair. The API payload therefore carried each digest
    // twice, breaking SC #7 byte-identical semantics vs pre-Phase-4.
    //
    // This test asserts each digest appears exactly ONCE across the
    // combined messages content in off mode. Pre-fix: fails (snapshot
    // contains 'ASKED QUESTIONS' section + buildUserMessage contains
    // 'Already asked' — two distinct surfaces but SAME information).
    // Post-fix: passes (snapshot gate suppresses the new sections in
    // off-mode; only buildUserMessage's legacy emission survives).
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'record_extraction',
          input: {
            extracted_readings: [],
            field_clears: [],
            circuit_updates: [],
            observations: [],
            validation_alerts: [],
            questions_for_user: [],
            confirmations: [],
          },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 10 },
      stop_reason: 'tool_use',
    });

    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.start(null);
    // Seed circuits, askedQuestions, extractedObservations — all three
    // digest-source surfaces populated so the duplication (pre-fix) is
    // visible.
    s.updateStateSnapshot({
      extracted_readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.35' }],
    });
    s.askedQuestions = ['polarity_confirmed:2'];
    s.extractedObservations = [{ id: 'id-a', text: 'missing earth bond at kitchen', code: 'C2' }];

    await s.extractFromUtterance('test utterance');
    await s.flushUtteranceBuffer();

    const payload = mockCreate.mock.calls[0][0];
    // Concatenate every text block across every message so we can count
    // substring occurrences (digests may land in snapshot-pair user
    // message OR in buildUserMessage's turn user message).
    const allText = payload.messages
      .map((m) =>
        Array.isArray(m.content)
          ? m.content.map((b) => b.text || '').join('')
          : String(m.content ?? '')
      )
      .join('\n---\n');

    // r2 section header (new per-mode surface, should be SUPPRESSED in off).
    const r2AskedCount = (allText.match(/ASKED QUESTIONS/g) || []).length;
    const r2ExtObsCount = (allText.match(/EXTRACTED OBSERVATIONS/g) || []).length;
    expect(r2AskedCount).toBe(0);
    expect(r2ExtObsCount).toBe(0);

    // Legacy buildUserMessage emissions (should appear EXACTLY ONCE —
    // from the turn's user message, not duplicated into a snapshot
    // section).
    const legacyAskedCount = (allText.match(/Already asked \(skip\):/g) || []).length;
    const legacyExtObsCount = (allText.match(/Observations already created \(do NOT re-extract\):/g) || []).length;
    expect(legacyAskedCount).toBe(1);
    expect(legacyExtObsCount).toBe(1);

    s.stop();
  });

  test("r4-1e: off-mode buildUserMessage byte-identical — r2-1d parity preserved", () => {
    // Cross-check the r2-1d lock still holds: buildUserMessage's off-mode
    // output is byte-identical to the pre-r2 expectation, regardless of
    // the r4 snapshot-builder gate. This is a defensive regression — any
    // drift in buildUserMessage would compromise SC #7 independently.
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'off' });
    s.circuitSchedule = 'Circuit 1: Kitchen Sockets []';
    s.askedQuestions = ['measured_zs_ohm:1', 'r1_r2_ohm:2'];
    s.extractedObservations = [{ id: 'id-a', text: 'missing earth bond at kitchen', code: 'C2' }];
    const msg = s.buildUserMessage('new utterance');
    const expected = [
      'NEW utterance: new utterance',
      'CIRCUIT SCHEDULE (confirmed values -- do NOT question these):\nCircuit 1: Kitchen Sockets []',
      'Already asked (skip): measured_zs_ohm:1; r1_r2_ohm:2',
      'Observations already created (do NOT re-extract): missing earth bond at kitchen',
    ].join('\n\n');
    expect(msg).toBe(expected);
  });
});
