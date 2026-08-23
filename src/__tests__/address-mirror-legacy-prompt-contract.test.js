// address-mirror-legacy-prompt-contract.test.js
// PLAN-A 2026-08-23 (feedback id 126) — the LEGACY extraction prompts carry
// their OWN address-mirror completeness definitions and drive the
// SONNET_TOOL_CALLS=off rollback path (claimLegacyQuestion validates the
// model's question against the server-side complete() predicate). A relaxed
// controller paired with strict legacy prompts would leave id-126 unresolved
// whenever rollback mode runs, so the relaxation is pinned PER legacy prompt
// here — Group 15 of stage6-agentic-prompt.test.js only covers the agentic
// prompt. The runtime model output can't be unit-tested; the PROMPT TEXT is
// the contract (same stance as surge-protection-contract.test.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'config', 'prompts');

for (const file of ['sonnet_extraction_system.md', 'sonnet_extraction_eic_system.md']) {
  describe(`${file} — address-mirror completeness relaxation (id 126)`, () => {
    const prompt = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');

    test('completeness is address + at least one of postcode/town/county, and a bare street line is not complete', () => {
      expect(prompt).toMatch(
        /`address` plus AT LEAST ONE corroborating component \(`postcode`, `town`, or `county`\)/
      );
      expect(prompt).toMatch(/a bare street line alone is NOT complete/);
    });

    test('the DEFER wording is satisfiable — it names the corroborating components, and no strict address+postcode completeness phrasing survives', () => {
      // The address-alone → later town/county sequence: an address dictated
      // alone defers, and the deferral resolves when ANY corroborating
      // component arrives — not only a postcode. The old wording ("defer
      // until a later turn completes it" against an address+postcode
      // definition) made the trigger structurally unsatisfiable on real
      // dictation (field session 17821FFA: street + county, no postcode ever).
      expect(prompt).toMatch(
        /defer until a later turn adds the missing corroborating component \(postcode, town, or county\)/i
      );
      expect(prompt).not.toMatch(/\(`address` \+ `postcode`\)/);
      expect(prompt).not.toMatch(/complete address family \(`address` \+ `postcode`\)/);
    });

    test('hybrid eligibility: the ask is banned when the other family holds a component the source lacks', () => {
      expect(prompt).toMatch(
        /Do NOT emit the ask when the other family already holds a component the source family lacks/
      );
      expect(prompt).toMatch(/a copy would fabricate a merged address/);
    });

    test('the wait-for-postcode line keeps the guessing ban but accepts town/county as mirror corroboration', () => {
      expect(prompt).toMatch(/do NOT guess the postcode/);
      expect(prompt).toMatch(
        /A later dictated town or county is equally valid mirror corroboration/
      );
    });
  });
}
