---
title: CertMate Subject Access Request + Erasure Playbook
status: working draft — first real request will surface gaps; iterate
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: after every real request + at least annually
visibility: internal — not published publicly
related: ./privacy-policy.md ./retention-policy.md ./registers/erasure-register.md
---

# Subject Access Request + Erasure Playbook

This is the operational playbook for handling requests from data subjects who want to exercise their UK GDPR rights — access, rectification, erasure, portability, objection, restriction, and automated-decision-related rights. It is internal — never publish it.

This playbook covers the **manual** process. A future engineering phase will build self-serve endpoints (`/api/me/export`, `/api/me/delete`) once volume justifies the investment. Until then, the manual process is how we hit the one-month statutory deadline.

## 1. Rights covered

| Right | UK GDPR Art. | What it means in CertMate context |
|---|---|---|
| Access (SAR) | 15 | Provide a copy of personal data we hold about the subject |
| Rectification | 16 | Correct inaccurate or incomplete data |
| Erasure | 17 | Delete data, subject to retention exceptions |
| Restriction | 18 | Pause processing while a query is resolved |
| Portability | 20 | Provide data in a machine-readable format |
| Objection | 21 | Stop legitimate-interest processing |
| Automated decisions | 22 | Not applicable — CertMate makes no Art. 22 automated decisions |

The same process applies to all of them. The differences are in the action taken at the end.

## 2. Statutory clock

- **One month** from the day after receipt to substantively respond.
- **Extendable by two further months** if the request is "complex or numerous" — must notify the subject of the extension within the original month and explain why.
- **Stop-the-clock** under the Data (Use and Access) Act 2025: if you need clarification before you can answer, the clock pauses from when you ask the question until you receive the reply.

Diary every active request. The clock is unforgiving.

## 3. Receipt and triage

### 3.1 Inbound routes

All requests must be routed to `privacy@certmate.uk`. Subjects who first contact via support, sales, or another channel should be redirected to that mailbox with a single response:

> *"Thanks for your message — to make sure your data-protection request is handled correctly, please send it to `privacy@certmate.uk`. The team there will respond within one month."*

If someone insists or refuses to redirect, accept the request via the channel it arrived on and forward to `privacy@` yourself — the obligation is to respond to a request received in any form, not only via the prescribed mailbox.

### 3.2 First-day triage checklist

Within 24 hours of receipt:

1. **Open a row in the [Erasure Register](./registers/erasure-register.md)** (yes, the register is named for erasure but it logs every rights-related request — keeps the audit trail in one place).
2. **Classify**: which right (or rights) is the subject exercising?
3. **Identify**: who is the subject? Inspector account holder, homeowner whose data flowed through CertMate, third party from a previous certificate, or someone the system doesn't know?
4. **Acknowledge**: send the acknowledgement template in §6.1 within 5 working days.

## 4. Identity verification

You must verify identity before responding to a SAR or executing a deletion. Two reasons: (a) you cannot send personal data to someone who isn't entitled to it; (b) erasing the wrong person's data is itself a personal-data breach.

### 4.1 Inspector account holder

- The request comes from the email address registered on the account → identity verified by access to the email account. Accept.
- The request comes from a different email but claims to be the same inspector → ask them to send a follow-up from the registered account, or to verify recent account activity (last job address, last login date) that an outsider could not know.

### 4.2 Homeowner whose data is in CertMate via an inspector

- Ask the homeowner to provide enough information to find their record: full property address, postcode, approximate date of inspection, and the name of the electrician who inspected.
- Confirm the existence of a matching record before going further (but **do not confirm the data content yet**).
- If verification is ambiguous, ask the homeowner to forward correspondence from the electrician about the inspection, or to confirm details that only the homeowner of that address would know.
- If you cannot reasonably verify identity within the one-month window, refuse the request and explain why (see §7.3). This is a legitimate refusal ground.

### 4.3 Third party from a previous-certificate scan

Same as 4.2 — extra care because the relationship to the data is more attenuated.

## 5. Search procedure — locating the data

The manual search lives in three systems: RDS, S3, and (for completeness) iOS Keychain / local storage on the user's own device (which is out of CertMate's reach anyway).

### 5.1 Inspector account holder

```sql
-- Connect to RDS using the credentials in eicr/database secret
-- (psql command pulled from compliance/incident-response-runbook.md if needed)

SELECT id, email, name, company_name, role, created_at, last_login
FROM users WHERE email = '<requester-email>';

-- Then for every related table:
SELECT id, folder_name, certificate_type, status, address, client_name, created_at
FROM jobs WHERE user_id = '<user-id>'
ORDER BY created_at DESC;

SELECT version_number, changes_summary, created_at
FROM job_versions WHERE user_id = '<user-id>'
ORDER BY created_at DESC LIMIT 50;  -- limit to recent versions; full export via JSONB

SELECT id, name, email, phone, company, notes, created_at
FROM clients WHERE user_id = '<user-id>';

SELECT id, client_id, address, postcode, property_type, notes
FROM properties WHERE user_id = '<user-id>';

SELECT id, stripe_customer_id, stripe_subscription_id, plan, status,
       current_period_start, current_period_end
FROM subscriptions WHERE user_id = '<user-id>';

SELECT id, scope, created_at
FROM calendar_tokens WHERE user_id = '<user-id>';

SELECT id, endpoint, created_at
FROM push_subscriptions WHERE user_id = '<user-id>';

SELECT id, agreement_kind, agreement_version, accepted_at, platform, ip_address
FROM account_consents WHERE user_id = '<user-id>';  -- once consent table exists
```

```bash
# S3 — list every object under the user's prefix
aws s3 ls "s3://eicr-files-production/jobs/<user-id>/" --recursive --region eu-west-2 > /tmp/sar-<user-id>-jobs.txt
aws s3 ls "s3://eicr-files-production/settings/<user-id>/" --recursive --region eu-west-2 > /tmp/sar-<user-id>-settings.txt
aws s3 ls "s3://eicr-files-production/session-analytics/<user-id>/" --recursive --region eu-west-2 > /tmp/sar-<user-id>-analytics.txt
```

### 5.2 Homeowner

The homeowner's data lives in the inspector's user-scoped prefix. So the search is "find the inspector(s) whose data contains this homeowner".

```sql
-- Try clients table first (CRM — most reliable structured data)
SELECT user_id, id, name, email, phone, company
FROM clients
WHERE LOWER(name) ILIKE '%<surname>%' AND LOWER(notes) ILIKE '%<postcode-prefix>%';

-- Then jobs (less structured)
SELECT user_id, id, folder_name, address, client_name, created_at
FROM jobs
WHERE LOWER(client_name) ILIKE '%<surname>%' OR LOWER(address) ILIKE '%<postcode>%';

-- Then properties
SELECT user_id, id, address, postcode
FROM properties
WHERE LOWER(address) ILIKE '%<postcode>%';
```

Pull every `job_versions` snapshot that references the matching jobs:

```sql
SELECT id, job_id, version_number, data_snapshot, created_at
FROM job_versions
WHERE job_id IN (<matching-job-ids>)
ORDER BY job_id, version_number;
```

And the S3 photos / PDF / extracted_data.json for each matching job:

```bash
aws s3 ls "s3://eicr-files-production/jobs/<user-id>/<folder-name>/" --recursive --region eu-west-2
```

### 5.3 Sub-processors

For a complete SAR response you have an obligation to identify what each sub-processor has. In practice this is bounded:

- **Anthropic**: only sees transcripts during the API call; non-retaining tier.
- **OpenAI**: only sees photos + document text during the API call; default 30-day API logs.
- **Deepgram**: live audio stream only; `mip_opt_out=true` means no model-training retention.
- **ElevenLabs**: text prompts only during TTS calls.

Where a subject asks for "everything sub-processors hold about me", respond that under the API tiers we use, sub-processors do not persistently hold personal data identifiable to the subject — the calls are transient. Provide the sub-processor list URL ([certmate.uk/legal/sub-processors](./sub-processors.md)) so they can verify.

## 6. Response templates

### 6.1 Acknowledgement (send within 5 working days of receipt)

> Subject: **Your data-protection request — receipt confirmation**
>
> Dear [name],
>
> Thank you for your message of [date]. I am confirming that we have received your request and treating it as a [Subject Access Request / Erasure Request / etc.] under the UK General Data Protection Regulation.
>
> Our deadline to respond substantively is **[receipt date + 1 month]**.
>
> Before we can complete your request we need to confirm your identity. [Insert the verification ask from §4.] Once we have your reply the response clock pauses until we hear back from you.
>
> If you have any questions in the meantime, this address (`privacy@certmate.uk`) is the right route.
>
> Derek Beckley
> Data Protection Lead, Beckley Electrical Ltd t/a CertMate

### 6.2 SAR fulfilment (within 1 month, post-verification)

Attach: a ZIP file containing all retrieved data in a portable format (JSON for structured data + the PDFs / photo files in their original format). Write a one-page covering email:

> Subject: **Your Subject Access Request — response**
>
> Dear [name],
>
> Please find attached the data we hold about you on CertMate as of [date]. The attached ZIP contains:
>
> - `account-data.json` — your account, profile, job history, and CRM records held in CertMate's database
> - `versions.json` — the historical-snapshot record of every change to jobs in your portfolio
> - `signatures/` — image files of your signature
> - `jobs/` — for each job, the extracted certificate data (`extracted_data.json`), the generated PDF, and any photographs taken during inspection
> - `consent-log.json` — your record of Beta Tester Agreement acceptance(s)
>
> Some categories of data we hold are not included or are summarised:
>
> - **Operational logs** — these are kept for 30 days and contain technical telemetry only; personal-data fields are automatically redacted at write-time so there is no per-user export available from them.
> - **Sub-processor data** — the AI services we use (listed at certmate.uk/legal/sub-processors) process your data transiently during API calls and do not retain identifiable copies. If you wish to make a separate request to any sub-processor, their contact details are on that page.
>
> Your rights:
>
> - If anything in the data is inaccurate, you have the right to ask for it to be corrected (Art. 16). Reply to this email with the correction.
> - You have the right to ask for your data to be erased (Art. 17), subject to the retention obligations described in our [Privacy Policy](https://certmate.uk/privacy).
> - You have the right to object to processing carried out on legitimate-interest grounds (Art. 21).
> - You have the right to complain to the UK Information Commissioner's Office at any time: [ico.org.uk/concerns](https://ico.org.uk/concerns/).
>
> [signature]

### 6.3 Erasure fulfilment

If the erasure can be completed in full:

> Subject: **Your erasure request — completed**
>
> Dear [name],
>
> I'm writing to confirm that, as you requested, we have erased the personal data we held about you on CertMate. The erasure was completed on [date].
>
> Items erased:
>
> [Bullet list of what was deleted — typically: account row, related job rows, related job_versions, related client and property rows, S3 prefix `jobs/{userId}`, S3 prefix `settings/{userId}`, S3 prefix `session-analytics/{userId}`, consent log]
>
> Items NOT erased and the reason:
>
> [Most commonly: any cert PDF older than [insert NICEIC retention cutoff date] — we are required to retain finalised certificates for 6 years (NICEIC scheme rules) plus a 1-year safety margin. The retained certificates are no longer linked to your account; they sit in a regulatory archive that is not accessible from the main service.]
>
> You can request a copy of any retained item at any time by writing to `privacy@certmate.uk`.
>
> Your rights:
>
> - You have the right to complain to the UK Information Commissioner's Office at any time: [ico.org.uk/concerns](https://ico.org.uk/concerns/).
>
> [signature]

### 6.4 Refusal (within 1 month)

> Subject: **Your [SAR / erasure request] — response**
>
> Dear [name],
>
> Thank you for your request of [date]. After consideration we are unable to comply with it in full for the following reasons:
>
> [Refusal grounds — see §7 below. Be specific and link to the relevant UK GDPR article.]
>
> If you wish to challenge this decision, you have the right to:
>
> - Complain to the UK Information Commissioner's Office: [ico.org.uk/concerns](https://ico.org.uk/concerns/) — 0303 123 1113.
> - Seek a judicial remedy via the courts.
>
> [signature]

## 7. Refusal grounds — when you can lawfully say no

A refusal must be in writing, within the one-month window, with reasons stated and the data subject's right to complain spelled out.

### 7.1 Erasure refused because of regulatory retention

UK GDPR Art. 17(3)(b) — we are entitled to refuse erasure where retention is required for compliance with a legal obligation. For CertMate, the load-bearing example is the NICEIC scheme's 6-year minimum retention of issued certificates. Cite the retention period and the source (scheme rules) in the refusal.

### 7.2 Manifestly unfounded or excessive

UK GDPR Art. 12(5)(b) — we may refuse to act on a request that is "manifestly unfounded or excessive, in particular because of its repetitive character." Use sparingly and document the reasoning. A second request within a short window for unchanged data may qualify; a single request that is just inconvenient does not.

### 7.3 Identity not verified

If after reasonable steps you cannot verify the requester's identity, you may refuse. Document what steps you took. UK GDPR Art. 12(6) supports requesting additional information.

### 7.4 Legal claim hold

UK GDPR Art. 17(3)(e) — retention is permitted where the data is necessary for the establishment, exercise, or defence of legal claims. Applicable if an open complaint, insurance claim, or litigation references the specific data.

## 8. Restriction (Art. 18)

A request for restriction pauses processing while a query is resolved. Operationalise by setting `users.is_active = false` (for an inspector) or by tagging the relevant `clients` / `jobs` rows with a `restriction_until` field (`[GAP]` — not currently a schema feature; for now, hand-document in the Erasure Register).

Restriction is reversible — when the underlying query is resolved, processing resumes.

## 9. Logging

Every request, response, and refusal must be recorded in [Erasure Register](./registers/erasure-register.md). Minimum fields:

- Date received
- Channel of receipt
- Subject (verified identity)
- Right exercised
- Statutory deadline
- Date response sent
- Outcome (fulfilled / partially fulfilled / refused — with grounds)
- Diary date for any follow-up

The register itself is personal data and is retained for as long as the underlying processing record (typically 7 years, in line with the [Retention Policy](./retention-policy.md)).

## 10. Outstanding setup work

- Provision `privacy@certmate.uk` mailbox (also gated by Incident Response Runbook).
- Build / dry-run an export script that produces the ZIP described in §6.2 from a given `<user-id>` — currently every step is manual. A 50-line bash script wrapping the SQL + S3 commands would replace 4 hours of manual work per request with 5 minutes.
- Add the [Erasure Register](./registers/erasure-register.md) as an empty template file (next commit in this Phase 5 batch).
- Schedule a tabletop run-through of a fabricated SAR within 30 days of the first non-Derek inspector signing the Beta Tester Agreement. Use the test scenario "homeowner emails asking for everything CertMate holds on them, from a job 4 months ago".
