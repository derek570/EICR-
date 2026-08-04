/**
 * Plan 00B §B4/§B6 — immutable expectation projections + lane partition.
 *
 * Each frozen field-corpus fixture gets a SEPARATE expectation projection:
 * canonical operations/order, ask answers and audible outputs ONLY — no
 * recorded model rounds, no tool ids, no output from any model under test.
 * Projections are authored from existing human fixture data as
 * UNREVIEWED-DRAFT candidates; neither runner nor collector may derive,
 * accept, rewrite or "repair" expectations from live Haiku/Luna output.
 * Derek's attestation act belongs solely to Plan 00C.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

export const EXPECTATION_STATUS = 'UNREVIEWED-DRAFT';

/** Deterministic stable-key JSON. */
export function canonicalJson(value) {
  const sortValue = (v) => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Project ONE fixture into its semantic expectation. Deliberately excludes
 * `model_rounds` (frozen recorded rounds stay recorded-lane-only) and every
 * generated id. Live matching uses semantic operations/asks/audio and
 * runtime-id-independent keys.
 */
export function projectFixtureExpectation(fixture) {
  const turns = Array.isArray(fixture.turns) ? fixture.turns : [];
  return {
    schema_version: 1,
    status: EXPECTATION_STATUS,
    corpus_id: fixture.corpus_id,
    certificate_type: fixture.job_state?.certificateType ?? null,
    seeded_state: {
      boards: fixture.job_state?.boards ?? [],
      circuits: fixture.job_state?.circuits ?? [],
    },
    turns: turns.map((t) => ({
      turn_index: t.turn_index,
      transcript: t.transcript,
      confirmations_enabled: t.confirmations_enabled ?? true,
      ask_answers: (t.ask_answers ?? []).map((a) => ({
        // Answer content only — the runtime tool_call id is bound live
        // (the fixture's match.tool_call_id is a recorded-lane correlation
        // handle and never enters the semantic expectation).
        answer_text: a.answer?.user_text ?? a.user_text ?? null,
        answered: a.answer?.answered ?? null,
        channel: a.answer_channel ?? null,
      })),
      operations: (t.expected_operations ?? []).map((op, i) => ({
        ordinal: i + 1,
        kind: op.kind ?? null,
        field: op.field ?? null,
        circuit: op.circuit ?? null,
        board_id: op.board_id ?? null,
        value: op.value == null ? null : String(op.value),
        state_transition: op.state_transition ?? null,
        audibility: op.audibility ?? null,
      })),
      audible_outputs: (t.expected_audible_outputs ?? []).map((out) => {
        // Strip generated-id matchers (recorded-lane correlation only);
        // keep the semantic text/regex matchers verbatim.
        const { tool_call_id: _toolCallId, ...semanticMatch } = out.match ?? {};
        return {
          kind: out.kind ?? null,
          count: out.count ?? 1,
          match: Object.keys(semanticMatch).length > 0 ? semanticMatch : null,
        };
      }),
    })),
  };
}

/**
 * §B6 lane partition — every fixture belongs to EXACTLY one executable
 * lane. All nine current fixtures are executable through the
 * production-composed Haiku/Luna lanes (vendor_live). The deterministic
 * observation-update egress cases are post-harness behaviour tested
 * deterministically (never rerun as vendor A/B) and are inventoried by
 * NAMED CASE below, each bound to the committed test file that covers it.
 */
export const VENDOR_LIVE_FIXTURE_IDS = Object.freeze([
  'frc_342b5176bba77d4e9a031c6541d60e63',
  'frc_4687948efcd06a3cd9dce203a3aa4ffe',
  'frc_51be8bece8e63330a2f0daf78220af92',
  'frc_85ace7677d0e1c4a7b2f3609e5d1a8c4',
  'frc_9aa68a437135b079a615109b10fcc63a',
  'frc_a5f8cfebcb5cd7749412d09d984ebf09',
  'frc_b6ec5356f67d8655db214b4f16ae8d83',
  'frc_c55c996fa1014e088455af77216220d1',
  'frc_e94d9854ba728621ade73126161023da',
]);

export const DETERMINISTIC_EGRESS_CASES = Object.freeze([
  {
    case_id: 'egress_neutral_update_silent',
    description: 'async neutral update emits one silent observation_update (no recode line)',
    covered_by: 'src/__tests__/plan3-observation-recode-emitter.test.js',
  },
  {
    case_id: 'egress_code_change_recode_once',
    description: 'code change emits observation_update then exactly one recode confirmation',
    covered_by: 'src/__tests__/plan3-observation-recode-emitter.test.js',
  },
  {
    case_id: 'egress_disconnect_resume_no_duplicate',
    description:
      'failure/disconnect after update and before recode resumes with no duplicate update and one recode (suffix replay)',
    covered_by: 'src/__tests__/plan3-observation-recode-emitter.test.js',
  },
  {
    case_id: 'egress_rule6_frame_ledger_ordering',
    description:
      'Rule-6/frame-ledger ordering across extraction, update, recode, field corrections and VCR with stable dedupe',
    covered_by: 'src/__tests__/plan3-observation-recode-emitter.test.js',
  },
]);

/**
 * §B6 required strata → covering vendor-live fixtures (by inspection of the
 * frozen human fixture data). A named gap is a Derek decision for Plan 00C,
 * never a fabricated fixture. Safety-critical strata cannot be waived.
 */
export const STRATA_COVERAGE = Object.freeze({
  corrections: ['frc_85ace7677d0e1c4a7b2f3609e5d1a8c4'],
  clears_and_certificate_mutation: ['frc_4687948efcd06a3cd9dce203a3aa4ffe'],
  pinned_ir: ['frc_4687948efcd06a3cd9dce203a3aa4ffe'],
  mixed_ask_reading: ['frc_85ace7677d0e1c4a7b2f3609e5d1a8c4'],
  common_test_types: [
    'frc_51be8bece8e63330a2f0daf78220af92',
    'frc_9aa68a437135b079a615109b10fcc63a',
    'frc_a5f8cfebcb5cd7749412d09d984ebf09',
  ],
  deterministic_observation_update_egress: ['(deterministic_egress_expectations lane)'],
});

/** §B6 named gaps for Plan 00C's Derek decision (non-safety strata only). */
export const STRATA_NAMED_GAPS = Object.freeze([
  {
    stratum: 'multi_board_routing',
    reason:
      'No frozen field-corpus fixture carries a multi-board voice routing turn with real provenance (the A2-multiboard work is pinned by unit/integration suites, not a captured session). Recording one is a Plan 00C Derek decision; fabricating one is prohibited.',
    safety_critical: false,
    dated: '2026-08-04',
  },
  {
    stratum: 'direct_observation_create_delete',
    reason:
      'No frozen fixture captures a live observation create/delete turn with real provenance. Deterministic dispatcher coverage exists (stage6-dispatchers-observation.test.js) but §B6 vendor-lane provenance requires a captured session — named gap for Plan 00C.',
    safety_critical: false,
    dated: '2026-08-04',
  },
]);

export function loadFixture(repoRoot, corpusId) {
  const p = path.join(
    repoRoot,
    'tests',
    'fixtures',
    'field-replay-corpus',
    corpusId,
    'fixture.yaml'
  );
  return yaml.load(fs.readFileSync(p, 'utf8'));
}

export function listCorpusIds(repoRoot) {
  const dir = path.join(repoRoot, 'tests', 'fixtures', 'field-replay-corpus');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('frc_'))
    .map((e) => e.name)
    .sort();
}

/** Render both lane manifests + their hashes (pure; no writes). */
export function renderExpectationManifests(repoRoot) {
  const vendorProjections = VENDOR_LIVE_FIXTURE_IDS.map((id) =>
    projectFixtureExpectation(loadFixture(repoRoot, id))
  );
  const vendorLive = {
    schema_version: 1,
    status: EXPECTATION_STATUS,
    lane: 'vendor_live_expectations',
    fixtures: vendorProjections,
  };
  const egress = {
    schema_version: 1,
    status: EXPECTATION_STATUS,
    lane: 'deterministic_egress_expectations',
    gated_by: 'plan00c_stage_a_deployed_oracle_fingerprint',
    cases: DETERMINISTIC_EGRESS_CASES.map((c) => ({
      ...c,
      covered_by_sha256: sha256Hex(fs.readFileSync(path.join(repoRoot, c.covered_by), 'utf8')),
    })),
  };
  const vendorJson = canonicalJson(vendorLive);
  const egressJson = canonicalJson(egress);
  return {
    vendorLive,
    egress,
    vendor_live_sha256: sha256Hex(vendorJson),
    deterministic_egress_sha256: sha256Hex(egressJson),
    combined_sha256: sha256Hex(sha256Hex(vendorJson) + sha256Hex(egressJson)),
  };
}

/**
 * §B6 — the enumerated repository-relative semantic-oracle input manifest.
 * These are the sources whose behaviour the 00B expectations cover: the
 * canonical mutation atoms, capture/ask/audibility adapters, lifecycle
 * hooks + sonnet-stream chokepoint, dispatch origin seams, schemas and the
 * expectation runner — NOT the later 00C manifest consumer/publisher.
 * Plan 00C must recompute this exact digest before cohort initialisation;
 * any input change fails closed and requires a fresh 00B successor.
 */
export const SEMANTIC_ORACLE_INPUTS = Object.freeze([
  'src/extraction/stage6-snapshot-mutators.js',
  'src/extraction/plan00-semantic-capture.js',
  'src/extraction/plan00-audibility-ledgers.js',
  'src/extraction/plan00-lifecycle-hooks.js',
  'src/extraction/sonnet-stream.js',
  'src/extraction/stage6-dispatchers.js',
  // Every producer file carrying an origin frame or provenance seam —
  // a change to any of these is a semantic-oracle input change and must
  // fail 00C's digest recomputation closed (Codex r1 finding 9).
  'src/extraction/eicr-extraction-session.js',
  'src/extraction/stage6-shadow-harness.js',
  'src/extraction/postcode-snapshot-applier.js',
  'src/extraction/dialogue-engine/engine.js',
  'src/extraction/dialogue-engine/helpers/snapshot-write.js',
  'src/extraction/dialogue-engine/helpers/derivations.js',
  'src/routes/voice-latency-fast-tts.js',
  'src/routes/voice-latency-playback-ack.js',
  'scripts/model-ab/lib/mutation-classification.mjs',
  'scripts/model-ab/lib/expectation-projection.mjs',
  'scripts/model-ab/lib/semantic-judge.mjs',
  'scripts/field-replay/lib/fixture-schema.mjs',
  'scripts/model-ab/run-semantic-lane.mjs',
]);

export function computeSemanticOracleDigest(repoRoot) {
  const rows = SEMANTIC_ORACLE_INPUTS.map((rel) => ({
    path: rel,
    sha256: sha256Hex(fs.readFileSync(path.join(repoRoot, rel), 'utf8')),
  }));
  const digest = sha256Hex(rows.map((r) => `${r.path}\n${r.sha256}\n`).join(''));
  return { rows, digest };
}
