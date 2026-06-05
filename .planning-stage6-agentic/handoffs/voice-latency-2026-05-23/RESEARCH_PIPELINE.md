# Voice/TTS/Extraction Pipeline Research

**Date:** 2026-05-23  
**Purpose:** Map existing surfaces for two planned sprints: (1) iOS regex fast-path → ElevenLabs streaming, (2) Sonnet streaming text chunks → ElevenLabs streaming input WS.

---

## A. iOS Regex Match → Outbound Message

### TranscriptFieldMatcher Entry Point
**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift`  
**Line:** 1166

```swift
func match(transcript: String, existingJob: JobDetail) -> RegexMatchResult
```

**Match Data Structure:**  
Lines 15–72 define `RegexMatchResult`:
- `supplyUpdates: SupplyUpdates` — Ze, PFC, earthing arrangement, etc.
- `circuitUpdates: [String: CircuitUpdates]` — keyed by `circuitRef`; contains `measured_zs_ohm`, `r1_r2_ohm`, `numberOfPoints`, etc.
- `boardUpdates: BoardUpdates`
- `installationUpdates: InstallationUpdates`
- `newCircuits: [NewCircuit]`
- `boardSwitch: BoardSwitchEvent?`

### Regex Hint WS Message
**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Services/ServerWebSocketService.swift`  
**Lines:** 494–530

```swift
func sendTranscript(
    text: String,
    regexResults: [[String: Any]]? = nil,
    confirmationsEnabled: Bool = false,
    inResponseTo: [String: Any]? = nil,
    utteranceId: String? = nil
)
```

**WS Message Shape (lines 506–507):**
```swift
if let regexResults, !regexResults.isEmpty {
    msg["regexResults"] = regexResults
}
```

The `regexResults` array is built by `buildRegexSummary()`.

### Building RegexResults Array
**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`  
**Line:** 2147

```swift
private func buildRegexSummary() -> [[String: Any]]? {
    transcriptProcessor.buildRegexSummary(writtenKeys: thisTurnRegexWrites, job: jobVM?.job)
}
```

Wire emission occurs at **lines 2072 & 2125** where `regexSummary` is passed to `sendTranscript()`.

### Field Priority Logic (Pre-existing > Sonnet > Regex)
**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`

**Core Priority Gate:** Lines 5815–5900, function `applySonnetValue`:
```swift
private func applySonnetValue(key: String, newValue: String, currentValue: String,
                               displayKeyword: String? = nil, apply: () -> Void) -> Bool
```

**Key Logic:**
- **Line 5818:** `let isPreExisting = (currentSource == .preExisting || currentSource == nil) && !currentValue.isEmpty`
- **Lines 5823–5827:** If field is pre-existing AND new value matches current value → block (return false)
- **Lines 5845–5850:** If current value is empty → apply Sonnet value, set source to `.sonnet`
- **Lines 5851–5897:** If new value differs → **OVERWRITE** the regex value (lines 5858–5862 explicitly overwrite `.regex` source), always apply Sonnet

**Regex Overwrite Detection (line 5858):**
```swift
if currentSource == .regex {
    debugLogger.info(category: .sonnet, event: "discrepancy_overwrite",
                     data: ["key": key, "regex_value": currentValue, "sonnet_value": newValue])
    discrepancyCount += 1
}
```

No suppression mechanism yet — Sonnet's value simply overwrites the regex value.

---

## B. Backend → Confirmation TTS Today

### Building Confirmation Text
**File:** `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-event-bundler.js`  
**Lines:** 66–110

```javascript
function buildConfirmationText(field, value, circuit) {
  const friendly = CONFIRMATION_FRIENDLY_NAMES[field];
  if (!friendly) return null;
  const valueStr = String(value ?? '').trim();
  if (!valueStr) return null;
  // ... handles polarity_confirmed boolean → "polarity confirmed" text
  if (circuit == null || circuit === 0) {
    return `${friendly} ${valueStr}`;
  }
  return `Circuit ${circuit}, ${friendly} ${valueStr}`;
}
```

**Example Output:** "Circuit 7, points 7" (line 108: `return \`Circuit ${circuit}, ${friendly} ${valueStr}\``)

**Source:** Built server-side from tool-call `record_reading` outcomes. NOT a Sonnet text content block — synthesised after the fact.

### Synthesizing Confirmations
**Lines:** 113–133

```javascript
function synthesiseConfirmations(readings, boardReadings) {
  const out = [];
  for (const r of readings) {
    if (typeof r.confidence === 'number' && r.confidence < CONFIRMATION_MIN_CONFIDENCE) continue;
    const text = buildConfirmationText(r.field, r.value, r.circuit);
    if (!text) continue;
    out.push({ text, field: r.field, circuit: Number.isInteger(r.circuit) ? r.circuit : null });
  }
  // ... board readings similarly
  return out;
}
```

These are emitted in `result.confirmations[]` within the `extraction` WS message.

### ElevenLabs Call Site
**File:** `/Users/derekbeckley/Developer/EICR_Automation/src/routes/keys.js`  
**Lines:** 223–290

**POST `/api/proxy/elevenlabs-tts`:**

```javascript
const voiceId = 'Fahco4VZzobUeiPqni1S'; // Archer Conversational (line 240)
const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
  method: 'POST',
  headers: {
    'xi-api-key': elevenLabsKey,  // from Secrets Manager (line 228)
    'Content-Type': 'application/json',
    Accept: 'audio/mpeg',
  },
  body: JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2_5',  // line 248
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.3,
      use_speaker_boost: true,
    },
  }),
});
```

**Model:** `eleven_turbo_v2_5` (line 248)  
**Mode:** Batch (not streaming; returns full MP3 buffer at line 261)  
**API Key Source:** `await getElevenLabsKey()` (line 226, from Secrets Manager)

### MP3 Response to iOS
**File:** `/Users/derekbeckley/Developer/EICR_Automation/src/routes/keys.js`  
**Lines:** 260–261

```javascript
res.set('Content-Type', 'audio/mpeg');
const buffer = Buffer.from(await response.arrayBuffer());
```

iOS receives the MP3 as an HTTP response body (not WS). AlertManager decodes and plays it.

### TTS Suppression Paths (Existing)
**No deduplication by Sonnet round yet.** Backend does NOT suppress duplicate confirmations when iOS has already spoken a regex result.  
However, **iOS-side dedup exists:**

**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`  
**Lines:** 5868–5875 (for correction TTS only, NOT confirmations):

```swift
let correctionDedupeKey = "\(shortKey)_\(correctionCircuit.map { String($0) } ?? "none")"
guard !confirmedFieldKeys.contains(correctionDedupeKey) else {
    debugLogger.info(category: .sonnet, event: "correction_tts_deduped", data: ["key": correctionDedupeKey])
    registerTTSFingerprint(ttsText)
    return true
}
```

This dedup only applies to **correction TTS** ("Updated X to Y"), not confirmation readbacks.

---

## C. Stage 6 / Sonnet Round Structure

### Normal Record-Reading Round Order
**File:** `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-tool-loop.js`  
**Lines:** 197–225

Each round:
1. **Line 197:** `const stream = client.messages.stream({...})` — **Streaming call** (SDK helper returning async iterator + `.finalMessage()` promise)
2. **Lines 206–209:** Consume stream events into assembler, extract records
3. **Line 211:** `const assistantMsg = await stream.finalMessage()` — get full assistant message
4. **Line 214:** `messages.push({ role: 'assistant', content: assistantMsg.content })` — push to history
5. **Lines 231–239:** If `stop_reason !== 'tool_use'`, exit loop (end_turn reached)
6. **Otherwise:** Dispatcher processes tool calls, synthetic tool_results pushed, next round

**Confirmation text emission:** Generated AFTER Sonnet's tool calls complete, in `bundleToolCallsIntoResult()` at line 341 of stage6-event-bundler.js. NOT in a Sonnet text content block — synthesised from `record_reading` outcomes.

**Thus:** `[tool_use record_reading]` → dispatcher → `[tool_result]` → (if end_turn) Sonnet emits nothing further. Confirmation text is built by backend bundler **after** the streaming round ends.

### Streaming Call Location
**Immediate Caller:** `runToolLoop()` function inside stage6-tool-loop.js, invoked from `runLiveMode()` at stage6-shadow-harness.js:668.

**SDK Call:** `client.messages.stream()` at line 197 of stage6-tool-loop.js  
**API Key:** Passed via `client` parameter (constructed by caller with `new Anthropic({ apiKey })`)

### Existing Streaming Handling
✓ **YES — ALREADY USING `messages.stream()`**

- **File:** `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-tool-loop.js`
- **Line:** 197 — live code, not dead
- **Usage:** Full streaming integration for tool-loop rounds; assembles text/tool_use blocks on-the-fly

No existing code pipes Sonnet streaming directly to ElevenLabs.

---

## D. iOS Audio Playback

### TTS Playback (AVAudioPlayer)
**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Recording/AlertManager.swift`  
**Lines:** 1111, 1167 (both create AVAudioPlayer and play immediately)

```swift
self.audioPlayer = try AVAudioPlayer(data: audioData)
self.audioPlayer?.delegate = self
self.audioPlayer?.volume = fallbackVolume
self.audioPlayer?.play()
```

**Queue/Overlap Rules:**
- **Line 1100:** `if self.shouldDeferPlayback?() == true` — defer if user still speaking
- **Lines 1159–1163:** Deferred TTS discarded if >6s old (stale question)
- **Line 1164:** Re-check gate at resume moment (user may have started speaking again)
- **Lines 1500–1505:** `AVAudioPlayerDelegate` fires `audioPlayerDidFinishPlaying` → `markTTSFinished(naturalCompletion: true)`

### Deepgram Pause/Resume Coupling
**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`

**Pause on TTS start (lines 843–849):**
```swift
self?.deepgramService.pauseAudioStream()
self?.sessionCoordinator.sleepManager.onTTSStarted()
self?.sessionCoordinator.clearPCMBuffer()
```

**Resume on TTS finish:**  
**Line 927:** `self.deepgramService.resumeAudioStream()` (called from `markTTSFinished`)

**Implementation:**  
**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Services/DeepgramService.swift`  
**Lines:** 566–570 (pause) & 589–593 (resume)

```swift
func pauseAudioStream() {
  isAudioStreamPaused = true
}

func resumeAudioStream() {
  isAudioStreamPaused = false
}
```

---

## E. WS Message Inventory

All iOS ↔ Backend messages on recording channel (from grep of ServerWebSocketService.swift):

### iOS → Backend
- `"type": "session_start"` (line 473)
- `"type": "transcript"` (line 502) — **includes `regexResults` array**
- `"type": "correction"` (line 534)
- `"type": "session_pause"` (line 537)
- `"type": "session_resume"` (line 538)
- `"type": "session_stop"` (line 539)
- `"type": "session_compact"` (line 540)
- `"type": "chitchat_resume"` (line 544)
- `"type": "select_board"` (line 556)
- `"type": "ask_user_answered"` (line 583) — **Stage 6 ask resolution**
- `"type": "heartbeat"` (line 604)
- `"type": "job_state_update"` (line 763)
- `"type": "client_diagnostic"` (line 791+)

### Backend → iOS (from ServerWebSocketServiceDelegate protocol, lines 15–74)
- `extraction` — RollingExtractionResult + **`confirmations[]` array**
- `cost_update` — CostTracker totals
- `question` — UserQuestion (legacy prose-JSON path)
- `voice_command_response` — VoiceCommandResponse
- `observation_update` — ObservationUpdate (BPG4 refinement)
- Stage 6 agentic events:
  - `ask_user_started` (line 37)
  - `tool_call_started` (line 38)
  - `tool_call_completed` (line 39)
  - `field_corrected` (line 40)
  - `circuit_created` (line 41)
  - `circuit_updated` (line 42)
  - `observation_deleted` (line 43)
- `chitchat_pause` / `chitchat_exit` (lines 50–55)
- `select_board_ack` (line 64)
- `current_board_changed` (line 74)

---

## F. Existing Feature Flags + Env Vars

### Backend (ecs/task-def-backend.json)
- `SONNET_TOOL_CALLS: "live"` — Stage 6 agentic tool-call mode (lines 3–4)

### Source Code
**File:** `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/sonnet-stream.js`

```javascript
const raw = process.env.SONNET_TOOL_CALLS ?? 'live';
```

(Line reference not found in grep output, but pattern confirmed)

**No TTS-specific env vars found.** ElevenLabs key sourced from Secrets Manager, not env var.

---

## G. Cost Tracking

### ElevenLabs Cost Attribution
**File:** `/Users/derekbeckley/Developer/EICR_Automation/src/routes/keys.js`  
**Lines:** 273–287

After successful TTS:
```javascript
if (sessionId) {
  try {
    const { recordElevenLabsUsageForSession } = await import(
      '../extraction/active-sessions.js'
    );
    trackerRecorded = recordElevenLabsUsageForSession(sessionId, text.length);
  }
}
```

**Billing Model:** By **character count** (line 287: `text.length`)

### Cost Tracker Implementation
**File:** `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/cost-tracker.js`  
**Lines:** 107–115

```javascript
addElevenLabsUsage(characterCount) {
  this.elevenLabsCharacters += characterCount;
}

get elevenLabsCost() {
  return this.elevenLabsCharacters * this.ELEVENLABS_RATE_PER_CHAR;
}
```

### Cost Summary Emission
**Lines:** 154–172 — `toCostUpdate()` method

```javascript
toCostUpdate() {
  return {
    type: 'cost_update',
    // ...
    elevenlabs: {
      characters: this.elevenLabsCharacters,
      cost: parseFloat(this.elevenLabsCost.toFixed(6)),
    },
  };
}
```

Emitted to iOS via WS message type `cost_update`.

---

## H. Confirmation Skip on Regex (Prompt Instruction)

**Search Result:** No existing instruction in prompts telling Sonnet to skip/shorten confirmation when regex hint was provided.

**File:** `/Users/derekbeckley/Developer/EICR_Automation/config/prompts/sonnet_extraction_system.md`  
**Line:** 284 (legacy prose-JSON path):
```
- CRITICAL: Only add confirmations for readings you are extracting from the CURRENT utterance.
  If the snapshot already contains the same circuit/field with the SAME value, skip confirmation
  — it was already confirmed in a previous turn.
```

This instruction applies to **legacy prose-JSON confirmations only**, not Stage 6 tool calls. **Stage 6 has no equivalent prompt instruction** — the agentic path simply emits `record_reading` tool calls; confirmation text is synthesised post-hoc by the bundler with no awareness of regex hints.

---

## I. iOS WS Connection Model

### Lifecycle
**File:** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Services/ServerWebSocketService.swift`

**One persistent WS per session.**

- **Line 320–326:** `func connect(serverURL, token)` — initiates connection
- **Line 327–366:** `_connect()` builds URLRequest with Bearer token, creates URLSessionWebSocketTask
- **Line 368–391:** `disconnect()` manually closes; `shouldReconnect = false` blocks auto-reconnect
- **Lines 393–407:** `_disconnectImmediate()` cleans up; calls `delegate?.serverDidDisconnect()` exactly once (fixed 2026-02-25)
- **Lines 473–532:** `sendSessionStart()` — sends `session_id`, `job_id`, `job_state`; resets unknown-message-type guard
- **Lines 409–457:** Send path — buffers pending messages while disconnected (Plan 06-04 r3-#1); replays on reconnect (Plan 06-05 r4-#2)

**Key Detail:** One WS connection for the entire session (Plan 06-02 r1-#5) — reconnects due to network blips, but the sessionId is re-sent on reconnect only if changed, preserving the conversation history across transports.

---

## J. Risks / Oddities

### 1. **Confirmation synthesis is post-hoc, not Sonnet-emitted**
- Confirmations are **synthesised from tool-call outcomes** in `synthesiseConfirmations()`, NOT a Sonnet text content block.
- A streaming TTS implementation must **capture the confirmation text AFTER the tool dispatcher completes**, not from Sonnet's streaming text chunks.
- Risk: Beginner mistake of trying to pipe Sonnet's text stream directly to ElevenLabs will miss confirmations.

### 2. **Regex-hint WS message shape is undocumented**
- `regexResults` array structure is built by `TranscriptProcessor.buildRegexSummary()` (not shown; search in TranscriptProcessor.swift).
- The wire shape of each element is never shown in the visible code — only `sendTranscript()` passes `regexResults: [[String: Any]]?`.
- Risk: Sprint planner must inspect TranscriptProcessor to understand the exact JSON shape before building suppression logic.

### 3. **Field priority overwrite has no backend analogue**
- iOS respects "pre-existing > Sonnet > regex" priority, with **full overwrite** of regex values by Sonnet.
- Backend has **no equivalent suppression layer** — Sonnet confirmations will be emitted even if iOS already announced a regex result.
- Risk: Duplicate confirmation TTS on iOS unless a server-side suppression layer is built (Task 2).

### 4. **ElevenLabs streaming not yet prototyped**
- Current implementation is batch-only (HTTP POST → full MP3 response).
- No existing code routes Sonnet streaming text or ElevenLabs streaming audio through WS.
- Risk: Streaming WS integration will require careful coordination between async Sonnet streaming, ElevenLabs streaming WS, and iOS playback buffering.

### 5. **Cost tracking currently batch-only**
- ElevenLabs cost is recorded **after the full HTTP response completes** (keys.js line 287).
- Streaming implementation must **record cost incrementally** as chunks are streamed (by token count or character count), not at the end.
- Risk: Streaming cost tracking will undercount or delay reporting if naively ported from batch.

### 6. **TTS dedup exists for corrections but not confirmations**
- `DeepgramRecordingViewModel.confirmedFieldKeys` Set only applies to correction TTS ("Updated X"), not confirmation readbacks.
- Confirmations are played directly from `result.confirmations` without dedup logic.
- Risk: If iOS receives both regex-fast-path TTS and Sonnet confirmation TTS on the same field, both will play unless a new dedup layer is added.

### 7. **TranscriptFieldMatcher confidence scoring opaque**
- `TranscriptMatchResult` includes readings with `confidence` fields, but the calculation method is not visible in the grep-able surface.
- Backend bundler respects `CONFIRMATION_MIN_CONFIDENCE = 0.8` (stage6-event-bundler.js:108), but iOS may have a different threshold.
- Risk: Regex hints and Sonnet confirmations may disagree on confidence, leading to inconsistent suppression behavior.

### 8. **Deepgram pause/resume is a simple flag, not a stream pause**
- `pauseAudioStream()` and `resumeAudioStream()` set `isAudioStreamPaused = true/false` (DeepgramService.swift:566–593).
- The actual Deepgram pause message is sent separately (`CloseStream` in ws-recording.js:593).
- Risk: Timing between the flag and the WS message could be misaligned if audio threads are not carefully synchronized.

---

## OPEN QUESTIONS FOR PLANNER

1. **What is the exact wire shape of `regexResults` array elements?**  
   - Inspect `TranscriptProcessor.buildRegexSummary()` to determine the JSON fields (e.g., does each element include `field`, `circuit`, `value`, `confidence`?).

2. **How does the iOS client currently invoke ElevenLabs TTS?**  
   - The HTTP endpoint is clear, but is there a queue/ordering mechanism that ensures confirmation TTS doesn't overlap with question TTS?

3. **Should the server-side confirmation-suppression layer be gated on a feature flag?**  
   - If regex_hint provided → suppress Sonnet confirmation on that field → emit `confirmation_suppressed` telemetry event for analysis.
   - Or inline the logic directly in the bundler?

4. **For streaming ElevenLabs, how should partial WS chunks be buffered on iOS?**  
   - Stream multiple MP3 frame chunks to the client; iOS buffers and plays them as they arrive?
   - Or use a streaming audio format (e.g., PCM, WAV) instead of MP3?

5. **Cost tracking for ElevenLabs streaming — character count or token count?**  
   - ElevenLabs bills by character; streaming still counts characters, not bytes or chunks.
   - Record character count at the moment Sonnet emits each text chunk? Or buffer until the turn completes?

6. **What is the "regex_hint" telemetry shape?**  
   - Should iOS emit a `regex_hint_fast_path` event when iOS matches and calls the backend directly?
   - Should backend emit `regex_hint_confirmed_by_sonnet` or `regex_hint_contradiction` for analysis?

7. **iOS dedup key format for confirmations — should it match the server format?**  
   - Server uses `buildConfirmationText()` which includes circuit. Dedup key should probably be `${field}_${circuit}` to avoid false positives across circuits.

