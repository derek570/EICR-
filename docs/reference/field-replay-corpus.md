# Field-replay correctness gate

A **merge-blocking regression corpus** that replays REAL captured field sessions through the REAL backend extraction pipeline (`runShadowHarness`) and asserts the audibility / write / clarification invariants. It closes the loop where a heavily-reviewed fix ships green-on-mocks and re-fails in the field the next morning: a fix for a field bug must now pass that bug's actual captured transcript before it can merge.

Origin: the 2026-07-15 F7/D2 waves shipped after 17-round `/rp` + multi-cycle `/ep` reviews + 5,200+ green tests, and field session `36731498` (the next morning, build 419) immediately re-failed bug classes those waves addressed. Every existing gate is static or mocked; this inserts the missing live-exercise step. Plan of record: the replay-corpus-gate handoff (private; not committed).

## Two lanes

| Lane | Trigger | Blocks? | Catches |
|------|---------|---------|---------|
| **Recorded (deterministic)** | per-PR, inside `Test Backend (Node.js)` | **MERGE-blocking** | backend drop/swallow + deterministic-backend-generated behaviours (a garbled transcript that beeps then goes silent; a swallowed clarification) |
| **Live (real model)** | nightly + manual dispatch | ADVISORY only | model-behaviour / routing (an observation turn the model never records; a clarification the model chooses not to ask) — a recorded replay is structurally blind to these |

The recorded lane replays the fixture's captured `model_rounds` through a mock Anthropic client (`src/__tests__/helpers/mockStream.js`) — no network, no vendor cost, deterministic. The live lane replays the same fixtures through the real model on the Haiku env, advisory, under a £10/month cost envelope.

## Corpus layout

```
tests/fixtures/field-replay-corpus/<corpus-id>/
  fixture.yaml            the executable fixture (ONLY basename discovered)
  attestation.json        the sanitized public review attestation (immutable hash + opaque source commitments)
  evidence/<kind>-<assertion>-<runid>.json   append-only trusted-run evidence events
```

`<corpus-id>` is **opaque and random** — `frc_<32 lowercase hex>`, generated from `crypto.randomBytes(16)`. NEVER a UUID (rejected), never date/marker-encoded (a `field-2026-07-16-f1` id trivially links to the incident). Human-readable labels and the raw session id live ONLY in the non-committed private review manifest. `fix_` references and other opaque public refs share the convention (`fix_<32 hex>`).

## The three-stage authoring workflow

The private review manifest can never be a CI input (it is never committed), so authoring is three stages:

1. **convert** — `node scripts/field-replay/convert-session.mjs --source=<type>:<role>:<path> [...] --out=.field-replay-drafts/<name>.draft.yaml --private-dir=<0700 archive>`
   Parses the raw sources (the backend CloudWatch JSONL export and/or the iOS flat-JSONL debug log and/or the `dr_*.json` reports), emits a sanitized NON-runnable draft into `.field-replay-drafts/` (gitignored, OUTSIDE the corpus root), and writes the PRIVATE manifest (source fingerprints, raw↔symbolic id map, chime correlations, per-corpus HMAC key) into the mode-0700 restricted archive. Source-permission preflight rejects any source outside a 0700 dir or broader than 0600. Fails closed on a stale/unlinked source.
2. **accept** — `node scripts/field-replay/accept-fixture.mjs --draft=<path> --manifest=<private> --out=tests/fixtures/field-replay-corpus/<id>/fixture.yaml --reviewer=<name>`
   Verifies freshness / provenance / PII review / raw-id remapping / chime evidence against the manifest; stamps `expires_at = accepted_at + 30d` (UTC) for `expected_red`; emits the committed fixture + the public `attestation.json` (immutable-payload hash + keyed source commitments — **bare raw source hashes never enter committed artifacts**).
3. **validate** — `node scripts/field-replay/validate-fixture.mjs <fixture>` (CI): committed fixture + attestation ONLY, no private manifest.

### Source formats

- **Backend CloudWatch JSONL export** — mixed backend rows + nested `Client log batch entry` → `client_log.{category,event,data}` envelopes. The chime evidence is a top-level `message:"Client diagnostic"` row with `category:"chime_invoke"` (NOT a nested event). Timestamps are **timezone-free second-resolution strings, parsed as UTC** (host-timezone parsing changes correlation across machines).
- **iOS flat-JSONL debug log** (the S3 `ln` capture — the executor confirmed the accepted flat-JSONL format; document the exact accepted filename(s) here when a real capture is inspected) — flat `{event, category, data}` records.
- **`dr_*.json` debug reports** — no session-id field; linked by the **100-character issue-prefix algorithm** against the `debug_report_uploaded` event (a full-description match yields zero matches on real artifacts), bounded by session + timestamp, exactly-one-match binds the session.

### Chime→turn correlation

Identifier join first (session + utterance/generation id). Otherwise pair a chime with the NEXT final transcript in the same session ONLY when it precedes another chime AND falls within `CHIME_CORRELATION_MAX_MS = 15000` (**exclusive** bound — a transcript at exactly the bound does NOT correlate). Ambiguity (multiple candidates, missing boundaries) is a CONVERSION FAILURE requiring a human-selected mapping in the private manifest, never a guess.

## Fidelity & scope (v1)

Fixtures enter AND exit at the `runShadowHarness` boundary. Out of scope in v1 (each a fixture-validation-rejected `capability_exclusion` + a named follow-up under `field-replay-hardening-followups`):

- **ingress** — pre-LLM gate, queue/overtake, regex fallback, deriving `in_response_to` from the inbound envelope (the recorded `inResponseTo` Boolean IS replayed);
- **post-harness egress** — `sonnet-stream.js`'s `validateAndCorrectFields`, extraction-envelope rewrites, `field_corrected` ordering;
- **Loaded Barrel** — the speculator is OFF in both lanes (its mid-stream read-backs participate in suppression/dedup);
- **postcode lookup** — `lookupPostcode()` network path (a fetch-deny guard is defence-in-depth);
- **watchdog / cancellation** — fixture-controlled cancellation triggers don't exist in v1;
- **dialogue-answer ingress** — `srv-*` ask ANSWER processing lives in the excluded pre-harness ingress.

Environment parity: the recorded lane runs the task-def env loader (`scripts/field-replay/replay-environment.mjs`) so `SNAPSHOT_FORMAT=split_blocks` / `CIRCUIT_ORDER=recent_3` / the routing models match production (config divergence is prompt divergence). Loaded Barrel OFF is the SOLE deliberate override.

## Gate-state machine

Fixtures carry `gate_state` ∈ `expected_red | required_green | unsupported_pending | superseded | privacy_quarantined`. Legal transitions ONLY:

- `expected_red → required_green` (the fix-wave GREEN flip);
- `unsupported_pending → expected_red` (payload-changing promotion, new attestation);
- `unsupported_pending → required_green` (ONLY with dual RED-against-pre-fix + GREEN-against-fixing-subject evidence);
- `required_green → superseded` (reviewed product-policy change — tombstone preserved);
- `* → privacy_quarantined` (EXECUTION CONTAINMENT, not erasure — the sensitive bytes remain in git history; a real disclosure triggers the separate PII-incident path).

Immutability is **history-anchored, not self-attested**: CI compares every pre-existing executable fixture / attestation / evidence log against the merge-base (PR) or `github.event.before` (push) and rejects any change to the immutable projection (which excludes only the mutable `gate_state` + active `expected_failure_id`). `expected_red` is satisfied ONLY by its exact `expected_failure_id`; XPASS fails the gate; an infrastructure failure (round-cursor violation, unmatched ask, swallowed `stage6_live_error`) is a DISTINCT outcome that can never satisfy a RED proof.

Every `expected_red` carries `owner / introduced_at / fix_reference / expires_at` (initial = `accepted_at + 30d`, max two 14-day extensions, 58-day hard bound — Derek, 2026-07-16). Expiry is evaluated against the REAL CI wall clock (captured before the scenario fake clock installs), never replay time. After an unextended expiry the deliberate pipeline freeze applies.

## Evidence (never self-asserted)

An arbitrary local log + attestation can be authored without ever running the command, and CI cannot re-reproduce a historical RED once a fixture flips — so ALL evidence uses **trusted-run retrieval**: `scripts/field-replay/accept-evidence.mjs` fetches the run + artifact via authenticated `gh api` / `gh run download` and verifies repository, anchored workflow-blob SHA, event, ref, head/base SHA, conclusion, artifact name + digest, fixture hash, assertion id, and tested tree BEFORE reading the result. A hand-authored event with regenerated hashes is rejected because the run it names does not verify. For every newly added evidence event, `test-backend` independently re-fetches + re-verifies before merge; pre-existing evidence relies on history locking.

Three modes: RED (`--manifest`, additionally scans the fetched artifact against the private raw-id map locally), GREEN (`--fixture` + `--attestation`, opaque ids + generic scans only), advisory (`--mode=advisory`, enforces the 3-consecutive-run chain over the same assertion + model + `behaviour_fingerprint`).

### RED/GREEN sequencing (two PRs)

The evidence workflow cannot authenticate the PR that introduces it, and `workflow_dispatch` cannot dispatch a workflow absent from the default branch — so:

1. **Foundation PR** (this one) — the runner, validators, the immutable evidence workflow (`field-replay-evidence.yml`), history checks, CI wiring, docs, ZERO keystone fixtures, ZERO evidence. Merges first, anchoring the workflow on `main`.
2. **Keystone PR** — branched from post-Foundation `main` (whose production tree still equals the pinned baseline `8fb95b7b`, CI-verified via the subject-path projection). Adds the fixtures and obtains RED evidence via the already-anchored workflow (two-phase tail: N focused fixture commits, then ONE evidence-only commit).

Evidence records both `subject_code_sha` (the pinned code under test) and `harness_commit_sha` (the harness applied on top). Merge strategy is load-bearing: evidence-bearing PRs merge via `gh pr merge --merge` (squash/rebase rewrite SHAs and orphan the evidence).

## PII policy

Commit only the minimal turns; strip user/job identifiers; pseudonymise via the **reserved synthetic grammar** — persons `fixture_person_<N>`, addresses `<N> Example Street, Testtown`, postcodes from the non-real `ZZ99` range (the ONLY content the scanner accepts in canonical PII fields). The raw backend JSONL export NEVER enters the repo. The scanner runs on RAW BYTES of every committed YAML/attestation/evidence file (comments, keys, anchors) plus every filename. Docs are two-tier: full raw-byte scan for new/modified corpus artifacts + newly created docs; legacy tracked docs scanned on ADDED lines only.

## Governance

Exceptional transitions (`expiry_extension`, `required_green → superseded`, `* → privacy_quarantined`) are **trusted governance events**, not free-form fields. Derek chose the **signed-commit branch** (2026-07-16): the exact governance-event commit, with the permitted diff only, must be signed by an allowlisted key fingerprint in `config/field-replay-maintainers.json` — byte-for-byte key binding (`verified: true` alone is insufficient — it accepts any GitHub-verified key). NO PR-review / distinct-approver requirement (that would re-create the solo-maintainer impossibility). The machine-account two-phase protocol is the documented fallback only. The allowlist is read at the base commit (never the PR head); a rotation and the transition it authorizes can never share a PR.

## CI lanes & delivery

- **Blocking:** `npm run replay:field-corpus` runs as a step inside `Test Backend (Node.js)` (so it rides the merge-blocking required check), followed by `scripts/field-replay/ci-history-checks.mjs` (immutability, manifest-path lock, expected-red closure, evidence re-fetch, dormant-until-marker ruleset guard). `test-backend` checks out `fetch-depth: 0` (history-anchored comparison) on the pinned Node `20.20.2`.
- **Manual deploy:** production `workflow_dispatch` requires `refs/heads/main` AND runs the corpus in a `manual-deploy-gate` job before `build-images` (the prior bypass let a manual dispatch skip `test-backend`).
- **Empty corpus = PASS** (exit 0 with `0 fixtures discovered`) — the Foundation PR wires the blocking step while shipping ZERO fixtures.
- **Local backstop:** `.husky/pre-push` runs `replay:field-corpus:prepush` — the XPASS-tolerant variant (a fix commit F's fixed `expected_red` fixtures intentionally XPASS; `--no-verify` stays prohibited). Local diagnostics only; the Node-20 CI job is authoritative.
- **Delivery is PR-only** — `main` is PR-protected; the hub auto-push rule is rewritten to auto-PR-then-`gh pr merge`.

## Live lane (Item 3 — external prereqs)

`field-replay-nightly.yml` splits scheduled (default-branch, no approval env) and manual (`workflow_dispatch` on `main`, gated by the `field-replay-vendor-manual` protected environment). Budget: a pre-run envelope over a COMPLETE shard rotation (config/field-replay-budget.json v1) — STOP + file an advisory issue if the projected monthly cost exceeds £10. The three routing values (`SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001`, `OBSERVATION_EXTRACT_MODEL=claude-sonnet-4-6`, `VOICE_LATENCY_ROUND1_MODEL=` empty) are drift-enforced against the task-def by a blocking test.

**Completion of Item 3 is a HUMAN prerequisite**: the `ANTHROPIC_API_KEY` repo secret must be provisioned AND the `field-replay-vendor-manual` protected environment configured (Derek as required reviewer, `prevent_self_review: false`, deployment branches = main). Until then the lane no-ops (a skipping workflow is NOT a delivered lane). See the vault todo.

## Standing rule

A BACKEND/MODEL field-feedback bug **within the corpus's v1 coverage** is not "done" until its captured transcript is a fixture in `field-replay-corpus/` that went RED-before / GREEN-after (deterministic lane for backend drop/swallow + deterministic-backend-generated behaviours; real-model lane for model-behaviour/routing bugs) and stays as a permanent regression guard. A CLIENT-ONLY bug (e.g. an iOS `observation_deduped`) is "done" only with a client apply/dedupe replay; its sanitized permanent record lives in the owning iOS/PWA corpus.

## Threat model (accident, not malice)

One-maintainer repo: every PR author is Derek or a Claude session on his behalf. The failure class this stops is well-meaning-but-wrong code going green on mocks, including a confused session fabricating plausible-but-never-executed artifacts. Malicious-insider hardening (base-branch-controlled `pull_request_target` check, OS-level `--network=none`, exact-closure trusted-harness manifest, hostile-PR credential-recovery suite) is DEFERRED to `field-replay-hardening-followups`, MANDATORY before any second maintainer gets write access. Accepted residual risk (dated): a PR editing `deploy.yml` itself to remove the corpus step would merge green — mitigated by PR review, the pre-push backstop, and the deploy-blocking lane.
