---
name: certmate-debugging-playbook
description: >
  Symptom-to-triage table for CertMate/EICR_Automation's KNOWN failure modes. Load this
  FIRST whenever you are debugging a live symptom in this repo: login bounces to /login,
  Swift "The data couldn't be read", values flipping to [REDACTED], Circuits tab empty,
  tests green locally but red in CI, cost tracker showing zeros, WebSocket readings
  silently not landing, "all phases hallucinated" verdicts, "can't assign requested
  address" network errors, or ANY recurring symptom you are about to fix for the 3rd+
  time. Do NOT load for: writing new features, historical why-was-this-built questions
  (use certmate-failure-archaeology), latency tuning (use certmate-latency-campaign),
  or test-methodology questions (use certmate-validation-and-qa).
---

# CertMate Debugging Playbook

All paths repo-relative to the EICR_Automation repo root. All facts date-stamped where volatile; verified against the repo as of 2026-07-06.

**Discipline:** run the FIRST DISCRIMINATING CHECK before proposing any fix. Every row below encodes a real incident where the obvious hypothesis was wrong and the check would have saved hours. If your symptom matches a row, the row's root-cause class is the DEFAULT explanation — prove it wrong before exploring alternatives.

## Quick triage table

| # | Symptom | First discriminating check | Root-cause class | Fix pointer |
|---|---------|---------------------------|------------------|-------------|
| 1 | PWA login accepted then bounces back to `/login` | `aws ecs describe-task-definition --task-definition eicr-pwa --region eu-west-2 --query 'taskDefinition.containerDefinitions[0].secrets'` — is `JWT_SECRET` present? | Env var / secret dropped from live task def | §1 |
| 2 | Swift: "The data couldn't be read because it is missing" | Capture the actual JSON payload; diff its keys/nullability against the iOS Codable struct | Decoder mismatch (backend schema drift) — ALWAYS, never a Swift bug | §2 |
| 3 | Address/client fields showing literal `[REDACTED]` | `node scripts/audit-redacted-job-addresses.js` | Live-ref mutation by a "safe" helper (logger redaction) | §3 |
| 4 | Circuits tab empty for an older single-board job | In DB/S3 payload: is the circuit's `board_id` `null`/`undefined`/`''`? | Unscoped board id treated as non-matching | §4 |
| 5 | Web tests green locally, red in CI (or pass isolated, fail full-run) | `node -v` vs `cat .nvmrc`; then run the failing file alone vs full suite | Node-major divergence / harness leak / storage-shim gap | §5 |
| 6 | Cost tracker shows zeros for a model tier that was used | Grep the code path for where `usage` is read off the API response — is it wired at all? | Wire-up bug, NOT "no traffic" | §6 |
| 7 | Agent/worker output looks like "all phases hallucinated" | `git -C <expected-repo> diff --stat` (or `git log -3`) in the repo the worker SHOULD have touched | Wrong-repo diffing (default explanation), not hallucination | §7 |
| 8 | `dial tcp ...: connect: can't assign requested address` on every outbound call | `netstat -an \| grep -c TIME_WAIT` (>10k = confirmed) | Ephemeral-port exhaustion from tight HTTP polling | §8 |
| 9 | Voice reading confirmed by backend but never lands in the client UI | Compare the field name the backend EMITS vs the name the client DISPATCHES on (see §9 commands) | Canonical-vs-legacy field-name mismatch → silent switch-miss drop | §9 |
| 10 | Job permanently fails to sync (PUT rejected every time) | Backend logs for board-hierarchy validation errors on the PUT path | Validator rejecting instead of repairing (fixed 2026-06-12; regression class) | §10 |
| 11 | A live-applied env var / behaviour silently reverts days later | `./scripts/check-task-def-env-drift.sh eicr-backend ecs/task-def-backend.json` | Out-of-band AWS edit stripped by next CI `register-task-definition` | §11 |
| 12 | A `NEXT_PUBLIC_*` flag is set but the deployed web app ignores it | `grep -n "NEXT_PUBLIC" docker/nextjs.Dockerfile` — is the var declared as ARG+ENV? | Build-time inlining: undeclared NEXT_PUBLIC vars silently dropped at `next build` | §11 |
| 13 | A page/component collapses to a sliver, or any "Safari/framework quirk" CSS theory | Pull `getComputedStyle` from the live DOM (Chrome DevTools/MCP) for the failing element FIRST | Token collision / real input value, not a browser quirk | §M2 |
| 14 | Fresh job page shows blank data after a transient network failure, then saves blank over real data | Check the hydration gate: `grep -n isHydrated web/src/lib/job-context.tsx` — auto-seeders must not run pre-hydration | Auto-seed-over-unhydrated-state data loss (fixed `851ba63e` 2026-07-03) | §12 |

---

## §1 Login bounces to /login (JWT_SECRET / task-def)

**Incident:** 2026-04-19, TWICE in one day. `JWT_SECRET` missing from the `eicr-pwa` ECS task def → web middleware **fails closed in production** (`web/src/middleware.ts`, commit `a1815098`): with `NODE_ENV=production` and no `JWT_SECRET`, every cookie is treated as unauthenticated → redirect to `/login`. Hotfix #1 added the secret live; hours later a local `deploy.sh` re-registered the task def WITHOUT it → bounce #2. Permanent fix `c918b88a` put it in source: `ecs/task-def-frontend.json` (the `secrets` block, Secrets Manager ARN) — verify with the check in the table.

Checks, in order:

```bash
# 1. Is JWT_SECRET on the LIVE task def?
aws ecs describe-task-definition --task-definition eicr-pwa --region eu-west-2 \
  --query 'taskDefinition.containerDefinitions[0].secrets' --output table

# 2. Is it in SOURCE (if not, any deploy will drop it again)?
grep -n "JWT_SECRET" ecs/task-def-frontend.json

# 3. Middleware warning in frontend logs?
aws logs tail /ecs/eicr/eicr-pwa --region eu-west-2 --since 30m | grep -i "JWT_SECRET"
```

Also required: the ECS **execution role** needs `secretsmanager:GetSecretValue` on the secret ARN, or the task fails to start with the secret.

**Web-side variant (2026-07-02):** login rejected users whose `company_id` is `null` — the Zod schema lacked `.nullable()`. Fixed in `web/src/lib/adapters/auth.ts:26`. If login fails for a SPECIFIC user while others work, suspect a schema/nullability mismatch, not auth infra.

**Fix rule:** the canonical change is ALWAYS the source template (`ecs/task-def-frontend.json`) + commit, never a live AWS edit (see §11 and CLAUDE.md "Infrastructure changes must come from source").

## §2 Swift "The data couldn't be read because it is missing"

**Rule (from the project's incident record): this message is ALWAYS a decoder mismatch** — the backend emitted a shape iOS's `JSONDecoder` can't decode (a newly-null field, a missing key, a type change). It is never a Swift/framework bug. Recorded incident: a payload shaped like `{circuit_number: null, is_rcd_device: true}` broke decoding on every split-load board (pre-2026-02-23 history; the repo's git history starts at the 2026-02-23 baseline, so the commit itself is not retrievable — the lesson is retained in the project mistakes record).

Checks:

```bash
# Capture the real payload (backend side):
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 15m | grep -i <endpoint-or-field>
# Then diff its keys + null-ability against the iOS Codable struct in
# CertMateUnified/Sources/ (separate nested git repo — iOS is canon for the data contract).
```

Fix direction under change control: during parity work the backend is IMMUTABLE — if the backend shape is correct per iOS canon, fix the client decoder; if the backend genuinely drifted, that is a cross-platform escalation, not a quiet patch. Related web analog: §1's `.nullable()` case.

## §3 `[REDACTED]` values appearing in real data (live-ref mutation class)

**Incident (P0, prod, 2026-05-27):** address/postcode/client name/phone/email flipped to the literal string `[REDACTED]` after opening a job, corrupting S3 `extracted_data.json` AND the `jobs.address` DB column. Root cause: `redactPiiInPlace` in `src/logger.js` mutated the LIVE object the route handler was about to serialize — the GET handler logged `installation_details` directly, the redactor scrubbed it in place, the client received redacted data and persisted it back on next auto-save. Fix: copy-on-write redaction (`5bf304ac`) + stop logging live refs in the route (`d5adb2e3`).

Checks:

```bash
node scripts/audit-redacted-job-addresses.js     # finds corrupted jobs + recovery path
grep -n "redactPiiInPlace" src/logger.js          # confirm copy-on-write comments intact
```

**Generalize the class:** any "harmless" helper (logging, sanitizing, formatting) that receives a reference to live state and mutates it. If a value corrupts AFTER a read-only operation (viewing a page, logging), suspect an in-place mutation in the read path. Discriminating experiment: log `JSON.stringify(obj)` immediately before and after the suspect helper call at the call site.

## §4 Circuits tab silently empty on legacy jobs (unscoped board id)

**Incident (2026-05-28):** PWA Circuits tab rendered empty for legacy single-board jobs. Circuits created before multi-board support have `board_id` of `null`/`undefined`/`''`; a strict `c.board_id === selectedBoardId` filter excludes all of them. Fix: treat those three values as "unscoped = belongs to any board" via `isUnscopedBoardId(id)`.

Live locations (as of 2026-07-06): `web/src/app/job/[id]/circuits/page.tsx:296` and `web/src/lib/recording/apply-ccu-analysis.ts:65` (used at ~8 call sites).

Check:

```bash
grep -rn "isUnscopedBoardId" web/src --include="*.ts" --include="*.tsx"
# If you are writing ANY new board_id filter: reuse this helper. A bare === comparison
# on board_id is the regression vector.
```

## §5 Green locally / red in CI web tests (the WS7 class)

Three independent sub-causes, all real incidents. Check in this order:

**(a) Node major divergence.** CI pins Node 20 (`.nvmrc` = 20, 4 pin sites in `.github/workflows/deploy.yml`); the dev box runs a newer major. jsdom/Storage behaviour differs by major.

```bash
node -v && cat .nvmrc
CHECK_NODE_STRICT=1 node web/scripts/check-node.mjs   # hard-fails on mismatch (normally WARN-only)
```

**(b) Storage-shim gap (the original WS7 bug, fixed 2026-07-03).** jsdom's real `Storage` can pass a `getItem` capability guard yet **silently ignore per-instance overrides** like `localStorage.setItem = () => { throw ... }` — so persist-failure tests saw writes succeed locally and failed only in CI. Fix: `installStorageShim` in `web/tests/setup.ts` installs a Map-backed shim UNCONDITIONALLY (lines 54-94). Never override storage methods by direct assignment in a test — use `vi.spyOn`. Never stub `fetch` by assignment — use `vi.stubGlobal`.

**(c) Harness leak (order-dependent failures).** `web/vitest.config.ts` sets `restoreMocks`/`clearMocks`/`unstubGlobals`/`unstubEnvs`/`isolate` all true (they default false in vitest) and `web/tests/setup.ts` has a global `afterEach(vi.useRealTimers())` (the config flags do NOT restore fake timers). `web/tests/harness-leak-lock.test.ts` is the regression guard.

```bash
# Discriminating check for a leak: isolated vs full-run
npx vitest run tests/<failing-file>.test.ts --root web      # passes?
npm test --workspace=web                                    # fails?  → leak; find the file that runs before it
```

**Governance corollary (MANDATORY, CLAUDE.md):** two parallel PRs touching shared test files (`web/tests/setup.ts`, `web/vitest.config.ts`) can each be green in isolation and break `main` after merge — re-run the FULL suite on `main` between merges.

## §6 Cost-tracker zeros (wire-up bug class)

**Incident (2026-04-28, commit `50445eb8`):** Stage 6's live tool loop never read `stream.finalMessage().usage`, so every live session billed by Anthropic showed `"sonnet": { turns: 0, input: 0, output: 0, cost: 0 }` in analytics despite 8 extraction events (field session 2D391936 was the smoking gun). Margin tracking ran blind for weeks.

**Rule: zeros for a tier that demonstrably ran = wire-up bug, not "no traffic".** The API response ALWAYS carries usage; if the tracker shows zero, the reader was never wired on that code path.

Check:

```bash
# For the suspect path, find where usage is consumed:
grep -rn "finalMessage\|\.usage" src/extraction/<suspect-path>.js
grep -n "addSonnetUsage\|addElevenLabsUsage\|addOpenAI" src/extraction/cost-tracker.js
# Then confirm the suspect path actually CALLS one of those accumulators.
```

Known open edge (as of 2026-07-06): the fast-TTS route `src/routes/voice-latency-fast-tts.js` has no cost attribution (deliberately out of scope 2026-06-26) — zeros there are expected, not a bug.

## §7 "All phases hallucinated" → check the repo before the model

**Rule (standing, from the project mistakes record): when a team-lead/worker task produces an "all phases hallucinated" verdict, the DEFAULT explanation is wrong-repo diffing, not hallucination.** A detailed work summary with a zero diff means the diff was taken in the wrong place — verify before concluding the model invented work.

Trap specific to this repo: `CertMateUnified/` is a SEPARATE nested git repo with its own object store. `git diff` at the EICR_Automation root shows NOTHING for iOS changes, and vice versa.

```bash
git -C /Users/derekbeckley/Developer/EICR_Automation diff --stat
git -C /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified diff --stat
git -C <repo> log -3 --oneline    # confirm the worker's commits actually exist HERE
```

Corollaries: always state "Working directory: /path" in worker task descriptions; require non-empty git diffs for code phases; workers must never run with cwd hardcoded to /tmp.

## §8 TIME_WAIT ephemeral-port exhaustion

**Symptom:** every outbound connection fails with `dial tcp ...: connect: can't assign requested address` (or equivalent ECONNREFUSED-flavored bind errors) — including tools that were working minutes ago. **Cause:** a tight HTTP polling/retry loop burned through macOS's ~16k ephemeral ports; each closed TCP connection sits in TIME_WAIT 15-60s.

```bash
netstat -an | grep -c TIME_WAIT     # >10k = confirmed; recovery is WAIT (or reboot) — no fast fix
```

Prevention rules: poll intervals ≥30s, single in-flight request, no parallel retries. For CI runs use `gh run watch <run-id> --exit-status` (one long-poll connection) — never a `gh run list` loop. If a background monitor script fails its first invocation, FIX it before re-arming; the harness retries without backoff and the failure loop is what burns the ports.

## §9 Silent WS field drops (canonical vs legacy names — Bug-I)

**Incident (field session FA361D70, 2026-04-26, commit `e83a6017`):** backend Stage 6 emits schema-canonical field names from `config/field_schema.json` (`measured_zs_ohm`, `r1_r2_ohm`, `ir_live_live_mohm`, ...); iOS dispatched on legacy short aliases (`zs`, `r1_r2`, ...). Unmatched names hit no switch case → the reading **silently never lands**: backend logs 6 successful tool calls, the row appears (designation populated), every test reading vanishes. No error anywhere.

**Resolution path matters:** a backend rename-to-legacy bridge shipped first (`e83a6017`), then was REVERTED one day later (`17470ada`) once iOS was taught to accept canonical names natively — canonical names on the wire are the end state. Do not reintroduce translation bridges.

Checks:

```bash
# The standing contract guard — every field_schema.json entry must have an iOS dispatch case:
npm run check:ios-parity
# Manual: compare what the backend emits vs what the client switches on:
grep -n "<field_name>" config/field_schema.json
grep -rn "<field_name>" web/src/lib/recording/apply-extraction.ts
grep -n "<field_name>" CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift
```

**Rule:** any NEW wire field needs an END-TO-END contract test (backend emit → wire shape → client dispatch). A green backend unit test plus a green client unit test proved nothing here — the mismatch lived in the gap between them. The `/api/sonnet-stream` protocol has no spec document; the three implementations are kept in sync socially + by tests (see sibling `certmate-voice-wire-protocol`).

## §10 Job permanently unsyncable (validator reject class)

**Incident (2026-06-12):** a PUT-path board-hierarchy validator REJECTED invalid hierarchies, making `job_1778443465217` unsyncable for a week — the client can never fix a payload the server refuses to accept. Rearchitected to deterministically REPAIR (clear dangling parent pointers, demote duplicate mains) + persist + echo `hierarchy_repairs`. Strict validation remains only on the interactive `add_board` path.

```bash
grep -n "repairBoardHierarchy" src/extraction/board-hierarchy-validator.js
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 1h | grep -i "hierarchy"
```

**Rule for the class:** on a persistence path where the CLIENT owns the data, prefer repair-and-echo over reject — a rejected save loops forever. Reserve hard rejection for interactive flows where a human can correct the input.

## §11 Config silently reverting / ignored (two distinct traps)

**(a) Live task-def edits stripped by next deploy.** Any env var applied via `aws ecs register-task-definition` or console, but absent from `ecs/task-def-*.json`, is silently dropped the next time CI registers from source. Bit twice: `CCU_DEWARP_OUTPUT_WIDTH=2048` (applied live 2026-05-13, gone 2026-05-14, resurfaced as a mystery regression 9 days later) and `JWT_SECRET` (§1). Guardrail now in CI:

```bash
./scripts/check-task-def-env-drift.sh eicr-backend ecs/task-def-backend.json
./scripts/check-task-def-env-drift.sh eicr-pwa     ecs/task-def-frontend.json
```

If a var matters, the durable fix is a CODE DEFAULT (as done for the dewarp width in `src/extraction/ccu-single-shot.js`, commit `01c081e5`) or a source-template entry + commit — never a live edit.

**(b) `NEXT_PUBLIC_*` build-time inlining.** Client-side Next.js flags are baked at `next build` inside the Docker image. A `NEXT_PUBLIC_*` var not declared as ARG+ENV in `docker/nextjs.Dockerfile` (and passed in `deploy.yml` build-args) is silently dropped — bit 2026-05-15 with `NEXT_PUBLIC_REGEX_HINTS_ENABLED`. Setting it on the task def does NOTHING for client code. The only runtime-switchable web flag is `DEEPGRAM_STT_MODEL`, served via the top-level `/runtime-config` route (deliberately not under `/api/*` — the prod ALB routes `/api/*` to the backend).

```bash
grep -n "NEXT_PUBLIC" docker/nextjs.Dockerfile .github/workflows/deploy.yml | head -20
```

## §12 Blank data overwriting real data (auto-seed / hydration class)

**Incident (2026-07-02, fixed `851ba63e` 2026-07-03):** a transient GET failure left a job page unhydrated; auto-seed defaulters ran against the blank state and SAVED a blank document over real data. Fix: seeders gate on `isHydrated` provider state (`web/src/lib/job-context.tsx`). **Rule for the class:** any code that writes defaults into a document must prove the document is genuinely empty (hydration confirmed) and not merely not-yet-loaded. Related invariant: when merging local+server state, a dirty local copy with newer edits must never be clobbered by a stale server fetch.

---

## Standing meta-rules (each earned by a real incident)

### M1 — 3+ builds on the same symptom → STOP fixing, START instrumenting

**Story:** 5 blind TestFlight builds chased a "saved-message body doesn't insert" bug through rendering-layer theories; the actual cause was an API list endpoint returning `body: null`. Frameworks are rarely the bug; they look weird because the input is weird. When you catch yourself on attempt #3 for the same symptom, the next build must add INSTRUMENTATION, not a fix.

This repo's instrumentation channel: `sendClientDiagnostic` — web `web/src/lib/recording/client-diagnostic.ts` (fires a `client_diagnostic` WS frame + a `[client-diagnostic]` console.info), iOS `ServerWebSocketService.sendClientDiagnostic`. Backend logs it to CloudWatch as `Client diagnostic` (`src/extraction/sonnet-stream.js:1072`, line current as of 2026-07-06):

```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 30m | grep "Client diagnostic"
```

Session forensics after the fact: S3 `session-analytics/{userId}/{sessionId}/debug_log.jsonl` in bucket `eicr-files-production`, processed by `node scripts/analyze-session.js /path/to/session-dir/` (needs `debug_log.jsonl` + `field_sources.json` + `manifest.json`; emits `analysis.json`). Deep tooling: sibling `certmate-diagnostics-and-tooling`.

### M2 — Measure before any CSS/browser-quirk hypothesis

**Story:** 4 "Safari BFC quirk" commits over 4 days for pages collapsing to ~48px. The real cause (fix `e9a7cf92`, 2026-05-11): Tailwind v4 `--spacing-*`/`--radius-*` theme tokens hijacked `max-w-*` utilities. One `getComputedStyle` pull from the live DOM would have shown `max-width: 48px` immediately. **Rule:** before naming a browser/framework quirk, pull computed styles for the failing element from the live DOM (Chrome DevTools MCP or the browser console). The dialog double-offset bug (Tailwind v4 `translate` + transform stacking, fixed WS5 `6e384feb`) is the same class.

### M3 — Data vs rendering: log the value at the assignment site FIRST

When two similar bindings driven by the same code path behave differently, the difference is in the VALUE going in, not the rendering layer. Before any architectural fix, add one log at the assignment site and look at the actual value. "I think SwiftUI/React is being flaky" appearing 3+ times on the same symptom means you have not verified the input (see M1's story — empty string was carried faithfully through every layer; nothing in rendering was broken). Same doctrine as invariant checks in §2 (decoder = data shape) and §9 (drop = name mismatch): this codebase's "rendering bugs" have overwhelmingly been data-contract bugs.

---

## When NOT to use this skill

| You actually need | Sibling skill |
|---|---|
| The full history/rationale of an investigation, dead ends, reverts | `certmate-failure-archaeology` |
| What counts as test evidence, harness footguns in depth, parity-ledger mechanics | `certmate-validation-and-qa` |
| Measurement tools (analyze-session, voice-latency-bench, stage6 harnesses) in depth | `certmate-diagnostics-and-tooling` |
| Dictate→confirm latency work specifically | `certmate-latency-campaign` |
| Env-var / flag catalog and how to add one | `certmate-config-and-flags` |
| Deploying, ECS status, rollback, migrations one-off | `certmate-run-and-operate` |
| WS `/api/sonnet-stream` frame shapes and both-direction protocol | `certmate-voice-wire-protocol` |
| CCU photo-extraction accuracy problems | `certmate-ccu-pipeline` |
| What you may/may not change (backend-immutable, infra-from-source, web-companion) | `certmate-change-control` |
| Electrical-domain meaning of a field (Zs, LIM, C1/C2/C3, spd_* trap) | `bs7671-domain-reference` |

Change-control reminder: nothing in this playbook authorizes backend edits during PWA/parity work, live AWS mutations, or bypassing CI deploy. Fixes route through `certmate-change-control` rules.

## Provenance and maintenance

Every row above was re-verified against the repo on 2026-07-06. One-line re-verification per drift-prone fact:

| Fact | Re-verify with |
|---|---|
| `JWT_SECRET` in frontend task-def source | `grep -n JWT_SECRET ecs/task-def-frontend.json` |
| Middleware fails closed on missing secret | `grep -n "fail" web/src/middleware.ts` |
| Copy-on-write redaction intact | `grep -n redactPiiInPlace src/logger.js` |
| Redacted-jobs audit script exists | `ls scripts/audit-redacted-job-addresses.js` |
| `isUnscopedBoardId` locations | `grep -rn isUnscopedBoardId web/src` |
| Node pin + preflight | `cat .nvmrc && ls web/scripts/check-node.mjs` |
| Vitest cleanup flags on | `grep -n "restoreMocks\|unstubGlobals" web/vitest.config.ts` |
| Storage shim unconditional | `grep -n installStorageShim web/tests/setup.ts` |
| Pre-push runs BOTH suites | `grep -n "npm test" .husky/pre-push` |
| Cost accumulators present | `grep -n "addSonnetUsage\|addElevenLabsUsage" src/extraction/cost-tracker.js` |
| iOS field-parity contract guard | `grep -n "check:ios-parity" package.json` |
| Hierarchy repair (not reject) | `grep -n repairBoardHierarchy src/extraction/board-hierarchy-validator.js` |
| Drift-check guardrail | `sed -n '1,30p' scripts/check-task-def-env-drift.sh` |
| CloudWatch diagnostic line number | `grep -n "Client diagnostic" src/extraction/sonnet-stream.js` |
| Hydration gate | `grep -n isHydrated web/src/lib/job-context.tsx` |
| Incident hashes cited (`5bf304ac`, `d5adb2e3`, `c918b88a`, `a1815098`, `e83a6017`, `17470ada`, `50445eb8`, `e9a7cf92`, `01c081e5`, `851ba63e`) | `git show -s --format="%h %ad %s" --date=short <hash>` |

Labeled-unverified items: the §2 split-load `{circuit_number:null, is_rcd_device:true}` example predates the 2026-02-23 repo baseline (hardware-failure reset) and exists only in the project's incident record — the RULE is standing, the example commit is unretrievable. The M1 5-TestFlight-builds story is likewise from the incident record (iOS-side, different app), retained for the rule it produced.
