# ADR-003: Server-Side Sonnet for Extraction

**Date:** 2026-02-16
**Status:** Accepted

## Context

The EICR-oMatic 3000 recording pipeline needs to extract structured certificate data (circuit readings, supply characteristics, board info, observations) from free-form transcribed speech. This is the core intelligence of the application: turning dictated readings like "ring final circuit one, Zs nought point two seven, RCD trip time twenty-one milliseconds" into structured fields on the certificate.

### Previous approach (v1-v2, client-side)

The iOS app made ~30 independent Claude Sonnet API calls per 10-minute session, each rebuilding context from scratch. Each call sent the system prompt (~900 tokens), previous extraction buffers, and the current circuit schedule. Problems:

- **No memory between calls.** Each extraction was independent, so Sonnet lost context about which circuit was being discussed, what had already been extracted, and the inspector's speech patterns.
- **Wasted tokens.** The ~900-token system prompt was re-sent and re-processed 30 times per session (~27,000 redundant input tokens).
- **Circuit misassignment.** Without conversation context, Sonnet frequently assigned readings to the wrong circuit.
- **API key on device.** The Anthropic API key had to be embedded in the iOS app.
- **Cost:** ~$0.52 per session.

### Alternatives considered

1. **Client-side multi-turn:** Maintain conversation history on iOS. Rejected because it would still expose the Anthropic API key on the device and make prompt tuning require app releases.
2. **Batch extraction:** Wait until recording ends, then extract all at once. Rejected because inspectors need real-time feedback during recording to catch errors immediately.
3. **Server-side multi-turn (chosen):** Stream transcripts to the backend over WebSocket, maintain a persistent multi-turn Sonnet conversation server-side.

## Decision

Move all Sonnet extraction to the backend as a **persistent multi-turn WebSocket conversation** at `/api/sonnet-stream`. The architecture:

1. **iOS sends transcripts** (not audio) to the backend over a WebSocket connection via `ServerWebSocketService.swift`.
2. **Backend maintains conversation state** in `eicr-extraction-session.js` -- a full multi-turn conversation history with Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`).
3. **Prompt caching** is enabled with a 1-hour TTL. The system prompt (~1,200 tokens) is cached after the first call, reducing input costs by ~90% for subsequent turns.
4. **Conversation compaction** triggers at ~6,000 tokens, summarizing earlier turns to keep context bounded while preserving essential extraction state.
5. **Results stream back** to iOS in real time: extracted field values, follow-up questions for the inspector, and per-session cost updates (Deepgram minutes + Sonnet tokens).
6. **Regex hints** from the iOS client-side `TranscriptFieldMatcher` are sent alongside transcripts. These provide the field names (not values) that regex already matched, giving Sonnet additional context about what the inspector is currently describing.

The session manager (`sonnet-stream.js`) handles WebSocket lifecycle, authentication, and message routing. The extraction session (`eicr-extraction-session.js`) handles the Anthropic API conversation, compaction logic, question gating (3-second delay before sending follow-up questions to avoid interrupting mid-speech), and cost tracking.

## Consequences

### Positive

- **50% cost reduction.** Prompt caching + multi-turn conversation reduces session cost from ~$0.52 to ~$0.26. The system prompt is processed once and cached for the session duration.
- **Better extraction accuracy.** Multi-turn conversation means Sonnet remembers which circuit is being discussed, what has already been extracted, and the inspector's speech patterns. Circuit misassignment is significantly reduced.
- **API key stays server-side.** The Anthropic API key is loaded from AWS Secrets Manager (`eicr/api-keys`) and never leaves the backend. Only the Deepgram streaming key is sent to the client (via authenticated proxy endpoint).
- **Prompt tuning without app releases.** The extraction system prompt in `eicr-extraction-session.js` can be updated by deploying the backend (~2 minutes) without requiring a new iOS app build or App Store review.
- **Real-time feedback preserved.** Inspectors still see extracted values appear in real time (1-2 seconds after speaking), just with a server round-trip instead of a client-side API call.
- **Conversation compaction bounds costs.** Even long sessions (30+ minutes) stay within predictable token budgets due to automatic compaction at ~6,000 tokens.

### Negative

- **Backend dependency during recording.** If the backend is unreachable, Sonnet extraction stops. Mitigated by client-side regex extraction continuing independently (ADR-004) and the iOS app queuing transcripts for retry.
- **Added latency.** Server round-trip adds ~200-500ms compared to direct Sonnet API calls from the device. Acceptable because regex provides instant (~40ms) field fill and Sonnet overwrites with higher accuracy 1-2 seconds later.
- **WebSocket complexity.** The backend now manages per-session WebSocket state, conversation histories, compaction timers, and session timeouts (5 minutes). This is significant new state management in `sonnet-stream.js` and `eicr-extraction-session.js`.
- **Session timeout risk.** If the WebSocket drops and reconnection fails, the conversation history is lost. Mitigated by the 5-minute session timeout (aligned with the auto-sleep Sleeping state) and client-side reconnection logic.
