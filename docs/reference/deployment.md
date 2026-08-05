> Last updated: 2026-08-03
> Related: [Architecture](architecture.md) | [iOS Pipeline](ios-pipeline.md) | [Field Reference](field-reference.md) | [File Structure](file-structure.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# Deployment & Troubleshooting

## Local Node version (match CI)

**Use Node 20 for local work.** CI pins Node 20 (`.github/workflows/deploy.yml` `node-version: '20'`, 4 sites); the repo-root `.nvmrc` = `20` records that pin for nvm users (`nvm use` at the repo root). The `web` workspace also declares `"engines": { "node": ">=20 <21" }` and a WARN-level preflight (`web/scripts/check-node.mjs`, wired as `pretest`) that fires on every `npm test --workspace=web` and in `.husky/pre-push`.

Why it matters: jsdom / Storage / experimental-webstorage behaviour differs across Node majors. Running the web vitest suite on a different major (e.g. v25) can pass locally while failing on CI's Node 20 — this is exactly what bit WS7 (the conditional `localStorage` shim in `web/tests/setup.ts`). The preflight is **warn-only** (exits 0) so it never blocks unrelated work or a GUI-git push; set `CHECK_NODE_STRICT=1` to make a mismatched major hard-fail. For an exact-patch pin, bump `.nvmrc` and `deploy.yml` to the same `20.x.y` in one commit.

## Deploy Changes to Cloud

The production site runs at **https://certmate.uk**. Delivery is PR-only: commit on a topic branch, open and merge a PR after required checks pass, then GitHub Actions builds and deploys the ARM64 images to ECS. Do not use the local `deploy.sh`, direct ECR pushes, or out-of-band ECS task-definition registration. A backend rollout is normally about 30 minutes end-to-end.

### Luna Fast field trial — rollback and verification

- **Active:** `SONNET_EXTRACT_MODEL=gpt-5.6-luna`, `OPENAI_EXTRACT_SERVICE_TIER=fast`, and `OPENAI_EXTRACT_PROMPT_CACHE=explicit` in `ecs/task-def-backend.json`.
- **Luna Standard rollback:** set `OPENAI_EXTRACT_SERVICE_TIER` to `standard`, commit, merge, and let CI redeploy. This omits `service_tier` while retaining the same model.
- **Prompt-cache rollback:** set `OPENAI_EXTRACT_PROMPT_CACHE=implicit`, commit, merge, and let CI redeploy. This restores top-level `instructions` and OpenAI's implicit breakpoint without changing model, reasoning, tools, or Fast tier.
- **Model rollback:** restore `SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001` separately. Leaving the Fast variable present is harmless because only the OpenAI Responses adapter reads it.
- **Verify:** after rollout, inspect `stage6_live_extraction`; `model` must be `gpt-5.6-luna` or a dated alias of it (`gpt-5.6-luna-*` — the field reports the RETURNED billing model, which the provider may version-stamp; the pinned request id lives in `prompt_cache_rounds[].requested_model`), `service_tier` should be `priority` (OpenAI's response label for Fast), and each `prompt_cache_rounds[]` entry should show `provider:"openai"`, requested/response/billing model and tier, `attribution_status:"attributed"`, `prompt_cache_mode:"explicit"`, `prompt_cache_breakpoint_enabled:true`, plus a non-null digest-only `prompt_cache_key_id`. The first call may write; repeated stable-prefix calls should move tokens into `cache_read_input_tokens`. Any `usageValidationErrors`/`unattributedProviderUsage` evidence is operationally significant but must not change that turn's certificate writes or speech. At session end, `cost_summary.json` → `sonnet.cacheEconomics` shows actual cost, no-cache counterfactual and net saving (negative is valid until cold writes amortise).
- **Verify pricing separately from cache mechanics:** `CostTracker` is pinned to OpenAI's [short-context API prices](https://developers.openai.com/api/docs/pricing), effective 2026-07-30 and last verified 2026-08-03. Luna Standard is `$0.20/$0.02/$0.25/$1.20` and Fast is `$0.40/$0.04/$0.50/$2.40` for fresh input/cached input/cache write/output per million tokens; Terra Standard is `$2.00/$0.20/$2.50/$12.00`. Anthropic fallback rates were independently verified the same day against the official [Claude pricing reference](https://docs.anthropic.com/en/docs/about-claude/pricing): Haiku 4.5 is `$1/$0.10/$1.25/$5` and Sonnet 4.6 is `$3/$0.30/$3.75/$15` for fresh input/cache read/five-minute cache write/output. On any provider price announcement, verify the live official pages and changelogs, update all four buckets for every affected tier, and pin one dated field-session raw-usage fixture. Do not infer price correctness from cache hit percentages.
- **Provider safety:** every extraction surface resolves model + SDK together. Missing keys, unknown providers and cross-provider round-one overrides fail before the first API request; there is no GPT-via-Anthropic fallback.
- **Tool-result parity probe:** the 2026-08-03 post-implementation Luna Fast probe passed all three paced cases against the real Responses endpoint: success tool → `end_turn` (2 rounds), `did_you_mean` → corrected tool → `end_turn` (3 rounds), and direct `end_turn` with no tool (1 round). Every round requested `gpt-5.6-luna`/`fast`, returned `gpt-5.6-luna`/`priority`, and was fully attributed. Repeat these PII-free protocol cases after any adapter or tool-loop continuation change; do not log prompts, model text or dispatcher payloads.

### Loaded Barrel audible-value telemetry

After the matching iOS build is installed, the authoritative cohort row is `voice_latency.turn_perceived_latency_ms`: `ack_audio_source` distinguishes `loaded_barrel_hit*` from `legacy_confirmation`/`confirmation`, and `ios_playback_ack_correlation_id` joins back to the synthesis ledger. Example CloudWatch Logs Insights query:

```text
fields @timestamp, sessionId, turnId, perceived_latency_ms,
       ack_audio_source, ios_playback_ack_correlation_id
| filter @message like /voice_latency.turn_perceived_latency_ms/
| filter ispresent(ios_playback_ack_correlation_id)
| stats count(*) as heard, pct(perceived_latency_ms, 50) as p50_ms,
        pct(perceived_latency_ms, 75) as p75_ms,
        pct(perceived_latency_ms, 95) as p95_ms by ack_audio_source
| sort heard desc
```

For one correlation, filter `voice_latency.outcome` rows by `correlation_id`. A real audible join ends with `outcome="playback_started"` and `acked_by_ios=1`; `loaded_barrel_hit*` without that terminal is a claimed-but-unheard clip and must not be counted as latency saved.

`turn_perceived_latency_ms` is intentionally a **first-audible-per-turn** row. Multi-reading turns can play several later clips after that row is complete. The canonical `voice_latency.late_playback_ack` and same-correlation `playback_started` rows retain those later playback facts, while a 60-second completed-summary tombstone prevents them from being misreported as `turn_perceived_latency_skipped { reason:"late_ack_without_summary" }`. That skip reason is therefore reserved for a late ACK whose turn genuinely never produced an audio summary.

### Observation-tier routing — flip & rollback (`OBSERVATION_TIER_ROUTING`)

The observation-tier model router is ACTIVE for Derek's sole-tester field trial: `ecs/task-def-backend.json` sets `OBSERVATION_TIER_ROUTING=true`, `OBSERVATION_EXTRACT_MODEL=gpt-5.6-terra`, `OPENAI_OBSERVATION_SERVICE_TIER=standard`, and `OPENAI_OBSERVATION_REASONING_EFFORT=low`. Ordinary readings remain on Luna Fast. Activation and rollback are source edits plus CI redeploy — never a live `aws ecs` mutation:

- **Trial scope:** Derek is currently the only tester and is validating through iOS, whose observation-processing cue is already live. The missing web cue (parity-ledger `recording/observation-processing-cue`) is explicitly waived for this trial, not reclassified as parity: broader/multi-user use still needs the web companion.
- **Rollback:** change it back to `"false"`, commit, merge, redeploy. This restores byte-identical pre-C1 behaviour with no other change.
- **OpenAI observation policy:** Terra is source-pinned to Standard/low, preventing the global Luna Fast setting from leaking onto observations. Raise reasoning effort only after a concrete quality miss; do not use Fast for observations during this baseline.
- **Verify the seam is active** post-flip: `aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m | grep observation_tier_routing` — the `stage6.observation_tier_routing` event carries `{classifier_match, flag_enabled, selected_model, selected_provider, default_model, round1_override_locked}` (PII-safe, no transcript). `flag_enabled:true`, the expected model and its matching provider prove the router fired. The P8 live probes REQUIRE this evidence (they must run against the observation-tier path; probes on the default model validate the wrong route).

### Check Cloud Status
```bash
# Service status (both frontend and backend)
aws ecs describe-services --cluster eicr-cluster-production --services eicr-frontend eicr-backend --region eu-west-2 --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" --output table

# View frontend logs
aws logs tail /ecs/eicr/eicr-frontend --region eu-west-2 --since 10m

# View backend logs (job processing)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m
```

### Parity-ledger staleness warning (PR-only, warn-only)

`.github/workflows/deploy.yml` job `parity-ledger-warn` (added 2026-07-02, WS1 of the iOS↔Web Full-Parity Program):

- Runs ONLY on `pull_request` events (`if: github.event_name == 'pull_request'` — on push/dispatch `github.base_ref` is empty and the diff would error-annotate every deploy run).
- Computes the PR's touched files (`git diff --name-only origin/${{ github.base_ref }}...HEAD`, checkout with `fetch-depth: 0`) and runs `node scripts/check-parity-ledger.mjs --ledger web/docs/parity-ledger.md --map web/docs/parity-ledger-files.json --changed-files …`.
- Emits GitHub `::warning::` annotations when a touched file maps (via `web/docs/parity-ledger-files.json`) to ledger rows whose `last-verified` is blank, invalid, or >30 days old. Blank-dated rows collapse into ONE summary line; a map id missing from the ledger and duplicate ledger ids also warn.
- **Never blocks anything:** the script always exits 0, the job has `continue-on-error: true`, and no other job `needs:` it. Touched files with no map entry are silently ignored by design.
- To silence a warning properly: re-verify the row against current iOS source and update its `last-verified` date in `web/docs/parity-ledger.md`.

### Field-replay corpus gate (accident-class; blocking; 2026-07-17)

The field-replay correctness gate replays real captured field sessions through the real `runShadowHarness` so a fix must pass its captured transcript before merging — full detail in [field-replay-corpus.md](field-replay-corpus.md).

- **Blocking (per-PR):** `npm run replay:field-corpus` runs as a step INSIDE `Test Backend (Node.js)` (so it rides the merge-blocking required check). This is the WHOLE blocking gate: each `expected_red` fixture must fail with exactly its target id, each `required_green` must pass. `test-backend` checks out `fetch-depth: 0` on the pinned Node `20.20.2`. An empty corpus exits 0. A `manual-deploy-gate` job closes the old `workflow_dispatch` bypass: a production dispatch requires `refs/heads/main` and runs the corpus before `build-images`.
- **Local backstop:** `.husky/pre-push` runs `replay:field-corpus:prepush` (XPASS-tolerant, fail-closed on any unexplained failure). Node-20 CI is authoritative.
- **Deferred (`field-replay-hardening-followups`):** signed-commit governance, trusted-run evidence + `ci-history-checks` history closure, the nightly live lane (`ANTHROPIC_API_KEY` + protected environment), and the per-fixture signed attestation are the malice-hardening the threat model defers; they were built in the original foundation and removed from the shipping gate.
- **Delivery is PR-only** — the hub auto-push rule is auto-PR-then-`gh pr merge` (Derek, 2026-07-16).

## Plan 00C — Stage-A evidence operator commands (2026-08-05)

Post-deploy, the Plan 00 three-day evidence gate is driven ONLY by the committed
operator commands (never a second `/ep`; `.ep-done` has no evidentiary weight):

```bash
# After the merge deploy goes green — verifies the trusted GitHub run (deploy JOB
# conclusion, never rolloutState), the live ECS/ECR runtime identity and the
# task-role manifest-prefix proof, then publishes stage_a_deployed:
node scripts/plan00-evidence/cli.mjs publish-stage-a --run-id <deploy-run-id> --head-sha <merge-sha>

# Interactive Derek-namespace commands (TTY-gated; automated runners cannot invoke):
node scripts/plan00-evidence/cli.mjs attest-expectations
node scripts/plan00-evidence/cli.mjs init-cohort            # -> HOLD_EVIDENCE 0/3
node scripts/plan00-evidence/cli.mjs bind-session --session-id <sid>   # fingerprint derives from stage_a_deployed
node scripts/plan00-evidence/cli.mjs attest-daily --session-ids <sid> --confirmation-session <sid>   --confirmation-ref '<op_key>' --heard true --result pass
node scripts/plan00-evidence/cli.mjs attest-dialogue-hearing --session-id <sid> --delivery-ref d:N   --heard true --result pass
node scripts/plan00-evidence/cli.mjs decide-mismatch --mismatch-id <id> --decision approved|rejected
node scripts/plan00-evidence/cli.mjs decide-corpus-gap --target <manifest-named-non-safety-stratum> --decision approved|rejected
# (Whole attested fixtures can NEVER be deferred — unclassified targets
#  default to safety-critical.)

# Evidence runners (machine namespace; reservation-guarded, exactly-one terminal).
# NOTE: these currently REFUSE — before allocating or reserving anything —
# because the enumerated 00B lane machinery is mock/replay-only and mock
# verdicts must never enter the evidence store. The runner protocol is
# complete and test-pinned; a reviewed 00B successor wires real live
# dispatch (surfacing provider response ids) in.
node scripts/plan00-evidence/cli.mjs run-ir --fixture <corpus-id>
node scripts/plan00-evidence/cli.mjs run-corpus --lane haiku|luna

# Status: version-audited fold + fresh live ECS drift check; regenerates the
# handoff-local PLAN-00-EVIDENCE.{json,md} projections (never the tracked index):
node scripts/plan00-evidence/cli.mjs status
```

A failed deploy or defective publisher blocks attestation/cohort initialisation
and requires a fresh fix-forward handoff/PR. A missing task-role prefix grant is
remedied by a source-committed IAM fix (never a live edit) and starts a new
prospective cohort. Later behaviour-changing latency plans call `status` and stay
blocked until it returns DONE against a matching live deployment.

## Deployment State (Jan 2026)

- PWA Frontend: `eicr-pwa` service running on ECS Fargate
- Backend: `eicr-backend` service running on ECS Fargate
- Streamlit: Stopped (can re-enable via `aws ecs update-service --service eicr-frontend --desired-count 1`)

---

## Debug Job Processing Issues

If "Upload & Process Job" fails, check the backend logs in a new terminal:
```bash
# Watch backend logs in real-time (run in separate terminal)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --follow

# Check backend API health
curl https://certomatic3000.co.uk/api/health

# Check target group health
aws elbv2 describe-target-health --target-group-arn "arn:aws:elasticloadbalancing:eu-west-2:196390795898:targetgroup/eicr-tg-backend/be5fa4d15b55fc3d" --region eu-west-2 --query 'TargetHealthDescriptions[*].TargetHealth.State'

# Check for OOM (out of memory) kills
aws ecs describe-tasks --cluster eicr-cluster-production --tasks $(aws ecs list-tasks --cluster eicr-cluster-production --service-name eicr-backend --desired-status STOPPED --region eu-west-2 --query 'taskArns[0]' --output text) --region eu-west-2 --query 'tasks[0].containers[0].{ExitCode:exitCode,Reason:reason}'
```

## Common Issues & Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `Backend API error: Expecting value: line 1 column 1` | Empty response from backend | Check ALB timeout (should be 600s), check for OOM kills |
| `ENOENT: no such file or directory, scandir .../output` | Output folder was renamed | Fixed in `api.js` - uses `result.finalOutDir` |
| `OutOfMemoryError: Container killed` (exit code 137) | Backend needs more RAM | Task definition uses 2048MB memory |
| Job stuck on "Transcribing audio" | Gemini API hanging/overloaded | Restart backend: `aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2` |
| Job stuck on "processing" in dashboard | Dashboard doesn't auto-poll | Fixed: Dashboard now polls every 5s when jobs are processing |
| Job data empty in PWA editor | API expects `extracted_data.json` but pipeline creates separate files | Fixed: API now reads from individual files as fallback |
| PWA container health check failing | Alpine image missing wget | Fixed: Removed container health check, using ALB health check only (task def revision 6+) |
| ECS not pulling new Docker image | Task definition caches image digest | Force new task definition: `aws ecs register-task-definition` then update service |
| Jobs not appearing in dropdown | Frontend not reading from S3 | `get_output_directories()` and `load_job_file()` now use S3 in cloud mode |
| Circuit data empty/missing after load | CSV not loading from S3 | Fixed: `load_job_csv()` function added with S3 support |
| Circuit values misaligned in editor | CSV column names don't match editor | Fixed: `map_circuit_columns()` maps CSV→editor column names |
| `KeyError: circuit_designation not in index` | Missing required columns | Fixed: Editor now creates missing columns with defaults |
| PDF generation fails with path error | Trying to write to local path in cloud | Fixed: Uses temp file in cloud mode, uploads to S3 |
| Job appears with timestamp ID not address | S3 key used job ID instead of address | Fixed: `api.js` now uses `result.address` for S3 folder name |
| `Failed to fetch` on login | Backend DATABASE_URL not set | Fixed: `secrets.js` now loads `eicr/database` secret and constructs DATABASE_URL |
| `Failed to fetch` - PWA calls localhost | `.env.local` copied into Docker image overrides env var | Fixed: `Dockerfile.pwa` removes `.env.local` before build |
| PWA 503 / health check failing | `wget --spider` doesn't follow redirects, `/` redirects to `/login` | Fixed: Health check now uses `wget -O /dev/null http://localhost:3000/login` |
| Database secret JSON parse error | Password contains backslash escape | Fixed: Updated `eicr/database` secret with unescaped password |

## Bug Fix History

Historical bug fixes (January-February 2026) have been archived. See `docs/plans/archive/CLAUDE_FIX_HISTORY.md` for the complete history of all 28 fixes including:
- Duplicate job fixes, S3 path mismatches, data transformation fixes (Jan 2026)
- Linked observations, synchronized photo capture, security plugins (Jan 2026)
- CCU photo BS/EN extraction, job save duplicate/timestamp fixes (Feb 2026)
