> Last updated: 2026-02-18
> Related: [iOS Pipeline](ios-pipeline.md) | [Deployment](deployment.md) | [Field Reference](field-reference.md) | [File Structure](file-structure.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# Architecture Reference

## Tech Stack

| Component | Technology |
|-----------|------------|
| iOS App | SwiftUI (CertMateUnified) — primary user interface |
| Transcription | Deepgram Nova-3 (direct WebSocket from iOS) |
| Data Extraction | Claude Sonnet 4.5 (live rolling extraction) + OpenAI GPT (batch/CCU photo analysis) |
| Photo Analysis | OpenAI Vision API |
| Backend | Node.js (ES modules) — API server, job processing, S3 storage |
| Editor UI | Python Streamlit (legacy, replaced by iOS app) |
| PDF Generation | CLIENT-SIDE on both apps since 2026-07-02: iOS `EICRHTMLTemplate.swift`→WKWebView; web `web/src/lib/pdf/` (TS port of the iOS template + foreignObject capture + pdf-lib Blob). Server Python ReportLab + Playwright (Chromium) is FALLBACK/DEBUG-ONLY (web "Generate on server (fallback)" action; flips behind the debug page after field validation) |
| Cloud Storage | AWS S3 |
| Secrets | AWS Secrets Manager |

## Backend Container Architecture

The backend Docker container (`Dockerfile.backend`) includes:
- **Node.js 20** - Job processing pipeline
- **Python 3 + pip** - PDF generation scripts (fallback path only since 2026-07-02 — the web PWA renders certificates client-side)
- **Playwright + Chromium** - Browser-based PDF rendering (same fallback path)
- **Sharp/libvips** - Image processing
- **All Python dependencies** from `requirements.txt`

**Key environment variables (set automatically):**
- `USE_AWS_SECRETS=true` - Loads API keys from AWS Secrets Manager at startup
- `NODE_ENV=production`
- `PORT=3000`

**Health check:** ALB uses `/health` endpoint (not `/`)

## PWA Container Notes

- `Dockerfile.pwa` uses `node:20-alpine` (minimal image)
- Container health check removed (task definition revision 6+) - relies on ALB health check only
- ALB health check: `/login` endpoint

## API Data Loading

The processing pipeline outputs separate JSON files, but the API can load from either format:
- **Pipeline outputs:** `installation_details.json`, `board_details.json`, `observations.json`
- **API also accepts:** `extracted_data.json` (combined format, created by PUT endpoint)

**Data Transformation:** When loading from pipeline files, `api.js` uses `transformExtractedData()` to map extracted data to UI format:
- Splits `board_details.json` into `board_info` + `supply_characteristics` + `installation_details`
- Maps fields like `ze` → `earth_loop_impedance_ze`, `voltage_rating` → `nominal_voltage_u`
- Sets sensible defaults for missing UI fields (e.g., `premises_description: "Residential"`)

If job data appears empty in PWA, check that API is reading the correct file format.

## Environment Variables

### Cloud (AWS Secrets Manager)
The cloud app gets API keys automatically from AWS Secrets Manager:

| Secret | Contents |
|--------|----------|
| `eicr/api-keys` | Single JSON with ALL API keys: OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, JWT_SECRET, etc. |
| `eicr/database` | PostgreSQL host, port, database, username, password |

**No action needed** - cloud deployment works without local API keys.

### Local Testing (Optional)
Only needed if you want to test locally before deploying. Add to `.env`:
```
OPENAI_API_KEY=sk-...              # For GPT extraction + Vision
GEMINI_API_KEY=...                 # For audio transcription
GEMINI_MODEL=gemini-3-pro-preview  # Transcription model
```

**Note:** You can skip local testing and deploy changes directly to the cloud.

## AI Models Reference

Current models used by the backend processing pipeline:

| Purpose | File | Model | Env Var |
|---------|------|-------|---------|
| Chunk transcription | `transcribe.js:242` | `gemini-3-pro-preview` | `GEMINI_CHUNK_MODEL` |
| Full transcription | `transcribe.js:104` | `gemini-3-pro-preview` | `GEMINI_MODEL` |
| Transcription fallback | `transcribe.js:105` | `gemini-2.5-flash` | `GEMINI_FALLBACK_MODEL` |
| Data extraction | `extract.js:278` | `gpt-5.2` | `EXTRACTION_MODEL` |
| Chunk extraction | `extract_chunk.js:48` | `gpt-5.2` | `EXTRACTION_MODEL` |
| Photo analysis | `analyze_photos.js:132` | `gpt-5.2` | `EXTRACTION_MODEL` |
| Salvage numbers | `salvage_numbers.js:9` | `gpt-5.2` | `EXTRACTION_MODEL` |
| OCR certificates | `ocr_certificate.js:218` | `gpt-4o` | (hardcoded) |
| Legacy transcribe | `gemini_transcribe.js:39` | `gemini-2.5-flash` | `GEMINI_MODEL` |

**Note:** For recording, iOS fetches API keys from `GET /api/keys` and connects directly to Deepgram. Sonnet extraction runs server-side via WebSocket. For batch processing and CCU photo analysis, the backend calls AI APIs directly.

## Stage 6 Agentic Extraction (live recording path)

Live recording flows through the Stage 6 agentic extraction pipeline. `config/field_schema.json` is the single source of truth for every extractable field; the tool schemas (`src/extraction/stage6-tool-schemas.js`) generate `record_reading.field` / `record_board_reading.field` enums from it at module load.

Sonnet's `ask_user` tool carries an OPTIONAL `pending_write` property. When the inspector says a value without enough context (e.g. "Number of points is 4" with no circuit), Sonnet attaches the buffered write to its ask. The server then:

1. Holds the user's reply.
2. Runs the deterministic answer resolver (`src/extraction/stage6-answer-resolver.js`) against the pending write + available circuits.
3. **High-confidence match** → server auto-emits the write through the normal write path (`createAutoResolveWriteHook` in `src/extraction/stage6-dispatchers.js`). Tool result body: `match_status: "auto_resolved", resolved_writes: [...]`. Sonnet doesn't write again.
4. **Low-confidence / ambiguous** → tool result echoes back `pending_write` + `available_circuits` + `parsed_hint`. Sonnet writes itself in the next turn.

**Inverted asks — `pendingValue` + the `pvr-*` deterministic broker (field-feedback-2026-07-14 §A4).** `pending_write` covers the field-known shape (value expected in the answer). The INVERSE shape — value spoken, FIELD garbled, ask emitted with `context_field:"none"` — is covered by `pendingValue`: at ask registration the server captures the dangling value (`stage6-pending-value.js` `extractPendingValue` — unit-bound numbers preferred, circuit/board-adjacent numbers excluded as scope, multiple candidates → no capture) from the turn transcript (question fallback) onto the pending-asks entry, and copies it into the resolve outcome (the registry deletes entries before resolution runs). A field-name reply ("RCD trip time.") resolves via `resolveFieldNameAnswer` and dispatches `record_reading` through the SAME `createAutoResolveWriteHook` path (validation, wire canonicalisation, read-back bundling; board scope preserved via `write.board_id`). Unresolvable pieces re-ask DETERMINISTICALLY via a `pvr-*` broker that REGISTERS in the pending-asks registry BEFORE sending `ask_user_started` (a bare emit would orphan the answer; `srv-*` ids bypass the registry) — four-shape state machine (field ask / value ask / circuit ask / terminal), retry cap 1 per shape, terminal = an audible apology drained through `result.confirmations`. Both answer channels are guarded by the TYPED schema-aware fresh-reading detector (`detectStructuredReading`, all field families incl. select options+aliases, boolean vocab, assignment-form free text): a structurally complete fresh reading is an OVERTAKE (re-injected + written), never consumed as an ask answer. While a blocking ask holds `isExtracting`, `handleTranscript` classifies pending asks PRE-QUEUE (answers resolve-and-consume; evidence-backed moved-on rejects; everything else queues unchanged).

**Observation severity clarification chains (field-feedback-2026-07-14 §D2; mutation-to-chain correlation 2026-07-15).** Ambiguous C2-vs-C3 observations trigger ONE targeted factual `ask_user` (`context_field:"observation_clarify"`, `reason:"observation_confirmation"`). The ask budget for these is keyed per OBSERVATION, not per scope: the gate wrapper mints a `clarification_chain_id` on each initial ask (echoed in the tool_result; the model echoes it on the single bounded continuation), so two ambiguous observations at one scope get separate budget buckets while a chain's own third ask is blocked. Chains retire on observation mutation / audible termination / terminal fallback.

A post-answer write-or-reask net in the harness closes the beep-then-silence path when the model drops a clarified observation, independent of the A3 orphan net (which structurally cannot see this case). As of 2026-07-15 the net **correlates each write to its chain**: `record_observation` carries the echoed `clarification_chain_id` (nullable-required tool field; `null` for a direct/unclarified observation), the net GROUPS answered clarify asks by chain id (latest anchor per chain), and evaluates each chain once against events after ITS anchor — a matching successful `record_observation`, or a same-chain audibly-terminated continuation. "Successful" = `is_error !== true` AND a parsed tool-result body with `ok === true` (a parser that catches malformed bodies internally, never throwing into the net's outer catch). Mutation-id resolution is **LENIENT** on both edge cases (Derek 2026-07-15): an id-less write (D-1a) or an unknown/invented non-null id (D-1b) qualifies EVERY evaluated chain whose anchor precedes it — today's suppression outcome, chosen because a false "I didn't record that" apology → re-dictation → duplicate observation is a worse field failure than the residual (prompt-mitigated) suppression when the model omits the id; only a non-null id matching a DIFFERENT evaluated chain fails to qualify this one. All unqualified chains collapse into ONE count-aware field-nil fallback (singular vs plural wording); every evaluated non-null chain retires exactly once, after all qualification decisions. Zero-client: `clarification_chain_id` is server-internal — the dispatcher returns exactly `{ok:true, observation_id}` and the field never enters `extractedObservations`, `perTurnWrites`, the legacy wire, or any log row (the raw model-controlled id is NEVER logged; telemetry logs only a `mutation_id_kind` of `null`/`matched`/`unknown` plus server-minted chain ids, via `stage6.observation_clarify_dropped_net` and the `stage6.observation_clarify_lenient_qualification` INFO row). **Known limitation (D-2, dated 2026-07-15, ACCEPTED):** because the fallback wording is stable, ANY same-wording D2 fallback repeated within 30s — singular after singular or plural after plural — may be client-deduped by the A1(b) field-nil TTL (`field:null` is outside `DEDUPE_TOKEN_FIELDS`, so a `dedupe_token` cannot rescue it). A rare compound failure; stable wording preserves the A1(b) dedupe's purpose, so no wording variants are added.

**Ask-emission audit signal + pre-emission audibility net (F7 hardening, task #16).** The A3 orphan net, the §D2 net, and the A4 pending-voice-prompt drain all MISS the case where Sonnet emitted an `ask_user` that was SUPPRESSED before `ask_user_started` crossed the wire (`restrained_mode` / `ask_budget_exhausted` / `validation_error` / prompt-leak / `dispatcher_error` / closed-WS / throwing-send / `fallbackToLegacy`), leaving a transcript-gate chime followed by SILENCE. `runLiveMode` now builds a per-turn `emittedAskToolCallIds` Set fed by a best-effort `onAskUserStarted({toolCallId, source})` OBSERVATION hook fired ONLY on a SUCCESSFUL send — by the initial dispatcher (`source:'initial'`), the `pvr-*` broker (`source:'pvr'`), and the dialogue engine's SINGLE send choke point `safeSend` (`source:'dialogue_script'`, via an observer attached to the WS under `ASK_STARTED_OBSERVER`, structurally covering every current+future engine emission path). A pre-emission net (AFTER §D2, BEFORE the A4 drain, gated on `confirmationsEnabled`) queues ONE deterministic field-null apology when an ask was attempted, `emittedAskToolCallIds` is empty, and no confirmation/prompt with trimmed-non-empty text survives. §D2's continuation qualification is tightened to require the continuation's `tool_call_id ∈ emittedAskToolCallIds` (a swallowed continuation reports `timeout` but was never spoken). The initial live dispatcher FAST-FAILS a closed socket / throwing send / `fallbackToLegacy` immediately as a pre-emission failure (`reason:'dispatcher_error'`, `lifecycle:'pre_emit'`, diagnostic `closed_ws`/`send_threw`/`fallback_to_legacy`) instead of waiting the 45s `ASK_USER_TIMEOUT_MS`. Two telemetry rows — `stage6.ask_user_started_emitted` (positive emission) + `stage6.ask_audibility_fallback_emitted` — plus a `generationId` (minted per extraction invocation in `sonnet-stream.js`) on those + `ios_send_attempt`, so the ship-gate join keys on the EXACT triple `sessionId + turnId + generationId`.

**marker-② catch-all audibility net (numeric-gate-redesign, 2026-07-18).** The FINAL audibility net, closing the class every earlier net structurally misses: **"a tool ran, didn't error, but emitted nothing audible"** (live 8/8 repro: "Zs for circuit 4." → the model calls `calculate_zs`, which succeeds with `computed:[]` because the circuit lacks inputs — a successful tool call defeats `producedNothing` (A3/marker-①), `is_error:false` defeats the M1 all-rejected net, and no ask was attempted so F7 declines → beep-then-silence). Placed AFTER A3/D2/F7 and BEFORE the §A4 drain in `runLiveMode`, it speaks ONE rotating apology (`CATCHALL_AUDIBILITY_PROMPTS`, 5 phrasings, string-distinct from every other apology family — pinned by test) when: `confirmationsEnabled` ∧ `chimeObserved` ∧ not-cancelled ∧ **zero speech-intent survived** ∧ not a designed-silent side-effect turn. Speech-intent = surviving trimmed-non-empty confirmations + `emittedAskToolCallIds` + current-generation queued prompts + a NEW per-turn `debouncedConfirmationCountThisTurn` (a confirmation produced then suppressed by `applyConfirmationDebounce` means the inspector already heard that reading — no false apology; client-side dedupe is deliberately invisible, owned by the PLAN-C client watchdog). Readings/observation COUNTS are deliberately NOT audibility (successful writes are UI state; counting them preserved the bug). The designed-silent exemption is classified by dispatcher OUTCOME, never tool name, and WHOLE-TURN (Codex diff-review cycle 1): exempt only when EVERY tool call is a FULLY-computed calculator success (`ok:true ∧ computed.length>0 ∧ skipped===[]` — its readings carry `::calc::` and are read-back-exempt BY DESIGN per the 2026-06-18 Audio-First auto-derivation exception) AND the loop ledger is clean (not aborted/cap-hit, zero per-round errors, attempted==accumulated — a thrown dispatcher or padded `internal_no_result` never reaches `tool_calls`, so the visible subset alone can't prove the turn clean; missing ledger arrays fail CLOSED). Partial batches, mixed turns, malformed `skipped` shapes and `computed:[]` — missing-input AND already-recorded — all FIRE (pinned: never silent; a specific "already recorded" wording is a dispatcher follow-up). Mutual exclusion with marker-①/A3/D2/F7 is structural (their outputs count as speech-intent). Telemetry: `stage6.catchall_audibility_fallback_emitted` (+ `stage6.catchall_audibility_net_error` guard). Companions: recorded fixture `frc_b6ec5356…` (RED-proven `audibility.turn` → `required_green`) and the Phase-4 prompt steer (bare value-less "Zs for circuit N" now ASKS for the value; `calculate_zs` reserved for explicit compute intent — verification = the post-deploy live probes A/B/C, REQUIRED after the ECS rollout and not yet run at merge time — model behaviour is live-lane, not fixture-lockable). **Generic-failure finalization (same wave, Codex cycle 2):** a GENERIC live `runToolLoop` failure (network/API/stream error) previously early-returned an EMPTY extraction BEFORE every audibility net — beep-then-silence on any transport error. It now deliberately REUSES the F7 Item-3 cancellation finalization (cancelled latch; `toolLoopOut`-guarded blocks skip; pre-crash writes still read back once; the F7 nothing-audible fallback guarantees one apology; iOS receives a well-formed partial result; `stage6_live_error` retained). Known parity residuals (identical to the shipped watchdog-cancellation semantics, owned by PLAN-C): a prior EMITTED ask counts as turn audibility, and dialogue-script resume/entry hooks are skipped on this path. Follow-ups logged: a successful calc-only turn is still silent by design (candidate: deterministic spoken read-back of calc results); `rename_circuit` no-designation same-ref silent edge; specific already-recorded wording.

**Extraction-watchdog controller + generation cancellation (F7 hardening, task #14).** `sonnet-stream.js` previously force-cleared `isExtracting` after a flat 30s, letting ANOTHER transcript start a CONCURRENT extraction while an ask chain was still legitimately active (a single 45s ask already outlives 30s; an A4 two-brokered-ask chain reaches ~90s+). It now runs a per-turn CONTROLLER: an `askChainObserved` latch (armed via the scalar `onAskRegistered` CONTROL hook on every successful initial/`pvr-*` register) extends the 30s no-ask deadline through inter-ask empty-registry gaps to the absolute ceiling `EXTRACTION_WATCHDOG_ABSOLUTE_MS = 3*ASK_USER_TIMEOUT_MS + 2*EXTRACTION_WATCHDOG_MS` (DERIVED, 195000ms today). At the deadline/ceiling a LIVE generation is REALLY cancelled — one `AbortController` per generation whose signal threads through `runShadowHarness` → `runToolLoop` (every `client.messages.stream`, checked via `throwIfStage6Cancelled` at each round + around each dispatcher await; the SDK's `APIUserAbortError` is canonicalised to `ExtractionCancelledError` while aborted) and the ask-dispatcher chain — plus `rejectAll('timeout')`, and it NEVER force-clears `isExtracting` (the aborted invocation's generation-guarded `finally` clears it, so no newer generation overlaps). One shared FATAL discriminator (`src/extraction/stage6-control-flow-errors.js`: `ExtractionCancelledError` / `AskRegistrationHookError` / `isStage6FatalControlFlowError` / `throwIfStage6Cancelled`) is tested BEFORE the generic recovery in every layer (`runToolLoop`'s dispatcher-error conversion, `gateOrFire`'s reject path, `createAskDispatcher`'s outer catch, the shadow-harness live/shadow catches) so a cancellation is never masked. On cancellation `runLiveMode` FINALIZES a partial result (bundler + designation maps + generation-owned drain + the field-null fallback + `ios_send_attempt`) so every already-applied write is still read back once and the queued apology still speaks — it SKIPS only the `toolLoopOut`-dependent A3/§D2/cost/core-summary blocks + dialogue hooks. Telemetry: `extraction_watchdog_extended_for_ask` + `extraction_watchdog_absolute_ceiling_fired` (both carrying `sessionId + turnId + generationId`).

**Agentic answers — `answer_user` + `inspect_session_state` (A1 agentic-voice, 2026-07-23; master flag `VOICE_AGENTIC_ANSWERS`).** Before A1 the live model was structurally MUTE for answers: 16 extraction/mutation tools, no query/answer egress — assistant text never reaches TTS, so a question turn became a zero-tool `end_turn` and drew the misleading marker-① "didn't catch that" apology. Two appended read-only tools close this: **`answer_user`** (`answer_text` ≤ 300 chars / ≤ 2 sentences, deterministic normaliser + the `checkForPromptLeak` output filter) STAGES the turn's single spoken answer into `perTurnWrites.answer` (stage-don't-send — dispatchers have no WS access); the bundler projects it as `result.spoken_response` and the EXISTING `voice_command_response` machinery emits it (sync path + P4d reconnect replay: `utterance_id` stamp, socket-down buffering, FIFO replay — zero new emit machinery, zero wire-SHAPE change). **`inspect_session_state`** (`scope: summary|board|circuit|field`) is the read-back channel into authoritative server state the `recent_3`/board-scoped cached snapshot doesn't show; it projects through the multi-board helpers (never direct `circuits[]` keying), sanitises + USER_TEXT-wraps every user-derived string via the shared `stage6-snapshot-user-text.js` leaf module (extracted from the session — identical hygiene to snapshot rendering), and enforces the completeness policy + 4096-byte cap pinned by the approved appendix [inspect-session-state-policy.md](inspect-session-state-policy.md). **Marker-net integration:** a staged answer IS speech-intent (marker-② mutual exclusion); the two tool names join the A3 orphan-net `ask_user` name-guard and `producedNothing` gains an `isAudibleText(result.spoken_response)` conjunct; both F7 branches require no surviving answer. **Failed-answer self-healing:** the feature owns its OWN audibility in BOTH confirmation-toggle states (the apology nets are `confirmationsEnabled`-gated) — post-loop finalization (runs on cancelled turns too) stages the FIXED fallback ("Sorry, I couldn't answer that — please ask it another way.") when the feature was attempted, nothing staged, and no write/ask owns the turn; exactly one utterance either way. **The ONE master flag** is read once at session construction and latched (`session.agenticAnswersEnabled`; default true unless exactly `'false'`; pinned explicitly in `ecs/task-def-backend.json`): it selects the conditional prompt render (`renderAgenticSystemPrompt` — the flag-off render is BYTE-IDENTICAL to the pre-A1 prompt, so the fragment ships dark with zero cache invalidation), filters the advertised toolset (`buildSessionTools`, both harness lanes), and drives the gate's borderline-forward — never independent env reads, so rollback is one atomic task-def flip. Telemetry is leak-rule strict: `voice_latency.answer_user_emitted` logs source + chars + truncated + hash, NEVER raw model text (the legacy sync-VCR `substring(0,80)` preview is branched off for answer-sourced responses). Client side: iOS speaks VCR frames unconditionally (zero iOS change); web required the ONE companion commit (`{force:true}` on the VCR speak path) because `speakConfirmation` mutes when the confirmation toggle — the web default — is off. Ledger row `recording/assistant-answers`.

**Same-turn clear→write collapse (P5, 2026-07-23, marker T10 / feedback 80B+81).** A dictated value that is BOTH read back aloud and written server-side must never be silently un-written on the client. When one turn carries a `clear_reading` AND a `record_reading` for the SAME circuit slot, `sonnet-stream.js` emits the extraction envelope (the write) FIRST, then each `field_corrected` frame AFTER it — so a clear→write correction applied the write then the stale clear (minted against pre-write state), wiping the value on BOTH clients (server ended with the value, client empty). **write→clear is already collapsed correctly for circuit slots** by `dispatchClearReading`'s same-turn `readings` delete (only the clear survives). The MIRROR — clear→final-write — is closed by a PURE projection-time collapse in `bundleToolCallsIntoResult`: it drops any `clear_reading` field-correction (and the matching `cleared_readings` envelope entry + synthesised "cleared" confirmation) whose circuit slot has a SURVIVING `readings` write. Given the effective-aware dispatcher delete, a surviving readings entry co-present with a clear can only mean the write came AFTER the clear. Slot identity is `(raw field, circuit, effective_board_id)` resolved ONCE at dispatch and carried on a non-enumerable `EFFECTIVE_CIRCUIT_SLOT` marker (producer-specific board resolution across all four `readings.set` sites: record/auto-resolve, calculators' `targetBoardId`, `set_field_for_all_circuits`' per-tuple board — never the `'*'` broadcast selector, and `start_dialogue_script`'s own resolution), so an omitted vs explicit-current `board_id` spelling denotes the SAME slot; a Symbol-less legacy entry falls back to raw decoded Map-key identity via the shared `rawCircuitSlot` helper (raw fallback only when BOTH compared sides lack the Symbol). Scope is circuit-reading slots ONLY — `boardReadings` is excluded (the dispatcher delete never covers it, so co-presence is not an ordering proof there; a board-slot write→clear ordering is a separate pre-existing behaviour, out of P5 scope). Matching is on RAW dispatcher field keys BEFORE the A2 outbound canonicalisation (`r2_ohm` keeps its exemption). The bundler stays PURE (no `perTurnWrites` mutation — Loaded Barrel's append-only/length-snapshot contract); collapse metadata rides a non-enumerable result Symbol that `stage6-shadow-harness.js` turns into `stage6.same_turn_clear_write_collapsed` telemetry. Spoken output is unchanged (one write read-back; the pre-existing board-unaware #31 suppression is not touched). ZERO wire-SHAPE change — frames are dropped/reordered server-side, both clients see a coherent stream. Recorded fixture `frc_4687948e…` RED-proves `reading.op_ir_ctw` on pre-fix code → `required_green`.

iOS apply parity is enforced by `scripts/check-ios-field-parity.mjs`, which walks `field_schema.json` and asserts every entry has a matching `case` in `applySonnetReadings`. CI exit-1 on drift.

Shared value-rule semantics live in `src/extraction/value-normalise.js` (`acceptsAsWrite`, `isValidSentinel`, `isEvasionMarker`). iOS mirrors the gate; tests pin equivalence so "N/A" is treated identically on both sides.

Full design rationale: [ADR-008](../adr/008-schema-driven-tools-and-server-resolved-asks.md).

### Pre-LLM transcript gate (`src/extraction/pre-llm-gate.js`)

Every iOS transcript runs through `shouldForwardToSonnet(text, opts)` before the Sonnet round + TTS cost commits. The gate is a sequential pass with bypass and forward reasons emitted as `voice_latency.gate_blocked` (block) / `voice_latency.gate_forwarded_complaint` (positive) for ops dashboards.

`GATE_REASONS` enum (full list): `EMPTY`, `HAS_DIGIT`, `HAS_OBSERVATION_PREFIX`, `HAS_STRONG_TRIGGER`, `HAS_WEAK_TRIGGER`, `HAS_TRIGGER` (legacy, retained for back-compat), `HAS_REGEX_HINT`, `HAS_COMPLAINT_OR_NEGATION`, `HAS_EARTHING_SYSTEM`, `BORDERLINE_FORWARD` (A1, 2026-07-23), `LOW_CONTENT`, `FALLBACK_FORWARD`, plus bypasses `BYPASS_PENDING_ASK`, `BYPASS_DIALOGUE_SCRIPT_ACTIVE`, `BYPASS_IN_RESPONSE_TO`, `BYPASS_DRAINED_RETRY`, `BYPASS_DISABLED`.

`HAS_COMPLAINT_OR_NEGATION` (PLAN-backend-final.md §5.1) runs BEFORE `HAS_DIGIT` so complaints that accidentally contain digits ("you set it to 0.45 but I said 0.55") log with intent reason. The regex deliberately requires a continuation pronoun after a bare "no" so "no problem" / "no signal" / "no spare" still block via `LOW_CONTENT`.

**Borderline-forward (A1 agentic-voice, 2026-07-23).** When the session's latched `VOICE_AGENTIC_ANSWERS` flag is on, the terminal `LOW_CONTENT` drop becomes a FORWARD (`BORDERLINE_FORWARD`, `borderline: true`, logged as `voice_latency.gate_borderline_forwarded`): every server-received transcript corresponds to a client chime already fired (client gate PASS → chime → send), so a server-side content block was an un-nettable beep-then-silence — the block `return`s before `runShadowHarness` and the marker nets ever run. The server carries NO question word-lists, permanently — question detection is the MODEL's job (it answers via `answer_user`, no-ops chatter into the marker nets per the confirmation toggle, or writes an oddly-phrased reading). The call site resolves `entry.session?.agenticAnswersEnabled === true` (fail-closed: session-absent turns keep legacy `LOW_CONTENT` routing); the gate option defaults false. `EMPTY` still blocks on the ordinary path — Phase 0.5 proved production clients cannot send an empty transcript after a chime (both client gates block empty pre-chime) — and every bypass keeps its precedence. Economics: the gate's 2026-05-26 blocking rationale was Sonnet-priced turns (~$0.027); the live model is Haiku 4.5 with a cached prefix, and the measured server-side blocked volume was 1 turn/30 days (Phase 0.3, 2026-07-23) — borderline-forward costs <$0.02/month.

### Dialogue engine (`src/extraction/dialogue-engine/`)

Schemas: `rcd`, `ocpd`, `rcbo`, `ring_continuity`, `insulation_resistance`. Each is a script-style walk-through with entry triggers, per-slot prompts + parsers, defer / skip / cancel verbs, and a `toolCallIdPrefix` (`srv-rcd-` / `srv-ocpd-` / `srv-rcbo-` / `srv-irs-` / `srv-rcs-`).

Per-session state outside the transient `session.dialogueScriptState`:

- **`session.dialogueScriptDeferredSlots: Map<string, Set<string>>`** (Phase 6.2) — keyed by `${schemaName}:${circuit_ref ?? 'none'}`. Survives `clearScriptState` so a script re-entry doesn't re-ask a slot the inspector deferred earlier. Volunteered writes to a deferred slot ("the BS code is 60898" / "set BS number") clear the entry via the named-field-extraction loop. Plumbed through `nextMissingSlot(values, slots, skippedSet, deferredSet)`.
- **Entry-exclusion guard — per-schema OPT-IN** (Phase 6.1, generalised by P1 ring-script-hardening 2026-07-22) — a schema that supplies `entryExclusionPattern` (any object with `test(text)`) skips script entry when it matches; the loop continues to other schemas, ultimately falling through to Sonnet. Telemetry: `${schema.name}_entry_guard_skipped`. RCD's pattern preserves the original Phase-6.1 behaviour verbatim (corrective imperatives delete/undo/cancel/fix/why/stop/remove/clear OR denial phrases what are you / i didn't / that's wrong / that's not — now in `schemas/rcd.js`). Ring supplies destructive/corrective verbs ONLY (`delete|undo|remove|clear|cancel|fix` — question-form entries like "Why haven't you added the ring continuity to circuit 17?" deliberately keep entering; field-evidenced recovery path, session B4C45F25). IR/OCPD/RCBO supply none and keep unguarded entry.
- **Ring confirmation-correction machine** (P1 ring-script-hardening, 2026-07-22, session B4C45F25) — during `awaiting_confirmation` the engine runs a canonical decision order: destructive-broadcast/clearIntent preflight (script exit + fixed `[Server note: …]` antecedent + raw reply falls through to Sonnet, which keeps `clear_reading` ownership), generic different-entry GATED off, then a 5a–5h branch: masked different-circuit amend routing (circuit-span masking + non-ring-context rejection + multi-ref negation polarity, seeding via `runEntry` with `overwriteVolunteered`), masked/qualified named amend, an anchored pending-slot value machine (`confirmation_pending_slot` + schema `pendingValuePattern` + slot-name selectors), a per-episode at-most-once negation re-ask (`confirmation_negation_reask_emitted`), a negated-positive guard, a 2-miss audible cap exit, and a reading-like classifier so dictated readings are NEVER consumed by the miss counter. All confirmation decisions parse the RAW client reply (`rawReplyText` threaded from sonnet-stream, annotated fallback). Purge contract: every confirmation-abandonment exit sends `cancel_pending_tts` BEFORE any replacement speech (the 5f positive finish is exempt by design); the 180s hard-timeout sweep purges too.
- **Cancel-drain WS frame** (Phase 6.3) — on any `*_script_cancelled`, the engine emits `{type:"cancel_pending_tts", prefix:"srv-{script}-", sessionId}` so iOS's AlertManager queue (slice 7.1) can purge in-flight script TTS in the same namespace. In CONFIRMATION mode the purge goes FIRST (before the cancel acknowledgement, which shares the `srv-…` prefix); generic cancels keep speak-then-purge.

## CCU Photo Extraction Pipeline

> ⚡ **CURRENT STATE (2026-05-08 onwards)** — `POST /api/analyze-ccu` runs a **whole-image single-shot `gpt-5.5`** call via `src/extraction/ccu-single-shot.js`. **No per-slot cropping is performed in the live pipeline.** The Stage 3 / Stage 4 per-slot Sonnet pipeline described in earlier versions of this doc is LEGACY FALLBACK, gated behind `CCU_USE_SINGLE_SHOT=false`. Production runs single-shot ON. When reasoning about CCU failures, do not consider CV crop accuracy or slot-crop boundary alignment — they are not in the live path.

Sequence (current pipeline):

1. **Board classifier (board-level metadata)** — one Sonnet VLM call (`claude-sonnet-4-6`, ~400 max tokens, ~5 s). Returns `{board_technology, main_switch_position, board_manufacturer, board_model, main_switch_rating, spd_present, confidence}`. Cost: ~$0.01. Source: `classifyBoardTechnology` in `src/routes/extraction.js`. Drives technology dispatch (modern vs rewireable prompt) and seeds the response with board-level fields the single-shot doesn't return directly.
2. **Geometric prep** — `prepareGeometry` finds the rail bbox + CV pitch (Sobel-X + autocorrelation; `src/extraction/ccu-cv-pitch.js`). The rail bbox crops the image down before single-shot sees it; the CV pitch + module count is kept for post-hoc cross-checks against the single-shot's slot count (logged on disagreement). The image is dewarped to a flat strip if `CCU_DEWARP_MAX_WIDTH` is set.
3. **Single-shot enumeration** — one OpenAI VLM call (`gpt-5.5` via `src/extraction/openai-vision-adapter.js`, ~4096 max tokens, ~15-20 s). Prompt: `MODERN_PROMPT` (DIN-rail boards) or `REWIREABLE_PROMPT` (BS 3036) in `src/extraction/ccu-single-shot.js`. The model receives the whole cropped rail image plus the prompt, and returns one entry per visible module slot in strict left-to-right order: `{device_kind, ocpd_rating_a, ocpd_curve, ocpd_bs_en, rcd_type, rcd_rating_ma, label}`. A 2-pole device returns two identical entries. Blanks return `device_kind:"blank"`. Labels are returned as a SEPARATE `labels[]` array with normalised `position_x` — the prompt forbids the model from assigning labels to devices itself; the code-side position matcher (`CCU_VLM_POSITION_MATCHER`, since 2026-05-21) does the label↔device assignment.
4. **Merge** — `slotsToCircuits` in `extraction.js` builds `circuits[]` from the single-shot entries: filters out `main_switch` / `spd` / `blank` so labels read on those positions never surface, and walks the slot order to attribute RCD-upstream relationships. Circuit 1 is nearest the main switch (BS 7671); side comes from (1) the single-shot's `main_switch` entry index, (2) rewireable `mainSwitchOffset`, (3) classifier's `main_switch_position`. SPD presence is derived from single-shot entries (any `device_kind:"spd"`); the classifier's `spd_present` is a pre-merger fallback only.
5. **Post-merge enrichment** — `applyBsEnFallback`, `normaliseCircuitLabels`, `lookupMissingRcdTypes` (web-search for RCD waveform type via `gpt-5-search-api`, fill-nulls-only, fires only when single-shot left it null AND both board manufacturer and model are known; the `uniform_low_conf` override trigger was REMOVED 2026-05-21 after clobbering correct AC reads on Crabtree Starbreakers); main-switch BS-EN/poles/voltage defaults. The SPD-from-main-switch supply fallback was removed 2026-06-17 — `spd_*` is the DNO cutout, a different physical device.
5b. **Quality gate** — `evaluateQualityGate` (`src/extraction/ccu-quality-gate.js`); fail ⇒ HTTP 422 `{status:'retake_required', reason, message, diagnostic}`. Hard signals: `poor_quad_fit` (rectNormCorr < 0.20), `too_many_nulls` (> 50% of OCPD circuits with unreadable rating — the OCPD filter understands both slot-shaped rows and live merged rows since 2026-07-08), and `classifier_low_confidence`. Since 2026-07-08 classifier confidence is a **soft** signal above a 0.65 hard floor: between 0.65 and 0.85 the gate passes anyway when the extraction corroborates itself (≥ 3 OCPD circuits, ≤ 50% null ratings). Rationale: Stage-1 confidence is a property of the board, not the photo (a Contactum board pinned 0.82 across three retakes with a perfect 13-circuit extraction), so a sub-0.85 score alone rejected every retake forever. Below 0.65 the gate still hard-fails regardless — the classifier may have routed the photo down the wrong prompt (modern vs rewireable). Deliberately NOT solved by improving board-model identification: model numbers have too much internal hardware variance to be a trustworthy signal.
6. **Response shape** — `circuits[]` (primary), `slots[]` (per-slot single-shot output reshaped for iOS LiveFillState consumption — crop bboxes are empty `{x:0,y:0,w:0,h:0}` and base64 is `""` because no per-slot crops exist), `geometric` (rail geometry + CV pitch diagnostics), `board_classification` (mirror of classifier output), `extraction_source: "geometric-merged"` (`"classifier-only"` only when single-shot produced no entries), plus the pre-existing top-level fields.

| Pipeline Step | Model | Wall-clock | Cost |
|---|---|---|---|
| Board classifier | `claude-sonnet-4-6` | ~5 s | ~$0.01 |
| Geometric prep (rail bbox + CV pitch) | local CV + 1 Sonnet call | ~3 s | ~$0.01 |
| Single-shot enumeration | `gpt-5.5` | ~15-20 s | ~$0.03-0.04 |
| Post-merge enrichment (RCD lookup, BS-EN, etc.) | `gpt-5-search-api` (conditional) | ~4 s when fired | ~$0.005 |
| **Total per extraction** | | **~25-30 s** | **~$0.05-0.06** |

**Failure mode**: classifier or `prepareGeometry` failure returns 502. Single-shot failure (timeout, JSON parse, validation) first re-runs the request through the legacy per-slot path (`extraction.js` catch, logged as "falling back to per-slot"); `extraction_source: "classifier-only"` with empty `circuits[]` only when that also yields nothing.

**Legacy per-slot pipeline (LEGACY FALLBACK ONLY)**: `src/extraction/ccu-geometric.js`, `src/extraction/ccu-geometric-rewireable.js`, `src/extraction/ccu-label-pass.js` still exist and can be activated by setting `CCU_USE_SINGLE_SHOT=false`. They run a 4-stage Sonnet pipeline (rail bbox → CV pitch → per-slot crop+classify in batches of 4 → wider per-slot label-zone crop). Pre-2026-05-08 the live pipeline; retained for emergency rollback if single-shot regresses. **Do not reason about its behaviour as a current failure mode unless the env override is confirmed set.**

## AWS Configuration

| Resource | Value |
|----------|-------|
| Region | eu-west-2 (London) |
| Account ID | 196390795898 |
| Domain | certomatic3000.co.uk |
| ECS Cluster | eicr-cluster-production |
| Frontend Service | eicr-frontend |
| Backend Service | eicr-backend |
| ECR Frontend | 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-frontend |
| ECR Backend | 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend |
| RDS Database | eicr-db-production.cfo684yymx9d.eu-west-2.rds.amazonaws.com |
| Database Name | eicr_omatic |
| Load Balancer | eicr-alb-production |
| ALB Idle Timeout | 600 seconds |
| Backend Memory | 2048 MB |
| Backend CPU | 512 units |

## Multi-User Support

The system supports multiple users (Derek, Michael) with:
- Separate output directories (`data/OUTPUT_Derek/`, `data/OUTPUT_Michael/`)
- Separate done/failed directories
- Per-user company settings (`config/company_settings_Derek.json`)
- Inspector profile selection in editor

## Production Infrastructure Status

**Production URL:** https://certomatic3000.co.uk

| Component | Status | Details |
|-----------|--------|---------|
| Domain | LIVE | certomatic3000.co.uk (Route 53) |
| SSL Certificate | ACTIVE | AWS ACM (auto-renewing) |
| Load Balancer | RUNNING | AWS ALB (eu-west-2) |
| PWA Frontend | RUNNING | ECS Fargate (Next.js) - `eicr-pwa` service |
| Backend | RUNNING | ECS Fargate (Node.js) - `eicr-backend` service |
| Database | RUNNING | RDS PostgreSQL |
| Storage | CONFIGURED | S3 bucket |
| Secrets | CONFIGURED | AWS Secrets Manager |
| Streamlit | STOPPED | Replaced by PWA (can re-enable if needed) |

### Architecture Diagram (AWS)

```
Mobile Device (PWA) → AWS ALB (SSL) → ECS Containers
                                          ├── Next.js PWA Frontend (eicr-pwa)
                                          └── Node.js Backend (eicr-backend)
                                                 ↓
                                    PostgreSQL (RDS) + S3 Storage
```

## Estimated Costs

- **AWS Infrastructure:** $77-122/month
- **API Usage (OpenAI/Gemini):** $20-45/month
- **Total:** ~$100-170/month
