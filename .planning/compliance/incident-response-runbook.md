---
title: CertMate Incident Response Runbook
status: working draft — test via tabletop exercise before relying on it under pressure
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: annually + after every real incident + after every tabletop exercise
visibility: internal — not published publicly
related: ./facts.md ./dpia-voice-extraction-pipeline.md ./beta-tester-agreement.md
---

# Incident Response Runbook

This runbook is the **operational playbook** for detecting, classifying, containing, investigating, and reporting any incident affecting personal data or the security of the CertMate service. It is internal — never publish it.

The goal of this document is to make incident response a sequence of pre-decided steps, so that when an incident actually happens the operator (you) is not also trying to invent the response plan in real time.

## 1. What counts as an incident

For the purposes of this runbook, treat any of the following as an **incident** and run the steps below:

| Indicator | Examples |
|---|---|
| **Confirmed personal-data breach** | An attacker accessed RDS or S3; an export was leaked publicly; an inspector reports unauthorised access to their account |
| **Suspected personal-data breach** | Unexplained spike in CloudWatch errors, anomalous IAM activity, an inspector reports their device was stolen |
| **Service compromise** | Production credentials rotated unexpectedly, unfamiliar code or container deployed, RDS unreachable for reasons that aren't a known maintenance event |
| **Sub-processor incident** | Anthropic / OpenAI / Deepgram / ElevenLabs / AWS reports a breach affecting their service |
| **Regulatory contact** | An email or letter from the ICO, Action Fraud, or any scheme provider asking about a specific event |
| **Customer complaint about privacy** | A homeowner or inspector emails saying their data is "in the wrong hands" or similar |

When in doubt, **run the steps** — it is cheaper to over-react and stand down than to under-react and miss the ICO 72-hour window.

## 2. Severity classification

Classify the incident within the **first 15 minutes** of starting the runbook. The classification determines the notification timeline.

| Severity | Definition | Notification |
|---|---|---|
| **P1 — Critical** | Confirmed breach affecting personal data with a likely high risk to data subjects. Examples: leaked S3 export, RDS dump exfiltration, unauthorised access to homeowner data for more than one inspector. | Inspector-customer (Controller): within 24 hours. ICO: within 72 hours. Data subjects: where high risk, "without undue delay" (typically within 72 hours). |
| **P2 — Significant** | Confirmed or strongly suspected breach with low-to-medium risk to data subjects. Examples: a single inspector's account compromised but acted on quickly with no exfiltration evidence; a sub-processor reports a minor incident affecting our scope. | Controller: within 24 hours. ICO: assess against the "likely to result in a risk" threshold — if yes, within 72 hours; if no, log internally only. |
| **P3 — Investigation needed** | Suspicious activity that may turn out to be benign. | No external notification until escalated to P1 / P2. Log everything internally. |
| **P4 — Non-incident** | False alarm after investigation. | Close the ticket in the breach register with the reason. |

## 3. The 60-minute response sequence

The first hour is the most important. Follow the steps in order; don't try to do them in parallel until step 9.

### Minute 0–5 — **Detect and acknowledge**

1. Open an entry in [`registers/breach-register.md`](./registers/breach-register.md) with: timestamp (UTC), source of report, one-sentence description, your name, severity (use "P3" pending classification).
2. Start a timer. The 72-hour ICO clock starts from "when you become aware" — that's now.

### Minute 5–15 — **Classify**

3. Read whatever evidence you have. Decide P1 / P2 / P3.
4. Update the breach register entry with the classification.
5. If P1 or P2, immediately:
   - Email yourself a copy of all the evidence so it is preserved outside any system that might itself be compromised.
   - Note in the register the **scope** as best understood: (a) which inspectors / homeowners affected, (b) what data category, (c) what time window.

### Minute 5–15 — **Evidence questions to the reporter (if the report came from a human)**

If the incident was self-reported by an inspector or homeowner, your **first reply** should ask the questions that will drive the classification call. Send before the 30-min mark; don't wait for answers before starting containment.

**For device loss / theft:**
1. Was the device passcode/biometric locked at the time of loss?
2. When did you last log in to CertMate on the device? (We issue 30-day session tokens.)
3. Have you (a) reported the theft to police, (b) signed out of your Apple ID via Find My iPhone, (c) initiated a remote wipe?
4. Approximately how many real jobs did you run on that device, and what was the most recent date?

**For suspected account compromise (phishing, shared password, etc.):**
1. When and how did you become suspicious?
2. Have you changed your CertMate password from a different device?
3. Have you used the same password anywhere else? (If yes, change those too.)
4. List any unfamiliar activity you can see in the app (jobs you don't recognise, settings changes, etc.).

### Minute 15–30 — **Contain**

The order is **stop the bleeding first, investigate second**.

6. **If credentials may be compromised**, immediately rotate:
   - JWT signing secret in AWS Secrets Manager (forces all current sessions to invalidate)
   - Sub-processor API keys (Anthropic, OpenAI, Deepgram, ElevenLabs) in AWS Secrets Manager
   - AWS IAM access keys if any are suspect
   - Database password (`eicr/database` secret) — requires backend rollout to pick up

7. **If specific inspector accounts may be compromised**, set `users.is_active = false` for those accounts via the admin tool (or directly via psql if necessary). This locks them out without deleting data — reversible once the situation is understood.

8. **If a public artefact has leaked** (e.g. an S3 object was set public by mistake), revoke public access immediately:
   ```bash
   aws s3api put-object-acl --bucket eicr-files-production --key <key> --acl private --region eu-west-2
   ```
   Then check the bucket-level public-access-block setting.

### Minute 30–60 — **Investigate and decide on notification**

9. Parallel investigation. Decide who to notify and when, based on the classification.

10. **For P1 / P2 incidents, draft the Controller-notification email now.** Use the template in §5. Do not send yet; review it once before the 24-hour deadline.

11. **For P1 incidents, decide whether ICO notification is required.** If yes, draft the ICO submission using the template in §6. Do not send yet; review once before the 72-hour deadline.

## 4. Containment toolkit — exact commands

Keep these in your head or pinned at your desk.

> **WARNING — JWT rotation is global.** Rotating `JWT_SECRET` logs out **every** active inspector, not just the suspected-compromised one. For a single-user beta this is acceptable. As the tester base grows, prefer account-specific lock (cmd 2) and reserve JWT rotation for incidents where the signing key itself is suspected leaked.

```bash
# Set CWD if not already there
cd /Users/derekbeckley/Developer/EICR_Automation

# 1. Rotate JWT secret (forces EVERY session — all inspectors — to log out on next request)
NEW_JWT=$(openssl rand -base64 64)
aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text | \
  python3 -c "import json,sys; d=json.loads(sys.stdin.read()); d['JWT_SECRET']='$NEW_JWT'; print(json.dumps(d))" | \
  aws secretsmanager put-secret-value --secret-id eicr/api-keys --region eu-west-2 --secret-string file:///dev/stdin
# Then force-new-deployment on ECS so the running tasks pick up the new secret
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2

# 2. Lock a specific inspector account (preferred for single-account compromise)
# Fetch DB creds and open a one-shot psql session:
DB_CREDS=$(aws secretsmanager get-secret-value --secret-id eicr/database --region eu-west-2 --query SecretString --output text)
DB_HOST=$(echo "$DB_CREDS" | python3 -c "import json,sys;print(json.loads(sys.stdin.read())['host'])")
DB_USER=$(echo "$DB_CREDS" | python3 -c "import json,sys;print(json.loads(sys.stdin.read())['username'])")
DB_PASS=$(echo "$DB_CREDS" | python3 -c "import json,sys;print(json.loads(sys.stdin.read())['password'])")
DB_NAME=$(echo "$DB_CREDS" | python3 -c "import json,sys;print(json.loads(sys.stdin.read())['dbname'])")
PGPASSWORD="$DB_PASS" psql "sslmode=require host=$DB_HOST user=$DB_USER dbname=$DB_NAME" \
  -c "UPDATE users SET is_active = false, locked_until = NOW() + INTERVAL '30 days' WHERE id = '<user-id>';"
# Reverse: same query with is_active = true, locked_until = NULL.

# 3. Revoke a single sub-processor key (example: Anthropic — replace key in console + here)
aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text | \
  python3 -c "import json,sys; d=json.loads(sys.stdin.read()); d['ANTHROPIC_API_KEY']='REVOKED'; print(json.dumps(d))" | \
  aws secretsmanager put-secret-value --secret-id eicr/api-keys --region eu-west-2 --secret-string file:///dev/stdin
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2

# 4. Take the backend offline (extreme — only if active exfiltration in progress)
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --desired-count 0 --region eu-west-2
# Reverse:
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --desired-count 1 --region eu-west-2

# 5. Snapshot RDS to preserve evidence
aws rds create-db-snapshot --db-instance-identifier eicr-db-production --db-snapshot-identifier incident-<YYYYMMDD-HHMM> --region eu-west-2

# 6. Pull recent CloudWatch logs for evidence
#    Adjust --since to cover the FULL window from time-of-incident to now.
#    Device-loss reports often arrive next-morning, so --since 24h is the safer default.
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 24h --format short > /tmp/incident-backend-logs.txt
aws logs tail /ecs/eicr/eicr-pwa --region eu-west-2 --since 24h --format short > /tmp/incident-pwa-logs.txt

# 7. Scope CloudWatch logs to a specific user (Logs Insights — adjust time range in console or via --start-time / --end-time)
aws logs start-query --region eu-west-2 \
  --log-group-name /ecs/eicr/eicr-backend \
  --start-time $(date -u -v-24H +%s) --end-time $(date -u +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /<user-id-or-email>/ | sort @timestamp desc | limit 500'
# Then fetch results with: aws logs get-query-results --query-id <id-from-above> --region eu-west-2
```

Keep the output of every containment command. It is part of the incident record.

## 4.1 Device-side actions — delegated to the affected user

We cannot do these for the inspector; they own the Apple ID. Send the list as part of the first reply for any device-loss / theft / suspected-account-compromise report:

1. **Remote-wipe via Find My iPhone / Find My iPad** — https://support.apple.com/en-gb/HT201472 — erases CertMate's cached job data, transcripts, and photos on the device.
2. **Sign out of Apple ID remotely** — Settings → Apple ID → Find My → Mark As Lost (also locks Activation Lock so the device can't be re-set-up without the Apple ID password).
3. **Report the theft to the police** for an incident reference number. Required if the inspector intends to claim on their own home/business insurance and useful evidence in our breach register.

A separate `is_active = false` lock from our side (toolkit cmd 2) is independent of and complementary to the above. The device may be wiped but the JWT in the wiped device's keychain could still be valid until our token-revoke takes effect — close that loop first.

## 5. Controller notification (24-hour deadline) — email template

Send from `privacy@certmate.uk` to the affected inspector-customer(s).

> **If the Controller is also the reporter** (i.e. the inspector emailed us first to say their device was stolen or account compromised), use the short variant in §5.1 instead of the formal template below. The formal template assumes the Controller is hearing about the incident from us for the first time; using it on a self-reporter reads as process-theatre.

> Subject: **CertMate — personal-data incident notification — action may be required**
>
> Hi [name],
>
> I am writing to notify you, in our capacity as a Processor under our Beta Tester Agreement, of a personal-data incident affecting data we process on your behalf. I am sending this within the 24-hour window required by Section 9.9 of the Beta Tester Agreement.
>
> **What happened:** [one-paragraph factual description]
>
> **When:** [date / time / time-zone window]
>
> **Categories of personal data affected:** [list — e.g. homeowner names, addresses, transcripts]
>
> **Approximate number of records affected:** [number, or "unknown — still being assessed"]
>
> **Likely consequences for affected data subjects:** [your honest assessment — e.g. "unauthorised disclosure of contact details"]
>
> **Measures we have taken so far:** [what containment was done — see §4]
>
> **Measures we recommend you take:** [e.g. consider whether to notify affected homeowners directly; review your own breach-register entry]
>
> **What's still being investigated:** [list]
>
> Please confirm receipt of this email. I will send a follow-up update within 48 hours, and final closure of the incident with full root-cause once available.
>
> If you wish to escalate, my direct contact is below.
>
> Derek Beckley
> Data Protection Lead, Beckley Electrical Ltd t/a CertMate
> privacy@certmate.uk
> [phone]

## 5.1 Controller notification — short variant (Controller is the reporter)

When the inspector reported the incident themselves, send a confirmation-of-actions email rather than the formal template.

> Subject: **CertMate — your reported incident — confirmation of actions taken**
>
> Hi [name],
>
> Thanks for reporting [the iPad theft / suspected account access] on [date / time]. I'm writing within the 24-hour window required by Section 9.9 of the Beta Tester Agreement to confirm what we've done on our side.
>
> **On our side:**
> - [List, e.g.: locked your CertMate account at 09:19 UTC; rotated session tokens]
> - [Investigated CloudWatch logs from [time of incident] to now — finding: [no activity / activity, see below]]
> - Logged as incident `INC-YYYY-NNN` in our internal breach register
>
> **On your side, please confirm you have done:**
> - [As applicable: remote-wiped via Find My iPhone; signed out of Apple ID; reported to police]
> - Changed your CertMate password (you can re-activate the account once you confirm)
>
> Based on the evidence we have so far, our assessment is that ICO notification is [not required / required] because [reasoning]. I'll send a final closure email with root-cause and any follow-up actions within 7 days.
>
> Reply with the device-side confirmations and I'll re-activate your account.
>
> Derek Beckley
> Data Protection Lead, Beckley Electrical Ltd t/a CertMate
> privacy@certmate.uk

## 6. ICO notification (72-hour deadline) — submission

The ICO accepts breach notifications at [ico.org.uk/for-organisations/report-a-breach/](https://ico.org.uk/for-organisations/report-a-breach/). Use the online form. The information you'll need:

- Your ICO registration number (from Task #4)
- Description of the breach in plain English
- Categories and approximate number of data subjects affected
- Categories and approximate number of records affected
- Name and contact of the DP Lead (you)
- Likely consequences
- Measures taken or proposed
- Whether the data subjects have been informed

**If you cannot meet the 72-hour deadline**, the ICO will accept the notification late, accompanied by the reasons for the delay. Do not wait beyond 72 hours hoping for more information — submit what you have.

You do not need a solicitor to file an ICO notification. If the incident is large or contentious, retain one for the follow-up correspondence.

### 6.1 ICO notification — decision matrix

The P2 ICO call ("assess against the 'likely to result in a risk' threshold") is the single most consequential judgement in this runbook. Use this matrix for the common cases; for anything outside it, document the reasoning in the breach register row.

| Pattern | Notify ICO? | Reasoning |
|---|---|---|
| **PIN/biometric-locked device loss, no API activity from the account after the loss** | **No** — log assessment in breach register, send Controller §5.1 short notification only | Device cryptographically protected; no evidence the data has been "compromised"; the lock substantially mitigates risk |
| **Unlocked device loss** (e.g. inspector left the iPad on a job-site bench, returned to find it gone, no PIN set) | **Yes** — within 72h. Treat the cached job data on the device as disclosed. | The "likely risk" threshold is met because anyone could have opened the app |
| **PIN-locked device loss with API activity from the compromised account after loss time** | **Yes** — within 72h. PIN was bypassed or shared. | Evidence of actual compromise overrides the lock-as-mitigation argument |
| **Confirmed exfiltration of homeowner data** (anywhere in the chain — device, backend, sub-processor) | **Yes** — within 72h, plus consider data-subject notification under §7 | The presumption is in favour of notification once exfiltration is evidenced |
| **Service-only incident with no personal-data dimension** (e.g. ECS service degraded, no data accessed) | **No** | Not a personal-data breach; log internally only |
| **Sub-processor notification reaching us about an incident in their stack** | **Depends** — apply the same matrix substituting "their disclosure" for "device loss" | A sub-processor confirming actual access by an unauthorised party is the same standard as our own systems being accessed |

For any "Yes" case, draft the §6 submission in parallel with the §5 / §5.1 Controller notification — don't sequence them.

## 7. Data-subject notification (without undue delay if high risk)

Required where the breach is likely to result in a **high risk to the rights and freedoms of natural persons**. Examples of high risk: financial fraud potential, identity theft potential, exposure of sensitive personal details.

Notify via the most-reliable channel you have. For homeowners, that is usually via their inspector (who has the direct relationship). For inspectors, that is via their account email.

Template:

> Subject: **Important — a personal-data incident affecting your records on CertMate**
>
> Dear [name],
>
> We are writing to let you know about a security incident that has affected your data held on CertMate. We are giving you this notice in line with our obligations under UK data-protection law.
>
> **What happened:** [plain-English description]
>
> **What data was involved:** [list]
>
> **What we have done:** [containment]
>
> **What we recommend you do:** [if relevant — e.g. "be alert for unusual contact from anyone claiming to know your address"]
>
> **How to contact us:** privacy@certmate.uk
>
> **How to contact the regulator:** [ico.org.uk/concerns](https://ico.org.uk/concerns/) — 0303 123 1113
>
> [signature]

## 8. Post-mortem

After every P1 or P2 incident — and after every tabletop exercise — produce a written post-mortem in `.planning/compliance/incidents/<date>-<slug>.md`. It must include:

- Timeline of events (detection, containment, investigation, notifications)
- Root cause
- What worked
- What didn't work
- Action items with owners and deadlines

Review the post-mortem at the next quarterly compliance review. Action items must be tracked through to completion.

## 9. Tabletop exercise cadence

Run a tabletop exercise **annually**, plus once within the first 90 days of the first paying inspector-customer. Use a realistic scenario from §1 — for example:

- "An inspector emails saying their iPad was stolen at a job site and they think their CertMate account is now in someone else's hands."
- "AWS sends an automated alert that the `eicr-files-production` bucket had public access enabled for 6 hours overnight."
- "Anthropic emails to say their API logs were accessed by an unauthorised party for an unknown duration."

Walk through the runbook end-to-end without touching production. Note where the runbook is silent or ambiguous; update it in a follow-up commit.

## 10. Contacts

- **Data Protection Lead** — Derek Beckley, `privacy@certmate.uk`, [phone TBD]
- **Outsourced DP consultant** — `[GAP]` — to be engaged when first paying inspector signs (Task #5)
- **Solicitor (engaged ad hoc)** — `[GAP]` — short-list Sprintlaw UK / EM Law / Harper James from the compliance plan
- **AWS support** — via AWS Console, Premium Support if subscribed; otherwise the standard support form
- **ICO** — [ico.org.uk/concerns](https://ico.org.uk/concerns/) — 0303 123 1113
- **Action Fraud** (if criminal element suspected) — 0300 123 2040

## 11. Outstanding setup work

Before this runbook can be relied on in anger:

1. Provision the `privacy@` and `security@` mailboxes on certmate.uk (currently `[GAP]`).
2. Set the operator phone number — internal-only number is fine, can be a Twilio / Google Voice line.
3. Test the JWT-rotation command and the containment toolkit commands on a non-prod environment so a typo doesn't surface during a real incident.
4. Verify ICO registration is in place and the registration number is recorded here (gated on Task #4).
5. Run the first tabletop exercise within 30 days of the first non-Derek inspector signing the Beta Tester Agreement.
