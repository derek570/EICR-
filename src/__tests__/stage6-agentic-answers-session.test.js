/**
 * A1 agentic-voice (2026-07-23) — master-flag latch, conditional prompt
 * render, and gate borderline-forward.
 *
 * Pins (plan Items 2 + 3):
 *  - VOICE_AGENTIC_ANSWERS resolved ONCE at construction, latched; default
 *    TRUE unless exactly 'false'; boolean constructor override wins.
 *  - renderAgenticSystemPrompt: flag-off render carries NO marker lines and
 *    NO answer-feature content. The A1 OFF-marker blocks still hold their
 *    original A1-era lines verbatim; the flag-on render adds the ANSWERING
 *    QUESTIONS section, TOOLS (18), and the inspect_session_state steer
 *    replacing "There are NO query_* tools". NOTE: the flag-off render is no
 *    longer byte-identical to the *pre-A1* prompt — subsequent SHARED-region
 *    edits outside the marker blocks (e.g. P8 2026-07-24 prompt steers) grow
 *    BOTH renders equally. This test proves the ABSENCE of answer-feature
 *    content in the flag-off render, not byte-identity to any snapshot.
 *  - the selected render SURVIVES applyModeChange (both flag states).
 *  - gate: LOW_CONTENT → BORDERLINE_FORWARD only when the latched flag is
 *    passed true; option defaults FALSE (session-absent fail-closed);
 *    EMPTY still blocks on the ordinary path; every bypass keeps precedence
 *    (forwarding even empty text); 4-way master × VOICE_PRE_LLM_GATE matrix.
 */

import { jest } from '@jest/globals';

const {
  EICRExtractionSession,
  EICR_SYSTEM_PROMPT,
  EIC_SYSTEM_PROMPT,
  EICR_AGENTIC_SYSTEM_PROMPT,
  EICR_AGENTIC_SYSTEM_PROMPT_ANSWERS,
  renderAgenticSystemPrompt,
} = await import('../extraction/eicr-extraction-session.js');
const { shouldForwardToSonnet, GATE_REASONS } = await import('../extraction/pre-llm-gate.js');

// Low-content chatter: no digit, no strong/weak/observation/earthing/
// identity trigger — the exact class the gate terminally dropped pre-A1.
const CHATTER = 'lovely wallpaper honestly';

afterEach(() => {
  delete process.env.VOICE_AGENTIC_ANSWERS;
});

// ───────────────────────────────────────────────────────────────────────────
describe('renderAgenticSystemPrompt — conditional marker-block render (Item 2)', () => {
  test('neither render leaks marker lines', () => {
    for (const enabled of [true, false]) {
      const rendered = renderAgenticSystemPrompt(enabled);
      expect(rendered).not.toContain('<!--A1:');
      expect(rendered).not.toContain('<!--/A1:');
    }
  });

  test('flag-off render preserves A1 OFF-block lines; no answer-feature content', () => {
    const off = renderAgenticSystemPrompt(false);
    expect(off).toContain('TOOLS (12):');
    expect(off).toContain('There are NO `query_*` tools — consult the cached prefix directly.');
    expect(off).toContain(
      'If no new information was spoken, emit NO tool calls — the server handles silence.'
    );
    expect(off).not.toContain('ANSWERING QUESTIONS:');
    expect(off).not.toContain('answer_user');
    expect(off).not.toContain('inspect_session_state');
    expect(off).not.toContain('TOOLS (18)');
    expect(off).not.toContain('You have 18 tools');
  });

  test('flag-on render carries the rewrites and the exhaustive TOOLS (18) inventory', () => {
    const on = renderAgenticSystemPrompt(true);
    expect(on).toContain('TOOLS (18):');
    expect(on).not.toContain('TOOLS (12):');
    expect(on).toContain('ANSWERING QUESTIONS:');
    expect(on).toContain('call `inspect_session_state`');
    expect(on).not.toContain('There are NO `query_*` tools');
    // Previously-omitted real tools join the flag-on inventory.
    for (const name of [
      'set_field_for_all_circuits',
      'add_board',
      'select_board',
      'mark_distribution_circuit',
      'answer_user',
      'inspect_session_state',
    ]) {
      expect(on).toContain(`\`${name}\``);
    }
    // YOU-ARE-DONE-WHEN question carve-out + anti-pattern + never-output list.
    expect(on).toContain('A question turn is NOT "no new information"');
    expect(on).toContain('only `answer_user` reaches the speaker');
    expect(on).toContain('"You have 18 tools"');
  });

  test('the composed exports match their renders (flag-off keeps the historical name)', () => {
    expect(EICR_AGENTIC_SYSTEM_PROMPT.startsWith(renderAgenticSystemPrompt(false).trimEnd())).toBe(
      true
    );
    expect(
      EICR_AGENTIC_SYSTEM_PROMPT_ANSWERS.startsWith(renderAgenticSystemPrompt(true).trimEnd())
    ).toBe(true);
    expect(EICR_AGENTIC_SYSTEM_PROMPT).not.toBe(EICR_AGENTIC_SYSTEM_PROMPT_ANSWERS);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('master-flag latch — resolved once at construction (Item 3.2)', () => {
  test('env unset → default TRUE (ships-on default; prod pins the task-def explicitly)', () => {
    delete process.env.VOICE_AGENTIC_ANSWERS;
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'live' });
    expect(s.agenticAnswersEnabled).toBe(true);
    expect(s.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT_ANSWERS);
  });

  test("env exactly 'false' → OFF; any other value → ON", () => {
    process.env.VOICE_AGENTIC_ANSWERS = 'false';
    const off = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'live' });
    expect(off.agenticAnswersEnabled).toBe(false);
    expect(off.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);

    process.env.VOICE_AGENTIC_ANSWERS = 'true';
    const on = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'live' });
    expect(on.agenticAnswersEnabled).toBe(true);

    process.env.VOICE_AGENTIC_ANSWERS = 'FALSE'; // not exactly 'false'
    const notExact = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'live' });
    expect(notExact.agenticAnswersEnabled).toBe(true);
  });

  test('boolean constructor override wins over the env (test seam)', () => {
    process.env.VOICE_AGENTIC_ANSWERS = 'true';
    const s = new EICRExtractionSession('k', 's', 'eicr', {
      toolCallsMode: 'live',
      agenticAnswersEnabled: false,
    });
    expect(s.agenticAnswersEnabled).toBe(false);
    expect(s.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
  });

  test('LATCH: mutating the env post-construction does not drift the session', () => {
    process.env.VOICE_AGENTIC_ANSWERS = 'false';
    const s = new EICRExtractionSession('k', 's', 'eicr', { toolCallsMode: 'live' });
    process.env.VOICE_AGENTIC_ANSWERS = 'true';
    expect(s.agenticAnswersEnabled).toBe(false);
    expect(s.systemPrompt).toBe(EICR_AGENTIC_SYSTEM_PROMPT);
  });

  test('the selected render SURVIVES applyModeChange (both flag states)', () => {
    for (const [flag, agentic] of [
      [true, EICR_AGENTIC_SYSTEM_PROMPT_ANSWERS],
      [false, EICR_AGENTIC_SYSTEM_PROMPT],
    ]) {
      const s = new EICRExtractionSession('k', 's', 'eicr', {
        toolCallsMode: 'off',
        agenticAnswersEnabled: flag,
      });
      expect(s.systemPrompt).toBe(EICR_SYSTEM_PROMPT);
      s.applyModeChange('live');
      expect(s.systemPrompt).toBe(agentic);
      s.applyModeChange('off');
      expect(s.systemPrompt).toBe(EICR_SYSTEM_PROMPT);
    }
    // EIC off-mode branch is untouched by the flag.
    const eic = new EICRExtractionSession('k', 's', 'eic', {
      toolCallsMode: 'off',
      agenticAnswersEnabled: true,
    });
    expect(eic.systemPrompt).toBe(EIC_SYSTEM_PROMPT);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('gate — borderline-forward under the master flag (Item 3)', () => {
  test('4-way matrix: master flag × VOICE_PRE_LLM_GATE on low-content chatter', () => {
    // gate ON + master ON → BORDERLINE_FORWARD (forward, borderline).
    const fwd = shouldForwardToSonnet(CHATTER, { gateEnabled: true, agenticAnswersEnabled: true });
    expect(fwd).toMatchObject({
      forward: true,
      reason: GATE_REASONS.BORDERLINE_FORWARD,
      borderline: true,
    });
    expect(typeof fwd.distinctContentWords).toBe('number');

    // gate ON + master OFF → legacy LOW_CONTENT block, no borderline key.
    const blocked = shouldForwardToSonnet(CHATTER, {
      gateEnabled: true,
      agenticAnswersEnabled: false,
    });
    expect(blocked).toMatchObject({ forward: false, reason: GATE_REASONS.LOW_CONTENT });
    expect(blocked.borderline).toBeUndefined();

    // gate OFF → BYPASS_DISABLED regardless of the master flag.
    for (const master of [true, false]) {
      expect(
        shouldForwardToSonnet(CHATTER, { gateEnabled: false, agenticAnswersEnabled: master })
      ).toEqual({ forward: true, reason: GATE_REASONS.BYPASS_DISABLED });
    }
  });

  test('session-absent fail-closed: the option DEFAULTS to false (legacy routing, no throw)', () => {
    expect(shouldForwardToSonnet(CHATTER, {})).toMatchObject({
      forward: false,
      reason: GATE_REASONS.LOW_CONTENT,
    });
  });

  test('EMPTY still blocks on the ordinary path even with the master flag ON (Phase 0.5)', () => {
    expect(shouldForwardToSonnet('   ', { agenticAnswersEnabled: true })).toEqual({
      forward: false,
      reason: GATE_REASONS.EMPTY,
    });
  });

  test('bypass precedence unchanged: each bypass forwards even EMPTY text, flag on or off', () => {
    const cases = [
      [{ drainedRetry: true }, GATE_REASONS.BYPASS_DRAINED_RETRY],
      [{ hasPendingAsk: true }, GATE_REASONS.BYPASS_PENDING_ASK],
      [{ hasActiveDialogueScript: true }, GATE_REASONS.BYPASS_DIALOGUE_SCRIPT_ACTIVE],
      [{ inResponseTo: true }, GATE_REASONS.BYPASS_IN_RESPONSE_TO],
      [{ regexResults: [{ field: 'zs' }] }, GATE_REASONS.HAS_REGEX_HINT],
    ];
    for (const master of [true, false]) {
      for (const [opts, reason] of cases) {
        expect(shouldForwardToSonnet('', { ...opts, agenticAnswersEnabled: master })).toEqual({
          forward: true,
          reason,
        });
        expect(shouldForwardToSonnet(CHATTER, { ...opts, agenticAnswersEnabled: master })).toEqual({
          forward: true,
          reason,
        });
      }
    }
  });

  test('non-borderline forward reasons are untouched by the flag (digit example)', () => {
    for (const master of [true, false]) {
      expect(
        shouldForwardToSonnet('Zs is 0.42 on circuit 3', { agenticAnswersEnabled: master })
      ).toEqual({ forward: true, reason: GATE_REASONS.HAS_DIGIT });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('leak filter — retained count literals + complete TOOL_KEYWORD_RE (Item 2)', () => {
  test('every tool-count literal and header form the prompt ever carried is filtered', async () => {
    const { checkForPromptLeak } = await import('../extraction/stage6-prompt-leak-filter.js');
    for (const text of [
      'You have 7 tools',
      'You have 8 tools',
      'You have 9 tools',
      'You have 12 tools',
      'You have 18 tools',
      'the header says TOOLS (12): here',
      'the header says TOOLS (18): here',
    ]) {
      expect(checkForPromptLeak(text, { field: 'question' }).safe).toBe(false);
    }
    // Ordinary inspection speech stays safe.
    expect(checkForPromptLeak('Circuit 4 has no Zs recorded yet.', { field: 'question' }).safe).toBe(
      true
    );
  });
});
