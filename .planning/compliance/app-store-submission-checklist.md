---
title: App Store submission checklist — CertMate iOS
status: ready for Derek to action in App Store Connect
last_verified: 2026-05-11
maintainer: Derek Beckley
source_of_truth: ./facts.md (data inventory) + Sources/Info.plist (entitlements)
purpose: single-page App Store Connect submission run-book — fill in this order, click Submit at the end
read_first: ./two-week-launch-checklist.md (covers the wider launch sequence; this doc only zooms in on the App Store form)
audience: future-Derek filling out App Store Connect for the first paid release
---

# App Store submission checklist — CertMate iOS

This is the **end-of-runway** doc — every other compliance task feeds into the fields here. Work the sections in order; when every box is ticked, the listing is in submittable shape.

The order matters: items 1–3 are **blockers** Apple will reject for. Items 4–9 are content fields you have to fill in. Item 10 is the final review-and-submit.

## 1. Engineering blockers (must be on a TestFlight build before submission)

| Item | Status | Why it blocks |
|---|---|---|
| iOS compliance commits on TestFlight | ☐ | Commits `a3eaccd` (Deepgram `mip_opt_out`) and `aa7141c` (EXIF strip) live on `main` but **not yet uploaded**. Run `./deploy-testflight.sh` from `~/Developer/EICR_Automation/CertMateUnified/`. DPIA risks R2 + R5 only fully closed in production once this build is live. |
| In-app account deletion | ☐ | **Apple Guideline 5.1.1(v)**. Auto-rejection if absent in any app that supports account creation. Implementation scoped in `two-week-launch-checklist.md` Task 18 (backend `DELETE /api/me` + iOS Settings → Account → Delete). Approx. 6h engineering. Until built, do not submit. |
| Public privacy URL resolves | ✅ | `/legal/privacy-policy` is statically rendered and middleware-allow-listed. Verify on prod by curling `https://certmate.uk/legal/privacy-policy` before submission. |

## 2. Info.plist usage descriptions — already correct

Confirmed against `Sources/Info.plist` on 2026-05-11. Apple checks these match the entitlements your code actually exercises. CertMate is minimal:

| Key | Value | Required because |
|---|---|---|
| `NSCameraUsageDescription` | "CertMate needs camera access to photograph consumer units and defects." | CCU photos, observation photos, document extraction |
| `NSMicrophoneUsageDescription` | "CertMate needs microphone access to record test readings by voice." | Deepgram dictation |
| `NSPhotoLibraryUsageDescription` | "CertMate needs photo library access to attach photos to observations." | Picker for prior photos + cross-job pool |

Deliberately **not present** (and must not be added without a corresponding code change): `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysUsageDescription`, `NSContactsUsageDescription`, `NSFaceIDUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSSpeechRecognitionUsageDescription` (Apple's speech, which we deliberately don't use — Deepgram is the STT engine), `NSSiriUsageDescription`.

`ITSAppUsesNonExemptEncryption` is `false`. See item 8 (Export Compliance) for the reasoning.

## 3. App Privacy — Nutrition Labels

App Store Connect: **App Information → App Privacy → Edit**. Fill exactly as below. Data categories trace back to `./facts.md` §3.

### 3.1 Header questions

| Question | Answer | Rationale |
|---|---|---|
| Do you or your third-party partners use this data for tracking? | **No** | No advertising, no analytics SDKs, no cross-site tracking. Cookie policy confirms zero third-party cookies. |
| Are the third-party partners' data uses governed by your privacy policy? | **Yes** | All sub-processors are contractually bound via DPAs (see `sub-processors.md`); their use is governed by the CertMate Privacy Policy you publish. |

### 3.2 Data collected — declare each category

For each row below, set the data type as **Collected**, then for each row tick the columns shown. "Linked to user" means the inspector's account; "purpose" = App Functionality unless otherwise stated.

#### Contact Info

| Data type | Linked | Tracking | Purposes |
|---|---|---|---|
| Name (inspector) | Yes | No | App Functionality |
| Name (homeowner / client) | Yes | No | App Functionality |
| Email Address (inspector) | Yes | No | App Functionality |
| Email Address (homeowner) | Yes | No | App Functionality — only when dictated into the certificate |
| Phone Number (homeowner) | Yes | No | App Functionality — only when dictated into the certificate |
| Physical Address (homeowner property) | Yes | No | App Functionality |
| Other User Contact Info | No | — | — |

> Apple's "Name" category covers both inspector account names and homeowner names. Apple treats *any* personal identifier the app processes as "data collected", including data the user-of-the-app enters about third parties (here, homeowners). Declare both.

#### Location

| Data type | Linked | Tracking | Purposes |
|---|---|---|---|
| Precise Location | **No** ✓ | — | — |
| Coarse Location | No | — | — |

> Post-`aa7141c` (EXIF strip): no GPS coordinates leave the device. Postcode is a manually-entered text field, treated as part of the Physical Address (above) and NOT as Location data — Apple's definitions are device-derived geolocation only. **Must be live on TestFlight before submission** — see item 1.

#### Sensitive Info

| Data type | Linked | Tracking | Purposes |
|---|---|---|---|
| Sensitive Info | No | — | — |

> No race, ethnicity, sexual orientation, pregnancy, disability, political opinion, religious belief, trade union membership, genetics, or biometric data is collected. The "voice" data is User Content (below), not Sensitive Info under Apple's narrower definition.

#### User Content

| Data type | Linked | Tracking | Purposes |
|---|---|---|---|
| Photos or Videos | Yes | No | App Functionality |
| Audio Data | Yes | No | App Functionality |
| Customer Support | Yes | No | App Functionality — for support emails sent via the app, if any |
| Other User Content | Yes | No | App Functionality — signatures, certificate text, observation notes, transcripts |

> Voice dictation → Audio Data. Transcripts of that audio → Other User Content (Apple's "Audio Data" category is for the raw audio, not its derivatives). CCU + observation + document photos → Photos or Videos. Inspector signature image → Other User Content.

#### Identifiers

| Data type | Linked | Tracking | Purposes |
|---|---|---|---|
| User ID | Yes | No | App Functionality — `users.id` UUID is the account key |
| Device ID | No | — | — |

> No IDFA, no IDFV, no advertising identifiers. JWT token is derived from User ID and not a separate declaration.

#### Usage Data

| Data type | Linked | Tracking | Purposes |
|---|---|---|---|
| Product Interaction | Yes | No | App Functionality, Analytics — session cost summaries, button events |
| Advertising Data | No | — | — |
| Other Usage Data | No | — | — |

> Session-cost analytics fall here (`session-analytics/{userId}/{sessionId}/cost_summary.json`). Used for both billing reconciliation (App Functionality) and internal product analytics (Analytics).

#### Diagnostics

| Data type | Linked | Tracking | Purposes |
|---|---|---|---|
| Crash Data | No | — | — |
| Performance Data | Yes | No | App Functionality |
| Other Diagnostic Data | Yes | No | App Functionality |

> Crash logs are handled by Apple TestFlight (90-day Apple-managed retention) — CertMate doesn't operate its own crash uploader, so this is "Not Linked" by Apple's logic (we don't tie crash logs to our user identifiers). Performance/Other Diagnostic = the debug-log JSONL used to investigate live-extraction issues.

#### Categories explicitly NOT collected

The following must be ticked **Not Collected** so Apple's algorithm doesn't infer them:

- Health & Fitness — all subcategories
- Financial Info — all subcategories (Apple handles IAP if/when introduced; we don't store card data)
- Contacts — we never read the device contact book
- Browsing History
- Search History
- Purchases — n/a until IAP launches
- Other Data — none beyond what's already declared

## 4. Listing fields

| Field | Value | Notes |
|---|---|---|
| App Name | CertMate | 30 char limit; we have plenty of room |
| Subtitle | Voice-driven EICR & EIC certificates | 30 char limit (currently 38 — needs trim). Alt: "Voice-driven electrical certs" (29) |
| Primary Category | Business | `LSApplicationCategoryType` is already `public.app-category.business` |
| Secondary Category | Productivity | Optional but useful for discovery |
| Age Rating | 4+ | No objectionable content; "Unrestricted Web Access" should be marked **No** — the app embeds a help page only |
| Privacy Policy URL | `https://certmate.uk/legal/privacy-policy` | Must resolve publicly. ✅ live as of commit `bd22fde`. |
| Marketing URL (optional) | `https://certmate.uk` | Skip if a public landing page isn't live yet |
| Support URL | `https://certmate.uk/legal` *(temporary)* | Apple requires a Support URL. Until a dedicated support page exists, the legal hub satisfies the requirement — every doc on it points at the company address. **Better follow-up:** stand up `/support` with a contact form or email-only fallback. |
| EULA | Apple Standard EULA | Default. Beta-tester-agreement.md is separate (governs beta), not the Apple EULA. |

## 5. App description and keywords

Apple imposes a 4,000-char description limit and a 100-char keyword string. Draft below; refine on the listing day.

**Description draft (~700 chars):**

> CertMate turns an inspector's voice into a finished EICR or EIC certificate. Dictate test readings and observations while you work; CertMate transcribes in real time, populates the certificate, prompts you for missing values, and lets you review every field before issuing the PDF.
>
> • Photograph the consumer unit — CertMate extracts the circuit schedule
> • Speak readings — they appear instantly in the correct row
> • Photograph defects — auto-attached as observations
> • Review and sign — issue the PDF locally on your device
>
> CertMate is a dictation aid. The named inspector remains the responsible professional under BS 7671 and the relevant Competent Person Scheme.

**Keywords (96 chars, comma-separated, no spaces inside terms):**

```
EICR,EIC,electrical,inspection,certificate,electrician,NICEIC,NAPIT,wiring,BS7671,voice
```

(Tune after the first round of App Store search analytics.)

## 6. Screenshots + preview

Apple requires screenshots for: 6.7" iPhone, 5.5" iPhone (legacy), 12.9" iPad. Iterating on this comes after the build is live on TestFlight — set aside ~90 min to capture a clean set on simulator + crop in Preview.

Suggested screens:
1. CCU photo → extracted circuit grid
2. Live recording view with transcript bar mid-extraction
3. Filled certificate review screen
4. Generated PDF preview (use a synthetic property, no real homeowner data)
5. Settings → Inspector profile (shows the professional framing)

Avoid screenshots that show: real homeowner names, real property addresses, real signatures, any data subject's voice transcript that could be linked back to a person.

## 7. Beta App Description (TestFlight)

Apple's beta review requires a short blurb. Use:

> CertMate beta. Voice-driven EICR/EIC authoring for UK electricians. Photograph the consumer unit, dictate readings while working, review the populated certificate, issue the PDF. Beta participants must have signed the Beta Tester Agreement available at certmate.uk/legal/beta-tester-agreement.

What's New (per build): one-liner per release. Default: "Bug fixes and improvements." Update before each TF push when there's something user-visible.

## 8. Export Compliance

`ITSAppUsesNonExemptEncryption = false` in `Info.plist`. Justification: the app uses only HTTPS/TLS for transport, Apple's standard cryptographic APIs (Keychain, CryptoKit), and standard JWT validation. No proprietary encryption algorithms; no encryption of user data beyond what iOS provides automatically; the app does NOT export encryption functionality. This is the "exempt" category under EAR §740.17(b).

App Store Connect's export-compliance step: tick **"My app does not use encryption beyond standard Apple-provided cryptography"**.

## 9. App Review Information

Apple asks for reviewer contact + a demo account.

| Field | Value |
|---|---|
| First name / Last name | Derek Beckley |
| Phone number | *(your number; not visible to public)* |
| Email | `support@beckleyelectrical.co.uk` (or whichever inbox you check daily) |
| Demo Account | Create a test inspector login dedicated to App Review — never use your own. Set the credentials in App Store Connect and on a real RDS row. Mark the row so it's exempt from cost-tracker billing alerts. |
| Notes | "CertMate is a voice-driven EICR/EIC certificate-authoring tool for UK electricians. The demo account contains a synthetic property; please record any short utterance (e.g. \"earth fault loop impedance zero point one ohms\") to see live transcription and field extraction. No real homeowner data is in the test account." |

## 10. Final review-and-submit

Run this in order; only click Submit when every box is ticked.

| ☐ | Item |
|---|---|
| ☐ | TestFlight build with `a3eaccd` + `aa7141c` is live + in **Ready to Submit** state |
| ☐ | Account-deletion endpoint deployed; iOS UI for it visible in Settings on the TestFlight build |
| ☐ | `https://certmate.uk/legal/privacy-policy` returns 200 to an anonymous curl |
| ☐ | App Privacy form completed using §3 above |
| ☐ | All listing fields filled per §4 |
| ☐ | Description + keywords per §5 |
| ☐ | At least 3 screenshots per required device class, sanitised of real personal data |
| ☐ | Beta App Description filled per §7 (TestFlight is a separate workflow but check both) |
| ☐ | Export Compliance ticked per §8 |
| ☐ | App Review demo account set up + credentials saved in App Store Connect |
| ☐ | Visual smoke test of the TestFlight build on an unfamiliar device (a friend's iPhone if available — catches "it only works on Derek's iPad" classes of bug) |
| ☐ | Beta Tester Agreement solicitor review **either complete OR you have explicitly decided to ship the current draft for beta-only audience** (the agreement controls homeowner-data risk; the App Store version doesn't have to wait for the solicitor verdict but you should know which call you're making) |
| ☐ | Tabletop walkthrough of `incident-response-runbook.md` done at least once |

## Likely-rejection pitfalls (worth pre-empting)

These are the patterns Apple's reviewers reject quickly:

1. **5.1.1(v) — account creation without account deletion.** Pre-flight blocker. Building this is non-negotiable.
2. **Privacy Policy URL not reachable.** Make sure DNS is pointed at certmate.uk and the cert is valid before submitting.
3. **5.1.1(i) — collecting data you haven't declared.** Cross-check §3 against `Info.plist` and `facts.md`. Anything declared in the Nutrition Label and NOT in `facts.md` is a process gap — fix `facts.md` first.
4. **2.1 — incomplete metadata.** The demo account is the field people forget. Apple will reject with "we couldn't sign in" if you leave it blank.
5. **2.5.1 — usage of private API.** Not an active risk for CertMate, but worth a `nm` pass on the binary before submission.
6. **4.2 — minimum functionality.** CertMate isn't at risk here (substantial voice-driven feature set), but the description should foreground the "I save inspectors 30+ minutes per cert" angle so reviewers immediately see the value.

## When you're done

Tick item 10's "Submit for Review" button. Expect:

- **Apple in-review state:** 24–72h typical, sometimes faster on first submission since the app is novel.
- **Possible rejection cycles:** 1–3 are normal on a first listing. Most rejections are 4.0-class (design polish) or 5.1.1 (privacy text mismatch) — both are fast to correct.
- **In-Review-to-Approved typical elapsed:** 5–10 calendar days including rejection cycles.

Once Approved + Ready For Sale, the App Store listing goes live (or queued for the release date you set). TestFlight users continue to receive TF builds independently of App Store releases.
