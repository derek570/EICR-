# Plan 00C Stage-A — /ep execution log

Session: `20260805T051955Z-ep`
Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260805T051955Z-ep`
Branch: `ep/plan00c-stage-a-20260805T051955Z-ep` (off `origin/main` @ `05add7e7`)
Plan: `/Users/derekbeckley/.claude/handoffs/EICR_Automation--00c-three-day-evidence-gate-2026-08-03/PLAN-final.md`

## Pre-claim policy verification — PASSED
- Policy sidecar: `explicit_only` + `require_no_chain` — invocation used exact `--plan=` + `--no-chain`. ✔
- 00B success record present, `terminal_class: shipped`, plan sha256 `57e5c9c2…` matches the file on disk. ✔
- Merge commit `05add7e7` IS an ancestor of `origin/main`. ✔
- Artifact `plan00_expectation_manifest` at `scripts/model-ab/plan00-expectation-manifest.json` on `origin/main` hashes `d58c1851…` — matches the recorded SHA-256. ✔
- Live deployment match: `eicr-backend` running task-definition revision **377**, rollout COMPLETED — matches the success record's runtime identity. ✔

## Step 0 — exploration + frozen design decisions

- Status: applied
- Decision: rule 1 (plan executed as written) with the following load-bearing findings recorded before any code was written.

### Seam map (verified from source, this worktree)
- **The 00B hook**: `src/extraction/plan00-lifecycle-hooks.js`. 00C's builder/publisher is the `observer` role of the evaluation context: `{ buildCandidate(snapshot), publish(candidate), onRegistered?, onLifecycleEvent?, onEvidenceFrozen? }`. `freezeEvidenceStart` (sonnet-stream.js:4499) and `freezeEvidenceCompletion` (:3666 terminate, :7454 stop) already run on the production path and invoke the builder synchronously with the frozen five-key snapshot `{sessionId, boundary, counts, revisions, sub_records}`, latch the candidate + single publish promise, and isolate every failure from the live turn. `attachEvaluationContext` + `normaliseEvaluationContext` compose the context from `initSonnetStream(..., { evaluationContextFactory })`.
- **Registration site**: production caller is `src/server.js:35` (currently 3 args). `src/server.js` is NOT in the 41-entry enumerated `semantic_oracle_inputs` list (verified against `scripts/model-ab/plan00-expectation-manifest.json`) — wiring there changes only the runtime digest, exactly as the plan requires. `sonnet-stream.js` and the hook seam are enumerated and MUST NOT be edited; the pre-merge check is `src/__tests__/plan00-expectation-manifest.test.js` ("the enumerated semantic_oracle_digest matches the checked-out sources").
- **Ledger factories for the production context**: `createAskLedger`/`createDeliveryLedger` (plan00-audibility-ledgers.js), `createMutationObserver` (plan00-semantic-capture.js) — same composition the eval lane-driver uses (`scripts/model-ab/lib/lane-driver.mjs:207-216`). All are enumerated inputs consumed by import only.
- **Family fields derivation**: `buildEvidenceProjectionV1(snapshot)` (plan00-evidence-projection.js, enumerated, import-only) — the completion manifest embeds its output verbatim as the per-family evidence, which is BY CONSTRUCTION "derived solely from the sub_records bridge" and makes the C0 contract-artifact acceptance test a direct deep-equal against the committed projection fixtures.
- **Primitives**: `canonicalBytes`/`evidenceEventHash` (scripts/field-replay/lib/canonical-crypto.mjs — RFC 8785 via pinned `canonicalize@2.1.0`, domain-separated SHA-256), `assertAppendOnly`/`verifyTrustedRun` (scripts/field-replay/lib/evidence-events.mjs). Operator commands reuse them by direct import.
- **Oracle digest recompute**: `computeSemanticOracleDigest(repoRoot)` (scripts/model-ab/lib/expectation-projection.mjs) — reused for the cohort fingerprint's `semantic_oracle_digest`, compared against the 00B success artifact.

### [ASSUMED] Deployment-image constraints found and resolved (rule 2 — single obviously-correct interpretation)
- `Dockerfile.backend` runs `npm ci --only=production` and copies ONLY `src/ config/ assets/ python/` — `scripts/` is NOT in the image. Therefore `src/extraction/plan00-session-manifest.js` cannot import from `scripts/field-replay/lib/`. Resolution: the src module imports the SAME pinned `canonicalize` package directly (moved from devDependencies to dependencies, exact 2.1.0 pin preserved), with a reciprocal Jest drift test asserting byte-identity with `canonicalBytes` over an edge-case corpus (the repo's established hand-mirror + drift-test precedent). Without this the module would crash at import time in production.
- Production bucket: `S3_BUCKET=eicr-files-production` already in the task-def env; the manifest publisher reads the same env var (no new infra).
- No existing `ECS_CONTAINER_METADATA_URI_V4` consumer in src/ — 00C introduces the metadata fetch (cached once at factory creation; the pure builder reads the cached frozen identity synchronously).

## Step C3 — src/extraction/plan00-session-manifest.js + server.js registration
- Status: applied
- Decision: rule 1. Builder consumes ONLY the five-key snapshot; completion embeds `buildEvidenceProjectionV1(snapshot)` verbatim (makes the C0 acceptance a direct deep-equal and satisfies "derived solely from the sub_records bridge" by construction). Publisher is task-role-bounded (conditional PutObject + current-version GetObject only), 412-idempotent, bounded-409, never throws. `src/server.js` passes the factory (full four-role context — the ledgers are required for family evidence in production; the observer-less alternative would latch `..._no_mutation_observer` rejections on every dialogue delivery).
- Files: src/extraction/plan00-session-manifest.js (new), src/server.js, package.json/package-lock.json (canonicalize → dependencies)
- Commit: db15e15d
- Notes: the `sonnet-stream.js` comment "the sole production caller … never passes initOptions, so this branch never runs live" is now STALE, but that file is an enumerated semantic-oracle input and MUST NOT be edited this wave — recorded as a follow-up for the next sanctioned 00B successor.

## Step C1/C2/C4/C5 — scripts/plan00-evidence/ (store, events, reservations, fold, collector, deployment, projections, CLI)
- Status: applied
- Decision: rule 1, with these [ASSUMED] under rule 2 (single obviously-correct interpretation, all logged):
  - Requirement-key formats `ir:<cohort>:rep-<ordinal>` / `corpus:<cohort>:<lane>:run-<ordinal>:<fixture>`; terminals also carry the structured fields (`repetition_ordinal`, `corpus_run_ordinal`, `fixture_id`, `model_lane`) the fold gates on.
  - "Cold-only cache rows are insufficient" ⇒ the day gate requires a WARM `cache_read_input_tokens > 0` row on the explicit route; write-only rows never satisfy it.
  - Luna-Fast "accepted inspector_live rounds" ⇒ `billable_kind === 'inspector_extraction'` (the live loop's kind); `cache_keepalive` / `orphan_review` / `inspector_legacy` are pinned negatives.
  - Non-safety mismatch identity rides the terminal's `mismatch: {mismatch_id, safety_critical}`; `non_safety_decision` events key on `mismatch_id`.
  - The manual `confirmation_ref` is the exact op_key string from the completion manifest's delivery ledger (the persisted logical operation identity the plan requires).
  - Derek-namespace commands are TTY-gated (`isTTY` + typed "attest") — the plan's procedural-not-cryptographic separation.
- Files: scripts/plan00-evidence/{cli.mjs, lib/{constants,events,store,reservations,fold,collector,deployment,projections,fold-runner,memory-store}.mjs}
- Commit: a8c190ab
- Notes: reuses field-replay `canonicalBytes`/`evidenceEventHash`/`assertAppendOnly`-style semantics/`verifyTrustedRun`; no CloudFormation/Object Lock/IAM/bucket work, per the plan's round-14 descoping.

## Step Tests — 119 new tests, two implementation defects caught and fixed
- Status: applied
- Decision: rule 1. The delete-marker create-through defect (a contender could re-create a marker-hidden reservation and dispatch a duplicate provider call) and the lost-200 recovery API shape (frozen candidate must survive retries) were both found by the matrix and fixed before commit.
- Files: src/__tests__/plan00-session-manifest.test.js (43), src/__tests__/plan00-evidence.test.js (76), scripts/plan00-evidence/lib/reservations.mjs (fixes)
- Commit: d00a9e0e

## Step Docs — architecture/deployment/field-replay-corpus/changelog + hub row
- Status: applied
- Decision: rule 1. `npm run verify:plan00-provenance` green (4 reference copies verified; nothing rematerialised; tracked latency-batch index untouched).
- Commit: cf35ceb7

## Codex diff review

### Cycle 1 — three parallel lenses (wire-contract / silent-path / edge-interactions), gpt-5.6-sol high
Merged + deduped: ~17 distinct in-scope findings applied, 4 held out-of-scope as follow-ups. Every factual claim was VERIFIED against source before acting; two claims were corrected in the process (the live billable kind is `inspector_live` — confirmed at stage6-shadow-harness.js:1785; both `inspector_live` and the CostTracker default `inspector_extraction` are now accepted).

APPLIED (all in-scope):
1. Route-gate normalization — real rows carry `billing_tier: 'priority'` (raw returned label) and dated model names; gates now match by model family prefix + FAST_TIERS/STANDARD_TIERS + attributed + provider openai + Responses transport; cache gate bound to an attributed explicit-route inspector round.
2. Billable-kind vocabulary — `inspector_live` accepted; keepalive/orphan/legacy stay negatives.
3. Checksum verification — publisher verifies read-back ChecksumSHA256 on BOTH the 200 and 412 paths; operator store requests/propagates checksums; loadAuditedPrefix holds on mismatch.
4. Config-fingerprint env allowlist — corrected to the REAL deployed names (OPENAI_EXTRACT_SERVICE_TIER / OPENAI_EXTRACT_PROMPT_CACHE / OPENAI_EXTRACT_REASONING_EFFORT / OPENAI_OBSERVATION_REASONING_EFFORT).
5. publish-stage-a — NON-NULL prompt/tool/config fingerprints computed with the SAME imported derivations the server uses (config from the LIVE task-definition environment, never the operator shell); `runtime.deployment_fingerprint` computed via the shared `deploymentFingerprintOf`; schema validation now REJECTS null fingerprints.
6. bind-session — operator supplies session ids ONLY; the fingerprint derives exclusively from the validated stage-A event; bound events record ACTUAL manifest content hashes.
7. Fold binding — production_session_bound verified against collected manifest hashes + the cohort's stage-A deployment fingerprint + post-init receipt.
8. Terminal↔PENDING echo — pairing now compares allocation_version_id + requirement_class + all three digests; PENDING key derivation recomputed and verified.
9. Generation chain — contiguous 1..N, replacement only after a predecessor INVALID terminal, replacement PENDING must postdate that terminal, a valid terminal must be the final generation (violations BLOCK).
10. Receipt-day tightening — strict timestamp parsing (NaN rejects), PENDING/terminal same London day, PENDING after cohort deployment, attested_at strictly inside (completion, publication+skew).
11. field_session_ids — EVERY listed session must be genuinely bound with a valid pair, not just the confirmation session.
12. Collector closed schemas — start manifests reject ANY completion-field presence (even null) + unknown keys; completion requires the evidence_projection_v1 discriminator with matching session/boundary.
13. Cohort scoping + determinism — all records sorted (published_at, key) at fold entry; cohort-init dependencies resolved by EXPLICIT event hash (a later stage-A deploy can no longer invalidate an older cohort's binding); foreign-cohort records are integrity holds; multiple initializations BLOCK; ambiguous CLI cohort selection now errors instead of lexicographic-newest.
14. Corpus-gap validation — targets must be attested fixture ids or manifest-named non-safety gap strata, at the CLI and re-validated at the fold; safety strata unwaivable.
15. State resolution — visible corruption/invalid evidence is HOLD even before initialisation (never a clean NOT_STARTED/STAGE_A_IMPLEMENTED over a corrupt stream).
16. Live-check hardening — backend container selected by NAME; ALL running tasks must agree on one image digest (rollout overlap = unavailable, never first-listed).
17. C2 runners — new `lib/runner.mjs` + `run-ir`/`run-corpus` commands: ordinal allocation → atomic PENDING → invocation-local dispatch latch → injected lane executor → EXACTLY ONE terminal (executor throw ⇒ INVALID; a semantic verdict with zero provider ids ⇒ DOWNGRADED to INVALID `provider_ids_unavailable`, never fabricated identity). Plus: defensive `guardEvidenceRole` proxy around the production evidence roles (00B's mutation observer deliberately THROWS on contract violations and two of its production call sites sit outside try/finally — the guard preserves the already-latched invalid verdict while guaranteeing nothing propagates into the inspector's live turn), bounded ECS-metadata fetch, non-ok publish logging, observer-only factory fallback, atomic projection writes, restored `packages/shared-types/node_modules` symlink (an npm-install artefact had staged its deletion — out of plan scope).

HELD OUT-OF-SCOPE (→ follow-ups; the plan itself routes enumerated-file changes to a reviewed 00B successor):
- enterTurnScope root fix at the two enumerated call sites (mitigated in-scope by guardEvidenceRole).
- Capture/memory budget in the 00B ledgers for long sessions.
- Provider response/message ids surfaced from the enumerated lane machinery (until then, live runner terminals are honestly INVALID and replaceable).
- Per-fixture safety-classification map in the expectation manifest (fold currently trusts the interactive Derek decision within the accident threat model).

### Cycles 2–9 — verify/fix loop to CLEAN
Finding counts: ~24 (3-lens merge) → 9 → 11 → 4 → 8 → 6 → 5 → 2 → **0 (CLEAN)**. Every fix in-scope; ZERO sanctioned plan deviations (no OUT_OF_SCOPE fix was applied). Highlights beyond cycle 1 (each verified against source, then pinned):
- **Cycle 2:** cohort-wide single-use (IR ordinals across days; allocations per requirement/run-group), content-addressed attempt REPORTS audited by the fold (withheld FAIL = BLOCK, missing PASS report = HOLD), terminal↔PENDING digest echo + lane/model contracts, decision hardening (rejections irreversible, unclassified vendor FAIL unwaivable), day binding of the bound event, live CONFIG-fingerprint drift detection, closed completion-manifest schema.
- **Cycle 3:** reports cross-checked against terminals (verdict/ids/mismatch equality — the safety-reclassification false-DONE hole), fold-recomputed sample identities incl. the deployed fingerprint, REPRODUCIBLE cohort fingerprints (shared lib, recompute-or-refuse), approved non-safety FAILs now CREDIT their fixture (a Derek decision with no operational effect was itself the bug), manifest-named gap strata gate DONE, day-indexed dialogue hearings, literal `inspector_live` Luna gate, `simulate-principal-policy` effective-permission IAM proof.
- **Cycle 4:** caught my cycle-3 splice DELETING `resolveCohortId` (six commands would have thrown; eslint over scripts/ joined the loop), exact closed report schema, both attested component hashes bound into the fingerprint, universal sample-identity rule.
- **Cycle 5:** attest/init cohort-derivation parity (the normal workflow would have derived two different cohort ids), strict 64-hex attested hashes, runner-side mismatch normalization (no executor prose can enter the append-only stream), report contradictions reclassified INVALID/HOLD per validation precedence, canonical-body equality for different-ref reservation winners, CLI enum/boolean validation pre-confirmation.
- **Cycle 6:** caught that cycle-5's batch-A script had DIED ON AN ASSERT before writing four of its fixes — all re-landed with asserts + module probes (process rule adopted: every scripted multi-edit asserts its patterns and probes the result); whole-outcome INVALID on malformed provider-id arrays; exact ordinal-reservation validator; mixed-task-definition rollout guard.
- **Cycle 7:** key-shape reservation classification (a mistyped kind can never vanish an orphan PENDING), 1:1 list/describe task audit, attest-expectations RENDERS both frozen manifests (hashes alone are not a review), smoke fingerprint derived from live identity, operator-command examples + the `status --exit-nonzero-unless-done` gate rendered into the projections.
- **Cycle 8:** fully-typed PENDING schema (probe-pinned: the fold can never crash on malformed evidence), bijective RUNNING-task audit.
- **Cycle 9: CLEAN — zero findings.**
Gates after every cycle: focused suites + full backend (8079 passed at final) green; field-replay corpus 9/9 strict; eslint scripts/ 0 errors.
Verdict: **PASSED**.

## Completed 2026-08-05 (pre-merge snapshot; deploy outcome appended post-merge)

- **Outcome header: ALL PASSED** — every Stage-A step applied (none skipped/blocked/failed), full backend suite green (8079 passed / 0 failed / 19 pre-existing skips), field-replay corpus 9/9 strict, pre-merge semantic-oracle digest check green (the diff touches NO enumerated input), Codex diff review PASSED after 9 cycles (final: zero findings, zero plan deviations).
- **Commits:** db15e15d (C3 builder/publisher + server wiring + canonicalize→deps), a8c190ab (evidence layer), d00a9e0e (119-test matrix + 2 caught defects), cf35ceb7 (docs), c3f681f7 (cycle-1 fixes), 1e118e96 (mini-review fixes), 381cf6f8 (cycle-2), be550630 (cycle-3), 7a36a11f (cycle-4), ca12c9ee (cycle-5), b7be06e9 (cycle-6), f5426312 (cycle-7), a1c9418b (cycle-8), + this log + changelog addendum.
- **Files:** src/extraction/plan00-session-manifest.js (new), src/server.js, package.json/package-lock.json, scripts/plan00-evidence/** (new: cli + 11 lib modules), src/__tests__/plan00-evidence.test.js (new, 103 tests), src/__tests__/plan00-session-manifest.test.js (new, 46 tests), docs (architecture/deployment/field-replay-corpus/changelog + hub row).
- **Plan deviations: NONE** (no OUT_OF_SCOPE fix was ever applied; the four fixes the plan structurally forbids are held as follow-ups per its own 00B-successor rule).
- **Assumed decisions:** see Step 0 + C1/C2 sections above ([ASSUMED] entries: image constraints → canonicalize in dependencies + no scripts/ import from src/; requirement-key formats; warm-read cache gate; billable-kind mapping — later hardened to literal inspector_live by review; op_key as the manual confirmation_ref; TTY-gated Derek commands).
- **Skipped / blocked / failed steps: none.** Stage B correctly NOT materialised (operator runbook).
- **Stashes: none.** Worktree clean.
- **Tests:** 149 new focused tests; backend 8079/0; corpus 9/9; eslint scripts/ 0 errors.

Follow-ups noticed:
[FOLLOWUP] 00B successor: live vendor lane dispatch + provider response/message ids + INVALID-replacement CLI resumption — scripts/model-ab/lib/lane-driver.mjs + adapters (enumerated); until it ships, `run-ir`/`run-corpus` REFUSE before allocating (mock verdicts must never enter the evidence store); the runner protocol (scripts/plan00-evidence/lib/runner.mjs) is complete and test-pinned via injected executors; smallest next action: author the 00B-successor plan covering lane provider-id surfacing + wiring the live executor.
[FOLLOWUP] 00B successor (same plan can carry it): enterTurnScope root fix at its two out-of-try call sites (sonnet-stream.js:~6183, stage6-shadow-harness.js:~4417) + a capture/row budget in the 00B ledgers for long production sessions — both enumerated files; the in-scope mitigation shipped (guardEvidenceRole no-throw proxy on the mutation observer) but the root fix belongs upstream.
[FOLLOWUP] Stale comment in sonnet-stream.js (~line 2110): "the sole production caller … never passes initOptions, so this branch never runs live" is now FALSE (server.js registers the evidence factory in production) — enumerated file, fix in the next sanctioned 00B-successor edit.
[FOLLOWUP] Per-fixture safety-classification metadata in scripts/model-ab/plan00-expectation-manifest.json — without it, whole-fixture corpus deferrals are refused by design (unclassified = safety-critical); adding reviewed per-fixture/per-expectation safety metadata would let Derek defer a genuinely non-safety fixture; smallest next action: extend the manifest generator with a safety_critical field per fixture, re-attest.
[FOLLOWUP] Observation-turn discriminator in round_usage (a billable_kind or closed flag distinguishing observation loops from reading loops) — cost-tracker/lifecycle-hooks (enumerated); would let the Terra gate require a GENUINE observation round instead of the strongest-available proxy.
