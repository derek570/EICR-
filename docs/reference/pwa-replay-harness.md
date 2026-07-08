# PWA Voice-Pipeline Replay Harness

> Shipped 2026-07-08 (pwa-replay-harness plan, Waves 1–7). Replays real
> recorded field sessions and generated scenarios through the REAL web
> recording pipeline, diffs behaviour against iOS, and asserts the
> Audio-First product invariants. Born from `sess_mrbnds2d_jczh` — four
> client bugs in 2.2 minutes that 1300+ green unit tests were
> structurally blind to (they tested each port against its own contract,
> never the composition).

## What it is

| Layer | Files | Purpose |
|-------|-------|---------|
| Injection seams (B1) | `web/src/lib/recording/test-services.ts` (+ taps in `client-diagnostic.ts`, `tts.ts`) | `__setRecordingTestServices()` — swap ONLY external effects (Deepgram WS, Sonnet WS, mic, audio players, chime/haptic, runtime-config fetch) at the `RecordingProvider` composition root. Null in prod = byte-identical behaviour. |
| Fakes | `web/tests/harness/fake-services.ts` | `FakeDeepgramService` wraps a REAL `DeepgramService` around a captive fake WebSocket — raw Flux frames flow through the REAL TurnInfo mapping (load-bearing: A1 lives inside that mapping; a delegate-level fake stayed green with A1 reverted). `FakeSonnetSession` records sends + emits scripted frames. |
| Trace (B2) | `web/tests/harness/trace.ts` | Per-utterance behavioural trace from THREE sources: diagnostic tap, job-state observer ({key, value, tier} — proves "the field landed with the spoken value"), injected effects (chime, TTS plays/defers/discards). The common currency for the differ and the invariants. |
| Runner (B3/B4) | `web/tests/harness/runner.tsx`, `scenario.ts`, `expectations.ts`, `pwa-replay-scenarios.test.ts` | Mounts the REAL provider, feeds a scenario's transcript timeline (interims synthesised — the iOS log truncates them), emits mock frames per send, evaluates `expect.web` + invariants. Modes: `mock` (deterministic, zero tokens) / `live` (real SonnetSession vs a local backend). |
| Invariants (D1) | `web/tests/harness/invariants.ts` | 7 product invariants over any trace: read-back exactly once (regex tier exempt), derivations silent, no circuit-ask for section fields, every gate pass justified by a real trigger, chitchat inert, no-op passes bounded, feedback capture semantics. |
| iOS differential (C1–C4) | `scripts/pwa-replay/convert-session.mjs`, `diff-traces.mjs`, `session.mjs` | Fetch an iOS session from S3 → replay fixture + iOS trace → replay on web → strict/loose two-lane diff report. |
| Generated sweep (D2–D4) | `scripts/pwa-replay/generate-field-sweep.mjs`, `tests/fixtures/pwa-replay/{generated-sweep/,garbles.json,chitchat.json}` | 116 scenarios from `config/field_schema.json` (clean + garbled + chitchat-interleaved per field). `--check` = CI sync guard. |

## Commands

```bash
npm run pwa-replay                             # session-fixture suite (mock mode)
npm run pwa-replay -- --scenario=<substring>   # filtered
npm run pwa-replay -- --mode=live              # live mode (needs PWA_REPLAY_TOKEN + local backend)
npm run pwa-replay -- --trace-out=<dir>        # dump behavioural-trace JSON per scenario
npm run pwa-replay:sweep                       # 116-field generated sweep (mock, ~35s)
npm run pwa-replay:session -- --session=<id>   # fetch → convert → replay → diff, one command
node scripts/pwa-replay/generate-field-sweep.mjs [--check]   # regenerate / verify sweep
```

## Corpus process (C5)

Add any iOS field session to the differential corpus with one command:

```bash
npm run pwa-replay:session -- --session=<iOS-session-UUID>
# writes tests/fixtures/pwa-replay-sessions/ios-<id>.yaml + .ios-trace.json — commit them
```

Better fidelity: hand-author the session-START job state (final `job_snapshot.json` minus the fields the session applied) and pass `--initial-state=<json>` → `initial_state_fidelity: hand_authored`, which keeps the state-dependent strict lanes enforced. Without it fixtures are `empty_fallback` and those lanes downgrade to WARN.

**Web sessions cannot be converted** — the web client uploads no `debug_log.jsonl` to S3 (ledger row `crosscutting/session-analytics-upload`). Hand-author them as scenario YAMLs from the CloudWatch `client_diagnostic` log while the forensics are fresh (`sess_mrbnds2d_jczh.yaml` is the template). Corpus policy: manual opt-in per session (§8 decision 4); auto-convert stays an optional stretch.

## Tolerance model (the differ, C3)

- **Strict lanes** (deterministic client logic — FAIL): gate pass/block, forwarded-to-Sonnet, circuit-ask class, web TTS invariants, feedback-marker detection. Downstream lanes only stay strict when the upstream gate/forward decisions agreed (derivative divergences don't double-count). `empty_fallback` fixtures downgrade state-dependent strict lanes to WARN.
- **Documented iOS quirk → WARN**: iOS's circuit-HINT loop inserts regex hit keys without a value-equality check (`DeepgramRecordingViewModel.swift:5188-5210`), so a stale cumulative circuit re-match can pass the iOS gate where the web (A3 freshness) blocks — an iOS quirk, not a web regression.
- **Loose lanes** (LLM-dependent — WARN): end-of-session applied-value set, question counts, semantic confirmation text (field+value present, not verbatim — §8 decision 3).

## CI lanes (E1)

- **Per-PR mock lane** (`pwa-replay-mock-lane` in `deploy.yml`): PR-only, path-filtered to recording/harness surfaces; sweep sync-check + harness suite + full 116-field sweep in mock mode. Deterministic, zero tokens, <5 min.
- **Nightly live lane** (`.github/workflows/pwa-replay-nightly.yml`): boots the real backend against a CI Postgres (schema bootstrap + `node-pg-migrate up`), per-run `JWT_SECRET` + `harness-mint-jwt`, Haiku + 1h-cache env, session-fixture corpus only (budget: hard cap under the confirmed **£10/month** — do NOT point it at the 116-field sweep without re-costing). ADVISORY — failure files a GitHub issue, never blocks a deploy. **Pending first green run:** requires the `ANTHROPIC_API_KEY` repo secret (human provisioning; the workflow no-ops with a notice until then) and a first `workflow_dispatch` to shake out boot issues. E1 decision (2026-07-08): GitHub Actions chosen over the launchd-on-dev-Mac fallback; revisit only if secret provisioning is refused.
- **Pre-push hook: UNCHANGED** (E2 decision). The harness composition tests run in the default web suite; the 116-field sweep is opt-in (`PWA_SWEEP=1`) — too heavy for the hook.

## Keystone proof (the harness's licence to exist)

Recorded in the plan's execution log (2026-07-08): with A1/A2/A3 reverted on a scratch branch (pre-fix tag `pwa-replay-prefix-2026-07-08`), the `sess_mrbnds2d_jczh` + `a3-gate-consequence` fixtures went RED on all three bug classes (16 + 12 violations: stranded-defer/lost read-back, false circuit ask, phantom chitchat passes); unmodified branch GREEN. The first RED attempt itself caught a harness blind spot (delegate-level Deepgram fake bypassed the real Flux mapping) — fixed before the proof was accepted. A4's lane went green at Wave 6 (four-bug proof complete).

## Known limits

- Interims are synthetic (progressive prefixes) — interim-dependent behaviours are asserted via invariants/tolerances, never exact-match.
- Mock frames are reconstructed from SERVER-ORIGIN iOS log events only (`sonnet/` category); regex-category client events never become frames (would mask the A3 class — pinned by `mock-frame-provenance.test.ts`).
- `server_extraction_received` carries counts only, so reconstruction is approximate (confidence/board_id synthesised; undefined-value field_sets skipped).
- No live audio: echo gating, real VAD, mic quirks stay with manual device smokes.
