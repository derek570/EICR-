/**
 * PLAN-B2 (B2-2, wire-frame speech half) — grammar-aware designation-slot
 * rewrite for `confirmations[].text`.
 *
 * Clients SPEAK the bundler's confirmation text, not the operation
 * values — and the bundler inserts the circuit designation into EVERY
 * single-circuit reading confirmation. PLAN-B guarantees the backend
 * never EMITS a raw designation post-fix, but stale frames, replays,
 * and not-yet-deployed-backend windows still deliver text carrying the
 * banned word. Blind byte substitution is WRONG here: the builder
 * truncates designation prefixes to 40 chars, and structural wording
 * collides — designation "Circuit 3" renders "Circuit 3 is now the
 * Circuit 3", where global replacement would yield "3 is now the 3".
 *
 * So the rewrite is keyed to the builder's EXACT grammar
 * (`src/extraction/confirmation-text.js` + the stage6 bundler's merged
 * create carrier), replacing ONLY the designation slot:
 *
 *   A. `<designation>, circuit <N>, <body>`   (reading confirmation)
 *   B. `Circuit <N> is now the <designation>` (designation set)
 *   C. `Created circuit <N>, <designation> — <tail>` (PLAN-D merged
 *      create-ack carrier; the designationless
 *      `Created circuit <N> — <tail>` form has no slot)
 *
 * Slot resolution order: the session-scoped raw-alias map (populated
 * from every designation operation observed, so a later stale frame
 * carrying only a measured reading still repairs) → the LOCAL model's
 * canonical designation for that circuit → pure repair of the slot
 * text. Structural "Circuit N" text is never touched. Unrecognised
 * shapes (including lowercase structural variants the builder never
 * emits) pass through byte-identical — this rewriter must never mangle
 * text it does not positively recognise.
 */

import { repairCircuitDesignation } from '@certmate/shared-utils';

export interface DesignationAliasStore {
  /** Record a raw→canonical pairing observed on a designation operation. */
  record(raw: string, canonical: string): void;
  /** Resolve a slot string to its canonical form, if known. */
  resolve(slot: string): string | null;
  /** Session reset. */
  clear(): void;
  /** Test seam. */
  size(): number;
}

export function createDesignationAliasStore(): DesignationAliasStore {
  // raw slot → SET of canonicals. Resolution succeeds only when a slot
  // maps to exactly ONE canonical (Codex r1: a last-write-wins map let
  // two distinct long designations sharing a 40-char prefix — or the
  // same raw text renamed differently on two boards — speak another
  // circuit's designation). An ambiguous slot falls through to the
  // model lookup / pure repair, which are circuit-scoped.
  const map = new Map<string, Set<string>>();
  const add = (key: string, canonical: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(canonical);
    map.set(key, set);
  };
  return {
    record(raw: string, canonical: string) {
      const key = raw.trim();
      const value = canonical.trim();
      if (!key || key === value) return;
      add(key, value);
      // The builder truncates prefixes to 40 chars — register the
      // truncated raw too so a shape-A slot from a long designation
      // still resolves.
      if (key.length > 40) add(key.slice(0, 40), value);
    },
    resolve(slot: string) {
      const set = map.get(slot.trim());
      if (!set || set.size !== 1) return null;
      return set.values().next().value ?? null;
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

/** The builder caps designation prefixes at 40 chars — mirror it when
 *  substituting the canonical local value into a slot. */
function slotCap(designation: string): string {
  const trimmed = designation.trim();
  return trimmed.length > 40 ? trimmed.slice(0, 40) : trimmed;
}

export interface RewriteOptions {
  aliases: DesignationAliasStore;
  /** Canonical designation for a circuit ref from the LOCAL model
   *  (post-apply), or null when unknown/empty. */
  lookupCanonicalByCircuit: (circuit: number) => string | null;
}

/** Resolve what a designation slot should read as; null = leave alone. */
function resolveSlot(
  slot: string,
  circuit: number,
  { aliases, lookupCanonicalByCircuit }: RewriteOptions
): string | null {
  const viaAlias = aliases.resolve(slot);
  if (viaAlias != null) return slotCap(viaAlias);
  const viaModel = lookupCanonicalByCircuit(circuit);
  if (viaModel != null && viaModel.trim() !== '') {
    // Only substitute the model value when the slot is NOT already the
    // (possibly truncated) canonical — otherwise an unrelated wording
    // difference would churn the text.
    const capped = slotCap(viaModel);
    if (capped !== slot) {
      // The slot must actually LOOK like a raw variant of the canonical
      // (its own repair reaches the canonical) before we substitute —
      // a slot that repairs to something else entirely belongs to a
      // different (renamed-away) designation and pure repair below
      // handles it truthfully.
      const repairedSlot = repairCircuitDesignation(slot);
      if (typeof repairedSlot === 'string' && slotCap(repairedSlot) === capped) return capped;
    } else {
      return null; // already canonical
    }
  }
  const repaired = repairCircuitDesignation(slot);
  if (typeof repaired === 'string' && repaired !== slot) return repaired;
  return null;
}

// Shape B — `Circuit <N> is now the <designation>`; the leading
// "Circuit <N>" is STRUCTURAL and preserved verbatim (case-sensitive:
// the builder always capitalises; a lowercase variant is not ours).
const SHAPE_B = /^(Circuit (\d+) is now the )(.+)$/;
// Shape C — PLAN-D merged create carrier. Only the structural head is
// matched here; the designation/tail split is NOT the first " — "
// (designations may legally contain an em-dash), so the rewrite
// iterates every boundary as a candidate split (cycle-4).
const SHAPE_C_HEAD = /^(Created circuit (\d+), )(.+ — .+)$/;
const SHAPE_C_BOUNDARY = ' — ';
// Shape A — designation prefix before ", circuit <N>, ". GREEDY first
// group: designations may themselves contain commas ("Upstairs sockets,
// lights…"); the builder emits exactly one ", circuit <N>," separator.
const SHAPE_A = /^(.+)(, circuit (\d+), )(.+)$/;

export function rewriteConfirmationDesignationText(
  text: string,
  opts: RewriteOptions
): { text: string; changed: boolean } {
  const b = SHAPE_B.exec(text);
  if (b) {
    const circuit = parseInt(b[2], 10);
    const replacement = resolveSlot(b[3], circuit, opts);
    if (replacement != null && replacement !== b[3]) {
      return { text: `${b[1]}${replacement}`, changed: true };
    }
    return { text, changed: false };
  }
  const c = SHAPE_C_HEAD.exec(text);
  if (c) {
    const circuit = parseInt(c[2], 10);
    const remainder = c[3];
    // Cycle-4 (C4-4) — a designation may itself contain " — "
    // ("Garage — outbuilding feed"), so a lazy first-boundary split
    // mis-attributes its second half to the tail and rewrites only a
    // fragment. Iterate every boundary left-to-right and rewrite the
    // FIRST candidate whose left side positively resolves; if none
    // does, the text passes through byte-identical.
    let searchFrom = 0;
    for (;;) {
      const idx = remainder.indexOf(SHAPE_C_BOUNDARY, searchFrom);
      if (idx === -1) break;
      const slot = remainder.slice(0, idx);
      const tail = remainder.slice(idx);
      if (slot !== '' && tail.length > SHAPE_C_BOUNDARY.length) {
        const replacement = resolveSlot(slot, circuit, opts);
        if (replacement != null && replacement !== slot) {
          return { text: `${c[1]}${replacement}${tail}`, changed: true };
        }
      }
      searchFrom = idx + 1;
    }
    return { text, changed: false };
  }
  const a = SHAPE_A.exec(text);
  if (a) {
    const circuit = parseInt(a[3], 10);
    const replacement = resolveSlot(a[1], circuit, opts);
    if (replacement != null && replacement !== a[1]) {
      return { text: `${replacement}${a[2]}${a[4]}`, changed: true };
    }
    return { text, changed: false };
  }
  return { text, changed: false };
}
