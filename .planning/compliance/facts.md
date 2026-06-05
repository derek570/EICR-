---
title: CertMate compliance facts — single source of truth
status: working draft
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
---

# CertMate compliance facts

> **Purpose.** Single reference document for every subsequent legal / compliance artefact: Privacy Policy, ROPA, DPIA, Beta Tester Agreement, Sub-processor List, Retention Policy, Cookie Policy, Acceptable Use Policy, Incident Response Runbook, SAR Playbook.
>
> **When a downstream doc needs to state "what data CertMate collects" / "who processes it" / "where it lives" / "how long it's kept", it pulls from this file.** Drift between this file and any drafted doc must be reconciled here first.
>
> Marker conventions used below:
> - `[CONFIRM]` — needs verification by Derek; currently a best-guess
> - `[GAP]` — known omission still to be filled in
> - `[ACTION]` — concrete fix already on the action-item list at the bottom
> - `[VERIFIED]` — confirmed by code audit on 2026-05-11

## 1. Legal entity & contact

| Item | Value |
|---|---|
| Trading name | CertMate |
| Public-facing product domain | **certmate.uk** (managed at AWS Route 53). The older `certomatic3000.co.uk` reference in `CLAUDE.md` is stale. |
| Legal entity | **Beckley Electrical Ltd** |
| Companies House number | **11816656** |
| Registered office address | 1 MacArthur Close, Tilehurst, Reading, RG30 4XW |
| ICO registration number | `[GAP]` — pending registration (Task #4) |
| Privacy contact mailbox | `[GAP]` — propose `privacy@certmate.uk` and `security@certmate.uk` |
| DPO appointed | No — DPO not legally required at this scale (UK GDPR Art. 37 thresholds not met). Derek acts as named Data Protection Lead. |

## 2. Data subjects

CertMate processes personal data of four distinct categories of people. Each has a different relationship to the product.

| # | Data subject | Relationship | Volume (today) |
|---|---|---|---|
| A | **Inspector / electrician (account holder)** | Direct user — CertMate is *controller* | One (Derek). Will grow as other inspectors are admitted. |
| B | **Homeowner / property occupier** | Subject of the inspection — once tester #2 is onboarded, the inspector becomes controller and CertMate becomes processor. Until then, Derek is both controller (of his own customers' data) and developer. | One per job |
| C | **Third parties incidentally present** (homeowner's family, other trades on site) | Voices may be captured incidentally during dictation | Variable |
| D | **Previous-cert subjects** | Names / signatures appearing in earlier certificates that get photographed through the document extraction feature | One+ per use of feature |

## 3. Personal data inventory — by data subject

### A. Inspector (account holder)

| Field | Storage | Source | Notes |
|---|---|---|---|
| Full name | RDS PostgreSQL `users.name` | Signup | `[VERIFIED]` — `migrations/001_baseline.cjs` |
| Email address | RDS PostgreSQL `users.email` | Signup | `[VERIFIED]` |
| Password hash | RDS PostgreSQL `users` | Signup | `[VERIFIED]` |
| Account state (active, last login, failed login attempts, locked-until, token version) | RDS PostgreSQL `users` | Login activity | `[VERIFIED]` |
| Company association | RDS PostgreSQL `users.company_name` + `jobs.company_id` foreign key | Signup / setup | `[VERIFIED]` |
| Signature image (PNG) | S3 `settings/{userId}/signatures/{filename}` and local GRDB SQLite on iOS | Profile setup | `[VERIFIED]` |
| Test equipment serial numbers + calibration dates | Local on iOS only (`Inspector.swift`) | Profile setup | `[VERIFIED]` |
| Inspector certification numbers (NICEIC / NAPIT / Stroma / ELECSA) | **Not stored anywhere on iOS.** Backend `InspectorProfile` type has an optional `enrolment_number` but it isn't populated by the iOS app. | n/a | `[VERIFIED]` — fewer ID fields = smaller PII surface |
| JWT auth token | iOS Keychain (`com.certomatic.certmateunified` / `jwt_token`); web localStorage `cm_token` + non-HttpOnly cookie `token` | At login | `[VERIFIED]` — iOS uses KeychainAccess library. Web auth has XSS-readable storage; HttpOnly migration is on the roadmap (`web/src/lib/auth.ts` comment refers to "Phase 9"). |
| Job history (which inspections they did) | RDS `jobs.user_id` + S3 `jobs/{userId}/` | Job creation | `[VERIFIED]` |
| Per-PDF attestation records | RDS `cert_attestations` (`user_id`, `job_id`, `pdf_s3_key`, `attestation_kind`, `attestation_text_version`, `attested_at`, `recorded_at`, `platform`, `platform_version`, `ip_address`, `user_agent`) | Captured at PDF generation | `[PENDING]` — schema specified in [pdf-issuance-attestations.md](./pdf-issuance-attestations.md); table not yet created |
| Session cost / usage analytics | S3 `session-analytics/{userId}/{sessionId}/cost_summary.json` | Recording sessions | `[VERIFIED]` |
| Device crash logs | Apple TestFlight (90d Apple-managed retention) | Auto | `[CONFIRM]` no separate in-house crash uploader |
| Push subscription credentials (web) | RDS `push_subscriptions` (endpoint, p256dh, auth) | Browser push opt-in | `[VERIFIED]` |
| Google Calendar OAuth tokens | RDS `calendar_tokens` (access_token, refresh_token, expiry) | OAuth grant | `[VERIFIED]` schema exists but Calendar is not in active use (no plans to use) |
| Stripe customer / subscription IDs | RDS `subscriptions` (stripe_customer_id, stripe_subscription_id, plan, status, periods) | Subscription event | `[VERIFIED]` schema exists but Stripe is not connected to a live account yet |

### B. Homeowner / property occupier (per inspection)

| Field | Storage | Source | Notes |
|---|---|---|---|
| Full name (`client_name`) | RDS `jobs.client_name`, RDS `clients.name`, S3 `extracted_data.json`, generated PDFs, RDS `job_versions.data_snapshot` | Dictation or manual entry | `[VERIFIED]` |
| Property address (line 1, line 2, town) | RDS `jobs.address`, RDS `properties.address`, S3 path itself (`jobs/{userId}/{address}/`), PDFs | Dictation, manual, postcode lookup | `[VERIFIED]` — address embedded into S3 key |
| Postcode | RDS `properties.postcode`, S3 `extracted_data.json` | Same | `[VERIFIED]` |
| Phone number (`client_phone`) | RDS `clients.phone`, S3 `extracted_data.json` under `installation_details.client_phone` | **Voice extraction** → Sonnet | `[VERIFIED]` — `packages/shared-types/src/job.ts:59`; the audit confirmed this is captured. |
| Email (`client_email`) | RDS `clients.email`, S3 `extracted_data.json` under `installation_details.client_email` | **Voice extraction** → Sonnet | `[VERIFIED]` |
| Property type, notes | RDS `properties.property_type`, `properties.notes` | Manual entry | `[VERIFIED]` |
| Property photos (consumer unit, observations, document scans) | S3 `jobs/{userId}/{folderName}/photos/{filename}` | Inspector camera | `[VERIFIED]` |
| **EXIF metadata (incl. GPS) on uploaded photos** | Same S3 location as the photo itself | iOS camera | `[VERIFIED]` — **EXIF is NOT stripped** by `Sources/Processing/ImageScaler.swift`. GPS coordinates of every property are uploaded. `[ACTION]` Task #3 fixes this. |
| Voice in any recorded audio | **Live to Deepgram only** in normal operation; **also written to S3 `debug/{userId}/{sessionId}/chunk_*` for debug** | Inspector dictation | `[VERIFIED]` — `src/routes/recording.js:892-906`. `[ACTION]` Task #3 env-gates this off in prod or adds tight S3 lifecycle. |
| Voice transcripts (text) | S3 `session-analytics/{userId}/{sessionId}/debug_log.jsonl` | Deepgram → server | `[VERIFIED]` |
| Generated EICR / EIC PDF | S3 `jobs/{userId}/{folderName}/output/eicr_certificate.pdf` | Local iOS render OR server render | `[VERIFIED]` — iOS uses local WKWebView; web uses server-side Python ReportLab + Playwright |

### C. Third parties incidentally present

| Field | Storage |
|---|---|
| Voice (incidental utterances captured during inspector dictation) | Live to Deepgram → transcript text only → S3 `debug_log.jsonl` (text) and possibly S3 `debug/.../chunk_*` (raw audio if debug path enabled) |

**This is the single highest-risk data category in the system.** It is the focus of the DPIA in Phase 2.

### D. Previous-certificate subjects (document extraction feature)

When inspectors photograph previous EICRs or handwritten notes:

| Field | Storage |
|---|---|
| Photos of source documents (may contain previous inspector name + signature, previous homeowner name + address) | S3 `jobs/{userId}/{folderName}/photos/{filename}` |
| Text extracted from those photos | S3 `extracted_data.json` |

This data is processed by OpenAI GPT Vision and then carried into the new certificate.

## 4. Processing activities & lawful bases

| Activity | Data subjects | Role | Lawful basis | Special category? |
|---|---|---|---|---|
| Inspector account management | A | Controller | UK GDPR Art. 6(1)(b) — contract | No |
| Marketing emails to inspectors | A | Controller | Art. 6(1)(a) — consent (PECR opt-in). Not currently active — none sent. | No |
| Real-time voice transcription | A, B, C | Processor (for inspector); Controller (for self-use today) | Art. 6(1)(b) — contract (inspector); Art. 6(1)(f) — legitimate interest (B, C incidental) | **No** — transcription only, not biometric processing. See DPIA. |
| AI extraction of certificate fields from transcripts | A, B | Processor | Art. 6(1)(f) — legitimate interest (compiling a regulated safety report) | No |
| AI extraction of fields from photos (CCU, documents) | B, D | Processor | Art. 6(1)(f) | No |
| Generation + storage of EICR / EIC PDF | A, B | Processor | Art. 6(1)(b) — contract; Art. 6(1)(c) — legal obligation (NICEIC 6yr scheme retention) | No |
| Storage of inspector signature | A | Controller | Art. 6(1)(b) | No |
| Crash / debug logging | A | Controller | Art. 6(1)(f) | No |
| TestFlight beta distribution | A | Controller | Art. 6(1)(b); Art. 6(1)(a) consent (clickwrap beta terms — once drafted) | No |
| Storage of homeowner phone / email in CRM tables | B | Processor (when controller is inspector) | Art. 6(1)(f) — legitimate interest (operational continuity, return visits) | No |

## 5. Sub-processors

### 5.1 Active sub-processors

| Vendor | Role / data seen | Region | DPA URL | Transfer mechanism | Status |
|---|---|---|---|---|---|
| **AWS** | ECS Fargate, S3 (job data, photos, PDFs, transcripts, signatures), RDS PostgreSQL, Secrets Manager, CloudWatch, ALB, ECR, Route 53 | eu-west-2 (London) | [AWS GDPR DPA](https://aws.amazon.com/compliance/gdpr-center/) | UK data residency | `[CONFIRM]` DPA on file (default AWS terms include it) |
| **Anthropic** (Claude Sonnet 4.5) | Transcript text + structured state for extraction | US | [Anthropic DPA portal](https://privacy.claude.com/en/articles/7996862-how-do-i-view-and-sign-your-data-processing-addendum-dpa) | UK Addendum to EU SCCs (auto-incorporated with Commercial ToS) | **`[ACTION]` Task #2 — NOT ACKNOWLEDGED.** Currently on default API access. |
| **OpenAI** (GPT-5.2 Vision + GPT-5-search-api) | Photos of CCUs, previous certs, handwritten notes; possibly text content | US | [OpenAI DPA](https://openai.com/policies/feb-2024-data-processing-addendum/) | UK Addendum to EU SCCs | **`[ACTION]` Task #2 — NOT SIGNED.** Verify retention tier (default 30 days). |
| **Deepgram** (Nova-3) | Live audio stream containing inspector + incidental homeowner / 3rd-party voices | US (EU endpoint available) | Via Account Executive | UK Addendum to EU SCCs | **`[ACTION]` Task #2 — NOT SIGNED + on default account; `mip_opt_out` not set.** Both fixes in Task #3. |
| **ElevenLabs** | Text strings for TTS prompts (may contain extracted field values like addresses) | US | [ElevenLabs DPA](https://elevenlabs.io/dpa) | UK Extension to EU-US DPF (self-certified) + SCCs | **`[ACTION]` Task #2 — NOT ACCEPTED.** |
| **GitHub Actions** (CI/CD) | Source code only — no customer data | US | Microsoft Products and Services DPA | UK Addendum / DPF | Sufficient (no customer data flow) |
| **Apple TestFlight + App Store Connect** | Tester email, install / crash data | US/global | Apple Developer Program DPA | DPF + SCCs | Confirm Apple Developer agreement is current |
| **Pushover** | Operator notifications only (Derek's own — no customer data) | US | [Pushover privacy](https://pushover.net/privacy) | N/A (no customer data) | Sufficient |
| **AWS Route 53** | DNS records for `certmate.uk` (registrar + DNS) | eu-west-2 (London) | Part of AWS DPA | UK | Covered by AWS |
| **HeyGen** | `[CONFIRM]` — `HEYGEN_API_KEY` exists in `eicr/api-keys` Secrets Manager value. Surfaced 2026-05-11 during cleanup. Active integration, marketing-asset generation, or dormant? | US | [HeyGen DPA](https://www.heygen.com/policies/data-processing-agreement) | UK Addendum / SCCs | `[CONFIRM]` |

### 5.2 Inactive — schema present, not connected

| Vendor | Why on the list | Status |
|---|---|---|
| **Stripe** | `subscriptions` table in DB references `stripe_customer_id`, `stripe_subscription_id`; no live Stripe account connected | Add to list **when activated**. PCI scope assessment then (Stripe Elements → SAQ-A is easiest). |
| **Google Calendar API** | `calendar_tokens` table for OAuth tokens; no plans to use | Drop from facts.md entirely if you decide to delete the schema; otherwise keep here as inactive |
| **SMTP / transactional email** | `src/services/email.js` exists (Nodemailer + SMTP); **no SMTP credentials deployed in production** (Secrets Manager has none; task def has no SMTP env vars). No email is currently sent from production. | Add when SMTP provider is wired (likely AWS SES given existing AWS footprint) |

### 5.3 Removed — confirmed dormant 2026-05-11

| Vendor | Disposition |
|---|---|
| ~~TradeCert~~ | Removed. `TRADECERT_API_KEY` code path deleted from `src/services/secrets.js` (commit `407ceb2`). `TRADECERT_EMAIL` + `TRADECERT_PASSWORD` deleted from `eicr/api-keys` Secrets Manager (version `7403214d-595a-4b5d-bf89-06ceffe14f06`). The `assets/schema/tradecert_csv_headers.json` file was retained — still loaded by the legacy whisper-based extraction path (`process_job.js` → `extractAll`), its name is incidental to the column set it describes. |

## 6. Storage locations & paths

### 6.1 S3 (eu-west-2, bucket `eicr-files-production`)

| Path pattern | Contents | Personal data? |
|---|---|---|
| `jobs/{userId}/{folderName}/photos/{filename}` | CCU, observation, document extraction photos | Yes — property images, GPS via EXIF until `[ACTION]` Task #3 lands |
| `jobs/{userId}/{address}/output/extracted_data.json` | Full job record (homeowner + property + circuits + observations) | Yes — note that the address itself is embedded into the S3 key |
| `jobs/{userId}/{folderName}/output/eicr_certificate.pdf` | Generated certificate | Yes — full homeowner + property + inspector data |
| `settings/{userId}/signatures/{filename}` | Inspector signature PNGs | Yes — inspector |
| `session-analytics/{userId}/{sessionId}/cost_summary.json` | Usage / cost telemetry | Inspector ID only |
| `session-analytics/{userId}/{sessionId}/debug_log.jsonl` | Per-session debug log including transcripts | Yes — transcript may contain names, addresses, incidental voices reported as text |
| `debug/{userId}/{sessionId}/chunk_*` | **Raw audio chunks (PCM/MP4) — debug feature, currently active in prod** | Yes — inspector voice + any incidental third-party voices. `[ACTION]` Task #3 disables in prod or adds 7-day lifecycle. |
| `token_usage.csv` (root) | Aggregated cost log | Inspector ID only |

### 6.2 RDS PostgreSQL (eu-west-2)

| Table | Key columns | Personal data? |
|---|---|---|
| `users` | `id`, `email`, `name`, `company_name`, `role`, `is_active`, `last_login`, `failed_login_attempts`, `locked_until`, `token_version`, `created_at` | Yes |
| `jobs` | `id`, `user_id`, `folder_name`, `certificate_type`, `status`, `address`, `client_name`, `s3_prefix`, `company_id`, plus JSON `job_data` column | Yes — homeowner + property |
| `job_versions` | `id`, `job_id`, `user_id`, `version_number`, `changes_summary`, `data_snapshot` (JSONB), `created_at` | Yes — full snapshot history |
| `clients` | `id`, `user_id`, `name`, `email`, `phone`, `company`, `notes`, `created_at`, `updated_at` | Yes — full CRM record per homeowner |
| `properties` | `id`, `client_id`, `user_id`, `address`, `postcode`, `property_type`, `notes`, `created_at`, `updated_at` | Yes |
| `subscriptions` | `user_id`, `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`, `plan`, `status`, period timestamps | Inactive — no live Stripe data yet |
| `calendar_tokens` | `user_id`, `access_token`, `refresh_token`, `expiry_date`, `scope` | Inactive — Calendar not in use |
| `push_subscriptions` | `user_id`, `endpoint`, `p256dh`, `auth` | Yes — browser push credentials |
| `cert_attestations` (**pending — not yet created**) | `id`, `user_id`, `job_id`, `pdf_s3_key`, `attestation_kind`, `attestation_text_version`, `attested_at`, `recorded_at`, `platform`, `platform_version`, `ip_address`, `user_agent` | Yes — inspector audit-trail rows (no homeowner PII in the row itself; only references to it via `job_id`). `ON DELETE RESTRICT` on `user_id` and `job_id`. Spec: [pdf-issuance-attestations.md](./pdf-issuance-attestations.md) |

No dedicated session table — JWTs are stateless and stored client-side only.

### 6.3 CloudWatch Logs (eu-west-2)

- `/ecs/eicr/eicr-backend` — application logs. Personal data now redacted at the Winston format-chain level (`src/logger.js`, commit `fb20dc0`, 2026-05-11) — `address`, `client_name`, `postcode`, `client_phone`, `client_email` and their camelCase variants are replaced with `[REDACTED]` before reaching CloudWatch. Verified by `src/__tests__/logger.redaction.test.js` (8/8 passing).
- `/ecs/eicr/eicr-pwa` — frontend logs (no application code outputs PII here).
- `/ecs/eicr/eicr-frontend` — legacy log group, empty.
- **Retention is configured at 30 days on all three log groups** — verified 2026-05-11 via `aws logs describe-log-groups`. The retention is set at the log-group level (not in the ECS task definition), so it survives task def re-registration but does NOT auto-apply to any new log group created in future. When adding a new service, set `retentionInDays` on its log group as part of the rollout checklist.

### 6.4 iOS device (local)

| Store | Contents |
|---|---|
| GRDB SQLite | Local job cache (mirrors server data for offline) — includes homeowner records |
| iOS Keychain (`com.certomatic.certmateunified`) | JWT token under key `jwt_token` (via KeychainAccess library) — verified, no UserDefaults token leakage |
| `Application Support/CertMateLogs/*.jsonl` | DebugLogger output — on device only, not synced |

### 6.5 Web (PWA)

| Store | Contents |
|---|---|
| IndexedDB `certmate-cache` | Offline read-through cache of job data |
| IndexedDB outbox | Mutations queue for offline writes |
| `localStorage` `cm_token`, `cm_user` | JWT + user data — **XSS-readable**, HttpOnly migration on roadmap |
| Cookie `token` (SameSite=Lax, **not** HttpOnly) | JWT mirror for middleware expiry check |

## 7. Retention — current state vs target

| Data | Current behaviour | Target retention | Lawful basis for retention |
|---|---|---|---|
| Generated PDF certificates | Indefinite in S3 | **7 years** post-issue | NICEIC scheme (6yr) + safety margin |
| Job records (`extracted_data.json`, RDS `jobs` + `job_versions`) | Indefinite | **7 years** | Same |
| Clients + properties CRM rows | Indefinite | **7 years** post-last-job for that client | Operational continuity within retention window |
| Job photos | Indefinite | **7 years** | Supporting evidence for cert |
| Transcript JSONL (`debug_log.jsonl`) | Indefinite | **30 days** | Operational / debug only — not a regulatory record |
| Raw audio chunks (`debug/.../chunk_*`) | Indefinite (currently active in prod) | **Disabled in prod**, or **7 days** absolute max via S3 Lifecycle | Debug-only — no regulatory value |
| Cost summary JSON | Indefinite | **2 years** | Billing dispute window |
| Inspector signature image | While account active | **Account lifetime + 7 years** | Linked to certs already issued |
| Inspector account data | While account active | **Account lifetime + 7 years** after closure | Linked to issued certs (controller obligation) |
| Application logs (CloudWatch) | Indefinite (not configured) | **30 days** | Operational |
| Crash logs (TestFlight) | Apple default (~90 days) | Apple default | Apple-managed |
| Auth tokens (JWT) | Until expiry | Until expiry | Operational |
| Push subscription credentials | While valid subscription | **Until user revokes or 12 months idle** | Service operation |

## 8. International transfers

| Destination | Mechanism | Status |
|---|---|---|
| AWS eu-west-2 → no transfer | Data stays in UK | ✓ |
| Anthropic (US) | UK Addendum to SCCs in Commercial DPA | `[ACTION]` Task #2 — pending acknowledgement |
| OpenAI (US) | UK Addendum to SCCs in DPA | `[ACTION]` Task #2 — pending signature |
| Deepgram (US) | UK Addendum to SCCs in DPA | `[ACTION]` Task #2 — pending DPA + `mip_opt_out` |
| ElevenLabs (US) | UK Extension to EU-US DPF (self-certified) + SCCs | `[ACTION]` Task #2 — pending acceptance |
| HeyGen (US) | UK Addendum / SCCs | `[CONFIRM]` use + DPA status |
| Apple (US) | DPF + Apple Developer DPA | ✓ |
| GitHub (US) | Microsoft DPA + DPF | ✓ |
| Pushover (US) | Operator-only, no customer data — not a transfer for our purposes | ✓ |

**Re-verify each US sub-processor's DPF / UK Extension certification at `https://www.dataprivacyframework.gov/list` immediately before launching pricing / accepting first paying customer.** Certifications expire annually.

## 9. Data subject rights — process

| Right | How fulfilled (today) | SLA |
|---|---|---|
| Access (SAR) | Email `privacy@` (once mailbox provisioned); manual export from S3 + RDS to ZIP | 1 month (DUAA 2025 stop-the-clock available) |
| Rectification | In-app for inspectors; via inspector for homeowners | 1 month |
| Erasure | Email `privacy@`; deletes RDS row + S3 prefix; logged in erasure register | 1 month, may refuse if NICEIC / regulatory retention obligation applies |
| Portability | Export job data as JSON (PDF + extracted_data.json) | 1 month |
| Objection | Per case | 1 month |
| Restriction | Pause-processing flag on account | 1 month |
| Withdraw consent (for marketing) | Unsubscribe link in every email | Immediate |

`[GAP]` None of these flows are built as self-serve. Phase 5 incident runbook documents the manual playbook. Self-serve `/api/me/export` and `/api/me/delete` endpoints are a future build.

**Volume to date:** Zero. No data subject has made any rights request — confirmed 2026-05-11.

## 10. Inspector-side obligations (passed through DPA to testers)

When CertMate is used by an inspector other than Derek, that inspector becomes controller for their homeowners' data and inherits these obligations under the Beta Tester Agreement:

- Inform the homeowner that an inspection-management app is being used and where the privacy policy is found
- Inform the homeowner that audio dictation may occur — **the door script handles this**
- Notify CertMate of any SAR / erasure request received from a homeowner so we can assist
- Not feed unrelated personal data into CertMate (e.g. don't dictate other customers' details into an inspection)

These become clauses in the Beta Tester Agreement drafted in Phase 4.

## 11. Architectural mitigations (justification for "legitimate interest")

Worth calling out in the Privacy Policy + DPIA — these are the mitigations that justify legitimate-interest balancing for the higher-risk processing:

- **AWS eu-west-2** keeps storage in UK; no transfer issue for data at rest.
- **Audio is not persisted in the production extraction path** — live-streamed to Deepgram, only a 3-second in-memory ring buffer. The `debug/` S3 path is the only persistence and is being closed (`[ACTION]` Task #3).
- **Deepgram `mip_opt_out=true`** (once set by `[ACTION]` Task #3) prevents Deepgram retaining audio for model training.
- **OpenAI + Anthropic API tiers** are contractually non-training by default; tier to be verified.
- **Voice is processed for transcription only**, never for speaker identification (no biometric template generation). Anthropic / OpenAI / Deepgram do not receive a voiceprint.
- **Multi-tier access controls**: JWT auth on every API call, MFA on admin consoles (to be audited per `[ACTION]` Task #5), IAM least-privilege on AWS roles.
- **Audit trail**: `job_versions` table holds full JSONB snapshots per change, supporting SAR + breach investigation.
- **Inspector-only access** by default: every S3 key is `{userId}` scoped; row-level filters in RDS queries; no cross-tenant data leakage path.

## 12. Risk profile — current state

| Factor | Today |
|---|---|
| Number of active inspectors using product | 1 (Derek only) |
| Number of homeowners with data in CertMate | Only Derek's own customers |
| Other electricians who have run real jobs through it | None — TestFlight installs exist but nobody has used it on a real homeowner |
| Marketing emails sent | None |
| Subject access / erasure requests received | None |
| Payments processed | None — Stripe schema exists but not connected |

**This means the processor relationship has not yet activated.** Until tester #2 runs a real job, Derek is simultaneously controller, developer, and inspector for all data in the system. Material to the urgency model: pre-tester-#2 compliance work is gating not for legal-already-happening reasons but for "before the door opens" reasons.

## 13. Critical findings surfaced by code audit (2026-05-11)

These are the items that made the audit a load-bearing exercise rather than a sanity check. All tracked under Task #3 or higher unless noted.

1. **Raw audio is persisted to S3** for debug purposes at `debug/{userId}/{sessionId}/chunk_*` — `src/routes/recording.js:892-906`. Must be env-gated off in prod or capped with a 7-day lifecycle. (`[ACTION]` Task #3)
2. **EXIF metadata including GPS is not stripped** from iOS photo uploads. `Sources/Processing/ImageScaler.swift` preserves all metadata. (`[ACTION]` Task #3)
3. **CloudWatch logs contained raw personal data — FIXED 2026-05-11.** `address`, `client_name`, `postcode` were logged in plaintext from `src/routes/jobs.js`, `src/routes/calendar.js`, etc. Commit `fb20dc0` adds Winston format-chain redaction so the PII never reaches CloudWatch. Log-group retention was already set to 30 days at the AWS log-group level (verified — the original audit missed it because the setting lives outside the task def). The "two-part" framing was wrong on the retention half; only the redaction needed action.
4. **Web auth tokens in `localStorage` + non-HttpOnly cookie** (`web/src/lib/auth.ts:10-87`). XSS-readable. Code comment indicates HttpOnly migration is on the Phase 9 roadmap. **Not a launch-blocker; should be flagged as a residual risk in the DPIA.**
5. **Homeowner phone + email captured via voice** into `installation_details.client_phone` / `client_email`. Must appear in Privacy Policy data inventory.
6. **No SMTP credentials deployed in production.** `src/services/email.js` exists but cannot send. Implies certificate-email delivery is broken / dependent on iOS-local PDF path. When wired up later, the SMTP provider becomes a sub-processor.
7. **Four AI sub-processors with no DPA in place** — Anthropic, OpenAI, Deepgram, ElevenLabs all on default API access. (`[ACTION]` Task #2 — free to fix, blocker for tester #2.)
8. **HeyGen API key exists in production secrets** — purpose unconfirmed. Could be active marketing-asset generation or dormant. `[CONFIRM]` outstanding.

## 14. Open questions remaining

The only outstanding `[CONFIRM]` items as of 2026-05-11:

1. **HeyGen** — what's the `HEYGEN_API_KEY` used for? Active integration (marketing video generation? avatar promo content?) or dormant?
2. **Inspector certification numbers** — does CertMate need to capture NICEIC / NAPIT / Stroma / ELECSA scheme numbers in the future? Not stored today. Adding them would expand the PII surface but may be needed for the cert footer.
3. **Apple Developer agreement** — confirm current and that the Apple Developer DPA is acknowledged.
4. **AWS DPA** — confirm on file (it's part of default AWS Customer Agreement, but worth a one-line check).
5. **Calendar / Stripe** — are the schemas going to be retained for future use or removed? If removed, the `calendar_tokens` and `subscriptions` tables should be dropped via migration.

## 15. Document maintenance

- This file is authoritative. If a downstream doc (Privacy Policy, ROPA, DPIA, Beta Agreement) contradicts it, fix this file first and propagate.
- Re-verify quarterly. Bump `last_verified` in the frontmatter.
- Re-verify after any:
  - New sub-processor added
  - Schema migration touching personal-data tables
  - Storage path change (S3 prefix, RDS column rename)
  - Retention policy change
  - New region or transfer destination
