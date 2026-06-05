---
title: CertMate Sub-Processor List
status: draft for publication at certmate.uk/legal/sub-processors
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: on change + at least quarterly
publication_route: certmate.uk/legal/sub-processors (to be wired into web/src/app/legal/sub-processors/page.tsx)
---

# CertMate sub-processor list

This page lists every organisation that may process personal data on CertMate's behalf as a "sub-processor" under UK GDPR Article 28. It is maintained by Beckley Electrical Ltd (the trading company behind CertMate) and is the authoritative source for who handles your data when you use the CertMate iOS app, the certmate.uk web app, or both.

If you are an inspector subscribed to CertMate, you may rely on this page to satisfy the Article 28(2) requirement to maintain an up-to-date list of sub-processors used in connection with your customers' data.

If you are a homeowner whose data sits in CertMate because your electrician used it to produce an electrical inspection certificate, this page tells you exactly which third parties have seen or stored that data.

## What "sub-processor" means

CertMate sometimes acts as a **processor** for inspector-customers — when an inspector dictates findings about a homeowner's property, CertMate processes that data on the inspector's behalf. We engage third parties (sub-processors) to help us provide the service: an AI transcription provider, AI model providers, cloud infrastructure, and so on. Each of those is a sub-processor.

A sub-processor only ever sees data that is strictly necessary for the part of the service they perform. They are bound by a Data Processing Agreement (DPA) that requires them to handle the data to at least the same standard as CertMate is required to handle it.

## How to be notified of changes

We will add or remove sub-processors as the service evolves. Material changes are announced:

- **In writing to subscribing inspector-customers** at least 28 days before the change takes effect, where practical
- **By updating this page** with the new entry on the day the change goes live, and updating the "Last verified" date in the frontmatter

If you are an inspector-customer and you object to a new sub-processor, your Beta Tester Agreement / Subscription Agreement gives you the right to terminate without penalty rather than accept the change.

## Active sub-processors

The list below is current as of the "Last verified" date at the top of this page.

### Infrastructure and storage

| Sub-processor | What they do for CertMate | Region | Transfer mechanism (for any data leaving UK) | Reference |
|---|---|---|---|---|
| **Amazon Web Services EMEA SARL** (AWS) | Cloud infrastructure — ECS Fargate compute, S3 object storage, RDS PostgreSQL, Secrets Manager, CloudWatch logs, Application Load Balancer, ECR container registry, Route 53 DNS. All CertMate data at rest lives here. | eu-west-2 (London) — UK | None — data stays in UK | [AWS GDPR DPA](https://aws.amazon.com/compliance/gdpr-center/) |

### AI processing

These are the services that handle the live voice + photo extraction pipeline. They process data transiently for transcription, extraction, or speech synthesis and (per the contract terms agreed by CertMate) do not retain that data for model training.

| Sub-processor | What they do for CertMate | Region | Transfer mechanism | Reference |
|---|---|---|---|---|
| **Deepgram, Inc.** | Real-time speech-to-text transcription of inspector dictation via the Nova-3 model. Audio streams over a WebSocket from your iOS device direct to Deepgram. CertMate sets `mip_opt_out=true` on every connection so audio is not retained for Deepgram's Model Improvement Partnership Program. | US (EU endpoint available) | UK Addendum to EU Standard Contractual Clauses in Deepgram's DPA | [Deepgram Privacy](https://deepgram.com/privacy) |
| **Anthropic, PBC** | Structured extraction of certificate fields from transcripts using Claude Sonnet. Receives the transcript text and the structured state of the certificate being built; returns extracted field values. API tier is non-training and non-retained beyond Anthropic's short-window operational logs. | US | UK Addendum to EU Standard Contractual Clauses in Anthropic's Commercial DPA | [Anthropic Privacy](https://www.anthropic.com/legal/privacy) · [DPA portal](https://privacy.claude.com/en/articles/7996862-how-do-i-view-and-sign-your-data-processing-addendum-dpa) |
| **OpenAI, OpCo, LLC** | Visual extraction of circuit data from consumer-unit photos and document scans, using GPT Vision. Receives the photos and returns structured field values. API tier is non-training; retention follows OpenAI's documented API policy. | US | UK Addendum to EU Standard Contractual Clauses in OpenAI's DPA | [OpenAI Privacy](https://openai.com/policies/privacy-policy/) · [OpenAI DPA](https://openai.com/policies/feb-2024-data-processing-addendum/) |
| **ElevenLabs, Inc.** | Text-to-speech generation for the inspector confirmation prompts ("I heard the Ze as zero point one three, confirm?"). Receives short text strings (which may contain extracted field values such as an address being read back to the inspector); returns audio. | US | UK Extension to the EU-US Data Privacy Framework (ElevenLabs is self-certified) + Standard Contractual Clauses as a fallback | [ElevenLabs Privacy](https://elevenlabs.io/privacy-policy) · [ElevenLabs DPA](https://elevenlabs.io/dpa) · [DPF policy](https://elevenlabs.io/eu-us-data-privacy-framework-policy) |

### Development, distribution, and operations

| Sub-processor | What they do for CertMate | Region | Transfer mechanism | Reference |
|---|---|---|---|---|
| **GitHub, Inc.** (Microsoft Corp.) | Source-code hosting and continuous-integration pipeline. Builds and deploys the backend container images. Never sees personal data — only source code. | US | UK Extension to EU-US Data Privacy Framework + UK Addendum to SCCs as part of the Microsoft Products and Services DPA | [Microsoft DPA](https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA) |
| **Apple, Inc.** / Apple Distribution International Ltd | iOS app distribution via the App Store and TestFlight. Receives inspector tester emails for TestFlight, device + crash metadata while the app runs. | Apple's global infrastructure | UK Extension to EU-US Data Privacy Framework + SCCs in the Apple Developer Program agreement | [Apple Privacy](https://www.apple.com/legal/privacy/) |
| **Pushover Inc.** | Operational push notifications to the CertMate operator's own device only. Receives no inspector or homeowner data. | US | Operator-only data; not a sub-processor for inspector-customer data | [Pushover Privacy](https://pushover.net/privacy) |
| **Browser vendors providing Web Push** — Apple Push Notification Service (APNs), Google FCM, Mozilla Push, depending on browser | Web push notifications to opted-in inspector users, e.g. job-update alerts when the web PWA is backgrounded | Variable by vendor (typically US for Mozilla, Google); APNs is Apple infrastructure | UK Extension to EU-US DPF or SCCs depending on vendor; subscription credentials are encrypted end-to-end | Linked from each browser vendor's privacy policy |

## Not currently active

The following integrations have code paths in the CertMate repository but are not connected to a live third-party account, and so do not currently process any data. They will be added to the active list above the day they go live, with 28 days' advance notice to subscribing inspectors:

- **Stripe, Inc.** — for subscription billing. Schema tables exist in the database but no Stripe account is connected.
- **Google LLC (Calendar API)** — for syncing inspections to a Google Calendar. Schema tables exist but the feature is not in use.
- **Email delivery provider (likely AWS SES)** — for transactional email such as certificate delivery. Not currently configured in production.

## Recently retired

- **TradeCert** — dormant code path removed on 2026-05-11; associated credentials deleted from production secrets storage. Never carried live customer data.

## How to raise a concern

If you have a concern about any sub-processor on this list — including a request to know more about what they specifically receive in respect of your data — please contact us at `privacy@certmate.uk`. If you are a homeowner data subject and you would prefer to raise the concern through the inspector who carried out your inspection, that is also fine — they will route it to us under their contract with CertMate.

You may also complain directly to the UK Information Commissioner's Office at [ico.org.uk/concerns](https://ico.org.uk/concerns/) at any time.
