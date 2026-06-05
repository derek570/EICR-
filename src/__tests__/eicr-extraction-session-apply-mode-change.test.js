/**
 * Stage 6 Phase 6 Plan 06-08 r7-#1 (MAJOR) — applyModeChange unit tests.
 *
 * REQUIREMENTS: STR-01 (rollback contract), STG-01 (review gate).
 *
 * WHY THIS FILE EXISTS
 *   r6 (Plan 06-07) wrote `entry.session.toolCallsMode` on reconnect/
 *   resume so the runtime path-selection in `runShadowHarness` and
 *   `consumeLegacyQuestionsForUser` tracks the live env mode. But
 *   `EICRExtractionSession.systemPrompt` is the OTHER constructor-
 *   time mode-derived field — set once at construction (line 697-702)
 *   from `toolCallsMode` and never re-derived. After an off → shadow
 *   flip, `buildSystemBlocks()` emits a legacy-prompt + agentic-
 *   snapshot hybrid that doesn't exist in any release of the prompt
 *   module.
 *
 *   Plan 06-08 adds a public `applyModeChange(newMode)` method to
 *   EICRExtractionSession that restamps `toolCallsMode` AND
 *   `systemPrompt` together. This file is the unit-level contract
 *   for that method:
 *     H.1 — off → shadow flips systemPrompt to the agentic prompt.
 *     H.2 — shadow → off flips systemPrompt back to the legacy
 *           cert-specific prompt (EIC vs EICR branch).
 *     H.3 — newMode === current is a no-op (no log, prompt object
 *           reference unchanged).
 *     H.4 — invalid newMode falls back to 'off' and warns.
 *
 *   Group H.5 (integration through sonnet-stream.js's reconnect
 *   path) lives in `sonnet-stream-protocol-version-handshake.test.js`
 *   alongside the rest of the handshake regression tests — it's the
 *   "call site uses the method" test, separate from this method-
 *   contract test.
 *
 * MOCK STRATEGY
 *   The Anthropic SDK is mocked because the constructor instantiates
 *   `new Anthropic({ apiKey })` before `applyModeChange` would ever
 *   fire. Logger is mocked so we can assert specific warn/info calls.
 *   The prompt-file `readFileSync` calls inside the module run for
 *   real — those files are checked into the repo at
 *   `src/extraction/system-prompt-eicr.txt` etc. and the test imports
 *   the loaded constants for assertion.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// ── Mocks (must register BEFORE dynamic import) ──────────────────────────────

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

class FakeAnthropic {
  constructor() {
    // No-op — applyModeChange never calls into the SDK.
  }
}

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: FakeAnthropic,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: mockLogger,
}));

const { EICRExtractionSession, EICR_SYSTEM_PROMPT, EIC_SYSTEM_PROMPT, EICR_AGENTIC_SYSTEM_PROMPT } =
  await import('../extraction/eicr-extraction-session.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession({ certType = 'eicr', toolCallsMode = 'off' } = {}) {
  // Pass toolCallsMode via options so the constructor's
  // _resolveToolCallsMode picks it up without us having to mutate
  // process.env for each test.
  return new EICRExtractionSession('fake-key', `sess-${Math.random()}`, certType, {
    toolCallsMode,
  });
}

beforeEach(() => {
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

// ── H.1 — off → shadow flips systemPrompt to agentic ─────────────────────────

describe('H.1 — applyModeChange off → shadow swaps systemPrompt to agentic', () => {
  test('toolCallsMode flips and systemPrompt becomes EICR_AGENTIC_SYSTEM_PROMPT', () => {
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'off' });

    // Pre-condition: legacy prompt selected at construction.
    expect(session.toolCallsMode).toBe('off');
    expect(session.systemPrompt).toBe(EICR_SYSTEM_PROMPT);

    session.applyModeChange('shadow');

    expect(session.toolCallsMode).toBe('shadow');
    expect(session.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
  });

  test('cert-type EIC: off → shadow flips from EIC_SYSTEM_PROMPT to agentic', () => {
    const session = makeSession({ certType: 'eic', toolCallsMode: 'off' });
    expect(session.systemPrompt).toBe(EIC_SYSTEM_PROMPT);

    session.applyModeChange('shadow');

    expect(session.toolCallsMode).toBe('shadow');
    expect(session.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
  });

  test('off → live also swaps to agentic prompt', () => {
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'off' });
    session.applyModeChange('live');

    expect(session.toolCallsMode).toBe('live');
    expect(session.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
  });
});

// ── H.2 — shadow → off swaps systemPrompt back to legacy (cert-specific) ─────

describe('H.2 — applyModeChange shadow → off swaps systemPrompt back to legacy', () => {
  test('cert-type EICR: shadow → off restores EICR_SYSTEM_PROMPT (STR-01 rollback)', () => {
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'shadow' });
    expect(session.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);

    session.applyModeChange('off');

    expect(session.toolCallsMode).toBe('off');
    expect(session.systemPrompt).toBe(EICR_SYSTEM_PROMPT);
  });

  test('cert-type EIC: shadow → off restores EIC_SYSTEM_PROMPT (cert-type branch)', () => {
    const session = makeSession({ certType: 'eic', toolCallsMode: 'shadow' });
    expect(session.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);

    session.applyModeChange('off');

    expect(session.toolCallsMode).toBe('off');
    expect(session.systemPrompt).toBe(EIC_SYSTEM_PROMPT);
  });

  test('live → off also restores legacy prompt', () => {
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'live' });
    session.applyModeChange('off');

    expect(session.toolCallsMode).toBe('off');
    expect(session.systemPrompt).toBe(EICR_SYSTEM_PROMPT);
  });
});

// ── H.3 — unchanged-mode is a no-op ──────────────────────────────────────────

describe('H.3 — applyModeChange unchanged mode is a no-op', () => {
  test('off → off does not log apply_mode_change and preserves prompt reference', () => {
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'off' });
    const originalPrompt = session.systemPrompt;
    mockLogger.info.mockClear();

    session.applyModeChange('off');

    expect(session.toolCallsMode).toBe('off');
    // Same exact object reference — no recompute fired.
    expect(session.systemPrompt).toBe(originalPrompt);
    // No info-level apply_mode_change log emitted on no-op.
    const infoMessages = mockLogger.info.mock.calls.map((args) => args[0]);
    expect(infoMessages).not.toContain('stage6.apply_mode_change');
  });

  test('shadow → shadow no-op preserves agentic prompt and emits no log', () => {
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'shadow' });
    const originalPrompt = session.systemPrompt;
    mockLogger.info.mockClear();

    session.applyModeChange('shadow');

    expect(session.toolCallsMode).toBe('shadow');
    expect(session.systemPrompt).toBe(originalPrompt);
    const infoMessages = mockLogger.info.mock.calls.map((args) => args[0]);
    expect(infoMessages).not.toContain('stage6.apply_mode_change');
  });
});

// ── H.4 — invalid newMode falls back to 'off' with warn ──────────────────────

describe('H.4 — applyModeChange with invalid value falls back to off + warn', () => {
  test('garbage string falls back to off, systemPrompt becomes legacy, warn fires', () => {
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'shadow' });
    mockLogger.warn.mockClear();

    session.applyModeChange('not-a-real-mode');

    expect(session.toolCallsMode).toBe('off');
    expect(session.systemPrompt).toBe(EICR_SYSTEM_PROMPT);
    const warnMessages = mockLogger.warn.mock.calls.map((args) => args[0]);
    expect(warnMessages).toContain('stage6.apply_mode_change_invalid_value');
  });

  test('null falls back to off (covers the "missing value" path)', () => {
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'shadow' });
    session.applyModeChange(null);

    expect(session.toolCallsMode).toBe('off');
    expect(session.systemPrompt).toBe(EICR_SYSTEM_PROMPT);
  });

  test('garbage value when already off is still a no-op (toolCallsMode unchanged) but DOES warn', () => {
    // Edge case: the validation says "fall back to off", and the
    // current mode IS already off. We expect: no toolCallsMode/
    // systemPrompt change (it's effectively unchanged), but the warn
    // still fires because the caller asked for a mode we can't
    // honour. Operators looking at logs need to see the bad value
    // even if no state change resulted.
    const session = makeSession({ certType: 'eicr', toolCallsMode: 'off' });
    mockLogger.warn.mockClear();

    session.applyModeChange('garbage');

    expect(session.toolCallsMode).toBe('off');
    expect(session.systemPrompt).toBe(EICR_SYSTEM_PROMPT);
    const warnMessages = mockLogger.warn.mock.calls.map((args) => args[0]);
    expect(warnMessages).toContain('stage6.apply_mode_change_invalid_value');
  });
});

// ── Logging contract — H.5 (here for completeness) ───────────────────────────

describe('applyModeChange logging — info event on actual flip', () => {
  test('info log fires with {sessionId, fromMode, toMode, certType} on flip', () => {
    const session = new EICRExtractionSession('fake-key', 'sess-log-1', 'eicr', {
      toolCallsMode: 'off',
    });
    mockLogger.info.mockClear();

    session.applyModeChange('shadow');

    const infoCall = mockLogger.info.mock.calls.find(([msg]) => msg === 'stage6.apply_mode_change');
    expect(infoCall).toBeDefined();
    expect(infoCall[1]).toEqual(
      expect.objectContaining({
        sessionId: 'sess-log-1',
        fromMode: 'off',
        toMode: 'shadow',
        certType: 'eicr',
      })
    );
  });
});
