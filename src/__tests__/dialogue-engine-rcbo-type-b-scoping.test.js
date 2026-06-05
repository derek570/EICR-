/**
 * Audit-2026-06-02 Phase 4 — Type B scoping fix.
 *
 * Field-test reality (audit observation #9): inside an RCBO
 * walk-through the engine ran extractNamedFieldValues on every turn.
 * Two distinct slot regexes happened to share the bare letter `B`:
 *
 *   ocpd_type (rcbo.js): /\b(?:type|curve)\s*([BCD])\b|\b([BCD])\s*-?\s*curve\b/i
 *   rcd_type  (rcbo.js): /\btype\s*(AC|[AFB]|S)\b|\b(AC)\b/i
 *
 * Inspector replied "Type B" to the ocpd_type ask. Both regexes
 * matched, both fields landed. ocpd_type=B is correct; rcd_type=B
 * is a contract violation — RCBO walkthrough never asks
 * `rcd_type` first, and "Type B" (curve letter) is not a valid RCD
 * waveform setting outside an explicit RCD context.
 *
 * Phase 4 tightens both rcbo.js and rcd.js rcd_type namedExtractor
 * to require an RCD-context anchor (RCD/residual/waveform) for the
 * bare-letter alternation, while keeping standalone-AC one-word
 * replies and explicit "type AC" form working.
 *
 * Codex Pass 4 caught a critical helper limitation: pre-Phase-4
 * extractNamedFieldValues only read m[1]. The Phase 4 regex uses
 * three capture groups across three alternations; the helper was
 * widened to read m[1] ?? m[2] ?? m[3] in the same commit.
 */

import { rcboSchema, rcdSchema } from '../extraction/dialogue-engine/index.js';
import { extractNamedFieldValues } from '../extraction/dialogue-engine/helpers/extraction.js';

// ---------------------------------------------------------------------------
// extractNamedFieldValues — contract widening regression guard
// ---------------------------------------------------------------------------

describe('extractNamedFieldValues — Phase 4 multi-group capture support', () => {
  test('still extracts single-group regex slot (ring r1) via m[1]', () => {
    // Pin: a slot whose regex has only one capture group must work
    // exactly as before. Builds the slot inline so we don't depend
    // on schema imports for this contract test.
    const slots = [
      {
        field: 'ring_r1_ohm',
        namedExtractor: /\b(?:lives?|R1)\b[^\d]{0,30}?(\d+(?:\.\d+)?)/i,
        parser: (s) => s,
      },
    ];
    expect(extractNamedFieldValues('Lives are 0.43.', slots)).toEqual([
      { field: 'ring_r1_ohm', value: '0.43' },
    ]);
  });

  test('reads m[2] when m[1] is undefined', () => {
    const slots = [
      {
        field: 'demo',
        // Two capture groups; the first arm matches "alpha" but the
        // value lives in group 2.
        namedExtractor: /(?:alpha\s+(\w+))|(?:beta\s+(\w+))/i,
        parser: (s) => s,
      },
    ];
    expect(extractNamedFieldValues('beta xyz', slots)).toEqual([{ field: 'demo', value: 'xyz' }]);
  });

  test('reads m[3] when m[1] and m[2] are undefined', () => {
    const slots = [
      {
        field: 'demo',
        namedExtractor: /(?:alpha\s+(\w+))|(?:beta\s+(\w+))|(?:gamma\s+(\w+))/i,
        parser: (s) => s,
      },
    ];
    expect(extractNamedFieldValues('gamma qqq', slots)).toEqual([{ field: 'demo', value: 'qqq' }]);
  });

  test('returns empty when no group captures', () => {
    const slots = [
      {
        field: 'demo',
        namedExtractor: /(?:alpha\s+(\w+))|(?:beta\s+(\w+))/i,
        parser: (s) => s,
      },
    ];
    expect(extractNamedFieldValues('nothing here', slots)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rcbo schema rcd_type slot — bare-letter alternation requires RCD anchor
// ---------------------------------------------------------------------------

describe('rcboSchema rcd_type slot — Phase 4 anchor tightening', () => {
  test('"Type B" inside RCBO walkthrough fills ocpd_type ONLY — no rcd_type write', () => {
    const out = extractNamedFieldValues('Type B', rcboSchema.slots);
    const fields = out.map((r) => r.field);
    expect(fields).toContain('ocpd_type');
    expect(fields).not.toContain('rcd_type');
  });

  test('"Type AC" extracts rcd_type=AC via the type-AC alternation (group 2)', () => {
    const out = extractNamedFieldValues('Type AC', rcboSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'AC' });
  });

  test('"RCD type A" extracts rcd_type=A via the anchored group 1', () => {
    const out = extractNamedFieldValues('RCD type A', rcboSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'A' });
  });

  test('"residual current device type AC" extracts rcd_type=AC via group 1', () => {
    const out = extractNamedFieldValues('residual current device type AC', rcboSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'AC' });
  });

  test('"waveform type B" extracts rcd_type=B via group 1', () => {
    const out = extractNamedFieldValues('waveform type B', rcboSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'B' });
  });

  test('standalone "AC" (one-word reply) extracts rcd_type=AC via group 3', () => {
    const out = extractNamedFieldValues('AC', rcboSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'AC' });
  });

  test('"AC supply" does NOT false-match rcd_type (whole-string guard on group 3)', () => {
    const out = extractNamedFieldValues('AC supply', rcboSchema.slots);
    const fields = out.map((r) => r.field);
    expect(fields).not.toContain('rcd_type');
  });

  test('"AC mains" does NOT false-match rcd_type', () => {
    const out = extractNamedFieldValues('AC mains', rcboSchema.slots);
    const fields = out.map((r) => r.field);
    expect(fields).not.toContain('rcd_type');
  });

  test('"Type AC supply" extracts rcd_type=AC via group 2 (type AC form unambiguous)', () => {
    const out = extractNamedFieldValues('Type AC supply', rcboSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'AC' });
  });
});

// ---------------------------------------------------------------------------
// rcd schema rcd_type slot — same regex; symmetric guard
// ---------------------------------------------------------------------------

describe('rcdSchema rcd_type slot — Phase 4 anchor tightening (symmetric)', () => {
  test('"Type B" alone does NOT fill rcd_type — no RCD anchor', () => {
    const out = extractNamedFieldValues('Type B', rcdSchema.slots);
    const fields = out.map((r) => r.field);
    expect(fields).not.toContain('rcd_type');
  });

  test('"RCD type A" extracts rcd_type=A', () => {
    const out = extractNamedFieldValues('RCD type A', rcdSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'A' });
  });

  test('"type AC" extracts rcd_type=AC (no anchor needed for AC form)', () => {
    const out = extractNamedFieldValues('type AC', rcdSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'AC' });
  });

  test('standalone "AC." with trailing period extracts rcd_type=AC', () => {
    const out = extractNamedFieldValues('AC.', rcdSchema.slots);
    expect(out).toContainEqual({ field: 'rcd_type', value: 'AC' });
  });
});
