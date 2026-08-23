/**
 * PLAN-B B2 (feedback id 128) — prompt-contract pins for the designation
 * wording rule.
 *
 * The prompt line is belt to B1's deterministic braces: it must be worded
 * to match the deterministic contract EXACTLY (edge-only), not more
 * broadly — a "never include the word" phrasing would direct the MODEL to
 * do the interior stripping the deterministic layer deliberately DEFERS
 * (an open Derek decision). These pins lock:
 *   1. every prompt surface carries the edge-only rule;
 *   2. the two kept examples ("Ring circuit sockets", "Short-circuit
 *      tester") appear with it — the phrase that scopes the rule to edges;
 *   3. the create_circuit tool schema description agrees.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

const PROMPT_FILES = [
  'config/prompts/sonnet_agentic_system.md',
  'config/prompts/sonnet_extraction_system.md',
  'config/prompts/sonnet_extraction_eic_system.md',
  'config/prompts/sonnet_text_system.md',
];

describe('designation-wording prompt contract (edge-only, kept examples pinned)', () => {
  for (const file of PROMPT_FILES) {
    describe(file, () => {
      const text = readFileSync(path.join(repoRoot, file), 'utf8');

      it('carries the edge-only omission rule with the canonical example pair', () => {
        expect(text).toMatch(/omit standalone leading\/trailing "circuit"\/"circuits"/i);
        expect(text).toContain('"Upstairs Lighting", not "Upstairs Lighting Circuit"');
      });

      it('pins BOTH kept examples that scope the rule to edges', () => {
        expect(text).toContain('Ring circuit sockets');
        expect(text).toContain('Short-circuit tester');
      });

      it('does not smuggle in the deferred interior-strip via a broader phrasing', () => {
        // "never appear"/"never contain/include the word circuit" phrasings
        // would instruct interior removal — the deliberately deferred
        // alternative. The rule must stay edge-scoped.
        expect(text).not.toMatch(/never (?:contain|include|use) the word ["']?circuit/i);
      });
    });
  }

  it('create_circuit tool schema description agrees with the edge-only phrasing', () => {
    const schemaSrc = readFileSync(
      path.join(repoRoot, 'src/extraction/stage6-tool-schemas.js'),
      'utf8'
    );
    expect(schemaSrc).toContain('never "Upstairs lighting circuit"');
    expect(schemaSrc).toContain('Ring circuit sockets');
    expect(schemaSrc).toContain('Short-circuit tester');
  });

  it('the inline extract_chunk / extract_session prompts carry the rule too', () => {
    for (const file of ['src/extract_chunk.js', 'src/extract_session.js']) {
      const src = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(src).toMatch(/omit standalone leading\/trailing "circuit"\/"circuits"/i);
      expect(src).toContain('Short-circuit tester');
    }
  });
});
