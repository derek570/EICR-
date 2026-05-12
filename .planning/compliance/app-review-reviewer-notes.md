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
> **No electrical knowledge required:** every phrase the reviewer needs to speak is written out word-for-word in the "Test phrases" section below. Just read them aloud at normal pace. The app's job is to convert voice → text → structured certificate fields; you're testing that pipeline works, not whether the readings are technically valid.
>
> **First sign-in plays a guided tour:** when the reviewer first reaches the Dashboard, CertMate automatically starts a ~5-minute audio tour (10 narrated steps) explaining every feature. Keep volume on and headphones plugged in if convenient. The tour walks through the home screen → defaults → recording orientation → consumer-unit photo step → how to dictate readings → bulk-circuit dictation → voice confirmations → observations → voice commands → PDF generation. The reviewer can let it auto-advance or tap to skip individual steps.
>
> **Test inspection (the golden path):**
>
> 1. **Sign in** with the demo credentials. Allow the tour to play (or tap-to-skip).
> 2. **Open the existing demo job** "1 Apple Review Lane" on the Dashboard. This already contains a populated certificate with a consumer-unit photo + extracted circuits + dictated readings — you can see the end state immediately without recording anything yourself.
> 3. **(Optional)** To test the new-job flow from scratch: tap "New Job" → type the UK postcode `RG30 4XW` → tap Lookup → address fields populate. Tap "Take photo of consumer unit" — pick any image from the photo library; CertMate's GPT Vision analyses it and returns a circuit schedule.
> 4. **Test the voice extraction:** tap "Start Recording", read one of the test phrases below aloud at normal pace. The transcript appears live in the bar at the bottom of the screen; the relevant certificate field highlights bright blue, then fills with the spoken value within ~1 second.
> 5. **Stop and review:** tap "Stop Recording" and check the Inspection / Circuits / Observations tabs — every field the AI extracted should be visible, editable, and the inspector can confirm or correct each one.
> 6. **Issue the PDF:** tap the PDF tab → tap "Generate PDF". Two tick-boxes appear that the inspector must confirm before the certificate is generated: one for readings, one for observations. Both are required every time. After confirming, the certificate renders locally on-device using WKWebView and can be shared or printed. No real homeowner data is in the demo account.
>
> **Test phrases — read these aloud verbatim while recording:**
>
> Each phrase below has been transcribed in fully-spelled-out form (no abbreviations) to match how an inspector dictates aloud. After speaking each, watch the certificate fields populate in real time.
>
> | # | Speak this verbatim | Where it lands in the app |
> |---|---|---|
> | 1 | *"Earth fault loop impedance zero point one zero ohms"* | Ze field on the Earthing card highlights blue then fills with `0.10` |
> | 2 | *"Prospective fault current one point two kilo amps"* | PFC field on the Earthing card fills with `1.2 kA` |
> | 3 | *"Circuit one is a thirty two amp ring final"* | Circuits tab → Circuit 1 row populates with designation + amperage |
> | 4 | *"Circuit one Zs zero point two five ohms"* | Circuits tab → Circuit 1 Zs column fills with `0.25` |
> | 5 | *"Insulation resistance live to earth greater than nine ninety nine megger ohms"* | Circuit 1 IR (insulation resistance) column fills with `>999` |
> | 6 | *"RCD trip time for circuits one to three is twenty five milliseconds"* | Multiple circuits — Circuits 1, 2, and 3 all fill their RCD trip column with `25 ms` |
> | 7 | *"Observation — front cover not securely fixed. Code two."* | Observations tab gains a new row classified as a C2 observation |
> | 8 | *"What's the Ze?"* | Voice command — the app speaks the current Ze value back via text-to-speech |
>
> The phrases are deliberately simple and use full words rather than abbreviations (i.e. "thirty two amp" not "32 A"). Speak at normal pace — the live transcript bar shows interim text as you talk, then finalises and extracts within ~1 second of the phrase ending.
>
> If voice extraction doesn't fire on the first attempt, check the small dot at the left of the transcript bar — green means the speech-to-text service is connected and listening. Orange/red would indicate a transient connectivity issue; tap Stop Recording and tap Start Recording again to reconnect.
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
