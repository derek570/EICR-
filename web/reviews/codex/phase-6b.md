## 1. Summary

Phase 6b adds the company branch of Settings: a company-details page at `/settings/company`, a dedicated logo upload/download path in `src/routes/settings.js`, and a company-admin dashboard at `/settings/company/dashboard` with Jobs, Team, and Stats tabs plus the one-time temporary-password invite flow.

The UI structure, typing, and overall scope mostly match the handoff. The main problem is that the implementation stores “company settings” per user, not per company, which breaks the core “all employees can view the company stamp” intent.

## 2. Alignment with original plan

The phase matches most of the handoff: live settings links, a read-only non-admin company page, dedicated logo upload, segmented dashboard tabs, and temp-password reveal/copy on invite.

The two meaningful misses are:
- The claimed triple-layer dashboard gate was not actually delivered. [`web/src/middleware.ts:58`](/Users/derekbeckley/Developer/EICR_Automation/web/src/middleware.ts:58) still only guards `/settings/admin`, not `/settings/company/dashboard`, and JWTs do not currently include `role` or `company_role` claims anyway ([`src/auth.js:121`](/Users/derekbeckley/Developer/EICR_Automation/src/auth.js:121)).
- “Company settings” are still modelled as one blob per user ([`web/src/lib/types.ts:56`](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:56)), which does not match the product intent of a shared company-wide branding record.

Current working-tree drift after `6e85e9e` is limited to later-phase changes in `web/src/app/settings/page.tsx` and `web/src/lib/api-client.ts`; the phase-6b files under review are otherwise unchanged.

## 3. Correctness issues

- **P1** [`web/src/app/settings/company/page.tsx:64`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/page.tsx:64), [`src/routes/settings.js:99`](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:99), [`src/routes/settings.js:133`](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:133): company branding is fetched and saved under `settings/{userId}/company_settings.json`, so each employee/admin gets their own independent blob. Non-admins following the new “Company Details” link will usually see their own empty settings, not the company’s actual branding, and multiple company admins can diverge permanently.
- **P1** [`src/routes/settings.js:329`](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:329), [`src/routes/settings.js:336`](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:336), [`src/storage.js:94`](/Users/derekbeckley/Developer/EICR_Automation/src/storage.js:94): the new logo upload route ignores the boolean result from `storage.uploadBytes`. On storage failure it still returns success and a `logo_file` key, so the client can save a broken reference that later 404s.
- **P2** [`web/src/app/settings/company/dashboard/page.tsx:155`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:155), [`web/src/app/settings/company/dashboard/page.tsx:275`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:275), [`web/src/app/settings/company/dashboard/page.tsx:524`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:524): the tab fetch effects do not clear `error` before retry or on success. After one transient failure, a tab can stay stuck on the error banner until remount.

## 4. Security issues

- **[Low]** [`web/src/app/settings/company/dashboard/page.tsx:380`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:380): the plaintext temporary password is kept in React state until modal close. That is not an auth bypass, but it enlarges the exposure window to browser extensions and React DevTools.
- **[Low]** No material XSS/auth/CSRF regression stood out in the changed code. The new logo path does at least require auth, rejects SVG, and blocks simple path traversal.

## 5. Performance issues

- [`web/src/app/settings/company/dashboard/page.tsx:135`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:135): tab panels unmount on every switch, so Jobs/Team/Stats all refetch and lose local state when revisited. That adds avoidable network churn and resets the jobs pager.
- [`web/src/app/settings/company/dashboard/page.tsx:325`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:325): the team list reload is triggered immediately after invite success, before the user dismisses the password modal, causing an extra fetch during the most sensitive part of the flow.

## 6. Accessibility issues

- [`web/src/app/settings/company/dashboard/page.tsx:423`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:423): the custom invite modal has `role="dialog"`/`aria-modal`, but no focus trap, no initial focus, no Esc handling, and no focus restoration.
- [`web/src/app/settings/company/page.tsx:142`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/page.tsx:142), [`:162`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/page.tsx:162), [`:201`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/page.tsx:201): the “view-only” company screen is rendered as disabled inputs. Disabled controls are not focusable or easily selectable, which is a poor fit for a screen whose purpose is to let inspectors verify and copy details.

## 7. Code quality

- The commit message and comments describe a triple-layer gate, but the implementation only has client-side gating plus backend enforcement. The docs and code are out of sync.
- The code is internally consistent around the wrong storage model: `CompanySettings` is explicitly documented as “one JSON blob per user” while the feature narrative treats it as shared company data.
- The async loading pattern is duplicated three times in the dashboard tabs with the same loading/error/cancel logic. A small shared hook would reduce drift.

## 8. Test coverage gaps

There are no matching tests for this area; `rg --files web | rg '\.(test|spec)\.(ts|tsx|js|jsx)$'` returned no settings/company coverage.

Missing coverage that matters here:
- Company details read/write using a shared company record.
- Logo upload failure path.
- Invite modal clearing the temp password on close/unmount.
- Dashboard role/no-company states.
- Tab retry behavior after a failed request.

## 9. Suggested fixes

1. [`src/routes/settings.js:99`](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:99), [`src/routes/settings.js:133`](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:133), [`src/routes/settings.js:309`](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:309), [`web/src/app/settings/company/page.tsx:64`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/page.tsx:64): move company settings and logos to a company-scoped key keyed by `company_id`, or resolve one canonical company-settings owner server-side. This is needed so every employee sees the same branding and every admin edits the same record.
2. [`src/routes/settings.js:329`](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:329), [`src/storage.js:94`](/Users/derekbeckley/Developer/EICR_Automation/src/storage.js:94): check the return value of `storage.uploadBytes`; if it is false, return `500` and do not emit `logo_file`. Move temp-file cleanup into `finally` so failures do not leave garbage behind.
3. [`web/src/middleware.ts:58`](/Users/derekbeckley/Developer/EICR_Automation/web/src/middleware.ts:58), [`src/auth.js:121`](/Users/derekbeckley/Developer/EICR_Automation/src/auth.js:121): either add signed `role`/`company_role` claims and enforce `/settings/company/dashboard` in middleware, or remove the “triple-layer gate” claim from comments/docs. The current implementation does not match the stated design.
4. [`web/src/app/settings/company/dashboard/page.tsx:155`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:155), [`:275`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:275), [`:524`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:524): call `setError(null)` before each fetch and clear it on success so retries can recover cleanly.
5. [`web/src/app/settings/company/dashboard/page.tsx:135`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:135): keep tab panels mounted or hoist fetched state into the parent so switching tabs does not refetch/reset all tab state.
6. [`web/src/app/settings/company/dashboard/page.tsx:423`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:423), [`web/src/app/settings/company/page.tsx:142`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/page.tsx:142): replace the custom modal with an accessible dialog primitive, and use `readOnly` inputs or plain text for non-admin company details instead of disabled fields.

## 10. Overall verdict

**Needs rework.**

Top 3 priority fixes:
1. Make company settings/logo storage truly company-scoped.
2. Fail logo uploads when storage writes fail instead of returning a fake success key.
3. Align the dashboard auth gate with the documented design, or explicitly narrow the design claim.