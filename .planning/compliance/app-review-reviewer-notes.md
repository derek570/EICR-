---
title: App Review reviewer notes + deletion-UX audit
status: copy-into-asc-on-submission
last_verified: 2026-05-11
maintainer: Derek Beckley
purpose: the text + screenshots an Apple App Review reviewer needs to evaluate CertMate against 5.1.1(v), 5.1.1(i), 4.2, and the generic content guidelines
read_first: ./app-store-submission-checklist.md
audience: Apple App Review (via App Store Connect's Review Information field) + future-Derek pre-flighting the submission
---

# App Review reviewer notes

This document has two halves:

1. **Reviewer Notes (copyable text)** — the text to paste into App Store Connect's "App Review Information → Notes" field on submission.
2. **Deletion-UX audit** — the exact tap path, copy, and behaviour the 5.1.1(v) reviewer will see when they exercise account deletion. Useful for self-review before submission and as the post-submission record if Apple ever asks "what does your deletion flow do?".

---

## 1. Reviewer Notes (paste into App Store Connect)

> CertMate is a voice-driven EICR / EIC certificate authoring tool for UK electricians. The reviewer can sign in with the demo account credentials supplied above, then exercise the recording pipeline as described below.
>
> **Test inspection (the golden path):**
>
> 1. From the Dashboard, tap "New Job".
> 2. Enter a property — type any UK postcode (e.g. RG30 4XW) and tap Lookup. Address fields will populate from the postcode service.
> 3. Tap "Take photo of consumer unit". For an instant photo, tap the simulator photo library and pick any image; CertMate analyses it via GPT Vision. Real-world it would be the inspector's own camera.
> 4. Tap "Start Recording". Speak any phrase containing a numeric reading, e.g. "earth fault loop impedance zero point one one ohms" or "Ze zero point one two". The transcript appears live in the bar at the bottom; the corresponding field highlights blue then fills with the value within ~1 second.
> 5. Tap "Stop Recording" and review the populated certificate tabs.
> 6. Tap "Issue PDF" — two tick-boxes appear that the inspector must confirm before the certificate is generated: one that they have personally reviewed every reading, one that they have personally reviewed every observation. Both confirmations are required every time a PDF is generated. The certificate renders locally on-device using WKWebView. No real homeowner data is in the demo account.
>
> **Guideline 5.1.1(ix) — AI / generative content posture:** CertMate uses Anthropic Claude Sonnet to extract structured certificate readings from inspector voice dictation, and OpenAI GPT Vision to identify consumer-unit components from inspector photos. Both outputs are presented as **suggestions** to the qualified inspector, who reviews and edits every field on tabs before issuing the certificate. The two per-PDF tick-boxes described in step 6 are the durable audit record of that review. CertMate does not produce determinations: the named inspector is the responsible professional for every certificate issued. The mechanism is documented at [pdf-issuance-attestations.md](./pdf-issuance-attestations.md) (internal) and visible to end users via the Beta Tester Agreement §4.3.1 at https://certmate.uk/legal/beta-tester-agreement.
>
> **Microphone, camera, photo library prompts:** CertMate is a dictation aid for issuing electrical inspection certificates. The microphone permission is core (voice dictation of test readings); camera is for photographing consumer units and defects; photo library is for re-attaching previous job photos to observations. Each prompt is shown when the user first taps a feature that needs it. Decline-and-retry both work cleanly.
>
> **Account deletion (Guideline 5.1.1(v)):** Settings → "Delete Account" (red border, bottom of the screen). A confirmation sheet explains what is deleted and what is retained (NICEIC scheme-rule 6-year retention of issued PDFs only — required by competent-person scheme audit obligations). A second affirmative tap is required. On success the account row + all personal data are erased from RDS and S3 within seconds; the user is returned to the login screen. See the publicly-served documentation at https://certmate.uk/legal/privacy-policy for the full data inventory.
>
> **Support:** https://certmate.uk/support and support@beckleyelectrical.co.uk.

---

## 2. Deletion-UX audit — what 5.1.1(v) review will see

This section pins the deletion flow so it can be self-reviewed before submission, and so future builds don't accidentally introduce a 5.1.1(v) regression.

### 2.1 Tap path (must be ≤ 3 taps from app launch)

1. App launch → Dashboard.
2. Tap the **Settings gear** in the top nav.
3. Scroll to the bottom; tap **"Delete Account"** (red text + red border, distinct from the Logout button immediately above it).
4. The Delete Account sheet appears.
5. Tap **"Delete My Account"** (red filled button).
6. A `confirmationDialog` appears with title *"Delete your CertMate account?"* and a destructive **"Delete My Account"** action plus a Cancel.
7. Tap the destructive action → loading state for ~3–5 seconds → user is returned to the LoginView.

Apple's bar is "clear and accessible from within the app". 3 user taps + 1 system-presented confirmation is well within the conventional band.

### 2.2 Sheet copy (verbatim — keep in sync with `DeleteAccountSheet.swift`)

**Hero banner (red):**

> **This will permanently delete your account.**
>
> There is no undo. Once confirmed, the data below is erased from CertMate's servers within a few seconds.

**Section "WHAT GETS DELETED":**

- Your account: email, name, password, and login history
- Job records, properties, and client contact details you've created
- Photographs of consumer units and observations
- Voice recordings, live transcripts, and AI-extraction debug logs
- Inspector signature, profile settings, and test-equipment records
- Push notification subscriptions and any linked Google Calendar tokens

**Section "WHAT IS RETAINED":**

> Issued certificate PDFs (EICRs and EICs) are moved to a retention archive and kept for 6 years from issue date.
>
> Why: NICEIC, NAPIT, and other competent-person schemes require inspectors and the platforms they use to retain issued certificates for scheme-audit purposes. The archived PDFs are dissociated from your active account and are not searchable through CertMate.
>
> A short audit log of the deletion event itself is also retained under UK GDPR Article 17(3)(b) (legal-obligation carve-out for processing records). It contains only the deletion timestamp and the row counts — no personal data.

**Destructive confirmation dialog message:**

> This cannot be undone. Your account, jobs, photos, and voice transcripts will be permanently erased. Issued certificate PDFs are kept under scheme-retention rules for 6 years.

### 2.3 What actually happens server-side

When the destructive action is confirmed (audited 2026-05-11 against backend commit `edff1d9` and shared-types schema):

| Step | Action | Where |
|---|---|---|
| 1 | Audit log entry `account_deletion_started` written with `email` + `role` + IP. | RDS `audit_log` |
| 2 | NICEIC PDFs copied from `jobs/{userId}/*/output/*.pdf` to `archive/{userId}/*` | S3 |
| 3 | RDS transaction: DELETE FROM `job_versions`, `jobs`, `properties`, `clients`, then `users`. Cascading FKs clear `push_subscriptions`, `subscriptions`, `calendar_tokens`. | RDS |
| 4 | Wipe S3 prefixes `jobs/{userId}/`, `settings/{userId}/`, `session-analytics/{userId}/`. | S3 |
| 5 | Audit log entry `account_deleted` with per-table row counts + per-prefix S3 object counts. | RDS `audit_log` |
| 6 | HTTP 204 No Content returned to the iOS client. | API |
| 7 | iOS clears local JWT, local GRDB SQLite, sets `currentUser = nil`. SwiftUI swaps the root view to `LoginView`. | iOS |

`audit_log` is intentionally NOT erased (UK GDPR Art. 17(3)(b) — legal-obligation carve-out for processing records). `audit_log.user_id` is a TEXT column with no FK, so the row persists after the user row is gone and serves as the compliance receipt.

### 2.4 Admin self-delete is refused

The backend returns 403 for any authenticated user whose `role === 'admin'`. The iOS button is hidden for admins (showing a button that always errors is a worse UX than not surfacing it). Admin accounts are deleted by another admin via the admin-users surface; the standard 5.1.1(v) "you must let the user delete their own account" requirement is met for regular users — who are the only data subjects Apple's guideline contemplates.

### 2.5 Error handling

If the network is unreachable, the sheet stays open and shows: *"Couldn't reach CertMate. Check your connection and try again."*

If the backend errors during deletion, the sheet stays open and shows: *"Couldn't delete the account. Try again, or email privacy@certmate.uk."*

In both cases the user can re-tap the destructive action or dismiss the sheet. There is no "soft fail" — if the backend reports anything other than 204 the iOS UI surfaces the error and does NOT clear the local session.

### 2.6 References

- iOS implementation: `CertMateUnified/Sources/Views/Settings/DeleteAccountSheet.swift` (commit `b56160e`)
- iOS trigger: `CertMateUnified/Sources/Views/Settings/SettingsView.swift` `deleteAccountButton` (same commit)
- Backend endpoint: `EICR_Automation/src/routes/auth.js` `DELETE /api/auth/account` (commit `edff1d9`)
- Backend RDS cascade: `EICR_Automation/src/db.js` `hardDeleteUserAccount` (same commit)
- Backend tests: `EICR_Automation/src/__tests__/routes-auth-delete-account.test.js` — 5 cases, all green
- Public privacy policy section that promises this: `/legal/privacy-policy` §"How long we keep data" + §"Your rights"

---

## 3. Demo account checklist (separate from Apple's reviewer notes)

Before submitting, Derek's pre-flight for the demo account:

| ☐ | Item |
|---|---|
| ☐ | Email = a dedicated test inbox (NOT Derek's personal). Suggestion: `apple-review+demo@beckleyelectrical.co.uk` or similar. |
| ☐ | Password = strong but easy to type during Apple review (no special chars that get auto-corrected on iPad). |
| ☐ | One synthetic job in the dashboard with a clearly fake address ("1 Apple Review Lane, Cupertino"), no real homeowner names. |
| ☐ | One issued PDF in that synthetic job so the PDF render flow can be exercised without recording new data. |
| ☐ | The account is **NOT** in any company-admin role — so the Delete Account button is visible and exercisable. |
| ☐ | Cost-tracker is configured to ignore this user ID (or the demo account is in a per-user sandbox with no billing impact). |
| ☐ | A note appended to the synthetic job's `client_name`: "DEMO — Apple Review test data, please ignore." — helps internal triage if the account ever surfaces in production exports. |

## 4. When this doc is needed

- **Day-of submission:** copy §1 into App Store Connect's "App Review Information → Notes" field. Verbatim, no edits.
- **After any deletion-UX change:** re-audit §2 against the diff; if behaviour or copy moves out of sync update this doc in the same commit.
- **If Apple rejects on 5.1.1(v):** the rejection email will quote specific copy or behaviour. Map their quote to §2 to identify exactly what they didn't see / didn't understand.
