---
title: CertMate Records of Processing Activities (ROPA)
status: working draft
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: quarterly + on material change
---

# CertMate Records of Processing Activities (ROPA)

> **Statutory basis.** UK GDPR Article 30 — every controller and every processor must maintain a record of their processing activities. The "small organisation" exemption (Art. 30(5)) does not apply to CertMate because the processing is regular (not occasional) and includes personal data of third parties (homeowners) on a non-incidental basis.
>
> **Scope.** This document holds both the controller-side and processor-side ROPAs as required by Art. 30(1) and Art. 30(2) respectively. CertMate operates a dual-hat structure (controller for inspector account data; processor for homeowner data via inspector-customers).
>
> **Source of facts.** All entries below are derived from `./facts.md`. If anything in this ROPA disagrees with `facts.md`, fix `facts.md` first and propagate.

---

## Part 0 — Controller / processor identity

| Item | Value |
|---|---|
| Trading name | CertMate |
| Legal entity | Beckley Electrical Ltd |
| Companies House number | 11816656 |
| Registered office | 1 MacArthur Close, Tilehurst, Reading, RG30 4XW |
| Data protection contact | `[GAP]` `privacy@certmate.uk` (mailbox to be provisioned) |
| DPO appointed | No — UK GDPR Art. 37 thresholds not met. Derek Beckley acts as named **Data Protection Lead**. |
| ICO registration number | `[GAP]` — pending registration (compliance Task #4) |

---

## Part 1 — Controller-side ROPA (Art. 30(1))

CertMate is **controller** for processing where Beckley Electrical Ltd determines purposes and means independently — primarily the operation of CertMate as a service to inspectors.

### Activity C1 — Inspector account management

| Field | Value |
|---|---|
| Purpose | Create, authenticate, and maintain inspector user accounts so they can use the CertMate service |
| Categories of data subjects | Inspectors (sole traders, employees of electrical contractors) |
| Categories of personal data | Full name, email address, password hash, company association, account state metadata (last login, failed login attempts, locked-until, token version) |
| Recipients | AWS (eu-west-2) — Amazon Web Services EMEA SARL acting as infrastructure processor |
| International transfers | None — data remains in UK |
| Retention | Account lifetime + 7 years after closure (linked to certs issued by that inspector) |
| Lawful basis | Art. 6(1)(b) — performance of contract |
| Security measures | See Part 3 |

### Activity C2 — Inspector authentication and session management

| Field | Value |
|---|---|
| Purpose | Verify inspector identity on each API call; maintain session continuity |
| Categories of data subjects | Inspectors |
| Categories of personal data | JWT bearer tokens (encoded user ID + expiry), token version counter |
| Recipients | AWS (eu-west-2); client devices (iOS Keychain, web localStorage + cookie) |
| International transfers | None |
| Retention | Token: until expiry. `token_version` counter: account lifetime. |
| Lawful basis | Art. 6(1)(b) — performance of contract |
| Security measures | iOS: Keychain (encrypted, device-bound). Web: localStorage + `SameSite=Lax` cookie — **note: not HttpOnly, residual XSS risk documented in the DPIA.** Backend: JWT signed with HS256 secret from AWS Secrets Manager. |

### Activity C3 — Inspector signature storage

| Field | Value |
|---|---|
| Purpose | Hold the inspector's signature image so it can be applied to every certificate they produce |
| Categories of data subjects | Inspectors |
| Categories of personal data | Signature image (PNG) |
| Recipients | AWS S3 `eicr-files-production` (eu-west-2) at `settings/{userId}/signatures/{filename}`; cached locally on iOS via GRDB SQLite |
| International transfers | None |
| Retention | Account lifetime + 7 years (linked to issued certs that embed the signature) |
| Lawful basis | Art. 6(1)(b) — performance of contract |
| Security measures | S3 bucket private (no public ACLs); IAM least-privilege; user-scoped key prefix; HTTPS-only access |

### Activity C4 — Operational logging

| Field | Value |
|---|---|
| Purpose | Diagnose errors, monitor service health, investigate security events |
| Categories of data subjects | Inspectors; transitively, the homeowners whose data appears in log lines |
| Categories of personal data | User ID, IP address (in some log lines), request paths, error stacks. **Currently also includes raw `address`, `client_name`, `postcode` strings** — see DPIA §R3 and compliance Task #3. |
| Recipients | AWS CloudWatch Logs in `/ecs/eicr/eicr-backend` and `/ecs/eicr/eicr-pwa` (eu-west-2) |
| International transfers | None |
| Retention | **30 days** — verified configured at the log-group level on 2026-05-11. PII fields redacted from log lines at the Winston format-chain level (commit `fb20dc0`). |
| Lawful basis | Art. 6(1)(f) — legitimate interest (service operation and security) balanced against subject interests; balancing test relies on redaction (in progress) |
| Security measures | CloudWatch encrypted at rest; IAM-controlled read access; admin-only |

### Activity C5 — Crash and TestFlight diagnostics

| Field | Value |
|---|---|
| Purpose | Identify and fix iOS app crashes during beta |
| Categories of data subjects | Inspectors (TestFlight participants) |
| Categories of personal data | Tester email, device model, OS version, crash stack traces, install metadata |
| Recipients | Apple Inc. / Apple Distribution International Ltd (TestFlight + App Store Connect) |
| International transfers | US — covered by EU-US Data Privacy Framework (Apple is DPF-certified) and Apple Developer Program DPA |
| Retention | ~90 days (Apple-managed default) |
| Lawful basis | Art. 6(1)(f) — legitimate interest (service quality) |
| Security measures | Apple platform controls; no in-house crash collection currently |

### Activity C6 — Marketing communications (inactive)

| Field | Value |
|---|---|
| Purpose | Inform prospective and existing inspector users about CertMate features and pricing |
| Categories of data subjects | Inspectors and prospective inspectors |
| Categories of personal data | Email address, name, opt-in record |
| Recipients | `[GAP]` — no email service deployed in production; would be added when wired |
| International transfers | TBD by email provider choice |
| Retention | Until unsubscribe; opt-in proof retained 2 years post-unsubscribe |
| Lawful basis | Art. 6(1)(a) — consent. PECR opt-in for all marketing email regardless of business-vs-consumer (sole traders treated as individual subscribers). |
| Security measures | TBD when email provider is wired. **Currently dormant — no marketing email is sent.** |

### Activity C7 — Web push notifications

| Field | Value |
|---|---|
| Purpose | Notify inspectors of job updates, sync events, or extraction completion when the web PWA is backgrounded |
| Categories of data subjects | Inspectors who opt in via the web PWA |
| Categories of personal data | Push subscription credentials (endpoint URL, p256dh public key, auth secret) |
| Recipients | Browser vendor push service (Apple Push Notification Service, Mozilla Push, Google FCM depending on browser) |
| International transfers | Variable by vendor — typically US-based for Mozilla and Google; covered under their respective DPF / SCCs frameworks |
| Retention | Until user revokes or 12-month idle expiry |
| Lawful basis | Art. 6(1)(a) — consent (browser permission prompt) |
| Security measures | Credentials stored in RDS; pushes encrypted end-to-end using VAPID + push subscription public key |

---

## Part 2 — Processor-side ROPA (Art. 30(2))

CertMate is **processor** for activities performed on behalf of inspector-customers (who are controllers for their homeowners' data). Each inspector-customer relationship is conceptually a separate processor-controller pair, but the categories of processing are identical, so this table is written once and applies to every inspector-customer signed up under the Beta Tester Agreement / Subscription Agreement.

> **As of 2026-05-11 there is one controller — Derek (acting as inspector through his Ltd company).** Once tester #2 onboards, this section grows a per-controller register.

### Activity P1 — Real-time voice transcription

| Field | Value |
|---|---|
| Purpose | Convert inspector dictation into text for live extraction into the certificate |
| Controllers on whose behalf | Inspector-customer (named on subscription / Beta Tester Agreement) |
| Categories of data subjects | Inspector; incidentally, homeowner and any third parties present in earshot |
| Categories of personal data | Audio stream (PCM); resulting transcript text |
| Sub-processors | Deepgram, Inc. (US) — Nova-3 model via WebSocket |
| International transfers | US — UK Addendum to EU SCCs in Deepgram DPA. `[ACTION]` Task #2 — DPA not yet signed. |
| Retention by processor | Audio: not persisted in normal operation (live-streamed, in-memory 3s ring buffer only). Transcripts: 30 days in S3 `session-analytics/{userId}/{sessionId}/debug_log.jsonl`. **Exception: debug audio chunks `debug/{userId}/{sessionId}/chunk_*` are currently persisted indefinitely** — `[ACTION]` Task #3 to disable in prod or cap with 7-day lifecycle. |
| Retention by Deepgram | Zero retention if `mip_opt_out=true` is set — `[ACTION]` Task #3 to set this flag. Default account would allow Deepgram to retain for model improvement. |
| Security measures | TLS WebSocket; API key in AWS Secrets Manager; user-scoped S3 keys |

### Activity P2 — AI extraction from transcripts (Sonnet 4.5)

| Field | Value |
|---|---|
| Purpose | Extract structured certificate field values (Ze, PFC, Zs, circuit details, client name, address, phone, email, etc.) from inspector dictation transcripts |
| Controllers on whose behalf | Inspector-customer |
| Categories of data subjects | Homeowner (subject of inspection); inspector |
| Categories of personal data | Transcript text containing dictated personal data + structured extraction state (circuit readings, observations, etc.) |
| Sub-processors | Anthropic PBC (US) — Claude Sonnet 4.5 via API |
| International transfers | US — UK Addendum to EU SCCs in Anthropic Commercial DPA. `[ACTION]` Task #2 — Commercial Terms not yet acknowledged. |
| Retention by processor | Extracted data: stored in RDS `jobs` + `job_versions` and S3 `extracted_data.json` per Retention Policy §2 |
| Retention by Anthropic | API tier default is non-training, non-retained beyond operational logs (~30 days). Verify on tier upgrade. |
| Security measures | TLS API calls; API key in AWS Secrets Manager; prompt + response logged to internal logs (PII-redaction in progress under Task #3) |

### Activity P3 — AI extraction from photos (GPT Vision)

| Field | Value |
|---|---|
| Purpose | Extract circuit data from consumer unit (CCU) photos; extract certificate fields from previous-certificate scans and handwritten notes |
| Controllers on whose behalf | Inspector-customer |
| Categories of data subjects | Homeowner (whose property is photographed); previous-certificate subjects (whose names + signatures may appear in scanned documents) |
| Categories of personal data | Property photographs (with EXIF metadata including GPS until Task #3 strips it); scanned text content of previous certificates |
| Sub-processors | OpenAI, OpCo, LLC (US) — GPT-5.2 Vision + GPT-5-search-api via API |
| International transfers | US — UK Addendum to EU SCCs in OpenAI DPA. `[ACTION]` Task #2 — DPA not yet signed. |
| Retention by processor | Photos: stored in S3 `jobs/{userId}/{folderName}/photos/` for cert lifetime (7 years per Retention Policy §2) |
| Retention by OpenAI | API default 30 days; zero-data-retention (ZDR) is a tier upgrade — verify status |
| Security measures | TLS API calls; API key in AWS Secrets Manager |

### Activity P4 — Text-to-speech confirmation prompts (ElevenLabs)

| Field | Value |
|---|---|
| Purpose | Generate spoken confirmation prompts during recording (e.g. "I heard the Ze as zero point one three, confirm?") |
| Controllers on whose behalf | Inspector-customer |
| Categories of data subjects | Inspector (spoken to); homeowner (data values spoken aloud — e.g. address being read back) |
| Categories of personal data | Text strings sent to TTS — may contain extracted field values such as addresses or names |
| Sub-processors | ElevenLabs, Inc. (US) |
| International transfers | US — UK Extension to EU-US Data Privacy Framework (ElevenLabs self-certified) + SCCs fallback. `[ACTION]` Task #2 — DPA not yet accepted. |
| Retention by processor | None — audio response is streamed and discarded after playback |
| Retention by ElevenLabs | API-tier defaults; enable Zero Retention Mode (Enterprise) if available on plan |
| Security measures | TLS API calls; API key in AWS Secrets Manager |

### Activity P5 — Generation, storage, and delivery of EICR / EIC certificates

| Field | Value |
|---|---|
| Purpose | Produce a finalised electrical inspection certificate PDF |
| Controllers on whose behalf | Inspector-customer |
| Categories of data subjects | Homeowner; inspector |
| Categories of personal data | Full certificate dataset — homeowner name, property address, postcode, phone, email; inspector name + signature; all electrical readings; observations |
| Sub-processors | AWS (S3 for storage, eu-west-2); iOS WKWebView for rendering on device (no external sub-processor) |
| International transfers | None — storage in UK |
| Retention | 7 years post-issue per Retention Policy §2 (NICEIC 6yr scheme minimum + safety margin) |
| Security measures | S3 user-scoped key prefix; HTTPS access; signed URLs for download; no public bucket policies |

### Activity P6 — Homeowner CRM persistence

| Field | Value |
|---|---|
| Purpose | Allow inspectors to maintain a list of past customers and properties for repeat business, follow-up inspections, and operational continuity |
| Controllers on whose behalf | Inspector-customer |
| Categories of data subjects | Homeowner |
| Categories of personal data | Name, email, phone, company affiliation, address, postcode, property type, notes |
| Sub-processors | AWS (RDS PostgreSQL in eu-west-2) |
| International transfers | None |
| Retention | Aligned with job retention — 7 years after last job for that client. Configurable per-inspector erasure on request. |
| Security measures | RDS encryption at rest; user-scoped row-level filters in application logic; no cross-tenant read paths |

### Activity P7 — Cost / usage telemetry

| Field | Value |
|---|---|
| Purpose | Track per-session API consumption (Deepgram audio minutes, Anthropic tokens, OpenAI tokens, ElevenLabs characters) for billing reconciliation and cost monitoring |
| Controllers on whose behalf | Inspector-customer |
| Categories of data subjects | Inspector (user ID); no homeowner data |
| Categories of personal data | User ID, session ID, per-call cost metrics, timestamp |
| Sub-processors | AWS S3 (eu-west-2) |
| International transfers | None |
| Retention | 2 years (billing dispute window) |
| Security measures | S3 user-scoped key prefix; no public ACLs |

---

## Part 3 — General description of security measures

Required by both Art. 30(1)(g) and Art. 30(2)(d). The same measures apply to all activities above except where overridden in the activity table.

### Organisational

- **Single named accountable individual**: Derek Beckley acts as Data Protection Lead, with outsourced DP consultant retainer planned (compliance Task #5 / wider plan §6.3).
- **Access control**: only Derek has admin access today. Future operational additions will follow least-privilege.
- **MFA**: enforced on AWS root + IAM, GitHub, OpenAI, Anthropic, Deepgram, ElevenLabs, App Store Connect, ICO portal, domain controls (audited under compliance Task #5; pre-req for Cyber Essentials v3.3 in April 2026).
- **Incident response**: documented playbook (Phase 5 — compliance Task #9) including 24h notification to controller and 72h notification to ICO.
- **Sub-processor due diligence**: DPA signed with each before live use (compliance Task #2 in progress).
- **Background check on personnel**: N/A (single-person team).

### Technical

- **Encryption in transit**: HTTPS-only on all public endpoints; TLS for API calls to sub-processors; WSS for Deepgram WebSocket and iOS↔backend WebSocket.
- **Encryption at rest**: S3 default encryption (SSE-S3); RDS encryption at rest enabled; AWS Secrets Manager for all API keys and JWT signing secret.
- **Authentication**: bcrypt-hashed passwords; JWT bearer tokens via Authorization header (or query param for WebSocket upgrade on iOS — see DPIA §R7); short token expiry with rotation via `token_version` counter.
- **Authorisation**: user-scoped S3 key prefixes (`jobs/{userId}/...`, `settings/{userId}/...`); user-scoped row filters in RDS application logic.
- **Network**: AWS ALB with WAF; private RDS subnet; ECS Fargate tasks in private subnets; no direct EC2 SSH.
- **Logging**: CloudWatch (retention being configured to 30 days under Task #3; redaction of personal data fields in progress under same task).
- **Backup**: RDS automated backups (7-day window); S3 versioning enabled.
- **Patching**: backend container rebuilt and redeployed on every push to `main` via GitHub Actions; iOS app updated via App Store Connect.

### Resilience

- **Service availability**: ECS Fargate auto-scales; RDS Multi-AZ `[CONFIRM]` for production tier.
- **Disaster recovery**: RDS point-in-time recovery within 7-day window; S3 versioning supports object-level rollback.

---

## Part 4 — Review history

| Date | Reviewer | Material change |
|---|---|---|
| 2026-05-11 | Derek Beckley (initial draft from code audit + facts.md) | Initial creation |

---

## Outstanding items

The `[GAP]` and `[ACTION]` markers above all trace back to entries in `./facts.md` §13–14 and the compliance task list. This ROPA is **publishable to ICO on request as-is** but should be updated once:

1. ICO registration number is issued (Activity C-header)
2. `privacy@certmate.uk` mailbox is provisioned (all activities)
3. Sub-processor DPAs are signed (Activities P1–P4)
4. Debug audio retention is closed and CloudWatch retention is set (Activity P1, C4)
5. EXIF stripping is shipped (Activity P3)
6. HeyGen is confirmed active / removed (would add a new activity if active)
