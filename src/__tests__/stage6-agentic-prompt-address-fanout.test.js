/**
 * Cluster E — address direction rule (voice-feedback-cleanup-2026-06-09).
 *
 * Marker 8: "when I gave the client's address, it also populated the
 * installation address" — Sonnet copied a dictated client_address into
 * the site address slots even though the CLIENT BILLING ADDRESS — SITE
 * COPY RULE is documented as site→client only (and requires explicit
 * confirmation at that). The fix adds a separate ADDRESS DIRECTION RULE
 * after the existing copy block, explicitly forbidding bidirectional
 * auto-population without an explicit equivalence statement from the
 * inspector.
 *
 * This file is a prompt-content lock — it asserts the new rule's prose
 * survives future edits to sonnet_agentic_system.md. Behavioural
 * verification (Sonnet actually obeys the rule under real input) lives
 * with the live-Sonnet bench suite, not here.
 */

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'config',
  'prompts',
  'sonnet_agentic_system.md'
);

describe('Cluster E — ADDRESS DIRECTION RULE (sonnet_agentic_system.md)', () => {
  let prompt;

  beforeAll(() => {
    prompt = fssync.readFileSync(PROMPT_PATH, 'utf8');
  });

  test('ADDRESS DIRECTION RULE header exists between the SITE COPY RULE and OBSERVATIONS', () => {
    const copyIdx = prompt.search(/CLIENT BILLING ADDRESS — SITE COPY RULE/);
    const directionIdx = prompt.search(/ADDRESS DIRECTION RULE/);
    const obsIdx = prompt.search(/OBSERVATIONS \((six|seven) rules\)/);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(directionIdx).toBeGreaterThanOrEqual(0);
    expect(obsIdx).toBeGreaterThanOrEqual(0);
    // Order matters — the new rule must come AFTER the existing copy
    // block (so the worked example still anchors the legitimate
    // same-as-site case) but BEFORE the OBSERVATIONS section.
    expect(directionIdx).toBeGreaterThan(copyIdx);
    expect(directionIdx).toBeLessThan(obsIdx);
  });

  test('ADDRESS DIRECTION RULE forbids both auto-population directions explicitly', () => {
    const idx = prompt.search(/ADDRESS DIRECTION RULE/);
    expect(idx).toBeGreaterThanOrEqual(0);
    // Block runs to OBSERVATIONS — bound there so a later prose drift in
    // the OBSERVATIONS block doesn't bleed into this assertion.
    const end = prompt.search(/OBSERVATIONS \((six|seven) rules\)/);
    expect(end).toBeGreaterThan(idx);
    const block = prompt.slice(idx, end);
    // Both directions must be named. If either is dropped the bug
    // resurfaces — the original marker was client→site, but covering
    // only one direction would leave the other class open.
    expect(block.toLowerCase()).toMatch(/do not auto-populate the site\/installation address from a dictated client_address/);
    expect(block.toLowerCase()).toMatch(/do not auto-populate the client_address from a dictated site address/);
  });

  test('ADDRESS DIRECTION RULE names the explicit-equivalence escape phrases', () => {
    const idx = prompt.search(/ADDRESS DIRECTION RULE/);
    const end = prompt.search(/OBSERVATIONS \((six|seven) rules\)/);
    const block = prompt.slice(idx, end);
    // The legitimate "client uses the site address" / "same as site"
    // path stays open — verify the escape phrases are named. Without
    // these the model would refuse the legitimate copy path that the
    // SITE COPY RULE above expects to fire.
    expect(block).toEqual(expect.stringContaining('client uses the site address'));
    expect(block).toEqual(expect.stringContaining('same as site'));
    expect(block).toEqual(expect.stringContaining('they live here'));
  });

  test('ADDRESS DIRECTION RULE preserves the four-slot client_* family naming', () => {
    const idx = prompt.search(/ADDRESS DIRECTION RULE/);
    const end = prompt.search(/OBSERVATIONS \((six|seven) rules\)/);
    const block = prompt.slice(idx, end);
    // The rule lists the four client_* slots that get written when the
    // inspector dictates a client-only address. Naming them defends
    // against the model writing them piecemeal under different slot
    // names — the existing SITE COPY RULE worked example uses the
    // same naming. Keep both in sync.
    expect(block).toEqual(expect.stringContaining('client_*'));
    expect(block).toEqual(expect.stringContaining('_address'));
    expect(block).toEqual(expect.stringContaining('_postcode'));
    expect(block).toEqual(expect.stringContaining('_town'));
    expect(block).toEqual(expect.stringContaining('_county'));
  });

  test('SITE COPY RULE worked example (71 Hexham Road) still anchors the legitimate copy path', () => {
    // Regression lock — the new ADDRESS DIRECTION RULE must not have
    // displaced the existing worked example that pins the SITE COPY
    // contract for the "Y to same-as-site" case. If this drops, the
    // model loses its one in-prompt demonstration of the legitimate
    // path and may default to refusing all address copying.
    expect(prompt).toEqual(expect.stringContaining('71 Hexham Road'));
    expect(prompt).toEqual(expect.stringContaining('NEVER'));
    expect(prompt).toEqual(expect.stringContaining('client_name'));
  });
});
