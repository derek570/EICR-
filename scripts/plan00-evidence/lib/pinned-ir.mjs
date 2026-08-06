/**
 * Plan 00B-4 §C1d — the ONE canonical pinned-IR identity.
 *
 * The pinned IR repetition is the daily "does the deployed stack still behave"
 * probe, and its whole value is that every repetition judges the SAME fixture
 * under the SAME wildcard against the SAME expectation row. Before this module
 * that identity lived nowhere: the fixture id, the single-board wildcard and
 * the expectation projection were each re-derived at the call site, so a test
 * could assert one triple while the coordinator dispatched another and nothing
 * would notice.
 *
 * So: the identity is a frozen constant exported here and imported by BOTH
 * `cmdRunIr` and its orchestration test — a single source of truth, not two
 * agreeing copies. `loadPinnedIrTarget` is the only sanctioned way to obtain
 * the fixture/expectation pair, and it RE-DERIVES the wildcard from the loaded
 * fixture and refuses if it disagrees with the constant: the constant records
 * what we believe, the loader proves the corpus still says it.
 *
 * `cmdRunIr` MUST NOT accept a caller-supplied fixture or expectation. A run-ir
 * that could be pointed at another fixture would publish evidence under the
 * pinned-IR requirement class describing something else entirely, which no
 * downstream fold could detect (the terminal carries the ordinal, not the
 * provenance of the thing judged). The override refusal therefore fires BEFORE
 * any allocation, so an attempted override costs no ordinal and no reservation.
 */

/** The pinned IR identity. Frozen; imported by the coordinator AND its test. */
export const PINNED_IR_IDENTITY = Object.freeze({
  requirement_class: 'pinned_ir',
  lane: 'ir-repetition',
  fixture_id: 'frc_4687948efcd06a3cd9dce203a3aa4ffe',
  /** Single-board fixture ⇒ the judge runs with the board wildcard. */
  board_wildcard: true,
  windowed_open_ask_families: Object.freeze(['dialogue_script']),
});

/**
 * Argument names that would REDIRECT what run-ir judges. Refused outright
 * rather than ignored: silently discarding an operator's `--fixture` would let
 * them believe they had re-pointed the probe.
 */
export const PINNED_IR_OVERRIDE_ARGS = Object.freeze([
  'fixture',
  'fixture-id',
  'fixtureId',
  'corpus',
  'corpus-id',
  'corpusId',
  'expectation',
  'expectation-id',
  'expectationId',
  'board-wildcard',
  'boardWildcard',
]);

/** Refuse a caller-supplied fixture/expectation override. Call BEFORE allocating. */
export function assertNoPinnedIrOverride(args) {
  if (!args || typeof args !== 'object') return;
  for (const name of PINNED_IR_OVERRIDE_ARGS) {
    if (args[name] !== undefined) {
      throw new Error(
        `REFUSED: run-ir judges exactly the pinned fixture ${PINNED_IR_IDENTITY.fixture_id} ` +
          `and does not accept --${name}; nothing was allocated or reserved`
      );
    }
  }
}

/** The canonical requirement key for one pinned-IR repetition ordinal. */
export function pinnedIrRequirementKey(repetitionOrdinal) {
  if (!Number.isInteger(repetitionOrdinal) || repetitionOrdinal < 1) {
    throw new Error(`pinnedIrRequirementKey: bad repetition ordinal ${repetitionOrdinal}`);
  }
  return `${PINNED_IR_IDENTITY.requirement_class}:${PINNED_IR_IDENTITY.fixture_id}:rep:${repetitionOrdinal}`;
}

/**
 * Load the pinned fixture + its projected expectation, proving the corpus still
 * matches the frozen identity.
 *
 * DELIBERATELY does NOT return a per-fixture expectation digest. The digest a
 * terminal binds is the ATTESTED LANE-WIDE manifest digest
 * (`vendor_live_expectations.sha256`) — `fold.mjs` rejects any non-INVALID
 * terminal whose `expectation_digest` is anything else
 * (`terminal_expectation_digest_unattached`), pinned_ir included. Returning a
 * sha256 of this one projected expectation would be exactly the wrong value in
 * exactly the right shape: it would bind cleanly, dispatch a real vendor call,
 * and only then be rejected by the fold. The coordinator reads the digest from
 * the manifest it has already verified, and there is no second candidate here
 * for it to reach for by mistake.
 */
export async function loadPinnedIrTarget(repoRoot) {
  const mod = await import('../../model-ab/lib/expectation-projection.mjs');
  const fixture = mod.loadFixture(repoRoot, PINNED_IR_IDENTITY.fixture_id);
  if (fixture?.corpus_id !== PINNED_IR_IDENTITY.fixture_id) {
    throw new Error(
      `pinned IR fixture identity drift: loaded corpus_id ${fixture?.corpus_id ?? 'null'} ` +
        `!= ${PINNED_IR_IDENTITY.fixture_id}`
    );
  }
  const boardCount = Array.isArray(fixture.job_state?.boards) ? fixture.job_state.boards.length : 0;
  const boardWildcard = boardCount <= 1;
  if (boardWildcard !== PINNED_IR_IDENTITY.board_wildcard) {
    throw new Error(
      `pinned IR board wildcard drift: fixture now has ${boardCount} boards ` +
        `(wildcard ${boardWildcard}) but the pinned identity says ${PINNED_IR_IDENTITY.board_wildcard}`
    );
  }
  const expectation = mod.projectFixtureExpectation(fixture);
  return {
    fixtureId: PINNED_IR_IDENTITY.fixture_id,
    boardWildcard,
    fixture,
    expectation,
  };
}
