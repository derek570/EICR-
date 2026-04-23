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
