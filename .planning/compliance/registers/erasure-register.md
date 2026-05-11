---
title: CertMate Subject Rights Request Register
status: live register — append-only
last_verified: 2026-05-11
maintainer: Derek Beckley (Data Protection Lead)
visibility: internal — not published publicly
related: ../sar-erasure-playbook.md
---

# Subject Rights Request Register

This is the authoritative log of every UK GDPR rights request received by CertMate, regardless of outcome. Despite the filename ("erasure register"), this single register covers **all** rights — access, rectification, erasure, restriction, portability, objection, and Art. 22 automated-decision-related rights — because they share the same one-month statutory clock and the same operational playbook.

## Logging policy

Add a row for **every** request, including:

- Requests fulfilled in full
- Requests fulfilled partially (e.g. erasure refused for the in-retention portion)
- Requests refused entirely
- Requests withdrawn by the data subject
- Tabletop exercises (mark `Tabletop?` as Yes)

Entries are **append-only**. Status changes (e.g. from "verifying identity" to "fulfilled") are recorded as additional rows referencing the same `REQ-` ID.

## Schema

| Field | Notes |
|---|---|
| **ID** | `REQ-YYYY-NNN` — running incrementally per year |
| **Received at** | UTC timestamp when the request arrived (any channel) |
| **Channel** | E.g. `privacy@certmate.uk`, support inbox forward, postal |
| **Subject** | Verified subject identity once verification is complete; before that "unverified — [self-reported description]" |
| **Subject category** | Inspector / Homeowner / Previous-cert third party / Unknown |
| **Right exercised** | Access / Rectification / Erasure / Restriction / Portability / Objection / Art. 22 |
| **Statutory deadline** | Received-at + 1 calendar month, less any stop-the-clock time |
| **Acknowledgement sent** | UTC date — within 5 working days |
| **Identity verification** | Method used + UTC date completed |
| **Action taken** | E.g. "ZIP export emailed", "RDS rows + S3 prefix deleted", "refused under Art. 17(3)(b)" |
| **Outcome** | Fulfilled / Partially fulfilled / Refused / Withdrawn |
| **Refusal grounds (if applicable)** | Specific UK GDPR article cited + plain-English reason |
| **Response sent at** | UTC timestamp |
| **Follow-up needed** | Diary date for any onward action (e.g. coordinating with a Sub-processor); blank if none |
| **Notes** | Anything material that doesn't fit elsewhere |

## Register

> **Empty — no requests have been received. Tabletop exercises will populate rows here when they are run.**

| ID | Received | Channel | Subject | Category | Right | Deadline | Acked | ID verified | Action | Outcome | Refusal grounds | Response sent | Follow-up | Notes |
|----|----------|---------|---------|----------|-------|----------|-------|-------------|--------|---------|-----------------|---------------|-----------|-------|
| _(no rows yet)_ | | | | | | | | | | | | | | |
