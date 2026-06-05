---
title: Handoff — CertMate launch-prep (2026-05-11)
status: pick-up-from-cold brief
last_verified: 2026-05-11
maintainer: Derek Beckley
purpose: resume the launch-prep workstream without re-reading any conversation history
read_first: ./two-week-launch-checklist.md
audience: future-Derek + any Claude session that resumes this work
---

# Handoff — CertMate launch-prep (2026-05-11)

## At a glance

CertMate has a complete compliance documentation stack and most of the legally-required technical fixes have shipped. The remaining work is **admin (vendor portals + ICO + insurance), a solicitor review of the Beta Tester Agreement, an iOS TestFlight deploy of two pending commits, a tabletop exercise of the incident-response runbook, building an in-app account-deletion flow, publishing the public docs to certmate.uk routes, and submitting to the App Store.** None of it is hard; all of it is gated on Derek's calendar.

The single most consequential gate before admitting a second inspector to run a real homeowner job: **bind Professional Indemnity insurance and sign the four AI sub-processor DPAs.** Both are free or near-free and together remove the largest residual financial and contractual exposures.

## What got done in the session of 2026-05-11

**Documentation stack** — 16 files in `.planning/compliance/` totalling ~3,250 lines, all UK GDPR / PECR / ICO-template aligned and internally consistent (every claim traces to `facts.md`):

```
facts.md                              source of truth
ropa.md                               UK GDPR Art. 30 ROPA (controller + processor)
retention-policy.md                   storage-limitation policy
dpia-voice-extraction-pipeline.md     UK GDPR Art. 35 DPIA
privacy-policy.md                     public Art. 13 notice
cookie-policy.md                      PECR Reg 6 compliance
sub-processors.md                     public Art. 28(2) list
door-script.md                        homeowner audio-recording notice
beta-tester-agreement.md              clickwrap contract + embedded DPA
in-app-consent-screen.md              clickwrap UX spec
acceptable-use-policy.md              public AUP
incident-response-runbook.md          internal breach playbook
sar-erasure-playbook.md               internal rights-request playbook
two-week-launch-checklist.md          the operational sequence
registers/breach-register.md          empty Art. 33(5) log
registers/erasure-register.md         empty Art. 12-22 log
```

**Technical compliance fixes shipped** — backend commits already deployed via CI, iOS commits pending TestFlight:

| Commit | Repo | What | Live? |
|---|---|---|---|
| `407ceb2` | backend | TradeCert dead-code cleanup | ✓ |
| `4e983a2` | backend | Web Deepgram `mip_opt_out=true` | ✓ |
| `0a4ed20` | backend | Debug audio S3 path env-gated default-off | ✓ |
| `fb20dc0` | backend | Winston logger PII redaction + 8 tests | ✓ |
| `a3eaccd` | iOS | iOS Deepgram `mip_opt_out=true` | **Pending TestFlight** |
| `aa7141c` | iOS | EXIF stripping in `ImageScaler.swift` | **Pending TestFlight** |

**AWS state change** — `eicr/api-keys` Secrets Manager value version `7403214d-595a-4b5d-bf89-06ceffe14f06` removed dormant `TRADECERT_EMAIL` + `TRADECERT_PASSWORD` keys; 7 keys remain.

**Discovered during the session** — CloudWatch retention was already set at 30 days on all three `/ecs/eicr/*` log groups (audit had assumed indefinite because the setting was not in the ECS task def). Docs updated to reflect the correct state.

## Current state of play

### What's in place

- Full compliance documentation stack (publishable to ICO on request as-is, modulo the marked `[GAP]` items below)
- Backend technical mitigations for DPIA risks R2 (Deepgram MIP), R3 (log redaction + retention), R4 (debug audio gate) — all live in production
- Limited-company structure ring-fencing Derek's personal assets (Beckley Electrical Ltd, Co. 11816656)
- Inspector-review-required architecture in the iOS recording pipeline (every cert field reviewed before issue)
- Sub-processor list updated to reflect TradeCert removal

### What's NOT in place yet

Listed in the order that surfaces them as launch blockers:

1. **Four AI sub-processor DPAs not signed** — Anthropic, OpenAI, Deepgram, ElevenLabs. All four are on default API access. Until each is signed, the Art. 28 processor chain is technically incomplete. **Free; ~1 hour total.**
2. **ICO registration not in place.** £35 Tier 1 fee outstanding. Without the registration number, every doc carries a `[GAP]` for the number. **30 min.**
3. **No insurance bound** — neither Professional Indemnity (covers Scenario 1: inspector blames us for a wrong cert) nor Cyber Liability (covers Scenario 2: data-protection breach claim). **The single highest-value remaining gap.**
4. **Beta Tester Agreement not solicitor-reviewed.** Brief is pre-written at the bottom of `beta-tester-agreement.md` — 8 specific questions targeting the highest-risk clauses. **£300–£500 fixed fee, 5–10 days turnaround.**
5. **MFA audit not done** across all consoles. Pre-req for Cyber Essentials v3.3 ("Danzell") which is in force 27 April 2026. **1 hour.**
6. **iOS TestFlight build pending** — two compliance fixes (Deepgram MIP, EXIF strip) are committed on `CertMateUnified/main` but not yet uploaded to TestFlight. Run `./deploy-testflight.sh` from `~/Developer/EICR_Automation/CertMateUnified/`. **~1 hour interactive + Apple processing.**
7. **Tabletop exercise** of the Incident Response Runbook not yet run. **1 hour.**
8. **Door-script wording** not yet field-tested — current draft is best-effort. **Real-world test on the next 2-3 jobs Derek does himself.**
9. **Public docs not published** at certmate.uk routes. Need Next.js page wrapping for `privacy-policy.md`, `cookie-policy.md`, `sub-processors.md`, `acceptable-use-policy.md`, `beta-tester-agreement.md`, `door-script.md`. **~3 hours engineering.**
10. **In-app consent screen not built** per `in-app-consent-screen.md`. ~9 hours engineering across backend + iOS + web.
11. **In-app account deletion not built** — required by Apple Guideline 5.1.1(v) before App Store approval. ~6 hours engineering. (Tracked as new harness task — see task list.)
12. **App Store submission not started.** ~3 hours metadata + 2-4 weeks elapsed for Apple review including likely rejection-and-resubmit cycles.

## Where to start when you resume

The work splits cleanly into two parallel paths. Derek does Path A; engineering work on Path B can happen in parallel.

### Path A — Derek's admin items (target: Days 1–7)

In this order, time-boxed:

1. **Day 1 (45 min):** sign the four AI vendor DPAs. Sequence them: Anthropic Commercial Terms → OpenAI DPA portal → ElevenLabs DPA URL → Deepgram email to AE requesting DPA (this one waits on their reply). All four are free.
2. **Day 1 (30 min):** register with ICO at https://ico.org.uk/registration. Capture the registration number that comes back.
3. **Day 1 (10 min):** substitute the ICO registration number into the four `[GAP]` placeholders in the compliance docs (see `two-week-launch-checklist.md` Task 6 for the exact paths). Commit.
4. **Day 1 (1 hour):** MFA audit per `two-week-launch-checklist.md` Task 7. Enable wherever missing.
5. **Day 2-3 (90 min):** Professional Indemnity quote from PolicyBee + Hiscox. Bind whichever is cheaper. Aim for £1m–£2m PI cover.
6. **Day 4-5 (1 hour):** Cyber Essentials application via IASME. £384 fee, 2-6 week turnaround. Free Cyber Liability insurance bundled for orgs under £20m turnover.
7. **Day 5-7 (1 hour to brief):** send Beta Tester Agreement to Sprintlaw UK / EM Law / Harper James. Point them at the 8-question brief at the bottom of `beta-tester-agreement.md`. £300–£500 fixed fee, 5–10 days turnaround.

### Path B — Engineering items (target: Days 7–21, parallel)

1. **iOS TestFlight build** — run `./deploy-testflight.sh` to ship the two pending compliance commits. Bumps build number, archives, uploads, attaches to Electricians group. **First.**
2. **Tabletop exercise** of `incident-response-runbook.md`. Pick a scenario from §9. Walk through the 60-minute response sequence without touching production. Update the runbook for anything that surfaced as ambiguous.
3. **Publish public docs to certmate.uk** (`two-week-launch-checklist.md` Task 15). 6 routes under `web/src/app/legal/`. Use the existing typography tokens. Footer link from the main app. ~3 hours.
4. **Build in-app account deletion** (Task 18 + the new harness task). Backend `DELETE /api/me` cascading to RDS + S3, archiving NICEIC-retention PDFs under `archive/{userId}/`. iOS Settings → Account → "Delete my account". Web equivalent. ~6 hours.
5. **Build the in-app consent screen** (Task 16) per `in-app-consent-screen.md`. ~9 hours. **Gated on the solicitor-reviewed final wording of the Beta Tester Agreement** — don't build against a draft.
6. **App Store submission** (Task 18, second half). Fill App Privacy "Nutrition Labels" from `facts.md` §3. Verify `Info.plist` usage descriptions. Prepare metadata + screenshots. Submit. Expect 1–3 rejection cycles.

## Critical context — don't proceed without reading

### 1. **Backend immutability rule** (project CLAUDE.md, just added)

> Backend (`src/`, `config/prompts/`, `packages/shared-types`, `packages/shared-utils`, RDS, S3) is SHARED with iOS and IMMUTABLE during PWA-only work. PWA bug fixes / parity work / UI tweaks land in `web/` ONLY.

For this launch-prep workstream specifically: the **account deletion endpoint IS a backend change** (`DELETE /api/me` + migration for any new column). It must be coordinated with iOS — confirm the iOS app handles the post-deletion logout cleanly. The Path B work in this handoff includes a deliberate cross-platform mandate; it is not "PWA-only work" and the rule above does not block it. But check before touching `src/` for anything that wasn't pre-agreed in this handoff.

### 2. **Legal entity is fixed; some doc placeholders are not**

Beckley Electrical Ltd, Co. **11816656**, registered office 1 MacArthur Close, Tilehurst, Reading, RG30 4XW. These are correct and locked in throughout the doc stack. The placeholders that need substitution on first publication are: ICO registration number (Path A item 3), effective date on the Beta Tester Agreement (set on first signature), and `privacy@certmate.uk` mailbox (needs to be provisioned first — quick AWS Workmail or Google Workspace task).

### 3. **The compliance docs are interdependent — don't edit one in isolation**

Every claim in `privacy-policy.md`, `ropa.md`, `dpia-voice-extraction-pipeline.md`, `retention-policy.md`, `beta-tester-agreement.md`, and `sub-processors.md` traces back to `facts.md`. If something is wrong in any of those docs, **fix `facts.md` first**, then propagate. The audit-trail expectation is that `facts.md` and every downstream doc agree.

### 4. **Domain is certmate.uk, NOT certomatic3000.co.uk**

The project CLAUDE.md still says `certomatic3000.co.uk` (stale). The compliance docs use `certmate.uk`. When you wire the public docs into Next.js routes, the host should be `certmate.uk`. The Route 53 record is for `certmate.uk`.

### 5. **TestFlight is sufficient for the next 6-12 months**

Don't let App Store approval gate inviting tester #2. TestFlight supports up to 10,000 testers via public link. App Store is a "wider distribution" upgrade, not a "first paying inspector" prerequisite. Sequence accordingly.

### 6. **The Beta Tester Agreement has 8 solicitor-review questions at the bottom**

When briefing the solicitor, point them specifically at those questions. They cover liability cap defensibility, indemnity asymmetry, sub-processor change mechanics, audit rights conditions, Art. 28(3) cross-check, the definition of "material breach", and the beta-to-paid transition structure. The solicitor brief is the cheapest way to make the £300–£500 review high-value.

### 7. **Two real risk scenarios were assessed in the conversation that produced this stack**

| Scenario | Capped? | Biggest gap |
|---|---|---|
| Inspector blames CertMate for a wrong cert | £1,000 / 12-month-fees | **PI insurance not bound** |
| Inspector says data was stored/processed wrong | **Uncapped** under contract; UK GDPR statutory caps apply | **Sub-processor DPAs not signed** + Cyber Liability not bound |

Both scenarios drop from Medium to Low residual risk once Path A items are complete. Until then, **do not invite a second inspector to run a real homeowner job.**

## Open questions for Derek

These need decisions before some of the work above can complete:

1. **HeyGen** — `HEYGEN_API_KEY` was found in production secrets. Active integration, dormant code, or experiment? Flagged in `facts.md` §5.1 and §14 as `[CONFIRM]`. If dormant, same treatment as TradeCert (cleanup commit).
2. **iOS monetisation route** — Apple IAP (Apple takes 15–30%) or web-only signup with iOS app free? Required only when paid plans launch but the decision shapes App Store positioning. Free during beta means no urgency.
3. **Stripe + Google Calendar integrations** — schema tables exist but not connected. Keep for future or remove via migration?
4. **Door-script wording** — Version A (5-10s) and Version B (15-20s) are field-test candidates. After 2-3 real jobs, lock the one that's actually used.
5. **Cert footer wording** — should every PDF say "Issued by [Inspector Name], scheme reg [X]. CertMate is a dictation aid; the named inspector is the responsible professional"? This is a Scenario 1 mitigation that's free to add.

## Key files, commits, URLs

**Documentation entry points:**
- Foundation: `.planning/compliance/facts.md`
- Operational sequence: `.planning/compliance/two-week-launch-checklist.md`
- Highest-risk document: `.planning/compliance/beta-tester-agreement.md`
- This handoff: `.planning/compliance/handoff_2026-05-11_launch_prep.md`

**Vendor portals to action:**
- Anthropic console: https://console.anthropic.com
- OpenAI DPA: https://openai.com/policies/feb-2024-data-processing-addendum/
- ElevenLabs DPA: https://elevenlabs.io/dpa
- Deepgram: contact Account Executive
- ICO registration: https://ico.org.uk/registration
- IASME Cyber Essentials: https://iasme.co.uk/cyber-essentials/
- PolicyBee (PI quote): https://www.policybee.co.uk
- Hiscox (PI quote): https://www.hiscox.co.uk

**Deploy commands:**
- Backend deploys via push to main on GitHub Actions (`gh run watch`)
- iOS TestFlight: `cd ~/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log`

**Status snapshot table in `two-week-launch-checklist.md` is the live progress tracker.** Tick boxes as items complete; commit per material milestone.

## When you're done

The success state for this workstream:

> Tester #2 (a real UK electrician other than Derek) has signed the Beta Tester Agreement via the in-app consent screen, completed a real homeowner inspection through CertMate, and uploaded the resulting certificate — all without any DPIA-mitigation gap being active. The Subject Rights Request Register and Breach Register remain empty. The compliance dashboard, were one to exist, would show every Path A item green.

That state is approximately 2-3 weeks of elapsed time from a Day 1 start. The bulk of the elapsed time is waiting on external clocks (Apple review, solicitor turnaround, Cyber Essentials processing, Deepgram DPA reply) rather than active engineering.
