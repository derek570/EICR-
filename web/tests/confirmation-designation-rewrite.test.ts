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
