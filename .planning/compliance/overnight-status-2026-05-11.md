---
title: Overnight status — App Store launch prep (2026-05-11 → 2026-05-12 morning)
status: morning entry point
last_verified: 2026-05-12 (overnight, written at end-of-session)
maintainer: Derek Beckley
purpose: pick-up-from-cold brief for the morning after autonomous overnight execution
read_first: ./app-store-submission-checklist.md (the runbook this work fed into) + ./app-review-reviewer-notes.md (the Apple-facing material)
audience: morning-Derek opening the laptop after a night's sleep
---

# Overnight status — App Store launch prep

## TL;DR — first three minutes

Two big things shipped overnight, both already pushed and one already live in production:

1. **Public legal corpus at `/legal/*`** — six App-Store-ready compliance documents now serve as static HTML to any visitor. App Store's Privacy URL has a target. **LIVE in production** (CI run `25697467543` succeeded at ~21:41 BST).
2. **Hard-delete account flow** (Apple 5.1.1(v) blocker) — backend `DELETE /api/auth/account` rewritten from soft-delete to true erasure with NICEIC archive; iOS Settings now shows a "Delete Account" button + confirmation sheet. **Pushed, CI run `25699533837` deploying.**

One App-Store-critical thing remains in your hands: **TestFlight push of the iOS build** to put the deletion UI (and the two earlier compliance commits a3eaccd / aa7141c) in front of Apple reviewers. Run from `~/Developer/EICR_Automation/CertMateUnified/`:

```
./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```

Everything else is form-filling in App Store Connect (drafts ready in `app-store-submission-checklist.md` + `app-review-reviewer-notes.md`).

## What got done overnight, with commit hashes

### EICR_Automation (backend + web)

All on `origin/main`. CI run `25699533837` is queued to deploy the last three.

| Commit | What | Live in prod? |
|---|---|---|
| `bd22fde` | feat(web): publish public legal corpus at /legal/* | ✅ via run 25697467543 |
| `13fdc87` | docs(compliance): App Store submission checklist with Nutrition Labels | ✅ via run 25697467543 |
| `ae83907` | (parallel-session) fix(migrations/009): users.is_active boolean migration | ✅ via run 25697467543 |
| `edff1d9` | feat(auth): hard-delete account on DELETE /api/auth/account (5.1.1(v)) | 🟡 CI run 25699533837 |
| `bd4bacb` | feat(web): public /support page for App Store Support URL | 🟡 CI run 25699533837 |
| `06718b9` | docs(compliance): App Review reviewer notes + deletion-UX audit | 🟡 CI run 25699533837 |

### CertMateUnified (iOS)

All on `origin/main`.

| Commit | What |
|---|---|
| `295a4f4` | chore(ios): bump CFBundleVersion 346 → 359 |
| `b56160e` | feat(settings): in-app account deletion UI (Apple 5.1.1(v)) |

iOS still needs a TestFlight push to actually be in Apple's hands.

## What's actually live vs. what's still queued

```
                               PROD
                                |
EICR_App:  bd22fde  ──►  ──►  ──┤  ✓ legal pages serving at /legal/*
           13fdc87  ──►  ──►  ──┤  (planning docs — not user-visible)
           ae83907  ──►  ──►  ──┤  (migration 009 applied to RDS)
                                |
           edff1d9  ──►  ──►  CI 25699533837 (~30 min wall)
           bd4bacb  ──►  ──►  CI 25699533837
           06718b9  ──►  ──►  CI 25699533837
                                |
iOS:       295a4f4  ──►  origin/main  ── TestFlight  ── App Store
           b56160e  ──►  origin/main  ── TestFlight  ── App Store
                          ↑
                  ⏳ deploy-testflight.sh is your move
```

## Status against the launch-prep handoff (Path B)

Cross-referenced against `.planning/compliance/handoff_2026-05-11_launch_prep.md` Path B items:

| Path B item | Status |
|---|---|
| **#1 TestFlight push** of pending compliance commits | ⏳ Manual — run `./deploy-testflight.sh` |
| **#2 Tabletop** of `incident-response-runbook.md` | ☐ Not started overnight (~1h, in-person task) |
| **#3 Publish public legal docs to certmate.uk** | ✅ Done + live in prod |
| **#4 In-app account deletion** | ✅ Backend deployed (after CI), iOS shipped to main, needs TestFlight |
| **#5 In-app consent screen** | ⏸ Blocked on solicitor review of Beta Tester Agreement (Path A) |
| **#6 App Store submission** | 📋 Drafted in `app-store-submission-checklist.md`, awaiting your form-fill |

Bonus completed: **public /support page** at `/legal-adjacent /support` route — gives Apple a Support URL distinct from the Privacy URL.

## What you need to do in the morning

In rough priority order. Items 1 and 2 are the only must-do-today gates.

### 1. TestFlight push (~1h interactive + Apple processing)

```
cd ~/Developer/EICR_Automation/CertMateUnified
./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```

This puts on TestFlight:

- `aa7141c` (EXIF strip — DPIA risk R5)
- `a3eaccd` (Deepgram `mip_opt_out` — DPIA risk R2)
- `b56160e` (in-app deletion UI — Apple 5.1.1(v) blocker)

After upload, the build sits in "Processing" for Apple's pipeline for ~15-30 min, then becomes available to TestFlight testers. Trigger a TestFlight install on your iPad/iPhone and **verify the Delete Account button is visible in Settings**, the sheet appears, and the destructive confirm dialog fires. Do NOT actually delete your own account on the production build.

### 2. Verify the legal/support pages resolve in prod

The DNS for certmate.uk has to be pointed at the ECS deployment for App Store reviewers (and ICO) to actually hit these URLs. After CI run `25699533837` completes (~30 min from 21:53 BST push), curl the following from any network:

```
curl -I https://certmate.uk/legal/privacy-policy
curl -I https://certmate.uk/legal/cookie-policy
curl -I https://certmate.uk/legal/sub-processors
curl -I https://certmate.uk/legal/acceptable-use-policy
curl -I https://certmate.uk/legal/beta-tester-agreement
curl -I https://certmate.uk/legal/door-script
curl -I https://certmate.uk/support
```

All must return 200. If certmate.uk is still pointed at the old frontend (or unresolved), see the AWS todo "Point CertMate.co.uk to certomatic3000 site" — DNS / Route 53 / ACM cert / ALB target group all need to align before submission. The handoff's note that *"domain is certmate.uk, NOT certomatic3000.co.uk"* applies — the public URLs must match the privacy-policy text we published.

### 3. App Store Connect form-fill (~3h)

Open App Store Connect and walk down `.planning/compliance/app-store-submission-checklist.md` sections §3 → §9. The Nutrition Labels matrix in §3 is the bulk of the work; everything else is short-form text.

For the "App Review Information → Notes" field, copy §1 of `.planning/compliance/app-review-reviewer-notes.md` verbatim.

Use the **demo account checklist** in §3 of the reviewer-notes doc to set up the Apple-reviewer-only RDS row.

### 4. Subtitle trim (5 min)

Current draft `Voice-driven EICR & EIC certificates` is 38 chars; Apple's limit is 30. Suggested: `Voice-driven electrical certs` (29 char). Or pick your own — but pre-trim before pasting into the listing.

### 5. Screenshots (~90 min)

Apple wants screenshots for 6.7" iPhone + 12.9" iPad minimum. Boot the TestFlight build, take 4-5 screens per device class, sanitise any real data, drop into App Store Connect. Suggested screens per §6 of the submission checklist.

## Open decisions I left for you

Three items I could have made overnight but felt out of scope:

1. **Should iOS app immediately log out OR show a "Deleted!" success toast first?** Currently it just navigates back to the LoginView via the `currentUser = nil` observation. No success toast. That's the most aligned with what Apple's deletion guideline wants ("don't celebrate, just confirm and exit"). If you want a toast in between, it's a ~10-line change to `DeleteAccountSheet.swift`.
2. **/legal layout for mobile** — tested at desktop width; phone widths render OK from the table-overflow + responsive padding but I haven't visually verified on a real iPhone yet. If a screenshot looks bad on a real device, the fix lives in `markdown-render.tsx` (probably tighten table padding) or `legal/layout.tsx` (header sizing).
3. **App Store IAP vs. web signup** — see "Open questions" in the launch-prep handoff. No urgency; doesn't gate submission. Decide before paid plans launch.

## Audit trail — what changed under the hood

If you want to deep-dive specific changes:

- **Why "soft delete" was a 5.1.1(v) violation:** `edff1d9` commit body covers the Apple guidance and links the broken legacy code line.
- **Foreign-key cascade audit:** `src/db.js::hardDeleteUserAccount` docstring — full coverage table of every FK to `users(id)` and what the deletion endpoint does about each.
- **NICEIC retention archive:** `src/routes/auth.js` step 2 + the deletion-UX audit §2.3.
- **Mockable storage layer:** new `copyObject(srcKey, dstKey)` in `src/storage.js` (S3 + local both supported).

## If CI run 25699533837 fails

The pre-push hook ran the full 3,308-test suite locally before pushing — odds of a CI red are low. But if it does fail:

1. `gh run view 25699533837 -R derek570/EICR- --log-failed | tail -100` to read the failure.
2. Most-likely-broken paths are S3 IAM permissions for the new `archive/{userId}/` prefix (the CopyObject + DeleteObjects on `archive/*` may need an explicit policy add) — check the bucket policy + the IAM role attached to `eicr-backend`.
3. The deletion test suite is in `src/__tests__/routes-auth-delete-account.test.js` — five cases; the failing test name will narrow the diagnosis.

## Tasks completed by the autonomous run

For the task list:

```
#9.  ✓ Field-render check of /legal/* (dev server + curl)
#10. ✓ Push /legal/* commits to main (triggers CI deploy)
#11. ✓ Audit RDS schema for ON DELETE CASCADE coverage
#12. ✓ Build backend DELETE /api/me endpoint
#13. ✓ Build iOS Settings → Account → Delete UI
#14. ✓ Build /support page route + draft content
#15. ✓ Write deletion-modal copy spec + reviewer notes doc
#16. ✓ Write STATUS.md overnight handoff for morning resume  ← this doc
```
