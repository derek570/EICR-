# Field-replay correctness gate

A **merge-blocking regression corpus** that replays REAL captured field sessions through the REAL backend extraction pipeline (`runShadowHarness`) and asserts the audibility / write / clarification invariants. It closes the loop where a heavily-reviewed fix ships green-on-mocks and re-fails in the field the next morning: a fix for a field bug must now pass that bug's actual captured transcript before it can merge.

Origin: the 2026-07-15 F7/D2 waves shipped after 17-round `/rp` + multi-cycle `/ep` reviews + 5,200+ green tests, and field session `36731498` (the next morning, build 419) immediately re-failed bug classes those waves addressed. Every existing gate is static or mocked; this inserts the missing live-exercise step.

> **Scope: accident-class (2026-07-16).** This gate targets well-meaning-but-wrong code going green on mocks. The signed-commit governance, trusted-run evidence, HMAC source commitments, and the nightly live lane were built in the original foundation but are **deferred to `field-replay-hardening-followups`** — they are malice-hardening the threat model defers (see the bottom section). What ships and blocks today is the deterministic runner + hand-authored fixtures + a single expected_red/required_green CI assertion. The gate is grown one proven vertical slice at a time; slice 1 is keystone ① below.

## The lanes

| Lane | Trigger | Blocks? | Catches |
|------|---------|---------|---------|
| **Recorded (deterministic)** | per-PR, inside `Test Backend (Node.js)` | **MERGE-blocking** | backend drop/swallow + deterministic-backend-generated behaviours (a garbled transcript that beeps then goes silent; a swallowed clarification) |
| **Live (real model)** | manual, local | not wired to CI (deferred) | model-behaviour / routing a recorded replay is structurally blind to |

The recorded lane replays the fixture's captured `model_rounds` through a mock Anthropic client — no network, no vendor cost, deterministic. The live lane (`--model-lane=live`) exists in the CLI for local use but its scheduled/advisory CI wiring + budget envelope + protected-environment provisioning are part of the deferred follow-up.

## Corpus layout

```
tests/fixtures/field-replay-corpus/<corpus-id>/
  fixture.yaml            the executable fixture (ONLY basename discovered)
```

`<corpus-id>` is **opaque and random** — `frc_<32 lowercase hex>`, generated from `crypto.randomBytes(16)`. NEVER a UUID (rejected), never date/marker-encoded (a `field-2026-07-16-f1` id trivially links to the incident). The raw session id ↔ opaque corpus id mapping and the raw bytes live ONLY in the non-committed private archive. `fix_` references share the convention (`fix_<32 hex>`).

## Authoring a fixture

Fixtures are hand-authored today (the ① keystone was written directly from the reconstruction). The `convert-session` / `accept-fixture` / `validate-fixture` scripts remain as helpers:

- `validate-fixture.mjs <fixture>` (or `--corpus-root`) runs **structural (schema + cross-field) + privacy** validation. Under accident-class scope a signed review attestation is **optional** — when absent the fixture is validated structurally and for PII only. This is the check that caught a raw session UUID + private-archive path leaking into ①'s comments during authoring.
- `convert-session.mjs` / `accept-fixture.mjs` convert raw captures and produce a private manifest; the attestation/commitment path is dormant until governance is re-enabled.

### Source formats (for the converter)

- **Backend CloudWatch JSONL export** — mixed backend rows + nested `Client log batch entry` → `client_log.{category,event,data}` envelopes. Chime evidence is a top-level `message:"Client diagnostic"` row with `category:"chime_invoke"`. Timestamps are **timezone-free second-resolution strings, parsed as UTC**.
- **iOS flat-JSONL debug log** — flat `{event, category, data}` records.
- **`dr_*.json` debug reports** — no session-id field; linked by the **100-character issue-prefix algorithm** against the `debug_report_uploaded` event, bounded by session + timestamp, exactly-one-match binds.

### Chime→turn correlation

Identifier join first (session + utterance/generation id). Otherwise pair a chime with the NEXT final transcript in the same session ONLY when it precedes another chime AND falls within `CHIME_CORRELATION_MAX_MS = 15000` (**exclusive** bound). Ambiguity is a CONVERSION FAILURE requiring a human-selected mapping, never a guess. (Forensic guidance for real captures: correlate by `(branch, same/next-second backend row)` — a bare 15s window is ambiguous; see the Phase-3 reconstruction.)

### The `clear_then_write` state-transition assertion (P5, marker T10)

An `expected_operations[]` entry may set `state_transition: clear_then_write` (its only allowed value) to lock the same-turn clear→write collapse. The op is a **joint** assertion — one `reading.<operation_id>` failure covers BOTH conditions:

1. the **replacement reading** is present in `extracted_readings` (exact `field`, `circuit`, `value`, and outward `board_id`), AND
2. there are **zero** same-slot `clear_reading` entries in `result.field_corrections` (the stale clear the collapse must drop).

This exact shape exists because a naïve reading oracle GREENs on broken code: the wiped write IS still present in `extracted_readings` (the wipe is the post-envelope `field_corrected` frame), so only the joint assertion RED-proves the wipe. The op MUST be a singular circuit `reading` carrying own `value`, non-empty `field`, non-null `circuit`, no `circuits[]`, and BOTH `board_id` (the replacement's outward board) AND `clear_board_id` (the stale correction's outward board, each `string|null` — they may legitimately differ in spelling for the same effective board); any other shape is rejected fail-closed (`clear_then_write_bad_shape`), and `empty_fallback` still prohibits it as state-dependent. The correction lookup maps the raw expected `field` through the REAL A2 `CLEAR_WIRE_EXEMPT`/`FIELD_CORRECTIONS` dialect (`r2_ohm` stays raw), which is **dynamically injected** into the runner AFTER the recorded lane installs its fake clock — never a static import from the extraction graph (an import-graph regression test enforces this); when the mapping is unavailable the oracle latches INFRASTRUCTURE. Regression fixture (`is_keystone: false`): `frc_4687948e…` (marker T10) RED-proves `reading.op_ir_ctw` on pre-fix code.

### The `field_null_fallback` audible-output oracle (P4, answered-ask decline ack)

When the target output is a **field-null apology/ack** (a marker-①/②/F7 apology or the P4 answered-ask decline ack), declare it in `expected_audible_outputs[]` as `kind: field_null_fallback` with `match.text_exact: <the exact spoken text>`. `matchAudibleOutputs` accepts a confirmation as a match only when it is `field==null && circuit==null` (the implication these acks always satisfy) AND the trimmed `text` equals `text_exact`. This is the ONLY way to RED-prove an "answered-then-silent" turn: the generic `audibility.turn` oracle CANNOT — `turnIsAudible` treats the original `ask_user_started` question as audible, so an answered-then-silent continuation passes it. Declaring BOTH the original `ask_user` frame AND the ack as expected outputs suppresses that false-pass, and the RED id becomes `audibility.output.<ack_output_id>` (the missing ack).

The §A4-drained ack is **tokenless** (`field:null` is outside `DEDUPE_TOKEN_FIELDS`, so the emitted confirmation carries no `dedupe_token`), and runtime `confirmationMatches` keys on `text_exact` with no token — so the fixture-schema validator admits a `field_null_fallback` matcher with a **non-empty trimmed `text_exact` alone** (the historical mandatory `dedupe_token`/`expected_key` was dropped; an empty/whitespace `text_exact` stays rejected — it is no meaningful oracle). Do NOT add a fabricated token: a token-bearing matcher then FAILS `confirmationMatches` against the tokenless wire ack even on FIXED code, so it could never flip to `required_green`. The ack text must be deterministic in the frozen lane — the P4 ack rotates `turnNum % ASK_DECLINE_ACK_PROMPTS.length` (turn 1 → "No problem, moving on."). Regression fixture (`is_keystone: false`): `frc_85ace7677…` (feedback id 85) RED-proves `audibility.output.out_decline_ack` on the net-reverted tree.

## Fidelity & scope (v1)

Fixtures enter AND exit at the `runShadowHarness` boundary. Out of scope in v1 (each a fixture-validation-rejected `capability_exclusion` + a named follow-up):

- **ingress** — pre-LLM gate, queue/overtake, regex fallback (the recorded `inResponseTo` Boolean IS replayed);
- **post-harness egress** — `sonnet-stream.js`'s `validateAndCorrectFields`, extraction-envelope rewrites, `field_corrected` ordering;
- **Loaded Barrel** — OFF in both lanes (its mid-stream read-backs participate in suppression/dedup);
- **postcode lookup** — `lookupPostcode()` network path (a fetch-deny guard is defence-in-depth);
- **watchdog / cancellation** — fixture-controlled cancellation triggers don't exist in v1;
- **dialogue-answer ingress** — `srv-*` ask ANSWER processing lives in the excluded pre-harness ingress.

Environment parity: the recorded lane runs the task-def env loader (`scripts/field-replay/replay-environment.mjs`) so `SNAPSHOT_FORMAT=split_blocks` / `CIRCUIT_ORDER=recent_3` / the routing models match production (config divergence is prompt divergence). Loaded Barrel OFF is the SOLE deliberate override.

## Gate-state machine

Fixtures carry `gate_state`. The two executable states drive the blocking gate:

- **`expected_red`** — the fixture documents a bug present on `main`. Satisfied ONLY by its exact `expected_failure_id`; **XPASS fails the gate** (an expected_red whose assertion passes no longer proves the regression → flip it, don't leave it); an infrastructure failure (round-cursor violation, unmatched ask, swallowed `stage6_live_error`) is a DISTINCT outcome that can never satisfy a RED proof.
- **`required_green`** — the fixture must pass; any failure blocks.

`unsupported_pending | superseded | privacy_quarantined` are validated but non-executable. The full history-anchored immutability + legal-transition enforcement is part of the deferred governance layer.

Every `expected_red` carries `owner / introduced_at / fix_reference / expires_at`. Expiry is evaluated against the REAL CI wall clock (captured before the scenario fake clock installs), never replay time; after an unextended expiry the deliberate pipeline freeze applies.

### RED → GREEN (the fix flip)

An `expected_red` fixture is RED on `main` because the bug reproduces. Its fix (same or a later PR) makes the replayed turn pass the invariant → the fixture would XPASS → the fixing PR **flips `gate_state` to `required_green`** in the same change, converting the fixture into a permanent regression guard. In the recorded lane the model response is frozen, so the fixture locks the deterministic **backend** fix; a pure model/prompt fix is what the (deferred) live lane is for.

## PII policy

Commit only the minimal turns; strip user/job identifiers; pseudonymise via the **reserved synthetic grammar** — persons `fixture_person_<N>`, addresses `<N> Example Street, Testtown`, postcodes from the non-real `ZZ99` range (the ONLY content the scanner accepts in canonical PII fields). The raw backend JSONL export NEVER enters the repo. The scanner runs on RAW BYTES of every committed YAML file (comments, keys, anchors) plus every filename — it rejects raw UUIDs, private paths, and real postcodes wherever they appear.

## CI & delivery

- **Blocking:** `npm run replay:field-corpus` runs as a step inside `Test Backend (Node.js)` (so it rides the merge-blocking required check). This is the WHOLE blocking gate: each `expected_red` must fail with exactly its target id, each `required_green` must pass. `test-backend` checks out `fetch-depth: 0` on the pinned Node `20.20.2`.
- **Manual deploy:** production `workflow_dispatch` requires `refs/heads/main` AND runs the corpus in a `manual-deploy-gate` job before `build-images`.
- **Empty corpus = PASS** (exit 0 with `0 fixtures discovered`).
- **Local backstop:** `.husky/pre-push` runs `replay:field-corpus:prepush` — the XPASS-tolerant variant (a fix commit's fixed `expected_red` fixtures intentionally XPASS; `--no-verify` stays prohibited). Local diagnostics only; the Node-20 CI job is authoritative.
- **Delivery is PR-only** — the hub auto-push rule is auto-PR-then-`gh pr merge`.

## Deferred to `field-replay-hardening-followups`

Built in the original foundation, removed from the shipping gate, to be re-introduced when a second maintainer needs write access:

- **Signed-commit governance** — allowlisted-key byte-for-byte binding for exceptional transitions.
- **Trusted-run evidence** — `gh api` / `gh run download` retrieval + verification of a RED/GREEN run (repo, workflow-blob SHA, event, ref, head/base SHA, conclusion, artifact digest, fixture hash, assertion id, tested tree) so a hand-authored log can't self-assert; `field-replay-evidence.yml`; `ci-history-checks` history-anchored immutability + closure + ruleset guard.
- **Nightly live lane** — `field-replay-nightly.yml`, the £10/month budget envelope, the `field-replay-vendor-manual` protected environment, `ANTHROPIC_API_KEY` provisioning.
- **Attestation requirement** — a signed public `attestation.json` per fixture (the primitives — `attestationPayloadHash`, `immutableProjection`, opaque commitments — remain in `canonical-crypto`/`accept-core`).

## Standing rule

A BACKEND/MODEL field-feedback bug **within the corpus's v1 coverage** is not "done" until its captured transcript is a fixture in `field-replay-corpus/` that went RED-before / GREEN-after and stays as a permanent regression guard. A CLIENT-ONLY bug (e.g. an iOS `observation_deduped`) is "done" only with a client apply/dedupe replay in the owning iOS/PWA corpus.

## Threat model (accident, not malice)

One-maintainer repo: every PR author is Derek or a Claude session on his behalf. The failure class this stops is well-meaning-but-wrong code going green on mocks, including a confused session fabricating plausible-but-never-executed artifacts. Malicious-insider hardening (signed governance, trusted evidence, base-branch-controlled checks, OS-level `--network=none`, trusted-harness manifest) is DEFERRED to `field-replay-hardening-followups`, MANDATORY before any second maintainer gets write access. Accepted residual risk (dated): a PR editing `deploy.yml` itself to remove the corpus step would merge green — mitigated by PR review, the pre-push backstop, and the deploy-blocking lane.

## Plan 00B — trusted semantic oracle (2026-08-04)

The corpus now feeds a REAL-SERVER semantic oracle beside the recorded gate
(which is unchanged and stays the deterministic backend/wire protection):

- **Real-server lane** — `initSonnetStream` boots the actual WebSocket
  handler with a test-only `evaluationContextFactory`; a per-entry teardown
  ARBITER (explicit stop / disconnect expiry / both reconnect frames observe
  ONE teardown) freezes evidence exactly once, quiescence-gated
  (`non_quiescent_at_stop` fails closed). `src/extraction/plan00-lifecycle-hooks.js`.
- **Semantic capture** — certificate mutations are captured SOLELY at the
  canonical atoms in `stage6-snapshot-mutators.js` (commit receipt per REAL
  state change, producer-declared origin frames, derived-parent provenance,
  journal WRITE_SEQUENCE as an overlay only). The committed classification
  manifest + source scan (`scripts/model-ab/lib/mutation-classification.mjs`,
  `plan00-mutation-source-scan.test.js`) fails on any unclassified direct
  write. `add_board`/`select_board`/distribution-mark/postcode-locality were
  extracted into atoms as a behaviour-preserving production refactor.
- **Ask/audibility/playback ledgers** — `plan00-audibility-ledgers.js`:
  produced→emitted→answered ask lifecycle on the normalized `liveAskKey`;
  operation-bound `delivery_attempt` rows (identity = extractionTurnId +
  effective slot + ordinal — transport aliases never); `playback_start` only
  from an authenticated ACK resolving uniquely to one delivered operation;
  fast-TTS provisional binding behind the route's new session-owner check;
  cross-process outbox recovery flags `delivery_history_ambiguous`.
- **Expectations** — every fixture has a frozen `UNREVIEWED-DRAFT`
  projection (operations/asks/audible only; no model rounds, no tool ids) in
  exactly ONE executable lane (`vendor_live_expectations` — all nine — or
  the `deterministic_egress_expectations` named-case inventory). Combined
  manifest: `scripts/model-ab/plan00-expectation-manifest.json` with both
  lane hashes, the combined anchor and the enumerated
  `semantic_oracle_digest`; the manifest test suite is the merge-blocking
  drift check. Attestation (`expectations_attested`) is owned SOLELY by
  Plan 00C — `run-semantic-lane.mjs` refuses live vendor sampling without
  that record (`--mode=mock` proves plumbing only). Named non-safety strata
  gaps (multi-board routing, direct observation create/delete) are recorded
  in the manifest for Derek's 00C decision.

### Plan 00B-2 — executable composition (2026-08-04)

The 00B modules became a production-composed, EXECUTABLE whole (the five
CODEX-HELD structural findings 1/2/3/6/10 of the parent run):

- **Composition seam** — `evaluationContextFactory({sessionId, userId})`
  runs ONCE per fresh entry at session CREATION (before `session.start`);
  the result is normalised into one server-owned evaluation context
  ({observer, mutationObserver, askLedger, deliveryLedger} all optional; a
  bare observer stays valid), the mutation observer attaches to session AND
  snapshot, and ONLY the normalised context is stashed non-enumerably on
  the ENTRY via the `EVALUATION_CONTEXT` Symbol. Reconnect/resume preserve
  the same instance; every production seam resolves it from the active
  entry.
- **Seam wiring (two-tier evidence)** — Tier 1 (dispatcher asks, result-
  frame delivery, playback ACKs, fast-TTS) carries the full semantic
  contract and is proven by the mock-lane gate; Tier 2 (dialogue-script +
  address-mirror) is wired to the SAME ledgers but proven by focused
  real-ingress integration tests (`plan00-tier2-seams.test.js`) — the
  corpus records a `dialogue_answer_ingress` exclusion by design, and the
  family evidence obligation is recorded INTO Plan 00C's canonical plan
  (completion-manifest family fields + the `dialogue_hearing_attestation`
  post-completion event).
- **Producer-aware quiescence** — `beginProducer(entry, kind)` single-use
  handles over the eight canonical async producer kinds fold into
  `readInFlightCounts`; boundary-keyed `start`/`completion` latches
  (single-flight per key) replace the single freeze latch; an INELIGIBLE
  completion still builds/publishes 00C's durable audit candidate, with the
  quiescence outcome inside `counts`; the judged evidence is the
  deep-frozen `frozen.evidence` sibling latched at the chokepoint (live
  ledgers stay diagnostics-only). `round_usage` lifecycle sub-records (one
  per accepted `ingestBillableUsage` round row, hand-built allowlist) plus
  the transport×turn reasoning-effort resolver give 00C its executed
  cost/effort evidence.
- **Real-server mock lane** — `scripts/model-ab/lib/lane-driver.mjs` boots
  the REAL `initSonnetStream`, drives each fixture through the captured WS
  listener (exact ingress mapping, non-awaited transcript promise, bounded
  deterministic answer pump under the field-replay replay clock, strict
  per-turn scripted client via the exported `makeTurnClient`), POSTs
  production playback-ACK bodies through the REAL exported route factory
  offline, and judges ONLY the retained entry's completion-latch
  `frozen.evidence` (`judgeFrozenEvidence`). Acceptance: **9/9 fixtures
  PASS end-to-end**, committed as `plan00-lane-driver.test.js`.
- **Byte parity + leak sweep** — `plan00-frame-parity-matrix.test.js` pins
  EXACT `ws.send` sequences across production/evaluation/both single-factory
  legs over the deterministic scenario matrix, and sweeps every frame,
  logger payload and storage body against the canonical frozen
  `EVALUATION_ONLY_SYMBOLS` list.

### Plan 00B-3 — the oracle-evidence CONTRACT (2026-08-04)

Two consecutive CODEX-HELD runs churned in one surface because the evidence
contract was implicit — reviewers kept discovering it one leak at a time.
00B-3 inverts the dynamic: the contract is an EXECUTABLE TEST authored
first, and the implementation converges against it.

- **Pre-authored schema** —
  `tests/fixtures/test-contracts/plan00-evidence-contract/schema-v1.json`,
  committed BEFORE any implementation (the anti-shaping rule): the five-key
  snapshot boundary, the closed ask-quiescence families
  (dispatcher/dialogue_script/address_mirror) with the stop-boundary
  ordering rule, the closed semantic-family + transport enums, ONE closed
  producer registry backing both, the complete row-kind vocabulary
  (accepted/rejected/idempotent/freeze/unknown classes), the closed
  rejection-reason vocabulary with PER-REASON regime composition, and the
  ternary-plus-pre-admission verdict taxonomy.
- **Two-sided fixture + projector** — hand-authored snapshot/projection
  pairs (eligible + ineligible) deep-equal `buildEvidenceProjectionV1`
  (`src/extraction/plan00-evidence-projection.js`, five-key-snapshot-only);
  the three-way agreement invariant (latched-snapshot reconstruction ↔
  frozen-ledger projection ↔ fixture) is created and pinned in
  `plan00-evidence-contract.test.js` (53 cases, RED-proven 32-failing
  against the held tip before the fixes landed). 00C's Stage A reuses the
  same artifact as its session-manifest builder acceptance.
- **Acceptance-gated sub-records (C1)** — every ask-ledger transition
  returns an explicit verdict and the row derives FROM it: accepted
  `ask_lifecycle` OR rejected `ask_transition_rejected` (visible, zero
  credit), exactly one per attempt. SANCTIONED ledger change:
  `answered_without_full_proof` is a transition rejection (no invalid
  latch; the ask stays open and counts non-quiescent). Byte-identical ACK
  retransmissions append `playback_idempotent`; ledger-layer integrity
  rejections append `playback_rejected`/`delivery_rejected` beside their
  latch; pre-admission misses stay telemetry.
- **Tier-2 quiescence (C2)** — per-family `open_asks_*` counts fold into
  `readInFlightCounts`; an eligible freeze requires them all zero, and a
  stop-boundary-terminal-resolved ask still counts open. The recorded
  corpus keeps judging its declared turn WINDOW: `composeCaptureInvalid`
  proceeds past quiescence ONLY when the sole non-quiescence is
  `open_asks_*` (dialogue asks are outside the corpus observation
  boundary; a stable open ask cannot mutate judged evidence) — 00C's
  completion fold reads the counts directly and stays strict.
- **Producer registry (C3)** — record* APIs take registry IDs only;
  unknown ids append uncreditable `producer_unknown` rows and latch the
  owning ledger; `semantic_family` + `transport` are separate fields on
  delivery AND playback rows; `plan00-evidence-source-scan.test.js`
  forbids raw family/transport-bearing appends outside the typed adapters.
- **Projection completeness (C5)** — delivery rows carry
  `delivery_ref`/`at_seq`/aliases, playback rows carry `ack_body_hash` +
  `source`, `round_usage` rows carry the adapter-stamped `api_transport`
  (anthropic_messages | chat_completions | responses), and condition-gated
  `freeze_invalid` rows (invalid latches, `mutation_invalid`, nonzero
  `delivery_prepared_outstanding`, the unconsumed fast-TTS provisional
  folded via the existing `assertNoUnconsumedProvisionals`) land inside
  the latched snapshot with stable revisions.
- **Parity matrix (C4)** — standalone observation UPDATE + RECODE
  scenario legs (rule_6_edit code_change + correction_lead_in frames)
  join the four-quadrant byte-parity matrix.
- **Diff-review hardening (cycles 1–7)** — the contract gained: the
  executable REJECTION_REASONS regime table (per-reason latch/row/stage
  composition folded into eligibility as
  `rejection_regime_contradictions`), the closed
  `lifecycle_transition_grammar` (ONE exported table the projector
  consumes; terminals never reopen; violations are
  `invalid_lifecycle_transition` entries in
  `lifecycle_state_contradictions`, full prior-state × stage matrix
  pinned), fail-closed count reconciliation (`count_contradictions`
  incl. missing-key and aggregate checks), sequence-positional
  transition-rejection binding, machine-readable per-kind `field_spec`
  validation over fixtures AND real hook output, the stop-boundary
  open-ask latch, the per-send-loop mirror replay identity, and a THIRD
  shared fixture pair
  (`snapshot/projection-lifecycle-contradiction-v1.json`) plus the
  `ack-sequences-v1.json` action fixture — all reused by 00C Stage A,
  whose fold must HOLD on any contradiction class.

## Plan 00C — Stage A shipped (2026-08-05)

The consumer 00B pointed at now exists. `src/extraction/plan00-session-manifest.js`
registers the pure manifest builder/publisher through the frozen 00B hook at
server boot; its acceptance suite (`src/__tests__/plan00-session-manifest.test.js`)
reuses ALL FIVE committed contract artifacts — the eligible, ineligible and
lifecycle-contradiction snapshot/projection pairs are deep-equal targets for the
builder's embedded `evidence_projection_v1`, and the `ack-sequences-v1.json`
action fixture is driven through the REAL evaluation context and read back from
the frozen candidate manifest. The operator-side fold (`scripts/plan00-evidence/`)
consumes the projection under the recorded rules: any `freeze_invalid` /
`producer_unknown` row, any `count_contradictions` /
`rejection_regime_contradictions` / `lifecycle_state_contradictions` entry, any
non-quiescent stop or open Tier-2 ask renders that session's evidence INELIGIBLE
(fold HOLD/INVALID, zero family credit) — pinned by
`src/__tests__/plan00-evidence.test.js`. Recorded-corpus fixtures and the gate
lanes are untouched; the evidence layer observes sessions, never replays them.
