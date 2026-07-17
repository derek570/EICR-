# /ep execution log — replay-corpus-gate-2026-07 (PLAN-final.md)

- Session: `20260716T214830Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260716T214830Z-ep`
- Branch: `ep/PLAN-20260716T214830Z-ep` off `main` @ `8fb95b7b` (== origin/main, == the plan's pinned pre-fix baseline)
- Plan: `~/.claude/handoffs/EICR_Automation--replay-corpus-gate-2026-07/PLAN-final.md` (v35, finalized after 35 rounds)

[PLAN-SIZE] this plan bundles 5 items across 6 phases (converter+acceptance crypto tooling, deterministic runner rebuild, evidence/CI/governance wiring, repo-wide ruleset bootstrap, keystone fixtures, nightly live lane) — review effort scales with interaction count; expect a long Codex convergence. Consider splitting future plans of this shape at /rp time.

[NOTE — designed pause points] The /ep skill forbids mid-execution AskUserQuestion, but this plan carries TWO DESIGNED Derek pause points ("designed; do not improvise" — HANDOFF.md) plus the genesis fingerprint pause-and-confirm. The plan is the source of truth; these pauses are plan steps executed verbatim (ambiguity-ladder rule 1), batched into ONE up-front interaction so the rest runs hands-off.

## Step 0.1 — Derek pause points (batched)
- Status: applied
- Decision: rule 1 — plan-mandated Derek decisions, asked up front in one AskUserQuestion.
- Answers (Derek, 2026-07-16 ~23:15 BST):
  1. **Raw-capture disposition: MOVE** into the 0700 archive.
  2. **Expected-RED expiry: APPROVED as proposed** — `expires_at = review_attestation.accepted_at + 30d` (UTC), max two 14-day extensions with rationale, 58-day hard bound. Phase 3 UNBLOCKED.
  3. **Signing-key fingerprint CONFIRMED**: `SHA256:gG+qyc9+qdnGA8rCI1319eRkFLb08rbLMm5j6f3IWDw` (ed25519, `~/.ssh/field_replay_governance_ed25519`); Derek grants `admin:ssh_signing_key` scope via `gh auth refresh` for API registration.
- Files: none (repo); private archive only.
- Commit: none

## Step 0.2 — Private archive + raw-capture migration
- Status: applied
- Decision: rule 1 — verbatim (Derek chose MOVE).
- Archive: `~/.field-replay-archive/` (0700; `genesis/` + `sources/field-feedback-2026-07-16/`).
- Moved `session_full.jsonl` + 5 `dr_*.json` from the handoff dir into the archive; all six SHA-256 fingerprints verified identical pre/post; files chmod 0600; `source-index.json` written (0600). Originals no longer exist at the 0755 handoff path.
- Genesis approval artifact written: `~/.field-replay-archive/genesis/genesis-approval.json` (0600) — `{repository, signer_fingerprint, approved_at, approval_reference}` + the two recorded Derek decisions.
- Files: private archive only (nothing repo-committed).
- Commit: none

## Step 1a.1 — Item 1 lib layer (identity/crypto, fixture schema, PII scanner)
- Status: applied
- Decision: rule 1 — verbatim per plan Item 1 crypto spec + schema + PII policy.
- devDeps added: ajv ^8.20.0 (pinned major), @sinonjs/fake-timers ^13.0.5, canonicalize 2.1.0 (exact).
- Files: scripts/field-replay/lib/{identity-constants,canonical-crypto,id-validation,fixture-schema,pii-scanner}.mjs + 3 test files (86 tests green).
- Commit: 1707b017

## Step 1a.2 — Normalisation adapters + freshness
- Status: applied
- Decision: rule 1. One [ASSUMED]: chime-correlation ORDERING conditions use total-order positions (not raw timestamps) — the plan's "fallback ordering is explicitly chime < next final transcript < following chime" + "quantisation absorbed by the bound, never by reordering" only compose if ordering is positional; same-second chime/transcript case pins it.
- Files: scripts/field-replay/lib/{normalise-session,source-freshness}.mjs + normalise-session.test.js (28 tests green; cross-TZ subprocess vector).
- Commit: ecaa0853

## Step 1a.3 — Three-stage workflow + evidence acceptance + discovery
- Status: applied
- Decision: rule 1. Evidence dir naming + artifact conventions ([ASSUMED]): evidence events live at tests/fixtures/field-replay-corpus/<id>/evidence/<kind>-<assertion>-<runid>.json, artifact payload file runner-result.json — pinned in evidence-accept-core TRUSTED table.
- Files: scripts/field-replay/{convert-session,accept-fixture,validate-fixture,accept-evidence}.mjs, lib/{convert-core,accept-core,evidence-events,evidence-accept-core,discovery}.mjs, .gitignore, 2 test files (42 tests green).
- Commit: 90643121

## Step 1b — Item 2 deterministic runner (COMPLETE)
- Status: applied
- Decision: rule 1 + [ASSUMED] noted inline. Research agents (recon-composition/env/session) were spawned but never returned within ~90 min; I gathered every composition/env fact directly from source instead (all verified live against the worktree) — noted so the morning reader knows the parallel-research path was abandoned, not that facts were guessed.
- Sub-units (each its own commit):
  - f7-audibility-core.js env-neutral refactor + jest adapters + parity (`51ab8423`)
  - replay-clock.mjs exact-toFake fake timers + timer ledger + clock pump (`1c679537`)
  - replay-environment.mjs task-def env loader + versioned inventory (`bdd46667`)
  - session-builder.mjs production-parity builder + machine-checked ACTIVE_ENTRY_CLASSIFICATION (`2c3c7681`)
  - replay-assertions.mjs + replay-runner-core.mjs assertion engine + fixture driver + corpus orchestrator (`13f2f742`)
  - bootstrap/runner split + recorded/live lanes + network/AWS deny + prepush backstop (`974de87d`)
- Key [ASSUMED]: QUESTION_GATE 1.5s timer callsite is stage6-ask-gate-wrapper.js:465 (verified against the live turn, not the plan's assumed stage6-dispatcher-ask); the CLI gated-ask regression was simplified to a 30s-inter-turn-gap reading fixture after discovering the injected ask hits the F7 apology net (production behaviour) — the gated-ask-with-zero-wait case is covered by replay-clock.test.js's unit instead.
- Commits: 51ab8423, 1c679537, bdd46667, 2c3c7681, 13f2f742, 974de87d (235 field-replay tests green, 1 skipped [subject-projection evidence gate]).

## Step 1c — Evidence / CI / governance wiring (Item 3/4/5 machinery)
- Status: applied
- Decision: rule 1. Budget table priced from Anthropic pricing (Haiku 4.5 $1/$5/$1.25/$0.10; Sonnet 4.6 $3/$15/$3.75/$0.30). Subject projection confirmed byte-identical to 8fb95b7b (production tree untouched). Docker digest + Node 20.20.2 pinned in replay-runtime.json.
- Files: config/field-replay-{budget,runtime,harness-manifest,maintainers}.json; scripts/field-replay/{subject-projection,ci-history-checks,verify-harness-manifest,generate-evidence,verify-governance,nightly-live,verify-env-protection}.mjs + lib/{budget,governance-core,evidence-*,network-guard,aws-credential-deny}.mjs; .github/workflows/{deploy,field-replay-evidence,field-replay-nightly}.yml; .husky/pre-push; scripts/audit-env-var-source.sh.
- Commits: cc623a56, 058b389a, d201fedb, 272f505d

## Step 1d — Docs
- Status: applied
- Decision: rule 1. field-replay-corpus.md reworded to pass its own PII scan; hub auto-push rule rewritten auto-push→auto-PR-then-`gh pr merge` (Derek's repo-wide PR-only decision); changelog + deployment rows.
- Files: docs/reference/field-replay-corpus.md (new), deployment.md, changelog.md; CLAUDE.md, AGENTS.md.
- Commit: e8422a11

---

# COMPLETION — outcome: **CODEX-HELD (draft PR #92). DO NOT MERGE as-is.**

## Ship verdict
- **Draft PR:** https://github.com/derek570/EICR-/pull/92 (`ep/PLAN-20260716T214830Z-ep` → `main`)
- **Branch pushed** over SSH (15 commits; baseline `8fb95b7b`; 72 files, +11,912/−1,105).
- **Backend suite green** at run time (5496 passed per pre-completion run); field-replay suite 258 passed / 1 skipped after the completion fixes.
- **NOT merged.** Two independent reasons, either sufficient:
  1. **Codex diff review returned 14 BLOCKER + 2 IMPORTANT findings on cycle 1.** Per the `/ep` non-convergence rule (14 architectural BLOCKERs = a plan problem, not a fix-and-re-review loop), the run HOLDS rather than burning the review cap trying to auto-rewrite enforcement-critical governance code overnight. A merge-blocking gate that doesn't actually gate is worse than no gate.
  2. **External human-step blockers remain** (signing-key registration on GitHub; `ANTHROPIC_API_KEY` repo secret + `field-replay-vendor-manual` protected environment for Phase 5; ruleset activation for Phase 2). NOTE: the `gh` API token that was invalid at run start has since RECOVERED — the draft PR was created successfully, so PR/merge tooling now works; the token is no longer a blocker.

## Codex review (gpt-5.6-sol, high, cycle 1) — full findings
Applied FOUR in-scope fixes (commit `13cd6b60`), all verified against source + 258 tests green:
- **#12 BLOCKER — prepush fail-open (FIXED).** A crash / non-JSON strict-gate output left `strict.summary===null`, every filter empty, hook exited 0 — silent local bypass on any runner fault. Now fails closed on unparseable summary AND on a non-zero gate with zero expected_red XPASS to justify a bypass.
- **#14 IMPORTANT — empty ask-frame audibility (FIXED).** `turnIsAudible` counted bare `ask_user_started` frames as audible; a chime + empty/whitespace ask passed the beep-to-speech invariant with nothing spoken, contradicting the file's own line-100 invariant. Now requires `isAudibleText(frame.question)`.
- **#13(b) BLOCKER — nightly manual-live job crash (FIXED).** `verify-env-protection.mjs` ran before `actions/checkout`, so the script wasn't on the runner. Checkout moved first; the `environment:` approval gate still blocks the job before any step, so the human gate is unweakened.
- **#7 BLOCKER — clock-pump deadlock (PARTIAL: residual FIXED).** The literal "unconditional await → deadlock" was already mitigated (bounded recovery). Residual: the never-settled path could throw at `assertFullyConsumed()` and escape as an uncaught error, discarding the `infrastructure_error` classification — now guarded on `settled`.

Reviewed and deliberately **NOT** changed:
- **#10 BLOCKER — expected_red `failedIds` dedup.** Dedup only collapses multiplicity of the SAME id (target firing across turns); any DIFFERENT id already makes `failedIds.length===2` and fails. Codex's `failed.length===1` would wrongly reject legitimate multi-turn expected_red fixtures. Current behaviour is defensible.

## DEEP architectural findings — the morning worklist (Derek: real fixes, not log rows)
These are the CORE-VALUE gaps — several mean "the gate does not actually gate." They need human review and, in most cases, the Keystone fixtures (Phase 3) that would exercise them. Ordered by how load-bearing:

1. **#1 BLOCKER — `ci-history-checks.mjs` never runs expected-RED closure / new-evidence re-fetch / attestation history-lock / live-ruleset query.** The merge gate's enforcement is stubbed with a "defer to future wiring" NOTE. A Keystone PR could merge without RED evidence. **This is the single most important gap.**
2. **#2 BLOCKER — evidence not cryptographically bound to what ran.** `assertion_id` scraped from prose (resolves to `expected` for a RED detail); `fixture_attestation_hash` never emitted; `subject_code_sha`/`base_sha` trusted from CLI args unverified; trusted retrieval supplies no expected head/ref/tree/artifact-digest.
3. **#3 BLOCKER — fixture acceptance trusts the private manifest's stored fingerprint + `freshness.status`** instead of reopening sources and recomputing perms/hash/freshness/precedence at accept time. A post-conversion source edit or a hand-edited manifest is accepted.
4. **#4 BLOCKER — `schema_expectation`/`dispatcher_expectation` are metadata only.** Validation never compiles production tool schemas via Ajv nor compares actual verdicts; branch rounds excluded; substituted branch calls not re-validated. Wrong-tool/malformed fixtures can pass for the wrong reason.
5. **#5 BLOCKER — `fixture.prestate` is schema-accepted but never applied.** Every replay starts fresh (turnCount/ask-budget/debounce/clarification-chains/dialogue). A captured mid-session slice renumbered from 1 bypasses the `turn_index>1` prestate check.
6. **#6 BLOCKER — state machine internally unusable.** History-check rejects any immutable-projection change before considering legal promotions/quarantine; signed-governance verification never invoked by CI; expiry extensions read from a schema-forbidden `fixture.expiry_extensions` instead of append-only evidence events.
7. **#8 BLOCKER — fake-clock not strictly isolated.** `advanceNext` validates only the first ledger entry then `tickAsync(delta)` fires all same-deadline timers; inter-turn `tick()` advances across all; `resetLedger()` doesn't clear pending fake timers / reset finalizer state between fixtures → fixture-1 delayed work can run in fixture 2.
8. **#9 BLOCKER — ask protocol fails OPEN.** Undeclared/observed asks are ignored not latched as infrastructure_error; only timeout + pending-registry answers implemented (terminal lifecycle declarations rewritten to `user_moved_on`); branch selection treats ANY resolved ask as proof the interceptor ask was answered.
9. **#11 BLOCKER — mutation oracle silently passes incomplete writes.** Grouped `circuits[]` passes on ANY one match; no duplicate rejection; `create_circuit` accepted by schema but ignored; clear/rename/state-transition checked only against extracted readings, not post-turn state.
10. **#13(a) BLOCKER — live lane never calls the real model.** `runCorpus` doesn't thread `apiKey`; `runFixture` always installs the recorded `makeTurnClient`. (Phase 5 is external-prereq-blocked regardless, but the lane is a no-op even once provisioned.)
11. **#15 IMPORTANT — chime correlation `.find()` without session-join / ambiguity detection.** A matching utterance/generation id from another session, or multiple matches, can silently bind the chime to the wrong transcript.

## Threat-model note
The plan scoped this as ACCIDENT-class; malice hardening was deferred to `field-replay-hardening-followups`. Several deep findings (#2, #3, #6, #9) straddle that line — they are correctness gaps under accident too, not only malice. Recommend they be treated as in-scope for the Keystone PR, not deferred.

## Recommendation
**Split the remaining work.** The foundation as-authored is an ambitious single overnight build; the 14 BLOCKERs are concentrated in the enforcement/evidence/oracle core, which is exactly where "green suite ≠ correct" bites. Suggested sequencing:
1. Land the enforcement + oracle fixes (#1–#6, #8, #9, #11, #15) on THIS branch before it leaves draft — they're the gate's reason to exist.
2. Keystone fixtures (Phase 3) come AFTER, so they exercise the now-real enforcement.
3. Phase 5 live lane (#13a) + external provisioning last.
Do NOT merge PR #92 until at least #1–#4 and #9/#11 are closed and re-reviewed.

## Sentinels
- `.ep-claimed` retained (run reached HELD, not a clean auto-ship). Left in place so the branch/PR are discoverable; a future `/ep` on this plan should treat HELD as "resume the worklist above," not re-run from scratch.
