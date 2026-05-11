---
title: CertMate In-App Consent Screen — copy + implementation notes
status: draft, ready for iOS + web implementation
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: on any change to Beta Tester Agreement or recording behaviour
implementation_targets:
  ios: CertMateUnified/Sources/Views/Onboarding/ConsentScreen.swift (new)
  web: web/src/app/(authenticated)/onboarding/consent/page.tsx (new)
related: ./beta-tester-agreement.md ./door-script.md ./privacy-policy.md ./dpia-voice-extraction-pipeline.md
---

# In-app consent screen

This is the screen that appears at first login on both the iOS app and the web app. It is the clickwrap moment for the [Beta Tester Agreement](./beta-tester-agreement.md) and the gate that unlocks the recording feature. Until the user has accepted, they cannot start a recording session.

## What this screen is for

Two distinct compliance purposes, addressed in one screen:

1. **Clickwrap acceptance of the Beta Tester Agreement.** UK GDPR Art. 28 requires a written processor agreement before CertMate can lawfully process homeowner data on the inspector's behalf. Clickwrap satisfies that "written" requirement under UK contract law and is the moment that flips the dormant processor relationship to active.

2. **Standing instruction to the inspector to deliver the door script.** The DPIA at [dpia-voice-extraction-pipeline.md §6 M1.1–M1.2](./dpia-voice-extraction-pipeline.md) requires per-recording disclosure to the homeowner via the [door script](./door-script.md). The consent screen is where the inspector acknowledges they understand this obligation; a recording-start-time reminder (smaller, separate UX) re-prompts at each session.

## Visible copy

The screen has three sections: (1) summary statement, (2) the key obligations the inspector is agreeing to, (3) the accept button + a clearly-marked decline route.

### Heading

> **Before you start using CertMate**

### Summary paragraph

> CertMate is in **closed beta**. By tapping **I agree** below, you accept the [Beta Tester Agreement](https://certmate.uk/legal/beta-tester-agreement) and the [Privacy Policy](https://certmate.uk/privacy). These cover how CertMate processes your data and your customers' data, including audio dictation, AI extraction, and storage.

### "What you're agreeing to" bullet list

Heading: **What you're agreeing to**

- CertMate processes your customers' data (names, addresses, photos, voice transcripts) on your behalf as your **processor** under UK GDPR Article 28.
- Some processing happens via US-based AI providers (transcription, extraction, text-to-speech), under standard UK-Addendum safeguards. The full list is at **certmate.uk/legal/sub-processors**.
- **You will tell each homeowner that audio dictation is taking place before recording starts**, using the wording at **certmate.uk/legal/door-script**. If anyone present asks you not to record, you'll enter readings manually instead.
- **You'll review every certificate before issuing it.** AI-extracted readings are a dictation aid; you remain the qualified inspector responsible for what the certificate says.
- During beta, the service is provided **as-is** with no warranty and no payment.
- You can terminate at any time with 30 days' notice (or immediately if we change something material you can't accept).

### Buttons

- **Primary** — `I agree — let me in`
- **Secondary** — `Read the full Beta Tester Agreement` (opens the published agreement in an in-app web view or external browser)
- **Tertiary** — `Cancel — I'll come back later` (returns to the login screen; account remains created but locked out of the recording feature until accepted)

### Footer line (small print)

> By tapping "I agree" you confirm you have authority to bind any company you act for. A copy of this agreement is at certmate.uk/legal/beta-tester-agreement. Questions? privacy@certmate.uk.

## Behaviour

### When the screen appears

- **First successful login** of a CertMate account, on either platform.
- **After any material amendment to the Beta Tester Agreement** that has not yet been accepted by this account. (Version stamp on the user record; if the stored accepted-version is older than the current version, re-prompt.)

### When the screen does NOT appear

- Subsequent logins on the same account on the same or different devices, **after** the current Agreement version has been accepted.
- Account password reset (no re-acceptance needed unless agreement version has changed in the meantime).

### The "I agree" action

When the inspector taps **I agree**, the client (iOS or web) submits to the backend:

```json
POST /api/account/consent/accept
{
  "agreement_kind": "beta_tester_agreement",
  "agreement_version": "0.1",
  "accepted_at": "<ISO8601 UTC timestamp generated client-side>",
  "platform": "ios" | "web",
  "platform_version": "<app build / web build>",
  "ip_address_hint": null   // server captures real IP from the request itself
}
```

The backend writes an `account_consents` row (new table — schema in §Implementation below) and returns 200 OK. On success the client navigates to the dashboard. On 4xx/5xx the client stays on the consent screen and shows an inline error; the user can retry.

### The "Cancel" action

The user is returned to the login screen. The account remains in a "consent-pending" state — login works but every protected action (start recording, create job, etc.) returns a 403 with a `consent_required` body explaining what to do. After 30 days in consent-pending state the account is soft-deleted and the user can re-register if they want to.

## Implementation

### Database — backend

New table `account_consents`:

```sql
CREATE TABLE account_consents (
  id            SERIAL PRIMARY KEY,
  user_id       VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agreement_kind TEXT NOT NULL,                   -- e.g. 'beta_tester_agreement'
  agreement_version TEXT NOT NULL,                -- e.g. '0.1'
  accepted_at   TIMESTAMP NOT NULL,               -- as-submitted client time
  recorded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  platform      TEXT NOT NULL,                    -- 'ios' | 'web'
  platform_version TEXT,
  ip_address    INET,                             -- captured server-side
  user_agent    TEXT,                             -- captured server-side
  UNIQUE (user_id, agreement_kind, agreement_version)
);

CREATE INDEX idx_account_consents_user_kind ON account_consents (user_id, agreement_kind);
```

This is the audit trail that demonstrates lawful Art. 28 acceptance. **It is itself personal data** (links a user to a clickwrap event) and is retained for the same period as the user account (account lifetime + 7 years per the Retention Policy).

### Backend route — `src/routes/consent.js` (new)

```js
// POST /api/account/consent/accept
//   body: { agreement_kind, agreement_version, accepted_at, platform, platform_version }
// Writes one row to account_consents; idempotent on (user_id, agreement_kind, agreement_version).
// Returns 200 with { ok: true } or 409 if already accepted.
```

### Gating middleware — `src/middleware/require-consent.js` (new)

```js
// For any route that touches Customer Personal Data, check that the
// requesting user has accepted the current Beta Tester Agreement version.
// Reject with 403 + { code: 'consent_required', current_version } if not.
//
// Apply to: jobs.js (create/update/finalise), recording.js, extraction.js,
// photos.js. Do NOT apply to: /api/account/consent/*, /api/auth/*, /api/me.
```

### iOS — `CertMateUnified/Sources/Views/Onboarding/ConsentScreen.swift` (new)

A SwiftUI view shown by the root coordinator when:

- `APIClient.fetchMe()` returns `{ consent_pending: true, current_agreement_version: "0.1" }`

After successful accept, the root coordinator re-fetches `/api/me` and routes the user to the dashboard.

Implementation notes:
- Use the existing `CertMateDesign` typography / colour tokens — this is a brand surface.
- The "Read the full Beta Tester Agreement" button should open `https://certmate.uk/legal/beta-tester-agreement` in `SFSafariViewController` (in-app browser) so the user stays in CertMate.
- Required: large touch targets (44pt minimum), VoiceOver labels on every interactive element.
- Required: the "I agree" button should be `disabled` until the user has scrolled to the bottom of the bullet list. This is belt-and-braces evidence of meaningful acceptance — discussed during the planning conversation; matches how published SaaS clickwrap UX has trended.

### Web — `web/src/app/(authenticated)/onboarding/consent/page.tsx` (new)

A Next.js page reached via middleware redirect when `/api/me` returns `consent_pending: true`. The middleware at `web/src/middleware.ts` should add to its existing auth check:

```typescript
if (response.consent_pending) {
  return NextResponse.redirect(new URL('/onboarding/consent', request.url));
}
```

The page itself mirrors the iOS layout. The "Read the full Beta Tester Agreement" link opens in a new tab.

### Versioning

The `agreement_version` field uses calendar versioning: e.g. `2026-05-11`. Bump on any material change to the Beta Tester Agreement that requires re-acceptance. Minor wording changes that don't affect rights or obligations don't require re-acceptance — flag this judgement explicitly in the commit that changes the agreement.

## Recording-time reminder

Separately from this once-per-account consent, the recording start UI shows a smaller reminder on every recording session:

> *"Have you told the homeowner about audio dictation? See the [door script](./door-script.md) if you need the wording."*

with a single dismissible tap. This is **not** a separate consent — it's a habit-reinforcing UX cue that mitigates DPIA risk R1 even in the case of an inspector who has been using CertMate for months and may have stopped delivering the door script.

## Audit log questions the solicitor / DP consultant may ask

| Question | Where the answer lives |
|---|---|
| "When did this inspector accept the current Beta Tester Agreement?" | `account_consents` row, `accepted_at` |
| "What IP address did they accept from?" | Same row, `ip_address` |
| "Which version did they accept?" | Same row, `agreement_version` |
| "Did they have to scroll to the bottom before accepting?" | Implementation requirement above; UI behaviour, no audit-log entry |
| "Where did they read the full Agreement?" | Linked URL recorded in the screen copy; same URL is the canonical published version |
| "Can they re-accept after a version bump?" | Yes — `(user_id, agreement_kind, agreement_version)` is unique, but a new version creates a new accepted row, not a replacement |
| "Can they revoke acceptance?" | No revocation flow — they terminate the agreement under Section 14 of the Beta Tester Agreement instead, which deletes their account |

## Outstanding implementation work

This document is the spec; the implementation is a follow-on task once the Beta Tester Agreement is solicitor-reviewed (Task #10). The implementation work is not in scope for the compliance documentation phase. Estimated effort:

- Backend route + middleware + migration: ~3 hours
- iOS consent screen + APIClient changes: ~3 hours
- Web consent screen + middleware changes: ~2 hours
- End-to-end test: ~1 hour

Total: ~9 hours of focused engineering, to be scheduled after the solicitor review.
