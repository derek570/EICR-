/**
 * Circuit-designation canonicaliser — PLAN-B (feedback ids 128 + 131,
 * field session 17821FFA, 2026-08-23).
 *
 * Derek's product rule: the word "circuit" must never appear in a circuit
 * description — the certificate column is already headed "Circuit
 * description", so a stored "Upstairs Lighting Circuit" reads as
 * "Upstairs Lighting Circuit circuit" (id 128). The same stored trailing
 * token also defeated BOTH designation-matcher passes at IR-script entry
 * ("insulation resistance for upstairs lighting live to live is LIM"
 * asked "Which circuit?" despite the circuit being named — id 131,
 * Audio-First §2 violation).
 *
 * SCOPE (deliberate, review-settled over 22 /rp rounds):
 *   - Removes standalone LEADING and TRAILING `circuit` / `circuits`
 *     tokens ONLY, iteratively at each edge until stable. A CLOSED
 *     two-token list — no fuzz, no edit-distance (project ban).
 *   - INTERIOR occurrences are UNCHANGED ("Ring circuit sockets" stays
 *     as-is). Interior removal is a DEFERRED Derek decision (default NO
 *     this wave) — do not widen without his say-so.
 *   - Hyphen-joined compounds are UNCHANGED ("Short-circuit tester"):
 *     a hyphen-adjacent `circuit` is NOT a standalone token. This is why
 *     the implementation uses an explicit DELIMITER GRAMMAR (tokens are
 *     maximal runs of non-delimiter characters; hyphen is NOT a
 *     delimiter) rather than regex `\b`, which treats `-` as a boundary.
 *
 * Caller policy for a banned-token-only input ("Circuit" → ''):
 *   - Interactive tool dispatch (create/rename/record_reading/bulk):
 *     REJECT with `invalid_designation` — never store the bare banned
 *     word. See `designationCanonicalisesToEmpty`.
 *   - Persistence paths (circuitsToCSV etc.): REPAIR-never-reject —
 *     strip where a meaningful remainder exists, leave a
 *     banned-token-only value UNCHANGED. Blanking is deliberately
 *     rejected: an EMPTY designation classifies the circuit as a SPARE
 *     on both clients (`packages/shared-utils/src/voice-commands.ts`
 *     spare predicate), so "Circuit" → "" would silently flip a real
 *     circuit to spare — worse corruption than the banned word.
 *     See `repairCircuitDesignation`.
 *
 * The committed golden-vector fixture
 * `config/designation-canonical-vectors.json` is the CROSS-PLATFORM
 * CONTRACT: PLAN-B2's iOS/web implementations consume it byte-identical
 * (drift tests on three platforms). Change vectors only with a matching
 * fixture update and cross-platform coordination.
 *
 * All helpers are PURE and never mutate inputs.
 */

// Delimiters that separate standalone tokens. Hyphen (and slash) are
// DELIBERATELY absent: "Short-circuit" must tokenise as ONE token so the
// edge strip never fires on it. Closed set — extend only with a vector.
const DELIMITER_RE = /[\s.,!?;:'"()[\]]/;

const BANNED_TOKENS = new Set(['circuit', 'circuits']);

/**
 * Tokenise into `{start, end}` spans of maximal non-delimiter runs.
 * Offsets index the ORIGINAL string so the canonical form can be sliced
 * out verbatim (interior spacing/punctuation preserved byte-for-byte).
 */
function tokenSpans(text) {
  const spans = [];
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
 *
 * @param {*} designation
 * @returns {*} canonical designation (same type as input when unchanged)
 */
export function canonicaliseCircuitDesignation(designation) {
  if (typeof designation !== 'string' || designation.length === 0) return designation;
  const spans = tokenSpans(designation);
  if (spans.length === 0) return designation;

  const isBanned = (span) =>
    BANNED_TOKENS.has(designation.slice(span.start, span.end).toLowerCase());
  // A pure-separator token ("-", "--", "/") holds no letter/digit. It is
  // dropped ONLY when a banned-token removal has already happened at that
  // edge (it was the removed token's separator, now orphaned): "Circuit -
  // Upstairs lighting" → "Upstairs lighting". A dash with no adjacent
  // banned edge token is content and stays ("- Upstairs" unchanged);
  // "Short-circuit" is one token (contains letters) and is never touched.
  const isSeparatorOnly = (span) => !/[\p{L}\p{N}]/u.test(designation.slice(span.start, span.end));

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
 * nothing — i.e. it consists solely of banned edge tokens ("Circuit",
 * "circuits", "Circuit circuit."). This is the interactive dispatchers'
 * reject-empty gate condition: it deliberately does NOT fire for raw
 * empty / whitespace-only / punctuation-only inputs (those keep today's
 * semantics untouched).
 *
 * @param {*} designation raw (pre-canonicalisation) value
 * @returns {boolean}
 */
export function designationCanonicalisesToEmpty(designation) {
  if (typeof designation !== 'string') return false;
  if (designation.trim() === '') return false;
  const canonical = canonicaliseCircuitDesignation(designation);
  return typeof canonical === 'string' && canonical.trim() === '';
}

/**
 * Persistence-path repair: strip banned edge tokens where a MEANINGFUL
 * remainder exists; leave a banned-token-only value UNCHANGED (never
 * blank it — empty designation = spare on both clients) and never
 * reject. Pure; safe on non-strings (returned verbatim).
 *
 * @param {*} designation
 * @returns {*} repaired designation
 */
export function repairCircuitDesignation(designation) {
  if (typeof designation !== 'string' || designation.length === 0) return designation;
  const canonical = canonicaliseCircuitDesignation(designation);
  if (typeof canonical !== 'string') return designation;
  if (canonical.trim() === '' && designation.trim() !== '') return designation;
  return canonical;
}
