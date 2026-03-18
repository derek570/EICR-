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
