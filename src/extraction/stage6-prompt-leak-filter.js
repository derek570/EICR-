import crypto from 'node:crypto';

/**
 * Stage 6 Phase 4 Plan 04-26 — Layer 2 output-side prompt-leak filter.
 *
 * WHAT: pure function `checkForPromptLeak(text, opts)` returning
 *   { safe: true } on clean text, OR
 *   { safe: false,
 *     reason: string,
 *     sanitised: string | null,
 *     is_error_replacement?: true }
 *
 * WHY: defence-in-depth complement to Layer 1 (the
 * `## CONFIDENTIALITY` section in `config/prompts/sonnet_agentic_system.md`).
 * Layer 1 tells the model not to disclose the system prompt; this
 * filter catches any disclosure content that nonetheless shows up
 * in free-text tool-use arguments. Runs PRE-DISPATCH on:
 *   - `ask_user.question`         (question-class)
 *   - `record_observation.text`   (observation_text-class)
 *   - `create_circuit.designation` / `rename_circuit.designation`
 *                                 (designation-class)
 *
 * WHY pre-dispatch (not post-emission): on ask_user, the leaked
 * text would already have been spoken via TTS before any post-
 * emission check could fire. We MUST scan before the dispatcher
 * registers / forwards.
 *
 * Detection families:
 *   1. Marker strings (case-insensitive substring) — exact
 *      framing strings the prompt uses for its own delimiters.
 *   2. Requirement IDs (/ST[QBGARTSDOI]-0\d/i) — the planning
 *      vocabulary embedded in the prompt comments.
 *   3. Structural phrases — verbatim sentence fragments from the
 *      prompt's own voice.
 *   4. Worked-example markers — "Example N:" where N in 1-9
 *      AND there's a tool-call keyword within ~80 chars.
 *      Context-gated to avoid "for example 1 hour" FPs.
 *   5. Length-based suspicion — question > 500 chars or
 *      observation_text > 1000 chars (real inspection utterances
 *      are short; long free-text on these fields is anomalous).
 *
 * Sanitised replacements (per field class):
 *   - question         → "I can't share that — please proceed with the inspection."
 *   - observation_text → "Attempted prompt extraction — refused."
 *   - designation      → null + is_error_replacement:true; dispatcher
 *                        rejects the tool call rather than corrupt the
 *                        certificate with a refusal-string circuit
 *                        name.
 *
 * WHY the filter is not a throw-site: the filter is defence-in-
 * depth. A malformed call (non-string text, etc.) should NOT break
 * the tool loop — return safe:true and let the dispatcher's own
 * validator handle type errors.
 *
 * WHY marker/phrase lists are inline here (not in the prompt
 * config): the filter needs to know specific banned strings
 * regardless of future prompt rewording — the output channel
 * contract is: "these specific tokens never appear". The prompt
 * may evolve its own wording; the filter's marker set is the
 * stable contract.
 */

/**
 * Exact-match banned markers (case-insensitive substring).
 * Must mirror the banned-literals enumeration in the prompt's
 * CONFIDENTIALITY section.
 *
 * r20-#2: each entry carries a STABLE ID tag that goes into
 * `filter_reason` on the blocked log row. The raw marker string
 * is NEVER logged — only the tag is — so CloudWatch never sees
 * the actual banned content.
 */
const MARKER_STRINGS = [
  { id: 'trust-boundary', value: 'TRUST BOUNDARY' },
  { id: 'snapshot-trust-boundary', value: 'SNAPSHOT TRUST BOUNDARY' },
  // Composite wrapper literals — listed BEFORE the bare variants
  // below so first-match-wins surfaces the sharper
  // `user-text-open` / `user-text-close` reason when a full
  // wrapper is present. If iteration order were reversed, a
  // payload containing `<<<USER_TEXT>>>` would surface as the
  // weaker `left-angle-triple` marker.
  { id: 'user-text-open', value: '<<<USER_TEXT>>>' },
  { id: 'user-text-close', value: '<<<END_USER_TEXT>>>' },
  { id: 'system-channel', value: 'SYSTEM_CHANNEL' },
  { id: 'user-channel', value: 'USER_CHANNEL' },
  // Plan 04-30 r23-#2 — bare wrapper literals. The CONFIDENTIALITY
  // prompt names USER_TEXT, END_USER_TEXT, <<<, >>> as forbidden
  // literals (the wrapper syntax the harness uses to frame
  // dictation inside the system prompt). r22 caught only the
  // composite forms; an attacker steering the model into "The
  // marker identifier is USER_TEXT" (no wrapper neighbour) could
  // extract prompt scaffolding tokens and the filter returned
  // safe:true.
  //
  // Ordering REQUIRED — two-level priority:
  //   1. Composite wrappers (`<<<USER_TEXT>>>` +
  //      `<<<END_USER_TEXT>>>`) stay ABOVE the bare variants so a
  //      full wrapper surfaces as the sharper composite ID.
  //   2. Within the bare block, `END_USER_TEXT` MUST come BEFORE
  //      `USER_TEXT` (longest-match-wins), because `END_USER_TEXT`
  //      contains `USER_TEXT` as a substring. If `USER_TEXT` came
  //      first, a payload containing just "END_USER_TEXT" would
  //      surface as the weaker `user-text-bare` reason rather
  //      than `end-user-text-bare`.
  //
  // FP profile (validated on 60-sample composite normal corpus ×
  // 4 field classes — 0/240 FP):
  //   - USER_TEXT / END_USER_TEXT: never appear in spoken
  //     inspection content. Case-insensitive via the existing
  //     `lower.includes(marker.value.toLowerCase())` path —
  //     consistent with all other markers.
  //   - <<< / >>>: diff/code-style triple-angle sequences. Absent
  //     from voice-dictated inspection utterances; an attacker
  //     emitting them into any of the 4 filter-scanned fields
  //     (question, observation_text, observation_location,
  //     observation_regulation) is out-of-domain and is a strong
  //     leak signal.
  { id: 'end-user-text-bare', value: 'END_USER_TEXT' },
  { id: 'user-text-bare', value: 'USER_TEXT' },
  { id: 'left-angle-triple', value: '<<<' },
  { id: 'right-angle-triple', value: '>>>' },
];

/**
 * Requirement-ID regex set. Each must be a 3-letter prefix + dash
 * + 0 + exactly one digit. "STQ-0" alone (no digit) is allowed —
 * too short to be a meaningful disclosure signal and the banned-
 * literal marker list covers that string explicitly in the prompt
 * (iff a downstream reader needs to enforce it, add here).
 */
const REQUIREMENT_PATTERNS = [
  /STQ-0\d/i,
  /STB-0\d/i,
  /STG-0\d/i,
  /STA-0\d/i,
  /STR-0\d/i,
  /STT-0\d/i,
  /STS-0\d/i,
  /STD-0\d/i,
  /STO-0\d/i,
  /STI-0\d/i,
];

/**
 * Structural prompt phrases — exact or near-exact sentence
 * fragments from the prompt's own voice. Case-insensitive
 * substring match.
 *
 * r20-#2: stable IDs so the filter_reason log field never
 * carries the prompt's own wording. The phrase values stay
 * inline for matching; only the ID goes into telemetry.
 */
const STRUCTURAL_PHRASES = [
  { id: 'assistant-intro', value: 'You are an EICR inspection assistant' },
  { id: 'seven-tools', value: 'You have 7 tools' },
  { id: 'no-free-text-json', value: 'Do not emit free-text JSON' },
  { id: 'silent-writes', value: 'Prefer silent writes' },
  { id: 'corrections-are-writes', value: 'Corrections are writes' },
];

/**
 * Tool-call keyword regex — any of the 7 tool names. Used to
 * context-gate worked-example detection (see MARKER_EXAMPLE
 * handling in checkForPromptLeak).
 */
const TOOL_KEYWORD_RE =
  /\b(record_reading|clear_reading|create_circuit|rename_circuit|record_observation|delete_observation|ask_user)\b/;

/**
 * Worked-example header regex: "Example 1:", "Example 2:", ...,
 * "Example 9:" — allowing case-insensitive leading capital.
 */
const EXAMPLE_HEADER_RE = /\bExample\s+[1-9]:/i;

/**
 * Per-field length ceilings. Question > 500 chars, observation_text >
 * 1000 chars, designation > 120 chars are flagged as suspicious.
 * Real designations are short ("Upstairs sockets" — ~16 chars);
 * anything above 120 is either a dump-style attack or a user
 * dictating the WHOLE sentence as a circuit name — both warrant a
 * reject (and the model retries with a short, real name).
 *
 * Plan 04-28 r21-#1 — introduce per-field classes for the observation
 * sub-fields. The 04-27 r20-#1 fix correctly ADDED `location` and
 * `suggested_regulation` to the scan list but classified both as
 * `observation_text`, inheriting the 1000-char ceiling. Real-world
 * values for these sub-fields are much shorter:
 *
 *   - `observation_location` (120c): real locations are short
 *     position labels — "Kitchen sockets consumer unit" (~30 chars),
 *     "Bathroom shaver socket and lighting circuit junction box"
 *     (~58 chars). A 120c ceiling catches a 150-char benign
 *     paraphrase of the prompt with zero FPs on real location data.
 *
 *   - `observation_regulation` (60c): real regulation refs are
 *     VERY short — "Regulation 522.6.201" (20 chars), "BS 7671
 *     643.3.2" (15 chars), occasional rich forms up to ~55 chars
 *     ("BS 7671 regulation 522.6.201 shock-risk installation").
 *     60c ceiling catches anything longer as suspicious with
 *     zero FPs on real regulation data.
 */
const LENGTH_CEILING = {
  question: 500,
  observation_text: 1000,
  observation_location: 120,
  observation_regulation: 60,
  designation: 120,
};

/**
 * Plan 04-29 r22-#1 — positive regulation-shape allowlist.
 * Plan 04-30 r23-#1 — extended with 10th bare-modifier shape +
 * composite-splitter helper.
 * Plan 04-31 r24-#1 — split into FULLY_QUALIFIED_PATTERNS (9,
 * standalone-valid) + BARE_MODIFIER_PATTERNS (1, non-first-only
 * inside composites).
 *
 * WHY: the r21-#1 `observation_regulation` field class added a
 * 60-char length ceiling but NO positive shape validation. A
 * 50-char English paraphrase of the prompt like "The system says
 * sockets must be GFCI protected" passes every existing detector:
 *   - no markers / requirement-IDs / structural phrases
 *   - no example markers adjacent to tool keywords
 *   - no reversed markers
 *   - no base64/hex entropy chunks
 *   - low-alpha guard deliberately NOT applied to this field
 *     (real regulation refs are numeric-heavy — "411.3.3" is 0%
 *     alpha, applying a 0.4/0.6 bar would destroy real content)
 *   - 46 chars < 60-char ceiling
 *
 * The content is genuinely anomalous for a `suggested_regulation`
 * field — real regulation references have highly constrained
 * shapes. A positive allowlist of known shapes rejects narrative
 * English while accepting every legitimate reference an inspector
 * might dictate.
 *
 * Shape inventory (from grepping config/prompts/ + src/__tests__/):
 *   FULLY_QUALIFIED (each standalone-valid — establishes a standard):
 *     1. Bare numeric sections:
 *          "132.15", "411.3.3", "522.6.201", "411.3.1.1"
 *          "722.411.4.1" (4 components), "534.4.4.5" (4 components)
 *          "701.411.3.3" (4 components, still a real ref)
 *        (BS 7671 is the implicit standard for bare numeric refs
 *        in UK electrical inspection context.)
 *     2. "Regulation <num>":
 *          "Regulation 522.6.201", "Regulation 411.3.3"
 *     3. "Reg <num>" (common dictation shorthand):
 *          "Reg 411.3.3"
 *     4. Bare BS series:
 *          "BS 7671", "BS 3871", "BS 3036", "BS 1361"
 *     5. BS hyphen-section series:
 *          "BS 88-2", "BS 88-3"
 *     6. "BS <num> <modifier> <section>":
 *          modifier in {Table, Part, Section, Chapter, Annex,
 *          Appendix, Figure, Regulation}
 *          "BS 7671 Table 41.1", "BS 7671 Appendix 4",
 *          "BS 7671 Section 706", "BS 7671 Part 6"
 *     7. "BS <num> <numeric section>":
 *          "BS 7671 643.3.2", "BS 7671 411.3.3"
 *     8. BS EN series (with up to 3 hyphenated section numbers):
 *          "BS EN 61008-1", "BS EN 60898-1", "BS EN 60335-2-73",
 *          "BS EN 61558-2-5", "BS EN 61643-11"
 *     9. IET / HSE guidance:
 *          "IET Guidance", "IET Guidance Note 3",
 *          "IET Guidance Note 3.2", "HSE Guidance Note 5"
 *
 *   BARE_MODIFIER (Plan 04-31 r24-#1 — NOT standalone-valid;
 *   only valid as a NON-FIRST token inside a composite, scoped
 *   to the preceding fully-qualified token's standard):
 *    10. Bare "<Modifier> <section>": "Table 41.1", "Appendix 4",
 *          "Part 6", "Section 706", "Annex A".
 *          Standalone "Table 41.1" is ambiguous ("Table 41.1 of
 *          which standard?") and rejects. Only accepts when a
 *          preceding fully-qualified token has already named the
 *          standard in the same composite.
 *
 * Composite forms (r23-#1 + r24-#1): real electricians routinely
 * cite multiple regulations in a single `suggested_regulation`
 * value, joined by a separator:
 *   - slash:      "411.3.3 / 522.6.201"
 *   - comma:      "BS 7671 411.3.3, Table 41.1"
 *   - semicolon:  "BS 7671; 411.3.3"
 *   - " and ":    "Regulation 522.6.201 and 411.3.3"
 *
 * The composite-splitter (`looksLikeCompositeRegulationRef`) runs
 * AFTER the single-ref fast path, so a string that matches a
 * single fully-qualified pattern never triggers the splitter
 * (telemetry stays sharp — a single ref is not classified as
 * composite). r24-#1 contract: the FIRST non-empty token in a
 * composite MUST match FULLY_QUALIFIED_PATTERNS (establishes the
 * standard); SUBSEQUENT tokens may match FULLY_QUALIFIED or
 * BARE_MODIFIER (scoped to the preceding fully-qualified token).
 *
 * Empty tokens (from leading / trailing / doubled separators)
 * are handled by `looksLikeCompositeRegulationRef` — r24-#2
 * tightens this to REJECT malformed input (see Task 3 in the
 * r24 plan).
 *
 * WHY anchored patterns (`^...$`) on the per-token check: the
 * field holds a pure reference, not a sentence. A narrative like
 * "Regulation 411.3.3 is breached by..." belongs in
 * `observation_text`, not `suggested_regulation`. Anchoring
 * enforces the schema PER TOKEN — the composite splitter is what
 * handles the between-token grammar.
 *
 * WHY gate fires LAST in the detector chain: when content fails
 * BOTH the shape check AND an existing detector (marker, phrase,
 * entropy, length-ceiling), the earlier detector's telemetry is
 * sharper. An over-length alpha run should emit `length-
 * suspicious:…`, not the coarser `non-regulation-shape`. The gate
 * sits immediately before the final `safe:true` return so it only
 * fires when nothing else would have caught the content.
 *
 * FP guard (r22-#1 + r23-#1 + r24-#1): 26 single refs in r22-#1
 * RED + 10 Group 9 samples + 8 composite forms in r23-#1 RED +
 * 4 bare-modifier-non-first composites in r24-#1 RED = 48 unique
 * real refs. All accept under the 9-pattern FULLY_QUALIFIED set +
 * 1-pattern BARE_MODIFIER set + composite splitter below.
 */
const FULLY_QUALIFIED_PATTERNS = [
  // Bare numeric: 132.15, 411.3.3, 701.411.3.3, 522.6.201a.
  // Up to 5 dot-separated numeric components, optional single
  // trailing lowercase letter (legacy variant suffix).
  // Fully qualified by UK-electrical convention — BS 7671 is the
  // implicit standard for bare numeric refs.
  /^\d{1,4}(\.\d{1,3}){1,4}[a-z]?$/,

  // "Regulation <numeric>" or "Reg <numeric>". Fully qualified by
  // convention — "Regulation" without a standard name means BS 7671.
  /^Reg(ulation)?\s+\d{1,4}(\.\d{1,3}){0,4}[a-z]?$/i,

  // Bare BS series: "BS 7671", "BS 3871", "BS 3036". Names the
  // standard directly.
  /^BS\s+\d{1,5}$/i,

  // BS hyphen series: "BS 88-2", "BS 88-3".
  /^BS\s+\d{1,5}(-\d{1,3}){1,3}$/i,

  // "BS <num> <modifier> <section>". Modifier set covers every
  // BS 7671 subdivision keyword seen in prompts + tests; section
  // is numeric (with up to 3 dot components) or a single uppercase
  // letter (e.g. "Annex A").
  /^BS\s+\d{1,5}\s+(Table|Part|Section|Chapter|Annex|Appendix|Figure|Regulation)\s+(\d{1,4}(\.\d{1,3}){0,3}|[A-Z])$/i,

  // "BS <num> <numeric section>": "BS 7671 522.6.201".
  /^BS\s+\d{1,5}\s+\d{1,4}(\.\d{1,3}){0,4}[a-z]?$/i,

  // BS EN series: "BS EN 61008-1", "BS EN 60335-2-73".
  /^BS\s+EN\s+\d{1,5}(-\d{1,3}){0,3}$/i,

  // IET / HSE Guidance (+ optional "Note <num>").
  /^IET\s+Guidance(\s+Note(\s+\d{1,3}(\.\d{1,3}){0,2})?)?$/i,
  /^HSE\s+Guidance(\s+Note(\s+\d{1,3}(\.\d{1,3}){0,2})?)?$/i,
];

/**
 * Plan 04-31 r24-#1 — bare modifier-section patterns.
 *
 * These are NOT standalone-valid regulation references — a bare
 * "Table 41.1" or "Appendix 4" in isolation doesn't establish a
 * standard (Table 41.1 of WHICH document?). They are valid ONLY
 * as non-first tokens in a composite reference where the
 * preceding fully-qualified token has named the standard.
 *
 * Example accepts: "BS 7671 411.3.3, Table 41.1" (fully-qualified
 * first + bare modifier second). Example rejects: "Table 41.1"
 * alone (standalone), "Table 41.1, BS 7671 411.3.3" (bare first).
 *
 * WHY kept as a separate array: the pattern itself is identical
 * to the r23-#1 10th shape. Splitting it out from
 * FULLY_QUALIFIED_PATTERNS is the r24-#1 contract — the single-
 * ref fast path in `looksLikeRegulationRef` iterates only
 * FULLY_QUALIFIED. The composite splitter in
 * `looksLikeCompositeRegulationRef` iterates BOTH arrays for
 * non-first tokens. Keeping the sets as separate arrays is the
 * clearest way to encode the standalone-vs-composite-only
 * distinction.
 */
const BARE_MODIFIER_PATTERNS = [
  /^(Table|Part|Section|Chapter|Annex|Appendix|Figure|Regulation|Reg)\s+(\d{1,4}(\.\d{1,3}){0,3}|[A-Z])$/i,
];

/**
 * Plan 04-30 r23-#1 — composite-reference separator regex.
 *
 * Matches: slash (`/`), comma (`,`), semicolon (`;`), or word-
 * bounded " and " (case-insensitive). Surrounding whitespace is
 * folded into the separator so `split()` returns tokens with
 * predictable edges and the per-token `.trim()` in
 * `looksLikeCompositeRegulationRef` still handles any stray
 * whitespace tolerably.
 *
 * WHY whitespace-bounded " and ": substring "and" inside a word
 * ("understand", "brand") must NOT split. The leading+trailing
 * `\s+` ensures `and` only matches when it stands alone as a
 * conjunction. The leading `\s*` outer group is preserved so
 * `", and"` (comma + and — rare but dictation-shaped) folds into
 * a single separator.
 *
 * WHY global (implicit via split): `String.prototype.split` with a
 * regex splits at EVERY match, which is what we need for 3+ token
 * composites like "411.3.3, 522.6.201, 132.15".
 */
const COMPOSITE_SEPARATOR_RE = /\s*(?:\/|,|;|\s+and\s+)\s*/i;

/**
 * Plan 04-30 r23-#1 — split-and-validate for composite regulation
 * references.
 * Plan 04-31 r24-#1 — first-non-empty-token MUST be fully qualified;
 * subsequent tokens may be fully-qualified OR bare-modifier.
 *
 * Returns true iff:
 *   1. the input contains at least one separator (so a single-ref
 *      value never trips this path — the single-ref fast path
 *      above already returned for those), AND
 *   2. at least one non-empty token exists (so a pure-separator
 *      string doesn't accept), AND
 *   3. the FIRST non-empty trimmed token matches at least one
 *      FULLY_QUALIFIED_PATTERNS entry (establishes a standard),
 *      AND
 *   4. every SUBSEQUENT non-empty trimmed token matches either
 *      FULLY_QUALIFIED_PATTERNS or BARE_MODIFIER_PATTERNS.
 *
 * r24-#1 rationale: a bare modifier like "Table 41.1" is NOT a
 * regulation reference standalone — it doesn't name a standard.
 * It's only meaningful scoped to a preceding fully-qualified
 * token that did name the standard ("BS 7671 411.3.3, Table
 * 41.1"). Enforcing first-token-fully-qualified closes the
 * r23-#1 gap where standalone "Table 41.1" accepted as a
 * regulation reference.
 *
 * Empty tokens (from leading / trailing / doubled separators) are
 * currently skipped rather than failed — dictation artefacts.
 * r24-#2 (Task 3 in the r24 plan) tightens this to REJECT;
 * until that lands the current skip semantics are preserved.
 */
function looksLikeCompositeRegulationRef(text) {
  if (!COMPOSITE_SEPARATOR_RE.test(text)) return false;
  const tokens = text.split(COMPOSITE_SEPARATOR_RE);
  let firstNonEmptyIdx = -1;
  let nonEmpty = 0;
  for (let i = 0; i < tokens.length; i++) {
    const trimmed = tokens[i].trim();
    if (trimmed.length === 0) continue; // skip artefact (r24-#2 tightens this)
    nonEmpty++;
    if (firstNonEmptyIdx === -1) firstNonEmptyIdx = i;
    const isFirstNonEmpty = i === firstNonEmptyIdx;
    let matched = false;
    // First non-empty token: must be fully qualified.
    for (const re of FULLY_QUALIFIED_PATTERNS) {
      if (re.test(trimmed)) {
        matched = true;
        break;
      }
    }
    // Subsequent tokens: fully qualified OR bare modifier.
    if (!matched && !isFirstNonEmpty) {
      for (const re of BARE_MODIFIER_PATTERNS) {
        if (re.test(trimmed)) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) return false;
  }
  return nonEmpty > 0;
}

/**
 * Returns true if `text` matches at least one
 * FULLY_QUALIFIED_PATTERNS entry, OR if `text` is a valid
 * composite (first-token-fully-qualified + subsequent tokens
 * fully-qualified-or-bare-modifier), OR if `text` is
 * empty/whitespace-only (a null regulation reference is
 * legitimate — the tool schema explicitly allows
 * `suggested_regulation: null` when the model can't reliably
 * cite one).
 *
 * r24-#1 contract: bare modifier forms ("Table 41.1", "Part 6",
 * "Appendix 4") are NOT standalone-valid. The single-ref fast
 * path iterates FULLY_QUALIFIED_PATTERNS only.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeRegulationRef(text) {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Single-ref fast path: only FULLY_QUALIFIED patterns accepted
  // standalone (r24-#1). Keeps telemetry sharp — bare modifier
  // forms must be part of a composite to accept.
  for (const re of FULLY_QUALIFIED_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  // Plan 04-30 r23-#1 + r24-#1 — composite path. Activates only
  // when a separator is present AND first-token is fully qualified
  // AND every subsequent non-empty token is valid.
  if (looksLikeCompositeRegulationRef(trimmed)) return true;
  return false;
}

/**
 * Plan 04-27 r20-#3 — high-entropy substring detection.
 *
 * Regex captures contiguous base64 or hex blobs of at least 40
 * chars. 40 chars is the tightest threshold that stays above the
 * 36-char UUID boundary while covering useful-size prompt fragments
 * (a 30-byte prompt substring base64-encodes to 40 chars, the
 * minimum an attacker would find useful). Shorter-than-40 blobs
 * are too short to carry meaningful prompt content AND too close
 * to legitimate UUID/hash references to flag without false-
 * positives.
 *
 * WHY base64 charset includes =: base64 pads multiples of 4 with
 * 0–2 `=` chars. A 40-char chunk might end with `==`; stripping
 * padding from the regex would miss those real-world cases.
 *
 * Hex pattern is separate + stricter: legitimate hex in inspection
 * text is rare (observation text doesn't typically contain hash
 * refs) but a colour code `#a1b2c3` (6 chars) or reference
 * `a1b2c3d4` (8 chars) does exist. 40 char-bar excludes those.
 *
 * CHAR-DIVERSITY GUARD: a long run of a single repeated char
 * (`aaaa...aaaa`) technically matches the base64 charset but has
 * near-zero Shannon entropy. Real base64-encoded content uses the
 * full alphabet; repeated-char runs are test fixtures or padding
 * artefacts. We require at least 10 distinct chars inside the
 * matched chunk before flagging — excludes `a.repeat(N)` style
 * length-ceiling test fixtures AND legitimate monotonic content
 * like solid ASCII dashes in a separator.
 */
// Plan 04-28 r21-#2 — GLOBAL flag required for `matchAll()`. The r20-#3
// implementation used `text.match()` without `g`, which returns only
// the FIRST match. Attackers can prepend a benign 40+ char low-
// diversity chunk (e.g. 50 "a"s: 1 distinct char, fails the 10-distinct
// threshold) then, after a break char, append the real 40-char
// base64/hex leak. First match's distinct count fails → filter
// returns safe:true → real leak never checked. Iterating ALL matches
// closes the bypass: if ANY chunk clears the distinct threshold,
// flag.
const BASE64_RE = /[A-Za-z0-9+/=]{40,}/g;
const HEX_RE = /[0-9a-fA-F]{40,}/g;
const MIN_ENTROPY_DISTINCT_CHARS = 10;

function hasHighEntropyChunk(text, re) {
  // matchAll requires the `g` flag — guard in-file; constants above
  // carry it. This iteration is O(N) where N is the number of 40+
  // char matches in the input, typically 0 or 1 on real inspection
  // speech. Each match incurs a Set construction over the chunk +
  // size check — cheap.
  for (const match of text.matchAll(re)) {
    const chunk = match[0];
    const distinct = new Set(chunk).size;
    if (distinct >= MIN_ENTROPY_DISTINCT_CHARS) return true;
  }
  return false;
}

/**
 * Plan 04-27 r20-#3 — per-field conservative low-alpha-ratio guard.
 *
 * For short natural-language fields (question + designation) that
 * have low plausible-content length ceilings (500 / 120 chars),
 * a payload with an anomalously low alphabetic-char ratio is
 * suspicious — legitimate inspector questions + circuit names are
 * almost entirely alpha + whitespace.
 *
 * `observation_text` is DELIBERATELY excluded: real observations
 * carry lots of numeric content (Zs 0.35, regulation 411.3.3,
 * cable 2.5mm², test voltage 500V, Ir > 999MΩ). A 200-char
 * observation legitimately hits 30–40% alphabetic ratio — flagging
 * it would destroy voice extraction on real inspection speech.
 * The 1000-char length ceiling is the only backstop for this
 * field.
 *
 * Thresholds:
 *   question:    length ≥ 200 AND alpha ratio < 0.5
 *   designation: length ≥ 40  AND alpha ratio < 0.4
 */
const LOW_ALPHA_MIN_LENGTH = {
  question: 200,
  designation: 40,
  // Plan 04-28 r21-#1 — observation_location gets a conservative
  // low-alpha guard (real locations are almost all alpha + spaces:
  // "Kitchen sockets consumer unit" is 95% alpha). 40-char min
  // floor + 0.6 ratio bar catches punctuation-heavy bypass attempts
  // without false-positiving on real location labels.
  observation_location: 40,
  // DELIBERATELY NOT applied to observation_regulation: real regulation
  // refs are numeric-heavy. "Regulation 522.6.201" is 50% alpha;
  // "7671 522.6.201" is 22% alpha — a 0.4 or 0.6 bar would destroy
  // real content. The 60c length ceiling is the only backstop for
  // that field.
};
const LOW_ALPHA_THRESHOLD = {
  question: 0.5,
  designation: 0.4,
  observation_location: 0.6,
};

function alphaRatio(text) {
  if (typeof text !== 'string' || text.length === 0) return 1;
  const alphaCount = (text.match(/[a-zA-Z]/g) || []).length;
  return alphaCount / text.length;
}

/**
 * Sanitised-replacement strings per field class.
 */
const SANITISED_QUESTION = "I can't share that — please proceed with the inspection.";
const SANITISED_OBSERVATION_TEXT = 'Attempted prompt extraction — refused.';

/**
 * Scan a free-text tool-use field value for system-prompt
 * disclosure content.
 *
 * @param {any} text     Free-text content (string) emitted by the
 *                       model on a tool-use argument. Non-strings
 *                       are treated as safe (defensive — dispatcher
 *                       validator handles type errors).
 * @param {{field?: string}} [opts] Optional descriptor of the
 *                       target field class. Valid values:
 *                       'question' | 'observation_text' | 'designation'.
 *                       Missing field → no length check, sanitised
 *                       defaults to question phrasing.
 * @returns {{safe: boolean, reason?: string, sanitised?: string|null, is_error_replacement?: boolean}}
 */
export function checkForPromptLeak(text, opts = {}) {
  const field = opts.field || 'unknown';
  if (typeof text !== 'string') return { safe: true };

  const lower = text.toLowerCase();

  // Family 1 — marker strings (stable IDs in filter_reason, r20-#2).
  for (const marker of MARKER_STRINGS) {
    if (lower.includes(marker.value.toLowerCase())) {
      return makeUnsafe(field, `marker:${marker.id}`);
    }
  }

  // Family 2 — requirement IDs. The regex source (e.g. `STQ-0\d`) is
  // structural metadata identifying WHICH requirement namespace was
  // matched; it's not user-supplied content. Kept as-is for analyzer
  // routing.
  for (const re of REQUIREMENT_PATTERNS) {
    if (re.test(text)) {
      return makeUnsafe(field, `req-id:${re.source}`);
    }
  }

  // Family 3 — structural phrases (stable IDs in filter_reason, r20-#2).
  for (const phrase of STRUCTURAL_PHRASES) {
    if (lower.includes(phrase.value.toLowerCase())) {
      return makeUnsafe(field, `phrase:${phrase.id}`);
    }
  }

  // Family 4 — worked-example markers, context-gated to adjacent
  // tool-call keyword within ~80 chars.
  const examMatch = text.match(EXAMPLE_HEADER_RE);
  if (examMatch) {
    const idx = examMatch.index ?? 0;
    const window = text.slice(Math.max(0, idx - 80), idx + 160);
    if (TOOL_KEYWORD_RE.test(window)) {
      return makeUnsafe(field, 'example-marker-adjacent-to-tool');
    }
  }

  // Family 5 — r20-#3 reversed-content detection.
  //
  // Attackers can bypass substring matching by reversing the leaked
  // content. Cheap to check: reverse the whole text once, then test
  // whether it contains any known marker / structural phrase.
  //
  // We check MARKER_STRINGS + STRUCTURAL_PHRASES here (the closed
  // banned-literals lists). REQUIREMENT_PATTERNS are regex-based
  // and not cleanly reversible (STQ-01 reversed is 10-QTS — hyphen
  // position changes; skip). The 04-26 req-id coverage on forward
  // content is sufficient — an attacker reversing a req-id still
  // has a req-id in some orientation.
  const reversed = text.split('').reverse().join('').toLowerCase();
  for (const marker of MARKER_STRINGS) {
    if (reversed.includes(marker.value.toLowerCase())) {
      return makeUnsafe(field, `reversed:marker:${marker.id}`);
    }
  }
  for (const phrase of STRUCTURAL_PHRASES) {
    if (reversed.includes(phrase.value.toLowerCase())) {
      return makeUnsafe(field, `reversed:phrase:${phrase.id}`);
    }
  }

  // Family 6 — r20-#3 high-entropy substring detection.
  //
  // Base64 or hex blobs of ≥40 chars are anomalous in inspection
  // speech and a standard attacker channel for binary-encoding a
  // prompt leak under the length ceiling. 40-char threshold sits
  // above the 36-char UUID bound and below any useful prompt
  // fragment encoding.
  if (hasHighEntropyChunk(text, BASE64_RE)) {
    return makeUnsafe(field, 'entropy:base64');
  }
  if (hasHighEntropyChunk(text, HEX_RE)) {
    return makeUnsafe(field, 'entropy:hex');
  }

  // Family 7 — r20-#3 + r21-#1 per-field conservative low-alpha-ratio
  // guard for question + designation + observation_location. NOT
  // applied to observation_text (real observations carry numeric
  // content) or observation_regulation (real regulation refs are
  // numeric-heavy). See LOW_ALPHA_MIN_LENGTH docblock above.
  const minLen = LOW_ALPHA_MIN_LENGTH[field];
  const alphaBar = LOW_ALPHA_THRESHOLD[field];
  if (minLen && alphaBar && text.length >= minLen) {
    const ratio = alphaRatio(text);
    if (ratio < alphaBar) {
      return makeUnsafe(field, `low-alpha-ratio:${ratio.toFixed(2)}<${alphaBar}`);
    }
  }

  // Family 8 — per-field length ceilings (final backstop).
  const ceiling = LENGTH_CEILING[field];
  if (ceiling && text.length > ceiling) {
    return makeUnsafe(field, `length-suspicious:${text.length}>${ceiling}`);
  }

  // Family 9 — r22-#1 positive shape gate for observation_regulation.
  //
  // Placed LAST in the chain so sharper telemetry from earlier
  // families (marker / requirement-id / phrase / example / reversed
  // / entropy / low-alpha / length) takes precedence. When a
  // regulation-field value falls through every other check, the
  // shape gate rejects any non-regulation-shaped content —
  // narrative English paraphrases of the prompt that would
  // otherwise slip past the 60-char ceiling.
  //
  // Empty / whitespace-only text is explicitly safe (the tool
  // schema allows `suggested_regulation: null`; an empty string is
  // the JSON-serialised form of that null for some code paths).
  if (field === 'observation_regulation' && !looksLikeRegulationRef(text)) {
    return makeUnsafe(field, 'non-regulation-shape');
  }

  return { safe: true };
}

function makeUnsafe(field, reason) {
  if (field === 'designation') {
    // Certificate-correctness trade-off: don't substitute a
    // refusal-string as a circuit designation. Signal the
    // dispatcher to reject the tool call; the model retries.
    return {
      safe: false,
      reason,
      sanitised: null,
      is_error_replacement: true,
    };
  }
  const sanitised = field === 'observation_text' ? SANITISED_OBSERVATION_TEXT : SANITISED_QUESTION;
  return {
    safe: false,
    reason,
    sanitised,
  };
}

/**
 * Plan 04-27 r20-#2 — structured-telemetry hash helper.
 *
 * Returns the first 16 hex chars of SHA-256 over the input string.
 * Used by every prompt_leak_blocked emission to correlate repeated
 * leak attempts in logs WITHOUT ever exposing a substring of the
 * blocked content.
 *
 * WHY SHA-256:
 *   - Cryptographic stability: same payload → same hash, always. The
 *     analyzer can count repeated attack payloads across sessions
 *     without reading any content.
 *   - Collision resistance: different payloads → different hashes.
 *   - Non-reversible: an ops engineer reading the log cannot
 *     reconstruct the prompt disclosure that triggered the block.
 *
 * WHY 16 hex chars (64 bits):
 *   - Enough uniqueness for correlation (no practical collisions
 *     across a session log volume).
 *   - Short enough not to dominate the log row size.
 *
 * Defensive shape: returns `null` for non-strings / empty strings so
 * callers don't have to guard — the filter never throws on unexpected
 * input.
 *
 * @param {any} text
 * @returns {string|null} 16-char lowercase hex, or null if input is
 *                        not a non-empty string.
 */
export function hashPayload(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
