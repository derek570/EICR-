# Phase 6a Review — Settings Hub + Inspector Profiles

**Commits reviewed:** `2ef8ec6` (Phase 6a), `3e902d8` (fix: /login `useSearchParams` Suspense wrap)
**Branch:** `web-rebuild`
**Reviewer:** Claude (Opus 4)
**Date:** 2026-04-17

---

## 1. Summary

Phase 6a ports the iOS Settings / Inspector surfaces to the web rebuild. It adds:

- A settings hub at `/settings` with role-gated section cards.
- A staff list at `/settings/staff` and a combined add/edit page at `/settings/staff/[inspectorId]` (with a `new` sentinel).
- An HTML5 canvas signature capture component with DPR handling, pointer events, quadratic smoothing, background loading of an existing PNG, and an imperative `getBlob`/`clear`/`hasContent` handle.
- Equipment tracking (5 instruments × serial + calibration date, collapsible, auto-expanded if any slot populated).
- A client-side default-inspector mutex executed in the same pass as the PUT so the server always sees canonical state.
- Role helpers (`isSystemAdmin`, `isCompanyAdmin`) and a `useCurrentUser` reactive hook.
- Middleware extension that JWT-decodes the `token` cookie and blocks `/settings/admin/*` from non-admins before render.
- A backend GET endpoint (`/api/settings/:userId/signatures/:filename`) for auth'd signature fetch, mirroring the photo download pattern.

The commit also pre-adds API-client methods for phases 6b/6c (company settings, logo upload, company jobs/stats, admin user CRUD) even though the UI for those lives in later commits. The `/login` Suspense fix is a tidy, targeted refactor.

Overall this is a solid, well-designed piece of work — the two-step upload-then-PUT flow, the JWT middleware, and the DPR-aware canvas are all correct. The issues below are largely about **defence-in-depth** and **form UX polish**, not architectural breakage.

---

## 2. Alignment with Plan / Handoff

| Handoff requirement | Status |
|---|---|
| `/settings` hub ports iOS `SettingsView.swift` | Done — hero + role pills + section groups |
| `/settings/staff` list + detail with `new` sentinel | Done |
| Signature canvas via HTML5 canvas + pointer events | Done, DPR-aware |
| Two-step upload-first, then PUT profiles array | Done (`staff/[inspectorId]/page.tsx:134-161`) |
| Equipment as flat 10-field form, one collapsible SectionCard | Done |
| Role helpers centralised (no inline `role === 'admin'`) | Done |
| Middleware blocks `/settings/admin/*` for non-admins | Done |
| Component-level `useCurrentUser()` with hydrate + revalidate | Done |
| Default-inspector mutex applied client-side | Done |
| First-ever profile auto-defaults to `is_default: true` | Done (`staff/[inspectorId]/page.tsx:81`) |
| Backend GET signature route for web (new) | Done (`src/routes/settings.js:219-248`) |
| 6b/6c stubs on the hub as disabled cards | **Partially — see §3.3** |
| iOS `signature_file` shape as S3 key string (not base64) | Done |

**Drift from the plan:** the handoff (§ "Phase 6a … 6b/6c are intentionally stubbed as disabled 'Coming in Phase 6b/6c' cards on the hub per the stop-the-line rule") is not faithfully honoured — the hub renders live `Link` cards pointing at `/settings/company`, `/settings/company/dashboard`, and `/settings/admin/users`, none of which exist yet in this commit. See §3.3 (P1).

---

## 3. Correctness

### 3.1 P0 — blocking

None. There is no correctness-breaking bug that makes the 6a feature set unusable.

### 3.2 P1 — important

**P1-a. Hub links point at unimplemented routes (drift from handoff).**
`web/src/app/settings/page.tsx:102-134` renders `LinkCard` (not disabled) for `/settings/company`, `/settings/company/dashboard`, and `/settings/admin/users`. The handoff explicitly asked for these to be disabled "Coming in Phase 6b/6c" cards. The `LinkCard` component has a `disabled`/`disabledLabel` prop path (`:201-207`) but those props are never passed. Clicking any of them gives the user a Next.js 404. For a shipped-to-main PR this is confusing UX; inside an unmerged rebuild branch it is less severe but still a plan-divergence worth noting.

**P1-b. `handleSignOut` does not await `clearJobCache`'s fire-and-forget IDB transaction and instantly calls `router.replace`.**
In `web/src/app/settings/page.tsx:27-35` the flow is `api.logout() → clearAuth() → router.replace('/login')`. `clearAuth()` kicks off `clearJobCache()` as `void` (`auth.ts:51`). The comment there concedes this is fire-and-forget. In practice, a navigation immediately after will usually complete the IDB txn — but on a shared-device signout this is a PII-leak class problem if the next user logs in before the txn commits. Low probability; worth documenting or awaiting.

**P1-c. Signature canvas: the existing-signature load and the resize race-condition.**
`web/src/components/settings/signature-canvas.tsx:133-150` — `resize()` runs on mount and on window resize, and each run clears the canvas and calls `redraw()`. If the first `resize()` completes **before** `backgroundImgRef.current` is populated (which is entirely possible since the image fetch is async at `:157-170`), the background render correctly waits for `img.onload`. But the inverse path — resize firing **after** the background image is already drawn — is fine because `redraw()` re-applies the background. **However**, the `resize()` callback explicitly does `canvas.width = ...` which zeros the bitmap, and there is no debounce — rapid iOS Safari viewport resizes (address-bar hide/show) can drop strokes mid-draw because the `currentLineRef` is never cleared on resize. The redraw re-paints committed strokes but the in-progress stroke array is fine. Verdict: likely harmless but worth debouncing.

**P1-d. Signature load failure leaves the profile silently "intact" without a signature.**
If `fetchSignatureBlob` (or `img.onerror`) fails, `signature-canvas.tsx:167-173` sets `loadError` and the canvas renders as empty. If the user then just saves without re-drawing, `handleSave` (`staff/[inspectorId]/page.tsx:134-143`) treats `!signatureRef.current?.hasContent()` as "user explicitly cleared" and sets `signatureKey = undefined`. A transient CDN/S3 flake therefore wipes the persisted signature. iOS doesn't have this problem because the existing key is retained on read failure.

**P1-e. Signature canvas resize on orientation change — pointer capture mid-stroke lost.**
`:150` removes a bound `onResize` listener on unmount but never cancels an in-flight stroke. If resize fires mid-pointer-down (iOS Safari soft keyboard appearing when the user focuses a Date field and then taps back to the canvas), the stroke is drawn in the wrong coordinate space until the next pointer-up. Minor.

**P1-f. `useCurrentUser` never marks `loading: false` if hydrated `getUser()` is null and `api.me()` hasn't returned.**
`web/src/lib/use-current-user.ts:28-49` — `loading` starts `true`. If `api.me()` rejects (network), the catch at `:40-42` is silent and `finally` sets `loading: false`. Good. But consumers who read `{ user, loading }` aren't given an error surface — any 401 just lets them sit on "Loading…" forever while the middleware eventually fires on the next navigation. The pages (`settings/page.tsx:37`, `staff/page.tsx:71`) render "Loading…" forever in this edge case.

**P1-g. `useCurrentUser` race — multiple pages mounted simultaneously duplicate `api.me()` calls.**
Each page that renders uses its own hook instance, so navigating from hub → staff → detail triggers 3 network calls to `/api/auth/me` in quick succession. Not a correctness issue, but wasteful. Worth a shared SWR-like cache or promoting to context.

**P1-h. `FloatingLabelInput` `required` prop is forwarded to the HTML input (good) but the component shows no asterisk styling — the `*` in the label is a magic string.**
`staff/[inspectorId]/page.tsx:216` uses `label="Name *"` as a manual marker. Fine, but the field-level validation only gates the Save button via `canSave = form.name.trim().length > 0` (`:119`) — there is no ARIA association between the asterisk-bearing label and the `aria-required` state on the input. Screen readers won't announce it as required.

### 3.3 P2 — polish / suggestions

**P2-a.** Unused icon import: `staff/[inspectorId]/page.tsx:13` imports `Link2` but only uses it in `EquipmentCard` for the serial field's trailing slot (`:407`). Actually used — scratch that. However the file imports `ShieldCheck` (`:17`) and it's only used on the "Enrolment Number" field trailing slot (`:242`) — fine. No cruft here.

**P2-b.** `staff/[inspectorId]/page.tsx:255-261` uses a styled native `<input type="checkbox">` with `appearance-none` + after-pseudo-element to fake a switch. It works but has no visible focus ring, breaking keyboard access (WCAG 2.1 AA SC 2.4.7). No `:focus-visible` rule is applied.

**P2-c.** `staff/[inspectorId]/page.tsx:410-414` — the Calibration Date field is a plain text input with `placeholder="YYYY-MM-DD"`. iOS parity aside, this is a form-fill UX miss on the web: `<input type="date">` would give a native picker and inherent validation. Retain the string storage format, just change the control type.

**P2-d.** `staff/page.tsx:79` — `const defaultInspector = inspectors.find((i) => i.is_default);` — if backend data ever has more than one `is_default: true` (pre-mutex legacy data), only the first is surfaced as "Default". The list-view should sanity-check and warn, or render all as defaults to reveal the data corruption to the user.

**P2-e.** `staff/[inspectorId]/page.tsx:85-89` — on "not found" for an existing `inspectorId`, the page sets `error = 'Staff member not found'` but `form` stays `null`, so the main return falls through to the "Loading…" fallback at `:111-117` which *does* display the error string. Works, but the text "Loading…" is misleading — the UI should render a clear "Not found → back to list" state rather than collapsing into the same gate as the network-loading state.

**P2-f.** `signature-canvas.tsx:157-179` — the `URL.revokeObjectURL` is called in the cleanup, but the `new Image()` element holds its own reference via `img.src = objectUrl`. Some browsers (Safari historically) have released decoded bitmap memory lazily after revoke; the current code is fine for correctness but the image load may be partially cancelled if the component unmounts mid-load. Low priority.

**P2-g.** `settings/page.tsx:70-74` — `company_role` badge hides `employee` but shows `admin`/`owner`. Good. But the badge text uses `user.company_role[0].toUpperCase() + user.company_role.slice(1)`. If backend ever returns a role the type system doesn't know about (string widening), the capitalisation still works, but `isCompanyAdmin` silently returns false — a silent degrade. Not a bug.

**P2-h.** `middleware.ts:71` sets `Cache-Control: no-cache, no-store, must-revalidate` on every non-static HTML response. Matches the "Next.js App Router … no-cache on page responses" mistakes rule. Good.

**P2-i.** `middleware.ts:38-42` — public path check `pathname.includes('.')` is a blunt instrument that lets `/settings/foo.bar` through without auth. Unlikely to exist as a route but worth tightening to a trailing-segment ext check.

**P2-j.** `staff/[inspectorId]/page.tsx:119` — `canSave = form.name.trim().length > 0` is the only validation. No validation on calibration date format (YYYY-MM-DD) even though the placeholder advertises it. If a user types "Jan 2026" the backend will round-trip it losslessly and the PDF generator will stamp garbage.

**P2-k.** `staff/page.tsx:50-54` — focus listener to refresh is fine, but the React 19 `useSyncExternalStore` primitive would be cleaner and avoid a potential double-fetch during Strict Mode remounts in dev.

**P2-l.** `signature-canvas.tsx:280-290` — the Clear button reimplements the `clear()` handle inline instead of calling it. Minor duplication (`linesRef.current = [] …`). Not a bug.

**P2-m.** Commit message claims "Respect prefers-reduced-motion (no smoothing animation)" but the `signature-canvas.tsx` has no `prefers-reduced-motion` check anywhere. Nothing is animated so it's vacuously true, but the comment at `:32-33` is misleading.

---

## 4. Security

### 4.1 Server-side RBAC

- **Tenancy enforcement is consistent.** `src/routes/settings.js:52, 79, 102, 137, 160, 187, 222, 262, 316, 358` — every settings handler checks `req.user.id !== userId → 403`. No handler relies on client obedience; good.
- **Path traversal guard.** `:227-229` + `:362-364` — both the signature and logo GET routes reject `filename` containing `/` or `..`. Basename-only. Mirrors `src/routes/photos.js`.
- **Multer config.** 10MB caps and PNG/JPEG-only MIME filter on both signature (`:26-27`) and logo (`:41-42`) uploads. No SVG — rationale given in the comment is correct (SVG + ReportLab/Playwright image inlining is a script-injection vector).
- **Cache-Control.** Signature download (`:242`) and logo download (`:378`) set `private, max-age=300`. For signatures this is the right call because intermediaries must never cache PII images. For logos it's fine. Matches the CLAUDE.md mistake rule about server-action cache headers (the middleware handles HTML; this is appropriate for image responses).
- **Admin surface RBAC is layered correctly.** `src/auth.js:288-316` — `requireAdmin` (role=admin only) and `requireCompanyAdmin` (includes system admins + company owner/admin). Client middleware at `web/src/middleware.ts:58-60` redirects non-admins from `/settings/admin/*` before SSR. The handoff's "component-level plus belt-and-braces middleware" pattern is honoured.

### 4.2 Client-side RBAC

- **`isSystemAdmin` / `isCompanyAdmin` centralisation.** (`web/src/lib/roles.ts`) — clean, one source of truth.
- **`useCurrentUser` revalidates on mount.** Catches role changes mid-session. The hydrate-from-localStorage path means if a user tampers with `cm_user` in localStorage to inject `role: 'admin'`, they can get a flash of the admin link card — but clicking it hits `/settings/admin/users` which is **middleware-gated on JWT payload role**, not localStorage. So tampering only buys a visual flash, no actual privilege. Correct design.
- **Middleware JWT decode is untrusted decode — no signature verification.** `middleware.ts:18-26` parses the JWT body without verifying the signature. This is intentional and correct for a "belt-and-braces" client gate: the **backend** is the authority and will reject any tampered token at `src/auth.js:270` via `verifyToken`. The middleware's role is just to avoid rendering the admin shell to someone who doesn't claim to be admin. Worth a comment in the code to pre-empt the reviewer asking about it — the current comment at `:54-57` hints at it but doesn't call out the non-verification explicitly.

### 4.3 Data handling

- **Signature blob uploaded via multipart with bearer auth.** `api-client.ts:322-336`. Upload path regenerates filename server-side (`settings.js:271-272`) so the client can't set an arbitrary filename. Good.
- **Tenancy is strict per `req.user.id`.** No system-admin override path for accessing another user's inspector profiles — that's correct for Phase 6a (an admin managing someone else's profiles isn't a documented feature). Note for 6c: if admins ever need to edit another inspector's signature, `canAccessUser` exists at `src/auth.js:325`.
- **`token` cookie is `SameSite=Lax` with `max-age=7 days`, no `Secure`, no `HttpOnly`.** `auth.ts:36` — the same token sits in localStorage anyway (required for the `Authorization` header), so `HttpOnly` is moot. `Secure` should still be set in production for defence against a rogue HTTP injection on any subdomain. Missing on purpose for dev? Either way worth a `; Secure` conditional on `location.protocol === 'https:'`.
- **CSRF surface:** The backend's `requireAuth` at `src/auth.js:260-264` explicitly rejects query-param tokens and accepts `Authorization: Bearer` only. The client's settings PUT/POST go through `api.ts` which always sets the header. Since the endpoint does **not** accept cookie auth (despite `credentials: 'include'` being sent), there is effectively no CSRF. Good.

### 4.4 XSS / injection

- Inspector `name`, `position`, etc. render via JSX text nodes — React escapes. No `dangerouslySetInnerHTML`. Good.
- `initialSignatureFile` is threaded through `encodeURIComponent(filename)` at `api-client.ts:354`. Good.

### 4.5 Logout / session termination

- `clearAuth` deletes both localStorage and the cookie. `settings/page.tsx:27-35` also calls `api.logout()` first (fire-and-forget for the backend's server-side session bookkeeping).

---

## 5. Performance

- **Canvas redraw on every pointer move.** `signature-canvas.tsx:196-200` — every `onPointerMove` pushes a point and calls `redraw()` which clears the full canvas and repaints every committed stroke plus the background image. For a 180px-tall canvas with modest strokes this is fine; for a long continuous signature (~1000 points across 10 strokes) this is O(n²)-ish on each move. Not a practical problem for signatures but would benefit from an "incremental stroke" path that only draws the latest segment.
- **`api.me()` duplicated across pages.** As noted in §3.2 P1-g, every page remount re-requests. Consider a shared context or a small in-memory cache with a 5-second TTL.
- **Bundle weight.** `staff/[inspectorId]/page.tsx` imports 10 lucide icons (`:6-19`). Tree-shaking handles this fine given the named imports.
- **Focus-listener pattern** (`staff/page.tsx:49-54`) is cheap and only fires when the tab gains focus. Fine.
- **Signature canvas `toBlob` is async and uncompressed PNG.** ~30KB typical. Acceptable.

---

## 6. Accessibility

**Wins:**
- Dialog has `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (`staff/page.tsx:284-289`). Good.
- Delete button has `aria-label` with the inspector name (`:237`). Good.
- Canvas has `aria-label="Signature capture area"` and `role="img"` (`signature-canvas.tsx:260-261`). Reasonable.
- LinkCard has `focus-visible:outline-2` (`settings/page.tsx:211-212`).
- `aria-expanded` on the Equipment collapse toggle (`staff/[inspectorId]/page.tsx:280`). Good.

**Gaps:**
- **The custom "toggle switch" at `:255-261` has no visible focus indicator.** `appearance-none` strips the native ring and the class list doesn't re-add one. Keyboard users cannot see when the toggle is focused. **WCAG 2.1 AA — SC 2.4.7 Focus Visible.**
- **No `aria-required` / `aria-invalid` on the Name field.** The asterisk in `label="Name *"` is a sighted-only signal.
- **Calibration Date input has no explicit pattern / input-mode / aria-describedby.** `placeholder="YYYY-MM-DD"` is a weak affordance, and placeholders are not an accessible name.
- **Confirm-delete dialog traps no focus.** Opening the dialog doesn't move focus to the first interactive control, and Tab can escape the dialog to underlying content. **WCAG 2.4.3 Focus Order** is degraded.
- **No `aria-live` on the error regions.** `staff/page.tsx:112-116` and `staff/[inspectorId]/page.tsx:347-349` render error messages as plain `<p>`. Screen readers won't announce them when they appear.
- **Loading text "Loading…" is plain text, not `aria-live="polite"`.** A momentary change between "Loading…" and the form is not announced.
- **Canvas `role="img"` is debatable** — a drawable surface is more of a custom widget than an image. Consider `role="application"` with explicit `aria-label` and documented keyboard alternatives (none provided — this is a true drawing control, so it's inherently mouse/touch only; an accessible fallback like a file-upload alternative would be the principled answer).
- **Contrast:** The `DEFAULT` pill at `staff/page.tsx:222-230` uses `color: var(--color-brand-green)` on `color-mix(brand-green 15%, transparent)`. Depending on the base surface, the contrast can drop below 4.5:1. Worth a token check.
- **Hero gradient text.** `staff/page.tsx:151-155` renders white/white-75% on a blue→green gradient. Likely OK but needs measurement.

---

## 7. Code Quality

**Strong:**
- Clear separation between presentational components (`LinkCard`, `SectionGroup`, `RoleBadge`, `HeroHeader`, `InspectorRow`, `EmptyState`, `ConfirmDeleteDialog`, `EquipmentCard`) and page logic. All small, readable.
- Heavy JSDoc on non-trivial helpers (`useCurrentUser`, `roles.ts`, `SignatureCanvas`, every `api.*` method). Matches the project's "Commit Rules — explain the WHY" discipline.
- Imperative handle via `forwardRef` + `useImperativeHandle` for the canvas — idiomatic React 19.
- Types: `InspectorProfile` is an accurate mirror of the iOS `Inspector.swift` shape; new types (`AdminUser`, `CompanyMember`, `CompanyJobRow`, `CompanyStats`, `InviteEmployeeResponse`, `Paginated<T>`) pre-land for phases 6b/6c.
- Backend changes are minimal and orthogonal (one new GET route mirroring an existing pattern).

**Weak:**
- `staff/[inspectorId]/page.tsx:91-100` does a `keyof InspectorProfile`-typed array dance to probe equipment keys. Works but verbose; a small helper `countPopulatedEquipment(profile)` would make the inspector list + detail page share the same logic (currently duplicated at `staff/page.tsx:181-187`).
- The hub's `LinkCard` accepts `disabled` and `disabledLabel` props that are never exercised (see P1-a). Either use them (as the handoff asked) or drop them.
- Mixed styling idioms: Tailwind utility classes, CSS custom properties, `color-mix(in oklab, ...)`, inline `style={{...}}`. Not a defect, just load on the reader.
- No unit tests added for `roles.ts`, `useCurrentUser`, or the mutex logic in the save path.
- Error messages reveal backend text verbatim (`e instanceof Error ? e.message : 'Failed to load'`). Fine for logged-in users but worth a product decision.
- `LinkCard` applies `pointer-events-none` via a class, which doesn't actually stop a focus ring from landing on a disabled card during keyboard nav — if `disabled` ever gets used, `tabIndex={-1}` + `aria-disabled="true"` on a focusable element is better than a `<div>` wrapper.

---

## 8. Test Coverage

- **No new tests.** The existing test suite under `web/` doesn't exercise the new routes, the hook, the role helpers, or the signature canvas. Given Phase 6a's surface area (RBAC, S3 key handling, PII-bearing signatures) this is the largest gap in the review.
- **Manual test plan from the handoff is not recorded as a test artefact.** The handoff lists an 8-step manual regression (normal user sees staff tab, admin tab hidden; add → save → re-open → signature renders; delete flow; is_default mutex). None of these are encoded.
- **Suggested minimum:**
  1. Unit test for `isSystemAdmin` / `isCompanyAdmin` against each role combination.
  2. Unit test for the mutex logic in `handleSave` (`staff/[inspectorId]/page.tsx:155-159`) — given two profiles, toggling `is_default` on one sets the other to false; toggling off does not re-default anything.
  3. Integration test for the middleware JWT gate — non-admin token → 307 to `/settings`; admin token → passes through.
  4. Hook test for `useCurrentUser` — assert `api.me` is called once on mount; `refresh()` re-reads.
  5. Backend integration test for the new signature GET route — 403 cross-tenant, 400 on traversal, 404 missing, 200 happy path with correct Content-Type.

---

## 9. Suggested Fixes (numbered, file:line)

1. **`web/src/app/settings/page.tsx:102-134`** — either remove the Company / Admin cards entirely for 6a or pass `disabled + disabledLabel="Coming in Phase 6b"` / `"Coming in Phase 6c"` so non-existent routes aren't reachable. Honours the handoff's stop-the-line rule.
2. **`web/src/app/settings/staff/[inspectorId]/page.tsx:134-143`** — on signature load failure, preserve the existing `form.signature_file` unless the user explicitly clicked Clear. Track a `signatureExplicitlyCleared` bool set only by the Clear button, and use it here instead of inferring from `!hasContent()`. Eliminates transient-flake data loss (P1-d).
3. **`web/src/components/settings/signature-canvas.tsx:281-290`** — call `ref.current?.clear()` or the `clear()` handle body via a shared private function instead of duplicating the reset logic inline. Cleaner and future-proofs against drift.
4. **`web/src/components/settings/signature-canvas.tsx:133-150`** — debounce the resize handler (16–50 ms trailing) to avoid tearing mid-stroke on iOS Safari viewport events.
5. **`web/src/app/settings/staff/[inspectorId]/page.tsx:255-261`** — add a `:focus-visible` ring to the custom toggle switch. Suggested class: `focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)] focus-visible:outline-offset-2`. WCAG 2.4.7.
6. **`web/src/app/settings/staff/[inspectorId]/page.tsx:410-414`** — change the Calibration Date field to `<input type="date">`. Add a date-validation guard in `handleSave` that rejects non-YYYY-MM-DD strings loudly. Addresses P2-j.
7. **`web/src/app/settings/staff/[inspectorId]/page.tsx:215-221`** — add `aria-required="true"` + `aria-invalid={form.name.trim().length === 0}` to the Name input, and surface the asterisk as `aria-label` rather than a label suffix. Addresses P1-h.
8. **`web/src/app/settings/staff/page.tsx:283-310`** — trap focus inside the confirm-delete dialog on open, restore focus on close. Consider `@radix-ui/react-dialog` or hand-roll with `autoFocus` on the Cancel button + a `keydown` Escape handler (already absent).
9. **`web/src/app/settings/staff/page.tsx:112-116`** and **`staff/[inspectorId]/page.tsx:347-349`** — add `role="alert"` / `aria-live="assertive"` to error `<p>` elements so screen readers announce them.
10. **`web/src/lib/use-current-user.ts:28-49`** — expose an `error` field; consumers currently can't distinguish "waiting" from "401 failed silently". Optional enhancement: share a single `api.me()` promise across simultaneous mounts.
11. **`web/src/lib/auth.ts:36`** — append `; Secure` to the cookie when `window.location.protocol === 'https:'` so downgrade-attack injection over plain HTTP cannot read it.
12. **`web/src/middleware.ts:38-42`** — tighten the `pathname.includes('.')` check to a trailing-ext regex (`/\.[a-z0-9]+$/i`) so deep paths with dots in segments still get auth.
13. **`web/src/middleware.ts:18-26`** — add a comment clarifying that this is an unverified decode, with the backend as authority.
14. **`web/src/app/settings/staff/[inspectorId]/page.tsx:85-89`** — render a dedicated "Not found" state (with a Back link) instead of falling through to the Loading fallback.
15. **`web/src/app/settings/staff/[inspectorId]/page.tsx`** — extract `countPopulatedEquipment(profile)` to a shared helper used by both the list row (`staff/page.tsx:181-187`) and the detail page.
16. **Add tests** per §8.
17. **`web/src/components/settings/signature-canvas.tsx:102-130`** — consider an incremental-draw path that only strokes the newest segment of `currentLineRef` instead of full redraw on every pointer-move, for older iPads where the canvas is expensive.
18. **Documentation:** add a short note in `docs/reference/architecture.md` (or a new `settings.md` reference) documenting the new `GET /api/settings/:userId/signatures/:filename` route and the two-step upload-then-PUT contract for both signatures (6a) and logos (pre-landed for 6b).

---

## 10. Verdict + Top 3 Priorities

**Verdict: APPROVE with changes.** Phase 6a ships the intended functionality (hub + staff profiles + signature capture + default mutex + RBAC layering) and introduces a small, well-aligned backend addition. The design decisions from the handoff (two-step upload-then-PUT, role helpers centralised, middleware JWT gate as belt-and-braces, canvas via native API) are faithfully implemented. Security is solid — both server-side tenancy checks and client-side role gating are correct and layered. The only hard drift from the plan is the hub exposing links to unbuilt routes (P1-a). The `/login` Suspense fix is minimal, correct, and idiomatic.

**Top 3 priorities before merging to `main` (not blockers for the rebuild branch):**

1. **Fix the hub links to unimplemented routes (P1-a).** Disable the Company / Admin cards behind `disabled` / `disabledLabel` until 6b/6c land, per the handoff. This is user-visible breakage that will generate bug reports once testers see the hub.
2. **Fix the signature-retention regression on transient load failure (P1-d).** A flaky S3 read silently wipes the stored signature on the next save — this is a data-integrity regression vs iOS behaviour. Track an explicit "user cleared" bit rather than inferring from `!hasContent()`.
3. **Close the accessibility gap on the toggle switch, error regions, and dialog focus trap (§6).** These are WCAG 2.1 AA misses that block the "Phase 7 accessibility pass" from starting clean. The toggle's missing focus ring is the most egregious and a 1-line fix.
