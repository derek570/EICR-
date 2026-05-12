---
title: CertMate PDF-Issuance Attestations — research, wording, implementation spec
status: draft, ready for iOS + web implementation
last_verified: 2026-05-12
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: on any change to AI extraction behaviour, certificate output, or professional liability framework
implementation_targets:
  ios: CertMateUnified/Sources/Views/JobDetail/IssueCertificateView.swift (new) — gate before PDF render
  web: web/src/app/(authenticated)/job/[id]/issue/page.tsx (new) — gate before PDF render
  backend: src/routes/cert-attestations.js (new) — POST + GET; src/db/migrations/<n>_cert_attestations.sql
related: ./beta-tester-agreement.md ./dpia-voice-extraction-pipeline.md ./privacy-policy.md ./in-app-consent-screen.md ./facts.md
---

# PDF-Issuance Attestations

Two tick-boxes the inspector must complete **every time** a CertMate PDF certificate is generated. They are the per-cert audit-trail capture of the inspector's professional declaration that they have personally verified the AI-extracted readings and AI-suggested observations before issuing the certificate. They are the strongest available evidential support for the position that **the named inspector — not CertMate — is the responsible professional for the contents of every certificate.**

## 1. Why two boxes, not one

The two-box design separates two domains of professional responsibility that BS 7671 itself treats distinctly:

- **Readings** (Part 6 of BS 7671 — Inspection and Testing): measured electrical values produced by test instruments and dictated by the inspector. AI-extraction error here is *transcription error* (mishearing a number, dropping a decimal, mis-attributing to a circuit).
- **Observations** (BS 7671 Section 653.2 — Reporting): the inspector's professional judgement on departures from BS 7671 expressed as C1 / C2 / C3 / FI classifications. AI-extraction error here is *classification error* (suggesting C2 when the inspector would call C3, or fabricating an observation that was never said).

A single combined attestation invites rubber-stamping. Two distinct attestations force the inspector to mentally separate "did I verify the numbers" from "did I verify the professional judgement." This is the same belt-and-braces UX rationale that drives why the first-login consent screen requires scroll-to-bottom before "I agree" enables.

## 2. Legal terminology — research

### 2.1 "Consent" vs "Attestation" vs "Declaration"

UK statute, BS 7671 practice, and contract law each have specific terms for this kind of acknowledgement. Picking the wrong one weakens the evidential value.

| Term | UK statutory meaning | Use here? |
|---|---|---|
| **Consent** | UK GDPR Art. 4(11) — "freely given, specific, informed and unambiguous indication" of agreement to data processing. Specific to data-protection law. | **No.** Misusing "consent" weakens its meaning where we actually rely on it (UK GDPR contexts). |
| **Acknowledgement** | Generic — "I have read and noted this." Weak evidential weight; doesn't commit the speaker to anything about accuracy. | **No.** Too soft for a professional-liability anchor. |
| **Attestation** | A formal declaration of fact made by a person who can speak to that fact. Common in regulated professions; carries evidential weight. | **Yes.** This is the term used throughout this spec. |
| **Declaration** | Used on the body of EICR and EIC certificates already ("Declaration of Inspector"). | **Reserved** — to avoid clashing with the certificate's existing Declaration section. The attestation is the per-issuance evidential capture; the on-cert Declaration is the certificate content the customer reads. |
| **Warranty** | Contract-law term implying liability if untrue. Too strong — it would expose the inspector personally to consequential damages if a reading were wrong. | **No.** "I attest I reviewed" is appropriate; "I warrant accuracy" would make the inspector personally liable to the homeowner. |
| **Certification** | A formal statement made by a person authorised to make it. Already what the EICR/EIC document as a whole IS. | **No** — overloaded. |

**Decision: use "Attestation" as the per-issuance term throughout the codebase, copy, and audit-log table name.**

### 2.2 Industry parallels for "AI-assisted output, human responsible"

The same pattern appears across regulated professions adopting AI assistance:

- **Medical AI** (radiology assist tools, e.g. Aidoc, Zebra Medical) — "AI-flagged finding requires radiologist review and adjudication." The radiologist signs the report; the AI vendor is positioned as a tool.
- **Legal AI** (Harvey, Spellbook, Robin AI) — "AI-generated suggestion — attorney must verify before reliance." The instructing solicitor takes responsibility for the work product.
- **Accounting AI** (Intuit AI, Xero ML categorisation) — "AI suggested entry — confirm before submission." The accountant signs the return.
- **Building-control AI** (early-stage; e.g. Bonacasa, Hypar) — same posture.

Common features across all four:
1. The output is described as a **suggestion** or **flagged finding**, not a determination.
2. The qualified professional is named as the **responsible** party for the final work product.
3. Sign-off is a **discrete UI moment**, not a passive default.
4. The acknowledgement is **logged with timestamp** for evidential retrieval.

CertMate's attestations follow this pattern exactly.

### 2.3 App Store Guideline 5.1.1(ix) alignment

Apple's App Store Review Guideline 5.1.1(ix) (added 2024) requires that apps using generative AI features include "appropriate guardrails" against "objectionable content." Adjacent guidance from Apple's reviewer team has clarified that for AI features that produce safety-relevant output (medical, legal, financial, regulatory), the bar is a **clear demarcation of professional responsibility**. Two per-issuance attestations exceed that bar. Mention them explicitly in the App Store reviewer notes (Path B Task 18).

### 2.4 ICO guidance on AI-assisted decision-making

The ICO's "AI and data protection" guidance distinguishes:

- **Solely automated decisions** affecting data subjects — UK GDPR Art. 22 territory; requires meaningful human review.
- **AI-assisted human decisions** — outside Art. 22; the human is the decision-maker.

CertMate is squarely the second category: the inspector decides the cert contents; the AI assists with transcription and classification. The per-cert attestation is the **evidential record of meaningful human review** — not because Art. 22 requires it (it doesn't), but because it pre-empts any future regulator question on whether the human review was "meaningful" or merely a UI rubber-stamp.

## 3. Verbatim wording

These are the production strings. They are stored centrally and rendered identically on iOS and web. **Versioned**: the `attestation_text_version` field on every saved row records which wording the inspector saw, so future wording changes don't retroactively change the audit trail.

### 3.1 Attestation A — Readings

> ☐ **I have personally reviewed every reading on this certificate.**
>
> CertMate is a dictation and data-extraction aid. AI-transcribed and AI-extracted readings can contain errors — values misheard, decimal points moved, readings attributed to the wrong circuit. As the qualified inspector named on this certificate, I am responsible for the accuracy of every reading shown, and I have verified each one against my own test instruments and notes before issuing this report.

### 3.2 Attestation B — Observations

> ☐ **I have personally reviewed every observation on this certificate.**
>
> Observations, code classifications (C1, C2, C3, FI), and recommended remedial actions generated by CertMate are AI-generated suggestions only. They are not a substitute for my professional judgement as the qualified inspector named on this certificate. I have reviewed every observation that appears below, rejected, edited, or added observations as my professional judgement required, and I am responsible for the relevance, accuracy, and classification of each one.

### 3.3 Button labels

- Primary (enabled only when **both** boxes are ticked): **`Issue certificate`**
- Secondary: **`Cancel — back to review`**

No "Skip" or "Remember my choice" option. Re-issuing the same cert re-prompts.

### 3.4 Below-the-button footer (small print)

> By tapping "Issue certificate" you confirm both attestations above. A copy of this confirmation is retained for audit purposes alongside the certificate. You can review your previous attestations in **Settings → Account → Issued certificates**.

## 4. Behaviour

### 4.1 When the screen appears

- **Every** time a PDF certificate is generated, on both iOS and web — including the case where nothing has changed since the previous generation.
- Includes:
  - First issuance of a new certificate
  - Re-issuance of a certificate after edit (each re-issuance is its own legal act, captured independently)
  - PDF regeneration after a corrected reading
  - PDF re-render with no edits at all (e.g. the inspector re-prints the same cert because the customer asked for another copy, or because the local PDF was lost) — **still re-prompts**, because each render is the issuance moment for that copy
  - PDF regeneration for the same job by a different inspector account (unusual but possible)
- Does **not** appear for:
  - PDF preview / pre-issuance render (a "preview" mode that doesn't store the PDF to S3 — used during review). Preview PDFs must be visibly watermarked `DRAFT — NOT FOR ISSUE`.

The principle: **a PDF that leaves CertMate is always accompanied by a fresh pair of attestations.** No exemption for unchanged content, no exemption for same-inspector-same-day, no exemption for "I already attested this morning." The attestations are cheap (two taps); the audit trail is the entire point.

### 4.2 The two boxes are independent

The inspector must tick **both** to enable `Issue certificate`. Ticking one and leaving the other unticked is a no-op; the button stays disabled. Both boxes default to **unticked** on every appearance. No memory of previous state.

### 4.3 Both attestations write before the PDF renders

On `Issue certificate`:
1. Client submits both attestations to `POST /api/cert-attestations/accept` (atomic — both rows or neither).
2. Backend writes two `cert_attestations` rows. Returns 200 with `{ ok: true, attestation_ids: [..., ...] }`.
3. Only on success does the client trigger PDF render (existing iOS `EICRHTMLTemplate.swift` flow; existing web `/api/generate-pdf` route).
4. On 4xx/5xx the inspector stays on the attestation screen with an inline retry banner.

If the PDF render itself fails after attestations have been written, the attestation rows stay (they are factual: the inspector attested at that moment), and the rendering retry can re-use them via the `attestation_ids` returned in step 2 — **no re-prompt** in the case of a downstream render failure. This is the only case where the inspector is not re-prompted, and it is justified because the attestations are a record of a human act that already happened.

### 4.4 What's NOT being attested

The attestations capture professional review of the certificate contents. They do **not** displace or replace:

- The **first-login Beta Tester Agreement consent** (per `in-app-consent-screen.md`) — that's the contractual base layer.
- The **per-recording door-script obligation** (per `door-script.md`) — that's the homeowner-facing notice.
- The **on-cert Declaration of Inspector** wording (per BS 7671 Section 653) — that's the customer-readable formal sign-off on the printed certificate.

These four together — once-per-account consent, per-recording door script, per-issuance attestations, on-cert Declaration — are a layered defence. Each is independently justifiable and each fails closed.

## 5. Implementation

### 5.1 Database — backend

New table `cert_attestations`:

```sql
CREATE TABLE cert_attestations (
  id                          SERIAL PRIMARY KEY,
  user_id                     VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  job_id                      VARCHAR(255) NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  pdf_s3_key                  TEXT,                        -- e.g. jobs/{userId}/{folderName}/output/eicr_certificate.pdf
  attestation_kind            TEXT NOT NULL,               -- 'readings' | 'observations'
  attestation_text_version    TEXT NOT NULL,               -- e.g. '2026-05-12'
  attested_at                 TIMESTAMP NOT NULL,          -- as-submitted client time
  recorded_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  platform                    TEXT NOT NULL,               -- 'ios' | 'web'
  platform_version            TEXT,
  ip_address                  INET,
  user_agent                  TEXT
);

CREATE INDEX idx_cert_attestations_user_job ON cert_attestations (user_id, job_id);
CREATE INDEX idx_cert_attestations_recorded ON cert_attestations (recorded_at);
```

Notable design points:

- **`ON DELETE RESTRICT`** on both `user_id` and `job_id`. The attestation is the audit trail of a legal act; cascading deletion would destroy that trail. If a user or job is hard-deleted (via the SAR / Erasure playbook), the attestation row must be considered separately under §6 of that playbook ("items NOT erased — controller legal-obligation retention").
- **No `UNIQUE` constraint** on `(user_id, job_id, attestation_kind)` — re-issuance is supported, and each re-issuance writes a fresh row.
- **Two rows per issuance**, not one row with two columns. The independent-attestation design at the UI level is mirrored in the data.

### 5.2 Backend route — `src/routes/cert-attestations.js` (new)

```js
// POST /api/cert-attestations/accept
//   body: { job_id, pdf_s3_key?, attestations: [
//     { kind: 'readings',     text_version, attested_at, platform, platform_version },
//     { kind: 'observations', text_version, attested_at, platform, platform_version }
//   ]}
// Validates: exactly 2 attestations, kinds are the unique set { readings, observations },
// text_version matches a current or known-prior version (rejects unknown versions to prevent
// client-side spoofing of e.g. older softer wording), job belongs to authenticated user,
// attested_at is within ±5 min of server time (clock-skew tolerance).
// Writes 2 rows atomically. Returns 200 { ok: true, attestation_ids: [a, b] } or 4xx.

// GET /api/cert-attestations?job_id=<id>
// Returns all attestations for a job for the authenticated user. Used by the "Issued certificates"
// list in Settings.

// GET /api/cert-attestations/by-cert?pdf_s3_key=<key>
// Returns the most recent matching attestations for a generated PDF. Used during audit trails.
```

### 5.3 PDF-render gate — backend

The existing PDF-generation routes (`/api/generate-pdf` and friends) currently render without an attestation gate. **They must not be tightened to require attestations** — iOS renders client-side via `EICRHTMLTemplate.swift` and never calls the backend route. The gate is enforced at the **UI layer on both iOS and web**, before the render is invoked. This is the same pattern as the first-login consent screen.

Belt-and-braces: log every PDF render with the `pdf_s3_key` in CloudWatch; periodically audit that every PDF in S3 has corresponding `cert_attestations` rows. Discrepancies are a data-integrity issue, not a real-time block.

### 5.4 iOS — `IssueCertificateView.swift` (new)

A SwiftUI sheet presented when the inspector taps "Issue certificate" from `JobDetailView`. Contents:

- Heading: **"Confirm and issue certificate"**
- Sub-heading: **"Two checks before this certificate is issued to the customer."**
- The two attestation paragraphs from §3.1 + §3.2, each with a leading SwiftUI `Toggle` that the inspector must tap.
- A two-button row: `Cancel` and `Issue certificate` (the latter disabled until both Toggles are on).
- On `Issue certificate`: submit to backend; on 200, dismiss sheet and trigger existing `EICRHTMLTemplate.render(...)` flow.
- Use `CertMateDesign` typography / colour tokens.
- VoiceOver labels on every interactive element.
- Touch targets ≥ 44pt.
- Toggles default off on every appearance — no `@State` persisted across appearances.

### 5.5 Web — `/job/[id]/issue/page.tsx` (new)

Equivalent UX on the web app. Uses existing design-system tokens. The `Issue` button currently triggers `/api/generate-pdf` directly; insert the attestation step between review and render.

### 5.6 Versioning

`attestation_text_version` uses calendar versioning (e.g. `2026-05-12`). Bump on any material change to the §3 wording. Pre-bump versions remain valid for historical reads (so the "Issued certificates" list can show what the inspector actually agreed to at issuance time). The backend keeps a static map `KNOWN_TEXT_VERSIONS` → wording, served to clients on app startup so wording is centrally controlled and the iOS app updates it via TestFlight refresh without code change.

Material changes that require a version bump:
- Adding or removing a sentence
- Changing what is being attested
- Changing the responsibility framing

Cosmetic changes that don't require a version bump:
- Punctuation
- Typography only

## 6. Retention

`cert_attestations` rows are retained for the **lifetime of the associated cert + 7 years** — matching the retention period for the cert itself ([retention-policy.md](./retention-policy.md) R1). They are the evidential proof that the cert was reviewed before issue. Deleting them earlier would defeat the purpose.

On account deletion (Path B Task 18, in-app account deletion), `cert_attestations` rows follow the same "retained under controller legal-obligation" carve-out as the certs themselves — they are moved under `archive/{userId}/` along with the PDFs, dissociated from the live user record but preserved for the regulatory retention window. See SAR / Erasure Playbook §6.3.

## 7. What this changes elsewhere in the paperwork

| Doc | Change | One-line summary |
|---|---|---|
| `beta-tester-agreement.md` | §4.3 strengthened | Adds: "and will record an attestation of this review with each certificate issued" |
| `dpia-voice-extraction-pipeline.md` | New mitigation M1.5 under R1 + new note in M-table introduction | Notes the attestation as a non-data-protection mitigation that strengthens the inspector-responsible framing |
| `privacy-policy.md` | "About inspectors" section | Adds: "attestation records linking your account to each certificate you issue" |
| `facts.md` | §3.A + §6.2 | New data-inventory entry + new RDS table |
| `ropa.md` | New activity P8 | Adds attestation processing under Processor ROPA |
| `retention-policy.md` | New row R15 | 7-year retention paired with R1 |
| `in-app-consent-screen.md` | New §4.5 | Clarifies that per-cert attestations are additive to the one-time consent, not replaced by it |
| `app-review-reviewer-notes.md` | New section | Tells App Store reviewer about Guideline 5.1.1(ix) alignment |
| `sar-erasure-playbook.md` | §6.3 (if it lists cert-related artifacts) | Adds `cert_attestations` to the controller-legal-obligation retained-on-erasure list |

## 8. Sign-off and review cadence

Wording (§3.1 + §3.2) review:
- Solicitor review at the same time as the Beta Tester Agreement (Path A item 6 — same brief).
- Annual review against ICO AI guidance updates and any App Store Review Guidelines changes.
- Re-review on any change to the AI extraction pipeline that materially changes what readings/observations look like (e.g. a new model with different failure modes).

## 9. Outstanding implementation work

Not in scope for the compliance documentation phase. Estimated effort once the BTA is solicitor-reviewed:

- Backend migration + route + tests: ~3 hours
- iOS sheet + APIClient call + tests: ~3 hours
- Web page + middleware + tests: ~2 hours
- End-to-end audit-trail integration test: ~1 hour
- Reviewer-notes update for App Store submission: ~30 min

**Total: ~9.5 hours focused engineering, to be scheduled after the solicitor returns the BTA review** (so any wording changes the solicitor demands on the BTA professional-responsibility clauses can be reflected in §3.1 / §3.2 in the same iteration). The two-attestation pattern itself is solicitor-independent — only the precise wording could change.
