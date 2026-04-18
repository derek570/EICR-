# Phase 6c Review — System-Admin User Management

**Commit:** `bc11914`
**Scope:** `web/src/app/settings/admin/users/*` (3 pages, 1207 LOC net) + 5 new methods in `web/src/lib/api-client.ts` + 2-line `web/src/app/settings/page.tsx` tweak to unlock the hub card.
**Reviewer stance:** Read-only; no files modified. Analysis is against the committed tree and live backend in `src/routes/admin-users.js`.

---

## 1. Summary

Phase 6c lands the iOS admin CRUD surfaces as a three-route sub-tree (`list`, `new`, `[userId]`) plus five well-documented API client methods. The implementation honours the handoff verbatim: no delete button, no audit-log UX, no company picker, pagination envelope always requested, self-edit guards mirrored. Code is tidy and the JSDoc on each page explains the non-obvious choices (scan-pages-to-load, stable-nowMs, reset-as-modal) — this is a good baseline for maintainability.

Correctness is broadly sound but there are a handful of real bugs that want fixing before promotion to `main`: error messages surfaced to the user are raw JSON bodies (P1, affects every endpoint), the self-edit guard spoofs via the `id` URL param (P1), the `company_name` field is sent as `''` rather than omitted when cleared (P1 data correctness), and there is no confirmation dialog for a system-admin toggling another admin's `is_active: false` — the only other destructive action (unlock) does use `window.confirm`. No P0 RBAC holes: middleware + `requireAdmin` + `isSystemAdmin` layers compose correctly and every write lives under `/api/admin/users` which is server-gated.

---

## 2. Alignment with Handoff

| Handoff item | Implemented | Notes |
|---|---|---|
| 5 API-client methods, always send limit+offset | Yes | `api-client.ts:500-579` |
| List route paginated, 50 per page, Prev/Next | Yes | `page.tsx:38, 176-205` |
| Row pills: role / active / locked / company-role | Yes | `page.tsx:247-266` |
| Create route with ≥8 char client guard | Yes | `new/page.tsx:58-60, 133-147` |
| Edit route scans pages to load row | Yes | `[userId]/page.tsx:80-107` |
| Self-edit guard disables role + is_active | Yes | `[userId]/page.tsx:271, 289` |
| Reset-password modal, two-phase form→success | Yes | `[userId]/page.tsx:397-500` |
| Unlock inline, conditional on locked_until | Yes | `[userId]/page.tsx:335-357` |
| No delete button | Yes | Honoured |
| Settings hub card unlocked | Yes | `settings/page.tsx` diff drops `disabled`/`disabledLabel` |
| Audit log surfaced | Intentionally deferred | Backend `logAction` fires on create/update/reset/unlock — no read UI per handoff |
| Company picker | Intentionally deferred | Raw UUID field only |
| Email notification on create | Intentionally deferred | Admin hands off out-of-band |
| Failed-login counter display | Intentionally deferred | "Locked" badge only |

Divergences from handoff: none material. The plan suggested an inline "shared `UserForm` inner component" for create/edit; the implementation instead fully duplicates the form markup across `new/page.tsx` and `[userId]/page.tsx` and duplicates `LabelledSelect` + `Pill` + `formatShortDate`. Defensible (create has `password`, edit has `is_active` + `Security` card, so the overlap is less than it looks) but worth noting — see §7.

---

## 3. Correctness

### P0 (none)

No correctness issues that block the phase. RBAC composes correctly: `middleware.ts:58` blocks non-admin navigation to `/settings/admin/*`, `src/api.js:239` mounts the route with `requireAuth + requireAdmin`, every page re-asserts `isSystemAdmin(user)` client-side, every write is a single mutation against an authenticated endpoint. The token-version bump on reset-password (`admin-users.js:180`) correctly kills live sessions.

### P1

1. **Error messages surface raw JSON bodies.** `request()` in `api-client.ts:63-64` reads the error body as `res.text()` and stores it on `ApiError.message`. When the backend returns `{"error":"Password must be at least 8 characters"}` (e.g. `admin-users.js:69`), `err.message` is the literal JSON string, not the `error` field. The code paths that show "Surface the backend message verbatim; it's user-friendly" will actually render `{"error":"..."}` in the alert. Affects:
   - `new/page.tsx:83` — 400 on create
   - `[userId]/page.tsx:172` — 400 on save
   - `[userId]/page.tsx:424` — 400 on reset-password

2. **`company_name: ''` is sent instead of omitted when the field is cleared.** `[userId]/page.tsx:157` does `company_name: companyName.trim()` unconditionally. If the admin clears the company name to wipe it, the backend receives `""` — `updateUser` will persist the empty string, not null. Create path has the guard (`companyName.trim() || undefined` at `new/page.tsx:72`) but edit doesn't. Mirror the pattern: `company_name: companyName.trim() || null` (or `undefined` to leave unchanged — needs a product call).

3. **Self-edit guard is identity-spoofable via the URL.** `[userId]/page.tsx:73` derives `isSelf` from `currentUser?.id === userId` where `userId` is the URL param. An admin editing user-A can lift the role/active disabled states by… navigating to their own id. That's self-edit, which is fine — but also: if two admins share a browser profile and the URL is `/settings/admin/users/<adminB-id>`, admin-A will see admin-B's row with role + is_active *enabled*, and changing either demotes admin-B. That's actually the intended behaviour (admin-A can demote admin-B, just not self). BUT the comparison should be against **the row's `id`, not the URL param** once the row loads — if `row.id !== userId` (e.g. a backend redirect or a loader race where a stale `row` state is rendered), the guard evaluates against the wrong identity. Change to `currentUser?.id === row?.id`. Low severity in practice but a cheap correctness bump.

4. **`handleSave` only bumps `refreshCurrent()` when `isSelf` but doesn't re-fetch the row on failure.** `[userId]/page.tsx:154-179` sets saving true, awaits, pushes on success, and on error stops the spinner. If the PUT succeeds *partially* server-side and then a 5xx bubbles, the client keeps the old `row` state on screen with the typed-in values. The list page's focus-refresh cleans this up when the admin navigates back, but the edit page itself never re-loads. Consider calling `load()` on catch to resync, or at least on the save-success path before `router.push`.

5. **Create page has no "happened already" guard.** `new/page.tsx:62-90` has `setBusy(true)` but no double-submit-suppression separate from the button disable. A keyboard user hitting Enter twice during the fetch window will enqueue a second submit because `canSubmit` is recomputed from state. `busy` is in `canSubmit`, so this is actually guarded — no bug, but worth a test. (Verified fine; leaving as a note.)

### P2

1. **`router.replace('/settings')` during render in `new/page.tsx:54`.** Calling `router.replace` inside the render body is a side effect in render; React 19 will usually tolerate it but it can trigger `react-hooks/purity` or "cannot update a component while rendering" warnings under StrictMode. The edit page handles this correctly — it renders the "Not authorised" screen and lets the user click back. Fix: wrap in `useEffect` or mirror the edit-page inline-not-authorised UI.

2. **`LoadingRows` shows for list but the edit page just shows `Loading…` text.** Minor UX inconsistency.

3. **`window.confirm('Unlock this account? Failed-login count will reset.')` at `[userId]/page.tsx:182`.** Native confirms are blocked in iOS Safari standalone PWA contexts and look out-of-style. The rest of the code uses custom modals; this one alone uses native. Works, but inconsistent.

4. **No confirmation when toggling `is_active: false` on another user.** Deactivation is the soft-delete per the handoff — that's a destructive action. The unlock flow does a `confirm`, the deactivate flow doesn't. Asymmetric.

5. **`adminListUsers` is retried 3× on 5xx** (`api-client.ts:43`). Fine for idempotent list but the retry logic isn't triggered on 4xx; the list page already shows `error` on failure — no issue, just confirming.

6. **`load()` in edit page does up to 20 sequential `GET /api/admin/users` requests** of 50 rows each (`[userId]/page.tsx:84-100`) before giving up. For a 1000-user tenant that's 1000 rows serialised — see §5.

7. **Pagination controls go blank between pages.** `page.tsx:50-68` sets `users` to `null` on every offset change, so Prev/Next clicks flash the skeleton loader. Minor but feels janky; a keep-stale-data-while-loading pattern would be smoother.

8. **`row.company_id` and `row.company_role` are displayed as read-only (`[userId]/page.tsx:306-307`) but the backend PUT accepts neither** — `updateUser` only handles the five listed fields. Correct as-is; just noting that displaying them as "not editable here" is accurate.

9. **`formatShortDate` and `Pill` duplicated** across `page.tsx` and `[userId]/page.tsx`. Extract if/when a 3rd caller lands.

10. **Create form's `company_role` default is `'employee'`** (`new/page.tsx:46-48`). Backend also defaults to `'employee'` (`admin-users.js:95`), so submitting with an empty `company_name` + `'employee'` company_role creates a user with `company_role: 'employee'` but `company_id: null`. That's an orphan employee — legal per the schema but semantically odd. Handoff acknowledges "`company_role` to `''` for none" was an option; the UI offers it but doesn't make it the default.

---

## 4. Security

**Headlines: no P0/P1 security issues.** The admin surface is properly gated.

- **JWT role claim** — `middleware.ts:22-26` base64-decodes the JWT without verifying the signature. That is deliberate and documented elsewhere in the codebase (middleware is for UX redirects, the backend enforces signatures via `requireAuth` in `auth.js`). A tampered JWT with `role:"admin"` would pass middleware but fail `requireAdmin` on every API call, so the UI would render admin chrome and then every admin action would 401/403. Cosmetic exploit, no data risk. Acceptable.
- **Password handling** — Passwords are held in `useState` strings in `new/page.tsx:42` and `[userId]/page.tsx:406`. The reset sheet clears on close (`[userId]/page.tsx:435`); the create page does **not** clear on unmount — if React keeps the component mounted during the `router.push`, the password lingers in memory briefly. Not a real leak vector.
- **No password confirmation field** on create or reset. Typos produce a user the admin can't log in as. Not a security hole but a UX bug that will trigger a reset-password cycle.
- **Password autocomplete** is `new-password` on both fields — correct, prevents browser from saving the admin's typed value as the admin's own password.
- **`company_id` accepts any string** (`new/page.tsx:182`). Backend does no referential check — `createUser` with `company_id: 'not-a-real-uuid'` creates a user referencing a non-existent company. This is a backend validation gap, not a 6c bug. Flag for Phase 7+ when the company picker replaces the raw field.
- **CSRF** — all writes are JSON POST/PUT with a Bearer token from localStorage. No cookie-only auth surface for these endpoints, so classical CSRF doesn't apply.
- **XSS** — all user-provided strings (`name`, `email`, `company_name`) are rendered via React text nodes, auto-escaped. No `dangerouslySetInnerHTML` anywhere in the three files.
- **Destructive-action safeguards** — asymmetric. Unlock has `window.confirm`; deactivate does not (see §3 P2.4); delete correctly absent.
- **Rate limiting / brute-force** — reset-password has no client throttle. Trivial to write a loop that resets 1000 users. Backend presumably limits — worth confirming outside this review.
- **Cross-company visibility** — the list endpoint `listUsers()` in `src/db.js` returns every user regardless of `company_id`. The handoff and iOS reference both expect this (system admin = global scope). Correct.

---

## 5. Performance

1. **`load()` in edit page is O(N/50) sequential roundtrips.** `[userId]/page.tsx:84-100` iterates pages up to 1000 users. On a cold cache with a slow RDS connection, a user on page 10 could take 2-3 seconds. A `GET /api/admin/users/:id` endpoint would fix this in one request; handoff notes this doesn't exist yet. Short-term mitigation: `Promise.all` on the first two pages in parallel (covers 100 users, which is almost every tenant). Longer term: add the single-row endpoint.
2. **List page re-fetches the *entire current page* on every `focus` event** (`page.tsx:72-87`). For a user who alt-tabs frequently this is a lot of wasted traffic. Debounce or gate on "at least 30s since last fetch".
3. **No request cancellation on `focus` refresh.** If the admin triggers a slow focus-refresh and then changes `offset`, both responses land and the later `setUsers` depends on race order. The primary effect uses `cancelled`; the focus effect doesn't.
4. **`nowMs` is frozen at mount** (`page.tsx:216`, `[userId]/page.tsx:72`). An admin who leaves the list tab open for 2 hours will see the "Locked" badge on users whose `locked_until` expired 90 minutes ago. The comment acknowledges this is intentional (focus-refresh clears it); fine for now.

---

## 6. Accessibility

- **Semantic roles** — `<main>`, `<h1>`, `<section>`, `<form>`, `<label htmlFor>` all correct.
- **`role="alert"`** on error banners — good.
- **`role="dialog" aria-modal="true" aria-labelledby="reset-title"`** on the reset sheet — good.
- **Focus trap on modal** — NOT implemented. The `ResetPasswordSheet` at `[userId]/page.tsx:439-499` has no focus trap, no focus restoration, no `Esc` key handler, and no `aria-describedby` on the password field pointing at the hint. Tab will escape the dialog into the underlying form. P2.
- **`aria-hidden` on decorative Lucide icons** — consistently applied. Good.
- **Focus ring** — buttons and links use `focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]` (`page.tsx:222`) inconsistently. The back-link icon buttons in all three pages have no explicit focus ring — they inherit from Tailwind defaults which may or may not be visible against the surface.
- **Toggle switch** at `[userId]/page.tsx:286-293` is a styled `<input type="checkbox">` with `aria-label="Account active"` — screen readers will announce it correctly. However the "Account active" *outer label text* wraps the input, making the SR announcement "Account active Account active". Minor.
- **Touch targets** — 44×44 minimum on mobile. The row chevron (`page.tsx:267`) is a 16×16 icon inside a 64px-tall row which is clickable — fine via row click. The icon-only back-button is `h-9 w-9` = 36×36px, under the 44×44 minimum. P2.
- **Colour contrast** — `text-[11px] text-[var(--color-text-tertiary)]` for the "Showing N–N of N" footer and hint copy needs a contrast check against `--color-surface-0`. Not verified in this review; flag for manual check.
- **`prefers-reduced-motion`** — skeleton shimmer uses `animate-pulse` which is CSS-only and respects OS reduced-motion. Good.
- **Keyboard navigation through modal** — without a focus trap, Tab from the password field lands on the page behind. The underlying form is not `inert` or `aria-hidden`. P2.

---

## 7. Code quality

Positives:
- JSDoc on every page explains the "why" — this will age well.
- `React.useCallback`, `React.useId` used correctly.
- Proper cleanup function in the list effect (`page.tsx:65-67`).
- `encodeURIComponent` on userId in all API calls.
- `ApiError` type-guards used before `.status` access.
- `// eslint-disable` comments absent — clean baseline.

Concerns:
- **Duplication.** `LabelledSelect` (30 lines) is copy-pasted verbatim between `new/page.tsx:222-269` and `[userId]/page.tsx:504-551`. `Pill` is copy-pasted between `page.tsx:272-300` and `[userId]/page.tsx:553-579`. `formatShortDate` is copy-pasted in both list and edit. The handoff actively permitted inline forms but the shared *primitives* deserve extraction — premature abstraction is one thing, three identical copies is another. Suggest `components/ui/labelled-select.tsx`, `components/ui/pill.tsx`, `lib/format.ts`.
- **`router.replace` called during render** (`new/page.tsx:54`) — side effect in render. See §3 P2.1.
- **Pagination controls use inline arithmetic** (`page.tsx:114-115, 186, 198`) rather than deriving from the returned pagination envelope. Works but makes the list code slightly denser than the dashboard in 6b.
- **Magic strings** for role/company_role enums scattered across three files. Would benefit from being exported from `lib/types.ts` as a union + a `const` literal array.
- **`role` in middleware JWT payload typed `'admin' | 'user'`** (`middleware.ts:15`) — matches the backend exactly; good. But the JWT also has `company_role` which middleware doesn't check. If a future route needs company-admin gating, that will want to be at middleware-level too.
- **`.eslintrc` `react-hooks/purity` rule** cited in the commit message isn't actually present in the repo; the `useState(() => Date.now())` pattern is fine either way but the rationale comment is slightly off.

---

## 8. Test coverage

**Zero automated tests for 6c.** No Playwright, no Jest, no RTL. Grepped `web/` — admin tests don't exist. The handoff explicitly notes "there are currently zero Playwright E2E tests for the rebuild" as a candidate next phase.

Manual test plan in the handoff (§Manual test plan) is reasonable for a smoke pass but the following concrete cases are NOT covered by eyeballing:
- Creating a user with `company_role: ''` (none) — backend accepts, but does the UI round-trip and render correctly on edit?
- Creating a user while another admin races to create the same email (409 handling) — covered by handoff.
- Editing a user whose `is_active` was flipped to false by another admin mid-session.
- Edit page when the target user is on page 11+ (past the 10-page MAX_PAGES… wait, the constant is 20 at `[userId]/page.tsx:85`, so 1000 users. Still — a 1001st user hits notFound).
- Network failure mid-save (does the error banner surface correctly? currently yes, but the row state is stale).
- Reset-password with backend 500 (not modelled; `ApiError.status >= 500` triggers a retry, so the UI spinner can hang briefly).
- Unlock click on a user whose lockout already expired at render time — button appears, POST is harmless, but wastes a round trip.
- Admin who demotes themselves by spoofing URL to a row where `isSelf` evaluates false (see §3 P1.3).

Recommend: one Playwright E2E `admin-users.spec.ts` exercising list → create → edit → reset → unlock → back-to-list. Stub the backend via MSW or hit a seeded dev DB.

---

## 9. Suggested fixes

Numbered, with file:line pinpointing. All optional beyond P1.

1. **[P1]** `web/src/lib/api-client.ts:63-64` — parse JSON error bodies in `request()`. If `Content-Type: application/json`, parse and extract `.error` / `.message`. Current behaviour dumps raw JSON into every `ApiError.message`.
2. **[P1]** `web/src/app/settings/admin/users/[userId]/page.tsx:157` — change `company_name: companyName.trim()` to `company_name: companyName.trim() || null` (or omit via spread) so clearing the field actually clears the stored value rather than persisting `""`.
3. **[P1]** `web/src/app/settings/admin/users/[userId]/page.tsx:73` — compute `isSelf` from `row?.id` once the row loads, not from the URL param. Prevents a stale-render mismatch.
4. **[P2]** `web/src/app/settings/admin/users/[userId]/page.tsx:182` — replace `window.confirm` with the same custom modal pattern used by `ResetPasswordSheet`. Works in iOS standalone PWA mode and matches house style.
5. **[P2]** `web/src/app/settings/admin/users/[userId]/page.tsx:286-293` — add a confirmation modal when toggling `is_active: false`. Symmetric with unlock, symmetric with the destructive nature of soft-delete.
6. **[P2]** `web/src/app/settings/admin/users/new/page.tsx:54` — move `router.replace('/settings')` into `useEffect` to avoid side-effect-in-render.
7. **[P2]** `web/src/app/settings/admin/users/[userId]/page.tsx:439` — add focus trap, `Esc`-to-close, focus restoration on close, `inert` on the underlying `<main>` while the modal is open.
8. **[P2]** `web/src/app/settings/admin/users/page.tsx:52` — keep previous `users` visible while loading the next page (optimistic pagination UX).
9. **[P2]** `web/src/app/settings/admin/users/page.tsx:72-87` + `[userId]/page.tsx:109-112` — debounce focus refetch; 30s minimum interval.
10. **[P2]** `web/src/app/settings/admin/users/[userId]/page.tsx:80-107` — parallelise the first 2 page fetches via `Promise.all` as a short-term mitigation for slow page-N loads.
11. **[P2]** Extract `LabelledSelect`, `Pill`, `formatShortDate` into shared modules. Three duplicate copies justify the move.
12. **[P2]** `web/src/app/settings/admin/users/new/page.tsx:133-147` and `[userId]/page.tsx:470-480` — add a "show password" toggle. Admins typing passwords with no echo typo frequently.
13. **[P2]** `web/src/app/settings/admin/users/page.tsx:122` and `[userId]/page.tsx:199` — bump the back-link icon buttons to `h-11 w-11` to clear the 44×44 touch target threshold.
14. **[P2]** `web/src/app/settings/admin/users/new/page.tsx:46-48` — either default `company_role` to `''` or add a warning when `company_id` is empty but `company_role !== ''` (orphan employee).
15. **[P2]** Add a new Playwright spec: `web/tests/admin-users.spec.ts` covering create → edit → reset → unlock → back-to-list.
16. **[P3]** `web/src/lib/types.ts` — export `ROLE_VALUES` and `COMPANY_ROLE_VALUES` as `const`-literal arrays and derive the union types from them. Removes 6 magic-string triples across the admin pages.
17. **[P3]** `web/src/middleware.ts:22-26` — add a comment explicitly stating that middleware does NOT verify the JWT signature and that the backend `requireAuth` is the authoritative check. Prevents future contributors from treating middleware as security.
18. **[P3]** Add a password-confirmation field to create + reset flows. Low-cost typo prevention.

---

## 10. Verdict

**Approve for merge to `web-rebuild` as "Phase 6 closed".** The handoff was honoured, RBAC is tight, the code is readable, and the remaining bugs are fixable in a follow-up pass rather than blockers.

**Do NOT promote `web-rebuild` → `main` until at least #1, #2, #3 land.** Surfacing `{"error":"..."}` to end-users in an admin tool is embarrassing, the `company_name: ''` write is real data damage, and the `isSelf` URL-derivation is a latent foot-gun.

### Top 3 priorities (do these before `main`):

1. **Fix `ApiError` message parsing in `request()`** (`api-client.ts:63-64`). Single change, fixes every consumer (not just 6c).
2. **Null-coalesce `company_name` on edit save** (`[userId]/page.tsx:157`). One-line fix that prevents silent data corruption.
3. **Add a confirmation modal for `is_active: false`** (`[userId]/page.tsx:286-293`). Symmetric with unlock, aligns with soft-delete semantics, costs 20 lines of markup. Highest-value UX fix.

Everything else is P2 polish that can pile into a 6d-or-7a housekeeping commit.
