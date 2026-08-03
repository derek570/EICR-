> **REFERENCE COPY — NOT EXECUTABLE.** Execute only the canonical handoff final recorded in `provenance.json`; every tracked copy has an adjacent fail-closed EP policy.

# Plan 00 bundle — residual Haiku-to-GPT-5.6 parity gate

Status: **RP-REVIEWED — bundle index only / NOT AN EP TARGET**
Canonical backend repo: branch each execution from then-current `origin/main`

Execution guard: this umbrella is permanently non-executable. Run only the explicit child finals in 00A → 00B → 00C order, each with `--no-chain` and only after its machine policy admits it.

## Outcome

The original migration plan was stale: atomic provider routing/system-block separation, explicit OpenAI prompt caching and Terra observation routing already shipped. Plan 00 is now a residual prerequisite bundle that audits those contracts, fixes Responses/cost accounting, creates a trusted production-composed semantic oracle and requires three calendar days of field evidence before later behaviour-changing latency plans may run.

The bundle preserves Luna Fast for readings, Terra Standard/low for observations, explicit cache, the two-round conversational loop, current end-of-turn behaviour and all client/TTS wire semantics. It does not implement eager end detection, Loaded Barrel, TTS/Deepgram/ElevenLabs changes, parallel speculative rounds or the future 25-minute keep-alive.

## Why it is split

Rounds 5–9 repeatedly found new issues only in the oracle/evidence subsystems while provider/tool work had converged. The round-10 diagnostic replaced the problematic handler-by-handler design and split execution at stable ownership boundaries:

1. [Plan 00A — provider, tool-result and cost parity](./PLAN-00A-final.md)
2. [Plan 00B — production-composed trusted semantic oracle](./PLAN-00B-final.md)
3. [Plan 00C — durable three-day field-evidence gate](./PLAN-00C-final.md)

The three files are separate EP task graphs. Do not combine them into one partial execution.

## Bundle RP termination contract

Only a clean shared reviewer round may finalise this bundle. Then:

1. render the umbrella and three converged child finals, all four HANDOFFs and both variants of the 00A policy to nonce-bearing temporary filenames that do **not** match `*-final.md`; validate all content/links while no canonical final exists;
2. publish a valid canonical 00A **staging** sidecar with `executable:false`. Write and validate the final umbrella/00B/00C sidecars at their canonical `<PLAN-final.md>.ep-policy.json` paths. The umbrella policy is `executable:false`; 00B and 00C are `executable:true`, `explicit_only:true` and `require_no_chain:true`. Plan 00B requires Plan 00A's shipped `.ep-success.json`, live deployed-commit match and `plan00_tracked_bundle_provenance` artifact; Plan 00C requires Plan 00B's corresponding shipped success/live match and `plan00_expectation_manifest`. Missing/held/partial/draft/failed/stale prerequisites skip before claim. 00A records the tracked provenance artifact on success; 00B records the expectation manifest;
3. while 00A remains disabled, atomically rename every temporary final and HANDOFF to its canonical path, then validate the complete four-plan final/policy/HANDOFF bundle. At no point may a dependency-free executable root exist during this publication sequence;
4. as the single atomic activation point and final operation, rename the already-validated 00A policy with `executable:true`, `explicit_only:true` and `require_no_chain:true` over its staging policy. Revalidate the complete bundle and only then expose the 00A EP command. Crash-boundary verification after every preceding publication step must prove there is no executable root before this final policy swap. The sidecars—not prose or `.ep-done`—are the execution gate.

Temporary provider-credit exhaustion never consumes 00A: its same claimed run follows canonical EP's bounded 24-hour wait with 15-minute claim heartbeat and resumes. Explicit account/billing/insufficient-quota errors or expiry take the hard-disabled path. If 00A must terminate, a fresh RP-finalised replacement 00A final and updated 00B policy supersede it; a separate recovery final cannot emit success on behalf of the predecessor path 00B names.

The umbrella is never passed to EP. RP finalisation edits handoff artifacts only and does not claim to commit the tracked repository.

## Execution order

```text
00A [REFERENCE COPY — Plan 00A execution uses its canonical handoff final only]
  ↓ merged + deployed
00B [REFERENCE COPY — Plan 00B execution uses its canonical handoff final only]
  ↓ merged + deployed; expectation projections/hash ready
00C [REFERENCE COPY — Plan 00C execution uses its canonical handoff final only] — Stage A infrastructure only
  ↓ merged + deployed green; .ep-done written (consumption only)
00C committed operator command publishes verified stage_a_deployed
  ↓ STAGE_A_IMPLEMENTED (until then NOT_STARTED)
00C operational command — Derek attests expectations and initialises cohort
  ↓ HOLD_EVIDENCE 0/3
00C committed operational commands — 3 field days
  ↓
DONE → later behaviour-changing latency plans eligible
```

Plan 00C Stage B is explicitly not an EP task. Its version-audited event store and committed commands publish the Stage-A deployment event and then resume/finalise evidence after normal EP completion. A green deploy with no event remains `NOT_STARTED` and the operator may run the publisher later; a failed deploy or broken publisher requires a fresh fix-forward handoff. Runtime status remains external to the tracked index because a `.planning/**`-only PR currently redeploys the backend and would invalidate the cohort it documents.

## Reference baseline to revalidate

Reference checks on 2026-08-03 used source `af530a7a3c93c60a46bb2a58b4e67e8c2debc19d` and healthy ECS backend revision 375:

- reading: `gpt-5.6-luna`, requested Fast;
- OpenAI explicit prompt cache;
- observation: `gpt-5.6-terra`, Standard/low;
- `OBSERVATION_TIER_ROUTING=true`;
- empty `VOICE_LATENCY_ROUND1_MODEL`.

Already shipped: `a45996a6` provider/system rendering, `94f56eea` core explicit caching and `60fd0f9d` Terra observations. Plan 01's core cache work is historical; its 24-hour retention/25-minute re-warm supplement remains DRAFT, outside Plan 00, and may run later after this gate.

Each child plan must start from fresh current main and repeat read-only source/live checks. Stop and re-baseline on material drift; never mutate ECS to make evidence match.

## Bundle acceptance

Plan 00 is complete only when 00A and 00B are delivered and Plan 00C's version-audited evidence fold is live-validated `DONE`. Any pinned-IR miss, certificate-mutation safety regression or manual-heard failure irreversibly blocks its cohort. Later behaviour-changing latency plans remain held until then.

Plan 00A step A0 is the sole source-controlled owner of vendoring immutable umbrella/child finals beneath `.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity/`, replacing the batch target with a repository-relative entry point and correcting the stale index to a static `RUNTIME STATUS EXTERNAL` entry in its normal PR. Plan 00C verifies that materialisation; HOLD/DONE exists only in live-validated local projections/status output, never a tracked status commit that redeploys the cohort. RP itself commits nothing.

Open execution choices: none. Cache keep-alive, speculative/parallel rounds and Loaded-Barrel value are deliberately deferred to their later plans.
