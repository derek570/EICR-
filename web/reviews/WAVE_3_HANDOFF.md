# Wave 3 Handoff — Recording hardening (test-focused slice)

**Branch:** `web-rebuild`
**Merges:**
- `wave-3b-component-dedupe` — D11 shared-component extraction (refactor)
- `wave-3a-msw-replay-tests` — MSW integration tests for offline replay worker (tests)
- `wave-3c-deepgram-ws-tests` — DeepgramService regression tests behind a fake WS (tests)

**Scope delta vs Wave 2b's "Recommended next wave":** delivered the three sub-items the Wave 2b handoff called out (3a/3b/3c). **Not** delivered in this wave: FIX_PLAN §F's original Wave 3 (D3, 4b, 4c, 4e + Playwright) — that's functional recording-pipeline work and stays queued for a later wave.

**Status:** 72/72 (70 pass + 2 `it.todo`) · `tsc --noEmit` clean · `npm run lint` 0 errors, 6 pre-existing warnings (unchanged since Wave 2a).

---

## Why three sub-waves in parallel

Wave 2b's handoff named three independent sub-items (D11 de-dupe, MSW replay tests, Deepgram WS tests). None depended on another; all three were scoped as additive; all three carry a risk of ballooning in a single-context run. Running them as three concurrent subagents in isolated worktrees meant:

- Each agent started with a clean context window large enough to read FIX_PLAN, the Wave 2b handoff, and the full surface under test without truncation pressure.
- Parallel wall-clock — three problems solved in the time of the longest one.
- Isolation kept merge conflict surface to `package.json` / `package-lock.json` only (the two test waves each added a devDep). Auto-resolved cleanly.
- Clean commit provenance: each sub-wave is 2 commits on its own branch, merged as a `--no-ff` commit with a detailed body. Revert surface is surgical.

Merge order was deliberate: 3b (pure refactor, zero deps) → 3a (adds `msw`) → 3c (adds `jest-websocket-mock`). The dep-adding merges were last so any conflict would surface on package-lock, not spread across callsite edits.

---

## Sub-wave summaries

The canonical detail lives in each sub-wave's own handoff. Quick index:

| Sub-wave | Handoff doc | Lines added | Tests added |
|---|---|---|---|
| 3a MSW replay | [`WAVE_3A_HANDOFF.md`](./WAVE_3A_HANDOFF.md) | +545 | +5 (5 integration cases) |
| 3b D11 dedupe | [`WAVE_3B_HANDOFF.md`](./WAVE_3B_HANDOFF.md) | +385 / −345 (net +40) | 0 (behaviour-preserving) |
| 3c Deepgram WS | [`WAVE_3C_HANDOFF.md`](./WAVE_3C_HANDOFF.md) | +474 | +13 + 2 `it.todo` |

### 3a — MSW integration tests (`outbox-replay.integration.test.tsx`)

Drives the outbox → replay → cache-warm round trip through MSW-mocked HTTP. Adapter-typed fixtures (Wave 2b) keep wire-shape drift a load-time failure.

| Case | Asserts |
|---|---|
| Happy path | Offline enqueue → online replay → queue drains → `putCachedJob` with post-save payload; write-through merges without clobbering unrelated fields. |
| 4xx poison | 422 moves head to `poisoned`; FIFO advances; `attempts` stays at 0 (permanent rejection doesn't burn the transient-retry budget). |
| 5xx backoff | 503 increments `attempts`, pushes `nextAttemptAt` forward, preserves `lastError`, does not poison; `hitCount === 1` (no head-of-batch spin). |
| Sign-out mid-flight | Unmount during in-flight fetch leaves later queued rows untouched. |
| FIFO order | Two patches for the same jobId replay in enqueue order. |

**Design calls documented in 3a's handoff:**
- `mountHook` via `createRoot` instead of RTL's `renderHook` — monorepo React-instance pinning issue (root hoists 19.2.3, web declares 19.2.4; CJS `require('react')` picked up the wrong copy → "Invalid hook call"). Inline `createRoot` keeps every React import on the Vite-aliased web-local copy. Worth reading before writing more integration tests.
- No `vi.useFakeTimers()` on the 5xx test — fake timers starve `waitForOutbox`'s IDB poll; relies on `BASE_BACKOFF_MS` + `hitCount` guard instead.

### 3b — D11 component de-dupe

| Extracted | New location | Sites migrated |
|---|---|---|
| `formatShortDate` | `web/src/lib/format.ts` | 3 imports, 5 JSX usages, 3 inline defs deleted |
| `<Pill>` | `web/src/components/ui/pill.tsx` | 3 imports, 10 JSX usages, 3 inline defs deleted |
| `<LabelledSelect>` | `web/src/components/ui/labelled-select.tsx` | 2 imports, 3 JSX usages, 2 inline defs deleted |
| `<MultilineField>` | `web/src/components/ui/multiline-field.tsx` | 3 imports, 9 JSX usages, 3 inline defs deleted |

**Divergences merged losslessly via opt-in props** (detail in 3b's handoff):
- `Pill.inline` — default `false`; one admin page needed `inline-flex`, others didn't.
- `Pill` colour palette widened to union `blue|green|red|amber|neutral` (no existing callsite breaks).
- `MultilineField.showCount` — default `false`; only `extent` wraps in a counter row.
- `LabelledSelect` retains `disabled:cursor-not-allowed`.

**Deferred:** `FormRow` — no actual `FormRow` exists in the web tree (zero grep hits). FIX_PLAN mentioned it speculatively; future wave scope when a FormRow actually appears.

### 3c — DeepgramService regression tests

15 tests (13 pass, 2 `it.todo`) using `jest-websocket-mock@^2.5.0` (+ `mock-socket@^9.3.0`).

| Contract row | Cases | Result |
|---|---|---|
| (a) Single reconnect per close | 4 (error+close double-fire; clean close; abnormal close; guard reset on reconnect) | ✅ |
| (b) 16 kHz resample correctness | 6 (32k→16k; 48k ramp; 44.1k fractional lerp; 16k passthrough; ±1/−1 clamp; zero-length no-op) with ±1 LSB tolerance | ✅ |
| (c) KeepAlive gated on `bufferedAmount` | 2 `it.todo` — see blocker below | ⏸ |
| Idle-based KeepAlive gate (regression guard) | 3 | ✅ |

**Library decision:** `jest-websocket-mock` installs a drop-in global `WebSocket` via `mock-socket` — no testability seam needed on `deepgram-service.ts`. Hand-rolled alternative (~60–80 lines of EventTarget scaffolding) was not needed. Vitest 4 compatibility verified with a smoke spike before committing.

**Product code untouched** — `deepgram-service.ts` is byte-identical to `web-rebuild`.

---

## Bugs surfaced (not fixed — by design)

Both sub-wave test sets ran test-only by contract. One real defect surfaced:

### KeepAlive is not gated on `ws.bufferedAmount`

- Location: `web/src/lib/recording/deepgram-service.ts:254-267`
- Already known: FIX_PLAN §C Phase 4b P1 line 144
- Test surface: 3c's two `it.todo` placeholders cross-reference this. They can be promoted to full tests once the fix lands.
- Double blocker per 3c's handoff:
  1. Product code doesn't read `bufferedAmount` today.
  2. `mock-socket` hard-codes `bufferedAmount` to 0 — so even after the product fix, the test needs either a hand-rolled fake WS with mutable `bufferedAmount` or a constructor-level seam on `DeepgramService`.
- Fixer picks up in the functional Wave 3 (§F original scope) or Wave 4b.

**No other defects surfaced.** The `errorEmitted` reconnect guard, the resample math, the outbox poison/backoff/FIFO semantics, and the idle-based KeepAlive gate all behave as specified.

---

## Verification (merged branch, after `npm install`)

```
$ ./node_modules/.bin/vitest run
 Test Files  8 passed (8)
      Tests  70 passed | 2 todo (72)

$ ./node_modules/.bin/tsc --noEmit -p web/tsconfig.json
# clean

$ cd web && npm run lint
# ✖ 6 problems (0 errors, 6 warnings)
# 6 pre-existing, unchanged since Wave 2a. Tracked for Wave 4 polish.
```

Test surface growth: Wave 1 (32) → Wave 2a (32) → Wave 2b (52) → **Wave 3 (70 + 2 todo)**.

---

## Why this approach (meta)

**Why tests before fixes for the recording pipeline.** FIX_PLAN §F Wave 3 proper (D3 + 4b/4c/4e + Playwright) is where the functional reconnect-state-machine and KeepAlive back-pressure fixes land. Shipping regression coverage *before* touching that code means the fixer has a net to catch any behaviour regression, and the `it.todo` stubs for the KeepAlive gating give them a concrete checklist.

**Why D11 landed alongside the test waves.** D11 is a pure refactor with zero dep changes and zero behaviour changes; letting it live indefinitely on `web-rebuild` as "someday" would guarantee the fifth copy of `<Pill>` lands before it ever gets extracted. Bundling it with the test-wave merge costs one extra merge commit and pays back with every future admin/recording page.

**Why the parallel-agent pipeline succeeded.** Three fresh context windows, three scopes that don't touch each other's files (aside from package.json — a known, trivial conflict), explicit `do not change product code` contracts on 3a and 3c, and `isolation: "worktree"` for commit safety. This is the pattern to reuse for Wave 4 (see "Recommended next").

---

## Remaining known gaps (genuinely deferred)

- **KeepAlive `bufferedAmount` gating** — product fix + promote the 2 `it.todo` stubs. Tracked under FIX_PLAN 4b.
- **Functional Wave 3 per FIX_PLAN §F** — D3 (sessionId guards + status state machine), 4b (KeepAlive back-pressure + close-code logging), 4c (session_resume + exponential backoff), 4e (`{ideal}` constraints from `rules/mistakes.md`), Playwright record-flow E2E with Deepgram WS stub. Still the right next functional unit.
- **FormRow extraction** — skipped because no real FormRow exists. Add when one appears.
- **6 lint warnings** — unchanged since Wave 2a; still queued for Wave 4 polish.
- **Observability sink for `parseOrWarn` drifts** (Wave 2b deferral, still open).
- **`@certmate/shared-types` zod v3/v4 split** (Wave 2b deferral, still open).

---

## Recommended next wave

### Option 1 — Functional Wave 3 (per FIX_PLAN §F)
Picks up where this test-focused slice left off:
- **D3** — sessionId guards + explicit status state machine on `deepgram-service`.
- **4b** — KeepAlive gated on `bufferedAmount`; close-code logging; promotes the 2 `it.todo` stubs.
- **4c** — `session_resume` on reconnect + exponential backoff.
- **4e** — `{ ideal: value }` constraints in `getUserMedia` per `rules/mistakes.md`.
- **Playwright E2E** with a Deepgram WS stub driving record → pause → resume → stop.

Good parallelisation shape: 4b and 4c both touch `deepgram-service.ts` and must be sequential; D3 and 4e can parallel. Playwright is its own subagent.

### Option 2 — Wave 4 (RBAC + modal a11y)
Per FIX_PLAN §F Wave 4:
- **D4** — JWT `company_role` + middleware admin matcher + signature verify.
- **D5** — Radix Dialog sweep across 6 modal sites; replace `window.confirm`.
- **6c** admin-user edit: `company_id`/`company_role` editable, confirm modal on deactivate, backend `/api/admin/users/:id`.
- **6b** per-company settings key fix.

Good fit for the three-agent pattern again (D4, D5, 6b/6c as three independent subagents).

### Which first?
Recommend **Option 1** — the test coverage we just shipped has a shelf life. The regression net is sharpest against the code it was written for, and the Wave 3 functional fixes will directly flip the 2 `it.todo` stubs to real tests. Wave 4 is a clean fit for the same parallel pattern afterwards.

---

## On the autonomous-phase question

The user asked whether phases can run autonomously with a fresh context per phase. The Wave 3 pipeline is the pattern:

1. **Parent session** reads the latest handoff, identifies the next wave's independent sub-items, fires one subagent per sub-item via `Agent` with `isolation: "worktree"`.
2. **Each subagent** starts with a fresh context window, gets an explicit prompt (scope, context docs to read, constraints, gates, commit rules, handoff deliverable), implements, commits, writes its handoff doc, returns a summary.
3. **Parent** merges the branches, runs combined gates, writes the unified wave-level handoff.

Promotion path when this pattern earns trust:
- Wrap the parent loop in `loop`/`schedule` so it runs every N hours from a *truly* fresh Claude Code instance — `loop 4h find the latest WAVE_*_HANDOFF.md on web-rebuild, implement the Recommended next wave, commit, write a new handoff`.
- Each scheduled run spawns its own subagents; genuinely fresh context at every level.
- Terminate when the latest handoff's Recommended next wave is empty.

Keep it opt-in per wave until we've validated two more runs of this shape.

---

## File inventory (Wave 3 aggregate)

**Added:**
- `web/src/components/ui/labelled-select.tsx`
- `web/src/components/ui/multiline-field.tsx`
- `web/src/components/ui/pill.tsx`
- `web/src/lib/format.ts`
- `web/tests/msw-server.ts`
- `web/tests/outbox-replay.integration.test.tsx`
- `web/tests/deepgram-service.test.ts`
- `web/reviews/WAVE_3A_HANDOFF.md`
- `web/reviews/WAVE_3B_HANDOFF.md`
- `web/reviews/WAVE_3C_HANDOFF.md`
- `web/reviews/WAVE_3_HANDOFF.md` (this doc)

**Modified:**
- `web/src/app/job/[id]/{design,extent,installation}/page.tsx` — import shared `MultilineField`, delete inline copies.
- `web/src/app/settings/admin/users/{page,[userId]/page,new/page}.tsx` — import shared `Pill`/`LabelledSelect`/`formatShortDate`, delete inline copies.
- `web/src/app/settings/company/dashboard/page.tsx` — import shared `formatShortDate`, `Pill`.
- `web/package.json` — `msw@^2.x`, `jest-websocket-mock@^2.5.0` added to devDeps.
- `web/vitest.config.ts` — MSW integration test config hooks.
- `package-lock.json` — regenerated via merge + `npm install`.

---

Wave 3 (test-focused slice) landed on `web-rebuild`. Functional Wave 3 (FIX_PLAN §F) or Wave 4 is the right next unit. Merge pattern + subagent handoff pipeline validated for future waves.
