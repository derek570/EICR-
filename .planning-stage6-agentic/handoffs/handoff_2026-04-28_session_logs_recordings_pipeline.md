# Handoff — 2026-04-28 — Recording-pipeline reading-loss fixes

## TL;DR

Long debugging session — analysed three field-test recordings, found a chain of bugs that prevented voice-dictated readings from landing in the iOS UI, and shipped **9 focused fixes** (backend + iOS) across the day. **All deployed.** The next session should start by pulling the latest session log and confirming the new behaviour holds, then move to whatever the next field-test surfaces.

## Sessions analysed today (newest last — pull these for any next-day context)

| Session | Time (UTC) | Job | Symptom |
|---|---|---|---|
| `A354882B-43DF-4325-9827-17CDD66B844F` | 08:35 | 19 Ivydene Road | "200 and 50" cascade; ring-continuity decode failure |
| `03CE342D-3706-42A0-9BFD-1A05F685AC39` | 07:33 | Wylex NHRS12SL | "Circuit 2 (Cooker) doesn't appear in active schedule" — empty stateSnapshot |
| `08469BFC-FBD3-48E7-9F0E-D4E1A38010F0` | 11:28 | Gen test job | Two consecutive TTS interruptions chopped a full ring-continuity sentence |
| `B200FF05-B59B-454D-8183-F3EEE06CCB4B` | 12:28 | Job - 28 Apr 1:22 pm | CCU missed Kitchen Sockets; values lost while creating C9 |

S3 prefix for any session: `s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/<sessionId>/` — `manifest.json`, `debug_log.jsonl`, `job_snapshot.json`, `field_sources.json`.

## Fixes shipped today (chronological)

| # | What | Repo | Commit |
|---|---|---|---|
| 1 | `_seedStateFromJobState` seeds metadata so CCU-imported circuits exist in stateSnapshot before any reading | backend | `c2eab9a` (merged via `49af857`) |
| 2 | Stage-6 observation rename (`text→observation_text` etc.) + field-name aliases for new schema names | backend | `e57fffe` |
| 3 | iOS `CircuitDerivations` for Zs ↔ R1+R2 ↔ Ze (deterministic, no prompt engineering) | iOS | `18a03d7` |
| 4 | NumberNormaliser handles "two hundred and fifty" → "250" | iOS | `11a5e75` |
| 5 | Stage-6 `resolveValueAnswer` — server auto-emits `record_reading` when ask_user with context_field+context_circuit gets a numeric answer | backend | `07338b9` |
| 6+8 | Prompt: TOPIC RESTRAINT, verbal-without-write anti-pattern, create-before-rename | backend | `fa728de` (squashed) |
| 7 | iOS `monitorPostWakeTranscript` suppresses "repeat that" when user mid-utterance | iOS | `2cc8995` |
| 9 | NumberNormaliser accepts "nil" as zero-word (Deepgram mishearing of "naught") | iOS | `f2151c1` |
| 10+11+12 | Prompt: topic→circuit carryover; immediate-create on unknown name; cross-ask value accumulation | backend | `6542836` |

Backend lives at `eicr-backend:79` (and any newer rev triggered by today's pushes). iOS shipped as TestFlight builds **313 → 316 → 318 → 319** in succession; **319** is the last and contains every iOS fix.

## What's STILL not fixed

- **CCU missing circuits** — the photo extraction missed "Kitchen Sockets" on a Wylex board (session B200FF05). Image-side problem, no code change attempted today. Worth re-running the same photo through the per-slot pipeline manually to see if it's deterministic or a one-shot lapse.
- **iOS local "repeat that" still uses `SpeechStarted`** — works for the field-test repro but `SpeechStarted` is "noisy" (HVAC, breath). If false suppressions become a problem, swap for a more reliable signal.
- **Pending-write pool** — Fix #12 is prompt-only ("the model accumulates values across an in-flight ask"). It relies on the model holding state in its message history. A more robust server-side accumulator could be added later if the prompt rule fails to hold.

## Architecture surfaces touched (reference paths)

- `src/extraction/eicr-extraction-session.js:943` — `_seedStateFromJobState`
- `src/extraction/stage6-shadow-harness.js:85-122` — `renameObservationsForLegacyWire`
- `src/extraction/stage6-answer-resolver.js:535-` — `resolveValueAnswer`
- `src/extraction/stage6-dispatcher-ask.js` — `buildResolvedBody` with value-resolve branch
- `src/extraction/sonnet-stream.js:670-688` — extended `FIELD_CORRECTIONS`
- `config/prompts/sonnet_agentic_system.md` — TOPIC RESTRAINT, anti-patterns, examples 5b/5c
- `CertMateUnified/Sources/Processing/CircuitDerivations.swift` — derivation helper
- `CertMateUnified/Sources/Recording/NumberNormaliser.swift` — compound-hundreds + "nil"
- `CertMateUnified/Sources/Recording/RecordingSessionCoordinator.swift:560-616` — post-wake monitor with mid-utterance guard

## Test commands

```bash
# Backend
cd /Users/derekbeckley/Developer/EICR_Automation
node --experimental-vm-modules node_modules/jest/bin/jest.js src/__tests__/stage6-agentic-prompt src/__tests__/stage6-prompt src/__tests__/stage6-answer-resolver src/__tests__/stage6-dispatcher-ask
# 625 tests across 11 suites all green as of today

# iOS
xcodebuild build -scheme CertMateUnified -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
# No working simulator runtime locally; build verifies compile-time only
```

## Deploy commands

```bash
# Backend (CI via push to main, ~13-14 min):
git push origin main

# iOS:
cd CertMateUnified && ./deploy-testflight.sh
# Auto-bumps build number, archives, uploads, adds to Electricians group, submits for beta review
```

## How to validate the fixes worked

Pull the next field-test session log and check for these positive signals:

1. `Seeded stateSnapshot with N circuits from jobState` log line at session start (Fix #1).
2. `stage6.ask_user_value_auto_resolved` log rows when the inspector answers a value-ask numerically (Fix #5).
3. **Absence** of an `ask_user` immediately after a topic-only utterance (Fix #6/8).
4. **Absence** of `Sorry, could you repeat that?` TTS while the inspector is mid-sentence (Fix #7).
5. **Absence** of `server_ws_decode_error: "Failed to decode extraction result"` (Fix #2).
6. When the inspector names a circuit not on the schedule, look for an immediate `create_circuit` rather than a "which existing circuit?" ask (Fix #11).

## Useful one-liners for the next session

```bash
# Most-recent session for this user
aws s3api list-objects-v2 --bucket eicr-files-production \
  --prefix "session-analytics/82b54893-220d-49f5-8c55-d677a009787b/" \
  --query "sort_by(Contents,&LastModified)[?ends_with(Key,'manifest.json')] | [-5:].[LastModified,Key]" \
  --output text --region eu-west-2

# Pull a session
sid=<SESSIONID>
mkdir -p /tmp/sess_$sid
for f in manifest.json debug_log.jsonl job_snapshot.json field_sources.json; do
  aws s3 cp s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/$sid/$f /tmp/sess_$sid/ --region eu-west-2
done
```

## Context window note

Today's session ran the context window to ~78% by end-of-day; that's why this handoff was written. A fresh window can start by reading this file then pulling the latest session log.
