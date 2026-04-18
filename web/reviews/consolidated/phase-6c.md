# Phase 6c — Consolidated Review

**Commit:** `bc11914` — system-admin user management.

## 1. Phase summary

Phase 6c lands the iOS admin CRUD surfaces as a three-route sub-tree (`/settings/admin/users` list / `new` / `[userId]`), five new API-client methods, and the Settings hub link-unlock. The handoff is honoured on RBAC, pagination envelope, self-edit guards, and scope exclusions (no delete, no audit-log UI, no company picker). Core flow works; remaining issues are UX/correctness polish rather than RBAC holes — middleware + `requireAdmin` compose correctly and every write is server-gated.

## 2. Agreed findings

- **[P1][correctness/quality]** `web/src/lib/api-client.ts:62-64` — `request()` throws `ApiError` with raw `res.text()`; backend returns `{"error":"..."}` JSON so users see literal JSON blobs. Fix: parse JSON when `content-type` is JSON and prefer `body.error`/`body.message`. Consumers assume clean strings at `new/page.tsx:83`, `[userId]/page.tsx:172`, `[userId]/page.tsx:424`.
- **[P1/P2][a11y]** `web/src/app/settings/admin/users/[userId]/page.tsx:439-499` — `ResetPasswordSheet` sets `role="dialog"` but has no focus trap, no initial focus move, no `Esc` handler, no focus restoration, and no `inert`/`aria-hidden` on underlying `<main>`. Tab escapes into background. (Codex rated P1, Claude rated P2 — adjudicated P1: it is a WCAG 2.1 AA keyboard-trap violation.)
- **[P2][perf]** `web/src/app/settings/admin/users/[userId]/page.tsx:84-107` — edit page does up to 20 sequential `/api/admin/users` page-fetches (1000 users cap) to locate one row. Both reviewers flag. Short-term: `Promise.all` first N pages; long-term: add `GET /api/admin/users/:id` backend endpoint.
- **[P2][correctness]** Same file, `:84` — `MAX_PAGES = 20` cap produces a false "User not found" for valid users beyond row 1000. System-wide listing is not tenant-scoped.
- **[P2][quality]** `LabelledSelect` duplicated verbatim: `new/page.tsx:222-269` vs `[userId]/page.tsx:504-551`. Also `Pill` and `formatShortDate` duplicated between list and edit pages. Handoff's shared-form guidance sidestepped; extract to `components/ui/` or `lib/format.ts` if a third caller appears.
- **[test]** No automated tests added for 6c. Both reviewers flag a Playwright `admin-users.spec.ts` covering list→create→edit→reset→unlock as the correct next step.

## 3. Disagreements + adjudication

| Topic | Claude says | Codex says | Adjudication + reason |
|---|---|---|---|
| `company_id`/`company_role` edit | Noted as read-only display at `[userId]/page.tsx:306-307`; accepts as correct because API client excludes them. P2 footnote. | **P1 — missing feature.** Handoff explicitly called for editable company fields on the shared form; backend whitelist in `src/db.js:271` already accepts both. Admins can create assignments but cannot correct them. | **Codex is right — upgrade to P1.** The handoff (`web/PHASE_6C_HANDOFF.md:157,230`) asks for raw-UUID `company_id` field + `company_role` select on the edit form too, not just create. `adminUpdateUser` at `api-client.ts:533` narrows the type and hides the capability. This is a real parity gap with iOS. |
| `company_name: ''` on save | **P1** at `[userId]/page.tsx:157` — clearing persists `""` instead of null; create path guards, edit path doesn't. | Not raised. | **Valid P1.** Confirmed in file: line 157 does `companyName.trim()` unconditionally. Silent data corruption when an admin wipes a company name. |
| Self-edit guard spoofable via URL | **P1** at `[userId]/page.tsx:73` — `isSelf` compared against URL `userId` param rather than loaded `row.id`, creating stale-render risk. | Not raised. | **Downgrade to P2.** Re-reading: `userId` comes from Next.js route params, same source the load uses; `row.id` is populated from the same id space. No realistic stale-render divergence because `isSelf` is evaluated post-`row` load. Cheap hardening but not P1. |
| Stale error banner on success | Not raised. | **P2** at `page.tsx:50,73` — list page doesn't `setError(null)` after a successful recovered fetch. | **Valid P2.** Small real bug worth fixing alongside other list-page polish. |
| `router.replace` in render body | **P2** at `new/page.tsx:54` — side-effect-in-render; flag for StrictMode. | Not raised. | **Valid P2.** Should move into `useEffect`. |
| Confirmation modal for `is_active: false` | **P2** — asymmetric vs unlock; soft-delete is destructive, deserves confirm. | Not raised. | **Valid P2.** Claude's UX argument holds. |
| `window.confirm` for unlock | **P2** at `[userId]/page.tsx:182` — blocked/ugly in iOS standalone PWA. | Not raised. | **Valid P2.** Consistent with house modal style in `ResetPasswordSheet`. |
| RBAC / JWT signature in middleware | **P3** note — middleware base64-decodes JWT unsigned; backend is authoritative. Documented. Cosmetic. | Silent (implicitly accepts). | **Agree — not a defect.** Middleware is UX-redirect only; every write path goes through server-side `requireAuth + requireAdmin`. |

## 4. Claude-unique findings

- **[P1]** `company_name: ''` silent data corruption on edit — `[userId]/page.tsx:157`.
- **[P1→P2]** `isSelf` identity-spoofing hardening — `[userId]/page.tsx:73`.
- **[P2]** No confirmation modal for `is_active: false` toggle — `[userId]/page.tsx:286-293`.
- **[P2]** `window.confirm` inconsistency for unlock — `[userId]/page.tsx:182`.
- **[P2]** `router.replace` during render — `new/page.tsx:54`.
- **[P2]** List page blanks on pagination (sets `users: null` per offset change) — `page.tsx:50-68`.
- **[P2]** Focus-refresh not debounced, no request cancellation — `page.tsx:72-87`.
- **[P2]** `nowMs` frozen at mount — "Locked" badge stale after hours — acknowledged in code as intentional.
- **[P2]** No password-confirmation field on create/reset flows (typo risk).
- **[P2]** No "show password" toggle on password inputs.
- **[P2]** Back-link icon buttons `h-9 w-9` (36×36px) fall under 44×44 touch-target threshold — all three pages.
- **[P2]** Toggle switch nested-label SR double-announce — `[userId]/page.tsx:286-293`.
- **[P2]** Create-form `company_role` defaults to `'employee'` while `company_id` can be blank → orphan employee — `new/page.tsx:46-48`.
- **[P3]** Export `ROLE_VALUES` / `COMPANY_ROLE_VALUES` as const arrays in `lib/types.ts`; removes magic strings across three files.
- **[P3]** Comment-document in `middleware.ts:22-26` that JWT signature is not verified there.
- **[security/note]** `company_id` accepts any string; backend does no referential check (flagged as Phase 7+ when picker replaces raw field — not a 6c bug).
- **[security/note]** Reset-password has no client throttle; backend limiting assumed (worth confirming).

## 5. Codex-unique findings

- **[P1]** `adminUpdateUser` type omits `company_id` + `company_role` despite backend whitelist acceptance — `api-client.ts:533` + `[userId]/page.tsx:297`. Feature-parity gap vs handoff.
- **[P2]** Stale error banner persists after successful recovery — `page.tsx:50,73`.
- **[P2/note]** Type/comment drift on `adminUpdateUser` will cause future churn — `api-client.ts:533`.
- **Context observation** — working tree has an unrelated `IOSInstallHint` addition in `settings/page.tsx:9` from a later phase; not part of 6c.

## 6. Dropped / downgraded

- **Claude §3 P1.3 (isSelf URL spoofing)** — downgraded to P2. The comparison happens after `row` loads and `userId` matches the route; no realistic divergence.
- **Claude §3 P1.5 (create-page double-submit)** — Claude self-retracted after verification; not a bug.
- **Claude §4 — JWT base64 decode without signature verification in middleware** — intentionally documented design; not a defect. Server-side `requireAuth` is authoritative.
- **No Codex findings are obsolete** — all flagged issues remain present in the committed tree at `bc11914`.

## 7. Net verdict + top 3 priority fixes

**Verdict: Approve for `web-rebuild` as "Phase 6 closed"; do NOT promote to `main` until priority fixes land.** RBAC is correctly layered, handoff honoured on scope exclusions, no P0s. Remaining issues are a mix of (a) real data-correctness bugs, (b) one handoff parity miss, and (c) a keyboard-accessibility modal gap.

### Top 3 priority fixes (pre-`main`):

1. **Fix `ApiError` message parsing** — `web/src/lib/api-client.ts:62-64`. Parse JSON bodies; prefer `body.error`. Single change, fixes every admin consumer (and every other route).
2. **Restore editable `company_id` + `company_role` on edit page** — `web/src/app/settings/admin/users/[userId]/page.tsx:297` + `web/src/lib/api-client.ts:533`. Handoff-mandated parity; backend already accepts both. Also fix `company_name: companyName.trim() || null` at `:157` to stop silent `""` writes.
3. **Make `ResetPasswordSheet` a proper accessible modal** — `web/src/app/settings/admin/users/[userId]/page.tsx:439-499`. Focus trap, initial-focus move, `Esc` to close, focus restoration, `inert` on background. Current state is a WCAG 2.1 AA keyboard-trap violation.
