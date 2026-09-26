/**
 * PLAN-CD (feedback-2026-09-17 wave) — acceptance item 3: the client-local
 * `ocpd_bs_en` miss handoff depends on VOICE_AGENTIC_ANSWERS, and that
 * dependency is PINNED here rather than left undocumented.
 *
 * Both clients forward a rejected apply-field command as an ORDINARY
 * transcript (Decision 13: no `client_command` marker, no allow-list entry).
 * The plan's fixture carries no regex hint, no digit and no trigger word, so
 * the backend gate forwards it only as BORDERLINE_FORWARD. With the flag off
 * it is dropped as LOW_CONTENT after the client has chimed — the failure
 * Derek knowingly accepted. If this test starts failing, that accepted cost
 * has changed: re-read the note at `_resolveAgenticAnswers` in
 * eicr-extraction-session.js before changing either side.
 */

import { shouldForwardToSonnet, GATE_REASONS } from '../extraction/pre-llm-gate.js';

const FIXTURE = 'OCPD standard grey square for all';

describe('PLAN-CD — the handed-off miss rests on VOICE_AGENTIC_ANSWERS', () => {
  test('flag true: forwarded as BORDERLINE_FORWARD', () => {
    const decision = shouldForwardToSonnet(FIXTURE, { agenticAnswersEnabled: true });
    expect(decision.forward).toBe(true);
    expect(decision.reason).toBe(GATE_REASONS.BORDERLINE_FORWARD);
    expect(decision.borderline).toBe(true);
  });

  test('flag false: BLOCKED as LOW_CONTENT — the accepted failure', () => {
    const decision = shouldForwardToSonnet(FIXTURE, { agenticAnswersEnabled: false });
    expect(decision.forward).toBe(false);
    expect(decision.reason).toBe(GATE_REASONS.LOW_CONTENT);
  });

  test('the client sends no marker and no hint, so nothing else opens the gate', () => {
    const decision = shouldForwardToSonnet(FIXTURE, {
      agenticAnswersEnabled: false,
      regexResults: [],
      clientCommand: null,
    });
    expect(decision.reason).toBe(GATE_REASONS.LOW_CONTENT);
  });
});
