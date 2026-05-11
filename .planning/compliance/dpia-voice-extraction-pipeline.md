---
title: Data Protection Impact Assessment — voice + AI extraction pipeline
status: working draft
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
source_of_truth: ./facts.md
template: ICO DPIA template (https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/how-do-we-do-a-dpia/)
review_cadence: annually + on material change to processing
---

# Data Protection Impact Assessment

## Voice recording, transcription, and AI extraction pipeline (CertMate)

> **About this DPIA.** UK GDPR Article 35 requires a DPIA where processing is "likely to result in a high risk to the rights and freedoms of natural persons." This DPIA covers the discrete, identifiable processing operation of capturing inspector dictation during an electrical inspection, transcribing it via Deepgram, and extracting certificate fields via Claude Sonnet + GPT Vision. It does **not** cover the broader operation of CertMate (account management, web app, payments) — those activities operate within standard SaaS norms and do not in themselves trigger the Art. 35 high-risk threshold.
>
> **Why this pipeline triggers Art. 35.** It scores on three of the ICO's nine high-risk indicators: (1) innovative technology (live AI extraction from voice during a regulated inspection — no clear industry precedent), (2) systematic monitoring (continuous voice capture in a private residence), (3) processing of data about vulnerable individuals (homeowners, including potentially elderly or socially housed tenants who may not understand what an AI inspection system is). Two of three is the ICO threshold for "high risk" requiring a DPIA.
>
> **Sign-off.** This DPIA must be signed by the Data Protection Lead (Derek Beckley) before the processor relationship activates (i.e. before tester #2 onboards). It should be reviewed for sign-off by an outsourced Data Protection consultant when one is retained.

---

## Section 1 — Identify the need for a DPIA

### 1.1 What is the project?

CertMate is an iOS-first SaaS for UK electricians that automates the production of EICR (Electrical Installation Condition Report) and EIC (Electrical Installation Certificate) certificates. The core innovation, and the subject of this DPIA, is the live voice extraction pipeline:

1. The inspector enters a customer's premises to carry out a regulated electrical inspection.
2. The inspector dictates readings, observations, and contextual data while testing.
3. The audio is streamed in real time from the inspector's iOS device to Deepgram Nova-3, which returns transcripts within ~200 ms.
4. The transcript is streamed to CertMate's backend, which feeds it (along with structured state and regex-extracted hints) to Anthropic Claude Sonnet 4.5 in a multi-turn conversation.
5. Sonnet returns structured certificate field values — circuit readings, observations, client / property details, regulatory codes — which are merged into the job state and rendered into the certificate UI for inspector review.
6. Photos of the consumer unit and any flagged defects are uploaded and processed by OpenAI GPT Vision for further field extraction.
7. ElevenLabs is used for occasional text-to-speech confirmation prompts ("I heard the Ze as zero point one three, confirm?").

### 1.2 Why is a DPIA needed?

The ICO's list of [criteria triggering mandatory DPIA](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/) requires a DPIA when **two or more** of nine indicators apply. CertMate's voice pipeline scores on three:

| Indicator | Why it applies |
|---|---|
| **Use of innovative technology** | Live AI extraction of safety-critical regulated data from voice in real-time is novel; no UK industry precedent for the specific combination |
| **Systematic monitoring** | Continuous audio capture during ~30–60 minute inspection inside a private residence |
| **Processing data about vulnerable individuals** | Homeowners are potentially elderly, socially housed, in council-mandated 5-year EICR cycle, or otherwise lacking equal bargaining power vis-à-vis "the electrician's AI software" |

Additional context:
- Captures personal data of identifiable third parties (homeowners + incidental family / occupants) who are not the inspector-customer
- Transfers personal data to four US-based sub-processors
- Combines voice + image + text into a single processing pipeline

### 1.3 What is the lawful basis for the processing?

| Subject | Role | Basis | Notes |
|---|---|---|---|
| Inspector | CertMate user — contracted to use the service | Art. 6(1)(b) — contract | Inspector signs Beta Tester Agreement / Subscription Agreement which includes explicit consent to recording |
| Homeowner (intentional capture: name, address read aloud) | Subject of certificate, customer of inspector | Art. 6(1)(b) — contract (inspector's contract with homeowner) **and** Art. 6(1)(f) — legitimate interest (compiling regulated safety report) | Inspector is controller; CertMate is processor |
| Third parties present (incidental voice capture) | Bystanders in the home | Art. 6(1)(f) — legitimate interest (operational necessity of dictation) | Balanced by: door script informing of recording; transcript-only retention; `mip_opt_out` on Deepgram |
| Voice as data | Inspector + B + C | Not special category — transcription only, no biometric template generation. **This is an architectural commitment** — see §4.4. |

### 1.4 Have we consulted relevant stakeholders?

| Stakeholder | Consulted? | Date | Outcome |
|---|---|---|---|
| Data Protection Lead (Derek Beckley) | Yes (self) | 2026-05-11 | Approved subject to mitigations |
| External DP consultant | `[GAP]` | — | To be engaged at Beta Tester #2 onboarding (compliance Task #5) |
| Beta testers / prospective inspector-customers | `[GAP]` | — | Informal feedback only; formal consultation when group >5 |
| Homeowner representatives (e.g. via inspector focus group) | `[GAP]` | — | Not consulted; door script is the practical mitigation; reconsider if any complaint surfaces |
| ICO | No | — | Prior consultation under Art. 36 not required because residual risks are assessed as low after mitigation; would consult if any residual risk re-scored "high" |

---

## Section 2 — Describe the processing

### 2.1 Nature of the processing

**What data is collected?**

- **Audio**: continuous PCM stream from the inspector's iOS device microphone, 16 kHz mono, for the duration of the active recording session (typically 30–60 minutes per inspection)
- **Transcripts**: text output from Deepgram including timestamps, confidence scores, and speaker turn information
- **Structured extracted fields**: client name, full address, postcode, phone, email, electrical readings (Ze, PFC, Zs, IR, RCD trip times), circuit data, observation codes, equipment ratings, etc.
- **Photographs**: of consumer units, defects, and occasionally of previous certificates / handwritten notes
- **Photo metadata**: until Task #3 ships, this includes EXIF GPS coordinates of the property — significant and being remediated

**How is data collected?**

- iOS microphone capture via `AVAudioEngine` at 16 kHz mono
- Direct WebSocket connection from iOS to `wss://api.deepgram.com/v1/listen` (Nova-3 model)
- Separate WebSocket connection from iOS to CertMate backend (`wss://.../api/sonnet-stream`) for extraction state
- iOS camera capture for photos
- HTTPS multipart upload for photos to CertMate backend

**How is data used?**

- Transcripts are matched against a regex library for instant on-device extraction (`TranscriptFieldMatcher.swift`) — yields ~40 ms field fill of high-confidence patterns
- Transcripts + regex hints are sent to CertMate backend, which forwards to Anthropic Claude Sonnet 4.5 in a multi-turn conversation with structured tools
- Sonnet returns extracted fields, observations, and clarification questions, which appear in the iOS UI and may be confirmed via TTS prompt
- Photos are sent to backend, which forwards to OpenAI GPT Vision for CCU / document extraction
- The combined extracted data is rendered into the EICR / EIC PDF and stored in S3 + RDS

**How is data stored?**

- Audio: **not persisted in normal production operation** — live WebSocket stream only, with a 3-second in-memory ring buffer on iOS for VAD wake replay. **Exception: a debug feature writes audio chunks to S3 `debug/{userId}/{sessionId}/chunk_*`** — this is being remediated under compliance Task #3.
- Transcripts: S3 `session-analytics/{userId}/{sessionId}/debug_log.jsonl` for 30 days (target) or indefinitely (current — pre-Task #3)
- Extracted data: S3 `extracted_data.json` per job; RDS `jobs.job_data` JSON column; RDS `job_versions.data_snapshot` JSONB column (audit trail)
- Photos: S3 `jobs/{userId}/{folderName}/photos/` for 7 years
- Generated PDF: S3 `jobs/{userId}/{folderName}/output/eicr_certificate.pdf` for 7 years

**How is data deleted?** See [retention-policy.md](./retention-policy.md).

### 2.2 Scope of the processing

**Geographic scope**: UK only. CertMate is currently marketed only to UK-registered electricians. All inspections are at UK addresses.

**Data subject volume (today)**: One inspector (Derek) using the app for his own jobs. No external testers running real jobs. The processor relationship has not activated.

**Data subject volume (12-month projection, conservative)**: 20–50 inspectors, each completing 5–20 jobs per month. At median: ~50 inspectors × 10 jobs/month × 12 months × 1 primary homeowner per job = **~6,000 homeowner records / year**.

**Data subject volume (12-month projection, optimistic)**: 200 inspectors at the same rate = **~24,000 homeowner records / year**.

**Duration of retention**: 7 years for cert-linked data; 30 days for operational logs; transient (sub-second to seconds) for audio.

**Categories of personal data**: standard categories (name, address, phone, email, photo of property). Not special category data.

### 2.3 Context of the processing

- **Relationship with data subjects**: Inspectors opt in via signup. Homeowners do not have a direct relationship with CertMate — only with the inspector. Awareness of CertMate by homeowners is created by the door script.
- **Public expectation**: An electrician dictating findings is a routine industry practice. The novel aspect is the AI extraction, which is invisible to the homeowner unless the inspector mentions it.
- **Power asymmetry**: Homeowners may be in council-mandated inspection cycles (5-year EICR for rental properties) and unable to refuse the inspection. They are not asked to consent to the recording specifically — the lawful basis for incidental capture is legitimate interest, with the door script as the practical mitigation.
- **Children / vulnerable persons**: family members of the homeowner may be present and incidentally captured. Children's voices may be transcribed. Mitigation: transcripts are text only; audio is not retained in production; door script can request a private dictation space if needed.
- **Public concern**: there is rising public sensitivity to AI processing of voice. The DPIA must acknowledge this and demonstrate proportionate mitigation.

### 2.4 Purposes of the processing

- **Primary**: produce a legally-required electrical inspection certificate efficiently and accurately.
- **Secondary**: reduce inspector keyboard / paper burden, allowing more focused safety inspection (i.e. the inspector's eyes stay on the consumer unit rather than on a clipboard).
- **Tertiary**: build a structured data corpus for future analytics (anonymised; not yet implemented).

**Benefit to subjects**: more accurate certificates, faster turnaround, fewer transcription errors that could mask safety issues. Indirect public-safety benefit.

---

## Section 3 — Consultation process

### 3.1 Internal consultation

Not formal — single-person team. The Data Protection Lead (Derek) is also the developer and primary user, which both simplifies (no internal disagreement to resolve) and complicates (no second pair of eyes) the assessment.

Compensating mitigation: outsourced DP consultant retainer to be engaged when tester #2 onboards (compliance Task #5).

### 3.2 External consultation

- **Beta testers**: informal feedback during onboarding will be captured; if any tester or homeowner objects to the recording, the DPIA is re-opened.
- **DPF / sub-processor due diligence**: each AI sub-processor's DPA + sub-processor list is reviewed before Task #2 sign-off.
- **Trade body** (NICEIC, NAPIT, Stroma): not consulted; their scheme rules require members to comply with UK GDPR but do not impose vendor-side requirements.

---

## Section 4 — Necessity and proportionality

### 4.1 Is the processing necessary?

For each data category, the necessity question is answered against the **primary purpose** (produce a regulated electrical certificate):

| Data | Necessary for cert? | Alternative considered |
|---|---|---|
| Inspector's dictated readings | Yes — these are the cert | Manual keyboard entry (slower; eyes off the consumer unit; safety regression) |
| Audio of dictation | Yes — for transcription | On-device-only STT (no UK provider currently has the accuracy needed for UK electrical terminology in real-time on iOS — Deepgram Nova-3 is uniquely fit; revisited annually) |
| Photographs of consumer unit | Yes — for circuit extraction + evidence | Manual circuit-by-circuit data entry (slower; error-prone) |
| EXIF GPS coordinates | **No — not necessary** | Strip before upload. Tracked under Task #3. |
| Homeowner name, address, postcode | Yes — on the cert | None — the cert has to identify the property |
| Homeowner phone, email | **Necessary only if the inspector intends to follow up.** Captured opportunistically. | Make optional; do not extract unless dictated explicitly. Current default is to capture if dictated. |
| Audio retained in `debug/*` S3 path | **No — not necessary** | Remove from prod path. Tracked under Task #3. |
| Unredacted address / client_name in CloudWatch logs | **No — not necessary** | Redact at logger or change call sites to log job IDs. Task #3. |

### 4.2 Is the processing proportionate?

The proportionality test asks whether the benefit (accurate, efficient electrical certificates with the public-safety benefit they entail) justifies the intrusion (continuous voice capture of inspection events in private homes, with incidental third-party capture).

**Assessment**: yes, **subject to the §6 mitigations being in place**. Specifically: door script, `mip_opt_out` on Deepgram, no audio retention in production, EXIF stripping, log redaction, and a published Privacy Policy + Beta Tester Agreement.

**Alternative considered**: keyboard-only data entry. Rejected because:
- Slower per-inspection (~2× time)
- Inspector eyes off the consumer unit during the safety-critical part of the inspection (regression in physical safety)
- Higher transcription error rate (digit-input on phone keypads under workshop lighting is error-prone)
- Net effect: more time per cert, more eye-off-cabinet time, and likely fewer or worse-quality safety findings. Voice extraction is a net win for the regulated purpose.

### 4.3 Data minimisation

- Audio is not retained in production (live stream only).
- Transcripts are retained 30 days for operational debug, not indefinitely.
- Photos that contain personal-identifying EXIF are remediated by stripping before upload (Task #3).
- Logs are redacted of PII (Task #3).
- Homeowner phone / email only captured if dictated by inspector — not solicited by a UI prompt.
- Cost telemetry contains no homeowner data — inspector ID only.

### 4.4 Architectural commitment — no biometric processing

CertMate **deliberately does not** generate voice templates, speaker embeddings, or any biometric representation of voice that could uniquely identify a natural person. The processing is transcription only.

This matters because:

- Crossing the line into biometric processing would put voice under UK GDPR Art. 9 (special category data), requiring **explicit consent** from every data subject (including incidental third parties — impractical) and a substantially higher mitigation bar.
- It is technically and commercially feasible to add (Deepgram supports diarisation; speaker-ID products exist). The architectural commitment is to **not** add it without re-opening this DPIA and obtaining external DP review.

This commitment is documented in:
- The Privacy Policy (data subjects know we won't do this)
- The Beta Tester Agreement (inspectors are bound to it)
- This DPIA (operational guardrail)
- Any product roadmap discussion of voice features

---

## Section 5 — Identify and assess risks

The risk register below uses ICO scoring:
- **Likelihood**: Low / Medium / High
- **Severity** (harm to data subjects): Low / Medium / High
- **Overall risk** = combination

### Risk R1 — Incidental capture of third parties (homeowners, family, other trades)

| Field | Value |
|---|---|
| Source | Inspector dictation captures voices of anyone within microphone range during a 30–60 minute inspection |
| Potential harm | Identifiable individuals (especially children, vulnerable adults) have voice content captured and transcribed without specific consent. Could include family discussions overheard. |
| Likelihood | **High** — inspections happen in occupied homes; family is usually present |
| Severity (pre-mitigation) | **Medium** — content is private but transcript-only retention means actual harm is rare; severity rises if audio is retained |
| Overall (pre-mitigation) | **High** |
| Mitigations | See M1.1–M1.4 in §6 |
| Residual likelihood | High (cannot eliminate — only mitigate) |
| Residual severity | **Low** |
| Residual overall | **Medium — accepted with door script and transcript-only retention** |

### Risk R2 — Audio sent to US sub-processor retained for model training

| Field | Value |
|---|---|
| Source | Deepgram's default Model Improvement Partnership Program retains audio for training unless explicitly opted out (`mip_opt_out=true`) |
| Potential harm | Inspector + incidental third-party voices retained on Deepgram infrastructure for indefinite training corpus use; potential for re-emergence in future model behaviour |
| Likelihood (pre-mitigation) | **High** — default account is in the MIP program |
| Severity | **Medium** — not catastrophic but a clear UK GDPR breach if uncontrolled |
| Overall (pre-mitigation) | **High** |
| Mitigations | M2.1, M2.2 |
| Residual likelihood | **Low** (flag enforced on every connection) |
| Residual severity | **Low** |
| Residual overall | **Low — accepted** |

### Risk R3 — Unredacted personal data in CloudWatch logs

| Field | Value |
|---|---|
| Source | `logger.info` calls in `src/routes/jobs.js`, `src/routes/calendar.js` and elsewhere logged raw `address`, `client_name`, `postcode` before commit `fb20dc0`. **Retention was found to be 30 days at the log-group level on verification (2026-05-11)** — the original audit incorrectly assumed indefinite retention because the setting was not in the ECS task def. |
| Potential harm | A 30-day rolling window of homeowner addresses accessible to anyone with IAM read on the log group. Less severe than the audit initially suggested (which assumed indefinite retention) but still a clear Art. 5(1)(c) (minimisation) breach until redaction shipped. |
| Likelihood (pre-mitigation) | **High** — call sites logged PII on every job-update / calendar event |
| Severity | **Low–Medium** — sensitivity of addresses, 30-day window |
| Overall (pre-mitigation) | **Medium** |
| Mitigations | M3.1 (redaction shipped — commit `fb20dc0`); M3.2 (retention already in place — verified) |
| Residual likelihood | **Low** (format-chain redaction is now the only path; logger calls cannot bypass it without explicit code change) |
| Residual severity | **Low** |
| Residual overall | **Low — accepted** |

### Risk R4 — Debug audio chunks persisted in S3 indefinitely

| Field | Value |
|---|---|
| Source | `src/routes/recording.js:892-906` writes raw audio chunks to S3 `debug/{userId}/{sessionId}/chunk_*` for debugging purposes; no lifecycle rule; not env-gated |
| Potential harm | Permanent retention of voice recordings — including inspector dictation containing homeowner / third-party voices. Direct contradiction of the "audio not retained in production" architectural claim. |
| Likelihood (pre-mitigation) | **High** — currently active in prod |
| Severity | **High** — voice is more sensitive than transcript text; identifies speakers |
| Overall (pre-mitigation) | **High** |
| Mitigations | M4.1, M4.2 |
| Residual likelihood | **Low** (env-gated off; lifecycle as belt-and-braces) |
| Residual severity | **Low** |
| Residual overall | **Low — accepted** |

### Risk R5 — EXIF GPS coordinates of properties uploaded to S3 and AI sub-processors

| Field | Value |
|---|---|
| Source | `Sources/Processing/ImageScaler.swift` re-encodes JPEGs but does not strip EXIF metadata, including GPS |
| Potential harm | Every property photo carries the precise lat/long of where it was taken. If photos leak (S3 misconfig, sub-processor breach), the data subject's home address can be derived from photo metadata even where the textual address has been redacted. |
| Likelihood (pre-mitigation) | **High** — current state |
| Severity | **Medium** — GPS adds little incremental risk on top of textual address; but it's a clean minimisation failure |
| Overall (pre-mitigation) | **High** |
| Mitigations | M5.1 |
| Residual likelihood | **Low** |
| Residual severity | **Low** |
| Residual overall | **Low — accepted** |

### Risk R6 — Transcripts containing personal data sent to Anthropic (US)

| Field | Value |
|---|---|
| Source | Extraction pipeline forwards transcript text (which contains dictated personal data) to Anthropic Claude Sonnet 4.5 |
| Potential harm | Personal data leaves UK jurisdiction; subject to US surveillance law (FISA 702). Anthropic's default API tier is non-training but operational logs may retain prompt + response for ~30 days. |
| Likelihood (pre-mitigation) | **Medium** — DPF / SCCs are the live mitigation |
| Severity | **Medium** — content is not special category but is personal |
| Overall (pre-mitigation) | **Medium** |
| Mitigations | M6.1, M6.2 |
| Residual overall | **Low — accepted** |

### Risk R7 — Photos containing personal data sent to OpenAI (US)

| Field | Value |
|---|---|
| Source | CCU and document extraction pipelines forward photographs to OpenAI GPT Vision |
| Potential harm | Photos of property interiors plus (until Task #3) GPS metadata sent to US sub-processor |
| Likelihood (pre-mitigation) | **Medium** |
| Severity | **Medium** |
| Overall (pre-mitigation) | **Medium** |
| Mitigations | M5.1 (EXIF strip), M7.1, M7.2 |
| Residual overall | **Low — accepted** |

### Risk R8 — TTS prompts containing personal data sent to ElevenLabs (US)

| Field | Value |
|---|---|
| Source | TTS confirmation prompts may include extracted personal data (e.g. "Confirming address: 1 MacArthur Close, Tilehurst") |
| Potential harm | Personal data leaves UK jurisdiction; ElevenLabs is DPF UK-Extension certified so the legal mechanism is robust, but text-string retention is plan-dependent |
| Likelihood (pre-mitigation) | **Medium** |
| Severity | **Low** — small data volume per call, and DPF UK Extension provides strong legal basis |
| Overall (pre-mitigation) | **Low** |
| Mitigations | M8.1, M8.2 |
| Residual overall | **Low — accepted** |

### Risk R9 — Web auth tokens in localStorage / non-HttpOnly cookie are XSS-readable

| Field | Value |
|---|---|
| Source | `web/src/lib/auth.ts:10-87` stores JWT in localStorage + non-HttpOnly cookie. Any XSS bug in the Next.js app would leak active session tokens. |
| Potential harm | Account takeover; downstream access to all data the inspector can see (including their homeowners) |
| Likelihood (pre-mitigation) | **Low** — Next.js apps are not common XSS targets; React's default output escaping is strong |
| Severity | **High** — full session compromise |
| Overall (pre-mitigation) | **Medium** |
| Mitigations | M9.1, M9.2 |
| Residual likelihood | **Low** (after Phase 9 HttpOnly migration) |
| Residual severity | **High** (still high if it occurs) |
| Residual overall | **Medium — accepted as residual risk pending Phase 9 migration**, flagged here so it isn't lost |

### Risk R10 — Voice processing could expand to biometric identification

| Field | Value |
|---|---|
| Source | Architectural risk: the same pipeline that does transcription could be extended to do speaker identification or speaker-ID-based authentication. Deepgram supports diarisation; voiceprint vendors exist. |
| Potential harm | If added without DPIA review, voice becomes special category data; existing data subjects' consent / legitimate-interest balancing collapses; mass-corpus retraining required |
| Likelihood (pre-mitigation) | **Low** — no current roadmap item, but technically trivial |
| Severity | **High** — would require complete re-papering of compliance |
| Overall (pre-mitigation) | **Medium** |
| Mitigations | M10.1 (architectural commitment in §4.4) |
| Residual overall | **Low — accepted** |

### Risk R11 — AI extraction error / hallucination propagates into safety-critical certificate data

| Field | Value |
|---|---|
| Source | Sonnet / GPT can mis-extract or hallucinate values; if not caught at inspector review, a flawed cert is issued |
| Potential harm | Not strictly a data protection risk under UK GDPR — but it is a **safety risk** with downstream data protection consequences (a homeowner relies on the cert; a child is injured; the cert is interrogated and CertMate's role is exposed). The Privacy Policy and Beta Tester Agreement must clearly position CertMate as a dictation aid, not an authority. |
| Likelihood (pre-mitigation) | **Medium** — at current Sonnet accuracy ~95–98% per field |
| Severity | **High** — could result in physical injury or loss |
| Overall (pre-mitigation) | **High** |
| Mitigations | M11.1, M11.2, M11.3 |
| Residual overall | **Medium — accepted with inspector-review-required architecture** |

### Risk R12 — No self-serve SAR / erasure mechanism

| Field | Value |
|---|---|
| Source | Subject-rights requests are handled manually; no `/api/me/export` or `/api/me/delete` endpoints |
| Potential harm | Delay or error in fulfilling Art. 12–22 rights; potential complaints to ICO |
| Likelihood (pre-mitigation) | **Low** at current scale (no requests received to date); rises with volume |
| Severity | **Low–Medium** — main risk is reputational + ICO time-bound response |
| Overall (pre-mitigation) | **Low** |
| Mitigations | M12.1, M12.2 |
| Residual overall | **Low — accepted, with build planned before passing ~20 paying customers** |

### Risk R13 — Inspector account compromise → access to all linked homeowner data

| Field | Value |
|---|---|
| Source | An inspector account compromised via password reuse, phishing, or device theft exposes all their job history including every homeowner record |
| Potential harm | Mass leak of homeowner personal data from one inspector's portfolio (potentially hundreds of homes over several years) |
| Likelihood (pre-mitigation) | **Medium** — sole-trader electricians may not have strong credential hygiene; no MFA enforcement on user accounts today |
| Severity | **High** — large data subject volume per incident |
| Overall (pre-mitigation) | **High** |
| Mitigations | M13.1, M13.2, M13.3 |
| Residual overall | **Medium — accepted with MFA roadmap and breach response playbook** |

### Risk R14 — Long retention (7 years) creates a large attack surface

| Field | Value |
|---|---|
| Source | NICEIC scheme requires 6-year cert retention; CertMate aligns to 7. Over the years, the volume of stored personal data grows linearly with usage. |
| Potential harm | A breach in year 5 exposes 5 years of data — far more than a 30-day retention would. |
| Likelihood | Constant background |
| Severity | Scales with time |
| Overall | **Medium** (acceptable given the regulatory necessity for the retention period — cannot be reduced without breaching scheme rules) |
| Mitigations | M14.1, M14.2 |
| Residual overall | **Medium — accepted, mitigation = strong perimeter + encryption + monitoring** |

---

## Section 6 — Mitigations

Each mitigation is keyed to one or more risks (R-) above and to the operational task that implements it (T-).

| # | Mitigation | Risks addressed | Status |
|---|---|---|---|
| **M1.1** | **Door script.** A one-paragraph script — bundled with the iOS app and on a printed card — that the inspector reads or shows to the homeowner before recording starts. Sample wording: *"I record my dictation so the system can transcribe my readings — voice goes to a UK-based service and no audio is kept once the report is generated. You may want to step into another room if you'd prefer not to be recorded."* | R1 | Drafted in Phase 4 (compliance Task #8) |
| M1.2 | **Inspector consent screen** at first launch + at each session start. Required tap acknowledging the door-script obligation. Logged with timestamp. | R1 | Drafted in Phase 4 |
| M1.3 | **Audio not persisted in production** — live stream to Deepgram only; 3-second in-memory ring buffer on iOS for VAD wake. | R1, R4 | In place except for the `debug/*` path (R4) being closed under Task #3 |
| M1.4 | **Transcript retention capped at 30 days.** | R1 | Pending Task #3 (S3 Lifecycle rule on `debug_log.jsonl`) |
| **M2.1** | **Set `mip_opt_out=true`** as a URL parameter on every Deepgram WebSocket connection. Single change in iOS `DeepgramService.swift` and web `deepgram-service.ts`. | R2 | Pending compliance Task #3 |
| M2.2 | **Sign Deepgram DPA** with UK Addendum to SCCs in place. | R2, R6 (DPF mechanism) | Pending compliance Task #2 |
| **M3.1** | **Redact personal data in logger calls** via Winston format-chain redaction in `src/logger.js`. PII_FIELDS set covers `address`, `client_name`, `clientName`, `postcode`, `postCode`, `client_phone`, `clientPhone`, `client_email`, `clientEmail`. Format-chain placement means it applies to every existing and future call site without per-site refactoring. | R3 | **Shipped commit `fb20dc0` (2026-05-11). 8 tests passing.** |
| M3.2 | **30-day CloudWatch retention** on all `/ecs/eicr/*` log groups. | R3 | **Already in place — verified 2026-05-11 via `aws logs describe-log-groups`.** Set at log-group level, not in ECS task def. |
| **M4.1** | **Env-gate the `debug/` S3 write** so it only runs when `ENABLE_DEBUG_AUDIO=true` (default false in production). | R4 | Pending Task #3 |
| M4.2 | **S3 Lifecycle rule on `debug/*`** with 7-day expiry as belt-and-braces. | R4 | Pending Task #3 |
| **M5.1** | **Strip EXIF metadata** before upload in `Sources/Processing/ImageScaler.swift`. Use `CGImageDestination` with an empty metadata dictionary. | R5, R7 | Pending Task #3 |
| **M6.1** | **Use Anthropic Commercial Terms tier** (DPA auto-incorporated; non-training; UK Addendum to SCCs). | R6 | Pending Task #2 |
| M6.2 | **Sub-processor transparency.** Privacy Policy + Sub-processor List names Anthropic explicitly with link to their DPA and DPF status. | R6 | Drafted in Phase 3 (Task #7) |
| **M7.1** | **Verify OpenAI API retention tier.** Default 30-day; upgrade to Zero Data Retention if budget allows for higher-volume / enterprise contract. | R7 | Pending Task #2 |
| M7.2 | **Strip EXIF before sending to OpenAI** (same as M5.1). | R7 | Pending Task #3 |
| **M8.1** | **Sign ElevenLabs DPA**; rely on UK Extension to DPF as primary transfer mechanism. | R8 | Pending Task #2 |
| M8.2 | **Enable ElevenLabs Zero Retention Mode** if available on plan. | R8 | Pending Task #2 |
| **M9.1** | **Plan migration to HttpOnly cookie** for JWT storage on web (currently `web/src/lib/auth.ts` comment says Phase 9). | R9 | Roadmap — not blocked on launch |
| M9.2 | **Document the residual XSS risk** in the Privacy Policy and Beta Tester Agreement so inspectors know not to share workstations. | R9 | Drafted in Phase 3 + 4 |
| **M10.1** | **Architectural commitment** documented in §4.4: voice is for transcription only, no biometric template generation. Reopen this DPIA if the commitment is ever revisited. | R10 | In place (this DPIA records it) |
| **M11.1** | **Inspector-review-required architecture.** No certificate is issued until the inspector explicitly reviews and confirms each extracted field. | R11 | In place — UI design choice |
| M11.2 | **Privacy Policy / Beta Agreement positioning.** CertMate is a dictation aid; inspector is the authority. | R11 | Drafted in Phase 3 + 4 |
| M11.3 | **In-app disclaimer** when reviewing extracted values reading "AI-extracted; review carefully." | R11 | Existing — verify wording is clear in iOS review screen |
| **M12.1** | **Manual SAR / erasure playbook** (Phase 5 — Task #9). | R12 | Drafted in Phase 5 |
| M12.2 | **Self-serve `/api/me/export` and `/api/me/delete`** built before scaling past ~20 paying customers. | R12 | Future phase |
| **M13.1** | **Enforce strong password policy** at signup (length 12+, no dictionary; future: leak-database check). | R13 | Roadmap |
| M13.2 | **Offer MFA on user accounts** (TOTP). Make mandatory for paid tier when launched. | R13 | Roadmap |
| M13.3 | **Anomaly detection on login.** Failed-login lockout already in place (`users.failed_login_attempts`, `users.locked_until`). Geo-IP / device-fingerprint anomaly detection at scale. | R13 | Partial (lockout exists) |
| **M14.1** | **Defence in depth.** S3 default encryption (SSE-S3); RDS encryption at rest; private subnets; ALB + WAF; AWS Secrets Manager for all credentials. | R14 | In place |
| M14.2 | **Annual backup verification + tabletop exercise.** Restore a non-prod copy from RDS PITR + S3 versioning; verify integrity; run an incident-response scenario. | R14 | Roadmap |

---

## Section 7 — Outcomes and sign-off

### 7.1 Residual risk summary

| Risk | Pre-mitigation | Post-mitigation | Acceptable? |
|---|---|---|---|
| R1 — incidental third-party capture | High | Medium | **Yes — accepted with door script** |
| R2 — Deepgram model training | High | Low | Yes |
| R3 — unredacted logs | High | Low | Yes (post-Task #3) |
| R4 — debug audio retention | High | Low | Yes (post-Task #3) |
| R5 — EXIF GPS | High | Low | Yes (post-Task #3) |
| R6 — Anthropic transfer | Medium | Low | Yes |
| R7 — OpenAI photo transfer | Medium | Low | Yes |
| R8 — ElevenLabs TTS transfer | Low | Low | Yes |
| R9 — web auth XSS | Medium | Medium | **Yes — flagged residual, mitigated by Phase 9 roadmap** |
| R10 — biometric expansion | Medium | Low | Yes (architectural guardrail) |
| R11 — AI extraction error | High | Medium | Yes — inspector review is the safety net |
| R12 — manual SAR process | Low | Low | Yes |
| R13 — inspector account compromise | High | Medium | Yes — MFA roadmap is the residual mitigation |
| R14 — long retention attack surface | Medium | Medium | Yes — regulatory necessity, mitigated by defence in depth |

### 7.2 Conclusion

The processing **may proceed** subject to the following gating conditions:

1. **Compliance Task #2 (sub-processor DPAs)** completed before tester #2 onboards. The pipeline cannot operate compliantly without all four AI vendor DPAs in place.
2. **Compliance Task #3 (Phase 1 technical fixes)** completed before tester #2 onboards. Specifically: `mip_opt_out` set, `debug/*` audio path closed, EXIF stripped, CloudWatch retention configured, log redaction in place.
3. **Phase 4 documents** (Beta Tester Agreement, in-app consent screen, door script) drafted, reviewed, and signed by tester #2 before they run their first real homeowner job.
4. **DPIA review** by an external DP consultant (compliance Task #5) before passing 10 paying inspectors.

Where any gating condition is unmet, the processing must be suspended for that inspector-customer or limited to Derek's own use only.

### 7.3 Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Data Protection Lead | Derek Beckley | 2026-05-11 | `[DRAFT — TO SIGN]` |
| External DP consultant | `[GAP]` — to be engaged | — | — |

### 7.4 Review triggers

This DPIA must be reviewed and re-signed when:

- Any new sub-processor is added to the pipeline
- Any existing sub-processor changes its retention or DPF / SCCs status
- A new feature crosses into biometric processing of voice or face (re §4.4 / R10)
- A material breach or near-miss occurs
- Annually (rolling), with the next review by **2027-05-11**
