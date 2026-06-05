---
title: iOS-embedded privacy text vs public privacy policy — drift audit
status: action-required-decision
last_verified: 2026-05-11 (overnight autonomous run)
maintainer: Derek Beckley
purpose: surface concrete inconsistencies between the iOS-embedded LegalTexts.swift and the publicly-served privacy policy, and recommend a fix path
source_of_truth: .planning/compliance/privacy-policy.md (public) + .planning/compliance/facts.md (data inventory)
audience: future-Derek deciding whether to fix-now or defer
---

# iOS legal text drift audit

The iOS app embeds full privacy/terms/EULA copy in `Sources/Views/Launch/LegalTexts.swift` and presents it via `TermsAcceptanceView` at first launch. That copy was last updated **9 March 2026** — before the comprehensive UK GDPR privacy policy work that landed in `.planning/compliance/privacy-policy.md` on 2026-05-11.

The two documents are now out of sync on several material points. This matters because:

1. **Apple App Store Guideline 5.1.1(i)** requires that what your in-app privacy text says matches what your App Privacy Nutrition Labels (and your Privacy URL) say. Significant drift between in-app and public privacy text can trigger rejection on this guideline.
2. **UK GDPR Articles 12–14** require that privacy notices presented to data subjects be accurate, consistent, and not misleading. A user accepting the iOS in-app policy and then later reading the certmate.uk version should see the same facts.

The drift is **substantial enough to be worth fixing** before App Store submission. Below is a per-claim audit; recommended action at the end.

## Drift table

Comparison between `LegalTexts.swift::privacyPolicy` (iOS-embedded) and `.planning/compliance/privacy-policy.md` (now live at `certmate.uk/legal/privacy-policy`).

| Claim | iOS-embedded says | Public privacy policy says | Drift severity |
|---|---|---|---|
| Voice recording retention | "Not permanently stored; streamed and discarded." | "Audio is NOT retained outside the live transcription stream. `mip_opt_out=true` set on every connection so the transcription provider may not retain audio for model training." | LOW — same direction, public adds the MIP detail |
| Transcript retention | "Transcripts: retained while account is active; deleted on closure or request." | "The text transcript is retained for **30 days** for operational debugging only; it is then deleted automatically." | **HIGH — direct contradiction** |
| Certificate + supporting data retention | "Account and certificate data: retained while your account is active, **plus 12 months**." | "Finalised certificates and their supporting data (job records, photographs): **7 years from the date of issue** (NICEIC requires 6 years; we add one year as a safety margin)." | **HIGH — direct contradiction** |
| Billing record retention | "6 years (UK tax requirements)" | Public doesn't currently state explicitly but `retention-policy.md` agrees | OK |
| Right of erasure | "You may request deletion at any time." | "You may also delete your account directly in the app at Settings → Delete Account." | MEDIUM — iOS omits the in-app self-service path |
| Sub-processors | Names "Deepgram, Anthropic/Claude Sonnet, OpenAI/GPT Vision" | Public sub-processors list adds AWS + ElevenLabs and gives the formal Article 28 framing | MEDIUM — public is more complete |
| NICEIC retention carve-out | Not mentioned | Retention table is explicit about the 6-year scheme rule | MEDIUM — iOS user doesn't know certs survive deletion |
| `mip_opt_out` flag (Deepgram) | Not mentioned | Public privacy policy + facts.md call it out explicitly | LOW — implementation detail; arguably not user-facing |
| "Data (Use and Access) Act 2025" reference | Mentioned in iOS section 1 | Not mentioned in public version | LOW (different framing choice) |
| Last-Updated date | 9 March 2026 | (frontmatter `last_verified: 2026-05-11`) | The dates need to align after any fix |

## The HIGH-severity items in detail

### 1. Transcript retention (iOS says "while account active", public says "30 days")

This is a **direct contradiction** that a 5.1.1(i) reviewer can spot quickly. A user who accepts the iOS in-app policy is told their transcripts persist for as long as their account exists. A user reading certmate.uk's policy is told 30 days. Same controller, same data, two different retention periods.

Resolution: public policy is correct (per `retention-policy.md` and the deployed 30-day S3 lifecycle on `session-analytics/`). iOS text should be updated to match.

### 2. Certificate retention (iOS says "account + 12 months", public says "7 years from issue")

Same contradiction, higher stakes — certificates carry homeowner names + addresses + electrical condition data. iOS promises a much shorter retention than what's actually configured server-side (the NICEIC 6-year scheme rule applies; the new account-deletion endpoint specifically archives PDFs for 6+1 years).

Resolution: iOS should reflect the 7-year (6 NICEIC + 1 safety margin) retention. The new in-app `DeleteAccountSheet` already explains this; the in-app privacy text should match.

### 3. In-app account deletion path

iOS text says "You may request deletion at any time" — the implication is to email support. The new in-app Delete Account button in Settings makes deletion self-service. The public privacy policy should be updated to match too; iOS lags this.

Resolution: iOS gets "You can delete your account in the app at Settings → Delete Account, or contact us." Public privacy policy should be checked for the same wording.

## Recommended action

Three paths, in order of "fix completeness":

### Path A — Defer (lowest risk, highest residual drift)

Do nothing this submission. Accept the residual 5.1.1(i) risk that a careful Apple reviewer notices the transcript/certificate retention mismatch. Mitigation: the reviewer notes in `.planning/compliance/app-review-reviewer-notes.md` can be expanded to say "the in-app text is being updated in the next release; the public policy is authoritative".

Worst-case outcome: rejection with a "your in-app privacy text contradicts your privacy URL" note, requiring a fix-and-resubmit cycle (~3-5 days).

### Path B — Surgical update to LegalTexts.swift (recommended)

Edit `Sources/Views/Launch/LegalTexts.swift` `privacyPolicy` string in three places:

1. Update **section 7 "Data retention"** to mirror the public policy (specifically the 30-day transcript retention and 7-year certificate retention).
2. Update **section 8 "Your rights"** to mention the in-app `Settings → Delete Account` path.
3. Bump the dated **Last Updated** line at the top from "9 March 2026" to "11 May 2026".
4. Bump `TermsAcceptanceView.currentVersion` to force re-acceptance on next launch.

UX impact: existing TestFlight users will see a one-time re-acceptance screen. Apple reviewers will see the same screen on first launch of the demo account, which doesn't add review friction (it's the same flow new users see).

This closes the HIGH-severity drift items without changing the architecture.

### Path C — Replace embedded text with a link to certmate.uk (longest-term, biggest change)

Refactor `TermsAcceptanceView` to display a short summary in-app + a "Read the full Privacy Policy" link that opens `certmate.uk/legal/privacy-policy` in `SFSafariViewController`. Eliminates the drift class permanently — there's only one privacy text, served from the web.

UX impact: still need to bump `currentVersion`. The acceptance flow becomes "I have read and agree to the Privacy Policy + Terms" with a link, rather than scrolling through 50+ paragraphs. This is the better long-term shape — exactly what most modern UK consumer apps do — but it's a larger change.

Not recommended for this submission cycle; flag as a Phase 2 cleanup post-App-Store-approval.

## Recommended verbatim edits for Path B

To save typing time tomorrow, here are the suggested replacement strings:

**Section 7 — replace:**

```
Account and certificate data: retained while your account is active, plus 12 months.
Voice recordings (raw audio): not permanently stored; streamed and discarded.
Transcripts: retained while account is active; deleted on closure or request.
Billing records: 6 years (UK tax requirements).
Usage/diagnostic data: 24 months.
Backups: up to 90 days.

You may request deletion at any time.
```

**With:**

```
Issued certificates and the supporting job data: 7 years from the date of issue. The NICEIC scheme requires 6 years; we add a 1-year safety margin. This retention applies even after you delete your account — issued certificates are archived and dissociated from your active account but kept for scheme-audit purposes.
Voice recordings (raw audio): not retained. Audio is streamed live to our transcription provider and discarded after transcription. We set the `mip_opt_out=true` flag on every connection so the provider may not retain the audio for model training.
Voice transcripts (text): retained for 30 days for operational debugging, then deleted automatically.
Billing records: 6 years (UK tax law).
Usage and diagnostic data: 24 months.
S3 backups: up to 90 days.

You can delete your account in the app at Settings → Delete Account at any time. The deletion erases your account record, all stored personal data, and all S3 objects within seconds. Issued certificate PDFs are kept under the 6-year scheme-retention rule as described above. Any retention beyond your control is logged in an audit register kept under UK GDPR Article 17(3)(b).
```

**Section 8 — replace:**

```
Under UK GDPR and the Data (Use and Access) Act 2025, you have the right to: access your data; correct inaccuracies; request deletion; restrict processing; object to processing; data portability; withdraw consent; and not be subject to automated decisions.
```

**With:**

```
Under UK GDPR you have the right to: access your data; correct inaccuracies; request deletion (you can do this in-app at Settings → Delete Account, or by emailing privacy@certmate.uk); restrict processing; object to processing; data portability; withdraw consent; and not be subject to solely-automated decisions that produce legal effects.
```

**Top-of-file `Last Updated:` line — replace:**

```
Last Updated: 9 March 2026
```

**With:**

```
Last Updated: 11 May 2026
```

**TermsAcceptanceView.currentVersion — bump:**

```swift
// Find the static let currentVersion = ... line and increment.
```

After edits, run:

```
cd ~/Developer/EICR_Automation/CertMateUnified
xcodebuild -scheme CertMateUnified -destination 'generic/platform=iOS Simulator' build
```

Commit, then deploy-testflight.sh. The re-acceptance flow on next launch confirms the new text loads correctly.

## Why I didn't apply Path B autonomously overnight

Path B forces a re-acceptance UX on every existing TestFlight user. That's a UX-shaping decision (it interrupts the user's next launch with a wall of text). Forcing it on the TestFlight build that's also about to go to App Store reviewers is a coordinated change that deserves Derek's sign-off before shipping — particularly because:

- The current TestFlight build (`b56160e`) is the one about to be promoted to App Store review. Adding a re-acceptance UX changes what Apple reviewers see on first launch.
- Bumping `currentVersion` affects existing testers who've already accepted the prior version.
- Path B's text is best refined with your eyes on Apple's likely reviewer questions, not by overnight Claude judgement alone.

If you agree with the Path B fix as written, the edits are short (~20 lines in `LegalTexts.swift`) and can ship as a follow-up commit before the TestFlight push.
