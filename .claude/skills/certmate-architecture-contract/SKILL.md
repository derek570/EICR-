---
name: certmate-architecture-contract
description: >
  Load this skill BEFORE proposing, planning, or reviewing ANY design-level change to
  CertMate/EICR_Automation — new features, refactors, "why is it built this way" questions,
  cross-platform (iOS/web/backend) changes, model swaps, PDF changes, CCU pipeline changes,
  Deepgram/STT changes, offline/sync changes, or anything touching the voice read-back loop.
  It states the load-bearing design decisions, WHY they were made, the invariants that must
  hold, and the known-weak points. Do NOT load it for: process/gating questions (use
  certmate-change-control), live-bug triage (certmate-debugging-playbook), WebSocket frame
  shapes (certmate-voice-wire-protocol), env-var values (certmate-config-and-flags), or
  BS 7671 electrical domain meaning (bs7671-domain-reference).
---

# CertMate Architecture Contract

The design decisions that must survive any change, and why. All file paths repo-relative to
`/Users/derekbeckley/Developer/EICR_Automation`. All line numbers and prod values are
**as of 2026-07-06** — re-verify via the Provenance section before relying on them.

**Jargon defined once:** EICR/EIC = the two electrical certificate types (condition report /
new-installation cert). CCU = consumer unit (the fuse board being photographed). Stage 6 =
the server-side agentic voice-extraction pipeline. Sonnet/Haiku = Anthropic Claude models.
Deepgram = the speech-to-text vendor (Nova-3 and Flux are its models). TTS = text-to-speech
(read-back to the inspector). PWA = the Next.js web app in `web/`. IDB = IndexedDB.
Ledger = `web/docs/parity-ledger.md`, the iOS↔web feature-parity register.

## 0. System shape (30-second orientation)

```
iOS app (canon) ──┐                          ┌── Deepgram Flux (STT, direct WS from client)
                  ├── wss://api.certmate.uk/api/sonnet-stream ── backend (Node, ECS Fargate)
web PWA (parity) ─┘                          └── Claude Haiku 4.5 multi-turn tool loop
                                                  → readings applied server-side
                                                  → confirmations read back via TTS (ElevenLabs)
Backend also: REST API (77 paths, /api/docs), S3, RDS Postgres, CCU photo VLM (gpt-5.5)
```

Three clients of one backend: iOS (SwiftUI, separate nested git repo `CertMateUnified/`),
web PWA (`web/`), and the certificate PDF renderers. iOS is canon; web chases parity;
backend is the shared contract and is IMMUTABLE during parity work (see
`certmate-change-control` — never route around that rule from here).

## 1. Server-side multi-turn extraction (ADR-003 + ADR-008)

**Decision:** all voice→structured-data extraction runs SERVER-side, as a multi-turn agentic
tool loop over one WebSocket per recording session (`wss://…/api/sonnet-stream`, mounted in
`src/server.js`; engine in `src/extraction/sonnet-stream.js`, ~4000 lines). Clients are thin:
they stream transcripts up and apply typed frames down.

**Why:** one extraction brain for two clients; prompt/tool iteration without client releases;
server holds session state (multi-turn context, compaction, cost tracking). ADR-008 is the
live contract: tool schemas are GENERATED from `config/field_schema.json` at module load
(`src/extraction/stage6-tool-schemas.js`), asks are server-resolved, value rules shared.
**ADR-008 is the most load-bearing ADR** — a field that exists in the schema automatically
exists in the tool enum; adding a field is a schema+prompt+client-dispatch change, not a
tool-schema hand-edit.

**Live model (as of 2026-07-06):** `SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001`
(`ecs/task-def-backend.json:53`). Despite the "Sonnet" naming everywhere (files, frames,
prompts), the live extraction model is **Haiku 4.5** (~10× cheaper). Treat "Sonnet" in code
names as a historical label, not a model claim.

**Invariant — Haiku's self-reported `confidence` is NOT trustworthy and must not gate
behaviour.** `CONFIRMATION_MIN_CONFIDENCE = 0.8`
(`src/extraction/confirmation-text.js:193`) is ONLY the loaded-barrel speculator's pre-synth
cost gate (skip speculative TTS synth for low-confidence slots). It is NOT a read-back gate
and NOT a write gate. Any proposal that reintroduces "suppress/drop low-confidence readings"
violates Audio-First invariant #2 (below) and repeats a superseded design.

Related constant: `FINALIZER_TIMEOUT_MS = 8000`
(`src/extraction/voice-latency-turn-summary.js:119`) — the open Phase-2.2 latency tuning
target; do not change it casually (owned by `certmate-latency-campaign`).

## 2. Audio-First MANDATORY invariants (verbatim-faithful)

Source of truth: `CLAUDE.md` § "Audio-First Design Principles". The inspector works in
AirPods, phone pocketed, **no eyes on the screen**. The spoken channel is the PRIMARY UI.
These three override any older screen-first or minimise-TTS-chatter guidance:

1. **"Every dictated reading is read back aloud — exactly once. Never silently entered into
   the UI."** Not zero (silent entry = invisible to a hands-free inspector) and not twice
   (double-confirm bug). Holds for ALL apply paths, including client-initiated reassignments.
   **Exception (by design):** automatic derivations and side-effect ticks (polarity
   auto-ticked from Zs, mirror-derived fields) are computed consequences, NOT dictated
   readings — they get NO spoken confirmation. Do not "fix" that silence.
2. **"Structurally complete readings are WRITTEN regardless of self-reported confidence, and
   read back aloud — never silently dropped."** A reading with field + circuit/board scope +
   value is written at ANY confidence; the inspector verifies by ear and corrects by
   speaking. Ask ONLY for structural gaps, contradictions, invalid/out-of-range values, or
   true non-values. This supersedes BOTH "suppress low-confidence confirmations" AND the
   interim "low-confidence readings ASK" stance.
3. **"Latency is a first-class concern."** The dictate→confirm loop is conversational;
   regressions in perceived latency are BUGS, not cosmetics.

Any design review of voice-path code starts by checking the change against these three.
Web advertises invariant-#2 support via the `low_conf_readback_v1` capability
(`web/src/lib/recording/sonnet-session.ts:586`, `VOICE_LATENCY_SUPPORTS`).

## 3. Three-tier field priority (ADR-004) — and what regex may NOT do

**Decision:** two extraction tiers run in parallel per utterance — client-side regex
(~40 ms, instant UI fill) and server-side Haiku (1–2 s, higher accuracy) — arbitrated by a
strict write priority:

| Tier | Source | May overwrite |
|---|---|---|
| 1 (highest) | Pre-existing (CCU photo analysis, manual entry) | — |
| 2 | Sonnet/Haiku server extraction | tier 3 only |
| 3 (lowest) | Client regex (`TranscriptFieldMatcher`) | a previous tier-3 write only |

Web enforcement: `web/src/lib/recording/field-source-tracker.ts`, gated in
`apply-regex-match.ts` ("regex never overwrites Sonnet OR pre-existing"). iOS mirrors this
in `applySonnetReadings` / regex apply.

**Invariant — regex NEVER creates circuits.** Circuit creation is Sonnet-only (server
`create_circuit` tool). The matcher on both platforms still EMITS `new_circuits` (so
wire-shape tests can assert it), but the apply layer deliberately ignores it —
`web/src/lib/recording/apply-regex-match.ts:14-19` documents this, and iOS is identical.
This has been mistaken for a missing port at least once. Do NOT "complete" it.

## 4. iOS-canon data contract

**Decision:** iOS is canon for the data contract. Web must match the backend's CURRENT wire
shape; any web↔iOS divergence is a bug unless a DATED exception exists on a parity-ledger
row. Backend shape changes are cross-platform mandates, never side effects of a web fix.

**Mechanical guard:** `npm run check:ios-parity` →
`scripts/check-ios-field-parity.mjs`. It diffs every `config/field_schema.json` field
against the `case "…"` arms of iOS `applySonnetReadings`
(`CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`) and exits 1 on a
schema field with no iOS case. Born from session 6FF8A837: Sonnet wrote
`ir_test_voltage_v` 6 times, iOS silently dropped all 6 (no case arm). Run it whenever you
touch `field_schema.json` or the iOS dispatch switch.

**Corollary (Bug-I lesson):** every wire field needs an END-to-END contract test (backend
emit → wire → client dispatch). Canonical-vs-legacy name drift (`measured_zs_ohm` vs `zs`)
produced silent no-op drops. Frame shapes themselves: see `certmate-voice-wire-protocol`.

## 5. Three PDF renderers + the companion rule

| Renderer | Path | Status |
|---|---|---|
| iOS (CANON) | `CertMateUnified/.../EICRHTMLTemplate.swift` → WKWebView HTML→PDF (ADR-006) | Live; iOS app uses ONLY this |
| Web client-side | `web/src/lib/pdf/` — line-for-line TS port of the iOS template (`template/eicr-html-template.ts`) + hidden-iframe SVG `foreignObject` page capture at 3× (`render/capture.ts`) + pdf-lib merge | Live since 2026-07-02 (WS9); primary Generate on the web PDF tab |
| Server fallback | `POST /api/job/:userId/:jobId/generate-pdf` (`src/routes/pdf.js:22`) → spawns `python3 python/generate_full_pdf.py` (ReportLab). A separate Playwright HTML→PDF module `src/generate_pdf.js` also exists (chromium installed in `docker/backend.Dockerfile:52`) | FALLBACK/DEBUG-ONLY — explicit "Generate on server (fallback)" action; flips behind the debug page after field validation (`TODO(ws9-followup)` in `web/src/app/job/[id]/pdf/page.tsx`) |

**Invariant — the companion rule:** ANY change to `EICRHTMLTemplate.swift` needs a
web-template companion change in `web/src/lib/pdf/template/` (ledger row `pdf/pdf-fidelity`,
`partial` until field validation). The two templates correspond 1:1 by design — that
correspondence is the entire fidelity argument, so do not "improve" the web port
independently.

**Known-weak (accepted trade-off):** the web renderer produces RASTER text (foreignObject
capture), not vector — chosen over html2canvas (no `vertical-lr` support) and vector
re-authoring (breaks 1:1 template correspondence). Documented, not a bug to fix in passing.

## 6. CCU photo pipeline: single-shot live, per-slot legacy

**Live path (as of 2026-07-06):** single-shot `gpt-5.5` over the WHOLE dewarped image —
`src/extraction/ccu-single-shot.js`. No per-slot cropping. Enabled by
`CCU_USE_SINGLE_SHOT=true` in `ecs/task-def-backend.json:40`; the CODE default is `false`
(`src/routes/extraction.js:2191`) — so a fresh env without the var silently runs the LEGACY
path. **Trap:** local runs and tests need the flag set to exercise the live path.

**Legacy fallback:** the Stage-3/Stage-4 per-slot pipeline (`src/extraction/ccu-geometric.js`
crop+classify, `ccu-label-pass.js` label pass) — demoted, kept behind the flag. The pipeline
history churned geometric → per-slot → single-shot with each prior approach demoted rather
than deleted; the full thrash timeline lives in `certmate-failure-archaeology`, the deep
stage-by-stage reference in `certmate-ccu-pipeline`.

**In-scope failure modes** (what to suspect when a CCU extraction is wrong): gpt-5.5
mis-counts in long identical-MCB runs; label-column mis-alignment; post-merge enrichment
overrides; `slotsToCircuits` phase-walking heuristics. NOT in scope: CV crop accuracy (not
in the live path). **Doctrine: blank beats guessed-wrong** — board-majority guessing was
reverted (`aa529115`); never fill a slot by inference from its neighbours.

## 7. Speech-to-text: Flux on BOTH platforms (as of 2026-07-03), reversibly

- **iOS:** Deepgram Flux `flux-general-en` on `/v2/listen`, direct WebSocket from the
  device (`CertMateUnified/Sources/Services/DeepgramService.swift`).
- **Web:** flipped nova3 → flux on 2026-07-03 (commit `ff620997`, field-reported
  partial-sentence sends on Nova-3) via the `DEEPGRAM_STT_MODEL` runtime kill-switch.
  Both Flux and Nova-3 code paths remain live in
  `web/src/lib/recording/deepgram-service.ts` (`buildFluxURL`/`buildNova3URL`).
- **Kill-switch mechanics + rollback** (fail-safe split, `/runtime-config` route
  rationale, ~3–5 min `frontend-taskdef` flip path): **certmate-config-and-flags §5b**
  (single home); flip recipe in `certmate-run-and-operate` §4a.

**Invariant:** iOS and web Deepgram configs (model, `utterance_end_ms`, `vad_events`,
`endpointing`, keyterms) move IN SYNC AS A SET — one-sided drift has produced garbage
transcripts before. **Fenced-off wrong path:** NO fuzzy/edit-distance garble correction
anywhere (rejected project-wide — recorded in-repo in the 2026-07-03 changelog row;
original decision 2026-06-24 per project memory, unverified in-repo, see
certmate-failure-archaeology. A false correction mis-filing a reading on a
safety-critical certificate is worse than a miss). Curated equal-weight keyterms are the
only sanctioned correction.

**Stale-doc warning:** the hub `CLAUDE.md` tech-stack table still says "web remains Nova-3
until WS4" — superseded by the 2026-07-03 flip. Trust the task-def value.

## 8. Auto-sleep: ADR-007 says 3-tier; the LIVE machine is 2-tier

ADR-007 (and the hub changelog "Live in production" line) documents a 3-tier
Active/Dozing/Sleeping model. **The live code on BOTH platforms is a collapsed 2-tier
machine**: `active ──60s no final──▶ sleeping`, `sleeping ──VAD wake──▶ active`.
iOS dropped the Dozing tier on 2026-04-27 (Flux rejects the KeepAlive JSON the tier relied
on; silent-PCM ping caused spurious EndOfTurn) — `CertMateUnified/Sources/Audio/
SleepManager.swift:32-34` has only `active`/`sleeping`; the web port
(`web/src/lib/recording/sleep-manager.ts:55`) matches, with iOS's three timer constants
verbatim (60 s no-transcript / 75 s post-question / 90 s post-wake grace) and a Silero-VAD
primary + RMS-fallback wake gate. When reading ADR-007, treat the 3-tier description as
historical context, not current behaviour.

## 9. Board hierarchy: REPAIR, never reject, on PUT

`src/extraction/board-hierarchy-validator.js` — `repairBoardHierarchy()` (line 144). On the
PUT/save path, an invalid multi-board hierarchy (dangling parent pointers, duplicate main
boards) is deterministically REPAIRED (pointers cleared, duplicate mains demoted), persisted,
and echoed to the client as `hierarchy_repairs`. It is NEVER rejected.

**Why:** the earlier reject gate made a real job permanently unsyncable for a WEEK
(2026-06-12, `job_1778443465217`) — the client could never produce a payload the server
would accept, so every save bounced. Strict validation survives ONLY on the interactive
`add_board` path, where a human can respond to the error. If you touch board-hierarchy
validation, preserve this asymmetry: interactive = strict, persistence = repair.

## 10. Offline outbox / IDB (web PWA)

`web/src/lib/pwa/` — IndexedDB database `certmate-cache`, **`DB_VERSION = 5`**
(`job-cache.ts:75`). Stores: `jobs-list`, `job-detail`, `outbox` (mutation outbox — FIFO
replay with exponential backoff, `outbox-replay.ts`), `app-settings`,
`pending-observation-photo`, `pending-ccu-extraction` (v5; persist-before-upload CCU photo
queue with one idempotency key per capture).

Invariants:
- **Durability-first save:** `queueSaveJob` writes to the IDB outbox BEFORE the network
  attempt; wired into the provider save path at `web/src/lib/job-context.tsx` (~line 201 as
  of 2026-07-06).
- **Dirty-guard:** a newer server `updated_at` must never clobber unsynced local edits.
- **`isHydrated` gate:** auto-seed defaulters (installation/supply sections) MUST NOT run
  until the job has hydrated from the network (`job-context.tsx`, provider state
  `isHydrated`). Fix `851ba63e` (2026-07-03) — before the gate, a transient GET failure let
  auto-seeders save a BLANK document over real data (P1 data loss, hit the parity fixture).
  Any new "seed defaults if empty" logic must sit behind this gate.

## 11. ADR inventory (8, all Accepted — `docs/adr/`)

| ADR | One-liner | Current-truth caveat |
|---|---|---|
| 001 (2026-01-15) | Backend is native ES modules (`"type":"module"`) | — |
| 002 (2026-02-05) | Deepgram Nova-3 for live transcription | Superseded in practice: BOTH platforms on Flux as of 2026-07-03 (§7) |
| 003 (2026-02-16) | Server-side Sonnet extraction over WS; thin clients | Live model is now Haiku 4.5 (§1) |
| 004 (2026-02-18) | Three-tier field priority: Pre-existing > Sonnet > Regex | — (§3) |
| 005 (2026-01-20) | npm-workspaces monorepo (src / web / packages/shared-*) | — |
| 006 (2026-02-14) | iOS-first WKWebView PDF | Web now has its own client-side port; three renderers total (§5) |
| 007 (2026-02-19) | Deepgram auto-sleep, 3-tier | Live machine collapsed to 2-tier 2026-04-27 (§8) |
| **008** (2026-04-27) | **Schema-driven tools, server-resolved asks, shared value rules — the live Stage 6 contract. Most load-bearing.** | — (§1) |

## 12. Known-weak points (state them, don't rediscover them)

| Weakness | Status | Where handled |
|---|---|---|
| Web PDF text is raster, not vector | Accepted trade-off, documented | §5; field validation pending (`pdf/pdf-fidelity` ledger row) |
| WebSocket `/api/sonnet-stream` has NO doc of record — code is the only source; three implementations kept in sync socially + by tests | Open structural risk | `certmate-voice-wire-protocol` IS the doc — load it for any frame work |
| CI lint + typecheck are NON-blocking (`\|\| true` in `.github/workflows/deploy.yml:221,225`); only build + both test suites gate | Open — a type error can reach main | `certmate-validation-and-qa` |
| Playwright E2E is NOT in CI or pre-push (manual only) | Open | `certmate-validation-and-qa` |
| `docs/DEVELOPER_SETUP.md` is STALE (references a non-existent `frontend/` workspace) | Known | `certmate-build-and-env` |
| Hub changelog/tech-stack lines lag code in two spots: web-STT-still-Nova-3 (§7) and 3-tier sleep (§8) | Known as of 2026-07-06 | this skill |
| `CCU_USE_SINGLE_SHOT` code default `false` ≠ prod `true` — flagless envs run legacy | Trap | §6 |
| Deferred wire-contract items `[contract]` #3.4 (designation not crossing wire) + #5.3 (atomic swap tool — Sonnet fakes swaps via orphan circuit 999) | Open, dated deferrals | `certmate-voice-wire-protocol` |

## When NOT to use this skill

| You actually need | Load instead |
|---|---|
| MANDATORY gates, commit/deploy policy, docs-of-record discipline | `certmate-change-control` |
| A live bug to triage (symptom → cause) | `certmate-debugging-playbook` |
| Past investigations / reverts / why an approach was abandoned | `certmate-failure-archaeology` |
| WS frame types, shapes, capabilities negotiation | `certmate-voice-wire-protocol` |
| Env vars, flags, prod values, kill-switch mechanics | `certmate-config-and-flags` |
| CCU pipeline stage-by-stage detail + harnesses | `certmate-ccu-pipeline` |
| What Ze/Zs/C1/C2/LIM/spd_* MEAN electrically | `bs7671-domain-reference` |
| Build env, Node pin, Docker | `certmate-build-and-env` |
| Deploying, ECS status, rollback commands | `certmate-run-and-operate` |
| Measuring latency/cost/session forensics | `certmate-diagnostics-and-tooling` |
| Evidence standards, test-harness footguns | `certmate-validation-and-qa` |
| The dictate→confirm latency campaign itself | `certmate-latency-campaign` |

## Provenance and maintenance

Every volatile fact above, one re-verification command each (run from repo root):

```bash
# Live extraction model + CCU flag (prod task def)
grep -n "SONNET_EXTRACT_MODEL\|CCU_USE_SINGLE_SHOT" ecs/task-def-backend.json
# CCU code default (should still be 'false')
grep -n "CCU_USE_SINGLE_SHOT" src/routes/extraction.js
# Web STT model flip
grep -n "DEEPGRAM_STT_MODEL" ecs/task-def-frontend.json
grep -n "DEFAULT_STT_MODEL\|SAFE_STT_MODEL" web/src/lib/runtime-config.ts
# Confidence + finalizer constants
grep -n "CONFIRMATION_MIN_CONFIDENCE = " src/extraction/confirmation-text.js
grep -n "FINALIZER_TIMEOUT_MS = " src/extraction/voice-latency-turn-summary.js
# Audio-First invariants verbatim
grep -n -A4 "Audio-First Design Principles" CLAUDE.md
# Regex-never-creates-circuits comment
sed -n '11,20p' web/src/lib/recording/apply-regex-match.ts
# iOS parity checker
npm run check:ios-parity
# PDF: server fallback route + python entry
grep -n "generate-pdf\|generate_full_pdf" src/routes/pdf.js
# Sleep-state tiers (both platforms)
grep -n "SleepState" web/src/lib/recording/sleep-manager.ts
grep -n -A3 "enum State" CertMateUnified/Sources/Audio/SleepManager.swift
# Hierarchy repair
grep -n "export function repairBoardHierarchy" src/extraction/board-hierarchy-validator.js
# IDB version + stores
grep -n "DB_VERSION\|const STORE_" web/src/lib/pwa/job-cache.ts
# isHydrated gate + queueSaveJob wiring
grep -n "isHydrated\|queueSaveJob(" web/src/lib/job-context.tsx
# ADR index
sed -n '1,25p' docs/adr/README.md
# CI non-blocking lint/typecheck + Playwright absence
grep -n "|| true" .github/workflows/deploy.yml; grep -c playwright .github/workflows/deploy.yml
# Web capability advertisement
grep -n "VOICE_LATENCY_SUPPORTS" web/src/lib/recording/sonnet-session.ts
```

(The ALB `/api/*`→backend rule is source-verified at `infrastructure/setup-domain.sh:394-409`.)

UNVERIFIED-in-this-authoring (low risk): the exact iOS `applySonnetReadings` line span in
`DeepgramRecordingViewModel.swift` — the parity script parses it structurally; run
`npm run check:ios-parity` rather than trusting any quoted line numbers for that switch.
