---
title: App Store Submission Packet — paste-ready
status: ready to paste into App Store Connect
last_verified: 2026-05-12
maintainer: Derek Beckley
purpose: every text field in the App Store Connect submission flow, finalised and ready to copy-paste in the order ASC presents them
read_first: ./app-store-submission-checklist.md (the gate-by-gate checklist this packet feeds)
related: ./app-review-reviewer-notes.md ./demo-account-setup.md ./facts.md
audience: future-Derek with App Store Connect open in another tab, ready to click Submit
---

# App Store Submission Packet

This document is the **single source of paste-ready text** for every field App Store Connect will ask for. The companion `app-store-submission-checklist.md` is the gating runbook (do this before that); this packet is the *content* that goes into each gate's form.

Order below matches App Store Connect's UI navigation. Each section says **what to paste, where, and why**. Where Apple Limits the character count, this packet has been tuned to fit.

## 0. Pre-submission state — verify these are true

| ☐ | Item | How to check |
|---|---|---|
| ☐ | TestFlight build 361 (or later) is **Ready to Submit** in ASC, with the consent screen visible on first launch | App Store Connect → CertMate → TestFlight tab |
| ☐ | `https://certmate.uk/legal/privacy-policy` returns 200 | `curl -s -o /dev/null -w "%{http_code}" https://certmate.uk/legal/privacy-policy` → `200` |
| ☐ | `https://certmate.uk/support` returns 200 | same, replacing `/legal/privacy-policy` with `/support` |
| ☐ | Demo inspector account provisioned per `demo-account-setup.md` | Step 2 of that doc; note the user_id |

## 1. App Information

**ASC nav:** Sidebar → App Information

| Field | Value | Char count |
|---|---|---|
| **Name** | `CertMate` | 8 / 30 |
| **Subtitle** | `Voice-dictated EICR & EIC` | 25 / 30 |
| **Primary Language** | English (U.K.) | n/a |
| **Bundle ID** | `com.certmate.unified` (locked, already correct) | n/a |
| **SKU** | `CERTMATE-IOS-001` | suggestion — pick anything you'll remember |
| **Primary Category** | Business | already correct via `LSApplicationCategoryType` |
| **Secondary Category** | Productivity | optional but useful for discovery |
| **Content Rights** | "Yes, it contains, shows, or accesses third-party content" → **No** | CertMate doesn't bundle third-party content |
| **Age Rating** | 4+ — all rating questions answered "None" | nothing objectionable; see §6 for the questionnaire walk-through |

### URLs (App Information → General Information)

| Field | Value | Verified |
|---|---|---|
| **Privacy Policy URL** | `https://certmate.uk/legal/privacy-policy` | ✅ live |
| **Support URL** | `https://certmate.uk/support` | ✅ live |
| **Marketing URL** *(optional)* | `https://certmate.uk` *(leave blank if marketing site isn't ready)* | check first |

## 2. Pricing and Availability

**ASC nav:** Sidebar → Pricing and Availability

| Field | Value | Why |
|---|---|---|
| **Price** | **Free** | Beta is free; paid plans run through Stripe on certmate.uk per multiplatform-service pattern, NOT through iOS IAP |
| **Availability** | United Kingdom only | initial release — UK-only inspectors. Add Ireland later if/when scheme coverage extends |
| **Pre-Order** | No | unchecked |
| **Volume Purchase Program** | unchecked | n/a |

**Why no Apple IAP:** CertMate fits Apple's **Guideline 3.1.3(b) Multiplatform Service** — subscribers create accounts and pay via the certmate.uk web app (Stripe); the iOS app is the working tool for already-paying inspectors. The iOS app contains zero pricing copy, zero "Buy / Upgrade / Subscribe" CTAs, and no links to `/pricing` or `/signup`. This is the supported pattern for B2B SaaS that keeps 100% of revenue. **Never link out from the iOS app to a payment surface** — Apple's reviewers reject 3.1.1 violations decisively.

## 3. App Privacy — Nutrition Labels

**ASC nav:** Sidebar → App Privacy → Edit

Every cell below is the literal answer to paste/tick. The cross-walk back to `facts.md` §3 is the audit trail; if Apple ever asks "where does that come from?" each row traces.

### 3.1 Header questions (above the data-type tables)

| Question | Answer |
|---|---|
| Do you or your third-party partners use this data for tracking? | **No** |
| Are the third-party partners' data uses governed by your privacy policy? | **Yes** |

> "Tracking" means linking data across other companies' apps/websites for advertising. CertMate has no ad SDKs, no analytics SDKs, no cross-site tracking, no third-party cookies. The sub-processors (Anthropic, OpenAI, Deepgram, ElevenLabs, AWS) all operate on data they receive from us under DPAs and don't link it to advertising identifiers.

### 3.2 Data types — declare each as **Collected**

For each row: tick **Collected**, then for the data-type-specific questions tick the columns below. "Linked to user" means the inspector's account; "Used for tracking" is always **No**.

#### Contact Info

| Data type | Linked | Purposes |
|---|---|---|
| **Name** | Yes | App Functionality |
| **Email Address** | Yes | App Functionality |
| **Phone Number** | Yes | App Functionality |
| **Physical Address** | Yes | App Functionality |

> "Name" covers both inspector account names and homeowner names (the inspector dictates the homeowner name onto the certificate). Apple treats *any* personal identifier the app processes as collected, even data entered by the user about third parties.

#### Location

| Data type | Linked | Purposes |
|---|---|---|
| Precise Location | **Not Collected** | — |
| Coarse Location | **Not Collected** | — |

> EXIF GPS metadata is stripped from every photo before upload (`Sources/Processing/ImageScaler.swift` post-`aa7141c`, live in TestFlight 361). Postcodes are typed text — Apple categorises postcode-as-text under **Physical Address**, not Location.

#### Sensitive Info

| Data type | Linked | Purposes |
|---|---|---|
| Sensitive Info | **Not Collected** | — |

> No race, ethnicity, sexual orientation, pregnancy, disability, political opinion, religious belief, trade union membership, genetics, or biometric template data. Voice is **User Content** under Apple's taxonomy, not Sensitive Info.

#### User Content

| Data type | Linked | Purposes |
|---|---|---|
| **Photos or Videos** | Yes | App Functionality |
| **Audio Data** | Yes | App Functionality |
| **Customer Support** | Yes | App Functionality |
| **Other User Content** | Yes | App Functionality |

> Voice dictation → Audio Data. Transcripts of that audio + observation notes + certificate text + inspector signature image → Other User Content. CCU + observation + document photos → Photos or Videos.

#### Identifiers

| Data type | Linked | Purposes |
|---|---|---|
| **User ID** | Yes | App Functionality |
| Device ID | **Not Collected** | — |

> The internal `users.id` UUID is the account key. No IDFA, no IDFV, no advertising identifiers. JWT tokens are derived from User ID — not a separate declaration.

#### Usage Data

| Data type | Linked | Purposes |
|---|---|---|
| **Product Interaction** | Yes | App Functionality, Analytics |
| Advertising Data | **Not Collected** | — |
| Other Usage Data | **Not Collected** | — |

> Session cost summaries (`session-analytics/{userId}/{sessionId}/cost_summary.json`) and the debug-log JSONL are used for both billing reconciliation (App Functionality) and internal product analytics (Analytics — not third-party).

#### Diagnostics

| Data type | Linked | Purposes |
|---|---|---|
| Crash Data | **Not Collected** | — |
| **Performance Data** | Yes | App Functionality |
| **Other Diagnostic Data** | Yes | App Functionality |

> Crash logs are Apple-managed (TestFlight / App Store Connect, 90-day retention) — CertMate doesn't run its own crash uploader, so Apple's logic treats this as "we" don't collect Crash Data. Performance + Other Diagnostic = the optional debug-log JSONL used to investigate live-extraction issues.

#### Categories explicitly NOT collected

Tick **Not Collected** on these so Apple's algorithm doesn't infer them:

- Health & Fitness — every subcategory
- Financial Info — every subcategory (no card data; payments via Stripe on web)
- Contacts — we never read the device contact book
- Browsing History
- Search History
- Purchases — none (no IAP per §2)
- Other Data — none beyond declared above

## 4. Version Information — paste-ready text

**ASC nav:** App Store → iOS App → 1.0 → Version Information

### 4.1 Promotional Text — 170 char limit, **mutable without re-review**

This is the lever to update messaging between releases. Default:

> Voice dictation, AI extraction, finished PDF in minutes. Built for UK electricians who'd rather be testing circuits than typing about them.

Char count: 142 / 170. Tune freely after first launch when you have user feedback.

### 4.2 Description — 4000 char limit

> CertMate turns voice dictation into finished electrical inspection certificates.
>
> Photograph the consumer unit, dictate test readings while you work, and CertMate transcribes in real time, populates the certificate, prompts you for missing values, and lets you review every field before issuing the PDF.
>
> WHAT YOU CAN DO
>
> • Photograph the consumer unit — CertMate identifies each circuit and builds the schedule
> • Dictate readings as you test — values appear instantly in the correct row
> • Photograph defects — CertMate attaches them to observations automatically
> • Review every field on tabs — edit, confirm, sign
> • Issue the PDF locally on your device — no waiting for a server round-trip
> • Generate both EICR (periodic inspection) and EIC (new installation) certificates
>
> WHO IT'S FOR
>
> CertMate is built for UK qualified electricians registered with NICEIC, NAPIT, Stroma, ELECSA, or equivalent competent-person schemes. The inspector remains the responsible professional under BS 7671 — CertMate is a dictation and data-extraction aid, not the authority on the contents of any certificate.
>
> HOW THE AI WORKS
>
> CertMate uses speech-to-text to transcribe the inspector's dictation, then AI extraction to populate certificate fields from that transcript. Both outputs are presented as suggestions; the inspector reviews and edits every field before issuing the certificate. Every PDF requires the inspector to record two confirmations — one that they have personally reviewed every reading, and one that they have personally reviewed every observation. The named inspector is the responsible professional for every certificate issued.
>
> WHAT'S NOT IN THE APP
>
> CertMate does not store voice audio after a recording session ends (audio is streamed to the transcription service and discarded). Photographs have all location metadata removed before upload. CertMate does not track you across other apps or websites.
>
> The full Privacy Policy is at certmate.uk/legal/privacy-policy. The sub-processor list is at certmate.uk/legal/sub-processors.

Char count: approximately 1,920 / 4,000. Plenty of room to extend after first feedback. Lines starting with `•` render as bullets in App Store; double-line-breaks render as paragraph spacing.

### 4.3 Keywords — 100 char limit, comma-separated, no spaces inside terms

```
EICR,EIC,electrical,inspection,certificate,electrician,NICEIC,NAPIT,wiring,BS7671,voice,dictation
```

Char count: 99 / 100. Refine after first round of App Store search analytics.

### 4.4 What's New in This Version — 4000 char limit, per release

For this initial submission:

> First public TestFlight release of CertMate.

For subsequent releases use a one-liner per user-visible change. Default if there's nothing user-visible: "Stability and performance improvements."

### 4.5 Support URL + Marketing URL

Already in §1 above. Apple shows these in the listing footer.

## 5. iOS App — Build

**ASC nav:** App Store → iOS App → 1.0 → Build → Select a build before you submit

Select TestFlight build **361** (or the latest "Ready to Submit" build, if a later TF push happens between now and submission). The build must have passed beta-review automated checks; it does not need to have been added to the Electricians group.

## 6. Age Rating

**ASC nav:** App Information → Age Rating → Edit

Walk through every category and select **None**:

| Category | Answer |
|---|---|
| Cartoon or Fantasy Violence | None |
| Realistic Violence | None |
| Sexual Content or Nudity | None |
| Profanity or Crude Humor | None |
| Mature/Suggestive Themes | None |
| Horror/Fear Themes | None |
| Medical/Treatment Information | None — CertMate covers electrical, not medical |
| Alcohol, Tobacco, or Drug Use or References | None |
| Simulated Gambling | None |
| Contests | None |
| Unrestricted Web Access | **No** — the only embedded WKWebView is for PDF rendering, never browses |
| Gambling | None |

Resulting age rating: **4+**. The "Unrestricted Web Access" answer is the only one Apple sometimes auto-bumps to 17+ when answered wrong; **answer No** because the WKWebView in CertMate renders certificate HTML only, never user-controlled URLs.

## 7. App Review Information

**ASC nav:** App Store → iOS App → 1.0 → App Review Information

### 7.1 Contact Information

| Field | Value |
|---|---|
| First name | Derek |
| Last name | Beckley |
| Phone number | *(your direct mobile — not visible to public, only to Apple reviewers)* |
| Email | `support@beckleyelectrical.co.uk` |

### 7.2 Demo Account (sign-in required = Yes)

Apple's reviewer will sign in and use the app. Provision the demo account per `demo-account-setup.md` first, then paste:

| Field | Value |
|---|---|
| Sign-in required | **Yes** |
| User name | `apple-review+demo@beckleyelectrical.co.uk` |
| Password | `AppleReviewer2026!` |

Verify these work from a clean simulator (or someone else's iPhone) before pasting — Apple will reject 2.1 if the login fails for them.

### 7.3 Notes (paste this verbatim)

Use the literal text from `app-review-reviewer-notes.md` §1. It already includes:
- The golden-path test inspection script
- The microphone/camera/photo-library permission explanations
- The Guideline 5.1.1(v) account-deletion flow walkthrough
- The Guideline 5.1.1(ix) AI/generative content posture statement
- The Support URL + email

Copy the entire blockquote between "> CertMate is a voice-driven EICR / EIC certificate authoring tool" and the final "> **Support:**" line.

### 7.4 Attachment

Optional. Skip — the on-page Notes cover everything Apple needs.

## 8. Export Compliance

**ASC nav:** App Store → iOS App → 1.0 → App Information → Encryption

| Question | Answer |
|---|---|
| Does your app use encryption? | **Yes** — uses standard cryptography |
| Does your app qualify for any of the exemptions? | **Yes — only uses encryption available within iOS, plus encryption for password authentication / data integrity** |
| Does your app implement any proprietary encryption algorithms? | No |
| Have you read the FAQ? | Yes |

Result: **Exempt** under EAR §740.17(b). `ITSAppUsesNonExemptEncryption = false` is already correct in `Sources/Info.plist`.

## 9. Beta App Description — for TestFlight (separate flow)

**ASC nav:** TestFlight → Test Information

| Field | Value |
|---|---|
| Beta App Description | (paste below) |
| Feedback Email | `support@beckleyelectrical.co.uk` |
| Marketing URL | `https://certmate.uk` (or blank) |
| Privacy Policy URL | `https://certmate.uk/legal/privacy-policy` |

**Beta App Description:**

> CertMate beta. Voice-driven EICR/EIC authoring for UK electricians. Photograph the consumer unit, dictate readings while working, review the populated certificate, issue the PDF. Beta participants must have signed the Beta Tester Agreement at certmate.uk/legal/beta-tester-agreement.

**What to Test** (per-build, mutable):

For first submission: "Live voice transcription, AI field extraction, PDF generation. Recording requires microphone permission; photographing the consumer unit and observations requires camera permission."

## 10. Screenshot capture recipe

**ASC nav:** App Store → iOS App → 1.0 → 6.7" iPhone / 12.9" iPad

Apple requires:
- **6.7" iPhone** (iPhone 17 Pro Max) — minimum 3 screenshots, recommended 5
- **12.9" iPad** (iPad Pro 12.9" 6th gen) — minimum 3 screenshots, recommended 5
- Other size classes are optional and Apple auto-generates if you skip

Capture from a simulator signed in to the **demo account** (never your own — risk of leaking real homeowner data). The simulator is currently broken on this Mac (`xcrun simctl create` hangs in "Device was allocated but stuck in creation state" — needs `sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService` then a re-create, or a Xcode reinstall to fully fix). Alternative: shoot from your own physical iPad/iPhone with the demo account signed in, then crop in Preview.

### Five screens to shoot

For each, what to capture and what NOT to include:

| # | Screen | What's on it | Censor before upload |
|---|---|---|---|
| 1 | **Dashboard** with 1 demo job | Job list showing the synthetic "1 Apple Review Lane" job from demo-account-setup.md Step 4 | nothing — synthetic data |
| 2 | **New Job → CCU photo extraction** | A consumer-unit photo (use one from `scripts/ccu-cv-corpus/` if you have a sanitized one) + the extracted circuit grid populated | nothing — synthetic data |
| 3 | **Recording view** mid-extraction | Live transcript bar, brand-blue field flashing as Sonnet fills a value, demo job context | If the transcript mentions a real address, blur it. Otherwise: nothing |
| 4 | **Certificate review** | Filled Circuits or Observations tab, showing the AI-populated fields with inspector review state | Inspector name = "Apple Review Demo Inspector" (already non-real) |
| 5 | **Issue Certificate sheet** (NEW) | The two-attestation sheet from this sprint — shows the responsible-professional posture | nothing — synthetic |

**Quality bar:** PNG, no compression artefacts. Light mode for App Store consistency (dark mode preview slips through reviewer's attention sometimes). 1290×2796 for 6.7" iPhone, 2048×2732 for 12.9" iPad.

**What to avoid:**
- Real homeowner names, real addresses, real postcodes
- Real signatures
- Any UI text mentioning "free", "subscribe", "upgrade", or pricing
- Any debug UI (the green/red/orange dot in the transcript bar for example — fine if it shows GREEN, fine to leave; do NOT show it red)

### Optional: App Preview Video

Apple accepts 15-30 second silent video previews. Defer — not required, not worth the polishing time for v1.

## 11. Final review-and-submit

Click **Save** on each section above, then **Submit for Review** on the version page.

Apple will run automated pre-checks (binary scan, metadata validation) within ~10 min. If they fail, you'll get a rejection email immediately. Pass that, and you're in human-review queue: typical 24-72h for first submissions of novel apps.

### Likely rejection patterns to pre-empt

| Guideline | What it catches | Already addressed |
|---|---|---|
| **5.1.1(v)** | Account creation without in-app deletion | ✅ shipped commit `b56160e` |
| **5.1.1(ix)** | AI without clear guardrails / professional-responsibility framing | ✅ described in §4.2 description + per-PDF attestation sheet + reviewer notes |
| **3.1.1 + 3.1.3(b)** | Subscription/IAP rules — wrong if the app contained "Subscribe" CTAs | ✅ multiplatform-service pattern — see §2 |
| **2.1** | Incomplete metadata, especially missing demo account or broken demo login | ☐ verify demo-account login from a clean device before submitting |
| **2.5.1** | Use of private API | not at risk — standard Swift + SwiftUI + Alamofire only |
| **4.2** | Minimum functionality / "this is just a website" | not at risk — substantial voice-driven feature set |
| **4.0** | Design polish | Could surface as a "needs cleanup" rejection on first attempt; usually easy to address |

### After Submit

| Day | Expected state |
|---|---|
| 0 | Submitted; "Waiting for Review" in ASC |
| 1-3 | Apple moves to "In Review" → "Approved" OR "Rejected with feedback" |
| If rejected | Read the rejection note, fix, resubmit. 1-3 cycles is normal on first submission. |
| Approved | Pick the release date — manual ("I'll release it later") or automatic (immediately). For first launch, manual gives you a chance to coordinate with any inspector you've onboarded via TestFlight first. |

## 12. After approval

This packet stays valid until anything in the listing changes. When the BTA wording changes (post-solicitor review) or a new feature ships:

- §1 Subtitle and §4 Description — re-tune if features change
- §4.1 Promotional Text — mutable, refresh quarterly with what's actually compelling that quarter
- §4.4 What's New — write per release as part of `./deploy-testflight.sh` runbook
- §3 App Privacy — only update if the data inventory in `facts.md` changes. Run a paste of `git log --oneline -- facts.md` quarterly to spot drift.
