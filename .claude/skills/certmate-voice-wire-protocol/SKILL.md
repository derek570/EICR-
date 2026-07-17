---
name: certmate-voice-wire-protocol
description: >
  THE doc of record for the /api/sonnet-stream WebSocket protocol (voice
  dictation -> live extraction -> spoken read-back). Load this whenever you are
  reading, changing, debugging, or testing ANY frame that crosses the recording
  WebSocket: session_start/session_ack/session_resume, transcript,
  extraction + confirmations[], question / ask_user_started /
  ask_user_answered, observation_update, board frames, voice_command_response,
  cancel_pending_tts, cost_update, heartbeat, error —
  or the client-side gates (TranscriptGate, pre-LLM gate) and the web TTS FIFO.
  Also load it before adding ANY new wire field. Do NOT load for CCU photo
  extraction (certmate-ccu-pipeline), REST endpoints (openapi.yaml /api/docs),
  latency tuning campaigns (certmate-latency-campaign), or deploy/ops
  (certmate-run-and-operate).
---

# CertMate voice wire protocol — `/api/sonnet-stream`

The live-dictation WebSocket. There is **no OpenAPI entry for it** — before
this skill, code was the only source of truth. All facts below were verified
against the repo on **2026-07-06**; line numbers drift, so the Provenance
section gives grep commands instead of trusting them.

**Definitions used throughout**
- **Frame** — one JSON object per WS message; discriminated by top-level `type`.
- **Stage 6** — the server-side agentic tool-call extraction loop (ADR-008).
  Live in prod (`SONNET_TOOL_CALLS=live`).
- **Read-back / confirmation** — the spoken echo of an applied reading
  (Audio-First invariant #1: every dictated reading is read back exactly once).
- **Ask** — a blocking question to the inspector, keyed by `tool_call_id`.

## 1. Where the protocol lives (three implementations, synced socially)

| Role | Files |
|---|---|
| Mount point | `src/server.js` — HTTP upgrade routes `url.pathname === '/api/sonnet-stream'` to `initSonnetStream` |
| Backend (authority) | `src/extraction/sonnet-stream.js` (~4570 lines: WS switch, session lifecycle, emit sites) · `src/extraction/stage6-event-bundler.js` (bundles tool calls into the `extraction` result + synthesises `confirmations[]`) · `src/extraction/stage6-shadow-harness.js` (projects Stage-6 shapes onto the legacy wire before emit) · `src/extraction/dialogue-engine/helpers/wire-emit.js` (script asks) · `src/extraction/cost-tracker.js` (`toCostUpdate()`) |
| Web decode/apply | `web/src/lib/recording/sonnet-session.ts` (frame switch in `handleMessage`, all outbound sends) · `web/src/lib/recording/apply-extraction.ts` · `web/src/lib/recording-context.tsx` (orchestration, gate + chime + TTS wiring) |
| iOS (canon for the data contract) | `CertMateUnified/Sources/Services/ServerWebSocketService.swift` (send/decode) + `DeepgramRecordingViewModel.swift` (apply) — CertMateUnified is a **separate nested git repo** |

**Do not confuse** `/api/sonnet-stream` with `/api/recording/stream`
(`src/ws-recording.js`) — the latter is a **legacy Deepgram proxy** with its
own tiny protocol (`start`/`audio`/`stop` in; `ready`/`transcript`/
`transcript_partial`/`extraction`/`stopped` out). Live iOS and web connect to
Deepgram **directly** and use `/api/sonnet-stream` only for extraction.

### The sync-is-social risk

Nothing mechanically enforces that the three implementations agree. Failures
are **silent**: Swift `Codable` throws on a shape mismatch and the WHOLE frame
is dropped (Bug-F 2026-04-26, Bug-H 2026-04-28 — readings vanished while
server logs said "sent OK"); a field-name mismatch is a silent no-op (Bug-I:
backend emitted canonical `measured_zs_ohm`, iOS dispatched on legacy `zs`).
**Rule: any new/changed wire field needs an end-to-end contract test** —
backend emit asserted in `src/__tests__/`, client decode asserted in
`web/tests/` (and an iOS `file:line` citation in the commit per iOS-canon
practice). `web/audit/ws3-checklist-2026-07.md` is the last full wire-shape
audit; `scripts/check-ios-field-parity.mjs` (`npm run check:ios-parity`)
guards field-schema/iOS-apply-switch parity.

Change control: the backend side of this protocol is **IMMUTABLE during
PWA-only work** (hub CLAUDE.md MANDATORY block), and every client-visible
change needs a **web companion** (same wave, or a dated
`web/docs/parity-ledger.md` row with owner). This skill never overrides that.

## 2. Session lifecycle

### `session_start` (client → server)

```json
{ "type": "session_start", "sessionId": "...", "jobId": "...",
  "jobState": { "...": "...", "certificateType": "eicr" },
  "protocol_version": "stage6",
  "capabilities": { "voice_latency": { "version": 1, "supports": ["low_conf_readback_v1"] } } }
```

- `protocol_version: "stage6"` is load-bearing: without it the backend sets
  `fallbackToLegacy=true` and **suppresses `ask_user_started`** — the inspector
  waits in silence (Farm Close incident, sess_moqvdgjl_fo6w, 2026-05-04).
- Certificate type is read from `jobState.certificateType` (default `'eicr'`).
  Web also sends a top-level `certificateType`; the backend ignores it.
- Transcripts arriving **before** `session_start` are buffered server-side and
  replayed after the handler completes.

### Capabilities negotiation (`parseVoiceLatencyCapabilities`)

`src/extraction/voice-latency-config.js`. Parsed ONCE at `session_start` and
**frozen for the session** (`entry.voiceLatency.capabilities`); a mid-session
env flip cannot change behaviour (only `VOICE_LATENCY_KILL_SWITCH` is read
live). Defensive defaults: missing/malformed block, or `version !== 1` →
`version 0, supports = []` → every emitter falls to the legacy path.

Known `supports` strings (`VOICE_LATENCY_KNOWN_SUPPORTS`, as of 2026-07-06):
`streaming_http_audio`, `source_field_in_tts_post`, `regex_fast_tts`,
`voice_latency_ack`, `kill_switch_drop_queue`, `regex_fast_v2`,
`client_playback_telemetry`, `low_conf_readback_v1`.

- **iOS advertises** `regex_fast_v2`, `client_playback_telemetry`,
  `low_conf_readback_v1` (ServerWebSocketService.swift `voiceLatencySupports`).
- **Web advertises ONLY** `low_conf_readback_v1`
  (`VOICE_LATENCY_SUPPORTS` in sonnet-session.ts) — the fast-TTS and
  playback-telemetry contracts are NOT implemented on web (open WS3b items 4/5).
  Claiming an unimplemented capability = lying to the backend gates. Don't.
- `low_conf_readback_v1` is a **rollout-sequencing PRE-APPLY gate**, not a
  behavioural confidence threshold: until the client advertises it, the
  dispatcher SKIPS applying `confidence < 0.5` readings (no wire traffic), so
  an old client never hears a read-back for a value its local filter would
  drop. Once advertised: apply + read back at any confidence.
- Every session logs `voice_latency.startup_log` to CloudWatch (flags snapshot
  + parsed capabilities) — the first thing to check when a session behaves as
  the wrong path.

### `session_ack` statuses (server → client)

| `status` | When | Extra fields |
|---|---|---|
| `started` | Fresh `session_start` | `sessionId` = **server-minted rehydrate token** (NOT the client sessionId) — echo it in later `session_resume` |
| `reconnected` | `session_start` while the server entry is still alive (socket swap) | `sessionId` (rehydrate token) |
| `resumed` | `session_resume {sessionId}` rehydrate hit, or legacy bare `session_resume` (Deepgram-doze wake) | `sessionId` on the rehydrate path |
| `new` | `session_resume` rehydrate MISS (5-min TTL expired / unknown id) — client should treat as fresh context | |
| `paused` | `session_pause` | |
| `stopped` | `session_stop` | `sessionStats` summary |

After `started`/`reconnected`, the server emits an initial
`current_board_changed` (`source: 'session_start'` / `'session_resume'`) so the
client's current-board pointer converges. Reconnect also flushes any
`extraction` results buffered while the socket was down, rejects all pending
asks (`rejectAll('session_reconnected')`), and clears the utterance dedupe
ledgers.

### Keep-alive and teardown

- Client sends `{"type":"heartbeat"}` every **25 s** (`HEARTBEAT_INTERVAL_MS`,
  sonnet-session.ts). Server case is a deliberate **no-op**: the data frame
  itself refreshes the AWS ALB idle timeout (WS PING control frames do not).
  There is NO server→client heartbeat.
- `session_pause` / `session_resume` (bare) = the Deepgram doze cycle.
  Deliberately **not** a chitchat wake trigger (see §6).
- `session_compact` — client-requested history compaction (rate-limited;
  can ack `status:'compact_skipped'`).
- `session_stop` → final `session_ack {status:'stopped', sessionStats}`.

## 3. Client → server frames

| Frame | Shape (load-bearing fields) | Notes |
|---|---|---|
| `transcript` | `{text, timestamp, utterance_id?, confirmations_enabled?, regexResults?, in_response_to?, regex_fast_correlation_id?}` | The workhorse. `confirmations_enabled` is emitted **only when true** (iOS-conditional; omitting = no read-back synthesis for the turn — see §4). `utterance_id` is client-minted, used for ask/transcript dedupe and echoed back on `extraction`. `regexResults` = `[{field, value?}]` regex hints (chitchat wake + counter reset + Sonnet context). `in_response_to` = `{type, question, field?, circuit?}` — the preceding TTS question, so bare "yes"/"code 2" keeps attribution; `question` is the load-bearing key. |
| `ask_user_answered` | `{tool_call_id, user_text, consumed_utterance_id?}` | Resolves a blocking ask. **Ordering invariant:** send the matching `transcript` (with `utterance_id=X`) FIRST, then `ask_user_answered` (`consumed_utterance_id=X`) — the backend keeps symmetric FIFO dedupe ledgers (`consumedAskUtterances` / `seenTranscriptUtterances`) plus content-anchor fallbacks for legacy clients; wrong order degrades to fuzzy text matching that collides on short answers. `tool_call_id` starting `srv-` short-circuits to the dialogue engine (never a Sonnet tool_result). Unknown/stale ids are logged and dropped. |
| `correction` | `{field, circuit, value}` | Manual UI edit forwarded as a pseudo-transcript so Sonnet state stays consistent. |
| `job_state_update` | `{...jobState}` (circuits or boards[]) | Refreshes the server StateSnapshot; if missing after a CCU extraction, Sonnet asks about circuits already on screen. |
| `select_board` | `{board_id}` | Client-initiated board switch; mutates the snapshot directly (no Sonnet round-trip); server replies `select_board_ack`. Web currently never sends it (decode only). |
| `tts_cancelled_by_user` | `{reason, vad_probability?}` | Barge-in telemetry; log-only server-side. |
| `heartbeat` | `{}` | §2. |
| `client_diagnostic` / `client_log_batch` | envelopes | Client debug telemetry → CloudWatch/S3; buffered while disconnected and drained after reconnect. |
| `session_*` | see §2 | |

Web buffers `transcript` / `correction` / `ask_user_answered` while
disconnected and replays them on reconnect with `reorderPendingForReplay`,
which preserves the transcript→ask pairing above even if frames were queued
out of order.

## 4. Server → client frames

### `extraction` — and the `confirmations[]` that ride on it

```json
{ "type": "extraction", "result": {
    "readings": [{ "field": "...", "circuit": 3, "value": "...", "confidence": 0.9,
                    "source": "tool_call", "board_id": "...?", "auto_resolved": true? }],
    "observations": [{ "observation_id": "...", "observation_text": "...", "code": "C2", ... }],
    "questions": [],
    "confirmations": [{ "text": "...", "expanded_text": "...", "field": "...",
                         "circuit": 3, "circuits": [3,4]?, "board_id": "...?" }],
    "circuit_updates": [{ "circuit": 5, "designation": "", "action": "delete", "board_id": "...?" }],
    "field_clears": [...], "board_ops": [...],
    "turn_id": "...?", "utterance_id": "...?",
    "extraction_failed": false?, "error_message": "...?", "validation_alerts": [...]? } }
```

Key facts (each one has bitten someone):

1. **On the wire the readings key is `readings`** — the bundler's internal
   `extracted_readings` is renamed at the emit site in sonnet-stream.js
   ("Rename extracted_readings → readings to match the web client interface").
   The dialogue engine's `buildExtractionPayload` emits `result.readings`
   directly. Grep for `extracted_readings` only server-side.
2. **`confirmations` is an ARRAY ON `extraction`, not a standalone frame.**
   Synthesised by `stage6-event-bundler.js` from the per-turn writes ONLY when
   the inbound transcript carried `confirmations_enabled: true`. Covers
   readings, board readings, state changes (create/rename/delete circuit,
   add/select board), observations, and clears. Omitted when empty
   (omit-when-empty is the house wire convention — keeps old decoders
   byte-identical).
3. **Auto-derivations are exempt from read-back** (Audio-First #1 exception):
   writes with `derived:true` or a `::calc::` source_turn_id stay on
   `readings` but are excluded from `confirmations`.
4. **Cross-turn confirmation debounce** keys on
   `field + circuit + circuits + board_id + value` (1500 ms window,
   `applyConfirmationDebounce`) — field-only keying was a 2026-06-18 bug that
   swallowed same-field different-circuit read-backs.
5. **The Stage-6 → legacy projection happens in `stage6-shadow-harness.js`
   before emit**: circuit-op meta is folded into readings; Stage-6-only slots
   (`circuit_updates` op-shape, `extracted_board_readings`, `cleared_readings`,
   `observation_deletions`) are **stripped** (Swift throws on them — Bug-F);
   deletes are re-emitted as legacy `{circuit, designation:'', action:'delete'}`;
   observations are renamed to the legacy keys
   (`observation_id`/`observation_text`/...) — Bug-H. If you "clean up" this
   projection you will silently break iOS.
6. `turn_id` / `utterance_id` are echoed when available — iOS pairs
   `utterance_id` with its pending utterance-end to close the
   perceived-latency telemetry loop; missing echo = 100 % orphaned latency
   POSTs.
7. `field_clears` is a legacy prose-JSON-path key; the Stage-6 clear path is
   the separate `field_corrected` frame. Web normalises both into one apply
   path.

### Questions / asks

| Frame | Shape | Producer |
|---|---|---|
| `ask_user_started` | `{tool_call_id, question, reason, context_field, context_circuit, expected_answer_shape: 'value'\|'none'}` | THE live ask path: Stage-6 `ask_user` dispatcher AND dialogue-engine scripts (`wire-emit.js`). `reason` ∈ `missing_value`, `missing_context`, `info`, schema-specific confirm reasons. `expected_answer_shape:'none'` = informational TTS, no answer expected. Web maps it onto its `SonnetQuestion`/onQuestion path and latches `tool_call_id` as the in-flight ask. |
| `question` | `{question_type, question, field?, circuit?, ...}` | LEGACY path only: `questions_for_user` via `QuestionGate` (1500 ms debounce, `QUESTION_GATE_DELAY_MS`). Sonnet's inner `type` is renamed `question_type` so it can't clobber the WS discriminator. Still decoded by both clients; in live tool-call mode the server refuses to forward legacy questions (one-shot bypass log). |

- `tool_call_id` conventions: Sonnet asks use Anthropic tool-call ids;
  dialogue-engine scripts mint `srv-<script>-<sessionId>-...` ids with
  prefixes `srv-rcd`, `srv-rcbo`, `srv-ocpd`, `srv-irs` (insulation
  resistance), `srv-rcs` (ring continuity).
- **`context_board_id` is backend-internal**: it exists on the ask_user tool
  schema, the auto-resolve write sites, and the ask-budget key — but neither
  client decodes it (reclassified WS3, 2026-07-02). Do not "add" client
  decode without a plan.
- Server-side ask throttles: per-(field,circuit) **ask budget cap = 2** (3rd
  ask short-circuits `ask_budget_exhausted`), gate debounce, restrained-mode
  **stubbed always-inactive** (kept as a stub because the gate wrapper only
  composes when the key is truthy — deleting it would bypass the budget too).
- All pending asks are rejected on any socket rebind.

### Observations — dual-path `observation_update`

```json
{ "type": "observation_update", "observation_id": null|"...",
  "observation_text": "...", "original_text": "...?", "code": "C2",
  "regulation": "411.3.2"|null, "regulation_title": null|"...",
  "regulation_description": null|"...", "schedule_item": "...?",
  "rationale": "...?", "source": "rule_6_edit"|"bpg4_refinement"|... }
```

Three emit paths, same frame type:
1. **Immediate RULE-6 edit** (`dispatchObservationUpdates`) — "make that a C2"
   corrections; fires BEFORE refinement so the code change lands first.
2. **BPG4 refinement** (`refineObservationsAsync`, gpt-5-search-api) — the
   observation first appears inside `extraction.result.observations` (~200 ms
   row), then this frame patches it ~2 s later with the professional rewrite +
   regulation.
3. **Reconnect replay** of cached refinements (2 s dedupe window,
   `recentlyRefinedIds`).

`regulation_title`/`regulation_description` are the canonical BS 7671 table
wording, looked up fresh on EVERY path; **`null` means table MISS and the
client must CLEAR stale wording, not keep it** (obs-#52 Fix B). Row matching:
`observation_id` exact first, fuzzy text (`original_text`) fallback.

### Board frames

| Frame | Shape | Notes |
|---|---|---|
| `current_board_changed` | `{board_id, designation\|null, source}` | Unified broadcast; `source` ∈ `session_start`, `session_resume`, Sonnet select/add-board, voice command — clients use it to suppress banner animation on non-events. |
| `select_board_ack` | `{ok, board_id\|null, designation\|null, error\|null}` | Reply to client `select_board`. |

### The rest

| Frame | Shape | Notes |
|---|---|---|
| `voice_command_response` | `{understood, spoken_response, action\|null}` | Sonnet's `spoken_response`/`action` are STRIPPED from `extraction.result` and sent separately. Web plays `spoken_response` via the confirmation FIFO (deliberate divergence, low stakes). |
| `cancel_pending_tts` | `{prefix, sessionId}` | See §5 — the only frame whose whole point is client-side audio state. |
| `cost_update` | `{sonnet:{turns,cacheReads,cacheWrites,input,output,compactions,cost}, deepgram:{minutes,cost}, elevenlabs:{characters,cost}, gptVision:{photos,inputTokens,outputTokens,cost}, totalJobCost}` | `cost-tracker.js toCostUpdate()`; sent after each extraction turn. |
| `field_corrected` | `{circuit, field, previous_value\|null, reason\|null}` | Stage-6 `clear_reading`; emitted per-event AFTER the extraction envelope. |
| `error` | `{message, recoverable}` | `recoverable:false` + WS close 1008 on transcript rate-limit. |
| `tool_call_started` / `tool_call_completed` / `circuit_created` / `circuit_updated` / `observation_deleted` | decoded by web (and iOS stubs) | **No backend emit site exists as of 2026-07-06** — reserved for the Phase-6/7 protocol cutover. Don't document them as live; don't delete the decoders. |

## 5. `cancel_pending_tts` — prefix semantics and client duties

Emitted at `dialogue-engine/engine.js` (~L1020) on every `*_script_cancelled`:
`{ type: 'cancel_pending_tts', prefix: '<toolCallIdPrefix>-', sessionId }` —
e.g. `prefix: "srv-rcd-"`. Motivating bug: a queued "BS number?" TTS outlived
its cancel by 18 s (session 60754E4D).

Client duties on receipt (web: `handleCancelPendingTts` in
`tts-prompt-helpers.ts`, wired via recording-context; iOS:
`AlertManager.purge(prefix:)`):
1. Silence the in-flight/deferred DIRECT prompt whose `tool_call_id` starts
   with `prefix` — **not gated on whether audio is currently playing**.
2. Clear ask state for that prefix: `SonnetSession.
   clearInFlightToolCallIdByPrefix(prefix)`, in-flight-question tracker
   `removeByToolCallIdPrefix(prefix)`, visible question cards, dismiss timers.
3. Purge any queued TTS in the same namespace (web FIFO `purge(prefix)` is
   currently a no-op — confirmations carry no cancel key — but the call site
   exists deliberately).
Empty/missing `prefix` → ignore the frame.

## 6. Server-side forwarding gates (why your transcript never reached Sonnet)

**Pre-LLM gate** (`src/extraction/pre-llm-gate.js`; kill switch
`VOICE_PRE_LLM_GATE=false`). Blocks no-chance transcripts BEFORE the Anthropic
call. Forward-decision order (memorise it before debugging "Sonnet ignored
me"): gate-disabled → drained-retry → pending-ask → active dialogue script →
`in_response_to` → regex hints → (empty text: block) → has-digit →
observation-prefix (fuzzy "observation" incl. Deepgram garbles) → strong
trigger (~20 domain words) → weak trigger (~75) → **block LOW_CONTENT**.
Blocks emit `voice_latency.gate_blocked` to CloudWatch; UX is deliberate
silence. Bare negations (`no`/`nope`/`nah`) forward (Option-B correction flow).

**Chitchat pause — RETIRED 2026-07-17** (Derek). The `chitchat-pause.js` state
machine, the `chitchat_paused`/`chitchat_resumed`/`chitchat_resume` frames, the
`CHITCHAT_*` thresholds, and the client banner/Resume are ALL removed. The
electrical-term forward-gate (below) is now the sole engagement decision —
non-electrical chat is filtered at the gate (no chime, no forward), so the
separate streak-based pause was redundant (and split-brain vs the chime). See
`docs/reference/changelog.md` (2026-07-17).

**Client-side TranscriptGate** (web `web/src/lib/recording/transcript-gate.ts`,
literal port of iOS `DeepgramRecordingViewModel.swift` TranscriptGate; both
mirror the backend gate's trigger lists). Runs in web `dispatchFinal`
(recording-context.tsx); a PASS is the anchor for the "sent for processing"
chime (`playSentForProcessingChime()`, 960 Hz/80 ms). PERMISSIVE by design —
when in doubt, forward; the backend gate is the authority. The three trigger
lists must move in lock-step (backend ⇄ iOS ⇄ web) — this is a named
sync-is-social hot spot.

## 7. Client TTS FIFO — the exactly-once read-back contract

Audio-First #1: every applied reading → exactly ONE spoken confirmation.
Wire-relevant client rules (web: `tts-queue.ts` + `tts.ts`, shipped 2026-07-06
PR #85 mirroring iOS AlertManager Phase 7.1):

- `speakConfirmation()` (extraction `confirmations[]`) → FIFO queue,
  `MAX_QUEUE_DEPTH = 6`, overflow **drops the oldest**; a drop fires a
  synchronous `onDiscarded(dedupeKey)` un-record so the confirmation is
  re-speakable later — never a permanent silent loss.
- `speak()` (asks / `ask_user_started` / alerts) is DIRECT and **preempts** the
  FIFO (`preemptFlush()`); asks always outrank read-backs.
- Ownership token (`direct` vs `queue`): barge-in `cancelSpeech({resetQueue:false})`
  kills only a direct-owned prompt, never a queued confirmation; full teardown
  resets the queue FIRST.
- Deferral: queue head re-checks `shouldDeferPlayback` post-fetch/pre-play
  (inspector speaking → hold); the deferred head resumes from BOTH
  utterance-end and the phantom-SpeechStarted reset path.
- Read-back dedupe key = the full iOS `buildConfirmationDedupeKey`
  (`confirmation-dedupe-key.ts`, djb2/BigInt, includes circuits list +
  board_id + text hash) — field-only or circuit-null keys re-introduce the
  double/zero-confirm bugs.

Backend counterpart: the bundler emits confirmations only when the transcript
said `confirmations_enabled:true`, exempts derived writes, and debounces
duplicates (§4). If read-backs are missing, check — in order — the transcript
flag, the capability gate (`< 0.5` pre-apply skip), the derived-write
exemption, the debounce key, then the client FIFO.

## 8. Adding or changing a wire field — checklist

1. **Classify.** Does the backend emit/read it? Then it is a cross-platform
   change: forbidden during PWA-only work; needs an explicit mandate + iOS
   plan + web companion (or dated ledger row with owner).
2. **Follow the omit-when-empty convention** — never emit a new key with an
   empty/None value; old Swift decoders must see byte-identical traffic.
3. **Never change a shape iOS already decodes** — additive optional keys only
   (Swift `decodeIfPresent`); a type change throws away the whole frame.
4. **Gate behavioural changes on a capability string**, not on deploy order:
   add to `VOICE_LATENCY_KNOWN_SUPPORTS` (or mint a new capability family),
   parse defensively, default to the legacy path.
5. **Write the end-to-end contract test** (backend emit → JSON → client
   decode) on BOTH suites before shipping; cite the iOS decode site
   (`file:line`) in the commit body.
6. **Update this skill** and, if the field is client-visible, the parity
   ledger row.

## When NOT to use this skill

- CCU photo extraction frames/REST (`/api/analyze-ccu`) → `certmate-ccu-pipeline`.
- REST API shapes → `docs/api/openapi.yaml` (served at `/api/docs`); ops →
  `certmate-run-and-operate`.
- Latency measurement/tuning of the dictate→confirm loop →
  `certmate-latency-campaign` (mechanics) and
  `certmate-diagnostics-and-tooling` (bench scripts).
- Why the architecture is shaped this way (server-side extraction, 3-tier
  priority) → `certmate-architecture-contract`.
- What C1/C2/Zs/LIM mean → `bs7671-domain-reference`.
- Historical thrash on this pipeline → `certmate-failure-archaeology`;
  live-symptom triage → `certmate-debugging-playbook`.
- Whether you're allowed to make the change at all →
  `certmate-change-control`.

## Provenance and maintenance (re-verify before trusting; all as of 2026-07-06)

| Fact | One-line re-verification |
|---|---|
| Mount path | `grep -n "sonnet-stream" src/server.js` |
| Client→server frame set | `grep -n "case '" src/extraction/sonnet-stream.js` |
| Server→client frame set | `grep -n "type: '" src/extraction/sonnet-stream.js \| grep -oE "type: '[a-z_]+'" \| sort -u` (plus `chitchat-pause.js`, `cost-tracker.js`, `dialogue-engine/engine.js`, `dialogue-engine/helpers/wire-emit.js`) |
| Web decode switch | `grep -n "case '" web/src/lib/recording/sonnet-session.ts` |
| Capabilities list + parser | `grep -n "KNOWN_SUPPORTS\|version !== 1" src/extraction/voice-latency-config.js` |
| Web capability claim | `grep -n "VOICE_LATENCY_SUPPORTS" web/src/lib/recording/sonnet-session.ts` |
| iOS capability claim | `grep -n "voiceLatencySupports\|low_conf_readback" CertMateUnified/Sources/Services/ServerWebSocketService.swift` |
| `readings` rename at emit | `grep -n "readings: extracted_readings" src/extraction/sonnet-stream.js` |
| Confirmations synthesis + debounce | `grep -an "confirmationsEnabled\|confirmationDebounceKey" src/extraction/stage6-event-bundler.js` (**note `-a`: this file trips BSD grep's binary heuristic**) |
| Legacy-wire projection/strips | `grep -n "delete result.circuit_updates" src/extraction/stage6-shadow-harness.js` |
| `cancel_pending_tts` emit + prefixes | `grep -rn "cancel_pending_tts" src/extraction/dialogue-engine/engine.js; grep -rn "toolCallIdPrefix:" src/extraction/dialogue-engine/schemas/` |
| Ask frame shapes | `sed -n '25,160p' src/extraction/dialogue-engine/helpers/wire-emit.js` |
| observation_update emitters | `grep -n "type: 'observation_update'" src/extraction/sonnet-stream.js` |
| Chitchat thresholds + wake set | `grep -n "CHITCHAT_PAUSE_THRESHOLD\|REPLAY_HORIZON" src/extraction/chitchat-pause.js; grep -n "negationHit\|observationHit" src/extraction/sonnet-stream.js` |
| Pre-LLM gate order | `sed -n '1,80p' src/extraction/pre-llm-gate.js` |
| QuestionGate delay | `grep -n "QUESTION_GATE_DELAY_MS" src/extraction/question-gate.js` |
| Heartbeat interval / server no-op | `grep -n "HEARTBEAT_INTERVAL_MS" web/src/lib/recording/sonnet-session.ts; grep -n "case 'heartbeat'" src/extraction/sonnet-stream.js` |
| TTS FIFO depth + preempt | `grep -n "MAX_QUEUE_DEPTH\|preemptFlush" web/src/lib/recording/tts-queue.ts web/src/lib/recording/tts.ts` |
| ask-budget cap | `grep -n "cap" src/extraction/stage6-ask-budget.js` |
| Dormant frame types (no emit yet) | `grep -rn "type: 'circuit_created'\|type: 'tool_call_started'" src/extraction/ --include='*.js' \| grep -v __tests__` (expect empty) |
| session_ack status set | `grep -n "status: '" src/extraction/sonnet-stream.js` |
