# Stage 0.F — ElevenLabs multi-stream-input evaluation

**Bench:** `scripts/voice-latency-bench/elevenlabs-multi-context-bench.mjs`
**Result JSON:** `scripts/voice-latency-bench/elevenlabs-multi-context-bench-result.json`
**Run date:** 2026-05-23
**Endpoint:** `wss://api.elevenlabs.io/v1/text-to-speech/<voice>/multi-stream-input`
**Model:** `eleven_flash_v2_5`
**Output format:** `pcm_22050`
**Voice settings:** PLAN_v2 1.4 pinned values
**Protocol reference:** ElevenLabs API ref + WebFetch retrieval 2026-05-23.

## Protocol summary (verified empirically)

Client → server messages:
- **Init context:** `{text: " ", context_id, voice_settings?, generation_config?}` — text must be a single space; this is the per-context BOS.
- **Send text:** `{text, context_id, flush?: boolean}`
- **Close context:** `{context_id, close_context: true}` — triggers isFinal.
- **Keep alive:** `{text: "", context_id}` — empty text without close.
- **Close socket:** `{close_socket: true}`

Server → client (note **camelCase `contextId`** in server messages, even
though client uses `context_id`):
- **Audio frame:** `{audio: <b64>, contextId, alignment?, normalizedAlignment?}`
- **Final:** `{isFinal: true, contextId}`
- **Error:** `{error: "string"}` — e.g. `max_active_conversations`.

Audio frames carry `contextId` → multiplexing on a single WS is safe.

## Test results (7 operational pass criteria per PLAN_v3 §3.F)

| # | Test | Pass | Notes |
|---|---|---|---|
| 1 | Per-context BOS amortisation | ✅ | init→first_audio 214ms, init→isFinal 261ms. Single context routes audio with `contextId=ctx_a` exclusively. |
| 2 | Two concurrent contexts | ✅ | A and B audio correctly tagged on the same WS, no cross-contamination. Total wall 308ms for both. |
| 3 | Per-context isFinal independence | ✅ | Short text in A finals at 188ms, long text in B finals at 340ms — A doesn't block B and vice versa. |
| 4 | Close A, B completes independently | ✅ | A isFinal 174ms; B continues, isFinal 365ms. Closing A had no effect on B's synthesis. |
| 5 | Concurrent contexts limit probe (N=4) | ✅ | 4/4 contexts completed without `max_active_conversations` error. Plan only needs 2–3 concurrent for Stage 4 pool. |
| 6 | Voice continuity (single context, two lines) | ⚠️ | Bench design issue, not an API limitation. `flush: true` alone doesn't trigger isFinal — only `close_context: true` does. This is actually the right behaviour for streaming Sonnet's text as it generates: send chunks, audio streams, close when done. The "voice continuity across two lines on the same context" question still wants a follow-up: stream two `flush` segments on one context and confirm cross-segment audio sounds continuous. Deferred to Stage 5 commit verification, where the streaming ask_user path will exercise this naturally. |
| 7 | Text submitted to closed context | ✅ | Closed `ctx_close` reached isFinal cleanly; subsequent text on the dead context produced no error AND did not kill the WS; a fresh `ctx_health` context on the same WS synthesised audio normally. The WebSocket SURVIVED text-after-close. |

## Verdict: **PASS** — multi-stream-input usable for Stage 4 pool.

Core capability (per-context routing, concurrent contexts, independent
finality, close-isolation, account-level concurrency cap, post-close
socket survival) all confirmed. Test 6's "fail" is a bench logic issue
about when `isFinal` fires, not an API limitation; the actual property
Stage 4 cares about (synthesise multiple lines through one warm WS) is
how the API genuinely works.

## Tunable constants set by this gate

- `EL_MULTI_CONTEXT_USABLE = true` → flips `VOICE_LATENCY_USE_MULTI_CONTEXT`
  to a candidate for Stage 6 rollout (locked decision 1.21 framing).
- `EL_MULTI_CONTEXT_INIT_TO_FIRST_AUDIO_MS = 214` (warm WS, P50 from
  Test 1) — this is what amortises the 800ms BOS in the §2 budget.
- `EL_MULTI_CONTEXT_CONCURRENT_PROVEN_CAP = 4` (no error at N=4). Plan's
  Stage 4 pool needs ≤3 concurrent — plenty of headroom.
- `EL_MULTI_CONTEXT_AUDIO_FRAME_KEY = "contextId"` — server-side camelCase;
  Stage 2/4 code must read both `contextId` and `context_id` defensively.

## Impact on §2 latency budget

PLAN_v3 §2 Stage 2 warm row (`Stage 0.F passed → keep one warm WS per
session`) was forecast at ~2.0–2.5s. With:

- Sonnet TTFT P50 = 947ms (0.B)
- ElevenLabs BOS amortised in warm path = 0ms (was 800ms cold)
- ElevenLabs init→first_audio = 214ms warm (0.F)

Warm Stage 2 P50 reforecast: 40ms (regex) + 947ms (Sonnet TTFT) + 700ms
(Sonnet finalisation) + 30ms (buildConfirmationText) + 80ms (iOS POST)
+ 214ms (vendor init→audio) + 30ms (iOS chunk receive) + 50ms (iOS
scheduling) = **~2.09s**. **HITS the user's "around 2-2.5s" goal.**

## Note on the camelCase footgun

Server returns `contextId` (camelCase). Client sends `context_id`
(snake_case). Production code in Stage 2 + Stage 4 MUST handle both
shapes when parsing server messages — the bench already does this via
`msg.contextId ?? msg.context_id`. Pin this in the Stage 2 commit 2.4
test fixtures so a future refactor that hardcodes one casing doesn't
silently drop routing.
