# CertMate Web Rebuild — Master Fix Plan

Aggregated from 21 per-phase consolidated reviews (phases 0 → 7c) on branch `web-rebuild`.
Target surface: `web/` workspace (Next 16 App Router + React 19 + Serwist PWA) and the slice of `src/routes/` it depends on.

---

## A. Executive summary

The rebuild has shipped an impressively broad surface in a short time — scaffold, recording pipeline, capture flows, settings/admin, and a PWA foundation — and the architectural bones are sound. Reviewers repeatedly note that the **design is conservative in the load-bearing places** (NetworkOnly for RSC/Server Actions, server-gated RBAC writes, build-ID-scoped SW caches, FIFO outbox with exponential backoff). What it is **not** yet is a shipping codebase: correctness and contract gaps accumulate fastest in the seams between layers.

Seven systemic themes account for roughly 80% of all findings:

1. **Stale-closure merges when updating job state.** `JobProvider.updateJob` takes a partial object instead of a functional updater, and every downstream `apply*` helper captures `job` once. This underlies the CCU overwrite bug (5a), the document-extraction race (5b), the observation cancel-desync (5c), the inspection toggle race (3c), and the LiveFill flicker (5d).
2. **Data-contract drift between UI types, backend wire, and `@certmate/shared-types`.** `JobDetail`/`CircuitRow`/`ObservationRow`/`CCUAnalysis` (`web/src/lib/types.ts`) have diverged from the shapes `src/routes/jobs.js` actually sends, and from the canonical shared-types. Staff page reads `job.inspectors`; PDF reads `data.board.boards`; supply page encodes `earth_type` as two booleans; `saveJob` uses PATCH while backend exposes PUT. Nothing currently catches this at compile time.
3. **Async lifecycle races across the recording pipeline.** `RecordingProvider`'s `start()` awaits multiple promises without a cancellation token; `stop()` and `pause()` interleave with in-flight Sonnet reconnects; `DeepgramService` double-fires `onerror`/`onclose`; AudioWorklet sample-rate conversion is missing. Any user who double-taps Start/Stop on iOS Safari can wedge the session.
4. **RBAC depth-of-defence is missing at the middleware layer** for newer routes, and the middleware's `pathname.includes('.')` early-return bypasses auth for any dotted dynamic path. Server routes mostly re-check (`requireAdmin`) but the JWT itself does not carry `company_role`, so company-admin pages lean on client decoding that can be forged.
5. **Zero automated test coverage anywhere in the new surface.** No vitest, no RTL, no Playwright. Every reviewer notes this, across every phase. The outbox, the merge helpers, the middleware, the sign-out purge, the PDF route — all rely on manual DevTools walkthroughs.
6. **Modal/focus-trap accessibility is consistently broken.** Six modals across 5c/6a/6b/6c ship as ad-hoc `role="dialog"` divs with no focus trap, no Esc handler, no focus restoration, no `inert` on the background, and `window.confirm` is still used for destructive actions. This is a WCAG 2.1 AA keyboard-trap violation on every one of them.
7. **PWA durability contract is advertised but not enforced.** The 7c outbox reuses read-cache IDB helpers that swallow errors, so a quota failure on `enqueueSaveJobMutation` returns success with nothing persisted. Offline revisit also paints pre-edit data because neither the queued-offline branch nor the replay-success branch warms the read cache.

Secondary themes: viewport zoom lock (layout.tsx), touch targets below 44×44 in trash/back-link icons, missing `prefers-reduced-motion` on brand animations, overclaiming copy on `/offline` and error boundary, duplicated `LabelledSelect`/`MultilineField`/`Pill` components, and token drift between `design-tokens.ts` and `globals.css`.

**Bottom line:** no architectural U-turns are required. A disciplined 5-wave fix sequence (see §F) — kill-list first, contracts + tests second, recording hardening third, RBAC + admin a11y fourth, PWA + polish fifth — gets this from "promising scaffold" to "shippable to a paying inspector" without scope creep.

---

## B. Kill list — P0s only

Surgical cut: only defects that (a) cause data loss, (b) break a load-bearing contract, (c) expose auth/RBAC holes, or (d) silently corrupt persisted state. Complexity: **S** ≤ 1hr, **M** 1–4hr, **L** ≥ 1 day.

| # | Defect | File:line | Complexity |
|---|--------|-----------|------------|
| 1 | `saveJob` sends PATCH; backend exposes PUT only. Every edit save 404s or falls to generic handler. | `web/src/lib/api-client.ts:278` + `src/routes/jobs.js:651` | S |
| 2 | `JobProvider.updateJob(partial)` takes an object, not a functional updater — callers using it inside async handlers merge against a stale snapshot. Also clobbers `isDirty` when a parent re-provides. | `web/src/lib/job-context.tsx:50-58` | S |
| 3 | `applyCcuAnalysis` mutates `ccu_analysis` without scoping to the current active board; multi-board jobs get CCU photos cross-bleeding. Also maps `board_model` → `board_name` incorrectly and dereferences `spd` without null guard. | `web/src/lib/recording/apply-ccu-analysis.ts:119-120, 143-149, 357-359` | M |
| 4 | Middleware `pathname.includes('.')` early-return bypasses BOTH auth AND admin gating for any dotted dynamic URL (e.g. job slug containing `.`). | `web/src/middleware.ts:37-44` | S |
| 5 | `/settings/company/dashboard` is not gated by the middleware's admin check; company-admin-only page is reachable by any authenticated user (server-side `requireAdmin` on its API calls limits blast radius, but the UI renders employee PII first). | `web/src/middleware.ts:58` | S |
| 6 | `RecordingProvider` hardcodes Deepgram `certificateType=EICR` so EIC recordings send the wrong schema upstream and Sonnet extracts into the wrong fields. | `web/src/lib/recording-context.tsx:183-215` | S |
| 7 | AudioWorklet emits at the device sample rate but `sendInt16PCM` ships to Deepgram without resampling to 16 kHz; transcription quality degrades silently on any device that is not 16 kHz native (most Macs, many iOS builds). | `web/src/lib/recording/deepgram-service.ts:132` + `web/src/lib/recording-context.tsx:404-423` | M |
| 8 | `DeepgramService.ws.onerror` and `.onclose` both call `handleClose`; every transient close fires two reconnect attempts and doubles bill-able connect storms. | `web/src/lib/recording/deepgram-service.ts:86-100` | S |
| 9 | Deepgram subprotocol uses `token, <jwt>` (comma-space) — Deepgram expects `['token', '<jwt>']` subprotocol array; current wire format is rejected by Deepgram's newer validation. | `web/src/lib/recording/deepgram-service.ts:74` | S |
| 10 | Sonnet session JWT is passed in the query string. iOS `rules/mistakes.md` explicitly requires this, but the server route in `src/routes/keys.js:318-396` still has a raw-key fallback path, meaning a misconfigured client will get a 500 instead of an auth rejection. Tighten to JWT-only. | `web/src/lib/recording/sonnet-session.ts:290-296` + `src/routes/keys.js:318-396` | M |
| 11 | PWA outbox `enqueueSaveJobMutation` is documented to throw on IDB failure, but reuses `wrapTransaction` which resolves on `onerror`/`onabort`. A quota error returns "success" with nothing persisted — **silent data loss on offline save**. | `web/src/lib/pwa/outbox.ts:164` + `web/src/lib/pwa/job-cache.ts:153-175` | M |
| 12 | Outbox replay routes every failure (including 4xx) through `markMutationFailed` with 10× retry and FIFO-stop; a single permanently-rejecting row stalls the entire queue (cross-job) for the full ~18min backoff window. | `web/src/lib/pwa/outbox-replay.ts:87-93, 110-124` | M |
| 13 | `queueSaveJob` offline/5xx branch does not update the IDB `job-detail` cache, and replay-success does not warm it either. Offline revisit paints pre-edit state — the exact UX failure 7c was sold as solving. | `web/src/lib/pwa/queue-save-job.ts:78-89` + `web/src/lib/pwa/outbox-replay.ts:103-109` | M |
| 14 | `SwUpdateProvider` reloads unconditionally on `controllerchange` — fires on first-ever SW install, reloading the page while the user is mid-edit. | `web/src/lib/pwa/sw-update-provider.tsx:108-113` | S |
| 15 | `src/routes/settings.js` reads settings keyed by `req.user.id` per user, but the UI at `/settings/company` is for the **company**; two admins in the same company see each other's state drift apart. | `web/src/app/settings/company/page.tsx:64` + `src/routes/settings.js:99, 133, 315, 358` | M |
| 16 | Login page redirects to any `?next=` value without host check — open redirect; trivially weaponisable in phishing flows. | `web/src/app/login/page.tsx:42, 56` | S |
| 17 | `company_name: ""` silent data corruption — edit page sends empty string instead of `null` when admin clears the field. | `web/src/app/settings/admin/users/[userId]/page.tsx:157` | S |

**Total: 17 P0s.** Estimate: ~3 engineer-days if taken as a single sweep.

---

## C. Phase-by-phase fix table

Severity: P0 blocking, P1 must-fix pre-main, P2 polish / nice-to-have. File:line cites the consolidated review's primary location; see the matching `web/reviews/consolidated/phase-*.md` for the full reviewer split.

### Phase 0 — scaffold

| Sev | Finding | File:line |
|---|---|---|
| P1 | Viewport `maximumScale: 1` + `userScalable: false` disables zoom (WCAG 1.4.4). | `web/src/app/layout.tsx:20-27` |
| P2 | `design-tokens.ts` and `globals.css` both hard-code the brand palette; drift inevitable. Pick one as source of truth. | `web/src/lib/design-tokens.ts` + `web/src/app/globals.css` |
| P2 | Visual-verify harness (`verify-visual.ts`) screenshots empty shells and reports "pass"; bypasses the stated purpose. | `web/scripts/verify-visual.ts:10, 34, 97-130` |
| P2 | No ESLint/Prettier config at `web/` workspace root; formatting drifts across phases. | `web/package.json` |

### Phase 1 — auth + middleware

| Sev | Finding | File:line |
|---|---|---|
| P0 | `pathname.includes('.')` bypasses auth + admin + cache-header for any dotted dynamic URL. | `web/src/middleware.ts:37-44` |
| P0 | Login open-redirect via unvalidated `?next=`. | `web/src/app/login/page.tsx:42, 56` |
| P1 | JWT signature not verified in middleware (UX-only guard); acceptable ONLY if every server route re-checks — audit needed. | `web/src/middleware.ts:18-26` |
| P1 | Auth token stored in `localStorage` (XSS-exposed). Migrate to HttpOnly secure SameSite=Lax cookie. | `web/src/lib/api-client.ts` + `web/src/app/login/page.tsx` |
| P1 | `/settings/company/dashboard` not gated at middleware; only protected by server-side `requireAdmin` on its fetches. | `web/src/middleware.ts:58` |
| P2 | `api.login` response shape not validated (assumes `{token, user}`); a backend typo surfaces as undefined auth. | `web/src/lib/api-client.ts` |

### Phase 2 — API client + JobProvider + dashboard/job layout

| Sev | Finding | File:line |
|---|---|---|
| P0 | `saveJob` uses PATCH; backend is PUT only. | `web/src/lib/api-client.ts:278` + `src/routes/jobs.js:651` |
| P0 | `JobProvider.updateJob` partial-merge signature; caller must pass a functional updater to avoid stale-closure clobber. Also resets `isDirty` on every `<JobProvider job=...>` re-provide. | `web/src/lib/job-context.tsx:50-58` |
| P0 | `JobDetail`/`CircuitRow`/`ObservationRow`/`CCUAnalysis` shape drift vs backend wire + `@certmate/shared-types`. | `web/src/lib/types.ts:192-207, 211-215, 216-230, 268-274` |
| P1 | `ApiError` throws raw `res.text()`; backend returns `{error:"…"}` JSON, so users see literal JSON blobs. | `web/src/lib/api-client.ts:62-64` |
| P1 | `dashboard/page.tsx` reads cache inside an async render without stabilising — a second navigation can paint stale then flash fresh. | `web/src/app/dashboard/page.tsx:64, 82, 84` |
| P1 | `job/[id]/layout.tsx` paints cached detail while a non-cached pass is in flight; 401 detection is a regex against message text. | `web/src/app/job/[id]/layout.tsx:65, 82` |
| P2 | Dashboard classifies errors via regex string match instead of `ApiError.status`. | `web/src/app/dashboard/page.tsx:82` |
| P2 | `api-client` error paths don't differentiate `TypeError` (network) vs `ApiError` (HTTP); caller branches are brittle. | `web/src/lib/api-client.ts` whole file |

### Phase 3a — installation + supply + extent

| Sev | Finding | File:line |
|---|---|---|
| P1 | `installation/page.tsx` computes `due_date` from `inspection_date` via client math; must match backend helper to avoid drift. | `web/src/app/job/[id]/installation/page.tsx:98-107` |
| P1 | Staff card links to `/settings/staff` instead of the job's staff tab. | `web/src/app/job/[id]/installation/page.tsx:351-358` |
| P1 | `supply/page.tsx` encodes `earth_type` as two booleans (`tn_s`, `tn_c_s`) then reconstructs a string — round-trip lossy; iOS persists the string directly. | `web/src/app/job/[id]/supply/page.tsx:144-160` |
| P1 | `extent/page.tsx` writes `consumer_unit_upgrade: true/false` but the backend field is a free-text string. | `web/src/app/job/[id]/extent/page.tsx:24-33, 40-44` |
| P2 | `MultilineField` duplicated across installation/supply/extent. Extract. | `web/src/app/job/[id]/installation/page.tsx:370-399` |
| P2 | Supply "N/A" chip renders as separate button; screen reader announces twice. | `web/src/app/job/[id]/supply/page.tsx:338-351` |

### Phase 3b — board + circuits list

| Sev | Finding | File:line |
|---|---|---|
| P0 | Active-board `activeId` drifts between `useState` seed and `boards[0]?.id`; deleting the active board leaves a zombie id in downstream tabs. | `web/src/app/job/[id]/board/page.tsx:64-68` |
| P0 | Circuit duplicate-`circuit_ref` collisions when a board import uses the same numbering scheme; list renderer key-collides and React warns + mis-updates. | `web/src/app/job/[id]/circuits/page.tsx:110` |
| P1 | Board pills have no `aria-pressed`; screen reader can't announce selected board. | `web/src/app/job/[id]/board/page.tsx:102-139` |
| P1 | Board textarea field has no associated label. | `web/src/app/job/[id]/board/page.tsx:301` |
| P1 | Circuit list filter orphans: when `board_id` filter is applied, "add circuit" writes without `board_id`, so new row disappears from view. | `web/src/app/job/[id]/circuits/page.tsx:98-100` |
| P1 | Reverse cross-board move (drag-drop) drops `board_id` instead of swapping. | `web/src/app/job/[id]/circuits/page.tsx:121` |
| P2 | Trash button on row is 24×24 — below 44×44 touch target. | `web/src/app/job/[id]/circuits/page.tsx:378-383` |
| P2 | Delete handler is stubbed — `onClick={() => {}}`. | `web/src/app/job/[id]/circuits/page.tsx:240` |

### Phase 3c — inspection (schedule of inspections)

| Sev | Finding | File:line |
|---|---|---|
| P1 | Shape-drift against `InspectionRow` in shared-types; new fields rendered but not persisted. | `web/src/app/job/[id]/inspection/page.tsx:42-52` |
| P1 | Toggle handler captures stale `rows` snapshot; rapid clicks drop updates. | `web/src/app/job/[id]/inspection/page.tsx:72-81` |
| P2 | Switch component lacks `aria-checked`. | `web/src/app/job/[id]/inspection/page.tsx:269-286` |
| P2 | Renders ~120 rows without memoisation; scroll jank on low-end iPhones. | `web/src/app/job/[id]/inspection/page.tsx:301-364` |

### Phase 4a — recording provider + overlay shell

| Sev | Finding | File:line |
|---|---|---|
| P0 | `RecordingProvider.start()` awaits several promises without a cancellation token; `stop()` called during `start()` leaves mic + WS half-initialised. | `web/src/lib/recording-context.tsx:147-160` |
| P1 | `pause()` destroys the Sonnet session instead of suspending it — resume re-initialises and loses context. | `web/src/lib/recording-context.tsx:290-305` |
| P1 | RecordingOverlay has `role="dialog"` with no focus trap, no Esc, no focus restoration. | `web/src/components/recording/recording-overlay.tsx:53-61` |
| P1 | Overlay `aria-label` is static ("Recording controls") while state is dynamic (Active/Dozing/Sleeping). | `web/src/components/recording/recording-overlay.tsx:82-85` |
| P2 | Question strip has no `aria-live="polite"`. | `web/src/components/recording/recording-overlay.tsx:155-179` |
| P2 | Transcript bar lacks accessible name; screen reader reads children verbatim. | `web/src/components/recording/transcript-bar.tsx:28-55` |

### Phase 4b — Deepgram service

| Sev | Finding | File:line |
|---|---|---|
| P0 | Subprotocol format wrong (`"token, <jwt>"` single string vs `['token', '<jwt>']` array). | `web/src/lib/recording/deepgram-service.ts:74` |
| P0 | `onerror`/`onclose` both call `handleClose` — double reconnect. | `web/src/lib/recording/deepgram-service.ts:86-100` |
| P1 | `sendInt16PCM` does not resample to 16 kHz; transmits at device sample rate. | `web/src/lib/recording/deepgram-service.ts:132` |
| P1 | `KeepAlive` frames sent unconditionally — no back-pressure check when WS `bufferedAmount` is high. | `web/src/lib/recording/deepgram-service.ts:239-249` |
| P2 | Reconnect uses `wss://…/api/stream-deepgram`; env var fallback silently points at localhost in prod if unset. | `web/src/lib/api-client.ts:144-147` |
| P2 | `onerror` log doesn't include close-code context. | `web/src/lib/recording/deepgram-service.ts:151` |

### Phase 4c — Sonnet session

| Sev | Finding | File:line |
|---|---|---|
| P0 | Sonnet JWT must be URL query-param only (iOS WS-upgrade header strip rule); backend fallback to raw API key must be removed. | `web/src/lib/recording/sonnet-session.ts:290-296` + `src/routes/keys.js:318-396` |
| P1 | `session_resume` field dropped on reconnect; backend treats every reconnect as a fresh session and Sonnet context is lost. | `web/src/lib/recording/sonnet-session.ts:247-279` |
| P1 | Reconnect backoff fixed 2s; should be exponential with jitter. | `web/src/lib/recording/sonnet-session.ts` |

### Phase 4d — recording-context orchestration

| Sev | Finding | File:line |
|---|---|---|
| P0 | `certificateType` hardcoded `'EICR'`; EIC jobs send wrong type to Sonnet. | `web/src/lib/recording-context.tsx:183-215` |
| P1 | `endSession` doesn't await Sonnet's final `session_end` ack before tearing down. | `web/src/lib/recording-context.tsx:290-305` |
| P2 | `certificateType` derived inline; promote to context selector. | `web/src/lib/recording-context.tsx:183-215` |

### Phase 4e — AudioWorklet + ring buffer + sleep manager

| Sev | Finding | File:line |
|---|---|---|
| P0 | Ring buffer assumes 16 kHz while AudioContext is usually 48 kHz; PCM sent upstream is playback-rate, not capture-rate. | `web/src/lib/recording-context.tsx:404-423` |
| P1 | `getUserMedia` uses bare `sampleRate` values; `rules/mistakes.md` requires `{ ideal }` object to avoid iOS Safari `OverconstrainedError`. | `web/src/lib/recording-context.tsx:347-353` |
| P2 | `SleepManager` thresholds hard-coded; lift to settings. | `web/src/lib/recording/sleep-manager.ts` |
| P2 | No `prefers-reduced-motion` override on pulse animation. | `web/src/components/recording/recording-overlay.tsx` |

### Phase 5a — CCU photo capture

| Sev | Finding | File:line |
|---|---|---|
| P0 | `applyCcuAnalysis` writes to `ccu_analysis` without board scoping — multi-board jobs cross-bleed. | `web/src/lib/recording/apply-ccu-analysis.ts:357-359` |
| P0 | `board_model` → `board_name` mismap (wrong target field). | `web/src/lib/recording/apply-ccu-analysis.ts:119-120` |
| P1 | SPD dereferenced without null guard (`analysis.spd.type`). | `web/src/lib/recording/apply-ccu-analysis.ts:143-149` |
| P1 | CCU questions not cleared on re-analyse; stale questions persist. | `web/src/app/job/[id]/circuits/page.tsx:335-339` |
| P1 | CCU capture button uses stale closure over `job.id`. | `web/src/app/job/[id]/circuits/page.tsx:130-145` |
| P2 | `ccu_analysis` merged then immediately overwritten by Sonnet; race unless 3-tier priority enforced per-field. | `web/src/lib/recording/apply-ccu-analysis.ts` |

### Phase 5b — document extraction

| Sev | Finding | File:line |
|---|---|---|
| P0 | `applyDocumentExtraction` captures `job` at call-time; async extraction resolves against stale snapshot. | `web/src/lib/recording/apply-document-extraction.ts:176` |
| P1 | Circuits silently dropped when extraction returns an oversized set (hard cap without warning toast). | `web/src/lib/recording/apply-document-extraction.ts:374-382` |
| P1 | Clone guard at `:205` is dead code (always true). | `web/src/lib/recording/apply-document-extraction.ts:205` |
| P2 | `structuredClone` fallback missing for Safari ≤15. | `web/src/lib/recording/apply-document-extraction.ts:236-238` |

### Phase 5c — observation photos

| Sev | Finding | File:line |
|---|---|---|
| P0 | Cancel-sheet desync: `observations` state not rolled back on cancel; uploaded-but-unsaved photos accumulate. | `web/src/components/observations/observation-sheet.tsx:107-152` |
| P1 | Save button not disabled while upload in flight; double-submit creates duplicate observation rows. | `web/src/components/observations/observation-sheet.tsx:399` |
| P1 | Observation photo component fetches blob on every render — no cache, no request dedup. | `web/src/components/observations/observation-photo.tsx:46-75` |
| P2 | Trash icon 24×24 below touch target. | `web/src/components/observations/observation-sheet.tsx:374-382` |
| P2 | Logo upload MIME allow-list excludes `image/webp`. | `web/src/lib/api-client.ts:401` + `src/routes/settings.js:329, 364` |

### Phase 5d — LiveFillView flash animation

| Sev | Finding | File:line |
|---|---|---|
| P1 | LiveFill selector re-subscribes on every render; flashes flicker. | `web/src/lib/live-fill-store.ts` |
| P1 | No `prefers-reduced-motion` escape hatch. | `web/src/components/live-fill/live-fill-view.tsx` |
| P2 | Flash duration hard-coded 600ms; lift to token. | `web/src/components/live-fill/live-fill-view.tsx` |

### Phase 6a — /settings hub + Staff

| Sev | Finding | File:line |
|---|---|---|
| P1 | Signature canvas state bleeds across inspector switches (cached DataURL not cleared). | `web/src/components/settings/signature-canvas.tsx:153` + `web/src/app/settings/staff/[inspectorId]/page.tsx:66` |
| P1 | Signature dirty-flag not set on stroke; save button stays disabled. | `web/src/components/settings/signature-canvas.tsx:220-228` |
| P1 | Setting `is_default: false` on the last default inspector leaves job with no default inspector; no invariant check. | `web/src/app/settings/staff/[inspectorId]/page.tsx:134-143` + `web/src/app/settings/staff/page.tsx:56` |
| P1 | Signature canvas resize not debounced — clears canvas mid-stroke on viewport resize. | `web/src/components/settings/signature-canvas.tsx:133-150` |
| P1 | Staff page relies on `job.inspectors` which is not a real backend field. | `web/src/app/job/[id]/staff/page.tsx:71-72, 105-153` |
| P1 | Delete-inspector dialog lacks focus trap. | `web/src/app/settings/staff/page.tsx:283-310` |
| P2 | Toggle switch focus ring missing. | `web/src/app/settings/staff/[inspectorId]/page.tsx:255-261` |
| P2 | Date input rendered as `type="text"` with manual regex validation. | `web/src/app/settings/staff/[inspectorId]/page.tsx:410-414` |
| P2 | Signature canvas `role="img"` should be `role="application"` when in draw mode. | `web/src/components/settings/signature-canvas.tsx:256-261` |
| P2 | Signature draw uses setState per-point; high CPU on iPhone SE. | `web/src/components/settings/signature-canvas.tsx:196-200` |
| P2 | Reset-password sheet inherits ad-hoc dialog pattern (same trap gap). | `web/src/app/settings/staff/[inspectorId]/page.tsx:439-499` |

### Phase 6b — company settings + company dashboard

| Sev | Finding | File:line |
|---|---|---|
| P0 | `/settings/company` settings route reads keyed by `req.user.id`, not `company_id`; two admins see divergent state. | `web/src/app/settings/company/page.tsx:64` + `src/routes/settings.js:99, 133, 315, 358` |
| P0 | `/settings/company/dashboard` not in middleware admin-gate list. | `web/src/middleware.ts:58` |
| P1 | Plaintext password briefly stored in React state during reset flow. | `web/src/app/settings/company/dashboard/page.tsx:275` |
| P1 | Tab panels all mounted simultaneously; unmount inactive tabs. | `web/src/app/settings/company/dashboard/page.tsx:135, 155` |
| P1 | Company dashboard reset-password modal has no focus trap. | `web/src/app/settings/company/dashboard/page.tsx:325, 380, 419, 423, 524` |
| P1 | JWT does not carry `company_role` claim; UI reads from localStorage user object (forgeable). | `src/auth.js:121` |
| P1 | Logo uploader does not clean up temp files on error path. | `src/routes/settings.js:270-275` |
| P1 | `uploadBytes` return ignored; a failed upload is treated as success. | `src/routes/settings.js:329` |
| P2 | File-extension allow-list regex anchored incorrectly. | `src/routes/settings.js:364` |
| P2 | `employee_id` filter applied post-pagination; pages are ragged. | `src/routes/companies.js:302-339` |
| P2 | Generated password is only 48-bit entropy. | `src/routes/companies.js:199` |
| P2 | Wire format for `jobs` in `src/routes/jobs.js:575-592` differs from shared-types. | `src/routes/jobs.js:575-592` |
| P2 | Backend missing PATCH alias for save (see kill list #1). | `src/routes/jobs.js:651` |

### Phase 6c — system-admin user management

| Sev | Finding | File:line |
|---|---|---|
| P0 | `company_name: ""` silent data corruption on clear. | `web/src/app/settings/admin/users/[userId]/page.tsx:157` |
| P1 | `adminUpdateUser` type omits `company_id` + `company_role` despite handoff parity promise and backend whitelist acceptance. | `web/src/lib/api-client.ts:533` + `web/src/app/settings/admin/users/[userId]/page.tsx:297` |
| P1 | Reset-password sheet is `role="dialog"` with no focus trap / no Esc / no restoration — WCAG keyboard trap. | `web/src/app/settings/admin/users/[userId]/page.tsx:439-499` |
| P1 | `ApiError` raw JSON blob shown to users (see Phase 2 P1). | `web/src/lib/api-client.ts:62-64` |
| P2 | Edit page does up to 20 sequential page fetches to find one user. Add backend `/api/admin/users/:id`. | `web/src/app/settings/admin/users/[userId]/page.tsx:84-107` |
| P2 | `MAX_PAGES = 20` cap = false "User not found" for users beyond row 1000. | `web/src/app/settings/admin/users/[userId]/page.tsx:84` |
| P2 | `isSelf` compared against URL param; harden to `row.id`. | `web/src/app/settings/admin/users/[userId]/page.tsx:73` |
| P2 | No confirm modal for `is_active: false`. | `web/src/app/settings/admin/users/[userId]/page.tsx:286-293` |
| P2 | `window.confirm` for unlock — blocked in iOS standalone PWA. | `web/src/app/settings/admin/users/[userId]/page.tsx:182` |
| P2 | `LabelledSelect` / `Pill` / `formatShortDate` duplicated across 3 files. | `web/src/app/settings/admin/users/new/page.tsx:222-269` vs `[userId]/page.tsx:504-551` |
| P2 | List page blanks on pagination (sets `users:null` per offset change). | `web/src/app/settings/admin/users/page.tsx:50-68` |
| P2 | Stale error banner after recovered fetch. | `web/src/app/settings/admin/users/page.tsx:50, 73` |
| P2 | `router.replace` called in render body. | `web/src/app/settings/admin/users/new/page.tsx:54` |

### Phase 7a — PWA foundation

| Sev | Finding | File:line |
|---|---|---|
| P0 | Middleware `pathname.includes('.')` bypass (see kill list #4). | `web/src/middleware.ts:37-44` |
| P1 | `skipWaiting: true` is safe only on first deploy; second deploy hot-swaps SW mid-edit. Removed in 7b but retain as P1 against 7a in isolation. | `web/src/app/sw.ts:75-79` |
| P1 | `/offline` page copy overclaims "will sync automatically" before outbox existed. Still slightly overclaims even post-7c until the queued-visible fix lands. | `web/src/app/offline/page.tsx:31-34` |
| P1 | `error.tsx` says "We've logged this" but no server error sink exists. | `web/src/app/error.tsx:96-99` |
| P1 | `reloadOnOnline: true` discards in-memory edits on every connectivity flap. | `web/next.config.ts:24-26` |
| P2 | RSC probe could add `Accept: text/x-component` secondary check. | `web/src/app/sw.ts:53-61` |
| P2 | Font matcher doesn't check origin; reordering could CacheFirst cross-origin. | `web/src/app/sw.ts:121-133` |
| P2 | `NEVER_CACHE_PATHS` regex is dead weight in Next 16. | `web/src/app/sw.ts:43` |
| P2 | Install button text/aria divergence. | `web/src/components/pwa/install-button.tsx:38-41` |

### Phase 7b — SW update handoff + IDB read-through + offline indicator + iOS ATHS hint

| Sev | Finding | File:line |
|---|---|---|
| P0 | `SwUpdateProvider` reloads on first-ever `controllerchange` (install), blowing away mid-edit state. | `web/src/lib/pwa/sw-update-provider.tsx:108-113` |
| P1 | iOS install hint misses iPadOS UA (reports as Mac). | `web/src/components/pwa/ios-install-hint.tsx:73` |
| P1 | `localStorage.setItem` inside try-less branch — throws in private mode. | `web/src/components/pwa/ios-install-hint.tsx:82` |
| P1 | Label hard-codes "iPhone"; shows wrong copy on iPad. | `web/src/components/pwa/ios-install-hint.tsx:103` |
| P1 | Offline-indicator `aria-label` says "You are offline" even when reconnecting. | `web/src/components/layout/offline-indicator.tsx:54` |
| P2 | IDB read-through cache helpers swallow `onerror`/`onabort` (separately a P1 for 7c). | `web/src/lib/pwa/job-cache.ts:153-175` |
| P2 | Duplicate `aria-label` on iOS install hint. | `web/src/components/pwa/ios-install-hint.tsx:140` |

### Phase 7c — offline mutation outbox

| Sev | Finding | File:line |
|---|---|---|
| P0 | `enqueueSaveJobMutation` reuses error-swallowing wrapper; quota error silently loses data. | `web/src/lib/pwa/outbox.ts:164` + `web/src/lib/pwa/job-cache.ts:153-175` |
| P0 | Replay worker 4xx head-of-line stall across unrelated jobs for ~18 min. | `web/src/lib/pwa/outbox-replay.ts:87-93, 110-124` |
| P0 | Queued-offline branch doesn't update read cache; replay-success also doesn't warm it. | `web/src/lib/pwa/queue-save-job.ts:78-89` + `web/src/lib/pwa/outbox-replay.ts:103-109` |
| P1 | No tests for backoff schedule, FIFO+stop, 4xx terminal, enqueue-fail-loudly, sign-out purge, cache-warm on replay. | new modules |
| P2 | `listPendingMutations()` called twice per pass. | `web/src/lib/pwa/outbox-replay.ts:76, 127-142` |
| P2 | `now` captured once before loop; refresh per iteration. | `web/src/lib/pwa/outbox-replay.ts:77` |
| P2 | Sign-out cancellation races in-flight `attempt()` after `clearJobCache`. | `web/src/lib/pwa/outbox-replay.ts:103-125, 170-178` |
| P2 | `generateId` fallback collision-prone, non-uuid-shaped. | `web/src/lib/pwa/outbox.ts:109-119` |
| P2 | `by-user` index unused; leave a TODO for 7d. | `web/src/lib/pwa/job-cache.ts:114` |
| P2 | Use `add` not `put` for enqueue (surfaces uuid collision). | `web/src/lib/pwa/outbox.ts:163` |
| P2 | Single-variant `OutboxOp` should be a `switch` with exhaustive default. | `web/src/lib/pwa/outbox-replay.ts:105` |
| P2 | `lastError` lacks attempt-number context. | `web/src/lib/pwa/outbox.ts:237` |
| P2 | DB constants re-exported from two files; pick one source of truth for 7d. | `web/src/lib/pwa/outbox.ts:268` |
| P2 | Unknown errors in `queueSaveJob` treated as transient; rethrow programming bugs. | `web/src/lib/pwa/queue-save-job.ts:76-89` |


---

## D. Systemic / cross-cutting fixes

Each bucket collapses a family of per-phase findings into a single remediation.

### D1. Stale-closure state merges
**Pattern:** `setState(merge(currentSnapshot, patch))` where `currentSnapshot` was captured in an outer scope.
**Instances:** JobProvider.updateJob (2), applyCcuAnalysis (5a), applyDocumentExtraction (5b), observation-sheet (5c), inspection toggle (3c), CCU capture button (5a), LiveFill selectors (5d).
**Fix:** Change `updateJob(partial)` to `updateJob(updater: (j) => Partial<JobDetail>)`. Convert every `apply*` helper to return `(prev) => merged` and call via the updater form. Add an ESLint rule (`react-hooks/exhaustive-deps` strict + a custom rule flagging `setJob(patch)` with object literal) to prevent regression.
**Est:** M. One refactor in `job-context.tsx` plus sweep of 6 call sites.

### D2. Data-contract drift client ↔ backend ↔ shared-types
**Pattern:** `web/src/lib/types.ts` defines UI-local shapes that re-declare backend fields with different nullability, naming, and envelope.
**Instances:** JobDetail/CircuitRow/ObservationRow/CCUAnalysis (2); `job.inspectors` read by Staff page (6a); `data.board.boards` read by PDF page (3b); `earth_type` two-booleans (3a); `consumer_unit_upgrade` bool vs string (3a); `adminUpdateUser` type drop of `company_id`/`company_role` (6c); saveJob PATCH vs PUT (2); `jobs` wire shape (6b).
**Fix:**
1. Delete `web/src/lib/types.ts` duplicates. Re-export from `@certmate/shared-types` and make that the only source.
2. Add a thin `web/src/lib/adapters/job.ts` that converts backend wire → UI view-model + back. All network calls go through it; no `JobDetail` ever leaves the adapter layer unvalidated.
3. Add a `zod` schema per wire shape; parse on ingress, fail loud on drift.
4. Backend: add PUT → PATCH alias for `/api/jobs/:id`; unify `earth_type` to a single string enum.
**Est:** L. One-day refactor across ~15 files, but unblocks future phases.

### D3. Async lifecycle / cancellation races in recording pipeline
**Pattern:** Awaited promises resolve into destroyed-context scope, no session token to discriminate.
**Instances:** RecordingProvider start/stop/pause (4a, 4d); Deepgram reconnect onerror+onclose (4b); Sonnet session_resume loss (4c); AudioWorklet teardown (4e); outbox sign-out race (7c).
**Fix:** Introduce a monotonic `sessionId` (or `AbortController`) at `start()`; every callback checks `if (sessionId !== currentSessionRef.current) return;`. Use a single `status` state machine (`idle → starting → active → pausing → paused → stopping → idle`) and refuse transitions that aren't on the edge.
**Est:** L. Touches ~8 files in `web/src/lib/recording/**`.

### D4. RBAC depth-of-defence
**Pattern:** Middleware trusts unsigned JWT; server re-checks; but UI surfaces that leak PII before server-side 403 render are exposed.
**Instances:** `/settings/company/dashboard` (6b); `pathname.includes('.')` bypass (7a, 1); `company_role` missing from JWT (6b); localStorage token (1).
**Fix:**
1. Sign `company_role` into JWT on login (`src/auth.js:121`).
2. Middleware: explicit static-asset allow-list replacing the `.` heuristic; explicit admin-path matcher covering `/settings/company/**` AND `/settings/admin/**`.
3. Migrate auth token to HttpOnly SameSite=Lax secure cookie (12-month plan — Phase 8+).
4. Add a `verifyJwt()` HMAC check in middleware using the same secret via env; keep it off the critical path if secret unavailable (fail open to NextAuth-style redirect).
**Est:** M for 1+2, L for 3.

### D5. Modal / focus-trap accessibility
**Pattern:** Hand-rolled `<div role="dialog">` without focus trap, Esc handler, focus restoration, `inert` on background, or first-focus move.
**Instances:** RecordingOverlay (4a); ResetPasswordSheet in admin (6c) + staff (6a) + company dashboard (6b); ObservationSheet (5c); inspector-delete confirm (6a).
**Fix:** Adopt **Radix Dialog** (`@radix-ui/react-dialog`) and retrofit all six sites. It handles focus trap, restore, Esc, `aria-modal`, portal, and scroll lock. Replace `window.confirm` calls with the same component. Stage as a single "modal parity" PR.
**Est:** M. Adding a dependency + ~6 file touches.

### D6. Test coverage baseline (zero → "enough to gate main")
**Pattern:** No vitest, no RTL, no Playwright.
**Fix:** Stand up three layers:
1. **Unit (vitest + RTL + `fake-indexeddb`)** for pure helpers (`apply-ccu-analysis`, `apply-document-extraction`, `apply-extraction`, `outbox`, `outbox-replay`, adapter layer, `NumberNormaliser` parity).
2. **Integration (RTL + MSW)** for JobProvider.updateJob stale-closure regression, dashboard cache race, login redirect rules.
3. **E2E (Playwright)** for login → dashboard → job → record (stubbed WS) → save; admin user CRUD; offline save + revisit-visible after replay.
Add `npm test --workspace=web` to pre-push hook.
**Est:** L (3–5 days for first wave; grows in parallel with fixes).

### D7. PWA durability + read-cache write-through
**Pattern:** Outbox reuses read-cache wrappers that swallow errors; queue/replay paths do not project pending mutation onto cached read.
**Fix:** (1) Introduce `wrapTransactionStrict` that rejects on `onerror`/`onabort`. (2) Use it in enqueue/markFailed/markPoisoned paths; keep the lenient wrapper only for reads. (3) In `queueSaveJob` queued-not-synced branch, overlay the patch onto the IDB `job-detail` cache. (4) In replay success, call `putCachedJob`. (5) Add a 4xx short-circuit → `markMutationPoisoned`. (6) Add tests per D6.
**Est:** M.

### D8. Touch targets < 44×44 on destructive/icon buttons
**Instances:** trash icons on circuits (3b), observations (5c); back-link icons on admin pages (6c).
**Fix:** Introduce `<IconButton size="md">` with padding box guaranteeing 44×44 hit area while keeping the 24×24 glyph. Sweep replace.
**Est:** S.

### D9. Viewport zoom + prefers-reduced-motion
**Instances:** `layout.tsx` viewport lock (0); pulse animations on RecordingOverlay (4e), install hint (7b), LiveFill flash (5d), offline page cm-orb (7a).
**Fix:** Remove `maximumScale`/`userScalable`. Add a global CSS block:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
```
**Est:** S.

### D10. Truthfulness-of-copy
**Instances:** `/offline` "will sync automatically" (7a — partly true post-7c but still overclaims until queued-visible fix); error boundary "We've logged this" (7a). Install button label divergence (7a).
**Fix:** Drop sync promise from offline page until kill-list #13 ships. Replace "We've logged this" with "If this keeps happening, please let us know." Align install button visible text vs aria-label.
**Est:** S.

### D11. Component duplication
**Instances:** `LabelledSelect`, `Pill`, `formatShortDate` (6c ×3); `MultilineField` (3a ×3); `FormRow` equivalents across settings pages.
**Fix:** Extract to `web/src/components/ui/`. Gate further phases on using the shared variants.
**Est:** S.

### D12. Error surface / API error parsing
**Instances:** Kill list #1 cause (ApiError raw body); dashboard regex error classifier; 401 regex in job layout.
**Fix:** Update `request()` to JSON-parse when `content-type: application/json` and expose `ApiError.body` + `ApiError.status`. Replace string-match classifiers with `status`-based branching.
**Est:** S.

---

## E. Test plan

Priorities align with D6. Listed by phase so the fix-wave engineer can bolt tests to the corresponding fix.

### E1. Unit (vitest + RTL + fake-indexeddb)

| Target | Cases |
|---|---|
| `job-context.tsx` | (a) `updateJob(fn)` merges against latest state; (b) rapid successive updates don't clobber; (c) re-provide doesn't reset `isDirty` |
| `apply-ccu-analysis.ts` | (a) scopes to active board; (b) null-safe `spd`; (c) `board_model` → `board_name` mapping; (d) questions cleared on re-analyse |
| `apply-document-extraction.ts` | (a) operates on `(prev) =>` updater; (b) oversized circuit list warns + caps; (c) clone path Safari ≤15 |
| `apply-extraction.ts` | (a) design section routed to design tab; (b) observation dedupe key respects `id`, not index |
| `outbox.ts` | (a) `enqueueSaveJobMutation` rejects on IDB error; (b) FIFO order preserved; (c) sign-out purge atomic; (d) `markMutationPoisoned` |
| `outbox-replay.ts` | (a) backoff schedule; (b) 4xx → poison, not retry; (c) sign-out cancellation drops in-flight result; (d) cache warmed on replay success |
| `queue-save-job.ts` | (a) inline 2xx updates cache; (b) offline branch overlays patch on cache; (c) ApiError 4xx rethrows; (d) TypeError queues |
| `job-cache.ts` | (a) read-through returns cached on miss-after-hit; (b) strict wrapper rejects, lenient wrapper resolves |
| `api-client.ts` | (a) ApiError parses JSON body; (b) saveJob uses PUT; (c) subprotocol format for Deepgram |
| `deepgram-service.ts` | (a) single reconnect per close; (b) 16 kHz resample correctness; (c) KeepAlive gated on bufferedAmount |
| `sonnet-session.ts` | (a) session_resume present on reconnect; (b) JWT-only auth (no raw key fallback) |
| adapters (new) | Round-trip wire ↔ UI for each shape |

### E2. Integration (RTL + MSW)

| Target | Cases |
|---|---|
| Dashboard | (a) paints cache then hydrates fresh; (b) 401 → login redirect; (c) offline pill appears on `navigator.onLine=false` |
| Job detail layout | (a) cache race resolved; (b) 401 routed via `ApiError.status`, not regex |
| Login | (a) `?next=/dashboard` allowed; (b) `?next=https://evil.com` rejected; (c) `?next=//evil.com` rejected |
| Staff edit | (a) signature dirty flag on first stroke; (b) resize mid-stroke doesn't clear; (c) last-default invariant blocks false |
| Admin user edit | (a) company_id + company_role persist; (b) company_name "" → null; (c) ApiError JSON message shown human-readable |
| Middleware | (a) dotted dynamic path hits auth; (b) `/settings/company/dashboard` denied for non-admin |

### E3. E2E (Playwright)

| Flow | Cases |
|---|---|
| Auth | login → dashboard, logout purges outbox + caches |
| Job edit | open job → edit circuits → save → reload → persists |
| Record (stubbed WS) | start → pause → resume → stop; overlay keyboard-trapped; ATHS pulse respects prefers-reduced-motion |
| Admin | create user → reset password → unlock lockout → deactivate (with confirm) |
| Offline | disconnect → edit → reload (queued patch visible) → reconnect → replay → cache warmed |
| PWA | `/sw.js` 200; dashboard/job produce no SW cache entries; update toast after new build; first-install does NOT reload |

### E4. Harness housekeeping

- Add `fake-indexeddb` to web devDeps.
- Add `msw` for integration layer.
- Fix `verify-visual.ts` to assert at least one known selector exists per screen.
- Pre-push: `npm run lint && npm test --workspace=web`.

---

## F. Recommended sequencing (5 waves)

Each wave ships as its own PR against `web-rebuild`; only Wave 5's final commit is eligible for promotion to `main`.

### Wave 1 — Kill-list correctness (~3 engineer-days)
All 17 P0s. No new features, no refactor beyond what a fix requires. Ship atomic commits per kill-list row so revert is surgical.
- Gate: all P0 tests from E1/E2 pass locally; manual Playwright smoke.

### Wave 2 — Contract alignment + test scaffolding (~5 engineer-days)
- D2 (adapters + zod + shared-types reuse).
- D6 (vitest + RTL + msw + fake-indexeddb stood up).
- D12 (ApiError JSON parse + status classifier).
- Backfill unit tests for every Wave 1 fix so they can't regress.
- Gate: no `JobDetail` declared outside adapter layer; CI runs tests.

### Wave 3 — Recording pipeline hardening (~5 engineer-days)
- D3 (sessionId guards, status state machine).
- 4b KeepAlive back-pressure, close-code logging.
- 4c session_resume + exponential backoff.
- 4e `{ideal}` constraints per `rules/mistakes.md`.
- Add Playwright record-flow E2E with Deepgram WS stub.
- Gate: recordings survive 2× start/stop tornado + network flap; no duplicate reconnects.

### Wave 4 — RBAC + admin UX + modal a11y (~4 engineer-days)
- D4 (JWT company_role + middleware admin matcher + signature verify).
- D5 (Radix Dialog sweep across 6 modal sites; replace `window.confirm`).
- 6c admin-user edit: company_id/company_role editable, confirm modal on deactivate, backend `/api/admin/users/:id`.
- 6b: per-company settings key fix (kill list #15 rider).
- Gate: WCAG 2.1 AA keyboard-only walk through all modals; all RBAC E2E green.

### Wave 5 — PWA durability + a11y polish + copy + deduplication (~3 engineer-days)
- D7 (strict wrappers + cache overlay + 4xx poison + tests).
- D8 (IconButton sweep).
- D9 (viewport + prefers-reduced-motion global).
- D10 (copy truthfulness).
- D11 (shared component extraction).
- Gate: promote `web-rebuild` → `main` once Playwright + vitest pass + smoke on TestFlight companion.

**Total engineer-budget:** ~20 working days. Parallelisable across 2 engineers to ~12 calendar days if Wave 2 (contracts) lands before Waves 3/4 start.

---

## G. Open questions for the lead

1. **iOS wire-format parity for `earth_type`, `consumer_unit_upgrade`, `jobs` envelope** — iOS reads these today. If we fix the web wire format, does iOS also need to move, or do we need a versioned `Accept` header and dual-write transitional?
2. **`@certmate/shared-types` as the single source of truth** — any objections to collapsing `web/src/lib/types.ts` into it, or should the web keep view-model types separately (adapter boundary)?
3. **HttpOnly cookie auth migration** — Phase 8 or deferred? Current localStorage posture is a known XSS exposure; decision drives whether Wave 4 includes cookie work or not.
4. **Deepgram token contract** — current code branches on JWT vs raw key. iOS uses subprotocol JWT. Can we drop the raw-key backend fallback entirely (breaking change for any legacy client), or do we keep it and log a deprecation?
5. **Focus-trap library choice** — Radix Dialog (recommended, brings portal + a11y) vs `react-focus-lock` (minimal, bring-your-own portal) vs hand-rolled. Preference?
6. **`reloadOnOnline: true` policy** — keep (7a default) and accept in-memory loss on flap, or scope to `/offline` only (requires custom Serwist config)?
7. **Minimum iOS Safari support** — some fixes (e.g. `structuredClone` fallback for doc extraction) depend on this. Currently implicit ≥16; confirm?
8. **Backend `/api/admin/users/:id` endpoint** — can we add this so 6c edit page stops doing 20-page scans? Blocking for a clean 6c fix.
9. **Plaintext-password-in-state for company-admin reset flow (6b)** — acceptable as tradeoff with redaction-on-unmount, or must we switch to a one-shot reveal pattern?
10. **Tests in pre-push hook** — confirmed as blocking-on-fail, or warn-only until Wave 5?

---

*Generated from 21 per-phase consolidated reviews in `web/reviews/consolidated/`. Every line citation corresponds to a specific reviewer finding in that directory.*
