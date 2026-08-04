> **REFERENCE COPY — NOT EXECUTABLE.** Execute only the canonical handoff final recorded in `provenance.json`; every tracked copy has an adjacent fail-closed EP policy.

# Plan 00A — residual GPT-5.6 provider, tool-result and cost parity

Status: **DONE — RP converged / EXECUTION-READY**
Dependency: none; execute before Plans 00B and 00C
Execution after RP convergence only: `[REFERENCE COPY — Plan 00A execution uses its canonical handoff final only]`

Execution guard: exact explicit path only; `--no-chain` is mandatory. Do not execute a tracked repository derivative. A-pre is the first executable task, and no repository mutation may precede its provider-credit PASS.

## Outcome and boundary

Audit the already-shipped Haiku-to-GPT-5.6 port without reimplementing it, close the remaining Responses tool-result and mixed-model accounting gaps, and leave the live conversational behaviour unchanged. This plan owns the converged provider/tool/cost portion of the former Plan 00. It does not own the semantic A/B oracle (00B), multi-day evidence (00C), model selection, end-of-turn policy, the two-round loop, client wire shapes, TTS, Deepgram, ElevenLabs, Loaded Barrel or the future cache keep-alive.

`/ep` executes every step in this file and may merge/deploy it when its tests pass. It must not materialise 00B/00C work as skipped, blocked or assumed tasks.

## Revalidate before editing

Create a fresh worktree from current `origin/main`. The 2026-08-03 reference point was `af530a7a3c93c60a46bb2a58b4e67e8c2debc19d`; stop and re-baseline if current source or live configuration has materially drifted.

Already shipped—verify, do not duplicate:

- `a45996a6`: `providerForModel()`, `ProviderResolutionError`, session-owned provider client cache, `resolveExtractionTarget()`, whole-loop provider fence and named `SYSTEM_BLOCK_SEPARATOR`.
- `94f56eea` / PR #150: Plan 01's **core** explicit OpenAI prompt cache is SHIPPED/HISTORICAL and must not be reimplemented. Plan 01's retention/keep-warm supplement (§5: 24-hour retention evaluation and any 25-minute Terra re-warm) remains DRAFT, is outside Plan 00 and may re-enter EP only after this bundle.
- `60fd0f9d` / PR #147: Terra observation routing.
- Reference live state: backend task definition 375; `SONNET_EXTRACT_MODEL=gpt-5.6-luna`; OpenAI extraction tier `fast`; explicit prompt cache; `OBSERVATION_EXTRACT_MODEL=gpt-5.6-terra`; observation tier Standard/low; `OBSERVATION_TIER_ROUTING=true`; empty `VOICE_LATENCY_ROUND1_MODEL`.

Revalidation is read-only against source-controlled task definitions and ECS. Never mutate ECS to make it match the plan.

## A-pre — provider-credit preflight (FIRST executable plan task)

Immediately after canonical EP claim/worktree setup and before A0, any repository edit/commit or any other live probe, run the cheap read-only provider-credit preflight. A temporary-class result enters the declared same-claim `CREDIT_WAIT_MAX` wait with the already-created clean worktree retained and a 15-minute claim heartbeat; a hard-disabled result records HELD, removes the still-clean empty worktree/branch through normal cleanup, emits no success and stops before repository mutation. Only a passing result unlocks A0. This is the first task in EP's document-order task list; do not begin A0 until A-pre is PASS.

## A0 — one-time batch materialisation (bookkeeping)

In this plan's normal source PR, vendor immutable **reference-only** copies of these four converged handoff artifacts under `.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity/`:

- `./PLAN-00-final.md`;
- `./PLAN-00A-final.md`;
- `./PLAN-00B-final.md`;
- `./PLAN-00C-final.md`.

Treat the tracked files as deterministic derivatives, not byte-identical copies, because their machine-local links must be rewritten. Give every tracked `*-final.md` an adjacent valid `.ep-policy.json` containing `schema_version:1` and `executable:false`; these repository copies are never EP targets. Replace every executable `/ep --plan=` instruction inside the derivatives with a conspicuous banner that execution uses the canonical handoff final only. Replace `.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity.md` with a repository-relative entry point to those derivatives. Write `.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity/provenance.json` with each absolute source identifier/source SHA-256, committed repository-relative Markdown and sidecar paths/hashes, and the complete ordered path-substitution map. Verification hashes every source, deterministically regenerates both each derivative and its non-executable sidecar, byte-compares them with the committed outputs, asserts every tracked `*-final.md` has a valid adjacent non-executable policy and verifies every resulting link resolves inside a fresh checkout. Unconditionally rewrite `INDEX.md`'s Plan 00 summary, dependencies and execution order to the reviewed 00A → 00B → 00C bundle and the current shipped Plan 01/Terra facts; its status is a static `RUNTIME STATUS EXTERNAL — run the committed Plan 00 status command`, never a copied HOLD/DONE value. The EP success policy records this provenance file as `plan00_tracked_bundle_provenance`. This plan is the sole source-controlled materialisation owner; later evidence commands do not rewrite tracked status.

## A1 — audit prompt rendering and atomic provider routing

- Exercise real snapshot builders and both OpenAI request modes. Pin block order and exact text for base + stable prefix + volatile tail, string/empty inputs, implicit instructions, explicit developer-input breakpoint and both flag variants.
- Preserve `SYSTEM_BLOCK_SEPARATOR = "\n\n"`; do not reconstruct undocumented Anthropic bytes. Assert the stable prefix never abuts `EXTRACTED`, `PENDING` or another volatile heading, explicit cache metadata never reaches Anthropic blocks, and the OpenAI cache breakpoint remains before volatile state.
- Record pre/post rendered tokens and emitted request shape. Material reordering, deletion or cache-prefix movement is a blocker.
- Use the shipped resolver as the sole provider truth. Cover Luna and Haiku defaults; same-provider Luna/Terra round-one override; both cross-provider override directions failing before SDK dispatch; Luna→Terra observation Standard via omitted request `service_tier`, low effort and no round-one override; legacy Anthropic observation; unknown model/missing client; and supported changes between user turns without client recreation.
- Enumerate every production selection site with `rg` and prove it reaches `resolveExtractionTarget()` or the whole-loop fence. Preserve and audit the existing four-minute `_sendCacheKeepalive()` plus paused-session 15-minute budget byte-for-byte. Only the proposed 25-minute retention/re-warm policy belongs to later Plan 01 supplement work; compaction is expected to remain absent.

## A2 — truthful per-round usage, cost and counters

Extend existing `CostTracker`, family buckets and economics rather than building a second ledger.

- Preserve genuinely returned OpenAI model/tier before adapter fallback coalescing. Each `round_usage` row carries provider, requested model/tier, raw nullable response model/tier, billing model/tier, separate provenance, fresh/cache-read/cache-write/output tokens and `round_idx` correlated with existing timing.
- Provenance: model `returned|request_implied_model`; tier `returned|request_implied_standard|unavailable_for_provider`. OpenAI Standard may omit tier; requested Fast + returned `priority` is equivalent; a versioned model alias is valid only within the same provider/family.
- The billing provider is always the SDK transport. Same-provider metadata contradictions are `validation_error`; cross-provider-looking/unknown identifiers enter `unattributed_provider_usage` under the transport provider at a conservative requested-transport rate and never another provider's bucket.
- Evaluation lanes treat contradictions as verdict-fatal. Live production never aborts, retries or changes extracted/audible output for a metadata contradiction: record telemetry, bill conservatively and let the turn finish. Pin this behaviour.
- Mint one stable `extractionTurnId` at the authoritative extraction harness/ingress before choosing live, shadow or legacy. Pass it unchanged to every sibling leg; when supplied, legacy must not replace it with `legacy-${randomUUID()}`.
- Inventory every production `addSonnetUsage()` caller with `rg`, including `_sendCacheKeepalive()` and `reviewForOrphanedValues()`. Split APIs:
  - `recordInspectorExtractionTurn(sessionId, extractionTurnId)` increments public `sonnet.turns` once across cancelled generations and live/shadow/legacy twins;
  - `ingestBillableUsage(loopInvocationId, roundUsage, kind)` owns token/cost, `loop_invocations` and `completed_model_rounds` only.
- Live billing invocation identity is `(sessionId, extractionTurnId, generationId)`; each shadow/legacy loop gets its own opaque billing id. Migrate the existing `_sendCacheKeepalive()` to `kind:cache_keepalive` and orphan review to `kind:orphan_review`; both retain provider-reported cost/round counters but never call `recordInspectorExtractionTurn()`. Keep any other non-inspector class separate.
- Mint one opaque `nonInspectorInvocationId` immediately before every actual `_sendCacheKeepalive()` or `reviewForOrphanedValues()` SDK dispatch. Reuse that id across that dispatch's success/error/finally accounting, but mint a new id for every later timer/review firing. A usage-bearing response increments billable cost, `loop_invocations` and `completed_model_rounds` once; pre-response failure increments none; neither path records an inspector turn.
- Expose a monotonic `usageRevision` and `inFlightBillableInvocationCount` on the session cost authority. The count represents active accounting scopes, not HTTP/model rounds: increment exactly once per unique `loopInvocationId` immediately before its first SDK dispatch, keep it positive across every round, dispatcher continuation, cancellation/error path and caller-side usage ingest, and decrement exactly once in that invocation's caller `finally` only after all returned/attached round usage is ingested. Each cache-keepalive and orphan-review call is its own one-dispatch accounting scope with the same one-in/one-out rule. `completed_model_rounds` alone counts completed SDK rounds. Advance `usageRevision` at scope start, every usage mutation and final decrement. Plan 00B's dormant lifecycle observer may read these values but cannot mutate them.
- `runToolLoop()` returns completed round usage/round count on success and attaches the same data and billing identity to propagated failures after billed responses. Live/shadow callers ingest once from `finally`; replace both aggregate billing sites while preserving distinct shadow legacy cost.
- SDK-owned HTTP retries are not observable on current production clients. Name the metric `completed_model_rounds`, not API attempts; add `http_attempts` only if a real retry observer is later introduced.
- Derive `estimateModelUsageEconomics()` and `stage6_live_extraction` model/tier telemetry from per-round evidence so mixed-model logs and cost agree.
- Actual cached cost uses fresh input, cache reads, cache writes and output at their applicable dated rates; also report a no-cache counterfactual. Verify rates against official provider pricing at execution time and store retrieval date/source without rewriting historical reports.
- Keep evidence PII-free: opaque ids, provider/model/tier, tokens, timings, status and error class only.

Required RED/positive cases include normal multi-round completion; later-round cancellation; dispatcher failure after billed response; transport failure before usage; duplicate normal/finally ingest; two generations sharing one inspector turn; live+shadow+legacy siblings sharing one turn; the real four-minute keep-alive and orphan-review callers; Standard omitted tier; Fast/priority; versioned alias; same-provider/cross-provider/unknown contradictions; and an additional synthetic non-utterance kind. A fake-clock test fires two consecutive keep-alives including paused-budget operation: two distinct billable invocations/rounds and summed cost, zero public turns, with duplicate finally ingestion idempotent. Prove a two-round loop transitions `0→1→1→0`, a later-round billed failure still decrements only after ingest, and concurrent loop invocations transition `0→1→2→1→0`; cache-keepalive and orphan-review scopes obey the same rule, no eligible freeze precedes final decrement, and no positive count leaks.

## A3 — Responses tool-result parity

Drive real dispatcher results through `runToolLoop()` and `openai-responses-adapter.js`. For every model-visible case assert the production body, exact call id, exact JSON string in the next Responses request and required next Luna action—corrected tool call or `end_turn`; add no retry wrapper or synthetic OpenAI `is_error`.

Model-visible cases:

- success write/ask/result;
- no-op/skipped and `answered:false`;
- correction such as `did_you_mean` / `invalid_value`;
- repeated address-mirror claim exact body `{"answered":false,"reason":"address_mirror_not_claimed","disposition":"already_asked"}` with no duplicate ask;
- answered address mirror with `answered:true`, real outcome, `changed_fields` and `source_replay_count`;
- invalid tool JSON with real call id;
- thrown dispatcher error using existing `dispatcher_error` body;
- internal/no-result defensive envelope.

Server-only terminals—loop cap, cancellation/abort, orphan delta without real call id and pre-result transport failure—must terminate/log without pretending to send a tool result. Keep model text/payloads out of telemetry. A-pre owns the initial credit gate. Here, after implementation, run minimal paced live Responses probes for representative success, correction and end-turn behaviour; if credit becomes temporarily exhausted now, retain the implemented worktree under the same-claim wait. Add the distinct clean-worktree A-pre wait and later implemented-worktree probe wait to the verification checklist.

Temporary provider-credit exhaustion uses canonical EP's plan-declared wait inside the **same claimed 00A run**: `CREDIT_WAIT_MAX=24h`, claim heartbeat every 15 minutes, and provider retry at the returned reset time (or bounded exponential backoff when the reset header is absent). Treat `429`/`rate_limit_exceeded` as temporary. Treat explicit `account_disabled`, `billing_disabled` or `insufficient_quota` as hard-disabled immediately; a temporary-class error becomes hard-disabled at 24 hours. Retain the worktree, persist the exact missing probes/next check and validate claim ownership after every wake; do not finalise, write `.ep-done`, open a draft PR or emit success while waiting. After reset, the same run completes the probes, full gate, independent diff review, merge and deploy, then writes 00A's own `.ep-success.json` with `plan00_tracked_bundle_provenance`. On hard-disabled, this EP run records a HELD hard-disabled outcome, emits no success record, ensures its PR is not mergeable, writes the exact missing probes/error and replacement requirement to the execution log, and stops; it must not author or modify any final or policy. A later explicitly invoked RP run, outside this EP execution, creates and reviews a new replacement-00A final, updates 00B's `requires_success.plan` to that exact final, republishes the bundle through the umbrella's disabled-00A activation sequence, and only then exposes the replacement EP command. The superseded run/PR can never satisfy or be merged around that dependency; only the replacement final's own EP may merge, deploy and emit the exact success record 00B awaits.

## Verification and delivery

At minimum:

```bash
npm test -- --runInBand \
  src/__tests__/model-provider-routing.test.js \
  src/__tests__/openai-responses-adapter.test.js \
  src/__tests__/stage6-tool-loop.test.js \
  src/__tests__/stage6-observation-tier-routing.test.js \
  src/__tests__/cost-tracker.test.js \
  src/__tests__/cost-tracker-streaming.test.js
npm run replay:field-corpus:prepush
npm test
```

Update architecture/deployment/changelog and dated cost references for actual changes. Deliver through the normal PR-only workflow. Preserve Luna Fast, explicit cache, Terra Standard/low and empty round-one override. Zero client/wire change is expected; if discovered, stop and add both client halves before delivery.

## Acceptance

- Shipped provider/prompt/cache/observation contracts are verified without duplicate implementation.
- Cross-provider continuation fails before network dispatch; same-provider routing is covered.
- Every model-visible tool-result class has byte-level adapter coverage and representative live probes behave; a temporary credit wait leaves the same run claimed, while hard-disabled credit terminates held and cannot emit success or unlock 00B.
- Provider-reported usage/cost is per round and exactly once; inspector turns, loop invocations, model rounds and non-inspector calls are distinct truthful counters.
- Live metadata anomalies never silence or change a successful inspector turn.
