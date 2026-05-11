---
title: CertMate Internal Breach Register
status: live register — append-only
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
visibility: internal — not published publicly
related: ../incident-response-runbook.md
---

# Internal Breach Register

This is the authoritative log of every personal-data incident affecting CertMate, **whether or not** it required ICO or data-subject notification. UK GDPR Article 33(5) requires every controller to document any personal-data breach, including its facts, effects, and remedial action — that obligation is satisfied by this register.

## Logging policy

Add a row for **every** incident handled under the [Incident Response Runbook](../incident-response-runbook.md), including:

- P1 / P2 / P3 / P4 classifications — even P4 (false alarm) gets logged so the audit trail shows the assessment was made
- Tabletop exercises (use the same format; mark `Tabletop?` as Yes)
- Sub-processor notifications received from Anthropic / OpenAI / Deepgram / ElevenLabs / AWS / Apple / GitHub

Entries are **append-only**. Errors are corrected by appending a "correction" row that references the original.

## Schema

| Field | Notes |
|---|---|
| **ID** | `INC-YYYY-NNN` — running incrementally per year |
| **Detected at** | UTC timestamp when the incident was first noticed by anyone, even if escalation came later |
| **Reported by** | Source — automated alert, inspector report, sub-processor notification, AWS notification, internal audit |
| **Description** | Single paragraph, factual |
| **Classification** | P1 / P2 / P3 / P4 / Tabletop |
| **Categories of data affected** | E.g. inspector account data, homeowner contact, photos, transcripts. "None" for false-alarm or service-only incidents. |
| **Approx. number of data subjects** | Best estimate at time of close; can be a range |
| **Containment actions** | Pointer to the commands run from the Incident Response Runbook §4 toolkit |
| **Notification: Controller** | Date sent (for processor-side incidents), N/A otherwise |
| **Notification: ICO** | Date sent / N/A with reason |
| **Notification: Data Subjects** | Date sent / N/A with reason |
| **Closed at** | UTC timestamp when the post-mortem completed and any follow-up actions were filed |
| **Root cause** | One-paragraph summary; full detail in the post-mortem document |
| **Post-mortem link** | Relative path under `../incidents/` |

## Register

> **Empty — no incidents have occurred. Tabletop exercises will populate rows here when they are run.**

| ID | Detected at (UTC) | Reported by | Description | Class | Data categories | Subjects | Containment | Controller notif | ICO notif | Subjects notif | Closed at | Root cause | Post-mortem |
|----|-------------------|-------------|-------------|-------|-----------------|----------|-------------|------------------|-----------|----------------|-----------|------------|-------------|
| _(no rows yet)_ | | | | | | | | | | | | | |
