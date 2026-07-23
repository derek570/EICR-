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

This exact shape exists because a naïve reading oracle GREENs on broken code: the wiped write IS still present in `extracted_readings` (the wipe is the post-envelope `field_corrected` frame), so only the joint assertion RED-proves the wipe. The op MUST be a singular circuit `reading` carrying own `value`, non-empty `field`, non-null `circuit`, no `circuits[]`, and BOTH `board_id` (the replacement's outward board) AND `clear_board_id` (the stale correction's outward board, each `string|null` — they may legitimately differ in spelling for the same effective board); any other shape is rejected fail-closed (`clear_then_write_bad_shape`), and `empty_fallback` still prohibits it as state-dependent. The correction lookup maps the raw expected `field` through the REAL A2 `CLEAR_WIRE_EXEMPT`/`FIELD_CORRECTIONS` dialect (`r2_ohm` stays raw), which is **dynamically injected** into the runner AFTER the recorded lane installs its fake clock — never a static import from the extraction graph (an import-graph regression test enforces this); when the mapping is unavailable the oracle latches INFRASTRUCTURE. Keystone: `frc_c1ea77d0…` (session 36731498) RED-proves `reading.op_ir_ctw` on pre-fix code.

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
