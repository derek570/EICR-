/**
 * PLAN-B2 (B2-2, wire-frame speech half) — grammar-aware designation
 * slot rewrite for confirmation text.
 *
 * The pinned regressions from the plan: the "Circuit 3" structural
 * collision (blind byte substitution would yield "3 is now the 3"),
 * lowercase structural variants left untouched, a >40-char leading-edge
 * designation, the PLAN-D merged create carrier, and the two-envelope
 * old-backend sequence (raw rename, then a measured-only frame whose
 * designation prefix repairs via the session alias map).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  createDesignationAliasStore,
  rewriteConfirmationDesignationText,
  type DesignationAliasStore,
  type RewriteOptions,
} from '../src/lib/recording/confirmation-designation-rewrite';

let aliases: DesignationAliasStore;
let circuits: Record<number, string>;
let opts: RewriteOptions;

beforeEach(() => {
  aliases = createDesignationAliasStore();
  circuits = {};
  opts = {
    aliases,
    lookupCanonicalByCircuit: (n) => circuits[n] ?? null,
  };
});

describe('shape B — "Circuit N is now the <designation>"', () => {
  it('rewrites the value slot, preserving the structural prefix (the "Circuit 3" collision)', () => {
    // Designation literally "Circuit 3": canonical is "3". Blind global
    // replacement would produce "3 is now the 3".
    const out = rewriteConfirmationDesignationText('Circuit 3 is now the Circuit 3', opts);
    expect(out.changed).toBe(true);
    expect(out.text).toBe('Circuit 3 is now the 3');
  });

  it('rewrites an edge-token designation value', () => {
    const out = rewriteConfirmationDesignationText(
      'Circuit 2 is now the Upstairs lighting circuit',
      opts
    );
    expect(out.text).toBe('Circuit 2 is now the Upstairs lighting');
  });

  it('leaves an already-canonical value untouched', () => {
    const out = rewriteConfirmationDesignationText('Circuit 2 is now the Upstairs lighting', opts);
    expect(out.changed).toBe(false);
  });

  it('lowercase structural variant is NOT recognised (never mangle unknown shapes)', () => {
    const text = 'circuit 3 is now the circuit 3';
    const out = rewriteConfirmationDesignationText(text, opts);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });
});

describe('shape C — PLAN-D merged create carrier', () => {
  it('rewrites the designation slot, preserving the tail', () => {
    const out = rewriteConfirmationDesignationText(
      'Created circuit 3, Downstairs light circuit — wiring type A',
      opts
    );
    expect(out.text).toBe('Created circuit 3, Downstairs light — wiring type A');
  });

  it('designationless create form has no slot', () => {
    const text = 'Created circuit 3 — wiring type A';
    const out = rewriteConfirmationDesignationText(text, opts);
    expect(out.changed).toBe(false);
  });

  it('em-dash designation: iterates boundaries, rewriting at the split that resolves (C4-4)', () => {
    // Designation itself contains " — ". A first-boundary split would
    // hand "outbuilding feed circuit — wiring type A" to the tail and
    // rewrite nothing (the fragment "Garage" resolves to nothing).
    aliases.record('Garage — outbuilding feed circuit', 'Garage — outbuilding feed');
    const out = rewriteConfirmationDesignationText(
      'Created circuit 5, Garage — outbuilding feed circuit — wiring type A',
      opts
    );
    expect(out.changed).toBe(true);
    expect(out.text).toBe('Created circuit 5, Garage — outbuilding feed — wiring type A');
  });

  it('em-dash designation resolves via pure repair when no alias/model knows it', () => {
    const out = rewriteConfirmationDesignationText(
      'Created circuit 5, Garage — outbuilding feed circuit — wiring type A',
      opts
    );
    expect(out.changed).toBe(true);
    expect(out.text).toBe('Created circuit 5, Garage — outbuilding feed — wiring type A');
  });

  it('already-canonical em-dash designation passes through unchanged at every candidate split', () => {
    circuits[5] = 'Garage — outbuilding feed';
    const text = 'Created circuit 5, Garage — outbuilding feed — wiring type A';
    const out = rewriteConfirmationDesignationText(text, opts);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });

  it('cycle-5: an INTERIOR "circuit" before an em-dash is not stripped when the model knows the full designation', () => {
    // Canonical designation "Garage circuit — outbuilding feed" —
    // "circuit" is interior (preserved by the edge-only canonicaliser).
    // The first boundary's fragment "Garage circuit" pure-repairs to
    // "Garage"; taking that fragment would corrupt speech. The model
    // match at boundary 2 is positive evidence and must win.
    circuits[5] = 'Garage circuit — outbuilding feed';
    const text = 'Created circuit 5, Garage circuit — outbuilding feed — wiring type A';
    const out = rewriteConfirmationDesignationText(text, opts);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });

  it('cycle-6: a session-global alias recorded for ANOTHER circuit cannot beat this circuit’s model match', () => {
    // Another circuit's rename recorded "Garage circuit" → "Garage" in
    // the session alias map. Circuit 5's canonical designation is the
    // legal interior-token "Garage circuit — outbuilding feed" — the
    // exact model match at boundary 2 must win over the alias hit at
    // boundary 1 (the alias store is session-global, the model lookup
    // is circuit-scoped: stronger evidence).
    aliases.record('Garage circuit for circuit two', 'ignored'); // noise
    aliases.record('Garage circuit', 'Garage');
    circuits[5] = 'Garage circuit — outbuilding feed';
    const text = 'Created circuit 5, Garage circuit — outbuilding feed — wiring type A';
    const out = rewriteConfirmationDesignationText(text, opts);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });

  it('cycle-5: a model-canonical boundary STOPS the scan before a tail fragment can pure-repair', () => {
    // Tail legally contains " — ring circuit — ": without the stop, the
    // boundary AFTER the canonical designation ("Garage — outbuilding
    // feed — ring circuit") pure-repairs (trailing "circuit") and the
    // rewriter would corrupt the TAIL.
    circuits[5] = 'Garage — outbuilding feed';
    const text = 'Created circuit 5, Garage — outbuilding feed — ring circuit — type A';
    const out = rewriteConfirmationDesignationText(text, opts);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });
});

describe('shape A — "<designation>, circuit N, <body>"', () => {
  it('repairs a raw prefix in place (pure repair fallback)', () => {
    const out = rewriteConfirmationDesignationText(
      'Kitchen sockets circuit, circuit 4, Zs 0.35 ohms',
      opts
    );
    expect(out.text).toBe('Kitchen sockets, circuit 4, Zs 0.35 ohms');
  });

  it('structural "Circuit N, body" (no designation prefix) is untouched', () => {
    const text = 'Circuit 4, Zs 0.35 ohms';
    const out = rewriteConfirmationDesignationText(text, opts);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });

  it('multi-circuit forms are untouched', () => {
    for (const text of [
      'Circuits 1 to 3, RCD time 28 milliseconds',
      'All circuits, RCD rating 30',
      'Circuits 2, 5, polarity confirmed',
    ]) {
      expect(rewriteConfirmationDesignationText(text, opts).changed).toBe(false);
    }
  });

  it('a comma-bearing designation resolves via the greedy separator', () => {
    circuits[6] = 'Upstairs sockets, lights, and alarms';
    const out = rewriteConfirmationDesignationText(
      'Upstairs sockets, lights, and alarms circuit, circuit 6, Zs 0.5 ohms',
      opts
    );
    expect(out.text).toBe('Upstairs sockets, lights, and alarms, circuit 6, Zs 0.5 ohms');
  });

  it('>40-char LEADING-edge designation: slot substitution mirrors the builder 40-char cap', () => {
    // Raw designation with the banned token at the LEADING edge and a
    // >40-char body: an old backend truncates the RAW to 40 chars for
    // the prefix slot, so the canonical (leading token stripped) must
    // replace it — capped to the same 40 chars the builder would use.
    const raw = 'Circuit extremely long garage and workshop supply feed';
    const canonical = 'extremely long garage and workshop supply feed';
    circuits[7] = canonical;
    aliases.record(raw, canonical);
    const rawSlot = raw.slice(0, 40); // what the old backend emitted
    const out = rewriteConfirmationDesignationText(`${rawSlot}, circuit 7, Zs 0.3 ohms`, opts);
    expect(out.changed).toBe(true);
    expect(out.text).toBe(`${canonical.slice(0, 40)}, circuit 7, Zs 0.3 ohms`);
  });

  it('a TRAILING-edge >40-char raw whose truncated slot already equals the canonical cap is a no-op', () => {
    const long = 'Extremely long garage and workshop supply feed circuit';
    circuits[7] = long.slice(0, 40); // truncation already cut the banned token
    const out = rewriteConfirmationDesignationText(
      `${long.slice(0, 40)}, circuit 7, Zs 0.3 ohms`,
      opts
    );
    expect(out.changed).toBe(false);
  });
});

describe('two-envelope old-backend sequence (raw rename → measured-only frame)', () => {
  it("the alias recorded from envelope 1 repairs envelope 2's prefix slot", () => {
    // Envelope 1: raw rename op observed — recording-context records
    // raw→canonical and applies the canonical to the model.
    aliases.record('Garage supply circuit', 'Garage supply');
    circuits[5] = 'Garage supply';
    // Envelope 2 (stale, old backend): measured reading whose prefix
    // still carries the raw designation.
    const out = rewriteConfirmationDesignationText(
      'Garage supply circuit, circuit 5, R1 plus R2 0.72 ohms',
      opts
    );
    expect(out.text).toBe('Garage supply, circuit 5, R1 plus R2 0.72 ohms');
  });

  it('without the alias, the local model lookup still repairs the slot', () => {
    circuits[5] = 'Garage supply';
    const out = rewriteConfirmationDesignationText(
      'Garage supply circuit, circuit 5, R1 plus R2 0.72 ohms',
      opts
    );
    expect(out.text).toBe('Garage supply, circuit 5, R1 plus R2 0.72 ohms');
  });

  it('a renamed-away historical designation is NOT rewritten to the new name', () => {
    circuits[5] = 'Completely different name';
    const text = 'Old kitchen feed, circuit 5, Zs 0.4 ohms';
    const out = rewriteConfirmationDesignationText(text, opts);
    // "Old kitchen feed" neither aliases nor repairs to the new
    // canonical — leave it truthful.
    expect(out.changed).toBe(false);
  });
});

describe('Codex r1 — alias uniqueness', () => {
  it('an ambiguous slot (two canonicals for one raw/truncated key) resolves to NOTHING', () => {
    aliases.record('Garage supply circuit', 'Garage supply');
    aliases.record('Garage supply circuit', 'Garage feed');
    // Ambiguous alias falls through; with no model row the pure repair
    // still fixes the edge token truthfully.
    const out = rewriteConfirmationDesignationText(
      'Garage supply circuit, circuit 5, Zs 0.4 ohms',
      opts
    );
    expect(out.text).toBe('Garage supply, circuit 5, Zs 0.4 ohms');
  });
});

/**
 * cycle-9 F4 — `\d` is ASCII-only in JS (no `u`-mode property escapes)
 * but matches every Unicode decimal digit (Nd) in ICU, which is what
 * `NSRegularExpression` uses. A non-ASCII digit in the structural
 * circuit slot therefore matched a shape on iOS and NOT here, so the
 * two clients spoke the same frame differently. The Swift patterns now
 * spell `[0-9]` out; these are the web assertions those mirror.
 * iOS twin: `DesignationHygieneBoundaryTests` § "Cycle-9 (F4)".
 */
describe('cycle-9 F4 — a non-ASCII digit is not a structural circuit number', () => {
  // U+0663 ARABIC-INDIC DIGIT THREE.
  const THREE = '٣';

  it.each([
    ['shape B', `Circuit ${THREE} is now the Upstairs lighting circuit`],
    ['shape C', `Created circuit ${THREE}, Upstairs lighting circuit — wiring type A`],
    ['shape A', `Upstairs lighting circuit, circuit ${THREE}, Zs 0.4 ohms`],
  ])('%s passes through byte-identical', (_label, text) => {
    const out = rewriteConfirmationDesignationText(text, opts);
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });

  it.each([
    [
      'shape B',
      'Circuit 3 is now the Upstairs lighting circuit',
      'Circuit 3 is now the Upstairs lighting',
    ],
    [
      'shape C',
      'Created circuit 3, Upstairs lighting circuit — wiring type A',
      'Created circuit 3, Upstairs lighting — wiring type A',
    ],
    [
      'shape A',
      'Upstairs lighting circuit, circuit 3, Zs 0.4 ohms',
      'Upstairs lighting, circuit 3, Zs 0.4 ohms',
    ],
  ])(
    '%s ASCII control still rewrites (so the above pins the digit class, not a stray non-match)',
    (_label, text, expected) => {
      const out = rewriteConfirmationDesignationText(text, opts);
      expect(out.changed).toBe(true);
      expect(out.text).toBe(expected);
    }
  );
});

/**
 * cycle-10 F2 — the shape-C boundary length test. This side compares JS
 * `.length` (UTF-16 units); Swift's `String.count` is extended grapheme
 * clusters. A combining mark immediately after the boundary joins the
 * preceding SPACE into ONE Swift grapheme, so iOS measured a 3-unit tail
 * against a 3-unit boundary and discarded a boundary this side accepted
 * — the same frame spoken raw on iOS and repaired on web. Swift now
 * compares `tail.utf16.count`. iOS twin:
 * `DesignationHygieneBoundaryTests` § "Cycle-10 (F1/F2)".
 */
describe('cycle-10 F2 — shape-C boundary length is UTF-16 units, not graphemes', () => {
  // U+0301 COMBINING ACUTE ACCENT as the entire tail body.
  const MARK = '\u0301';

  it('a combining-mark tail is still a valid boundary and the slot repairs', () => {
    const out = rewriteConfirmationDesignationText(
      `Created circuit 5, Garage circuit \u2014 ${MARK}`,
      opts
    );
    expect(out.changed).toBe(true);
    expect(out.text).toBe(`Created circuit 5, Garage \u2014 ${MARK}`);
  });
});
