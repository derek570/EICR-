/**
 * Plan 00B §B2 — committed production-source mutation-parity manifest.
 *
 * Every direct certificate-state write in `src/extraction` (the covered
 * surface) must be classified here, following the field-replay
 * ACTIVE_ENTRY_CLASSIFICATION pattern (scripts/field-replay/lib/
 * session-builder.mjs): a committed manifest + a source-scan test that fails
 * on any unclassified or stale entry.
 *
 * Classes (§B2):
 *  - `semantic_mutation`   — active after evaluation-context creation and
 *                            REQUIRED to live in the declared commit atoms
 *                            (stage6-snapshot-mutators.js). Only that file
 *                            may carry this class.
 *  - `input_state_seed`    — constructor hydration and client
 *                            job_state_update ingest. Allowed ONLY as
 *                            scenario input; captured via canonical pre/post
 *                            state, never via commit receipts.
 *  - `forbidden_direct_mutation` — every other covered write. The committed
 *                            manifest must contain ZERO entries of this
 *                            class; the class exists so the scan test can
 *                            prove it fails closed on one (RED fixture).
 *
 * The scan test (src/__tests__/plan00-mutation-source-scan.test.js) greps
 * the covered files with MUTATION_WRITE_PATTERNS and requires every hit to
 * match exactly one manifest row, and every manifest row to still hit.
 */

/** Line-level regexes that identify a covered certificate-state write. */
export const MUTATION_WRITE_PATTERNS = [
  // assignment into the circuits map (flat or composite key)
  String.raw`(?:snapshot|stateSnapshot)\.circuits\[[^\]]*\]\s*=[^=]`,
  // board registry append
  String.raw`(?:snapshot|stateSnapshot)\.boards\.push`,
  // current-board flip
  String.raw`(?:snapshot|stateSnapshot)\.currentBoardId\s*=[^=]`,
  // observation store writes
  String.raw`extractedObservations\.push`,
  String.raw`extractedObservations\.splice`,
  // distribution-circuit semantic fields
  String.raw`\.is_distribution_circuit\s*=\s*'`,
  String.raw`\.feeds_board_id\s*=\s*[a-zA-Z]`,
];

/**
 * file → ordered list of {test, class, rationale}. The FIRST row whose
 * `test` regex matches the hit line claims it. A file with covered hits and
 * no entry here — or a hit no row claims — fails the scan.
 */
export const MUTATION_SITE_CLASSIFICATION = {
  'src/extraction/stage6-snapshot-mutators.js': [
    {
      test: String.raw`.`,
      class: 'semantic_mutation',
      rationale:
        'The declared commit-atom layer itself — every write here is inside an atom that emits its own commit receipt (Plan 00B §B2). This is the ONLY file allowed to carry semantic_mutation.',
    },
  ],
  'src/extraction/stage6-multi-board-shape.js': [
    {
      test: String.raw`boards\.push\(buildDefaultMainBoard|currentBoardId\s*=|circuits\[`,
      class: 'input_state_seed',
      rationale:
        'ensureMultiBoardShape default-main synthesis / shape normalisation — deterministic structural seeding, not a semantic operation; captured via canonical pre-state.',
    },
  ],
  'src/extraction/postcode-snapshot-applier.js': [
    {
      test: String.raw`snapshot\.circuits\[0\]\s*=\s*\{\}`,
      class: 'input_state_seed',
      rationale:
        'circuits[0] bucket materialisation only (no field value written). The locality VALUE writes route through applyBoardReadingToSnapshot with a silent_deterministic origin frame.',
    },
  ],
  'src/extraction/eicr-extraction-session.js': [
    {
      test: String.raw`.`,
      class: 'input_state_seed',
      rationale:
        'Constructor hydration (_seedStateFromJobState), client job_state_update supply/board/circuit ingest and canonical-main resolution. Scenario INPUT per §B2 — captured in canonical pre/post state, deliberately NOT refactored to satisfy grep. Semantic legacy-leg writes were extracted to atoms (appendLegacyObservationRecord, applyReadingFlagAware).',
    },
  ],
};
