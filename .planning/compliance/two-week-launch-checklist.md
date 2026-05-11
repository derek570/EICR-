---
title: CertMate Two-Week Pre-Launch Checklist
status: live checklist — tick items off as they complete
last_verified: 2026-05-11
maintainer: Derek Beckley
purpose: minimum-viable gating list to admit the first paying inspector-customer
related: ../compliance/ — every doc in that directory
---

# Two-Week Pre-Launch Checklist

The single objective: be in a position to confidently admit the first inspector-customer who is not Derek. Everything below either (a) closes a current legal or financial exposure, or (b) operationalises a documented mitigation.

Order matters less than completion. The dependencies are flagged.

---

## Days 1–3 (this weekend) — Free, can be done from a laptop

### ☐ 1. Sign Anthropic Commercial Terms / DPA

- Log in to https://console.anthropic.com
- Settings → Plans → upgrade from Free to Commercial if not already there (or confirm acknowledgement)
- The Commercial DPA auto-incorporates — no separate signature needed once on Commercial
- Reference: [Anthropic DPA portal](https://privacy.claude.com/en/articles/7996862-how-do-i-view-and-sign-your-data-processing-addendum-dpa)
- **Time: 15 min**

### ☐ 2. Sign OpenAI DPA

- Log in to https://platform.openai.com
- Settings → Compliance → Data Processing Addendum
- Sign as Beckley Electrical Ltd, Co. 11816656
- Also verify the API retention tier (default 30-day operational logs)
- Reference: https://openai.com/policies/feb-2024-data-processing-addendum/
- **Time: 15 min**

### ☐ 3. Request Deepgram DPA + opt out of MIP at the account level

- Email Deepgram support / your Account Executive requesting the DPA
- Confirm in writing that your account is on the zero-retention plan (the `mip_opt_out=true` URL flag is already shipped on web, pending TestFlight build for iOS — see Task 11)
- **Time: 10 min email; reply may take 1–2 business days**

### ☐ 4. Sign ElevenLabs DPA

- Log in to https://elevenlabs.io
- Settings → Compliance → DPA
- Reference: https://elevenlabs.io/dpa
- Confirm UK Extension to EU-US DPF status on https://www.dataprivacyframework.gov/list (ElevenLabs is self-certified)
- Enable Zero Retention Mode if available on your plan
- **Time: 15 min**

### ☐ 5. Register with the ICO + pay the Tier 1 data protection fee

- https://ico.org.uk/registration
- Register as Beckley Electrical Ltd, Co. 11816656, registered office 1 MacArthur Close
- Set up Direct Debit (£35 with DD discount, £40 otherwise)
- Save the registration number that comes back
- **Time: 30 min**

### ☐ 6. Update placeholders in compliance docs with the new ICO registration number

Once the ICO number is issued, substitute it into:

- `.planning/compliance/facts.md` §1
- `.planning/compliance/privacy-policy.md` "Who we are" section
- `.planning/compliance/ropa.md` Part 0
- `.planning/compliance/incident-response-runbook.md` §6
- `.planning/compliance/sar-erasure-playbook.md` (no direct reference but worth a search for `[GAP]`)

Commit as a single edit. **Time: 10 min**

### ☐ 7. Audit MFA on every console and vendor portal

Pre-req for Cyber Essentials v3.3 ("Danzell") which takes effect 27 April 2026. The audit itself is also a sensible compliance step regardless. Required portals:

- AWS root account
- AWS IAM users (any user with console access)
- GitHub
- Anthropic console
- OpenAI org console
- Deepgram
- ElevenLabs
- Apple App Store Connect
- ICO portal (once registered)
- AWS Route 53 / domain controls

Enable MFA wherever it's missing. Use an authenticator app (Authy, 1Password) — not SMS where avoidable.

**Time: 1 hour**

---

## Days 4–7 (this week) — Insurance, the highest-value 90 minutes you'll spend this fortnight

### ☐ 8. Get Professional Indemnity insurance quote — bind whichever comes back cheaper

Two-call workflow:

- **PolicyBee** — https://www.policybee.co.uk — they specialise in tech and SaaS. Phone or online quote.
- **Hiscox** — https://www.hiscox.co.uk/business-insurance/professional-indemnity-insurance — same.

Be explicit when quoting:

- "SaaS for UK electricians that uses AI to extract data from inspector voice dictation, producing EICR / EIC electrical inspection certificates"
- "We are a Processor under UK GDPR for our customer-electricians' homeowner data"
- "We use four US-based AI sub-processors under standard UK Addendum to SCCs"

Cover sought: **£1m–£2m PI**, **£1m Cyber Liability** (or pair with Cyber Essentials free cover — see Task 10).

Budget: **£500–£1,200/yr** for the PI alone if separate.

Bind before doing Task 12. **Time: 90 min (call + email round-trip)**.

### ☐ 9. Apply for Cyber Essentials

- IASME is the NCSC's delivery partner: https://iasme.co.uk/cyber-essentials/
- Cost: £320 + VAT (micro org, 0–9 employees)
- The "Danzell" v3.3 question set comes into force 27 April 2026 — start now so MFA-audit work (Task 7) feeds into the application
- Free Cyber Liability insurance is bundled for orgs under £20m turnover via IASME — confirms this against your Task 8 quote
- **Time: 1 hour application + 2–6 weeks turnaround**

---

## Days 8–14 (next week) — Legal review + operational rehearsal

### ☐ 10. Solicitor review of the Beta Tester Agreement

Send to one of:

- Sprintlaw UK — fixed-fee SaaS contracts, online: https://sprintlaw.co.uk
- EM Law — UK SaaS specialists: https://emlaw.co.uk
- Harper James — SaaS subscription option: https://harperjames.co.uk

Brief them with the 8 questions appended at the bottom of `.planning/compliance/beta-tester-agreement.md`. Budget: **£300–£500 fixed fee**. **Time: 1 hour to brief; 5–10 days turnaround**.

Apply their feedback in a follow-up commit.

### ☐ 11. Ship the pending iOS TestFlight build

Two commits are sitting on `CertMateUnified/main` waiting for the next deploy:

- `a3eaccd` — iOS Deepgram `mip_opt_out` (closes DPIA R2 on iOS)
- `aa7141c` — EXIF stripping in `ImageScaler.swift` (closes DPIA R5)

Run `./deploy-testflight.sh` from `~/Developer/EICR_Automation/CertMateUnified/`. Confirm the build lands in the Electricians + toolbox TestFlight groups. **Time: 15 min interactive + ~30 min upload + ~15 min Apple processing**.

### ☐ 12. Run the first tabletop exercise

Pick one scenario from `.planning/compliance/incident-response-runbook.md` §9. Walk through it end-to-end without touching production. Time yourself against the 60-minute response sequence. Note any step that is ambiguous, missing, or impossible at the current scale.

Update the runbook in a follow-up commit. **Time: 60 min plus 30 min for runbook update**.

### ☐ 13. Field-test the door script wording

Two paths:

- Try Version A and Version B (`.planning/compliance/door-script.md`) on your next two real-world jobs as Derek-the-inspector
- If you have a tester from the Electricians group who has done at least one inspection with you, ask them which version they would actually use

Lock the wording or revise it in a follow-up commit. **Time: 30 min reflection after each job**.

---

## Days 14+ (gating tester #2)

These don't have to land within the fortnight, but they must land before the first non-Derek inspector runs a real homeowner job.

### ☐ 14. Apply solicitor feedback to the Beta Tester Agreement

Whatever the solicitor flags from Task 10. Tag the resulting version as `1.0` and bump `agreement_version` in the in-app consent screen spec.

### ☐ 15. Publish the public docs to certmate.uk routes

Wire the existing markdown into Next.js routes:

- `web/src/app/legal/privacy/page.tsx` ← `.planning/compliance/privacy-policy.md`
- `web/src/app/legal/cookies/page.tsx` ← `.planning/compliance/cookie-policy.md`
- `web/src/app/legal/sub-processors/page.tsx` ← `.planning/compliance/sub-processors.md`
- `web/src/app/legal/aup/page.tsx` ← `.planning/compliance/acceptable-use-policy.md`
- `web/src/app/legal/beta-tester-agreement/page.tsx` ← `.planning/compliance/beta-tester-agreement.md`
- `web/src/app/legal/door-script/page.tsx` ← `.planning/compliance/door-script.md`

Use the existing typography tokens. Add footer links from the main app. **Time: 3 hours**.

### ☐ 16. Build the in-app consent screen

Per `.planning/compliance/in-app-consent-screen.md`. Backend migration + route + middleware + iOS SwiftUI + Next.js page + E2E test. **Time: ~9 hours focused engineering**.

### ☐ 17. Invite tester #2 with confidence

Send them:

- Link to certmate.uk/legal/beta-tester-agreement
- Link to certmate.uk/privacy
- TestFlight invite
- A 30-minute onboarding call

Watch the consent-screen flow complete on first launch. Wait 24 hours. Their first real homeowner job is now legitimate from every angle on this checklist.

---

## Cost summary

| Item | Cost |
|---|---|
| ICO Tier 1 fee | £35 |
| Solicitor fixed-fee review | £300–£500 |
| Cyber Essentials | £384 (£320 + VAT) |
| Professional Indemnity insurance (Year 1) | £500–£1,200 |
| Cyber Liability insurance | £0 if bundled with CE; otherwise £350–£2,000 |
| **Total Year 1 (low / high)** | **£1,219 / £4,119** |

## What this checklist does NOT include

- Self-serve SAR / erasure endpoints (engineering, scheduled later)
- HttpOnly cookie migration (engineering, scheduled later — DPIA R9 residual)
- App Store submission (separate workstream — overlaps with Task 15)
- Stripe / payments wiring (no paid plan during beta)
- ISO 27001 / SOC 2 (deferred to enterprise customer demand)

## Status snapshot

| Phase | Item | Done? |
|---|---|---|
| 1–3 | All free admin items | ☐ |
| 4–7 | PI + Cyber Essentials kicked off | ☐ |
| 8–14 | Solicitor review + TestFlight + tabletop + door-script field test | ☐ |
| 14+ | Solicitor feedback applied, public docs published, consent screen built | ☐ |
| Gate | Tester #2 invited and onboarded | ☐ |

Update this file with `☑` as each item completes; commit per material milestone.
