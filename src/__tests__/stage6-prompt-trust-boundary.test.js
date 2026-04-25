/**
 * Plan 03-12 r20 MAJOR remediation — prompt-assembly regression test.
 *
 * Stage 6 Phase 3 routes resolved ask_user replies back to Sonnet as
 * `{answered:true, untrusted_user_text:"..."}`. The `untrusted_` prefix
 * is deliberate: the string is raw user speech and must be treated as
 * quoted data, NEVER as an instruction that overrides the system
 * prompt. The tool-schema description says so (see
 * stage6-tool-schemas.js ASK_USER_DESCRIPTION), but the Sonnet system
 * prompts ALSO need to carry the directive — otherwise a spoken
 * "ignore previous instructions..." could steer the resumed turn.
 *
 * This test pins the trust-boundary section into both live system
 * prompts (EICR + EIC). If a future rewrite drops or weakens these
 * guards, this suite fails loudly at CI instead of silently shipping
 * a prompt-injection-susceptible model.
 */

import { EICR_SYSTEM_PROMPT, EIC_SYSTEM_PROMPT } from '../extraction/eicr-extraction-session.js';
import { getToolByName } from '../extraction/stage6-tool-schemas.js';

const ASK_USER_DESCRIPTION = getToolByName('ask_user').description;

describe('Stage 6 Phase 3 — prompt trust-boundary (r20 MAJOR)', () => {
  describe.each([
    ['EICR', EICR_SYSTEM_PROMPT],
    ['EIC', EIC_SYSTEM_PROMPT],
  ])('%s system prompt', (label, prompt) => {
    test(`${label}: contains an explicit TRUST BOUNDARY section`, () => {
      expect(prompt).toMatch(/TRUST BOUNDARY/);
    });

    test(`${label}: names the untrusted_user_text field verbatim`, () => {
      expect(prompt).toMatch(/untrusted_user_text/);
    });

    test(`${label}: explicitly calls untrusted_user_text quoted user content / data, not a directive`, () => {
      // The exact wording is not pinned, but the concept must be there —
      // the model must see both "quoted" (or equivalent) AND a
      // prohibition on treating the text as an instruction/directive.
      expect(prompt.toLowerCase()).toMatch(/quoted/);
      expect(prompt.toLowerCase()).toMatch(/never\s+as\s+(a\s+)?(directive|instruction)/);
    });

    test(`${label}: tells the model to ignore embedded "ignore previous instructions"-style content`, () => {
      // Canonical prompt-injection string must be named in the guard
      // so the directive is unambiguous.
      expect(prompt.toLowerCase()).toMatch(/ignore previous instructions/);
    });

    test(`${label}: prompt is still >= 1024 characters (prompt-caching floor)`, () => {
      // Anthropic prompt caching requires >=1024 tokens; byte-length
      // check is a cheap sanity floor. The trust-boundary insert must
      // not push the file below the cacheable size.
      expect(prompt.length).toBeGreaterThan(2000);
    });
  });

  test('tool schema description aligns with the prompt — also names untrusted_user_text + quoted content', () => {
    expect(ASK_USER_DESCRIPTION).toMatch(/untrusted_user_text/);
    expect(ASK_USER_DESCRIPTION.toLowerCase()).toMatch(/quoted/);
  });
});
