# RESEARCH — Streaming APIs for voice-latency sprint

Compiled 2026-05-23. Sources are inline URLs. Where a number comes from a community/blog source it's flagged "(community)" and should be treated as a planning estimate, not a contract.

---

## A. ElevenLabs streaming

### A.1 HTTP streaming endpoint

**URL (exact):**
```
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream
```
Regional variants: `api.us.elevenlabs.io`, `api.eu.residency.elevenlabs.io`, `api.in.residency.elevenlabs.io`.

**Headers:**
- `xi-api-key: <key>` (auth)
- `Content-Type: application/json`

**Query parameters:**
- `output_format` — codec_samplerate_bitrate. Default `mp3_44100_128`. Full set: `mp3_22050_32`, `mp3_24000_48`, `mp3_44100_32`, `mp3_44100_64`, `mp3_44100_96`, `mp3_44100_128`, `mp3_44100_192`, `pcm_8000`, `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_32000`, `pcm_44100`, `pcm_48000`, `ulaw_8000`, `alaw_8000`, `opus_48000_32/64/96/128/192`.
- `optimize_streaming_latency` — integer 0-4 (now marked **deprecated** in the API ref — see A.6).
- `enable_logging` — boolean, default `true`.

**Body (JSON):**
- `text` (string, required)
- `model_id` (string) — default `eleven_multilingual_v2`
- `voice_settings` — `{stability, similarity_boost, style, use_speaker_boost, speed}`
- `language_code` (ISO 639-1)
- `previous_text` / `next_text` — context tokens for continuity
- `previous_request_ids` / `next_request_ids` — up to 3 each, for stitching
- `apply_text_normalization` — `'auto'|'on'|'off'`
- `pronunciation_dictionary_locators` — up to 3
- `seed` (0..4294967295) for determinism

**Response:** binary audio stream. The docs page lists the response as `text/event-stream`, which is the docs' own SSE wrapper rendering — in practice the client receives raw chunked audio bytes (the official SDK exposes it as `for chunk in audio_generator`). Chunk size is not specified by ElevenLabs; behaviour is "send bytes as they're synthesised".

**Minimal Node.js fetch loop** (chunks-as-arrive):
```js
const res = await fetch(
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
  {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  }
);
// res.body is a ReadableStream of Uint8Array — pipe straight to the iOS WS:
for await (const chunk of res.body) {
  iosWs.send(chunk); // each chunk is a partial MP3 frame
}
```

Source: https://elevenlabs.io/docs/api-reference/text-to-speech/stream

### A.2 `stream-input` WebSocket

**URL (exact):**
```
wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
```

**Query parameters:**
- `model_id` (string)
- `output_format` — default `pcm_22050` (note: HTTP default is mp3, WS default is pcm)
- `language_code`
- `enable_logging` (default true)
- `enable_ssml_parsing` (default false)
- `inactivity_timeout` — seconds, default 20, max 180. After timeout with no message, server closes the socket.
- `sync_alignment` (default false)
- `auto_mode` (default false) — when true, ElevenLabs picks chunking automatically and ignores `chunk_length_schedule`. Recommended for LLM output by the latency-best-practices page.
- `apply_text_normalization` — `'on'|'off'`, default `'off'`
- `seed` (integer)
- `authorization` / `single_use_token` (query-string auth alternatives)

**Authentication:** three options — `xi-api-key` HTTP header on upgrade, `authorization` bearer in the initial message body, or `?authorization=` / `?single_use_token=` query param. Per the iOS-WS gotcha already burned us on Deepgram (`MEMORY.md` re iOS WebSocket auth headers): the backend opens the WS, not iOS, so the header form is fine here.

**Initial (BOS) message:**
```json
{
  "text": " ",                          // MUST be exactly " " (single space)
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0,
    "use_speaker_boost": true,
    "speed": 1
  },
  "generation_config": {
    "chunk_length_schedule": [120, 160, 250, 290]
  },
  "pronunciation_dictionary_locators": [
    { "pronunciation_dictionary_id": "...", "version_id": "..." }
  ],
  "xi-api-key": "<optional alt auth>",
  "authorization": "<optional alt auth>"
}
```
Voice settings + generation config are only honoured on the first message.

**Subsequent text frames:**
```json
{ "text": "Your text here ", "flush": false, "try_trigger_generation": false }
```
- `flush: true` forces synthesis of whatever is currently buffered (use this on Sonnet `content_block_stop`).
- `try_trigger_generation` is the older sibling of `flush`; still accepted.
- **Trailing space** in `text` matters — concatenated chunks need word boundaries.

**End-of-stream signal:** `{"text": ""}` (empty string). Server flushes, emits final audio + `{"isFinal": true}`, closes.

**Keep-alive (during pauses):** send `{"text": " "}` (single space) to reset the 20s inactivity timer.

**Response frames:**
```json
{
  "audio": "<base64 string>",
  "normalizedAlignment": { "charStartTimesMs": [...], "charDurationsMs": [...], "chars": [...] },
  "alignment":           { "charStartTimesMs": [...], "charDurationsMs": [...], "chars": [...] }
}
```
Final frame: `{"isFinal": true}`. `alignment` only present when `sync_alignment=true`.

**TTFB feeding one token at a time vs whole sentences:** documented best practice is `auto_mode=true` + send tokens as they arrive, **let the server decide** when to commit. With manual `chunk_length_schedule`, sending one token at a time stalls until threshold (e.g. 120 chars) — counterproductive. Sentence boundary buffering on the client is the recommended fallback when `auto_mode` is unavailable.

Sources:
- https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
- https://elevenlabs.io/docs/developers/websockets
- https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization

### A.3 Voice models comparison

| Model ID | TTFB (model only) | Quality | Price/1k chars | Languages | Max input | Voice cloning |
|---|---|---|---|---|---|---|
| `eleven_multilingual_v2` | not published | "Most lifelike, rich emotional expression" | $0.10/1k chars (1 credit/char) | 29 | 10,000 chars | IVC + PVC compatible |
| `eleven_turbo_v2_5` | ~75ms | **Deprecated — functionally equivalent to flash_v2_5** | $0.05/1k chars (0.5 credit) | 32 | — | IVC + PVC |
| `eleven_turbo_v2` | ~75ms | **Deprecated — equivalent to flash_v2** | $0.05/1k chars | English only | — | IVC + PVC |
| `eleven_flash_v2_5` | **~75ms model inference** | Slight fidelity drop vs Multilingual v2 | **$0.05/1k chars (0.5 credit)** | 32 | 40,000 chars | IVC + PVC (confirmed) |
| `eleven_flash_v2` | ~75ms | Faster, English only | $0.05/1k chars | English only | 30,000 chars | IVC + PVC |
| `eleven_v3` | not specified | Highest emotional range, expressive | not specified (assume 1 credit) | 70+ | 5,000 chars | not documented as Flash-tier |

**All Flash/Turbo/Multilingual models work with both Instant Voice Clones (IVC) and Professional Voice Clones (PVC).** PVC adds latency (docs say "slower than default/IVC").

**The 75ms figure is model inference under ideal short-input conditions.** Real end-to-end TTFB via WebSocket (per ElevenLabs' own latency-optimization page):
- North America / Europe / Southeast Asia: **100-150ms**
- South Asia / Northeast Asia: 150-200ms

For Anthropic Cookbook reference: TTS streaming (HTTP, Turbo v2.5, with full input pre-buffered) measured **0.39s** time-to-first-audio-chunk; sentence-by-sentence client-side buffering measured **1.48s** (the buffer itself dominates).

Sources:
- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization
- https://platform.claude.com/cookbook/third-party-elevenlabs-low-latency-stt-claude-tts

### A.4 Rate limits + concurrency

Per ElevenLabs help-center (community-republished, no public SLA page):

| Plan | Concurrent streams |
|---|---|
| Free | 2 |
| Starter ($5/mo) | 3 |
| Creator ($22/mo) | 5 |
| Pro ($99/mo) | **10** |
| Scale | 15 |
| Business | 15 |
| Enterprise | negotiated |

**Overflow error:** HTTP `429` with body `{"detail": {"status": "too_many_concurrent_requests"}}`. Distinct from `429 system_busy` (global overload).

For our scale (single inspector at a time), Creator or Pro is ample headroom. Burst pricing exists (3× concurrency at 2× cost) but isn't needed.

Sources:
- https://help.elevenlabs.io/hc/en-us/articles/14312733311761
- https://help.elevenlabs.io/hc/en-us/articles/19571824571921-API-Error-Code-429

### A.5 Reconnect / resumption

**Not resumable.** The docs do not document a mid-stream resume primitive. A dropped WS = fresh request, fresh BOS. Conservation strategies:
- Keep state locally (which Sonnet content_block index, accumulated text not yet sent).
- On WS drop, open a new `stream-input` connection and replay any text that hadn't yet been finalised by `isFinal`.
- Voice continuity across separate requests is supported by the HTTP `previous_request_ids` field — but NOT exposed on the `stream-input` WS.

Inactivity-timeout disconnect (20s default, 180s max) is the most common drop mode; mitigate by sending `{"text": " "}` keep-alives during long Sonnet thinking pauses. After 180s of nothing → forced close, no recovery.

Sources:
- https://github.com/livekit/agents/issues/4609 (community report of mid-stream WS drop killing the stream)
- https://elevenlabs.io/docs/developers/websockets

### A.6 Optimisation levers

**`optimize_streaming_latency` (HTTP only, deprecated):**
- `0` — default, no optimisations
- `1` — normal (~50% of possible improvement)
- `2` — strong (~75%)
- `3` — max
- `4` — max + text normaliser off (more savings, lower quality on numbers/abbrev)

Now **marked deprecated** in the official API reference. Replacement guidance is "use Flash v2.5 + WebSocket + auto_mode". For our use case (inspector confirmations), text normalisation is desirable (we will speak numbers like "Ze 0.13") so do not set 4.

**`output_format` latency ranking** (lowest TTFB first, by encoder cost):
1. `pcm_*` — no codec encode, server emits PCM samples directly. Lowest TTFB.
2. `ulaw_8000` / `alaw_8000` — telephony codecs, very cheap.
3. `mp3_22050_32` — lowest-bitrate MP3.
4. `mp3_44100_128` — current default; richer audio, slightly more encode time.
5. `opus_*` — typically lowest bytes-on-wire but a hair more encode work than MP3.

**Practical:** for an iOS client that already plays MP3, switching to `mp3_22050_32` shaves bytes-on-wire dramatically (~75% smaller than `mp3_44100_128`) at acceptable speech quality. If we can stomach swapping iOS to PCM playback (AVAudioPlayer doesn't do streamed PCM directly — need AudioQueue or AVAudioEngine), `pcm_16000` would be ideal because it matches Deepgram's input rate and stays small.

**`chunk_length_schedule` defaults:** `[120, 160, 250, 290]`. First audio after 120 chars buffered, next at 160, etc. To trade quality for latency: `[50, 90, 120, 150]` is the typical "low-latency" override quoted in community posts.

**`auto_mode`:** when true, ElevenLabs runs an internal sentence-boundary detector and ignores `chunk_length_schedule`. Best for LLM streaming (per their own latency best-practices page). Effectively: don't try to outsmart it client-side.

**Realistic best-case TTFB:**
- Direct ElevenLabs-only path (text known upfront, Flash v2.5, EU region, mp3_22050_32 or pcm_16000): **~150-250ms** end-to-end to iOS first audio frame.
- Sonnet-chained path: bounded by Sonnet TTFT (see B.1) — typically Sonnet first token at ~700ms + ElevenLabs handshake parallelised = first audio at **~900ms-1.2s**.

Sources: same as A.2.

### A.7 Known gotchas

- **Multilingual v2 stuttering on stream-input** — open GitHub issue elevenlabs/elevenlabs-python#114, reports of stutter under packet loss. Mitigation: prefer Flash v2.5.
- **WS protocol-error 1002** — surfaced when client misformats the BOS (e.g. missing the leading space `{"text": " "}`). Stop and verify BOS shape, not server-side.
- **800ms BOS handshake delay** — first packet after WS open includes model load. Keep-warm via a persistent WS or send BOS speculatively before user speaks.
- **Audio clicks at chunk boundaries** — most common cause is MP3 chunks not aligned to MP3 frame boundaries when re-encapsulated. The server emits frame-aligned chunks; clicks usually mean the iOS player is being fed truncated bytes (don't `Data.subdata` partway through a chunk).
- **No resume across reconnects** — see A.5. Plan for replay-from-state.
- **20s inactivity close** — easy footgun if Sonnet pauses (e.g. extended thinking) between text deltas. Always pipe a keep-alive when sonnet enters tool_use.
- **`stream-input` ignores `previous_request_ids`** — no voice continuity primitive between sessions; voice drift mid-conversation is reportedly mild for Flash v2.5 but real for PVC voices.

---

## B. Anthropic `messages.stream`

The current SDK version in this repo is `@anthropic-ai/sdk`, model `claude-sonnet-4-6`. The API hasn't changed in any incompatible way between 4.5 and 4.6 — only the error-recovery prescription (B.6).

### B.1 Event types in order

The full SSE flow (verified against official docs):

1. `message_start` — emits the empty Message envelope. **`usage.input_tokens` arrives HERE.**
2. For each content block (index 0, 1, 2…):
   - `content_block_start` — declares block type (`text`, `tool_use`, `thinking`, `server_tool_use`, `web_search_tool_result`)
   - one or more `content_block_delta` — `delta.type` is `text_delta` / `input_json_delta` / `thinking_delta` / `signature_delta` / `citations_delta`
   - `content_block_stop`
3. `message_delta` — emits `stop_reason`, `stop_sequence`, and **cumulative** `usage.output_tokens` (it's cumulative across multiple message_delta events).
4. `message_stop` — terminal event.
5. `ping` events may appear at any point (heartbeat).
6. `error` events appear in place of a normal terminal sequence on mid-stream failure.

**Case 1 — single text block:**
```
message_start → content_block_start(idx=0, type=text) → content_block_delta(text_delta) × N → content_block_stop(idx=0) → message_delta → message_stop
```

**Case 2 — single tool_use:**
```
message_start → content_block_start(idx=0, type=tool_use, input={}) → content_block_delta(input_json_delta) × N → content_block_stop(idx=0) → message_delta(stop_reason=tool_use) → message_stop
```
Note `content_block_start.content_block.input = {}` is a placeholder; the actual input is built by concatenating `delta.partial_json` strings.

**Case 3 — tool_use then text** (typical Stage 6 turn that calls a tool then narrates):
```
message_start
  → content_block_start(idx=0, type=text) → text_delta × N → content_block_stop(idx=0)
  → content_block_start(idx=1, type=tool_use) → input_json_delta × N → content_block_stop(idx=1)
  → message_delta → message_stop
```
The order of content blocks within a single message is whatever Claude emits — text-then-tool is the documented common pattern. Currently models only emit **one complete key/value at a time** in tool inputs, so there can be visible pauses inside an `input_json_delta` stream while the model "thinks".

Source: https://platform.claude.com/docs/en/api/messages-streaming

### B.2 Partial tool_use dispatch

**Without `eager_input_streaming`** — server buffers and JSON-validates before emitting. You get well-formed sub-strings but might wait for the whole input to be ready before any `input_json_delta` arrives. Safe to accumulate-then-parse on `content_block_stop`.

**With `eager_input_streaming: true`** on the tool definition — server skips validation, emits fragments as the model produces them. You can **react to partial input before block close** (rendering a progress indicator, dispatching a streaming tool that accepts partial args). Caveats:
- Stream may end with **invalid/incomplete JSON** if `max_tokens` is hit.
- Wrap invalid JSON in `{"INVALID_JSON": "<raw>"}` if you need to ship it back to Claude.
- Available on all models and platforms.

**In practice:** most production agents accumulate-then-dispatch. Eager streaming is meaningful for tools with large args (file writes, long arrays). For our Stage 6 schema (small JSON objects: `record_circuit_reading`, `ask_user`, `add_board`), **eager mode buys nothing** — by the time the JSON is "useful" the block is essentially done. **Recommendation: do NOT set `eager_input_streaming`** for Stage 6 tools.

Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming

### B.3 Usage timing

| Field | Where emitted |
|---|---|
| `input_tokens` | `message_start.message.usage.input_tokens` |
| `cache_creation_input_tokens` | `message_start.message.usage` |
| `cache_read_input_tokens` | `message_start.message.usage` — **reliable on streaming** |
| `output_tokens` | `message_delta.usage.output_tokens` — **CUMULATIVE** across multiple message_delta events |
| `server_tool_use.web_search_requests` | last `message_delta` |

**Known double-counting trap** (langchain/litellm have hit this): treating `message_delta.usage` as the per-event delta rather than cumulative. For our backend, take the **last** `message_delta.usage.output_tokens` value as the canonical output count.

Source: https://github.com/langchain-ai/langchainjs/issues/10249, https://platform.claude.com/docs/en/api/messages-streaming

### B.4 Cache behaviour

Prompt caching (`cache_control: {"type": "ephemeral"}` with default 5m TTL) **works identically on streaming**. `cache_read_input_tokens` is reported in `message_start.message.usage`. Extended TTL (`ttl: "1h"`) is also supported in streaming — usage adds `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` breakdowns.

Sonnet 4.6 has the same prompt-caching contract as 4.5 — nothing model-specific to flag.

Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching

### B.5 Abort / cancellation

**SDK helpers:**
- TypeScript: `stream.abort()` or `break` from `for await` loop.
- Both options propagate as `APIUserAbortError`, fire the `.on('abort', ...)` event.
- Underlying HTTP request: SDK uses `fetch` with an `AbortController`. You can pass your own signal via `client.messages.stream(params, { signal })`.

**Known issue (community):** SDK's SSE iterator can swallow `AbortError` silently in some paths — the `for await` completes "normally" without emitting `message_stop`, so downstream code thinks the message finished naturally. Mitigation: explicitly track whether `message_stop` arrived before treating the conversation as complete.

Sources:
- https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md
- https://github.com/anthropics/anthropic-sdk-typescript/issues/842

### B.6 Error handling mid-stream

A 529 or other server failure during streaming arrives as an `error` SSE event, NOT an HTTP error (the upgrade already succeeded):
```
event: error
data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```
The SDK fires the `.on('error', err)` event. Partial response received so far is in the accumulated `Message` snapshot.

**Error recovery (Sonnet 4.6 prescription, changed from 4.5):**
- Capture text deltas already received.
- Issue a **new** request with a USER message (not an assistant continuation) that says "Your previous response was interrupted and ended with [...]. Continue from where you left off."
- Resume streaming.

Tool_use and thinking blocks **cannot be partially recovered** — only text blocks. If we get cut mid-tool, the whole turn is lost.

Source: https://platform.claude.com/docs/en/api/messages-streaming (Error recovery section)

### B.7 Tool-use sequencing in Stage 6

Stage 6 round trip: `[user msg] → Claude produces [text + tool_use] → backend runs tool → [tool_result] → next Claude turn`. Per-turn latency:

| Phase | Non-streaming | Streaming |
|---|---|---|
| TTFT (input_tokens response) | n/a | ~1.4s (Anthropic measured P50) |
| Time-to-first-text-delta | 1.0-1.5s (whole response) | **~0.7s** (Cookbook measured) |
| Tool_use block fully emitted | included in 1.0-1.5s | input_json_delta stream finishes ~same time as text |
| Backend tool execution | local — typically <50ms for Stage 6 tools | unchanged |
| Next turn TTFT (after tool_result) | ~1.4s | ~0.7s with prompt caching |

**Meaningful savings:** for text-heavy turns where the inspector hears confirmation while Claude is still talking. **Marginal:** for pure tool_use turns (text block before tool_use is short; the tool_use input_json itself isn't useful audio). The biggest win for Stage 6 is on *narration turns* — e.g. "OK, recorded Ze 0.13 ohms" — where the text comes first then the tool_use, so streaming saves the full text duration (~0.5-0.8s of audio latency).

Source for TTFT numbers: https://artificialanalysis.ai/models/claude-sonnet-4-6/providers (Anthropic provider 1.42s P50 over 72h)

### B.8 claude-sonnet-4-6 specific notes

- Same streaming contract as 4.5. No new event types.
- Median TTFT on Anthropic API: **1.42s** P50 (10k input tokens benchmark). Lower on Google Vertex (1.05s) and Bedrock (1.52s) — irrelevant unless we migrate provider.
- Output speed: **43.9 tokens/sec** on Anthropic API (P50).
- Sonnet 4.6 changed the error-recovery prescription (user message vs assistant continuation; see B.6).
- Cache contract unchanged.

---

## C. Chaining Sonnet → ElevenLabs

### C.1 Pattern reports

**Official:** Anthropic publishes a cookbook — https://platform.claude.com/cookbook/third-party-elevenlabs-low-latency-stt-claude-tts. It uses `claude-haiku-4-5` (not Sonnet), `eleven_turbo_v2_5` (deprecated alias for Flash v2.5), and HTTP-stream TTS. Reports:
- Sonnet/Haiku TTFT: **0.71s**
- TTS first audio chunk (after Claude's full text known): **0.39s**
- Sentence-buffered streaming chained pattern: **1.48s** first audio (buffer dominates)

The cookbook **recommends** WebSocket `stream-input` over the sentence-buffered HTTP path for production. Reference implementation file: `stream_voice_assistant_websocket.py` (in the cookbook repo).

**Community implementations:** ccappetta/bidirectional_streaming_ai_voice on GitHub (Python, similar pattern). Pipecat's ElevenLabs plugin handles auto-mode + keep-alive.

### C.2 Sentence boundary buffering

**With `auto_mode=true`:** **don't buffer client-side.** Forward every `text_delta` to ElevenLabs as a separate text message. Server picks sentence boundaries. This is the recommended pattern.

**With `auto_mode=false`:** the model needs ≥120 chars (default `chunk_length_schedule[0]`) before it can synthesise. Feeding single tokens (3-4 chars) means the first ~30+ tokens accumulate before any audio. So either:
- Lower `chunk_length_schedule[0]` to ~50, and accept some prosody loss at the very start, OR
- Client-side buffer by sentence boundary (regex `[.!?]+`) and only send complete sentences, OR
- Hybrid: send accumulated chunks of ~50 chars on each `text_delta`, flush on sentence-final punctuation.

**Sweet spot for our use case:** since Stage 6 confirmations are short (15-40 chars typical: "OK, Ze 0.13 ohms recorded"), `auto_mode=true` is strictly better — the model will commit on punctuation regardless of buffer. **Recommendation: use auto_mode.**

**Commas vs full stops:** ElevenLabs synth honours comma prosody only when ≥1 word follows it in the buffer at synth time. With `auto_mode` it waits naturally; without it, low-threshold schedules can break commas mid-clause.

### C.3 End-of-input signal

When Anthropic emits `content_block_stop` for the text block:
1. Send `{"text": "", "flush": true}` to flush any remaining buffered chars.
2. Send `{"text": ""}` to close the WS (empty string = EOS).

Don't send EOS until you're sure Sonnet won't produce a *second* text block in the same turn (e.g. text → tool_use → text). Recommendation: only close the WS on `message_stop`. Between text blocks, send `{"text": " "}` keepalives to prevent the 20s timeout, AND emit a `flush: true` at the end of each text block so the inspector hears segment 1's audio before segment 2 starts buffering.

### C.4 First-audio-byte vs first-audio-playable on iOS

For MP3: `AVAudioPlayer` does **not** stream-play (it needs the whole file). `AVPlayer` + `AVURLAsset` with chunked HTTP can stream, but feeding it from a WebSocket requires either:
- Buffering to a temp file and pointing AVPlayer at it (defeats streaming), or
- Using `AVAudioEngine` + `AVAudioPlayerNode` after decoding each chunk to PCM via `AudioConverter`, or
- Using `AudioFileStream` + `AudioQueue` (Apple's lower-level streaming primitive — used by AudioStreamer libs).

**Minimum MP3 chunk size for playback start:** for `mp3_44100_128`, one full MP3 frame is 1152 samples = ~26ms = ~418 bytes. The decoder needs **at least 2 frames** in buffer to start (~836 bytes / 52ms of audio).

**For PCM (`pcm_16000`):** no decode step — feed samples to `AVAudioPlayerNode.scheduleBuffer` as they arrive. Lowest possible first-audio-playable.

Existing iOS code in this repo plays MP3 over the custom WS (per the task description). We can keep MP3 for the streaming path but should consider `mp3_22050_32` (half the bitrate, more chunks per second, faster decoder buffer fill).

### C.5 Reference shape (Sonnet → ElevenLabs glue)

```js
// Backend pseudocode
const elWs = new WebSocket(
  `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=mp3_22050_32&auto_mode=true&inactivity_timeout=180`,
  { headers: { 'xi-api-key': key } }
);
elWs.on('open', () => {
  elWs.send(JSON.stringify({
    text: ' ',
    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 },
  }));
});
elWs.on('message', frame => {
  const f = JSON.parse(frame);
  if (f.audio) iosWs.send(Buffer.from(f.audio, 'base64'));
  if (f.isFinal) elWs.close();
});

const sonnet = anthropic.messages.stream({
  model: 'claude-sonnet-4-6',
  // ...
});

let currentTextBlock = false;
for await (const event of sonnet) {
  if (event.type === 'content_block_start' && event.content_block.type === 'text') {
    currentTextBlock = true;
  } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    elWs.send(JSON.stringify({ text: event.delta.text }));
  } else if (event.type === 'content_block_stop' && currentTextBlock) {
    elWs.send(JSON.stringify({ text: '', flush: true })); // flush this segment
    currentTextBlock = false;
  } else if (event.type === 'message_stop') {
    elWs.send(JSON.stringify({ text: '' })); // EOS, server closes
  }
}
```

---

## D. Costs

### D.1 ElevenLabs per-character cost

API pricing (independent of subscription plan, billed in credits at 1 credit = $0.0001 / 1k chars on Pro, varies slightly by tier):

| Model | Cost / 1k chars (API) | Credit multiplier |
|---|---|---|
| `eleven_multilingual_v2` | **$0.10** | 1.0 |
| `eleven_flash_v2_5` | **$0.05** | 0.5 |
| `eleven_flash_v2` | $0.05 | 0.5 |
| `eleven_turbo_v2_5` | $0.05 (deprecated) | 0.5 |
| `eleven_v3` | not published — assume $0.10 | assume 1.0 |

**Pro plan ($99/mo)** includes 500k credits = 500k Multilingual chars OR 1M Flash chars. Annual saves ~17%.

### D.2 Anthropic streaming cost

**Identical to non-streaming.** Anthropic does not charge differently for streamed vs batched responses. Cost is purely input_tokens + output_tokens + cache_create + cache_read tokens × Sonnet 4.6 rates. Reference rates from the changelog (already in this repo): no change vs current Sonnet bill.

Confirmed against https://platform.claude.com/docs/en/api/messages-streaming (no cost differentiator mentioned anywhere).

### D.3 Order-of-magnitude estimate for added regex-fast-path TTS

Assumptions (per spec):
- 30 confirmations per certificate
- 20 chars per confirmation
- 10 certs/day
- = 30 × 20 × 10 = **6,000 chars/day**

At Flash v2.5 ($0.05 / 1k chars):
- **$0.30/day** = **~$9/month** = **~$110/year**

At Multilingual v2 ($0.10 / 1k chars):
- $0.60/day = ~$18/month = ~$220/year

Both are negligible relative to the £3/cert margin. The dominant TTS cost driver is *Sonnet-narrated* confirmations (which can be 50-200 chars each, not 20). At 100 chars × 30 confirmations × 10 certs/day × $0.05/1k = **$1.50/day** Flash, **$3.00/day** Multilingual. Still trivial.

**Net additional ElevenLabs spend from a fast-path that doubles the number of synth calls: ~$0.30-1.50/day.** Not a scope blocker.

---

## E. Failure mode catalogue

| Failure | Detection | Recovery |
|---|---|---|
| Anthropic timeout / connection drop before `message_start` | SDK throws on `client.messages.stream()` call or never fires `.on('connect')` | Retry up to 3× with exponential backoff. iOS TTS the legacy "I didn't catch that" line. |
| Anthropic 529 `overloaded_error` mid-stream | `event: error` SSE; SDK fires `.on('error')` | Capture text deltas received so far. Use Sonnet 4.6 prescription: new request with user-msg continuation. If happens twice → bail to a static fallback confirmation ("Recorded."). |
| Anthropic stream silently truncated (no `message_stop`) | `for await` exits without seeing `message_stop` event. Open issue anthropic-sdk-typescript#842. | Track a `messageStopSeen` flag. If false → treat as failure, retry. |
| Tool_use input arrives invalid JSON | `JSON.parse` throws after `content_block_stop` | Without eager_input_streaming this shouldn't happen; if it does → log + fail the turn + ask Sonnet to retry. With eager → wrap in `{"INVALID_JSON":...}` and surface to Sonnet. |
| ElevenLabs WS upgrade fails | `elWs.on('error')` before `'open'`, HTTP 401/403/429 | 401/403 → fatal (auth bug), surface to logs. 429 `too_many_concurrent_requests` → backoff + retry. 429 `system_busy` → 5s wait + retry. Fallback path: HTTP `/stream` endpoint (no concurrent-limit gating same way). |
| ElevenLabs WS drops mid-synthesis | `elWs.on('close')` before `isFinal` arrived | Open new `stream-input` WS, replay text accumulated since last `isFinal`. iOS may hear a slight pause. If 2nd connection also drops within 5s → bail to HTTP `/stream` of full remaining text. |
| ElevenLabs 20s inactivity timeout fires while Sonnet is thinking | WS close with reason indicating timeout | Detect via keep-alive scheduler: if no text delta in 15s, send `{"text": " "}`. If we still get a close → reconnect-and-replay. |
| ElevenLabs returns server-side error frame | Frame contains `{"error": ...}` instead of `audio` | Log + reconnect. If Flash model is at fault, fall back to Multilingual v2 for this synthesis. |
| iOS WS reset mid-MP3 chunk | Backend `iosWs.on('close')` while ElevenLabs is still piping audio | Stop forwarding to iOS, cancel ElevenLabs WS (server-side cleanup). On iOS side: AVAudioPlayerNode stops naturally on EOF; if buffer is mid-frame, expect a soft pop. Mitigation: don't send sub-MP3-frame slices to iOS — buffer one full frame minimum. |
| iOS WS reset, partial MP3 in player | Same as above + iOS player stuck "playing" empty buffer | Treat as audio-finished. Use `AVAudioPlayerNode.completionHandler` driven by `isFinal` over the WS, not by audio decode finishing. |
| Sonnet emits text → tool_use → text and we EOS'd ElevenLabs after block 1 | New text arrives, no WS open | DON'T EOS until `message_stop`. Keep WS open with `{"text": " "}` keepalives between blocks. Flush on each `content_block_stop` to deliver segments. |
| Both Anthropic and ElevenLabs down | Both error handlers fire | iOS TTS the legacy bundled "Tour audio" or a static MP3. The whole feature degrades to silent — log and surface offline indicator. |
| Voice drift across reconnects | No automated detection — only on PVC voices, mild on Flash IVC | Accept as known limitation. If field-test surfaces it, switch to a less-drift-prone voice. |
| MP3 chunk boundary clicks on iOS | Audible click between chunks | Verify each chunk is decoded as a complete unit (don't concat raw bytes into a `Data` you then re-frame). Use `AVAudioFile` or `AVAudioPlayerNode.scheduleBuffer(_:completionHandler:)` per chunk. |

---

## F. Open questions (need empirical validation)

1. **TTFB for `eleven_flash_v2_5` + cloned voice (IVC) via `stream-input` from eu-west-2 ECS to ElevenLabs eu/us endpoints, mp3_22050_32, auto_mode=true** — documented best-case is 100-150ms but our specific voice ID + region path is unmeasured. **Action: micro-benchmark before committing.**
2. **Does our existing custom WS (server → iOS) tolerate ~50-100 small MP3 chunks/sec without head-of-line blocking?** Existing path probably tested with full-blob messages; chunked may need flow-control. **Action: measure on a 4G iPad in the field.**
3. **Sonnet 4.6 TTFT to our backend specifically** — the 1.42s figure is Anthropic's benchmark P50 from artificialanalysis.ai with 10k input tokens. Our Stage 6 system prompt is heavier (cached) — actual cached-read TTFT is unknown. **Action: instrument `time-to-first-content_block_delta` over a real session, collect 20 samples.**
4. **`auto_mode` behaviour with very-short utterances (<10 chars)** — does it wait for more text or flush immediately on EOS? Docs don't say. **Action: test with a single-word confirmation like "OK" to see whether it synthesises or waits.**
5. **iOS player gapless playback with WS-delivered MP3 fragments** — Apple's MP3 decoders are notoriously fussy about frame boundaries. The repo doesn't document which iOS playback API is used for the current MP3-over-WS path. **Action: cross-check with `Sources/Services/AlertManager.swift` (per CLAUDE.md it owns TTS) and confirm whether it queues full MP3 blobs or streams.**
6. **Concurrent stream limit interaction with multiple users** — we're single-inspector now but spec says "single user, dozens of certs/day", which implies sequential. **Confirm: Creator (5 concurrent) is sufficient and we don't accidentally spawn parallel streams from a misbehaving retry loop.**
7. **MP3 vs PCM end-to-end latency on our specific iOS playback path** — without knowing the playback API, the "MP3 needs ≥2 frames buffered" estimate is generic. PCM via `AVAudioPlayerNode` might be faster but requires iOS-side rewrite. **Action: prototype both formats and time first-audible-frame.**
8. **`stream-input` voice continuity across the auto-resume on WS drop** — does the same `voice_id` give identical timbre if we replay the same text in a new connection? Reportedly yes for IVC, less stable for PVC. Confirm with our specific voice.
9. **Whether `optimize_streaming_latency=0` (deprecated) still has any effect when `auto_mode=true`** — docs are quiet. Assume no, but verify before relying on auto_mode alone.
10. **Behaviour when Sonnet aborts mid-tool_use** (e.g. backend cancels). Does the SDK fire `.on('abort')` AND `.on('end')`? See B.5. Need to verify our cleanup path doesn't leak open ElevenLabs WSs.

---

## Sources

### ElevenLabs

- API ref — stream-input WS: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
- API ref — HTTP /stream: https://elevenlabs.io/docs/api-reference/text-to-speech/stream
- API ref — multi-context-stream-input: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input
- Models overview: https://elevenlabs.io/docs/overview/models
- Latency optimisation: https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization
- Audio streaming concepts: https://elevenlabs.io/docs/eleven-api/concepts/audio-streaming
- WebSocket guide: https://elevenlabs.io/docs/developers/websockets
- Realtime TTS guide: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
- Rate limits 429: https://help.elevenlabs.io/hc/en-us/articles/19571824571921
- Concurrent stream limits: https://help.elevenlabs.io/hc/en-us/articles/14312733311761
- Pricing: https://elevenlabs.io/pricing
- Voice cloning compatibility: https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning
- Mid-stream drop community report: https://github.com/livekit/agents/issues/4609

### Anthropic

- Streaming messages: https://platform.claude.com/docs/en/api/messages-streaming
- Fine-grained tool streaming: https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
- TS SDK helpers: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md
- SDK abort silent-swallow issue: https://github.com/anthropics/anthropic-sdk-typescript/issues/842
- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Cumulative usage double-count issue: https://github.com/langchain-ai/langchainjs/issues/10249
- Sonnet 4.6 performance benchmarks: https://artificialanalysis.ai/models/claude-sonnet-4-6/providers

### Chaining patterns

- Anthropic cookbook (Claude + ElevenLabs voice agent): https://platform.claude.com/cookbook/third-party-elevenlabs-low-latency-stt-claude-tts
- Community reference impl: https://github.com/ccappetta/bidirectional_streaming_ai_voice
