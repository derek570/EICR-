> Last updated: 2026-02-19
> Related: [Architecture](architecture.md) | [Field Reference](field-reference.md) | [Deployment](deployment.md) | [File Structure](file-structure.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# iOS Recording Pipeline — v3 (Feb 2026)

## Architecture

The iOS app connects directly to Deepgram for transcription and uses a server-side WebSocket for Sonnet extraction. Silero VAD is used only for auto-sleep wake detection (not during active recording).

```
iOS (16kHz PCM audio)
       │
       ├──► DeepgramService.swift (direct wss://api.deepgram.com/v1/listen)
       │         │  Nova-3, en-GB, smart_format, punctuate, interim_results
       │         │  endpointing=300, utterance_end_ms=1300
       │         │
       │◄── transcript words (final + interim)
       │
       ├──► NumberNormaliser.swift ("nought point two seven" → "0.27")
       │
       ├──► TranscriptFieldMatcher.swift (instant regex ~40ms)
       │         │  30+ patterns for supply, board, installation fields
       │         │  Populates fields with .regex source
       │
       ├──► SleepManager.swift (auto-sleep state machine)
       │         │  Active → Dozing (60s silence) → Sleeping (5min)
       │         │  Silero VAD wake detection + AudioRingBuffer (3s)
       │
       └──► ServerWebSocketService.swift (wss://<backend>/api/sonnet-stream)
              │  Sends transcripts + regex hints + job state to backend
              │
              └──► Backend: eicr-extraction-session.js (multi-turn Sonnet 4.5)
                     │  Full session context, prompt caching (1hr TTL),
                     │  conversation compaction, 5min session timeout
                     │
                     └──► Extraction results + questions + cost updates back to iOS
```

**Field priority (3-tier):** Pre-existing (CCU photo, manual edit) > Sonnet > Regex

**API keys:** iOS fetches the Deepgram streaming key from `POST /api/proxy/deepgram-streaming-key` (authenticated). Anthropic and ElevenLabs calls are proxied through the backend — API keys never leave the server (loaded from `eicr/api-keys` in AWS Secrets Manager).

**Key files:**

| File | Purpose |
|------|---------|
| `CertMateUnified/.../DeepgramRecordingViewModel.swift` | iOS recording VM — orchestrates full pipeline |
| `CertMateUnified/.../DeepgramService.swift` | Direct WebSocket to Deepgram Nova-3 |
| `CertMateUnified/.../ServerWebSocketService.swift` | WebSocket client to backend Sonnet extraction |
| `CertMateUnified/.../NumberNormaliser.swift` | Spoken number → digit conversion |
| `CertMateUnified/.../KeywordBoostGenerator.swift` | Board photo data + remote config → Deepgram keyword boosts |
| `CertMateUnified/.../DebugLogger.swift` | JSONL per-session debug logging |
| `CertMateUnified/.../AlertManager.swift` | Validation alerts (voice + visual) during recording |
| `src/sonnet-stream.js` | Backend WebSocket session manager |
| `src/eicr-extraction-session.js` | Multi-turn Sonnet conversation + compaction |
| `src/api.js` (`GET /api/keys`) | Backend endpoint to serve API keys to iOS |
| `src/secrets.js` | Loads Deepgram + Anthropic keys from AWS Secrets Manager |
| `CertMateUnified/.../SleepManager.swift` | Auto-sleep state machine (Active/Dozing/Sleeping) |
| `CertMateUnified/.../AudioRingBuffer.swift` | 3s ring buffer for zero word loss on wake |
| `CertMateUnified/.../TranscriptFieldMatcher.swift` | Instant regex extraction (30+ patterns) |

**Server-side Sonnet extraction:** Multi-turn conversation with `claude-sonnet-4-5-20250929`. Prompt caching (system prompt cached at ≥1024 tokens), conversation compaction at ~6000 tokens. Returns `RollingExtractionResult` with structured certificate fields.

**Remote config:** `RemoteConfigService.swift` + `Resources/default_config.json` — keyword boosts and validation rules can be updated without app rebuild.

---

## Wire contract — response epoch (PLAN-C chime-silence watchdog)

The client chime-silence watchdog (Phases 5/6) arms a timer when a processing chime fires for an utterance and disarms it when a matching spoken output plays back. To correlate the two, server-emitted **speech** frames carry an **optional `utterance_id`** — the *response epoch*: the id of the utterance the spoken output is a reply to.

- **P4c (answer side):** post-answer `confirmations[]` carry the epoch of the utterance that *answered* an open ask (advance-only-on-non-empty).
- **P4d (question side):** `ask_user_started` (dialogue-engine + dispatcher initial/pvr), legacy `question`, and `voice_command_response` frames carry the **creation-time** epoch of the arming utterance. Also carried on the reconnect-replay `voice_command_response` (a buffered `spoken_response` now replays as a separate frame, stripped from the extraction replay).

Rules: the epoch is snapshotted at frame **creation** (never re-read from mutable session state at emit time); `utterance_id` is stamped **only for a non-empty string** epoch, so a no-epoch frame is byte-identical to the pre-P4c/P4d wire. `turn_id` remains a reserved/optional telemetry field (not populated by P4d). All fields are additive-optional — clients that ignore them behave exactly as before; the client watchdog is gated behind the P4b `session_ack speech_epochs: 1` capability. THE doc of record for the full frame catalogue is the `certmate-voice-wire-protocol` skill.

---

## Confirmation read-back dedupe key (client-side; value-aware since id-84)

The spoken read-back loop suppresses a *duplicate* confirmation via a per-client dedupe key computed from the wire `Confirmation`. The key is computed CLIENT-side (iOS `buildConfirmationDedupeKey`, web `confirmation-dedupe-key.ts`); the backend `src/extraction/ios-dedupe-key.js` is a **telemetry-only mirror** that reproduces the same key so the `ios_send_attempt` `expected_dedupe_key` row reconciles byte-for-byte against client reality — it is NOT a wire field.

Three key shapes:

| Shape | Key | When |
|-------|-----|------|
| per-circuit  | `{field}_{circuit}_{djb2(text)}` | a single-circuit reading confirmation |
| multi-circuit | `{field}_{sortedCircuits.join('-')}_{djb2(text)}` | a grouped broadcast (`circuit:null`, `circuits:[…]`) |
| degenerate | `{field}_{djb2(text + boardId)}` | board-level / supply / installation (no circuit) |

For the five text-op fields (`circuit_op`, `observation`, `observation_deletion`, `field_cleared`, `circuit_designation`) a backend-stamped `dedupe_token` takes precedence in EVERY branch (`{field}_{dedupe_token}`), so identical-text REPEATS of DISTINCT operations don't collide (field-feedback-2026-07-14 §A1a).

> **id-84 (2026-07-24) — value-aware single-circuit key.** The per-circuit shape was previously value-LESS (`{field}_{circuit}`) and kept that way deliberately so the iOS local correction-TTS dedupe could cross-match wire keys. But because field read-back keys are session-**permanent**, a spoken correction (a second reading on the same field+circuit with a DIFFERENT value) collided with the original key forever and was **silently swallowed** — beep-then-silence on a successful correction (session 2ACE7677: "No. It was 0.63." spoke nothing). Fix: fold djb2 of the confirmation TEXT (which encodes the value) into the single-circuit key, matching the multi-circuit branch. A correction (different text) now yields a distinct key and speaks; a genuine duplicate (same field+circuit+SAME text — e.g. the model re-recording circuit 4) still dedupes. The correction-TTS cross-match is **intentionally dropped** (worst case an extra local read-back, never silence). Derek's decisions: TEXT-HASH (not a direct value in the key, which would need wire/decoder changes), and NO new field-key TTL. iOS adds the twin fix to its own client-initiated `correctionDedupeKey`, plus the id-87 fast-path double-read-back suppression (fast clip + bundler safety-net now share a VALUE- and effective-board-aware suppression identity). Parity: `web/docs/parity-ledger.md` `recording/readback-dedup-value-aware`.

---

## Backend transcript normalisation (P6 — canonical ingest layer)

> Added 2026-07-24 (feedback ids 89 + 80A). Backend-only, **zero wire change**.

There is now ONE canonical normalisation layer for the raw dictation transcript, applied at the backend ingest in `src/extraction/sonnet-stream.js`. `src/extraction/transcript-normalise.js` is a pure, enumerated `normalise(text) → {text, rules_hit[]}` with **two evidence-backed rules** (word-boundary, pattern-anchored — **no fuzzy/edit-distance**, per §3E + the research-methodology ban):

| Rule ID | Rewrite | Notes |
|---------|---------|-------|
| `a_hundred` | `"a hundred"` → `"100"` | The article word-number (iOS/web digit-ise `"one hundred"` + compounds, not `"a hundred"`). Compound guard: `"a hundred and fifty"` is left UNTOUCHED (out of scope, no corruption). Runs FIRST so its digit output satisfies the `zs_field_token` gate. |
| `zs_field_token` | `"Z s"`/`"Zed s"`/`"zed s"` → `"Zs"` | **Context-gated** on a reading-shaped same-clause (connector/scope word + numeric-or-sentinel value) so genuine two-letter dictation (`"Z S Electrical"`, `"designation Z S 1"`, spelled postcodes) is NOT collapsed. |

**Origin:** id 89 (`"Z s on the heating was 0.67"`) failed to anchor because `reading-transcript-anchor.js` looks for the substring `"zs"`, which spaced `"z s"` misses; id 80A (`"A hundred MΩ"`) failed to parse because the word-number produced no digit.

### Raw/canonical split (do NOT mutate `msg.text`)

`msg.text` is **never mutated** — a canonical COPY is derived and threaded to model-facing/behavioural consumers, so the recorded-corpus fixtures + the reverse-race dedupe keys keep the raw garble (a future replay must reproduce the bug, not mask it). There is no live raw-transcript S3 sink on this path (only `cost_summary.json` is uploaded); the authoritative raw artifacts for future replays are the RAW literals pinned in the unit + production-ingress tests plus the field-feedback records (sessions 2ACE7677 / 36731498). No P6 `.yaml` corpus fixture was added — the production-ingress test is the load-bearing raw→canonical proof.

Applied at **two seams**, with this consumer routing table:

| Seam | CANONICAL (canonical copy) | RAW (unchanged) |
|------|----------------------------|-----------------|
| **A — `handleTranscript`** (top, after the `isStopping` guard) | both content anchors (recentAskAnswers consult + recentTranscripts push), the pre-LLM gate, BOTH `classifyOvertake` calls (pre-queue + transcript-overtake — the latter stays **un-annotated**), `detectStructuredReading`, the model-bound `transcriptText` (incl. the `in_response_to` annotation), the three dialogue-script `rawReplyText` args (normalised but **un-annotated**), `runShadowHarness` | `msg.text`; exact-dedupe on `utterance_id`; log previews (`.slice(0,80)`) |
| **B — `ask_user_answered`** | **Behavioural (model-facing) consumers** use `canonicalAnswerText` (= normalise of the POST-sanitisation text): the `classifyOvertake` shape check, the new-command gate, `detectStructuredReading`, `resolvePayload.user_text`, the re-injected synthetic transcript. **Dedupe-ledger ops** (the pre-sanitisation reverse-race lookup AND the recentAskAnswers anchor push) use one raw-based `canonicalUserTextForAnchor` (= normalise(`msg.user_text`)) so their keys match Seam A's raw-based transcript stamp in either arrival order — even for a truncated/control-stripped answer. | `sanitiseUserText` runs on RAW `msg.user_text` (length/truncation semantics unchanged); raw previews + sanitisation flags |

**Both content anchors are canonical on BOTH seams** so cross-seam dedupe equality holds in either arrival order (no double-exposure). The re-injected synthetic transcript is already canonical, so Seam A re-normalises it to a no-op.

**Telemetry:** `stage6.transcript_normalised { rules_hit, seam }` (rule IDs ONLY — never the raw/canonical text; leak-filter). At Seam A the result is stashed on a JSON-invisible `Symbol` so the isExtracting queue/drain + `user_moved_on` re-entries reuse it and log EXACTLY once per message.

**Incidental INFO-log previews** (engine / dispatcher-logger) that derive from the now-canonical vars MAY read canonical — that is the documented, pinned behaviour (the load-bearing raw requirement is only the debug/corpus capture boundary, which has no live sink here).

**Web:** zero wire change; web transcripts flow through the same backend ingest, so web benefits identically. The web client-side regex fast-hint tier still sees raw text (acceptable — Sonnet overwrites).

**Key files:** `src/extraction/transcript-normalise.js` (pure rules), `src/extraction/sonnet-stream.js` (the two seams), `src/__tests__/transcript-normalise.test.js` (unit), `src/__tests__/sonnet-stream-transcript-normalise-ingress.test.js` (the raw→canonical ingress proof for both seams — the direct replay runner bypasses these seams), `src/__tests__/sonnet-stream-transcript-normalise-ir-realengine.test.js` (drives the REAL insulation-resistance dialogue engine end-to-end through `handleTranscript` and asserts it records `ir_live_live_mohm=100` from a raw "A hundred megaohms").

---

## Auto-Sleep (Deepgram Power Saving)

Prevents wasted Deepgram billing when the inspector stops speaking. Three-tier state machine:

| State | Trigger | Deepgram WS | Sonnet Session | Visual |
|-------|---------|-------------|---------------|--------|
| **Active** | Recording started | Connected, streaming | Active | Red dot |
| **Dozing** | 60s silence | Connected, KeepAlive ($0/min) | Compacted, paused | Grey dot, "Saving power..." |
| **Sleeping** | 5min in dozing | Disconnected | Preserved (5min timeout) | Grey dot, "Paused — speak to resume" |

**Wake detection:** Silero VAD runs only during doze/sleep states (not during active recording). Requires 3 consecutive frames above 0.5 probability threshold. Audio ring buffer (3s, 16kHz Int16 PCM, ~96KB) captures speech during wake detection window.

**Wake flow:**
- From dozing: Resume audio streaming (WS still alive) → replay ring buffer → zero word loss
- From sleeping: Reconnect Deepgram WS → poll for connection (up to 3s) → replay ring buffer. If no transcript arrives within 5s, TTS prompts "Sorry, could you repeat that?"

**Backend support:**
- Anthropic prompt cache TTL extended to 1 hour (from 5min default) — saves ~$0.09/session by avoiding cache rebuilds during silence gaps
- Session timeout extended to 5 minutes (from 30s) — preserves Sonnet conversation history across sleep
- `session_compact` message triggers proactive compaction before sleep

**Key files:** `SleepManager.swift`, `AudioRingBuffer.swift`, `DeepgramService.swift` (pause/resume/replay), `TranscriptDisplayView.swift` (sleep state UI)

---

## Realtime iOS Log Streaming (PLAN-backend-final.md Phase 1.3)

On-device `DebugLogger` JSONL output streams to the backend in near-real-time via batched `client_log_batch` envelopes over the existing Sonnet WebSocket. Replaces the multipart `/api/session/:id/analytics` upload that has been broken since Mar 2026 — that path used a one-shot end-of-session POST that lost the batch on crash and required the iPad to be plugged in for diagnosis. The streaming path:

- iOS batches every ~2 s (50 entries or 32 KB cap) and sends `{type:"client_log_batch", session_id, entries:[<jsonl string>, ...]}` on the same WebSocket already carrying transcripts.
- Backend per-entry sanitises (drop client `userId`/`sessionId`/`timestamp`, re-attach server-authoritative) → emits one CloudWatch `Client log batch entry` row per entry → appends to a per-session in-memory buffer.
- Buffer flushes to S3 on whichever of ~30 s tick, 100 KB threshold, ws_close, session_timeout, session_stop, or `gracefulShutdown` fires first. Keys: `session-logs/{userId}/{sessionId}/realtime/{ms}-{shortUuid}.jsonl` — lexically sortable so download/replay concatenates chronologically across ECS restarts.
- Cost-cap: 20 000 lines/session → downsampling mode (all error/warn, 1/10 info, 1/100 debug) instead of going dark — stuck sessions are precisely the ones that most need mid-session telemetry.
- iOS-on-device `DebugLogger` file write is unaffected; the stream sink is a parallel additive consumer.

Bucket / region defaults are resolved by `src/storage.js` — do NOT hardcode the production bucket name in callers. To recover a session's full log: list `s3://<production-bucket>/session-logs/{userId}/{sessionId}/realtime/` in alphabetical order and `cat` the batches.

---

## Debug a CertMate Recording Session

**When asked to "debug a job", "debug recording", "investigate transcription", or "debug CertMate" for a session, follow this COMPLETE process. The goal is to determine whether the problem is audio quality, transcription accuracy, or data extraction/UI population.**

### Step 1: Find the session data in S3

```bash
# Find the job by address
aws s3 ls s3://eicr-files-production/jobs/ --recursive | grep -i "<address>"

# Find debug audio chunks (listed by session ID)
aws s3 ls s3://eicr-files-production/debug/ --recursive | grep "<userId>"
```

**Tip:** The sessionId is in the debug log. If you only have the address, download the debug log first to get the sessionId, then use it to find audio chunks.

### Step 2: Download ALL debug artifacts

```bash
# 1. Audio chunks (FLAC files, 5-10s each) — these are the EXACT audio sent to Gemini
aws s3 cp "s3://eicr-files-production/debug/<userId>/<sessionId>/" /tmp/debug_session/audio/ --recursive

# 2. iOS debug log (chunk events, Gemini transcripts, field SET/UPDATE/SKIP events)
aws s3 cp "s3://eicr-files-production/jobs/<userId>/<address>/output/whisper_debug.json" /tmp/debug_session/debug_log.json

# 3. Backend debug log (chunk-level metrics, session transcript accumulation)
aws s3 cp "s3://eicr-files-production/jobs/<userId>/<address>/output/debug_transcription.json" /tmp/debug_session/backend_debug.json

# 4. Current job data (what's actually in the UI — the end result)
aws s3 cp "s3://eicr-files-production/jobs/<userId>/<address>/output/extracted_data.json" /tmp/debug_session/extracted_data.json
```

### Step 3: Independently transcribe each audio chunk

**Use Claude's audio capabilities to listen to and transcribe each FLAC chunk independently.** Read each audio file and produce your own transcription. The chunks are 16kHz mono FLAC, 5-10 seconds each.

```bash
# List the chunks in order
ls -la /tmp/debug_session/audio/
# Expect: chunk_000.flac, chunk_001.flac, chunk_002.flac, ...
```

For each chunk, read the audio file and transcribe what you hear.

### Step 4: Compare transcriptions (3-way)

Build a comparison table with THREE columns for each chunk:

| Chunk | What was actually said (your transcription) | What Gemini transcribed | What made it into the UI |
|-------|---------------------------------------------|------------------------|-------------------------|
| 000   | "Ze is 0.35 ohms"                          | "Ze is 0.35 ohms"     | Ze: 0.35               |
| 001   | "Circuit 1 lights, 6 amp B type MCB"       | "Circuit 1 lights, 6 amp"  | Circuit 1: lights, 6A (missing MCB type) |
| 002   | "R1 plus R2 is 0.8"                         | "Our one plus R2 is 0.8"   | r1_r2: empty (bad transcription) |

**To get "What Gemini transcribed":** Parse the debug log (`debug_log.json`). Look at `CHUNK_COMPLETE` events — each has a `transcript=` field showing what Gemini returned for that chunk index.

**To get "What made it into the UI":** Parse `extracted_data.json` which contains the final job state (circuits, supply, installation, observations).

### Step 5: Identify the failure point for each missed value

For every value that was spoken but didn't end up in the UI, classify the failure:

| Failure Type | Meaning | Example |
|-------------|---------|---------|
| **Audio quality** | Your transcription also couldn't understand it | Mumbled, background noise, too quiet |
| **Gemini transcription error** | You heard it correctly but Gemini got it wrong | "0.35" → "0.25", "MCB" → "and CB" |
| **Extraction miss** | Gemini transcribed correctly but the value wasn't extracted into structured data | Transcript says "Ze 0.35" but extraction JSON has no Ze field |
| **Field routing error** | Value extracted but put in wrong field or wrong circuit | Zs value put in Ze field, or circuit 2 data assigned to circuit 1 |
| **Priority/overwrite** | Value was set but later overwritten by a subsequent chunk | Earlier chunk set Ze=0.35, later chunk overwrote with Ze=0.40 |
| **Pre-existing block** | Field already filled by CCU photo, extraction skipped it | CCU set ocpd_rating=32, recording said 40 but was blocked |

### Step 6: Produce a diagnostic report

Format the report as:

```
## Recording Debug Report: <address>
**Session:** <sessionId>
**Date:** <date>
**Total chunks:** <N>
**Audio format:** FLAC 16kHz mono

### Summary
- Audio quality: Good/Fair/Poor
- Transcription accuracy: X/Y values correct (Z%)
- Data extraction accuracy: X/Y transcribed values extracted (Z%)
- UI population accuracy: X/Y extracted values in UI (Z%)
- **Bottleneck:** [Audio quality | Transcription | Data extraction | Field routing]

### Chunk-by-Chunk Analysis
[Table from Step 4]

### Missed Values
[Table from Step 5 — only values that were spoken but missing from UI]

### Recommendations
- [Specific suggestions: speak clearer, prefix field names, adjust prompt, fix extraction logic, etc.]
```

### Step 7: Check CloudWatch logs if needed

```bash
aws logs filter-log-events --log-group-name /ecs/eicr/eicr-backend \
  --filter-pattern "<sessionId>" \
  --start-time $(date -v-7d +%s000) --region eu-west-2 \
  --query "events[*].message" --output text
```

---

## Debug Log Event Reference

Key events in the iOS debug log (`whisper_debug.json`):

| Event | Meaning |
|-------|---------|
| `SESSION_START` | Recording began — shows sessionId, jobId |
| `CHUNK_START` | Audio chunk created — shows index, duration, sample count |
| `CHUNK_COMPLETE` | Transcription returned results — shows transcript, circuit count, orphans, latency |
| `CHUNK_ERROR` | Transcription call failed — shows error details |
| `GEMINI_SET` | Field set for first time by extraction |
| `GEMINI_UPDATE` | Field overwritten by later extraction |
| `GEMINI_CIRCUIT_CREATED` | New circuit created from extraction data |
| `GEMINI_MERGE` | Final merge applied — shows total circuit count |
| `SESSION_END` | Recording stopped — shows total chunks and transcript length |

## S3 Paths Reference

| Artifact | S3 Path | Format |
|----------|---------|--------|
| Audio chunks | `debug/<userId>/<sessionId>/chunk_XXX.flac` | FLAC 16kHz mono (5-10s each) |
| iOS debug log | `jobs/<userId>/<address>/output/whisper_debug.json` | JSON (events, transcripts, field updates) |
| Backend debug log | `jobs/<userId>/<address>/output/debug_transcription.json` | JSON (chunk metrics, accumulated transcript) |
| Job data (UI state) | `jobs/<userId>/<address>/output/extracted_data.json` | JSON (circuits, supply, installation, observations) |

## Common Recording Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Values said but not in transcript | Audio too quiet, mumbled, or background noise | Speak clearly, closer to mic |
| Numbers without context lost | Said "0.8" without "Ze is 0.8" | Always prefix values with field name |
| Circuit data missing | Never said circuit name/number | Say "Circuit 1 is..." before readings |
| Short chunks empty | Transcription struggles with <3s audio | Speak in longer continuous phrases |
| Values transcribed but not extracted | Extraction prompt doesn't map the phrasing to a field | Check extraction prompt — may need synonym |
| Values in wrong circuit | Circuit ref wasn't mentioned before values | Say circuit number before each set of readings |
| Field blocked by CCU | CCU photo pre-filled the field, extraction won't overwrite | Expected — CCU data takes priority over voice |
