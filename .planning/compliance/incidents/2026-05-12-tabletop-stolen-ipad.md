---
title: Tabletop Exercise — Stolen iPad with Active CertMate Account
date: 2026-05-12
type: Tabletop (no production systems touched)
scenario_source: incident-response-runbook.md §9 first bullet
runbook_version_under_test: 2026-05-11
facilitator: Derek Beckley
classification: Tabletop (logged in breach register as `INC-2026-001`)
related: ../incident-response-runbook.md ../registers/breach-register.md
---

# Tabletop — Stolen iPad with Active CertMate Account

## 1. Scenario brief

> **2026-05-12 09:14 BST.** An inspector ("E. Kowalski" — fictional, a future tester #2) emails `privacy@certmate.uk` from a personal Gmail saying: "My iPad was stolen at a job site in Reading yesterday around 17:42. I haven't logged out of CertMate on it. I think someone may have it. What do I do?"
>
> The iPad was passcode-protected with a 6-digit PIN at the time of theft. The inspector has not yet remote-wiped via Apple Find My. The inspector has run 3 jobs in CertMate this week, all real homeowner inspections in Berkshire.

The exercise treats this as a real-time event and walks the [Incident Response Runbook](../incident-response-runbook.md) end-to-end without touching production. The scenario is plausibly the first real incident CertMate will see — beta-tester device theft is more likely than backend compromise.

## 2. Timeline (simulated wall-clock)

All timestamps are simulated as if Derek read the email at **T+0 = 09:14 UTC** on 2026-05-12.

| T+min | Action | Runbook step | Notes |
|---|---|---|---|
| 0:00 | Email read; awareness established | §3 minute 0–5 | The 72-hour ICO clock starts now |
| 0:02 | Open `breach-register.md`, write row `INC-2026-001`, severity `P3 (pending)` | §3 step 1 | **GAP-1**: runbook §3 doesn't link to the breach register path |
| 0:04 | Email myself a copy of E. Kowalski's email + the metadata (subject, from, received-at) | §3 minute 5–15 step 5 | Forwarded to a personal Gmail outside `certmate.uk` infra |
| 0:08 | Classification decision: **P2 Significant** | §3 step 3 | Justification: single account, passcode-locked device, no exfiltration evidence yet, but real homeowner data was cached |
| 0:10 | Update breach register row → `P2`, scope = "1 inspector account, ~3 homeowner records, audio + photos + transcripts" | §3 step 4 | |
| 0:11 | Reply to inspector confirming receipt, ask 4 evidence questions (see §3 below) | Not currently in runbook | **GAP-2** |
| 0:17 | Rotate JWT signing secret in AWS Secrets Manager | §4 toolkit cmd 1 | Drafted command only; in real run this logs out ALL inspectors |
| 0:19 | Lock the inspector's account: `UPDATE users SET is_active = false ... WHERE id = '...'` | §4 toolkit cmd 2 | **GAP-3**: the runbook doesn't give the actual psql connection command |
| 0:21 | Force ECS new deployment so containers pick up rotated JWT | §4 step 6 | ~2 min for new tasks to come up |
| 0:23 | Ask inspector to (a) remote-wipe via Find My iPhone, (b) sign out Apple ID, (c) report theft to police | Not in runbook | **GAP-4**: iOS-specific containment is missing from §4 |
| 0:30 | Pull CloudWatch logs since the theft time (T-15h54m, not the runbook's `--since 4h`) and filter for the user's API calls | §4 toolkit cmd 6 | **GAP-5**: runbook example uses 4h; **GAP-6**: no filter syntax for user-scoped logs |
| 0:40 | Investigation result: zero API calls from this user's account between 17:42 BST yesterday and 09:17 BST today. PIN held; no compromise observed. | §3 minute 30–60 | The PIN-lock window probably held |
| 0:45 | Draft Controller notification email to send within 24h | §5 template | **GAP-7**: template assumes Controller ≠ reporter; here Controller IS reporter (awkward wording) |
| 0:55 | Decide on ICO notification: **NOT required.** No evidence of access; the inspector is the data subject and reported it themselves; homeowners' data not accessed. Document the assessment. | §3 step 11, §6 | **GAP-8**: no decision-template for "P2 device-loss, no exfiltration" common case |
| 0:58 | Close breach register row with disposition; schedule post-mortem | §8 | Total elapsed: under 60 min — runbook timing held |

## 3. Evidence questions to the inspector (template to add to runbook)

For any reported device loss / theft / suspected account compromise:

1. **Was the device passcode/biometric locked at the time of loss?** (governs whether unlock is needed to access the app)
2. **How recently did you last log in to CertMate on the device?** (estimates the JWT TTL window; our tokens are valid for 30 days)
3. **Have you (a) reported the theft to the police, (b) signed out of your Apple ID remotely via Find My iPhone, (c) initiated a remote wipe?** (Apple-side containment that we cannot do for them)
4. **Approximately how many real jobs did you run on that device, and what was the most recent date?** (data-subject scope)

Send these in the **first reply** to the reporter, before the 30-min mark.

## 4. Findings — runbook gaps

Each finding has a fix. The fixes are applied in a follow-up commit to `incident-response-runbook.md`.

### GAP-1 — Breach register location not linked from §3

**Symptom:** §3 step 1 says "Open an entry in the Breach Register". A reader who hasn't memorised the file layout has to grep. Under pressure this costs 30+ seconds and breaks flow.

**Fix:** add a `[Breach Register](./registers/breach-register.md)` link in §3 step 1.

### GAP-2 — No evidence-gathering checklist for device-loss reports

**Symptom:** I had to invent the 4 inspector-questions on the fly. A real incident would benefit from a pre-drafted question list — especially the lock-state question, which fundamentally changes severity.

**Fix:** add a new §3.1 "Evidence questions by incident type" with two starter checklists: device loss/theft, and credential-compromise suspicion.

### GAP-3 — psql connection command incomplete

**Symptom:** §4 toolkit cmd 2 says `Connect via psql using the credentials in eicr/database secret, then:` but stops there. Under pressure you'd be hunting for the secret JSON shape, the host, the SSH bastion (if any), and the SSL flags.

**Fix:** add the exact connection one-liner.

### GAP-4 — No iOS / Apple-side containment guidance

**Symptom:** A stolen iPad is a 50%-of-all-plausible-incidents scenario for a field-deployed iOS app. The runbook §4 toolkit has zero iOS-specific actions. Apple-side containment (Find My, Activation Lock, Apple ID sign-out) is owned by the inspector, not by us, but we should be the ones telling them to do it.

**Fix:** new §4.1 "Device-side actions (delegated to the affected user)" with a 3-step checklist + the support URL.

### GAP-5 — CloudWatch `--since 4h` example is too short for slept-on incidents

**Symptom:** A real device-loss is often discovered on the next morning, ~12-15 hours after the event. The runbook example pulls 4 hours of logs, missing the actual incident window. A fresh-eyes reader would copy-paste and get incomplete data.

**Fix:** change the `--since 4h` examples to `--since 24h` and add a one-line note: "adjust `--since` to cover the full window from `time-of-incident` to `now`".

### GAP-6 — No log-filter syntax for user-scoped investigation

**Symptom:** "How many API calls did this user make after the theft?" is the most important investigative question in any account-compromise scenario. The runbook shows how to pull all logs (`aws logs tail`) but not how to filter for one user.

**Fix:** add a CloudWatch Insights one-liner example with a `user_id` field filter.

### GAP-7 — Controller-is-reporter case isn't covered in §5 template

**Symptom:** In our beta architecture the inspector IS the Controller. When the inspector reports the incident themselves, sending them back the formal §5 "I am writing to notify you" template reads as a process-theatre — they already know.

**Fix:** add a "When Controller is also the reporter" variant in §5 — a confirmation-of-actions style email rather than a notification.

### GAP-8 — No decision template for "P2 device-loss, no exfiltration evidence"

**Symptom:** The P2 ICO-notification call ("assess against the 'likely-to-result-in-a-risk' threshold") is the single most consequential judgement in the runbook. For the most likely real incident class (PIN-locked device loss with no exfiltration evidence), there's no template to reason through the decision — every operator would re-derive it from first principles.

**Fix:** add §6.1 "ICO notification decision matrix" with three pre-decided cases: (a) PIN-locked device loss, no API activity → no notification, document assessment; (b) unlocked device loss OR API activity from compromised account → notify; (c) confirmed exfiltration of any homeowner data → notify and consider data-subject notification too.

## 5. What worked

- **The 60-minute window held.** Total elapsed was under 60 minutes with all in-runbook steps completable. No step blocked on a missing tool or credential I didn't have access to.
- **The breach register schema captured everything needed.** No missing columns.
- **The classification matrix (§2) was unambiguous.** P2 was the obvious call; no temptation to under-classify as P3 or over-classify as P1.
- **JWT rotation as a "stop the bleeding" step is the right first action** — it's reversible (it just forces re-login), scoped to our infra (no Apple involvement), and bought time while the investigation proceeded.
- **The Beta Tester Agreement is the right contractual home for the 24-hour Controller-notification SLA.** Section 9.9 (the runbook §5 template references it) — when I drafted the response I went straight to Section 9.9 wording without having to invent it.

## 6. What didn't work

- **§3 step 1 → breach register hop** lost 30 seconds. Trivial fix.
- **No iOS containment guidance** — I had to invent the 3-step inspector instruction list. This is the biggest gap and the most likely to recur.
- **The psql command was incomplete** — would have cost a real run ~3-5 minutes to find the host, SSL flags, and secret JSON shape. In a real account-compromise where every second of session-lifetime is risk exposure, that's too slow.
- **The Controller-is-reporter awkwardness** isn't a process bug, but reading the §5 template aloud in this scenario showed the template wording doesn't fit a self-reported incident. A 5-line variant template fixes it.

## 7. Follow-up actions

| # | Action | Owner | Deadline |
|---|---|---|---|
| 1 | Apply GAP-1 through GAP-8 fixes to `incident-response-runbook.md` | Derek | Same day as this post-mortem |
| 2 | Add row `INC-2026-001` to `registers/breach-register.md` | Derek | Same commit as this post-mortem |
| 3 | Schedule a second tabletop covering a different scenario (suggestion: "Anthropic email saying API logs were accessed") within 90 days | Derek | 2026-08-12 |
| 4 | When `privacy@certmate.uk` mailbox is provisioned (Path A item), test the address-to-inbox flow with a self-sent email | Derek | At provisioning |
| 5 | Pre-write the JWT-rotation + ECS-redeploy commands as a shell script `scripts/incident/rotate-jwt.sh` so a real-incident run doesn't have to copy-paste and risk a typo | Derek | Within 30 days |

## 8. Sign-off

Tabletop conducted by: Derek Beckley
Runbook version under test: 2026-05-11
Runbook fitness-for-purpose: **READY**, conditional on the 8 GAP-fixes in §4 landing.
Re-run cadence: annually + within 30 days of first non-Derek inspector signing the Beta Tester Agreement.
