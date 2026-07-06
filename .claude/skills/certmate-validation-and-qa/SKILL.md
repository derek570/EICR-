---
name: certmate-validation-and-qa
description: >
  Load this skill whenever you are about to WRITE, RUN, or TRUST a test in the
  EICR_Automation repo — adding a backend Jest or web Vitest test, debugging a
  "passes locally / fails in CI" or "passes alone / fails in the full run"
  test, deciding whether green CI means a change is safe, running Playwright
  E2E, adding or verifying a wire-protocol field (contract-test requirement),
  updating a parity-ledger row (partial → match lifecycle, device smokes), or
  judging what evidence is sufficient to call a change "validated". Do NOT
  load it for the content of the voice wire protocol itself
  (certmate-voice-wire-protocol), for latency measurement tooling
  (certmate-diagnostics-and-tooling), for deploy mechanics
  (certmate-run-and-operate), or for change-classification/commit rules
  (certmate-change-control).
---

# CertMate Validation & QA — what counts as evidence

Everything verified directly against the repo on 2026-07-06 unless marked otherwise.
Repo root: the EICR_Automation monorepo (backend `src/`, web `web/`, shared `packages/`).

## 0. Evidence hierarchy (memorize this)

From weakest to strongest. Never claim a level you haven't earned.

| Level | What it proves | What it does NOT prove |
|---|---|---|
| 1. Unit test green (one side) | That side's logic in isolation | That the other side of the wire agrees on names/shapes (Bug-I, §7) |
| 2. Full suite green locally | No regressions ON YOUR NODE MAJOR | CI green (Node 20 vs local 25 — §5), typecheck-clean (§6) |
| 3. CI green | Build + both test suites pass on Node 20 | Lint-clean or typecheck-clean — those steps are `\|\| true` (§6) |
| 4. Wire round-trip / contract test | Backend emit and client decode agree on the SAME literal field name | Real-device behaviour (audio, Safari quirks, haptics) |
| 5. Device smoke (iPad/iPhone Safari) | The surface works on real hardware | Sustained real-world use under field conditions |
| 6. Field session (Derek on a real job) | THE final arbiter. Parity rows, latency decisions, and PDF fidelity only close on field evidence | — |

Rule of thumb: a parity-ledger row (§9) or a voice-behaviour change is not
"done" at level 3. It is `partial` until level 5–6 evidence exists, with a
dated note saying which evidence is pending.

## 1. Quick command card

```bash
# Backend Jest — full suite (~205 files; several minutes)
npm test
# Backend Jest — one file (verified: runs in <1s warm)
npm test -- src/__tests__/confirmation-text.test.js
# Web Vitest — full suite (125 files / 1362 tests, ~15s; green 2026-07-06)
npm test --workspace=web
# Web Vitest — one file
npm test --workspace=web -- tests/apply-extraction-parity.test.ts
# Web typecheck + lint (CI does NOT block on these — run them yourself)
npm run typecheck --workspace=web && npm run lint --workspace=web
# Playwright E2E (manual-only; NOT in CI, NOT in pre-push)
cd web && npx playwright test                      # all specs
cd web && npx playwright test tests-e2e/smoke.spec.ts
# Cross-repo field-name parity (backend schema vs iOS dispatch switch)
npm run check:ios-parity
# Stage-6 extraction regression harness (offline, no API calls; verified exit 0)
node scripts/stage6-golden-divergence.js
```

## 2. Backend suite — Jest, native ESM

Config: `jest.config.js` (repo root). Facts that bite:

| Setting | Value | Why it is that way |
|---|---|---|
| runner invocation | `node --experimental-vm-modules node_modules/jest/bin/jest.js` (the root `test` script) | Backend is native ESM (`"type": "module"`); Jest needs the VM-modules flag. Never invoke bare `jest`. |
| `testEnvironment` | `node` | |
| `roots` / `testMatch` | `src/` / `**/__tests__/**/*.test.js` | All ~204 test files live FLAT in `src/__tests__/` — the only `__tests__` dir in `src/`. Put new backend tests there. |
| `transform` | `{}` | No Babel/ts-jest. Plain ESM `.js` only. |
| `testTimeout` | **90000** (bumped 30s→90s 2026-05-27) | ESM + `jest.unstable_mockModule` cold-start: route tests observed at 32–63s under full-suite parallel load. Do not "fix" a slow first test by lowering this. |
| `maxWorkers` | `'50%'` | Module-load contention under `--experimental-vm-modules`; halves worst-case I/O queue depth. |

**How to add a backend test:**
1. File: `src/__tests__/<area>-<behaviour>.test.js` (kebab-case; look at neighbours — e.g. `dialogue-engine-rcd-entry-guard.test.js`).
2. Mocking ESM modules requires `jest.unstable_mockModule(...)` BEFORE a dynamic `await import(...)` of the module under test (standard Jest `jest.mock` does not work under native ESM). Copy the pattern from an existing route test.
3. Run just your file first (`npm test -- src/__tests__/yourfile.test.js`), then the full suite before push — pre-push runs it anyway (§4).
4. CI runs `npm test -- --coverage --ci` — same suite, plus coverage.

Backend suite size: 204 test files as of 2026-07-06; ~4952 tests as of the
2026-06-26 changelog entry (dated figure — re-count with a full run).

## 3. Web suite — Vitest + jsdom, and why every harness flag is load-bearing

Config: `web/vitest.config.ts`. Setup: `web/tests/setup.ts`. Tests live in
`web/tests/*.test.{ts,tsx}` (include glob `tests/**/*.test.{ts,tsx}`); E2E
lives in `web/tests-e2e/` deliberately OUTSIDE that glob so the two runners
never compete for files.

### 3.1 Config flags (2026-07-03 hardening — do not remove any of these)

| Flag | Why |
|---|---|
| `restoreMocks: true` | restores every `vi.spyOn` between tests |
| `clearMocks: true` | clears mock call history |
| `unstubGlobals: true` | reverts `vi.stubGlobal` (e.g. stubbed `fetch`) |
| `unstubEnvs: true` | reverts `vi.stubEnv` |
| `isolate: true` | per-file isolation (vitest default, pinned explicitly) |

All four cleanup flags default FALSE in vitest 4.1.4. Without them, spies and
stubs leak across tests → order-dependent "passes in isolation / fails in the
full run" — the exact class behind the WS7 CI break. `web/tests/harness-leak-lock.test.ts`
is the regression guard: test 1 deliberately pollutes (fake timers, stubGlobal,
stubEnv, spy), test 2 asserts everything auto-reverted. If a harness flag is
ever dropped, that file fails and names the regression. Never "fix" it by
adding manual cleanup to it.

| `testTimeout` | `5_000` — any web test over 5s is a hung async or a real-timer oversight; fail loud. Do not raise it; fix the test. |
|---|---|

**React-instance pin** (`resolve.alias` regex + `dedupe` in vitest.config.ts):
the monorepo root hoists React 19.2.3 (via `@dnd-kit`), web declares 19.2.4.
Two React copies → "Invalid hook call" from every `useRef`/`useEffect`. The
alias forces all `react`/`react-dom` imports (incl. `react/jsx-dev-runtime`)
to the web-local copy. If you see "Invalid hook call" in a web test, suspect a
new dep bypassing the alias BEFORE suspecting the component.

### 3.2 `web/tests/setup.ts` shims — the rules they impose on your tests

| Shim | Rule for your test |
|---|---|
| jest-dom matchers via `expect.extend(matchers)` (NOT the `/vitest` shorthand — jest-dom is hoisted to root `node_modules` where `vitest` can't be resolved) | Matchers like `toBeVisible()` just work; never re-import jest-dom per-file. |
| `import 'fake-indexeddb/auto'` | Bare `indexedDB` global works (PWA outbox/job-cache). Clean up with per-test `deleteDB`, not by re-stubbing the global. |
| Global `afterEach(vi.useRealTimers())` | The config cleanup flags do NOT restore fake timers — this afterEach does. You may `vi.useFakeTimers()` freely without a matching restore, but never rely on fake timers surviving into the next test. |
| **`installStorageShim` — UNCONDITIONAL Map-backed `localStorage`/`sessionStorage` replacement** | See the WS7 story below. Overriding `localStorage.setItem = () => { throw }` in a test IS supported and deterministic because the shim is a plain writable object. |

**The WS7 story (why the storage shim is unconditional):** jsdom's REAL
`Storage` can pass a "does getItem work?" guard yet silently IGNORE
per-instance method overrides like `window.localStorage.setItem = () => { throw }`.
Tests simulating quota/privacy-mode persist failures saw their override
no-op'd → the write succeeded → CI-only, order-dependent failures (locally the
old conditional guard installed the shim, so tests passed). Fix: always
install the Map-backed shim. Lesson for new tests: to simulate storage
failure, prefer `vi.spyOn(Storage-ish object, 'setItem').mockImplementation(...)`
or direct assignment on the shim — both now behave identically — and never
assume jsdom built-ins honour monkey-patching.

### 3.3 How to add a web test

1. File: `web/tests/<area>-<behaviour>.test.ts` (or `.tsx` if it renders).
   Import product code via the `@` alias (`@/lib/...`) exactly as source does.
2. Stub globals with `vi.stubGlobal('fetch', fn)` — NEVER `globalThis.fetch = fn`
   (direct assignment escapes `unstubGlobals` cleanup; converting those was
   part of the 2026-07-03 hardening).
3. Spy with `vi.spyOn`, not method reassignment on real objects.
4. Keep each test under 5s; use fake timers for debounce/interval logic.
5. Run your file, then the full web suite — 15s, no excuse to skip.

## 4. Local gates — what runs before your code leaves the machine

- `.husky/pre-commit`: `npx lint-staged` (eslint --fix + prettier on staged
  files) + a secrets grep (AWS keys, `sk-` keys, password literals) that
  exits 1 on match. `export PATH="/opt/homebrew/bin:$PATH"` first line is
  load-bearing for GUI git clients — keep it.
- `.husky/pre-push`: sources nvm best-effort → `nvm use` (.nvmrc = 20) →
  `node web/scripts/check-node.mjs` (WARN) → **`npm test && npm test --workspace=web`**.
  BOTH suites, since 2026-07-03. Before that it was backend-only, which is why
  the WS7 web breakage was never gated locally. Do not bypass with
  `--no-verify`; if pre-push is red, fix it (project rule).

## 5. Node-version discipline (the "green locally ≠ green in CI" root)

CI pins Node 20 (`deploy.yml`, 4 sites; `.nvmrc` = 20; `web/package.json`
`engines: ">=20 <21"` — scoped to web only, deliberately not root
`engine-strict`, so backend install still works on the dev box's Node 25).
jsdom/Storage behaviour differs across Node majors — that difference is what
made WS7 unreproducible locally.

`web/scripts/check-node.mjs` runs on every `npm test --workspace=web`
(`pretest`) and in pre-push: WARN-only by design (exits 0 on mismatch);
`CHECK_NODE_STRICT=1` makes it hard-fail. **If you are debugging a CI-only web
test failure, your FIRST move is `nvm use` (Node 20) and re-run** — before
reading a line of test code.

## 6. What CI blocks — and what it deliberately does NOT

Workflow: `.github/workflows/deploy.yml` (single file). As of 2026-07-06:

| CI step | Blocking? |
|---|---|
| Backend `npm test -- --coverage --ci` | **YES** |
| Web `npm run build` | **YES** |
| Web `npx vitest run` | **YES** |
| Web `npx eslint . --max-warnings=0` | **NO** — `\|\| true` |
| Web `npx tsc --noEmit` | **NO** — `\|\| true` |
| `npm audit --audit-level=high` | NO — advisory |
| Trivy image scan CRITICAL | **YES** (exit-code 1) |
| Trivy image scan HIGH | NO — advisory |
| `parity-ledger-warn` job | NO — warn-only, PR-only, `continue-on-error`, nothing `needs:` it |

Consequences you must internalize:
- **Green CI does NOT mean typeclean or lint-clean.** Before claiming either,
  run `npm run typecheck --workspace=web` yourself. Main-branch baseline may
  already carry warnings; the house standard is "zero NEW errors vs main".
- Deploy gating chain: `build-images` `needs:` both test jobs and requires
  both `success`; `deploy` `needs: build-images`. So a red `Test Frontend` on
  `main` silently SKIPS the deploy — this is exactly how the WS5×WS7
  interaction shipped nothing (see next bullet).
- **`workflow_dispatch` runs SKIP the test jobs entirely** (test jobs carry
  `if: github.event_name != 'workflow_dispatch'` and the build gate lets
  dispatch through). A manually dispatched deploy is an untested deploy —
  treat it as an emergency lever only.

**MANDATORY parallel-workstream rule** (hub CLAUDE.md; born from WS5×WS7):
when two PRs touch overlapping test files or the shared harness
(`web/tests/setup.ts`, `web/vitest.config.ts`), green-in-isolation is NOT
sufficient. After each merge to `main`, watch the full `main` CI run to green
(both suites) BEFORE merging the next. If red, fix-forward before stacking.

## 7. Wire contract tests — the Bug-I lesson

**Definition:** a wire contract test proves the backend's emitted frame and
the client's decode/apply path agree on the SAME literal field/frame name, in
one test or one enforced check — not in two per-side unit suites that can both
be green while the value silently drops.

**The Bug-I incident (field session FA361D70, 2026-04-26):** backend Stage 6
emitted schema-canonical circuit field names (`measured_zs_ohm`, `r1_r2_ohm`,
`ir_live_live_mohm`…) straight from `config/field_schema.json`; iOS dispatched
on pre-Stage-6 legacy aliases (`zs`, `r1_r2`, …). Backend tests green, iOS
tests green, 6 successful tool calls on the wire — and every circuit-scoped
reading silently vanished on the device. First fix (`e83a6017`) added a
rename bridge in the bundler; ONE DAY later it was reverted (`17470ada`)
because the durable fix was making iOS accept the canonical names natively —
leaving `field_schema.json` as the single source of truth end-to-end with NO
translation layer. Both the incident and the revert teach the same thing:
**aliases and bridges are contract debt; names must match literally, and a
check must enforce it.**

Standing enforcement:
- `npm run check:ios-parity` → `scripts/check-ios-field-parity.mjs`: diffs
  every `config/field_schema.json` field against the `case "..."` arms of iOS
  `applySonnetReadings` (reads `CertMateUnified/` — the nested sibling iOS
  repo — via relative path; run from repo root). Exit 1 on a schema field
  with no iOS case. Run it whenever you add an extractable field.
- Web-side wire round-trip tests in `web/tests/` — copy these patterns when
  adding a wire field: `observation-update-roundtrip.test.ts`,
  `chitchat-pause-wire.test.ts`, `apply-extraction-parity.test.ts`,
  `confirmation-dedupe-key.test.ts` (its hash vectors were generated FROM the
  backend mirror — cross-side fixtures, not hand-typed twice).

**Checklist for ANY new wire field or frame** (frame shapes themselves are
documented in sibling `certmate-voice-wire-protocol`):
1. Backend test asserting the emit carries the literal name/shape.
2. Web test decoding a captured/mirrored payload with that SAME literal
   (ideally share a fixture string, never re-type the name).
3. `npm run check:ios-parity` green (if it's a schema field).
4. If iOS must also change: that is a cross-platform mandate — route through
   change control (sibling `certmate-change-control`); backend is immutable
   during PWA-only work.

## 8. Stage-6 golden divergence — the extraction regression harness

`scripts/stage6-golden-divergence.js` replays golden-session fixtures through
the legacy extraction shape AND the tool-call dispatcher + bundler pipeline,
canonicalises both (STR-02 normalisation), and measures divergence.

- Offline and free: fixtures ship canned SSE streams — no Anthropic calls.
  Verified 2026-07-06: `node scripts/stage6-golden-divergence.js` → exit 0,
  0% divergence on the 5 default fixtures.
- Default fixtures: `src/__tests__/fixtures/stage6-golden-sessions/` (5
  `sample-*.json` + README). Flags: `--dir <fixtures>`, `--threshold <rate>`
  (default 0.10), `--extra <file>` (repeatable).
- Gate semantics: breach = call_divergence_rate OR session_divergence_rate
  > threshold (section rate is diagnostic only). Exit 1 on breach.
- Use it when touching `src/extraction/stage6-*`, the bundler, or the
  dispatcher: run before and after; any new divergence is a regression in the
  deterministic pipeline (model behaviour is out of scope for this harness).
- `npm run voice-test` / `npm run voice-regression` (scripts/voice-latency-bench/)
  are the LIVE-model harnesses — they cost money and belong to sibling
  `certmate-diagnostics-and-tooling`.

## 9. Playwright E2E — manual-only, know its wiring before trusting it

Config: `web/playwright.config.ts`. **NOT in CI and NOT in pre-push** (as of
2026-07-06; deferred until stability proven — comment in config). Treat E2E
as a tool you run deliberately, never as an implied gate.

- `testDir: web/tests-e2e/` (outside the vitest glob). Projects: chromium +
  webkit only (webkit = iOS Safari parity; no firefox).
- `webServer`: `PORT=3001 npx next dev --turbopack` — boots the web app
  itself; backend is NOT booted. Specs touching real API/TTS
  (`pdf-renderer-spike`, `record-tts-elevenlabs`, `ws9-acceptance-render`
  reference :3000/api) need the backend running (`npm start`) and real keys —
  check each spec's header before running.
- Mic faking (chromium launch args, required for any record-flow spec):
  `--use-fake-ui-for-media-stream` (auto-accepts the mic permission prompt) +
  `--use-fake-device-for-media-stream` (synthetic silent audio device — without
  it headless Chromium throws "Requested device not found" and the record flow
  goes `state === 'error'` on start).
- Retries: 0 local (fail fast) / 2 CI-env; workers 1 under CI env.
- Spec inventory (2026-07-06): `smoke` (harness sanity — run first),
  `record`, `record-tts-elevenlabs`, `dialog-centering`,
  `pdf-renderer-spike`, `ws9-acceptance-render`, plus
  `visual-baseline-capture.mjs` (a driver script, not a spec; needs
  credentials — user-specific, not covered here).

## 10. Acceptance-threshold discipline — parity ledger, device smokes, field sessions

`web/docs/parity-ledger.md` is the single source of truth for iOS↔web surface
parity (~396 rows as of 2026-07-02). Columns:
`id | ios-ref | web-ref | status | last-verified | phase | notes`.

Row rules (all enforced socially + by the CI warner):
- `id` is a stable slug — NEVER renumber, NEVER reuse; new rows get fresh ids.
  `web/docs/parity-ledger-files.json` maps web file paths → row ids.
- Statuses: `match` / `partial` / `missing` / `ios-only`. `backend` is RETIRED
  (2026-07-02) — no active row may carry it.
- `last-verified` = ISO date you ACTUALLY re-checked the row against current
  iOS + web source. Blank counts as stale. **Never fabricate it.**
- `scripts/check-parity-ledger.mjs` (CI job `parity-ledger-warn`, PR-only)
  warns when a touched file's rows have blank/invalid/>30-day-old
  `last-verified`. Always exits 0 — it informs, never blocks.

**Row lifecycle (the promotion path):**

```
ship the web change (suite + CI green)
  → row status `partial`, dated note naming the PENDING evidence
  → device smoke passes (real hardware: iPad Safari, iPhone A2HS,
    or ear-verify for TTS behaviour)
  → row → `match` with dated last-verified
  → (for voice/PDF/latency surfaces) field-session evidence is the
    FINAL arbiter — some rows stay `partial` until a real job validates
    them (e.g. `pdf/pdf-fidelity` until field validation)
```

Live examples as of 2026-07-06: WS2 obs-photo row `partial` awaiting iPad
Safari smoke; WS7 chrome rows `partial` awaiting iPhone A2HS smoke;
`crosscutting/uiimpactfeedbackgenerator` is PERMANENT `partial` (no iPhone
Safari Vibration API — a dated deliberate divergence, the honest way to
record "can't match"). Deliberate divergences are allowed ONLY as dated,
owner-attributed notes on the row — never silent.

**Field sessions as arbiter:** the parity program's WS8 (field test + QA
gate) gates the whole program; the open voice-latency Phase 2.2 decision
(`FINALIZER_TIMEOUT_MS` widen vs iOS local_fallback) explicitly waits for 1–2
field sessions on deployed code. Do not attempt to close such items with
bench evidence alone — propose, ship behind the existing flag/default, and
route promotion through field evidence per `certmate-change-control`.

## 11. When NOT to use this skill

| You actually need | Sibling skill |
|---|---|
| Wire frame shapes / capabilities negotiation for `/api/sonnet-stream` | `certmate-voice-wire-protocol` |
| Latency benches, analyze-session, CloudWatch, cost tracker | `certmate-diagnostics-and-tooling` |
| Deploy/CI job anatomy, ECS status, rollback | `certmate-run-and-operate` |
| MANDATORY change rules, commit/changelog/ledger governance | `certmate-change-control` |
| Node/env/workspace setup from scratch | `certmate-build-and-env` |
| Env vars and flags catalog | `certmate-config-and-flags` |
| Triage of a production symptom | `certmate-debugging-playbook` |
| History of a past investigation/revert | `certmate-failure-archaeology` |
| CCU-photo extraction accuracy evaluation | `certmate-ccu-pipeline` |
| Designing a discriminating experiment / latency budget analysis | `certmate-proof-and-analysis-toolkit` |
| The latency campaign's phased plan | `certmate-latency-campaign` |

## 12. Provenance and maintenance

Every volatile fact above, with a one-line re-verification command:

| Fact (as of 2026-07-06) | Re-verify with |
|---|---|
| Jest timeout 90000, maxWorkers 50%, testMatch, transform {} | `cat jest.config.js` |
| Backend test files flat in one dir (204 files) | `ls src/__tests__/*.test.js \| wc -l && find src -type d -name __tests__` |
| Web suite green: 125 files / 1362 tests | `npm test --workspace=web` |
| Vitest cleanup flags + isolate + React pin | `sed -n 34,81p web/vitest.config.ts` |
| setup.ts shims (jest-dom, fake-indexeddb, useRealTimers, unconditional storage shim) | `cat web/tests/setup.ts` |
| harness-leak-lock guard exists | `ls web/tests/harness-leak-lock.test.ts` |
| Pre-push runs BOTH suites | `cat .husky/pre-push` |
| Pre-commit lint-staged + secrets grep | `cat .husky/pre-commit` |
| CI lint/typecheck non-blocking, build+vitest blocking | `grep -n '\|\| true\|vitest\|npm run build' .github/workflows/deploy.yml` |
| workflow_dispatch skips test jobs | `grep -n "github.event_name != 'workflow_dispatch'" .github/workflows/deploy.yml` |
| Trivy CRITICAL blocking / HIGH advisory | `grep -n -B2 -A8 trivy-action .github/workflows/deploy.yml \| grep -n 'severity\|exit-code'` |
| Playwright not in CI/pre-push; mic-fake flags | `cat web/playwright.config.ts && grep -rn playwright .github/workflows/deploy.yml .husky/pre-push` |
| check-node WARN-only, CHECK_NODE_STRICT | `cat web/scripts/check-node.mjs` |
| Golden divergence default dir/threshold, offline exit 0 | `node scripts/stage6-golden-divergence.js \| tail -3` |
| ios-parity checker reads field_schema vs Swift switch | `sed -n 1,30p scripts/check-ios-field-parity.mjs` |
| Ledger columns, status legend, id/last-verified rules | `sed -n 1,30p web/docs/parity-ledger.md` |
| Ledger warner warn-only, 30-day staleness | `sed -n 1,45p scripts/check-parity-ledger.mjs` |
| Bug-I fix + next-day revert commits | `git log --oneline --follow -- src/__tests__/stage6-fold-circuit-fields.test.js` |
| Backend test count ~4952 (dated 2026-06-26, changelog figure — UNVERIFIED by a live run here) | `npm test 2>&1 \| tail -5` |
