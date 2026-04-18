## 1. Summary of the phase

Phase 6a adds the new `/settings` tree for the web rebuild: a settings hub, a staff list, and a shared add/edit page for inspector profiles, plus signature capture and equipment fields. It also adds shared role helpers, a `useCurrentUser()` hook, middleware role gating for `/settings/admin/*`, and a backend signature-download route so stored signature PNGs can be rendered through authenticated requests.

The implementation largely matches the commit intent for 6a. Note that the working tree has later edits in `web/src/app/settings/page.tsx`, `web/src/lib/api-client.ts`, and `web/src/middleware.ts`; findings below are anchored to commit `2ef8ec6` unless stated otherwise.

## 2. Alignment with original plan

Mostly aligned:
- It ships the planned 6a routes and core mechanics from the handoff: settings hub, staff list, detail editor, signature canvas, typed API helpers, role helpers, middleware role check, and the backend signature-read endpoint.
- It follows the intended two-step signature flow and the full-array PUT model for inspector profiles.

Partial / missing alignment:
- The handoff called for a `/settings` layout with persistent settings chrome (`back-to-dashboard + tabs/sidebar`) at `web/reviews/context/phase-6a.md:299-303`, but the shipped layout is only `AppShell` with no settings-specific navigation: [web/src/app/settings/layout.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/layout.tsx:1).
- The handoff explicitly said admin surfaces should have role-gated rendering and a friendly “not authorised” UI, not only routing/redirects (`web/reviews/context/phase-6a.md:145-150`). This commit implements redirect-based middleware gating only: [web/src/middleware.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/middleware.ts:54).

## 3. Correctness issues

- [P1] The “exactly one default inspector” invariant is not enforced. Deleting the current default simply removes it with no reassignment ([web/src/app/settings/staff/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/page.tsx:56)), and editing a profile can unset `is_default` without promoting another profile ([web/src/app/settings/staff/[inspectorId]/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/%5BinspectorId%5D/page.tsx:154)). That leaves zero defaults, which conflicts with the phase rationale that certificate generation needs one default inspector.
- [P1] Inspector state leaks across client-side navigation. The detail page does not clear `form`/`showEquipment` when `inspectorId` changes before the next fetch resolves ([web/src/app/settings/staff/[inspectorId]/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/%5BinspectorId%5D/page.tsx:66)), and `SignatureCanvas` does not clear its internal background when `initialSignatureFile` becomes `null` or changes ([web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:153)). Result: navigating from inspector A to B can show A’s stale details/signature, and if B has no signature the old one can persist and be saved onto B.
- [P2] An unchanged existing signature is treated as a fresh upload on every save. `getBlob()` returns a PNG whenever a background image exists, even if the user never drew anything ([web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:220)), and the detail page uploads whenever `getBlob()` returns non-null ([web/src/app/settings/staff/[inspectorId]/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/%5BinspectorId%5D/page.tsx:136)). That causes needless uploads, new S3 keys on unrelated edits, and orphaned old signature objects.
- [P2] Signature upload temp files are only deleted on success. If `readFile` or `uploadBytes` throws, the `catch` path returns 500 without unlinking the multer temp file ([src/routes/settings.js](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:270)). Over time this can leak disk space on the backend host.

## 4. Security issues

No new phase-specific security vulnerabilities stood out in this commit.

Evidence:
- The new signature GET route is auth-protected and tenant-scoped ([src/routes/settings.js](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:219)).
- Uploads are constrained to PNG/JPEG via the shared file filter ([src/routes/settings.js](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:17)).
- User-entered profile fields are rendered through React, so this phase does not introduce obvious XSS sinks.

## 5. Performance issues

- [P2] Unchanged signatures are re-uploaded on every profile save, which adds avoidable network latency and S3 churn on otherwise small edits ([web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:220), [web/src/app/settings/staff/[inspectorId]/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/%5BinspectorId%5D/page.tsx:136)).
- [P2] Failed signature uploads leak temp files on disk, which is a backend resource leak rather than a frontend perf issue, but it will accumulate under repeated failures ([src/routes/settings.js](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:275)).

## 6. Accessibility issues

- [P2] The delete confirmation dialog has `role="dialog"` and `aria-modal`, but no focus trap, no initial focus target, no Escape handling, and no focus restoration ([web/src/app/settings/staff/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/page.tsx:284)). Keyboard and screen-reader users can fall behind the modal.
- [P2] The signature control is pointer-only and is exposed as `role="img"` even though it is interactive ([web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:256)). There is no keyboard-accessible fallback or alternative upload path, so users who cannot draw on a pointer device cannot complete that part of the form.

## 7. Code quality

- `SignatureCanvas` duplicates its clear logic in two places: the imperative handle and the Clear button handler ([web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:228), [web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:281)). That already contributed to weak state semantics around “background loaded” vs “user changed”.
- `useCurrentUser()` writes `cm_user` directly instead of reusing a shared auth-storage helper, which duplicates storage-key knowledge and drifts from the rest of the auth abstraction ([web/src/lib/use-current-user.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/use-current-user.ts:35), [web/src/lib/auth.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/auth.ts:10)).
- `EmptyState` takes an unused `count` prop ([web/src/app/settings/staff/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/page.tsx:246)). Minor, but it suggests the page-level components were shipped without a cleanup pass.

## 8. Test coverage gaps

No automated tests were added for this phase, and the risky paths here are exactly the ones that need coverage:

- Default-profile invariant: create first profile, switch default, unset default, delete default.
- Inspector-to-inspector navigation: stale form/signature/equipment state should not bleed between routes.
- Signature save semantics: untouched background should not upload; cleared background should remove `signature_file`; newly drawn signature should upload once.
- Middleware vs UI role gating for `/settings/admin/*`.
- Dialog keyboard behavior and signature-canvas accessibility.

## 9. Suggested fixes

1. [web/src/app/settings/staff/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/page.tsx:56): when deleting a profile, if it was the default and another profile remains, promote one deterministically before PUT; if it was the last profile, allow empty. This preserves the “always one default when any profiles exist” invariant.
2. [web/src/app/settings/staff/[inspectorId]/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/%5BinspectorId%5D/page.tsx:154): prevent saving a non-empty profile list with zero defaults. Either disallow unchecking the sole default, or auto-promote another profile when the current default is unset.
3. [web/src/app/settings/staff/[inspectorId]/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/%5BinspectorId%5D/page.tsx:66): reset transient page state immediately on `inspectorId` change (`setForm(null)`, `setAllProfiles(null)`, `setShowEquipment(false)`, `setError(null)`) so old inspector data is not rendered while the next fetch is in flight.
4. [web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:153): on any `initialSignatureFile` change, explicitly clear previous background/load error first; if the new prop is null, leave the canvas empty. This fixes stale-signature bleed.
5. [web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:220): track a separate dirty flag for user-drawn changes. `getBlob()` should return a blob only when the signature was created/modified in this session, not merely when an existing background is present.
6. [web/src/app/settings/staff/[inspectorId]/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/%5BinspectorId%5D/page.tsx:136): use the dirty flag from the canvas so saves only upload when needed, and preserve the existing `signature_file` key when the signature is unchanged.
7. [src/routes/settings.js](/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:270): move temp-file cleanup into a `finally` block so failed uploads do not leave files behind in `os.tmpdir()`.
8. [web/src/app/settings/staff/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/staff/page.tsx:284): add proper modal focus management: autofocus the least-destructive action, trap focus inside, close on Escape, and restore focus to the triggering delete button.
9. [web/src/components/settings/signature-canvas.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/settings/signature-canvas.tsx:256): replace `role="img"` with semantics appropriate for an interactive control, and provide an accessible fallback for users who cannot draw with pointer input.

## 10. Overall verdict

**Needs rework.**

Top 3 priority fixes:
1. Fix stale inspector/signature state when navigating between staff profiles.
2. Enforce the single-default invariant on save and delete.
3. Add signature dirty tracking so unchanged signatures are not re-uploaded and old keys are not orphaned.