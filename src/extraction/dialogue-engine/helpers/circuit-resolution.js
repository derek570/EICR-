/**
 * Circuit-resolution helpers shared across all dialogue scripts.
 *
 * `findCircuitByDesignation` was previously copy-pasted in
 * ring-continuity-script.js and insulation-resistance-script.js, with
 * the same key-mismatch bug in both (`bucket.designation` vs the
 * canonical `bucket.circuit_designation` written by
 * `_seedStateFromJobState`). Lifting it into one helper means future
 * key-shape changes land once.
 *
 * "Work on Board" hotfix slice 4 (2026-05-08) — replaced direct
 * `snapshot.circuits[ref]` walks with the dual-shape helpers
 * `getCircuitBucket` and `listCircuitRefsInBoard` so designation /
 * field reads scope to the ACTIVE board (snapshot.currentBoardId)
 * rather than walking every circuit on every board. Pre-fix a
 * sub-board flow on currentBoardId='sub-1' would designation-match
 * against main's circuits too (the bare-numeric keys), giving
 * cross-board false matches when a label like "Cooker" appeared
 * on multiple boards.
 */

import { getCircuitBucket, listCircuitRefsInBoard } from '../../stage6-multi-board-shape.js';
import { canonicaliseCircuitDesignation } from '../../designation-canonicaliser.js';

/**
 * Try the digit-form regex against a transcript. Recognises:
 *   - "circuit 13" / "circuit 13."
 *   - bare "13" / "13." (whole-utterance form, e.g. an answer to
 *     "Which circuit?")
 *
 * Returns the integer or null. Excludes 0 and negatives.
 */
export function parseCircuitDigit(text) {
  return parseCircuitDigitWithSpan(text)?.ref ?? null;
}

/**
 * Span-bearing variant of `parseCircuitDigit` (feedback id 105, 2026-07-29,
 * group C fix 1). ADDITIVE — the scalar API above delegates here and is
 * byte-identical for every caller. Returns
 * `{ref, start, end, wholeReply}` or null:
 *   - `start`/`end` — the matched span within `text` (the resolution text
 *     the IR exclusive-voltage masking rule blanks before parseVoltage runs
 *     on the reply remainder);
 *   - `wholeReply: true` — the bare whole-utterance numeric alternative
 *     matched (e.g. "56" answering "Which circuit?"), meaning the ENTIRE
 *     reply is the circuit reference and the masking rule masks it all — a
 *     bare "56" on a 56-circuit board must resolve the circuit and draw the
 *     voltage ask, never parse as a voltage.
 */
export function parseCircuitDigitWithSpan(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(/\bcircuit\s*(\d{1,3})\b|^\s*(\d{1,3})\s*\.?\s*$/i);
  if (!m) return null;
  const ref = Number(m[1] ?? m[2]);
  if (!Number.isInteger(ref) || ref <= 0) return null;
  return {
    ref,
    start: m.index,
    end: m.index + m[0].length,
    wholeReply: m[1] === undefined,
  };
}

/**
 * Normalise a USER designation utterance for matching / echoing: lowercase,
 * collapse whitespace, drop trailing sentence punctuation, and strip a
 * single leading article/filler phrase ("for the sockets." → "sockets").
 * F1AC26FB #3.1/#3.2. Longest filler phrases first so "for the" wins over
 * "for". Applies ONLY to user input — stored designations are never
 * stripped. Returns '' for empty / non-string input.
 */
export function stripDesignationFiller(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!,;:]+$/g, '')
    .replace(/^(?:for\s+the|on\s+the|in\s+the|for|on|the|a|an)\s+/, '')
    .trim();
}

/**
 * Feedback id 116 (2026-08-12) — pass-2 morphological fold table.
 *
 * A CLOSED token-equivalence map listing every accepted form explicitly.
 * This is deterministic enumerated normalisation, NOT edit-distance fuzz —
 * the fuzzy-transcript-correction ban (certmate-research-methodology)
 * stays intact. Generic `s`/`es` suffix stripping is deliberately NOT
 * implemented: a naïve strip mangles singular tokens ("house", "mains").
 * Add entries only with a test each.
 */
const DESIGNATION_FOLD_TABLE = new Map([
  ['light', 'light'],
  ['lights', 'light'],
  ['lighting', 'light'],
  ['socket', 'socket'],
  ['sockets', 'socket'],
  ['heater', 'heater'],
  ['heating', 'heater'],
]);

// Leading filler tokens dropped from the USER token sequence in pass 2 —
// the token-level analogue of `stripDesignationFiller`'s single leading
// phrase. Dropping RECORDS (never rewriting the string) is what keeps raw
// offsets intact for `matchedUserSpan`.
const PASS2_LEADING_FILLER = new Set(['for', 'on', 'in', 'the', 'a', 'an']);

/**
 * Tokenise text into `{folded, start, end}` records with RAW offsets into
 * the original string. Tokens are maximal runs of Unicode letters/digits,
 * so EVERY punctuation separator folds at the token level — hyphens,
 * slashes, periods alike ("kitchen-sockets", "Kitchen/Diner" each tokenise
 * as two records; ep-diff-review cycle 1: the earlier whitespace+hyphen
 * splitter kept internal punctuation like `/` inside tokens, defeating the
 * fold). Match indices ARE the raw offsets, so nothing is rewritten.
 */
function tokeniseWithOffsets(text) {
  const records = [];
  if (typeof text !== 'string' || !text) return records;
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    records.push({ folded: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return records;
}

/** Map a folded token through the closed equivalence table (identity when absent). */
function foldToken(folded) {
  return DESIGNATION_FOLD_TABLE.get(folded) ?? folded;
}

/**
 * Contiguous token-sequence containment: does `needle` appear as a
 * contiguous run inside `haystack` (comparing table-folded tokens)?
 * Returns the start index of the first run, or -1.
 */
function findTokenRun(haystackFolded, needleFolded) {
  if (needleFolded.length === 0 || needleFolded.length > haystackFolded.length) return -1;
  outer: for (let i = 0; i + needleFolded.length <= haystackFolded.length; i++) {
    for (let j = 0; j < needleFolded.length; j++) {
      if (haystackFolded[i + j] !== needleFolded[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Look up circuits whose designation matches a transcript fragment.
 *
 * Returns `{ matched, candidates, sharedDesignation }`:
 *   - `matched` is the circuit_ref ONLY when exactly one designation
 *     matches; null on zero matches AND on 2+ matches (ambiguous).
 *   - `candidates` is every ref whose designation matched the user's
 *     text (length 0 → no match; length 1 → unique; length ≥ 2 →
 *     ambiguous, caller should disambiguate).
 *   - `sharedDesignation` is the lowercased designation string when
 *     EVERY candidate's designation collapses to the same canonical
 *     form (e.g. three circuits all labelled "Sockets" by CCU). null
 *     when candidates differ in designation. Used by the engine to
 *     emit "Which 'sockets' — circuit 2, 4 or 7?".
 *
 * Match rules (unchanged from the original `findCircuitByDesignation`):
 *   - Lowercase + collapse whitespace on BOTH sides.
 *   - Bidirectional substring: user's text may be a longer sentence
 *     containing the designation, or a shorter prefix of it.
 *   - Skips circuit 0 — that bucket is the supply / installation slot.
 *
 * Optional `restrictToRefs` narrows the search to a specific candidate
 * set. Used by the active-path disambiguation handler when the
 * inspector replies to a "Which 'sockets' — circuit 2, 4 or 7?" prompt
 * with a designation rather than a digit ("the kitchen one") — we want
 * to match against ONLY the three candidate circuits' designations,
 * not the whole board.
 *
 * The canonical schema key is `circuit_designation` (matching
 * `field_schema.json.circuit_fields` and what
 * `_seedStateFromJobState` writes). Falls back to bare `designation`
 * for legacy in-memory shapes — the existing test suites use that
 * form, and keeping the fallback avoids re-flowing every fixture.
 */
export function findCircuitsByDesignation(session, text, opts = {}) {
  const empty = { matched: null, candidates: [], sharedDesignation: null };
  if (typeof text !== 'string' || !text) return empty;
  const snapshot = session?.stateSnapshot;
  if (!snapshot?.circuits) return empty;
  // Strip a single leading article/filler phrase + trailing punctuation
  // from the USER text so "For the sockets." resolves against a "Sockets"
  // designation (F1AC26FB #3.1). Applies ONLY to user input — the
  // stored-designation reads below (`circuit_designation || designation`)
  // are deliberately NOT stripped.
  const normalised = stripDesignationFiller(text);
  if (!normalised) return empty;

  // PLAN-B (id 131, 2026-08-23) — QUERY-side edge-token canonicalisation.
  // Interior banned tokens are RETAINED by design ("Ring circuit sockets"),
  // so canonicalising only the stored side is insufficient: a generic reply
  // "circuit"/"the circuit" would still substring-match a stored interior
  // token and uniquely misroute a pending safety reading. A reply whose
  // canonical remainder is EMPTY (nothing but banned tokens) yields ZERO
  // candidates; both pass directions compare the CANONICAL query, while the
  // raw text is retained for spans/display.
  const canonQuery = String(canonicaliseCircuitDesignation(normalised))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!canonQuery) return empty;

  // Hotfix slice 4 — designation matching scopes to the ACTIVE board so
  // a sub-board flow doesn't false-match against main's designations.
  // listCircuitRefsInBoard returns refs filtered to currentBoardId under
  // dual-shape, OR every numeric ref under flag-off (legacy single-board
  // behaviour preserved). getCircuitBucket reads the right composite-key
  // bucket per ref. Array-shape snapshots (legacy in-memory) fall through
  // to the legacy walk to keep older fixtures green.
  const restrict =
    Array.isArray(opts.restrictToRefs) && opts.restrictToRefs.length > 0
      ? new Set(opts.restrictToRefs.map(Number))
      : null;

  // PLAN-B (id 131) — per-row canonical decoration, computed once during
  // the board-scoped walk so BOTH passes share the same edge-token rule:
  //   - canonDes: the stored designation with standalone leading/trailing
  //     circuit/circuits tokens dropped (normalised lowercase). The
  //     comparison form for both passes; the RAW form is kept for
  //     display/sharedDesignation only.
  //   - EMPTY canonical (a stored bare "Circuit" — reachable, the
  //     persistence path deliberately leaves them unchanged) EXCLUDES the
  //     row from designation matching entirely: not just the canonical
  //     variant (JS includes('') is always true) but the RAW comparison
  //     too — a raw "circuit" designation would substring-match nearly any
  //     utterance mentioning the word.
  //   - tier 'strict' (single-letter or numeric-only canonical remainder,
  //     e.g. "Circuit A" → "A"): indistinguishable from an article/dictated
  //     value after case-normalisation, so it matches ONLY a bounded
  //     whole-designation reply or an explicit circuit-noun-adjacent form.
  //   - tier 'short' (< 3 chars otherwise): token-boundary comparison only
  //     (a 1-2 char substring matches almost any transcript).
  //   Fail CLOSED: a missed match costs one legitimate ask; a false match
  //   mis-files a reading on a legally-significant certificate.
  const rows = [];
  const collectRow = (ref, designation) => {
    const normDes = designation.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normDes) return;
    const canonDes = String(canonicaliseCircuitDesignation(normDes)).replace(/\s+/g, ' ').trim();
    if (!canonDes) return; // empty-canonical row: excluded from BOTH passes
    let tier = 'normal';
    if (/^[\p{L}]$/u.test(canonDes) || /^[\p{N}]+$/u.test(canonDes)) tier = 'strict';
    else if (canonDes.length < 3) tier = 'short';
    rows.push({ ref, normDes, canonDes, tier });
  };

  if (Array.isArray(snapshot.circuits)) {
    // Array-shape — walk verbatim (legacy fixture compat).
    for (const c of snapshot.circuits) {
      if (!c || typeof c !== 'object') continue;
      const ref = Number(c.circuit_ref);
      if (!Number.isInteger(ref) || ref <= 0) continue;
      if (restrict && !restrict.has(ref)) continue;
      const designation = c.circuit_designation || c.designation;
      if (typeof designation !== 'string' || !designation.trim()) continue;
      collectRow(ref, designation);
    }
  } else {
    // Dual-shape — use the active-board-aware helpers.
    const activeBoardId = snapshot.currentBoardId;
    const refs = listCircuitRefsInBoard(snapshot, activeBoardId);
    for (const ref of refs) {
      if (!Number.isInteger(ref) || ref <= 0) continue;
      if (restrict && !restrict.has(ref)) continue;
      const bucket = getCircuitBucket(snapshot, ref, activeBoardId);
      if (!bucket || typeof bucket !== 'object') continue;
      const designation = bucket.circuit_designation || bucket.designation;
      if (typeof designation !== 'string' || !designation.trim()) continue;
      collectRow(ref, designation);
    }
  }

  const matches = [];
  // Comparison metadata: designationsByRef carries the CANONICAL form (it
  // drives `matchedDesignation`, which the engine's mask branch searches
  // for literally in the reply — the canonical variant IS the findable
  // text); rawDesignationsByRef keeps the original normalised stored form
  // for sharedDesignation/display (the quote-back speaks what is stored).
  const designationsByRef = new Map();
  const rawDesignationsByRef = new Map();
  // TRUE when at least one pass-1 admission exists ONLY through the
  // canonicalised stored/query variant (the raw bidirectional comparison
  // would NOT have matched). Pass 2 must then also run: a
  // canonicalisation-created pass-1 match could otherwise SUPPRESS a pass-2
  // morphology match that is the true target — a silent retarget instead
  // of an ask (PLAN-B round-19 finding).
  let pass1HasCanonicalOnlyAdmission = false;

  // Tokenised canonical query for the short-tier token-boundary rule.
  const canonQueryTokens = canonQuery.split(' ');

  // PLAN-B Codex-review cycle 1 — QUERY-side tier classification. The
  // short-remainder guard on the STORED side alone leaves a hole: a
  // canonicalised query like "the A circuit" → "a" would enter the NORMAL
  // character-substring comparison and match any designation CONTAINING
  // "a" ("garage") — a false match/false ambiguity. A strict-class query
  // (single letter or numeric-only) or a short query (< 3 chars) never
  // enters character-substring comparison in either direction; against
  // NORMAL rows it may match only as a whole-token run inside the stored
  // canonical token sequence (which keeps today's legitimate reverse
  // matches — reply "56" against stored "56 sockets" — alive), and pass 2
  // is skipped entirely for it (a one-token fold containment would
  // replicate the same hazard).
  // Mini-review c1 split: a NUMERIC strict query keeps the legitimate
  // whole-token reverse match against normal rows ("56" vs "56 sockets");
  // a SINGLE-LETTER strict query does not — "A" as a token is
  // indistinguishable from the article, so letting it uniquely resolve a
  // normal row ("A garage radial") recreates the article false-target
  // hazard. Letter-strict queries match ONLY strict stored rows through
  // the sanctioned bounded/adjacency grammar.
  let queryTier = 'normal';
  if (/^[\p{L}]$/u.test(canonQuery)) queryTier = 'strict_letter';
  else if (/^[\p{N}]+$/u.test(canonQuery)) queryTier = 'strict_numeric';
  else if (canonQuery.length < 3) queryTier = 'short';

  for (const row of rows) {
    let hit = false;
    if (row.tier === 'strict') {
      // Bounded whole-designation reply ("A", "A." — filler/punctuation
      // already stripped from `normalised`), or explicitly adjacent to a
      // circuit noun. The three sanctioned adjacency shapes only:
      // "circuit A", "the A circuit", "A way". Nothing broader — a bare
      // "a"/number inside longer prose must never match.
      const tok = row.canonDes.toLowerCase();
      const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Adjacency is tested against the RAW lowercased text, not the
      // filler-stripped form: stripDesignationFiller eats the leading
      // "the", which is load-bearing for the "the A circuit" shape (and
      // what distinguishes it from a bare article in prose).
      const rawLower = text.toLowerCase().replace(/\s+/g, ' ').trim();
      const adjacency = new RegExp(
        `(?:^|\\s)circuits?\\s+${esc}(?=\\s|$|[.,!?])|(?:^|\\s)the\\s+${esc}\\s+circuits?(?=\\s|$|[.,!?])|(?:^|\\s)${esc}\\s+way(?=\\s|$|[.,!?])`
      );
      hit = normalised === tok || adjacency.test(rawLower);
    } else if (row.tier === 'short') {
      // Token-boundary only: the canonical remainder must appear as a
      // contiguous token run of the canonical query — never a raw
      // character-level substring.
      hit = findTokenRun(canonQueryTokens, row.canonDes.split(' ')) !== -1;
    } else if (queryTier === 'strict_numeric' || queryTier === 'short') {
      // Numeric-strict/short QUERY vs a normal row: whole-token-run
      // containment of the query inside the stored canonical tokens only
      // (see the query-tier note above) — never character substring.
      hit = findTokenRun(row.canonDes.split(' '), canonQueryTokens) !== -1;
    } else if (queryTier === 'strict_letter') {
      // Letter-strict query vs a normal row: fail closed (article class).
      hit = false;
    } else {
      hit = canonQuery.includes(row.canonDes) || row.canonDes.includes(canonQuery);
    }
    if (!hit) continue;
    matches.push(row.ref);
    designationsByRef.set(row.ref, row.canonDes);
    rawDesignationsByRef.set(row.ref, row.normDes);
    // Would today's RAW bidirectional comparison have admitted this row?
    // (Pass-1 precedence over pass 2 is preserved only when EVERY pass-1
    // match existed under the raw comparison.)
    const rawHit = normalised.includes(row.normDes) || row.normDes.includes(normalised);
    if (!rawHit) pass1HasCanonicalOnlyAdmission = true;
  }

  // Pass 2 (feedback id 116, 2026-08-12) — fold-table token-sequence pass.
  // Consulted when pass 1 yielded ZERO candidates (the pre-116 rule), AND
  // ALSO (PLAN-B round-19) when pass 1 admitted a candidate only through a
  // newly-canonicalised variant — the union + dedup below then applies
  // normal uniqueness handling (unique → match; multiple → ambiguity ask).
  // "Upstairs lights" vs designation "Upstairs Lighting" has no substring
  // relation in either direction, but folds to the same token sequence.
  // Tokenises the ORIGINAL caller text so raw offsets survive into
  // `matchedUserSpan` (consumed by the engine's designation-mask branch —
  // a pass-2 matched designation is NOT literally findable in the reply,
  // and without the span the mask would blank the ENTIRE reply and drop a
  // co-dictated voltage).
  const spansByRef = new Map();
  if (
    (matches.length === 0 || pass1HasCanonicalOnlyAdmission) &&
    rows.length > 0 &&
    queryTier === 'normal' // strict/short queries never enter fold containment
  ) {
    let userRecords = tokeniseWithOffsets(text);
    // Drop LEADING filler records (token-level analogue of
    // stripDesignationFiller — drop records, never rewrite).
    while (userRecords.length > 0 && PASS2_LEADING_FILLER.has(userRecords[0].folded)) {
      userRecords = userRecords.slice(1);
    }
    // PLAN-B (id 131) — drop standalone LEADING and TRAILING banned edge
    // tokens from the user token sequence too (the pass-2 analogue of the
    // canonical query): stored "Ring circuit sockets" vs a bare "circuit"
    // reply must not produce a one-token containment run.
    const BANNED_EDGE = new Set(['circuit', 'circuits']);
    while (userRecords.length > 0 && BANNED_EDGE.has(userRecords[0].folded)) {
      userRecords = userRecords.slice(1);
    }
    while (userRecords.length > 0 && BANNED_EDGE.has(userRecords[userRecords.length - 1].folded)) {
      userRecords = userRecords.slice(0, -1);
    }
    const userFolded = userRecords.map((r) => foldToken(r.folded));
    if (userFolded.length > 0) {
      for (const row of rows) {
        if (designationsByRef.has(row.ref)) continue;
        // strict-tier rows never participate in pass-2 containment either —
        // a single-letter/numeric folded token would match any article or
        // dictated value at token level (same fail-closed rationale).
        if (row.tier === 'strict') continue;
        // Both passes use the SAME edge-token rule: comparison tokens come
        // from the CANONICALISED stored variant.
        const desFolded = tokeniseWithOffsets(row.canonDes).map((r) => foldToken(r.folded));
        if (desFolded.length === 0) continue;
        // Token-SEQUENCE containment in both directions (mirrors pass 1's
        // bidirectional substring semantics at token granularity).
        const runIdx = findTokenRun(userFolded, desFolded);
        if (runIdx !== -1) {
          // Designation ⊂ user text: span = the matched contiguous run's
          // raw extent in the original text.
          matches.push(row.ref);
          designationsByRef.set(row.ref, row.canonDes);
          rawDesignationsByRef.set(row.ref, row.normDes);
          spansByRef.set(row.ref, {
            start: userRecords[runIdx].start,
            end: userRecords[runIdx + desFolded.length - 1].end,
          });
        } else if (findTokenRun(desFolded, userFolded) !== -1) {
          // User text ⊂ designation: the whole (filler-dropped) reply IS
          // the resolution text.
          matches.push(row.ref);
          designationsByRef.set(row.ref, row.canonDes);
          rawDesignationsByRef.set(row.ref, row.normDes);
          spansByRef.set(row.ref, {
            start: userRecords[0].start,
            end: userRecords[userRecords.length - 1].end,
          });
        }
      }
    }
  }

  // Deduplicate (in case the iteration produced a circuit twice via
  // string + number key collision).
  const candidates = Array.from(new Set(matches)).sort((a, b) => a - b);

  // Shared designation: only meaningful when every candidate collapsed
  // to the same canonical text. The CCU label pass deliberately stamps
  // adjacent circuits with identical labels ("Sockets" × 3, "Lighting"
  // × 2) — the engine quotes that shared label back to the inspector
  // ("Which 'sockets' — circuit 2, 4 or 7?"). When candidates have
  // distinct designations, no single quote-back is honest.
  // PLAN-B (id 131) — computed over the RAW stored forms (the quote-back
  // speaks what is stored; the canonical form is comparison metadata).
  let sharedDesignation = null;
  if (candidates.length >= 1) {
    const first = rawDesignationsByRef.get(candidates[0]) ?? null;
    if (first && candidates.every((r) => rawDesignationsByRef.get(r) === first)) {
      sharedDesignation = first;
    }
  }

  return {
    matched: candidates.length === 1 ? candidates[0] : null,
    candidates,
    sharedDesignation,
    // Feedback id 105 (2026-07-29, group C fix 1) — ADDITIVE resolution
    // metadata: the designation string of the UNIQUE match (null
    // otherwise). The IR exclusive-voltage masking rule blanks this text out
    // of the reply before parseVoltage runs on the remainder, so a
    // designation answer that ALSO carries "tested at 500" keeps the
    // voltage parseable while the resolution text itself cannot be misread.
    // PLAN-B (id 131) — this is now the CANONICAL variant (edge circuit
    // tokens dropped): a canonicalised match's stored form is no longer
    // literally present in the reply, and returning the original would make
    // the engine's mask branch blank the WHOLE reply and drop a co-dictated
    // value ("Upstairs lighting, tested at 500" would lose the 500). The
    // canonical variant IS the findable text; the ORIGINAL stored form
    // stays available via sharedDesignation for quote-back/display.
    matchedDesignation:
      candidates.length === 1 ? (designationsByRef.get(candidates[0]) ?? null) : null,
    // Feedback id 116 (2026-08-12) — raw-offset span of the user text that
    // established a UNIQUE pass-2 (fold-table) match; null for pass-1
    // matches (their matchedDesignation is literally findable in the reply,
    // so the mask branch's existing literal search still works) and for
    // zero/ambiguous outcomes. `{start, end}` indexes into the ORIGINAL
    // `text` argument.
    matchedUserSpan: candidates.length === 1 ? (spansByRef.get(candidates[0]) ?? null) : null,
  };
}

/**
 * Backwards-compatible single-result wrapper. Returns the ref on a
 * unique match or null otherwise (zero AND ambiguous both → null).
 *
 * Kept so the legacy ring-continuity-script.js / insulation-resistance
 * -script.js paths and their test suites stay byte-identical. The live
 * dialogue-engine path uses `findCircuitsByDesignation` directly so it
 * can act on ambiguity instead of swallowing it.
 */
export function findCircuitByDesignation(session, text) {
  return findCircuitsByDesignation(session, text).matched;
}

/**
 * Read whatever values for a given list of fields already exist on the
 * snapshot for a circuit. Used at script-entry time to seed the values
 * map from the persisted state (so the first ask skips slots that are
 * already filled from a prior session or manual entry).
 *
 * Tolerant of `circuits` being either Object or Array — the snapshot
 * shape can vary across mutators.
 */
export function readExistingValues(session, circuit_ref, fields, boardId = undefined) {
  const out = {};
  const snapshot = session?.stateSnapshot;
  if (!snapshot) return out;
  const circuits = snapshot.circuits;
  let bucket = null;
  if (Array.isArray(circuits)) {
    bucket = circuits.find((c) => c && Number(c.circuit_ref) === Number(circuit_ref)) || null;
  } else if (circuits && typeof circuits === 'object') {
    // Hotfix slice 4 — use the dual-shape lookup so the read scopes to the
    // active board's bucket rather than the bare numeric key (which would
    // hit main's circuit even when currentBoardId is sub-1).
    //
    // PLAN-A (feedback-2026-09-17) — an explicit `boardId` overrides the
    // CURRENT board. The post-dispatch entry hook needs it: a `record_reading`
    // can carry an explicit `board_id` that is not the selected board, and
    // seeding the episode from the SELECTED board would put another board's
    // pre-existing values into `state.values`. They would then surface in the
    // handoff note as though this walk had recorded them — presenting
    // pre-existing certificate data as clearable, the worst failure class in
    // this wave. `undefined` keeps the current-board behaviour for every other
    // caller.
    bucket =
      getCircuitBucket(snapshot, circuit_ref, boardId === undefined ? snapshot.currentBoardId : boardId) ??
      null;
  }
  if (!bucket) return out;
  for (const f of fields) {
    const v = bucket[f];
    if (v !== undefined && v !== null && v !== '') out[f] = v;
  }
  return out;
}
