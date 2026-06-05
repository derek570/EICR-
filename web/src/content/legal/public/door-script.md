---
title: CertMate Door Script — homeowner audio-recording notice
status: draft, pending field-test wording with first 2-3 inspectors
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
review_cadence: on any change to recording behaviour
distribution: bundled in iOS app help; printable sticker for tablet
related: ./dpia-voice-extraction-pipeline.md mitigation M1.1
---

# Door script — informing homeowners about audio recording

## Purpose

CertMate captures the inspector's dictation during an electrical inspection. That dictation incidentally captures the voices of anyone present in the home — the homeowner, family members, other tradespeople. The **Data Protection Impact Assessment** identifies this as the single highest-risk processing activity in the system (risk R1) and lists this door script as **mitigation M1.1**.

The script gives the homeowner notice **before** recording starts. It is the practical way we satisfy the "legitimate interest" balancing test under UK GDPR Article 6(1)(f): we record because it materially improves inspection accuracy, and the homeowner is told and offered alternatives.

The Beta Tester Agreement requires every inspector to inform the homeowner at the start of every inspection. This script is the wording we recommend.

## Three versions

The three versions below carry identical substantive content. Pick the version that fits the moment. The verbal versions are written to sound natural when spoken aloud — read them through once before your first job so the rhythm is yours.

### Version A — Quick verbal (5–10 seconds)

> "Just so you know, I record my dictation while I'm working so my software transcribes my test readings. The audio doesn't get kept — only the text. Happy for me to start?"

### Version B — Slightly more formal (15–20 seconds)

> "Before I start, just a quick note on how I work — I record my dictation while I'm testing. That goes to a UK transcription service so I get my readings written up correctly. The audio isn't kept; only the typed-up findings are. If you'd rather not be in earshot, you're welcome to sit in another room while I dictate. Are you OK with me starting?"

### Version C — Printable sticker for the tablet / iPad cover

A 70 mm × 50 mm sticker can carry this much text legibly at arm's length:

> **Audio dictation in progress**
>
> This electrician records their voice as they test, so the readings transcribe automatically into your certificate. Audio is **not** kept. Only typed-up findings are.
>
> Questions? See **certmate.uk/privacy** or ask the electrician.

(Sticker artwork to be designed; copy frozen here so any future design changes don't regress the wording.)

## When to deliver the notice

- **Always**: at the start of every inspection, before the first dictation.
- **Again, if circumstances change**: if a new person arrives during the inspection (e.g. an adult child returning home mid-job), use Version A as you greet them.
- **On request**: if anyone asks during the inspection what the recording is for, give them Version B.

## What to do if the homeowner objects

If the homeowner — or any other person present — asks you not to record audio:

1. **Don't record.** Use manual entry: type readings into the iPad directly as you test, the same way you would have before CertMate.
2. **Record what was asked.** When the certificate is finalised, add a short observation note: *"Audio dictation declined by customer; readings entered manually."* This protects both of you in the event of a future query about how the certificate was produced.
3. **Don't argue the point.** The homeowner has the right to refuse incidental capture of their voice. The certificate will still be valid.

If only one occupant (e.g. an elderly relative living with the homeowner) objects and the named homeowner is happy to proceed, ask the objector if they would prefer to be in another room while you dictate. That is the proportionate response.

## What the script does **not** say (and why)

The script intentionally:

- **Does not ask for written consent.** UK GDPR's lawful basis for incidental capture here is *legitimate interest* (Article 6(1)(f)), not consent. Asking for written consent would (a) misrepresent the lawful basis, (b) suggest the recording is more invasive than it is, and (c) create operational friction with no legal benefit.
- **Does not mention AI by default.** The verbal scripts focus on the transcription. If asked, you can mention that AI helps extract the structured readings — but most homeowners want to know "is my voice being recorded" rather than "what software model is used", and leading with the AI buzzword tends to alarm rather than inform.
- **Does not mention the US sub-processors by name.** That detail belongs in the Privacy Policy at certmate.uk/privacy, which the sticker and the in-app help both link to. The verbal version stays at the level the homeowner cares about.
- **Does not promise that audio is "deleted" — it says "not kept".** This is the accurate wording: audio is streamed and discarded after transcription rather than retained-then-deleted on a schedule.

## Compliance hooks

| Hook | Where it lives |
|---|---|
| Inspector consent to deliver this script | Beta Tester Agreement §5.3 |
| In-app recording-start confirmation that the script was delivered | In-app consent screen — required tap on the recording-start UI |
| Privacy Policy public reference for the homeowner who looks up the URL | [Privacy Policy](./privacy-policy.md) section "A note on voice recording" |
| Lawful-basis balancing this script supports | [DPIA](./dpia-voice-extraction-pipeline.md) mitigation M1.1 against risk R1 |

## Review log

| Date | Reviewer | Change |
|---|---|---|
| 2026-05-11 | Derek Beckley | Initial draft. Field-test wording with first 2-3 inspector-customers before locking. |
