## 1. Summary of the phase

`bc11914` adds the system-admin user-management subtree under `/settings/admin/users`: a paginated list, a create page, an edit page, reset-password and unlock flows, and five new admin API client methods. It also enables the Settings hub link for system admins by removing the Phase 6c placeholder state in [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/page.tsx:124).

## 2. Alignment with original plan

The phase largely matches the handoff on route structure, list/create/edit/reset/unlock coverage, reuse of `useCurrentUser()`/`isSystemAdmin()`, and the hub-link activation. The current working tree has only one later change in the reviewed surface: [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/page.tsx:9) now also renders `IOSInstallHint`, which is unrelated to Phase 6c.

There are two notable misses versus the handoff:
- The handoff explicitly called for editable `company_role` and a raw UUID `company_id` affordance on the shared create/edit form ([web/PHASE_6C_HANDOFF.md](/Users/derekbeckley/Developer/EICR_Automation/web/PHASE_6C_HANDOFF.md:157), [web/PHASE_6C_HANDOFF.md](/Users/derekbeckley/Developer/EICR_Automation/web/PHASE_6C_HANDOFF.md:230)). The create page has both, but the edit page renders them read-only and the API client omits them from `adminUpdateUser`.
- The handoff described a shared create/edit inner form. The implementation duplicates form primitives instead. That is not a ship blocker by itself, but it is a deviation.

## 3. Correctness issues

- `P1` Missing edit support for `company_id` and `company_role`. The edit page only displays those fields read-only in [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:297), and `adminUpdateUser` is typed to exclude them in [api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:533), even though the backend whitelist accepts both in [db.js](/Users/derekbeckley/Developer/EICR_Automation/src/db.js:271). Result: admins can create a company assignment/role but cannot correct it later from the web UI.
- `P2` The edit page can falsely report “User not found” once the user is beyond the first 1,000 records. `load()` hard-stops at `MAX_PAGES = 20` in [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:84) and then sets `notFound`, even though `/api/admin/users` is system-wide, not tenant-scoped.
- `P2` The list page leaves stale error banners on screen after a subsequent successful reload. Neither the initial fetch nor the focus refresh clears `error` on success in [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/page.tsx:50) and [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/page.tsx:73).
- `P2` Server validation errors will often surface as raw JSON strings, not user-facing messages. `request()` throws `res.text()` directly in [api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:62), while these pages assume `err.message` is plain text in [new/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/new/page.tsx:81), [userId/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:171), and [userId/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:423).

## 4. Security issues

- No material new security defect found in this commit. The routes remain protected in middleware at [middleware.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/middleware.ts:54), backend admin routes are still mounted behind `requireAuth + requireAdmin`, user-controlled strings are rendered through React escaping, and IDs are URL-encoded in the client at [api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:549) and [api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:562).

## 5. Performance issues

- `P2` The edit-page lookup is a sequential request waterfall of up to 20 list fetches in [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:87). Even when it succeeds, worst-case latency scales linearly with page count and needlessly re-downloads whole user pages just to locate one row.

## 6. Accessibility issues

- `P1` `ResetPasswordSheet` is only a styled overlay, not an accessible modal dialog. It sets `role="dialog"` but does not trap focus, move initial focus into the sheet, restore focus on close, or support `Escape` dismissal in [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:440). Keyboard and screen-reader users can still tab into background controls.

## 7. Code quality

- `P2` `adminUpdateUser`’s type/comment drift from backend reality in [api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:533). That mismatch is already causing a feature gap and will make future admin-user work error-prone.
- `P3` `LabelledSelect` is duplicated almost verbatim in [new/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/new/page.tsx:222) and [userId/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:504). Not severe, but it is exactly the kind of drift the handoff’s shared-form guidance was trying to avoid.

## 8. Test coverage gaps

No automated tests were added in this phase. `git show --stat bc11914` contains only app/API-client files, and a repo search did not find matching admin-user/settings tests.

Missing coverage is most risky around:
- Editing another user’s role/active state and the self-edit guard.
- Reset-password success/error handling and unlock visibility.
- Pagination/error-recovery behavior on the list page.
- Admin-only route gating and non-admin redirect behavior.

## 9. Suggested fixes

1. [web/src/app/settings/admin/users/[userId]/page.tsx:297](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:297), [web/src/lib/api-client.ts:533](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:533): add editable `company_id` and `company_role` to the edit form and include them in `adminUpdateUser`. Why: this is required by the handoff and the backend already supports both fields.
2. [web/src/app/settings/admin/users/[userId]/page.tsx:84](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:84): remove the hard 20-page cap or replace this scan with a dedicated `GET /api/admin/users/:id` endpoint. Why: the current implementation can return a false “User not found” for valid users and scales poorly.
3. [web/src/app/settings/admin/users/[userId]/page.tsx:440](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/[userId]/page.tsx:440): convert `ResetPasswordSheet` to a real dialog primitive with initial focus, focus trap, Escape handling, and focus restoration to the trigger. Why: current modal behavior is not keyboard-safe.
4. [web/src/app/settings/admin/users/page.tsx:50](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/admin/users/page.tsx:50): call `setError(null)` before each fetch and after successful responses. Why: recovered list loads should not continue to display stale failure banners.
5. [web/src/lib/api-client.ts:62](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:62): parse JSON error bodies and prefer `body.error` when constructing `ApiError`. Why: current admin flows can show raw JSON payloads instead of clean validation messages.

## 10. Overall verdict

**Needs rework.**

Top 3 priority fixes:
1. Restore missing edit functionality for `company_id` and `company_role`.
2. Fix the edit-page lookup so valid users cannot become false 404s beyond the 1,000-user cap.
3. Make the reset-password sheet an actually accessible modal.