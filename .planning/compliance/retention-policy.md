---
title: CertMate Data Retention Policy
status: working draft (target state — current state is the "Today" column below)
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: annually + on material change
---

# CertMate Data Retention Policy

## 1. Purpose and scope

This policy defines how long CertMate retains each category of personal data, the reasons for those periods, and how data is deleted at the end of its lifecycle. It satisfies UK GDPR Article 5(1)(e) — the storage-limitation principle — by establishing that personal data is kept "no longer than is necessary" for the purposes set out in the [ROPA](./ropa.md).

It applies to all personal data processed by CertMate, including data held on:

- **AWS S3** in `eu-west-2` (job photos, generated PDFs, signatures, transcripts, telemetry)
- **AWS RDS PostgreSQL** in `eu-west-2` (users, jobs, job_versions, clients, properties, subscriptions, calendar_tokens, push_subscriptions)
- **AWS CloudWatch Logs** (operational + application logs)
- **AWS Secrets Manager** (out of scope — credentials only, no data subject data)
- **iOS device storage** (GRDB SQLite, Keychain, app sandbox debug logs — these mirror server data and are governed by the server-side retention)
- **Web client storage** (IndexedDB cache, localStorage — same: mirror data, governed by server side)

Out of scope: data held by sub-processors (Anthropic, OpenAI, Deepgram, ElevenLabs, Apple, etc.), which is governed by their own retention policies and the DPAs signed with each.

## 2. Retention schedule

| # | Data category | Today (current state) | Target retention | Trigger for deletion | Lawful basis for retention | Source |
|---|---|---|---|---|---|---|
| R1 | Generated EICR / EIC PDFs | Indefinite in S3 | **7 years post-issue** | Automated S3 Lifecycle policy on `jobs/{userId}/{folderName}/output/eicr_certificate.pdf` | NICEIC scheme requires 6yr minimum retention; 7yr is safety margin | [facts.md §7](./facts.md) |
| R2 | Job records (RDS `jobs`, `job_versions`; S3 `extracted_data.json`) | Indefinite | **7 years post-job-closure** | Scheduled job that purges `jobs` rows + their `job_versions` + S3 prefix after 7y | Same as R1 (the data underlies R1) | facts.md §7 |
| R3 | Property photos (CCU, observations, documents) — S3 `jobs/{userId}/{folderName}/photos/` | Indefinite | **7 years post-job-closure** | Same S3 Lifecycle rule as R1 (whole folder TTL) | Supporting evidence for the cert | facts.md §7 |
| R4 | Homeowner CRM rows (RDS `clients`, `properties`) | Indefinite | **7 years after the last associated job for that client** | Scheduled job that walks `clients` → `jobs(client_id)` and purges any client with no job within 7y | Operational continuity within retention window; aligns with R1 | facts.md §7 |
| R5 | Transcript JSONL (`session-analytics/{userId}/{sessionId}/debug_log.jsonl`) | Indefinite | **30 days** | S3 Lifecycle rule on `session-analytics/*/debug_log.jsonl` | Operational / debug only — not a regulatory record | facts.md §7 |
| R6 | Raw audio chunks (`debug/{userId}/{sessionId}/chunk_*`) | Indefinite | **Disabled in production**; if temporarily enabled for debugging, **7-day absolute maximum** | Env flag gating production write + S3 Lifecycle on `debug/` prefix as belt-and-braces | Debug-only — no regulatory value; high risk because audio of incidental third parties is captured | facts.md §7, §13 finding #1 |
| R7 | Cost / usage telemetry (`session-analytics/{userId}/{sessionId}/cost_summary.json`) | Indefinite | **2 years** | S3 Lifecycle rule on `session-analytics/*/cost_summary.json` | Billing dispute window |
| R8 | Inspector signature image (S3 `settings/{userId}/signatures/`) | While account active | **Account lifetime + 7 years post-closure** | Triggered on account closure: signature retained but flagged "account closed"; deleted at +7y | Linked to certs already issued under that signature |
| R9 | Inspector account data (RDS `users`) | While account active | **Account lifetime + 7 years post-closure** | Manual deletion at +7y; row not anonymised because audit trail (`job_versions.user_id`) refers to it for compliance | Linked to certs issued under that account (controller obligation) |
| R10 | CloudWatch application logs (`/ecs/eicr/eicr-backend`, `/ecs/eicr/eicr-pwa`, `/ecs/eicr/eicr-frontend`) | **30 days (already set at the log-group level, verified 2026-05-11)** | **30 days** | Log group `retentionInDays: 30` set via AWS console / `aws logs put-retention-policy` | Operational and security monitoring |
| R11 | Crash logs (TestFlight / App Store Connect) | Apple default ~90 days | Apple default | Apple-managed | Service quality |
| R12 | JWT auth tokens | Until expiry | Until expiry | Stateless — server side has no record | Operational |
| R13 | Push subscription credentials (RDS `push_subscriptions`) | While valid | **Until user revokes OR 12-month idle** | Periodic scan for subscriptions with no successful delivery in 12 months | Service operation |
| R14 | Marketing email subscriber list (when activated) | Not yet collected | **Until unsubscribe**; opt-in proof retained 2 years post-unsubscribe | Unsubscribe link in every email | PECR proof of consent |

> **All "Today" entries marked indefinite become the target retention via compliance Task #3** (technical fixes) and the routine deletion job described in §4.

## 3. Lifecycle implementation

Deletion is implemented via four mechanisms, in order of preference:

### 3.1 S3 Lifecycle rules

Used for time-based bulk expiry of S3 objects. Configured in AWS Console / Terraform on the `eicr-files-production` bucket:

| Prefix | Lifecycle rule | Maps to |
|---|---|---|
| `session-analytics/*/debug_log.jsonl` | Expire 30 days after creation | R5 |
| `debug/*` | Expire 7 days after creation | R6 |
| `session-analytics/*/cost_summary.json` | Expire 2 years after creation | R7 |
| `jobs/*` | Expire 7 years after creation | R1, R2, R3 (collective) |
| `settings/*/signatures/*` | No lifecycle rule — manual deletion on account closure +7y | R8 |

### 3.2 CloudWatch retention

Set at the log-group level (NOT in the ECS task definition — the awslogs driver doesn't carry retention). The three live log groups (`/ecs/eicr/eicr-backend`, `/ecs/eicr/eicr-pwa`, `/ecs/eicr/eicr-frontend`) are at 30 days, verified 2026-05-11 via `aws logs describe-log-groups`. Operational note: when adding a new service (= new log group), set `retentionInDays` via `aws logs put-retention-policy --log-group-name <name> --retention-in-days 30 --region eu-west-2` as part of the deployment checklist. Maps to R10.

### 3.3 Scheduled deletion job

For RDS rows that need conditional retention (e.g. R4 "7 years after the last associated job"), a Node.js scheduled job runs nightly and:

1. Queries for rows whose retention trigger has elapsed
2. Deletes the row + cascades to dependent rows (`ON DELETE` constraints)
3. Logs the deletion in an internal deletion register

`[GAP]` This job is not built yet. To be implemented in a future phase.

### 3.4 Manual deletion (subject-rights-driven)

For erasure requests (UK GDPR Art. 17) that arrive within the retention window, the SAR / erasure playbook (Phase 5 — compliance Task #9) describes the manual process: identify all S3 prefixes + RDS rows, delete, log in erasure register. Refusal grounds (NICEIC retention obligation, legal claims) are documented per case.

## 4. Triggers that extend retention

The retention periods in §2 are **defaults**. Retention may be extended where:

- **Legal hold**: ongoing or anticipated litigation, regulatory investigation, or ICO enquiry. Hold is recorded in writing by Derek and reviewed quarterly until released.
- **Insurance claim**: open professional indemnity or cyber liability claim referencing specific data.
- **Open complaint or dispute**: customer or homeowner complaint where the underlying data is evidentially relevant.
- **Active subject-rights request**: data subject of a SAR / objection / restriction request — retention paused until response is delivered and the appeal window has closed.

Extensions are logged and reviewed quarterly.

## 5. Inspector-side data (B as controller)

Once the processor relationship activates (tester #2 onboards), inspector-customers are controllers for their homeowner data and are bound by the retention terms expressed in the Beta Tester Agreement / Subscription Agreement. Operational reality:

- **CertMate enforces a minimum 7-year retention** for certificate-related data (PDF, job record, photos) — inspectors cannot request earlier deletion of their own data within that window because of the NICEIC 6-year scheme obligation that they themselves are subject to.
- **CertMate supports immediate erasure** for data outside that obligation (CRM contact rows where no certificate has been issued, draft jobs that were never finalised, transcripts older than the 30-day operational window).
- **Homeowner erasure requests** routed through the inspector-customer are subject to the same minimum window with documented refusal grounds.

## 6. Right of erasure interaction

UK GDPR Art. 17 grants data subjects the right to erasure with six grounds for refusal. CertMate may refuse erasure where:

- The data is necessary for **compliance with a legal obligation** to which CertMate or the inspector-customer is subject (NICEIC scheme retention; Building Regulations / Part P record-keeping; Trading Standards / consumer-rights record obligations).
- The data is necessary for the **establishment, exercise, or defence of legal claims** (open complaint, insurance claim, ICO enquiry).

Refusals are responded to within one month, in writing, with grounds stated and an explanation of the data subject's right to complain to the ICO.

## 7. Sub-processor retention

Each sub-processor operates its own retention against its DPA. CertMate is responsible for:

- Verifying sub-processor retention policies meet UK GDPR requirements at onboarding
- Ensuring sub-processors delete or return data on termination
- Documenting sub-processor retention in the [ROPA](./ropa.md) per-activity rows

Key sub-processor configurations:

- **Deepgram**: `mip_opt_out=true` set on every WebSocket URL → zero retention for audio
- **OpenAI**: verify API retention tier (default 30 days; Enterprise ZDR is a separate contract)
- **Anthropic**: Commercial Terms default is non-training, non-retained beyond operational logs
- **ElevenLabs**: enable Zero Retention Mode if available on plan tier

`[ACTION]` Each of the above is tracked under compliance Task #2 (DPA signature) and Task #3 (`mip_opt_out`).

## 8. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Data Protection Lead (Derek Beckley) | Owns this policy. Reviews annually. Approves lifecycle rule changes. Reviews legal-hold extensions quarterly. |
| Outsourced DP consultant (when retained — Task #5 in compliance plan) | Quarterly review of policy currency vs sub-processor changes. Sign-off on retention exceptions. |
| Backend on-call (when team grows) | Operates the scheduled deletion job. Investigates retention violations surfaced by monitoring. |

## 9. Monitoring and audit

- **S3 Lifecycle rule changes**: tracked in Terraform / AWS Console history.
- **CloudWatch retention changes**: tracked in `ecs/task-def-backend.json` git history.
- **Manual deletions** (subject-rights or legal-hold-release): logged in the erasure register (`[GAP]` to be created under Task #9).
- **Scheduled deletion job output**: writes a daily report to CloudWatch and an internal counter to confirm it ran.

## 10. Review history

| Date | Reviewer | Material change |
|---|---|---|
| 2026-05-11 | Derek Beckley | Initial draft. Captures current state ("indefinite for most") and target state. |

## 11. Outstanding items

This policy is **publishable as-is** but the actual retention behaviour will only match the policy once:

1. S3 Lifecycle rules per §3.1 are deployed (compliance Task #3)
2. CloudWatch `retentionInDays` is set per §3.2 (compliance Task #3)
3. The scheduled deletion job per §3.3 is built (future phase — gating: first row that needs conditional deletion)
4. The erasure register per §9 is created (compliance Task #9)
5. The SAR / erasure playbook per §3.4 is drafted (compliance Task #9)

Until items 1–2 ship, the actual retention is "indefinite for most categories" and the policy is aspirational. Closing the gap is the highest-priority work item in the compliance plan.
