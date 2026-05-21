/**
 * Parse the inspector's reply to the RCD bulk-apply prompt:
 *   "Apply these RCD details to any other circuits? Say 'all' or a
 *    range like '1 to 6'."
 *
 * Recognised shapes:
 *   "all" / "yes all" / "every circuit" / "all of them"
 *     → { scope: 'all' }
 *
 *   "1 to 6" / "1 through 6" / "1 thru 6" / "1-6" / "circuits 1 to 6"
 *     → { scope: 'range', circuits: [1, 2, 3, 4, 5, 6] }
 *
 *   "1, 3, 5" / "1 and 3 and 5" / "circuits 1 3 and 5"
 *     → { scope: 'list', circuits: [1, 3, 5] }
 *
 *   "no" / "nope" / "just this one" / "skip" / "cancel" / silence
 *     → { scope: 'none' }
 *
 *   Anything else / unparseable
 *     → { scope: 'none' } (no-op, the engine finishes the script normally)
 *
 * Range parsing is bidirectional-tolerant ("1 to 6" and "6 to 1" both
 * produce [1,2,3,4,5,6]); the engine never wants to overwrite circuits
 * in reverse order, so we normalise. Caps the range size at 50 to
 * prevent a misheard "1 to 200" from accidentally creating 200 circuits.
 *
 * Why "no" wins over a stray digit: the inspector saying "no, just
 * circuit 1" should NOT bulk-apply to circuit 1 — they're already on
 * circuit 1 (that's where the original RCD reading lives), and the
 * volunteered "no" indicates they don't want a bulk operation. The
 * decline-pattern check runs first, before list/range/all detection.
 */
const DECLINE_RE =
  /\b(?:no|nope|nah|nothing|none|just\s+this\s+one|just\s+the\s+one|skip|cancel|don'?t|do\s*not)\b/i;
const ALL_RE = /\b(?:all(?:\s+of\s+them)?|every(?:\s+circuit)?|everything|yes\s+all|the\s+lot)\b/i;
const RANGE_RE = /\b(\d{1,3})\s*(?:to|through|thru|until|-|—|–)\s*(\d{1,3})\b/i;
const DIGIT_RE = /\b(\d{1,3})\b/g;

const MAX_RANGE_SIZE = 50;

export function parseCircuitRange(text) {
  if (typeof text !== 'string' || !text.trim()) return { scope: 'none' };
  const t = text.trim();

  // 1. Explicit decline beats every other pattern. Field rationale: a
  //    misheard "1" attached to "no" shouldn't trigger a single-
  //    circuit bulk apply.
  if (DECLINE_RE.test(t)) return { scope: 'none' };

  // 2. Range form — checked before the bare-digit list because "1 to
  //    6" contains two digits that the list path would otherwise pull
  //    out as [1, 6] instead of the full inclusive range.
  const range = t.match(RANGE_RE);
  if (range) {
    const a = parseInt(range[1], 10);
    const b = parseInt(range[2], 10);
    if (a > 0 && b > 0 && a <= 200 && b <= 200) {
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      if (end - start + 1 <= MAX_RANGE_SIZE) {
        return { scope: 'range', circuits: rangeFromTo(start, end) };
      }
    }
  }

  // 3. "All" — after range so "all the way to 6" doesn't get
  //    swallowed by ALL_RE before RANGE_RE has a chance.
  if (ALL_RE.test(t)) return { scope: 'all' };

  // 4. Discrete list of circuit numbers. Filters out 0 (legacy
  //    board/installation bucket) and anything > 200 (sanity guard).
  const digits = [...t.matchAll(DIGIT_RE)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => n > 0 && n <= 200);
  if (digits.length >= 1) {
    const unique = [...new Set(digits)].sort((a, b) => a - b);
    return { scope: 'list', circuits: unique };
  }

  return { scope: 'none' };
}

/**
 * Format the inspector-confirm TTS for a given parse result. Used in
 * the engine's bulk-apply branch to read back what was applied.
 *
 *   scope 'all'   → "Applied RCD to all circuits."
 *   scope 'range' → "Applied RCD to circuits 1 through 6."
 *   scope 'list'  → "Applied RCD to circuits 1, 3 and 5."
 *   scope 'none'  → null (caller emits the normal finish TTS).
 *
 * `applied` is the actual count after the engine has filtered the
 * parse result against the snapshot (e.g. when 'all' resolves to 14
 * existing circuits, or when a range includes non-existent circuits
 * that the engine just created blank). The TTS reads back the parse
 * result, not the post-apply count — the inspector cares about which
 * circuits were targeted, not how many were already populated.
 */
export function formatBulkApplyConfirm(scope, parse, fieldsLabel = 'RCD') {
  if (scope === 'all') {
    return `Applied ${fieldsLabel} to all circuits.`;
  }
  if (scope === 'range') {
    const { circuits } = parse;
    if (!circuits || circuits.length === 0) return null;
    if (circuits.length === 1) {
      return `Applied ${fieldsLabel} to circuit ${circuits[0]}.`;
    }
    const first = circuits[0];
    const last = circuits[circuits.length - 1];
    return `Applied ${fieldsLabel} to circuits ${first} through ${last}.`;
  }
  if (scope === 'list') {
    const { circuits } = parse;
    if (!circuits || circuits.length === 0) return null;
    if (circuits.length === 1) {
      return `Applied ${fieldsLabel} to circuit ${circuits[0]}.`;
    }
    if (circuits.length === 2) {
      return `Applied ${fieldsLabel} to circuits ${circuits[0]} and ${circuits[1]}.`;
    }
    const head = circuits.slice(0, -1).join(', ');
    const tail = circuits[circuits.length - 1];
    return `Applied ${fieldsLabel} to circuits ${head} and ${tail}.`;
  }
  return null;
}

function rangeFromTo(start, end) {
  const out = [];
  for (let i = start; i <= end; i += 1) out.push(i);
  return out;
}
