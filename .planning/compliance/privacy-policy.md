---
title: CertMate Privacy Policy
status: draft for publication at certmate.uk/privacy
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: annually + on any material change to processing
publication_route: certmate.uk/privacy (to be wired into web/src/app/legal/privacy/page.tsx)
---

# Privacy Policy

**Effective:** [TO BE SET AT PUBLICATION]
**Last updated:** 2026-05-11

## Who we are

CertMate is a service operated by **Beckley Electrical Ltd**, a company registered in England and Wales (company number **11816656**), registered office: **1 MacArthur Close, Tilehurst, Reading, RG30 4XW**.

You can reach the person responsible for data protection at **`privacy@certmate.uk`**.

We are registered with the UK Information Commissioner's Office (ICO) under registration number **[TO BE INSERTED ONCE REGISTERED]**.

In this policy "we", "us", and "our" refer to Beckley Electrical Ltd trading as CertMate.

## What this policy covers

This policy describes how we collect, use, and protect personal data when you:

- Use the CertMate iOS app or the CertMate web application (the "service")
- Have your data entered into the service by an electrician carrying out an electrical inspection on your property
- Visit the CertMate website at **certmate.uk**

It also tells you what rights you have under UK data protection law and how to exercise them.

It does not cover:

- Other websites or services that link to or from CertMate — please consult their own privacy policies
- Data that an electrician (your service provider) holds about you outside of CertMate — they may have a separate privacy policy of their own

## What CertMate is

CertMate is a tool for UK electricians. It captures the inspector's dictation during an electrical inspection, transcribes that dictation, extracts the resulting test readings and observations using artificial intelligence, and produces a finalised electrical inspection certificate (an EICR — Electrical Installation Condition Report — or an EIC — Electrical Installation Certificate). The electrician then issues that certificate to you, the property owner or occupier.

## The two different roles we play with your data

Data protection law distinguishes between **controllers** (who decide why and how data is processed) and **processors** (who carry out processing on behalf of a controller). CertMate plays each role depending on whose data we are talking about.

### When you are an electrician (inspector) using CertMate

If you are an inspector who has signed up to use the service, **we are the controller for the data we hold about you**. That data includes the account information you provide at signup, your signature image, your job history with us, and so on. We decide why we collect that data (to provide the service to you) and how we look after it. This Privacy Policy is the legally-required notice for the data we hold about you in that capacity.

### When you are a homeowner whose data has flowed through CertMate

If your data is in CertMate because an electrician used the service to inspect your property, **the electrician is the controller for your data, and CertMate is the processor**. The electrician decided to use CertMate; we carry out specific processing on their behalf, under a contract that limits what we can do. The electrician's own privacy notice is the primary legal disclosure about what happens to your data, and they are the first port of call for any rights request you want to make. This policy tells you what role we play in that picture and how to contact us directly if you cannot reach the electrician or are not satisfied with their response.

### When you visit certmate.uk without being signed in

When you browse the public certmate.uk website without logging in, we collect only the minimum information necessary to operate the site. See the [Cookie Policy](./cookie-policy.md).

## The personal data we collect

### About inspectors (our direct users)

When you create an account and use CertMate, we collect:

- **Account information**: your full name, email address, password (stored only as a one-way hash), the company you work for (if any), and the date you signed up.
- **Inspector signature**: an image of your handwritten signature, which appears on every certificate you produce.
- **Job history**: a record of every electrical inspection you complete using CertMate, including the test readings, observations, and certificate output.
- **Test equipment details**: serial numbers and calibration dates of the multifunction tester (MFT) and any other instruments you record in your profile. These are stored on your iOS device only.
- **Cost and usage records**: a per-session record of how much of CertMate's API usage your work consumed (used for billing reconciliation and cost monitoring).
- **Device and crash diagnostics**: standard iOS crash reports and TestFlight install metadata. Apple processes these on our behalf — see the [Sub-Processor List](./sub-processors.md).

### About homeowners (your customers, as an inspector — or you, as a homeowner)

When an electrician carries out an inspection using CertMate, the service captures and stores the following data about the property and its occupier:

- **Name** of the customer / property owner / occupier as recorded on the certificate
- **Property address** (line 1, line 2, town) and **postcode**
- **Phone number and / or email address** of the customer, if the inspector dictates one
- **Photographs of the property's electrical installation** — typically of the consumer unit (fuse box) and of any defects flagged during inspection. **Photographs have all location metadata (EXIF, including GPS coordinates) removed before upload.**
- **Audio dictation** from the inspector during the inspection. The audio is streamed to a transcription service to produce a text transcript and is **not retained as audio** by us in normal operation. The text transcript is kept for 30 days for operational and debug purposes.
- **Electrical test readings** — Ze, prospective fault current, circuit-level Zs and insulation resistance values, RCD trip times, and so on.
- **Observations and remedial notes** generated during the inspection.
- **The finalised PDF certificate** that the inspector issues to the customer.

People other than the customer who happen to be present in the property during the inspection — family members, other contractors — may have their voices incidentally captured by the inspector's microphone during dictation. That audio is **not retained as audio**; the transcript may incidentally include words spoken near the microphone. The inspector is required, under their contract with us, to inform anyone present that voice dictation is taking place.

### About visitors to certmate.uk

When you visit our public website without logging in, we collect only the minimum information necessary to operate the site — typically server logs that include your IP address and the page you requested. We do not use analytics services, advertising trackers, or any third-party tracking technology. See the [Cookie Policy](./cookie-policy.md) for full detail.

## Why we collect each category of data

| Category | Why we collect it |
|---|---|
| Account information | To create and run your CertMate account |
| Inspector signature | To embed it on the certificates you produce |
| Job history | To let you find, review, and re-export past certificates; to maintain an audit trail of changes |
| Test equipment details | To pre-fill those fields on every certificate; to demonstrate that you used calibrated test equipment |
| Cost and usage records | To reconcile billing, monitor service costs, and investigate operational issues |
| Device and crash diagnostics | To identify and fix bugs in the iOS app |
| Customer / homeowner name, address, phone, email | These appear on the certificate (a legal requirement of the certificate format) |
| Property photographs | To extract circuit data via AI vision, and to retain visual evidence supporting the inspection |
| Audio dictation | To produce a transcript that drives AI extraction of certificate fields |
| Electrical test readings | These are the substance of the certificate |
| Observations and remedial notes | These are part of the certificate |
| Finalised PDF certificate | To allow the inspector and the customer to re-download it for the regulatory retention period |
| Server logs (visitors) | To operate the website and investigate security events |

## Our lawful bases under UK GDPR

We rely on the following lawful bases under the UK General Data Protection Regulation:

- **Performance of a contract (Article 6(1)(b))** — for everything we do to run the service you have signed up for, or that your inspector has signed up for. This is the primary basis for processing inspector account data and for processing homeowner data on the inspector's behalf.
- **Legitimate interest (Article 6(1)(f))** — for incidental capture of bystander voices during inspector dictation, for cost / usage telemetry, for crash diagnostics, and for security logging. The legitimate interest is the operation of a regulated electrical-inspection service. We have considered and balanced this against the privacy interests of the people affected and concluded the processing is proportionate; see [our Data Protection Impact Assessment](./dpia-voice-extraction-pipeline.md) for the full assessment.
- **Legal obligation (Article 6(1)(c))** — for retaining the finalised certificate and its supporting data for the minimum retention period required by the NICEIC scheme rules (six years) and applicable Building Regulations.
- **Consent (Article 6(1)(a))** — for any future marketing emails (we do not currently send marketing) and for browser-push notifications (where you must opt in via the browser prompt).

We do not process special-category data (such as health data or biometric data used to uniquely identify someone). Voice data is captured for transcription only — we do not generate voiceprints or any other unique-identification artefact, and we have committed not to add that capability without first publishing an updated Privacy Policy and a refreshed Data Protection Impact Assessment.

## A note on voice recording

Because CertMate captures voice dictation in private homes, we want to be explicit:

- The inspector consents to the recording when they sign their Beta Tester Agreement / Subscription Agreement.
- The inspector is required, under that agreement, to inform the customer or occupier at the start of each inspection that voice dictation is taking place. The exact wording is supplied to the inspector in the app.
- **Audio is not retained.** It is streamed to a UK-Addendum-compliant transcription service (see [Sub-Processor List](./sub-processors.md)) and discarded after transcription. We set the `mip_opt_out=true` flag on every connection so the transcription provider may not retain the audio for model training.
- **The text transcript is retained for 30 days** for operational debugging only; it is then deleted automatically.
- **We do not use voice to identify anyone.** No voiceprints, no speaker IDs.

If you are present at an inspection and you would prefer not to be incidentally recorded, ask the inspector. They can step into another room to dictate, or skip dictation altogether and enter readings manually.

## A note on AI processing

CertMate uses third-party artificial-intelligence services to:

- Transcribe inspector dictation into text (a speech-to-text service)
- Extract structured certificate fields (readings, observations, customer details) from the transcript (a large-language-model service)
- Extract circuit data from photographs of consumer units (a vision-language model service)
- Generate short voice prompts confirming what the inspector said (a text-to-speech service)

These are listed individually in our [Sub-Processor List](./sub-processors.md). Each operates under a Data Processing Agreement that prohibits training their models on your data and requires UK-equivalent data-protection safeguards.

**Inspector review is always required before a certificate is issued.** The AI never finalises a certificate on its own; the inspector reviews and confirms every extracted field. AI extraction is a dictation aid, not the authority on what the certificate says.

## Who else sees your data

The third parties who help us deliver the service are listed exhaustively at our [Sub-Processor List](./sub-processors.md). We update that page when we add or remove a sub-processor.

We do not sell personal data, share it for advertising or marketing purposes, or transfer it to any party outside the relationships listed there.

## International transfers and safeguards

Most data stays in the United Kingdom: it sits on Amazon Web Services infrastructure in the London region (eu-west-2).

Some processing — specifically the AI transcription, extraction, and text-to-speech steps — uses services hosted in the United States. Whenever data crosses to a US-hosted sub-processor we ensure one of the following safeguards applies, as required by UK GDPR Articles 44–46:

- The **UK Extension to the EU-US Data Privacy Framework**, where the receiving organisation is self-certified under that framework, or
- The **UK Addendum to the EU Standard Contractual Clauses** (SCCs) contained in our Data Processing Agreement with the sub-processor.

Each sub-processor's specific transfer mechanism is listed on the [Sub-Processor List](./sub-processors.md).

## How long we keep your data

The full retention schedule is in our [Retention Policy](./retention-policy.md). In summary:

- **Finalised certificates and their supporting data** (job records, photographs): 7 years from the date of issue (the NICEIC scheme requires 6 years; we add one year as a safety margin).
- **Transcripts of inspector dictation**: 30 days.
- **Raw audio**: not retained outside the live transcription stream. (A debug feature can write audio chunks to short-term storage during diagnostic investigation; this feature is off by default in production.)
- **Inspector account data**: for the lifetime of the account, then 7 years after account closure (because certificates issued under that account need to remain attributable).
- **Customer / property contact records** (the CRM-style record an inspector keeps of their past customers): 7 years after the last associated job.
- **Operational logs**: 30 days; personal-data fields (address, name, postcode, phone, email) are automatically replaced with `[REDACTED]` before any log line is written.

Retention may be extended in specific cases (an active legal hold, an open complaint, a current data-subject rights request). These extensions are recorded.

## Your rights

Under UK data protection law you have the following rights in respect of personal data we hold about you:

1. **Right to be informed** — about how your data is being used. This Privacy Policy is part of how we satisfy that right.
2. **Right of access** — to obtain a copy of the data we hold about you.
3. **Right to rectification** — to correct inaccurate data.
4. **Right to erasure** ("the right to be forgotten") — to ask us to delete your data, subject to certain exceptions where we have a legal obligation to retain it.
5. **Right to restrict processing** — to ask us to limit how we use your data while a query is being resolved.
6. **Right to data portability** — to receive a copy of your data in a machine-readable format.
7. **Right to object** — to processing carried out on the basis of legitimate interest.
8. **Rights related to automated decision-making** — to ask that a decision affecting you not be made solely by automation. CertMate does not make automated decisions in the legal sense — every certificate is reviewed and signed off by a human inspector.

We will respond to any of these requests **within one month** of receiving it, extendable by a further two months if the request is complex. If we need to clarify the request before we can respond, the clock pauses until you reply.

## How to exercise your rights

**If you are an inspector (you have a CertMate account):** email `privacy@certmate.uk` from the address registered on your account.

**If you are a homeowner whose data is in CertMate because an electrician used the service:** in the first instance, contact the electrician who carried out your inspection — they are the data controller and most rights requests are quickest to resolve through them. If you cannot reach them, or you are not satisfied with their response, contact us directly at `privacy@certmate.uk`. Please include the name of the electrician (if you can), the approximate date of the inspection, and the property address — this helps us find your record.

We may need to verify your identity before responding (we will not send sensitive data to anyone who cannot confirm they have a right to receive it). We will explain what verification we need at the time.

## Cookies and similar technologies

See the separate [Cookie Policy](./cookie-policy.md). In summary: certmate.uk uses one strictly-necessary cookie (an authentication mirror) and some strictly-necessary browser storage (a copy of the same authentication token, your UI preferences, and an offline cache so the app keeps working when your network drops). We do not use analytics, advertising, or third-party tracking technology.

## Children's data

CertMate is not intended for use by anyone under 18. We do not knowingly collect data about children. If a homeowner whose data is in CertMate is a child (for example, where a child is named as an occupier on rental-property paperwork passed to the inspector), please contact us at `privacy@certmate.uk` — we will work with you to confirm the position and act accordingly.

## How we keep your data secure

Some of the technical and organisational safeguards we use:

- All data in transit is encrypted using TLS / HTTPS.
- All data at rest in our cloud storage is encrypted by default.
- API keys for our sub-processors and database credentials are held in AWS Secrets Manager, not in source code.
- Authentication tokens on iOS are stored in the system Keychain (encrypted, device-bound).
- Access to our production environment is restricted to authorised personnel using multi-factor authentication.
- Operational logs are automatically scrubbed of personal-data fields before storage.
- We maintain an internal Records of Processing Activities, Retention Policy, and Data Protection Impact Assessment for high-risk processing.

We are working towards UK government **Cyber Essentials** certification, which independently verifies a baseline of cyber-security practice.

## Changes to this policy

We will update this policy if our processing materially changes. The "Last updated" date at the top of the policy reflects the most recent change. We will tell subscribed inspector-customers in writing about any change that materially affects how their data or their customers' data is handled, at least 28 days before the change takes effect where practical.

We retain previous versions of this policy on request — email `privacy@certmate.uk`.

## Contact

For any question or concern about this policy or about how we handle your data:

**Email:** `privacy@certmate.uk`
**Postal:** Data Protection, Beckley Electrical Ltd, 1 MacArthur Close, Tilehurst, Reading, RG30 4XW

## Complaining to the Information Commissioner's Office

If you are not satisfied with our response, or you believe we are not handling your data in accordance with the law, you have the right to lodge a complaint with the UK Information Commissioner's Office:

**Website:** [ico.org.uk/concerns](https://ico.org.uk/concerns/)
**Helpline:** 0303 123 1113
**Post:** Information Commissioner's Office, Wycliffe House, Water Lane, Wilmslow, Cheshire, SK9 5AF

You do not have to contact us first, although we would prefer the chance to put things right.
