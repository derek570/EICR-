/**
 * Circuit-designation canonicaliser — web/shared port of the backend
 * helper (`src/extraction/designation-canonicaliser.js`, PLAN-B, feedback
 * ids 128 + 131) for PLAN-B2's client-local defence-in-depth sweep.
 *
 * Derek's product rule: the word "circuit" must never appear in a circuit
 * description — the certificate column is already headed "Circuit
 * description". The backend fix (PLAN-B) stops the SERVER storing or
 * speaking it; this port closes the CLIENT-LOCAL write paths that bypass
 * the backend dispatchers entirely (voice appliers, manual edits, CCU/
 * document/preset imports, wire-frame applies) and feed the client-side
 * certificate PDF from the LOCAL model.
 *
 * SEMANTICS ARE A CROSS-PLATFORM CONTRACT — byte-for-byte identical to
 * the backend implementation, pinned by the shared golden-vector fixture
 * `config/designation-canonical-vectors.json` (drift-tested on all three
 * platforms: backend Jest, web Vitest, iOS XCTest). Change behaviour only
 * with a matching fixture update and cross-platform coordination.
 *
 *   - Removes standalone LEADING and TRAILING `circuit` / `circuits`
 *     tokens ONLY, iteratively at each edge until stable. A CLOSED
 *     two-token list — no fuzz, no edit-distance (project ban).
 *   - INTERIOR occurrences are UNCHANGED ("Ring circuit sockets" stays).
 *     Interior removal is a DEFERRED Derek decision (default NO).
 *   - Hyphen-joined compounds are UNCHANGED ("Short-circuit tester"):
 *     tokens are maximal runs of non-delimiter characters and hyphen is
 *     NOT a delimiter — deliberately not regex `\b`, which treats `-` as
 *     a boundary.
 *
 * Clients use REPAIR-only semantics (`repairCircuitDesignation`): strip
 * where a meaningful remainder exists, leave a banned-token-only value
 * UNCHANGED, never reject and never blank a local edit — an EMPTY
 * designation classifies the circuit as a SPARE on both clients (see the
 * spare predicate in `voice-commands.ts`), so "Circuit" → "" would
 * silently flip a real circuit to spare: worse corruption than the
 * banned word.
 *
 * All helpers are PURE and never mutate inputs.
 */

// Delimiters that separate standalone tokens. Hyphen (and slash) are
// DELIBERATELY absent: "Short-circuit" must tokenise as ONE token so the
// edge strip never fires on it. Closed set — extend only with a vector.
const DELIMITER_RE = /[\s.,!?;:'"()[\]]/;

const BANNED_TOKENS = new Set(['circuit', 'circuits']);

interface TokenSpan {
  start: number;
  end: number;
}

/**
 * Tokenise into `{start, end}` spans of maximal non-delimiter runs.
 * Offsets index the ORIGINAL string so the canonical form can be sliced
 * out verbatim (interior spacing/punctuation preserved byte-for-byte).
 */
function tokenSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (DELIMITER_RE.test(text[i])) {
      if (start !== -1) {
        spans.push({ start, end: i });
        start = -1;
      }
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) spans.push({ start, end: text.length });
  return spans;
}

/**
 * Canonicalise a circuit designation: drop standalone leading/trailing
 * `circuit`/`circuits` tokens (iteratively, case-insensitive), trimming
 * the whitespace/punctuation orphaned by each removal. Returns:
 *   - the input UNCHANGED (byte-identical) when no edge token was
 *     removed — including non-string, empty, whitespace-only and
 *     punctuation-only inputs;
 *   - `''` when every token was banned ("Circuit", "Circuit circuits");
 *   - otherwise the sliced remainder, case preserved on kept tokens,
 *     interior content untouched.
 */
export function canonicaliseCircuitDesignation<T>(designation: T): T | string {
  if (typeof designation !== 'string' || designation.length === 0) return designation;
  const spans = tokenSpans(designation);
  if (spans.length === 0) return designation;

  const isBanned = (span: TokenSpan): boolean =>
    BANNED_TOKENS.has(designation.slice(span.start, span.end).toLowerCase());
  // A pure-separator token is a CLOSED grammar: hyphen/slash runs only
  // ("-", "--", "/"). It is dropped ONLY when a banned-token removal has
  // already happened at that edge (it was the removed token's separator,
  // now orphaned): "Circuit - Upstairs lighting" → "Upstairs lighting".
  // A dash with no adjacent banned edge token is content and stays;
  // "Short-circuit" is one token (contains letters) and is never touched.
  // Deliberately NOT "any token without a letter/digit": symbols like
  // "&"/"+"/"⚡" are meaningful designation content and must never be
  // deleted — extend this grammar only through contract vectors.
  const isSeparatorOnly = (span: TokenSpan): boolean =>
    /^[-‐‑‒–—/]+$/u.test(designation.slice(span.start, span.end));

  let first = 0;
  let last = spans.length - 1;
  let removedLeading = false;
  while (first <= last) {
    if (isBanned(spans[first])) {
      first++;
      removedLeading = true;
    } else if (removedLeading && isSeparatorOnly(spans[first])) {
      first++;
    } else break;
  }
  let removedTrailing = false;
  while (last >= first) {
    if (isBanned(spans[last])) {
      last--;
      removedTrailing = true;
    } else if (removedTrailing && isSeparatorOnly(spans[last])) {
      last--;
    } else break;
  }

  if (first === 0 && last === spans.length - 1) return designation; // nothing removed
  if (first > last) return ''; // every token banned

  // Per-edge slicing: an edge only loses its surrounding whitespace /
  // punctuation when a removal actually happened there ("orphaned by the
  // removals" — the untouched edge keeps its original bytes).
  const sliceStart = first > 0 ? spans[first].start : 0;
  const sliceEnd = last < spans.length - 1 ? spans[last].end : designation.length;
  return designation.slice(sliceStart, sliceEnd);
}

/**
 * TRUE when a raw designation is non-empty text that canonicalises to
 * nothing — i.e. it consists solely of banned edge tokens. Web clients
 * do NOT reject on this (repair-only policy); exported for parity with
 * the backend helper and for tests that pin the repair wrapper's
 * banned-token-only behaviour.
 */
export function designationCanonicalisesToEmpty(designation: unknown): boolean {
  if (typeof designation !== 'string') return false;
  if (designation.trim() === '') return false;
  const canonical = canonicaliseCircuitDesignation(designation);
  return typeof canonical === 'string' && canonical.trim() === '';
}

/**
 * Client repair boundary: strip banned edge tokens where a MEANINGFUL
 * remainder exists; leave a banned-token-only value UNCHANGED (never
 * blank it — empty designation = spare on both clients) and never
 * reject. Pure; safe on non-strings (returned verbatim). This is the
 * function client write/load boundaries actually CALL.
 */
export function repairCircuitDesignation<T>(designation: T): T | string {
  if (typeof designation !== 'string' || designation.length === 0) return designation;
  const canonical = canonicaliseCircuitDesignation(designation);
  if (typeof canonical !== 'string') return designation;
  if (canonical.trim() === '' && designation.trim() !== '') return designation;
  return canonical;
}
