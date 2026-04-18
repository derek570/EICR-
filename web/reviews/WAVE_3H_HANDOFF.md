# Wave 3H Handoff — Playwright E2E harness + record flow spec

**Branch:** `wave-3h-playwright-record-e2e`
**Commits:** `0def74f` (harness + smoke) · `504224a` (WS stub + auth fixtures) · `f72edf9` (record spec + Chromium mic flags)
**Scope:** `WEB_REBUILD_COMPLETION.md` §2.1 "Playwright E2E — record flow" · gate 9 (partial — record flow only; other E3 flows remain).
**Status:** First Playwright harness live. Smoke spec covers chromium + webkit. Record flow spec covers chromium only (documented WebKit gap). Vitest unchanged at 72/72 · `tsc --noEmit` clean · `npm run lint` unchanged (0 errors, 6 pre-existing warnings).

---

## Harness layout

```
web/
├── playwright.config.ts          # chromium + webkit projects, webServer on :3001
├── tests-e2e/
│   ├── smoke.spec.ts             # loads /login, asserts email/password labels
│   ├── record.spec.ts            # 3 tests: start/pause/resume/stop, focus trap (fixme), reduced-motion
│   └── fixtures/
│       ├── auth.ts               # JWT mint + cookie/localStorage seed + HTTP stubs
│       └── deepgram-ws-stub.ts   # IIFE stub for Deepgram + Sonnet WebSockets
├── package.json                  # new `e2e` script
└── .gitignore                    # /test-results + /playwright-report excluded
```

Key config choices:

- **`testDir: './tests-e2e'`** — outside vitest's `tests/` root, so the two runners never fight over the same files. `vitest.config.ts` already globs `tests/**/*.test.{ts,tsx}` only; no exclude changes needed.
- **`baseURL: 'http://localhost:3001'`** — matches the project CLAUDE.md hub, and keeps port 3000 free for the backend.
- **`webServer`** — boots `PORT=3001 npx next dev --turbopack`; reuses an already-running dev server locally (`reuseExistingServer: !process.env.CI`).
- **Projects:** chromium + webkit only. iOS parity is the whole reason this app exists; Firefox would be install weight for no coverage we care about.
- **Chromium launch flags:** `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`. Without the device flag, headless Chromium reports "Requested device not found" and the record flow never leaves `requesting-mic`. With it, `getUserMedia` resolves to a virtual audio track the AudioWorklet can pipe.
- **Retries:** 0 local, 2 CI. Fail fast on dev, absorb one-in-a-hundred WS handshake flakes on CI.

## WS stub design

Playwright's native `page.routeWebSocket` can inspect WS frames but cannot plausibly synthesise Deepgram reply frames. The stub instead replaces `window.WebSocket` via `context.addInitScript({ content: DEEPGRAM_WS_STUB })` before any product code evaluates.

The stub:

- Intercepts connections to `api.deepgram.com` and `/api/sonnet-stream`; everything else falls through to the native WebSocket (Next HMR, etc.).
- Deepgram side: on the first binary audio frame, emits one interim + one final `Results` message so the overlay flips from "Listening…" to a real transcript. `CloseStream` is accepted silently; a `close()` call fires a clean `close` event with code 1000.
- Sonnet side: on the first `transcript` JSON frame, emits one `extraction_complete` envelope so the UI clears its "extracting" state. `pause` / `resume` / `session_start` frames are accepted silently.
- Exported as a string literal (not a compiled helper) so `addInitScript({ content })` serialises deterministically — no bundler step needed for the harness.

Rationale for page-context stub (vs. `routeWebSocket`): replacing the constructor is unambiguous — every `new WebSocket(url, protocols)` in product code lands on our class with no framing/subprotocol semantics to fake at the wire level.

## Specs covered

| Spec | Scenarios | Chromium | WebKit |
|---|---|---|---|
| `smoke.spec.ts` | Login page renders with Email + Password labels | ✓ | ✓ |
| `record.spec.ts` | Start → Pause → Resume → Stop; no error toast after stop | ✓ | skipped |
| `record.spec.ts` | Overlay focus trap (4 focusables, wraps on Tab) | `.fixme` (waits for Wave 4 D5) | skipped |
| `record.spec.ts` | `prefers-reduced-motion` signal reaches the app | ✓ | skipped |

**Passing runs:** 4 passed, 4 skipped (3 webkit record-flow tests + 1 chromium `.fixme`).

### Why focus trap is `.fixme` not a passing test

The current overlay is a raw `<div role="dialog">` with no focus trap; Tab escapes to the page-behind chrome (dashboard link, tab nav, FAB buttons). Wave 4 D5 (Radix Dialog sweep) implements the trap. The spec body is already written so the Wave 4 agent unskips on the same PR that adds the trap — no test rewriting required.

### Why record flow is Chromium-only

- WebKit rejects `grantPermissions(['microphone'])` with "Unknown permission".
- WebKit has no equivalent of Chromium's `--use-fake-device-for-media-stream` flag.
- Stubbing `navigator.mediaDevices.getUserMedia` with a fake stream doesn't work because `AudioContext.createMediaStreamSource()` needs a real MediaStream with active tracks — and faking one at the object level on WebKit causes the subsequent audio graph to silently no-op.

The smoke test still runs on WebKit so any iOS-parity regression in the basic chrome (login, auth gate) surfaces.

## How to run locally

```bash
cd web
# First-time setup only:
../node_modules/.bin/playwright install chromium webkit

# Every run:
npm run e2e                               # both projects, all specs
npm run e2e -- --project=chromium         # chromium only
npm run e2e -- smoke.spec.ts              # just the smoke spec
npm run e2e -- --ui                       # Playwright UI mode for authoring
```

Playwright binaries hoist to `node_modules/.bin/playwright` at the repo root (workspace hoisting), not `web/node_modules/.bin/`. The `npm run e2e` npm script inside `web/` does the right thing — you'd only ever invoke the binary directly for `playwright install`.

## How to run on CI

The harness is not yet wired into `.github/workflows/`. When it is (Phase 8 gate-tightening), the CI job needs to:

1. `npm ci` at the repo root (hoists Playwright).
2. `npx playwright install --with-deps chromium webkit` (Linux needs system deps; `--with-deps` pulls them).
3. `npm run e2e --workspace=web`.
4. Publish `test-results/` on failure so traces survive the run. `trace: 'on-first-retry'` in the config means every retry captures a trace automatically.

Deliberately NOT on pre-push yet — Playwright is ~5s boot + per-spec browser spawn; the Wave 5 gate-tightening task should opt it in once the suite is wider.

## Verification

```
$ cd web && ./node_modules/.bin/vitest run
 Test Files  8 passed (8)
      Tests  70 passed | 2 todo (72)

$ cd web && ../node_modules/.bin/tsc --noEmit
# clean

$ cd web && npm run lint
# 0 errors, 6 pre-existing warnings (unchanged from Wave 2a/3a)

$ cd web && npm run e2e
  ✓  chromium › smoke.spec.ts › login page renders (895ms)
  ✓  webkit › smoke.spec.ts › login page renders (928ms)
  ✓  chromium › record.spec.ts › start → pause → resume → stop transitions cleanly (1.5s)
  ✓  chromium › record.spec.ts › ATHS pulse respects prefers-reduced-motion (1.2s)
  4 skipped
  4 passed (3.4s)
```

No new lint warnings introduced by the harness — the one transient warning seen during development (unused `USER_ID` const) was removed before the first commit.

## Remaining gaps

### Gate 9 — record flow

- **Focus trap** (`.fixme`): waits on Wave 4 D5 (Radix Dialog sweep).
- **WebKit coverage:** see "Why record flow is Chromium-only". Options to close:
  - Playwright 1.60+ roadmap item — WebKit mic permission parity (watch-only).
  - Run WebKit specs against `npm start` + a local `xmobile`-style virtual audio device (out of scope for Wave 3).
- **Reduced-motion tightening:** the current assertion only checks the media query reaches the app. Wave 5 D9 lands the global `prefers-reduced-motion` stylesheet block — tighten the assertion then to check the overlay ring's computed `animation-duration` resolves to 0.

### Other E3 flows (not in this wave)

From `FIX_PLAN.md` §E E3, still uncovered by E2E:

| Flow | Notes |
|---|---|
| Login + role-based redirect | Fixture in `tests-e2e/fixtures/auth.ts` already primes auth; a dedicated login spec can reuse it to test the happy path + 401 redirect classifier. |
| Job edit + save | Needs a debounced-save stub that acks the PUT. `buildJobFixture` is already reusable. |
| Admin — user list → edit → deactivate | Needs Radix Dialog modal coverage post-D5. |
| Offline → edit → reload queued patch → reconnect → replay | Needs Playwright `context.setOffline(true)` + outbox stub. Highest ROI after record flow; pairs with Wave 5 D7. |
| PWA install + SW update handoff | Needs `pwa.spec.ts`; exercise the sonner toast + SKIP_WAITING path. |

### Harness maturity

- **Pre-push hook**: deferred to Wave 5 per the scope constraint.
- **Test fixtures drift**: `buildJobFixture` is typed against `web/src/lib/types.ts:JobDetail`. If the zod v3/v4 split lands (mini-wave 4.5) and the types collapse into `@certmate/shared-types`, the fixture import path updates to follow — that's the only harness-facing change.
- **Visual regression**: not in scope; Wave 5 could add `toHaveScreenshot()` checks against the overlay once the design is stable post-D5.

---

## File inventory

**Added:**
- `web/playwright.config.ts` — chromium + webkit projects, webServer on :3001
- `web/tests-e2e/smoke.spec.ts` — login page renders
- `web/tests-e2e/record.spec.ts` — record flow (3 tests)
- `web/tests-e2e/fixtures/auth.ts` — JWT mint, localStorage + cookie seed, HTTP stubs
- `web/tests-e2e/fixtures/deepgram-ws-stub.ts` — browser-side WS interceptor
- `web/reviews/WAVE_3H_HANDOFF.md` — this doc

**Modified:**
- `web/package.json` — `e2e` script
- `web/.gitignore` — `/test-results` + `/playwright-report` + `/playwright/.cache`
- `package-lock.json` — Next.js SWC platform binaries (incidental to `npm install`)

**Product code changes:** none. No data-testid additions; every spec assertion resolves against the app's own a11y contract (`aria-label`, role, accessible name).

---

## Handoff to the next wave

The next agent picking up E2E coverage should:

1. Read this doc + `WEB_REBUILD_COMPLETION.md` §2.1.
2. Pick an E3 row from the "Remaining gaps" table.
3. Reuse `fixtures/auth.ts` + `fixtures/deepgram-ws-stub.ts` verbatim. If a new HTTP surface needs stubbing, add a sibling helper next to `stubRecordFlowApi()` rather than growing that one function.
4. Keep the route-registration order rule in mind: catch-all first, specific routes after (see `stubRecordFlowApi` header comment).
5. When Wave 4 D5 lands, flip the `.fixme` on the focus-trap test to a regular `test()` — the body is already written.

The harness is deliberately minimal. Resist the urge to add fancy page-object abstractions until there are 3+ specs; a thin fixture + plain locator calls is easier to read and debug.
