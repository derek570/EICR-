/**
 * Stage 6 — SONNET_TOOL_CALLS env-flag plumbing (STR-01).
 *
 * WHY this test file exists:
 *   Phase 1 of the Stage-6 agentic-extraction milestone ships an env-flag
 *   (`SONNET_TOOL_CALLS={off|shadow|live}`) that later phases branch on. The
 *   flag is READ but NOT acted on in Phase 1 — the harness (Plan 06) consumes
 *   it. This test locks down the contract so later plans can trust the value.
 *
 * WHY constructor-option override pattern:
 *   Research §Pitfall 4 — tests that mutate `process.env` AFTER session
 *   construction silently fail because the flag was already latched. Accepting
 *   an explicit `options.toolCallsMode` override gives tests a deterministic
 *   path AND preserves the env-driven prod path.
 */

import { jest } from '@jest/globals';

// Mock the Anthropic SDK so the constructor does not try to open a real client.
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: jest.fn(),
    },
  })),
}));

// Mock the logger so we can assert warn calls without real output.
const mockWarn = jest.fn();
const mockInfo = jest.fn();
const mockError = jest.fn();
jest.unstable_mockModule('../logger.js', () => ({
  default: {
    warn: mockWarn,
    info: mockInfo,
    error: mockError,
    debug: jest.fn(),
  },
}));

const { EICRExtractionSession } = await import(
  '../extraction/eicr-extraction-session.js'
);

const ORIG_ENV = process.env.SONNET_TOOL_CALLS;

describe('Stage 6 env-flag plumbing (STR-01)', () => {
  beforeEach(() => {
    mockWarn.mockClear();
    mockInfo.mockClear();
    mockError.mockClear();
  });

  afterEach(() => {
    if (ORIG_ENV === undefined) {
      delete process.env.SONNET_TOOL_CALLS;
    } else {
      process.env.SONNET_TOOL_CALLS = ORIG_ENV;
    }
  });

  it('defaults to "off" when no env var and no options are provided', () => {
    delete process.env.SONNET_TOOL_CALLS;
    const s = new EICRExtractionSession('fake-key', 'sess-default', 'eicr');
    expect(s.toolCallsMode).toBe('off');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('reads "shadow" from process.env.SONNET_TOOL_CALLS when set', () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const s = new EICRExtractionSession('fake-key', 'sess-shadow', 'eicr');
    expect(s.toolCallsMode).toBe('shadow');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('reads "live" from process.env.SONNET_TOOL_CALLS when set', () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const s = new EICRExtractionSession('fake-key', 'sess-live', 'eicr');
    expect(s.toolCallsMode).toBe('live');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('options.toolCallsMode overrides the env var', () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const s = new EICRExtractionSession('fake-key', 'sess-override', 'eicr', {
      toolCallsMode: 'live',
    });
    expect(s.toolCallsMode).toBe('live');
  });

  it('falls back to "off" and logs a warn for invalid env values', () => {
    process.env.SONNET_TOOL_CALLS = 'garbage';
    const s = new EICRExtractionSession('fake-key', 'sess-invalid-env', 'eicr');
    expect(s.toolCallsMode).toBe('off');
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      'stage6.invalid_tool_calls_mode',
      expect.objectContaining({ value: 'garbage', fallback: 'off' })
    );
  });

  it('falls back to "off" and logs a warn for invalid option override values', () => {
    delete process.env.SONNET_TOOL_CALLS;
    const s = new EICRExtractionSession('fake-key', 'sess-invalid-opt', 'eicr', {
      toolCallsMode: 'nonsense',
    });
    expect(s.toolCallsMode).toBe('off');
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      'stage6.invalid_tool_calls_mode',
      expect.objectContaining({ value: 'nonsense', fallback: 'off' })
    );
  });

  it('env mutation AFTER construction does NOT change session.toolCallsMode (Pitfall 4)', () => {
    delete process.env.SONNET_TOOL_CALLS;
    const s = new EICRExtractionSession('fake-key', 'sess-latched', 'eicr');
    expect(s.toolCallsMode).toBe('off');

    // Mutate env post-construction — flag must NOT drift.
    process.env.SONNET_TOOL_CALLS = 'live';
    expect(s.toolCallsMode).toBe('off');
  });

  it('existing 3-arg construction still works (backward compatibility)', () => {
    delete process.env.SONNET_TOOL_CALLS;
    expect(
      () => new EICRExtractionSession('fake-key', 'sess-3arg', 'eicr')
    ).not.toThrow();
    const s = new EICRExtractionSession('fake-key', 'sess-3arg', 'eicr');
    expect(s.toolCallsMode).toBe('off');
    expect(s.sessionId).toBe('sess-3arg');
    expect(s.certType).toBe('eicr');
  });

  it('existing 2-arg construction (as used by test suite) still works', () => {
    delete process.env.SONNET_TOOL_CALLS;
    expect(
      () => new EICRExtractionSession('fake-key', 'sess-2arg')
    ).not.toThrow();
    const s = new EICRExtractionSession('fake-key', 'sess-2arg');
    expect(s.toolCallsMode).toBe('off');
    expect(s.certType).toBe('eicr'); // default
  });
});
