# Phase 6a — Consolidated Review

**Commits:** `2ef8ec6` (Phase 6a settings hub + inspector profiles) + `3e902d8` (fix `/login` `useSearchParams` Suspense wrap)
**Branch:** `web-rebuild`
**Reviewers:** Claude (Opus 4), Codex
**Consolidator:** Claude (Opus 4)
**Date:** 2026-04-17

---

## 1. Phase summary

Phase 6a ports the iOS Settings / Inspector surfaces to the web rebuild:

- `/settings` hub with role-gated section groups (Team / Company / Administration).
- `/settings/staff` inspector list + `/settings/staff/[inspectorId]` add/edit (with `new` sentinel).
- HTML5-canvas signature capture (DPR-aware, pointer events, quadratic smoothing, background PNG load, imperative `getBlob`/`clear`/`hasContent` handle).
- Equipment section — 5 instruments × (serial + calibration date) on a collapsible card, auto-expanded when any slot is populated.
- Client-side default-inspector mutex applied in the same pass as the PUT.
- Role helpers (`isSystemAdmin`, `isCompanyAdmin`) and a reactive `useCurrentUser()` hook.
- Middleware JWT-decodes the `token` cookie and blocks `/settings/admin/*` from non-admins before SSR.
- New backend `GET /api/settings/:userId/signatures/:filename` endpoint (auth'd blob read, basename traversal guard, `Cache-Control: private, max-age=300`).
- Pre-adds 6b/6c API-client methods (company settings, logo upload, dashboard, admin CRUD) and associated types even though their UIs land later.

The `/login` fix wraps `useSearchParams` in `<Suspense>` to unblock `next build` on App Router 16.

---

## 2. Agreed findings (both reviewers)

| Severity | Area | File:line | Finding |
|---|---|---|---|
| **P1** | Correctness — UX / data-integrity | `web/src/components/settings/signature-canvas.tsx:220-228` + `web/src/app/settings/staff/[inspectorId]/page.tsx:134-143` | Signature "dirtiness" is inferred from `hasStrokes \|\| hasBackground`, not from actual user changes. Claude framed this as "transient fetch failure silently wipes the stored signature on next save" (P1-d); Codex framed it as "unchanged signatures are re-uploaded on every save, orphaning the old S3 key". Both reviewers arrive at the same root cause — the canvas needs a proper user-dirty flag distinct from `hasBackground`. Consolidated severity: **P1 correctness + perf**. |
| **P1 (Codex) / P2 (Claude)** | Accessibility | `web/src/app/settings/staff/page.tsx:283-310` | Confirm-delete dialog has `role="dialog"` + `aria-modal` but no focus trap, no initial focus target, no Escape key handling, no focus restoration. Both reviewers agree. Claude labelled this P2 inside a §6 gap list, Codex labelled it P2 in §6. Consolidated severity: **P2 a11y** (WCAG 2.4.3). |
| **P2** | Accessibility | `web/src/components/settings/signature-canvas.tsx:256-261` | Canvas is exposed as `role="img"` despite being an interactive drawing control, and there is no keyboard-accessible fallback for users who can't draw with a pointer. Both reviewers flag it; Claude additionally notes `role="application"` or a file-upload alternative as the principled fix. |
| **P2** | Code quality | `web/src/components/settings/signature-canvas.tsx:228, 281-290` | The Clear button reimplements the reset inline instead of calling the exported `clear()` handle body — two sources of truth for "reset canvas". Both flag. |
| **P0/P1/P2** | Test coverage | (no files) | No automated tests added for `roles.ts`, `useCurrentUser`, default-mutex save path, middleware JWT gate, or the new signature GET route. Both reviewers call it out as the largest gap; neither marks it a hard blocker. |
| **Alignment** | Plan drift | N/A | Both note Phase 6a is **mostly aligned** with the handoff; Phase 6b/6c API-client methods + types are pre-added as planned. Disagreements about remaining drift are §3 below. |

---

## 3. Disagreements + adjudication

### 3.1 "Hub LinkCards rendered live instead of disabled" (Claude P1-a)

**Claim (Claude §3.2 P1-a / §9 fix 1):** The hub renders **live** `LinkCard`s for `/settings/company`, `/settings/company/dashboard`, and `/settings/admin/users`, breaking the handoff's "stop-the-line" rule and sending users to 404s.

**Codex position:** Silent on this point — Codex does not raise it.

**Adjudication:** **Claude is wrong at `2ef8ec6`.** Verified via `git show 2ef8ec6:web/src/app/settings/page.tsx`:

```tsx
// at 2ef8ec6 — hub renders Company + Admin cards with disabled + disabledLabel:
<LinkCard
  href="/settings/company"
  …
  disabled
  disabledLabel="Coming in Phase 6b"
/>
…
<LinkCard
  href="/settings/admin/users"
  …
  disabled
  disabledLabel="Coming in Phase 6c"
/>
```

The `disabled`/`disabledLabel` props **are** passed at commit 2ef8ec6 exactly as the handoff asks. Claude's review is describing the **working tree** at the time of the review (post-6b/6c commits where the cards were re-enabled and gated by `isCompanyAdmin`/`isSystemAdmin`), not the commit under review. **Drop this P1** from the consolidated list.

> Note: Codex explicitly flags at the top of its review that "the working tree has later edits in `web/src/app/settings/page.tsx` … findings below are anchored to commit 2ef8ec6". Claude's review silently leaked state from a later commit.

### 3.2 "Persistent settings chrome (back-to-dashboard + tabs/sidebar) missing" (Codex §2)

**Claim (Codex):** Handoff asked for `settings/layout.tsx` to have persistent settings nav (back-to-dashboard + tabs/sidebar); shipped layout is `AppShell`-only.

**Claude position:** Silent.

**Adjudication:** **Codex is correct** — the handoff (context file `:299-303`) did ask for this. But the deviation is minor — the hub itself is one navigable screen and the staff sub-pages have their own back-links. Consolidated severity: **P2 plan drift** (not a correctness issue). Keep.

### 3.3 "Admin page shows friendly not-authorised UI, not a redirect" (Codex §2)

**Claim (Codex):** The handoff explicitly asked for role-gated rendering with a friendly "not authorised" fallback; the commit only redirects via middleware.

**Claude position:** Silent, but Claude applauds the middleware-JWT-decode as belt-and-braces (§4.2).

**Adjudication:** **Codex is correct on the spec**, but the redirect is functionally equivalent for a user with no admin role (they never see the admin URL because the hub link is hidden behind `isSystemAdmin(user)`). The "friendly not-authorised" UI is a defence-in-depth nicety for URL-typing / stale-bookmark cases. Consolidated severity: **P3 nice-to-have** (downgrade Codex's implied severity).

### 3.4 "Inspector state leaks across client navigation A→B" (Codex P1, second)

**Claim (Codex §3 P1):** The detail page does not clear `form`/`showEquipment` when `inspectorId` changes before the next fetch resolves; `SignatureCanvas` does not clear `backgroundImgRef`/`hasBackground` when `initialSignatureFile` changes. Navigating A → B can show A's data and persist A's signature onto B if saved before the fetch completes.

**Claude position:** Does not raise it.

**Adjudication:** **Codex is correct.** The detail page's `useEffect(() => { load(user.id, inspectorId) }, [user, inspectorId])` doesn't `setForm(null)` before firing, and the canvas effect has no cleanup that resets `backgroundImgRef.current` on dep change — it only sets `cancelled = true`. A user rage-clicking between two profiles could plausibly save A's signature onto B. Low probability but real. Consolidated severity: **P1 correctness**. Keep.

### 3.5 "Default-inspector invariant (zero defaults after delete / unset)" (Codex P1, first)

**Claim (Codex):** Deleting the current default simply removes it with no reassignment; unchecking `is_default` on the sole default leaves zero defaults. Conflicts with the phase rationale that cert generation needs one default.

**Claude position:** Touches it obliquely in P2-d ("multiple defaults") but misses the "zero defaults" direction.

**Adjudication:** **Codex is correct and has the stronger framing.** The commit body says "first-ever profile auto-defaults to is_default: true so a freshly onboarded company always has a default for cert generation" — but the invariant isn't enforced on subsequent mutations. Consolidated severity: **P1 correctness**. Keep.

### 3.6 "Middleware JWT decode has no signature verification" (Claude §4.2)

**Claim (Claude):** Middleware calls `atob` on the payload directly with no signature check.

**Codex position:** Does not raise it.

**Adjudication:** Not a vulnerability — backend `requireAuth` (`src/auth.js:270`) is the authority and verifies the HMAC. Client-side middleware is just a render-time optimisation to avoid flashing admin chrome; tampering with the cookie only fakes the visual, not the privileged API calls. Claude itself (correctly) concludes "correct design" — so this is informational, not a finding. **Downgrade to commentary**, keep only the "add a clarifying code comment" suggestion.

### 3.7 Claude's long accessibility + code-quality punch-list

**Claim (Claude §3.2 P1-b through P1-h, §3.3, §6, §7):** Two-dozen small findings (toggle focus ring, asterisk aria-required, calibration-date `<input type="date">`, cookie `Secure` flag, `pathname.includes('.')` gate, canvas incremental-draw, `useCurrentUser` race, etc.).

**Codex position:** Silent on nearly all of these.

**Adjudication:** Claude's items are individually valid but mostly **P2-P3 polish**. The toggle focus-ring (P1-g / §9 fix 5) is a real WCAG 2.4.7 issue and should stay at P2. The cookie `Secure` flag (§9 fix 11) is a P2 defence-in-depth item. Everything else → P3 or drop. See §4 below for the curated list.

---

## 4. Claude-unique findings (retained)

| Severity | File:line | Summary |
|---|---|---|
| P2 a11y | `web/src/app/settings/staff/[inspectorId]/page.tsx:255-261` | Custom toggle switch built on `appearance-none` has no `:focus-visible` ring — keyboard users can't see focus. WCAG 2.4.7. |
| P2 sec | `web/src/lib/auth.ts:36` | Token cookie set without `Secure` flag — readable on any accidental HTTP response in production. Conditional on `location.protocol === 'https:'`. |
| P2 a11y | `web/src/app/settings/staff/page.tsx:112-116` + `staff/[inspectorId]/page.tsx:347-349` | Error `<p>` elements lack `role="alert"` / `aria-live="assertive"` — screen readers won't announce them on appearance. |
| P2 UX | `web/src/app/settings/staff/[inspectorId]/page.tsx:410-414` | Calibration Date is a plain text input with `placeholder="YYYY-MM-DD"` — `<input type="date">` would give native picker + validation. |
| P2 UX | `web/src/app/settings/staff/[inspectorId]/page.tsx:85-89` | On not-found, page renders "Loading…" instead of a dedicated not-found state with a back link. |
| P2 a11y | `web/src/app/settings/staff/[inspectorId]/page.tsx:215-221` | Name field uses `label="Name *"` as a sighted-only signal with no `aria-required` / `aria-invalid`. |
| P3 perf | `web/src/lib/use-current-user.ts:28-49` | Each page that mounts duplicates the `api.me()` network call. A shared promise or context would dedupe. |
| P3 perf | `web/src/components/settings/signature-canvas.tsx:196-200` | Full redraw on every pointer move is O(n²) on long signatures; incremental draw of the newest segment would help on older iPads. |
| P3 correctness | `web/src/middleware.ts:38-42` | `pathname.includes('.')` as a public-path check lets deep paths with embedded dots through without auth. Tighten to a trailing-ext regex. |
| P3 UX | `web/src/app/settings/staff/[inspectorId]/page.tsx:91-100` vs `staff/page.tsx:181-187` | `countPopulatedEquipment` logic duplicated between list and detail — extract helper. |
| P3 UX | `web/src/app/settings/page.tsx:27-35` | `handleSignOut` fires `clearJobCache` IDB txn without awaiting; a shared-device sign-out followed by immediate login could leak IDB rows before the deletion commits. |
| P3 correctness | `web/src/components/settings/signature-canvas.tsx:133-150` | Resize handler is not debounced — rapid iOS Safari address-bar hide/show can trigger redundant canvas bitmap resets. |

---

## 5. Codex-unique findings (retained)

| Severity | File:line | Summary |
|---|---|---|
| **P1** | `web/src/app/settings/staff/[inspectorId]/page.tsx:66` + `web/src/components/settings/signature-canvas.tsx:153` | State bleed on A→B navigation: stale `form`/`showEquipment` and stale `backgroundImgRef` can render and persist data from the previous inspector onto the next. |
| **P1** | `web/src/app/settings/staff/page.tsx:56` + `staff/[inspectorId]/page.tsx:154` | "Always one default inspector when any exist" invariant is not enforced on delete or on unset. Leaves zero-default state that breaks cert generation. |
| P2 | `src/routes/settings.js:270-275` | Temp-file cleanup (`fs.unlink`) only on success path — a throw in `readFile`/`uploadBytes` leaves the multer temp file in `os.tmpdir()`. Move to `finally`. |
| P2 | `web/src/lib/use-current-user.ts:35` vs `web/src/lib/auth.ts:10` | Hook writes `cm_user` in localStorage directly instead of reusing the `setUser` / storage-key abstraction — drifts from the rest of the auth layer. |
| P2 | `web/src/app/settings/staff/page.tsx:246` | `EmptyState` takes an unused `count` prop. |
| P2 plan | `web/src/app/settings/layout.tsx:1` | Handoff asked for persistent settings chrome (back-to-dashboard + tabs/sidebar); shipped layout is `AppShell`-only. |
| P3 plan | (admin routing) | Handoff asked for friendly "not authorised" UI on admin pages rather than middleware redirect — currently redirect-only. |

---

## 6. Dropped / downgraded

| Item | Source | Action | Reason |
|---|---|---|---|
| "Hub renders live LinkCards to unbuilt routes" (P1-a) | Claude §3.2 / §9 fix 1 / top-3 #1 | **Dropped** | Claim does not hold at commit 2ef8ec6 — `disabled` + `disabledLabel="Coming in Phase 6b/6c"` are passed on both cards at the reviewed commit. Claude was looking at a later working-tree revision. |
| "`useCurrentUser` never marks loading:false if me() rejects silently" (P1-f) | Claude §3.2 P1-f | **Downgraded to P3** | Claude's own read confirms the `finally` block does set `loading: false`. The concern is about missing error surfacing, not a hang. |
| "Signature resize loses pointer capture mid-stroke" (P1-e) | Claude §3.2 P1-e | **Downgraded to P3** | Speculative iOS Safari edge case; Claude labels it "Minor". |
| "`prefers-reduced-motion` claim in commit body is vacuous" (P2-m) | Claude §3.3 P2-m | **Dropped** | Literally vacuous — no animation exists, so the commit claim is trivially true. Not a finding. |
| "Unused `Link2` import" (P2-a) | Claude §3.3 P2-a | **Dropped** | Claude self-retracts within the bullet. |
| "Middleware JWT is unverified decode" (§4.2) | Claude §4.2 | **Downgraded to commentary** | Claude itself concludes it's correct design; keep as "add a clarifying code comment". |
| "`pointer-events-none` on disabled LinkCard doesn't block focus ring" (§7) | Claude §7 | **Downgraded to P3** | Only reachable if the disabled path is used — which, after §6.1 adjudication, **is** used at 2ef8ec6. Worth a note but low urgency since the div isn't focusable. |
| "Hero gradient contrast" (§6) | Claude §6 | **Downgraded to P3** | Unmeasured; flagged as "likely OK". |
| "Canvas `toBlob` is uncompressed ~30KB PNG" (§5) | Claude §5 | **Dropped** | Explicitly labelled "Acceptable" by Claude. |

---

## 7. Net verdict + top 3

### Verdict: APPROVE with follow-ups

Phase 6a ships the intended surface — hub, staff list, inspector detail, signature capture, equipment card, default-inspector mutex, role helpers, middleware gate, auth'd signature read endpoint — and honours the handoff's "6b/6c stubbed as disabled hub cards" stop-the-line rule (contra Claude's P1-a). Backend additions are minimal and mirror an existing pattern. Security posture is solid: tenancy checks on every handler, basename-only path handling, no XSS sinks, no CSRF surface (Authorization header only). The `/login` Suspense fix is correct and targeted.

The two real P1 correctness issues — both surfaced by Codex only — are scoped and tractable for Phase 7 polish: signature/state bleed across client navigation, and the zero-default-inspector invariant. Neither blocks the rebuild branch, but both block a confident promotion to `main`.

### Top 3 priorities before merging `web-rebuild` → `main`

1. **Enforce the single-default-inspector invariant on both delete and edit paths.** (`staff/page.tsx:56`, `staff/[inspectorId]/page.tsx:154`) — auto-promote a deterministic successor when the current default is deleted; disallow saving a non-empty profile list with zero defaults. Prevents a data state that silently breaks cert generation downstream.
2. **Add a proper user-dirty flag to `SignatureCanvas` and clear stale state on `initialSignatureFile` / `inspectorId` change.** (`signature-canvas.tsx:153, 220-228`, `staff/[inspectorId]/page.tsx:66, 136-143`) — addresses both the "transient fetch fail wipes persisted signature" (Claude framing) and "unchanged signature re-uploads on every save, orphaning old S3 keys" (Codex framing) and the A→B state bleed all in one fix.
3. **Close the a11y + temp-file-cleanup polish items.** (delete-dialog focus trap + Escape handling, custom toggle `:focus-visible`, error regions `role="alert"`, signature canvas non-pointer fallback, and move `fs.unlink` into `finally` at `src/routes/settings.js:270`.) None are individual blockers, but together they cover the WCAG 2.1 AA gaps that Phase 7 is meant to start clean on.

---

### Review tallies

- Agreed items: **6** (signature-dirty, delete-dialog focus, canvas role, clear-logic duplication, missing tests, plan alignment)
- Adjudicated disagreements: **7**
- Claude-unique retained: **12**
- Codex-unique retained: **7**
- Dropped/downgraded: **9**
