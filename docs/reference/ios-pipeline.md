> Last updated: 2026-08-13
> Related: [Architecture](architecture.md) | [Field Reference](field-reference.md) | [Deployment](deployment.md) | [File Structure](file-structure.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# iOS Recording Pipeline — v3 (Feb 2026)

## Architecture

The iOS app connects directly to Deepgram for transcription and uses a server-side WebSocket for Sonnet extraction. Silero VAD is used only for auto-sleep wake detection (not during active recording).

```
iOS (16kHz PCM audio)
       │
       ├──► DeepgramService.swift (direct wss://api.deepgram.com/v2/listen)
       │         │  Flux `flux-general-en`, eot_threshold=0.7,
       │         │  eot_timeout_ms=5000, mip_opt_out (TurnInfo/EndOfTurn events)
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
              └──► Backend: Stage 6 tool loop (multi-turn GPT-5.6 Luna trial)
                     │  Full session context, prompt caching (1hr TTL),
                     │  conversation compaction, 5min session timeout
                     │
                     └──► Extraction results + questions + cost updates back to iOS
```

**Field priority (3-tier):** Pre-existing (CCU photo, manual edit) > Sonnet > Regex

**API keys:** iOS fetches the Deepgram streaming key from `POST /api/proxy/deepgram-streaming-key` (authenticated). Anthropic and ElevenLabs calls are proxied through the backend — API keys never leave the server (loaded from `eicr/api-keys` in AWS Secrets Manager).

**Key files:**

| File                                                   | Purpose                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `CertMateUnified/.../DeepgramRecordingViewModel.swift` | iOS recording VM — orchestrates full pipeline              |
| `CertMateUnified/.../DeepgramService.swift`            | Direct WebSocket to Deepgram Flux (`/v2/listen`)           |
| `CertMateUnified/.../ServerWebSocketService.swift`     | WebSocket client to backend Sonnet extraction              |
| `CertMateUnified/.../NumberNormaliser.swift`           | Spoken number → digit conversion                           |
| `CertMateUnified/.../KeywordBoostGenerator.swift`      | Board photo data + remote config → Deepgram keyword boosts |
| `CertMateUnified/.../DebugLogger.swift`                | JSONL per-session debug logging                            |
| `CertMateUnified/.../AlertManager.swift`               | Validation alerts (voice + visual) during recording        |
| `src/sonnet-stream.js`                                 | Backend WebSocket session manager                          |
| `src/eicr-extraction-session.js`                       | Multi-turn Sonnet conversation + compaction                |
| `src/api.js` (`GET /api/keys`)                         | Backend endpoint to serve API keys to iOS                  |
| `src/secrets.js`                                       | Loads Deepgram + Anthropic keys from AWS Secrets Manager   |
| `CertMateUnified/.../SleepManager.swift`               | Auto-sleep state machine (Active/Dozing/Sleeping)          |
| `CertMateUnified/.../AudioRingBuffer.swift`            | 3s ring buffer for zero word loss on wake                  |
| `CertMateUnified/.../TranscriptFieldMatcher.swift`     | Instant regex extraction (30+ patterns)                    |

**Server-side live extraction:** Multi-turn tool loop, currently `gpt-5.6-luna` through the OpenAI Responses API (Fast service-tier trial). Prompt caching and conversation compaction preserve the rolling structured-certificate context.

### Voice-address authority and postcode hints

Address-family values are deliberately outside client regex extraction. Web
and iOS do not locally write `address`, `postcode`, `client_address`,
`client_postcode`, locality fields, or a same-address flag, and iOS no longer
owns an address-mirror prompt/latch. The backend/model path is the only voice
writer and the backend address-mirror controller is the only copy owner.

Before the ask/regex split, each client may derive an optional `postcode_hint`
from the current final utterance and carry it on the existing transcript
envelope. It is lookup enrichment only: the backend validates it once, never
reuses it on a later message, and waits for an authoritative site/client
postcode write before applying `postcodes.io` town/county to that family.
Question purpose/type metadata is round-tripped on both client answer paths so
the durable server intent can recover across reconnects. Mirror-derived target
writes remain designed-silent; the original dictated source write or a short
server acknowledgement supplies the answer's audible terminal.

Annotated transcript replies preserve the exact server `tool_call_id`; the
backend forwards it to durable recovery and rejects a stale explicit
generation before model extraction. A deciding address/postcode reply also
receives a server prompt-clear frame before its terminal read-back, so neither
client remains in answer mode after the copy has completed.

On-screen answers preserve the same authority split: live Stage-6 mirror asks
emit the paired transcript plus `ask_user_answered`, whereas rollback and
direct questions emit one transcript with their exact `in_response_to`
identity. Web/iOS remove only that tapped generation from their TTS question
queues. Durable terminal voice frames carry a stable server token, which each
client keeps in a bounded heard-set so a reconnect replay cannot speak the
same decision twice.

That token is operation identity, not a text-dedupe alias. An unheard address
operation plays even when an older ordinary confirmation has identical prose;
a pre-play discard releases only the new operation reservation and any
ordinary key reserved with it. The backend emits one token-owning audio item
per operation, aggregating multiple recovered source confirmations and, when
present, the final voice-command acknowledgement. Playback-start ACK therefore
means the whole owed terminal has begun, rather than only its last field.

Explicit copy commands use an append-only durable operation ledger: even a
complete no-question command is claimed before mutation, and incomplete or
conflicting commands retain one stable clarification id across restart. The
backend finalizes after the deciding source write even when legacy extraction
uses its timeout-batch callback, then replays any committed-but-undelivered
write/read-back ledger after the next session acknowledgement. Stable
operation tokens make retries idempotent and keep old direct-question replies
from resolving a newer command.

Web and iOS preserve `purpose` on `ask_user_answered` and preserve the direct
question's `tool_call_id` in transcript `in_response_to`. Their address-question
tap paths send the answer but do not speak the normal local “Updated” or
“keeping it” terminal; that speech is server-owned and therefore heard once.
Question logs are hashed/redacted, and malformed postcode hints containing
controls or non-ASCII separators are rejected before lookup.

### Regex fast-TTS path

For five low-ambiguity circuit readings (`measured_zs_ohm`, `r1_r2_ohm`, both IR values, and `number_of_points`), iOS can request the canonical ElevenLabs read-back before the model loop completes. This five-field whitelist is unchanged by address-regex retirement. The matcher accepts either explicit `Circuit N …` phrasing or a natural exact designation such as “Number of points for the upstairs socket is 6.” Natural routing canonicalises singular/plural designations, strips a leading article, requires exactly one matching circuit on the selected board, and fails closed on duplicates, missing multi-board scope, or non-numeric refs. Sonnet/Luna still processes the same transcript and remains authoritative for the write.

The fast clip and bundler safety-net share `field::circuit::board` slot identity. iOS marks the slot pending before the HTTP request; if fast audio starts, the later bundler line is suppressed, and if the request or playback fails, the parked bundler line is released. This preserves the audio-first invariant: one heard read-back, never zero or two. Two client seams must carry that identity: the deferred-confirmation flush and the ordinary inline-confirmation branch. Build 425 exposed that only the deferred branch did—an inline “Zs for the cooker is 0.22” fast clip played, then its bundler twin played because inline delivery passed `slotKey:nil`. Both branches now derive the same three-part key. This follows the earlier correction from a two-part caller key to the board-aware identity. `regex_attempt.fields_matched` also includes circuit-field hits.

In latency reports, **heard confirmation** is the client playback ACK/start timestamp: the point at which TTS audio actually begins playing back. It does not mean the model merely produced confirmation text or that ElevenLabs finished synthesis.

### Loaded Barrel audible-start correlation

The TTS proxy returns `X-Voice-Latency-Correlation-Id` plus `X-Voice-Latency-Source`. Hit sources are `loaded_barrel_hit`, `loaded_barrel_hit_pending`, and `loaded_barrel_hit_late`; canonical alternatives are `confirmation` (streaming) and `legacy_confirmation` (buffered fallback). `APIClient` returns those headers beside the MP3 instead of discarding them. `AlertManager` carries the metadata with the exact bytes through FIFO waiting and the deferred-head hold, then adds it to `/api/voice-latency/playback-ack` only after `AVAudioPlayer.play()` returns true. Network receipt, decode failure, and `play()==false` do not count as heard.

The established ACK `source` remains `bundler` (delivery path); additive `audio_source` records where the bytes originated, preserving existing dashboards. Backend rows expose `ios_playback_ack_correlation_id` and `ios_playback_ack_audio_source`; the unified `voice_latency.turn_perceived_latency_ms` row exposes the same values as `ios_playback_ack_correlation_id` and `ack_audio_source`. A same-correlation `voice_latency.outcome { outcome:"playback_started", acked_by_ios:true }` provides the direct PII-safe synthesis→audible join. Missing headers remain valid for rolling deploys and older servers.

Address-mirror terminal speech has a separate durability ACK. A capable web or iOS client advertises `address_mirror_delivery_ack_v1`, reserves the server's `address_mirror_delivery_token` while TTS is queued, persists it in a bounded heard ledger immediately when playback starts, and then sends `address_mirror_delivery_ack`. Discard, pre-enqueue failure, or synthesis failure releases the reservation, allowing the server's leased outbox to retry. A reconnect/restart replay whose token is already heard is ACKed without speaking again. The operation token deliberately overrides an ordinary field/text confirmation collision: an unheard address operation still plays, and discarding it must not erase an older heard ordinary key. This is operation delivery state, not latency telemetry: the backend does not mark a capable client's address-mirror outbox row delivered merely because the WebSocket frame flushed.

**Remote config:** `RemoteConfigService.swift` + `Resources/default_config.json` — keyword boosts and validation rules can be updated without app rebuild.

---

## Wire contract — response epoch (PLAN-C chime-silence watchdog)

The client chime-silence watchdog (Phases 5/6) arms a timer when a processing chime fires for an utterance and disarms it when a matching spoken output plays back. To correlate the two, server-emitted **speech** frames carry an **optional `utterance_id`** — the _response epoch_: the id of the utterance the spoken output is a reply to.

- **P4c (answer side):** post-answer `confirmations[]` carry the epoch of the utterance that _answered_ an open ask (advance-only-on-non-empty).
- **P4d (question side):** `ask_user_started` (dialogue-engine + dispatcher initial/pvr), legacy `question`, and `voice_command_response` frames carry the **creation-time** epoch of the arming utterance. Also carried on the reconnect-replay `voice_command_response` (a buffered `spoken_response` now replays as a separate frame, stripped from the extraction replay).

Rules: the epoch is snapshotted at frame **creation** (never re-read from mutable session state at emit time); `utterance_id` is stamped **only for a non-empty string** epoch, so a no-epoch frame is byte-identical to the pre-P4c/P4d wire. `turn_id` remains a reserved/optional telemetry field (not populated by P4d). All fields are additive-optional — clients that ignore them behave exactly as before; the client watchdog is gated behind the P4b `session_ack speech_epochs: 1` capability. THE doc of record for the full frame catalogue is the `certmate-voice-wire-protocol` skill.

---

## Wire contract — `replaces_cleared` (A2, 2026-07-28)

A same-turn `clear_reading` + `record_reading` on ONE circuit slot is collapsed **server-side** (P5, 2026-07-23): the clear is dropped from the wire and only the surviving write is sent. That collapse is correct for ordering, but it destroys the one fact a fill-only client needs — _the server already emptied this cell_ — so the write arrives BARE against a cell the client still believes the user owns.

`replaces_cleared` restores exactly that fact on the surviving `readings[]` entry:

|              |                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Shape**    | `readings[i].replaces_cleared?: true` — boolean, **omit-when-false**                                                                      |
| **Producer** | `stage6-event-bundler.js`, at the same point the collapse drops the clear                                                                 |
| **Meaning**  | this write superseded a same-turn clear of the SAME circuit slot; treat it as a REPLACEMENT, not a new value competing on source priority |

Rules:

- **Omit-when-false is the compatibility mechanism** — there is no capability gate, and none is needed: a turn with no collapse is byte-identical to the pre-A2 wire, so an older client is never handed a key it must understand. Emitting `false` would have forfeited that and required a gate.
- **Never inferred by a consumer.** The marker is stamped by the producer that performed the collapse; nothing downstream reconstructs it from an absent clear.
- **Fail-closed-unflagged:** the bundler stamps the flag only when EXACTLY ONE surviving write resolves to the collapsed slot. An unflagged write is always safe (the consumer's normal gate applies); a wrongly-flagged one would license an overwrite. Since A2-multiboard (below) the per-turn writes are projected last-write-wins per EFFECTIVE slot, so the multi-candidate case is unreachable by construction — the shape is retained so a future duplicate-producing regression degrades to silent-unflagged rather than stamping arbitrarily. (A2-core's `stage6.replaces_cleared_ambiguous_projection` telemetry event and its `REPLACES_CLEARED_AMBIGUOUS_PROJECTION` Symbol were REMOVED by A2-multiboard item 2 — declining to stamp was right while the collision was undecidable, but it left web holding the STALE value on a real replacement.)
- **Circuit slots only** at A2-core. A2-multiboard item 7 adds the BOARD-scope twin — see below.
- **Derived writes are not candidates** (`derived: true` mirrors/auto-ticks). Calculator writes (`source_turn_id` starting `::calc::`) **are** candidates — since F/U-1 (2026-07-19) a calc result is an explicitly-requested, spoken value.

**Consumers.** Web is the reason this exists: `applyCircuitReadings` is fill-only and source-agnostic, so it silently skipped the collapsed replacement — the assistant SPOKE it and the server + iOS stored it while web did not (the inverse Audio-First violation). _Epistemic split:_ the SKIP is source-confirmed (read straight off `applyCircuitReadings`' `if (hasValue(row[column]) && !isLimWrite) continue`); that the field-visible symptom was a stale WRONG value rather than a blank cell is INFERENCE from the wire shape — no captured web session covers such a turn. Web now bypasses its gate for a flagged reading, but only on a slot it can resolve to exactly ONE row; an orphan ref or an unresolvable duplicate DECLINEs the bypass. ~~At A2-core the decline fell through to the unchanged gate, so declining was never a new skip and an empty cell still filled.~~ **SUPERSEDED by A2-multiboard item 6:** an unresolvable FLAGGED reading is now SKIPPED outright — see "fail closed differs by class" below for the resolution rules and the reasoning. (A2-core additionally declined for ANY multi-board job with `apply_replaces_cleared_multiboard_deferred`; item 6 REPLACED that envelope-wide gate with per-reading row resolution — see below.)

**iOS needs no change and gets none.** `ExtractedReading` declares explicit `CodingKeys`, so the key decodes inertly; `applySonnetValue` already applies any DIFFERING value regardless of source state (only an exact duplicate of a pre-existing value is blocked), so the replacement already lands. Both properties are pinned by `DeepgramRecordingViewModelReplacesClearedTests` (CertMateUnified) rather than assumed — a stricter decoder or a source-priority gate ported from web would reintroduce the defect on iOS, and that test is what catches it.

The frame both clients are tested against is pinned at `tests/fixtures/test-contracts/replaces-cleared-circuit.json` (see the README there — regenerate from the production egress chain, never hand-edit). Web IMPORTS that file; the iOS test embeds a hand-mirrored Swift literal of the same payload, which can drift undetected — a change to the fixture must be mirrored into the iOS test by hand in the same wave. **A2-multiboard regenerated this fixture** — it now carries `board_id: "main"` on the flagged reading and its confirmation (the enrichment rules below), so the iOS Swift literal must be re-mirrored.

---

## Wire contract — effective-board addressing (A2-multiboard, 2026-07-28)

A2-core shipped `replaces_cleared` for SINGLE-board jobs and explicitly deferred multi-board delivery. A2-multiboard closes that deferral by making the board a first-class part of every write's identity, server-side, and then ADDRESSING the surviving writes to the board the server actually mutated. **Every new wire key is additive-optional and omitted exactly where it was omitted before** — there is no new capability gate on the circuit channel.

### What the server decides before it emits

The per-turn write Maps are keyed by the RAW tool arguments, and the raw key is board-AMBIGUOUS by construction: `record_reading` omits `board_id` in the common case and `record_board_reading` has no `board_id` in its schema at all. A cross-board turn therefore collided under one key and the earlier board's write was silently destroyed (last-write-wins by RAW key). An append-only, monotonically-sequenced **write journal** (`src/extraction/stage6-per-turn-writes.js`) now runs beside those Maps — every producer stages through one helper pair — and the bundler projects it **last-write-wins per EFFECTIVE slot** (field + circuit + effective board). The Maps keep their raw-key semantics (the bundler's Map-type guard, the harness's size check and the speculator's snapshot/diff all depend on them); the journal is what makes the collision decidable. The sequence counter lives on a NON-ENUMERABLE `WRITE_SEQUENCE` Symbol, so it is invisible to `JSON.stringify` and the wire bytes are unchanged.

### Enrichment rules — when `board_id` appears on a reading

| Class                                  | Enriched with the effective board?                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| **FLAGGED** (`replaces_cleared: true`) | **ALWAYS** — circuit channel and board channel alike                                       |
| **ORDINARY**                           | **ONLY on a cross-board turn** — when the turn's winners span ≥2 distinct effective boards |
| explicit model `board_id`              | never overwritten                                                                          |

The asymmetry is deliberate. A flagged reading whose target board is unstated is UNRESOLVABLE by a client that fails closed on an ambiguous target — it would drop a spoken replacement, the exact defect the marker exists to prevent — so the flag and the address always travel together. Ordinary readings stay bare on every single-board turn (including every turn of a multi-board job where the inspector works one board at a time), which keeps the wire byte-identical to pre-A2 and keeps the loaded-barrel speculator's null-board cache entries hitting; blanket enrichment would spend latency on every turn to fix a defect that only exists when two boards are written in ONE turn (Audio-First #3). Enrichment runs BEFORE `synthesiseConfirmations`, so a flagged confirmation inherits the same `board_id`.

The board channel differs in one respect: an ORDINARY board-scoped write is filled from its `EFFECTIVE_BOARD_SLOT` stamp only for sessions that advertised `board_clear_v1` (plan A1a's capability line), whereas a FLAGGED board replacement is enriched unconditionally for the reason above.

### Board-aware fail-closed targeting (consumers)

A client that receives `board_id` MUST resolve it to exactly one row and MUST fail closed when it cannot. **What "fail closed" means differs by class, and deliberately so.** For an ORDINARY reading it is never a skip: the reading falls through to the client's ordinary fill-only gate, so an empty cell still fills — the value is only a fill, and landing it ref-only is safer than losing it. For a FLAGGED (`replaces_cleared`) reading it IS a skip: the flag's whole purpose is to OVERWRITE an existing cell, so an unresolvable target must not be guessed at — no row is created and no cell is touched, and telemetry names which of the three outcomes fired (`apply_replaces_cleared_ambiguous_board` / `_orphan_board_ref` / `_duplicate_board_ref`). Writing a replacement onto the wrong board's row is a silent wrong value in a legally-significant certificate; a missed one is a visible empty cell the inspector re-dictates. Web resolves in three ordered branches (`ensureBoardScopedRow`): exact `(board_id, ref)` match → first-come claim of an unscoped legacy row → a new scoped row. A `board_id` for which the client has no INDEPENDENT evidence (no such board in its own job state) falls back to ref-only and logs `apply_circuit_reading_unevidenced_board` — the server's word alone never conjures a board row. A newly-created scoped row seeds the ref index only when nothing already owns that ref, so a scoped sibling cannot re-point the ref-only `field_clears` / `circuit_updates` loops.

A2-core's ENVELOPE-WIDE decline (`apply_replaces_cleared_multiboard_deferred` — any multi-board job dropped the bypass for the whole frame) is REPLACED by per-reading row resolution: the resolver DECLINES a specific reading it cannot pin to one row rather than disarming the mechanism for the turn.

### Board-scope `replaces_cleared` (item 7)

The marker now also lands on a collapsed BOARD clear→write (`readings[i]` at `circuit: 0` / board scope). A board value lives in TWO places written by two independent loops (`board_info` and `boards[]`), so the client decides the replacement ONCE, before either leg runs, and applies the SAME decision to both — a local per-leg bypass would let the halves diverge, which is worse than either failing cleanly because it looks like it worked. Three routing rules:

- **BOARDLESS flagged reading ⇒ SECTION-ONLY, and that is a SUCCESS.** `ze` / `pfc` are `'global'` in `BOARD_CLEAR_SCOPE_MAP`, so a flagged global reading carries a NULL board _by construction_.
- **SUB-BOARD ⇒ `boards[sub]` only, `board_info` WITHHELD.** `board_info` is the MAIN-board summary that the PDF and the backend's own `_applyTopLevelBoardInfo` ingest read as "the board".
- **ORPHAN (a board id the client cannot evidence) ⇒ NEITHER leg**, logged.

### Circuit-topology ops carry their board

`circuit_updates[]` entries gain `board_id?: string` and `from_ref?: string`, and `op` gains `'delete'`. The board is stamped at DISPATCH (`EFFECTIVE_OP_BOARD`) — the only place the resolution is known — so `select_board sub-b` followed by "delete circuit 2" deletes the SUB-board's circuit 2 on the client, not main's. Ops are emitted losslessly and in wire order; a metadata-free `create_circuit` no longer vanishes (the previous meta fold skipped nulls and the carrier was then deleted).

### Companion contracts touched by this wave

- **Circuit designations** are keyed by `(effective_board_id, circuit_ref)` at both build and resolve sites. On the bare ref, the last writer's name won for BOTH boards, and a sub-board circuit was read back with the MAIN board's name.
- **Confirmation dedupe keys** fold `board_id` into the hashed text — see the next section.
- **"All circuits" completeness phrasing** is measured against the confirmation group's OWN board, not the session's.
- **An empty-string `board_id`** is normalised to ABSENT at the dispatcher boundary (legacy CSV writes `''`). `select_board`, `clear_board_reading` and `record_board_reading` are the enumerated EXEMPTIONS — for them an unaddressable board must not silently become "whatever board is current", so they still reject.

---

## Confirmation read-back dedupe key (client-side; value-aware since id-84)

The spoken read-back loop suppresses a _duplicate_ confirmation via a per-client dedupe key computed from the wire `Confirmation`. The key is computed CLIENT-side (iOS `buildConfirmationDedupeKey`, web `confirmation-dedupe-key.ts`); the backend `src/extraction/ios-dedupe-key.js` is a **telemetry-only mirror** that reproduces the same key so the `ios_send_attempt` `expected_dedupe_key` row reconciles byte-for-byte against client reality — it is NOT a wire field.

Three key shapes:

| Shape         | Key                                                         | When                                                 |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| per-circuit   | `{field}_{circuit}_{djb2(text + boardId)}`                  | a single-circuit reading confirmation                |
| multi-circuit | `{field}_{sortedCircuits.join('-')}_{djb2(text + boardId)}` | a grouped broadcast (`circuit:null`, `circuits:[…]`) |
| degenerate    | `{field}_{djb2(text + boardId)}`                            | board-level / supply / installation (no circuit)     |

`boardId` is `conf.board_id ?? ''` in every shape.

For fields in `WIRE_CLIENT_DEDUPE_TOKEN_FIELDS`, a backend-stamped `dedupe_token` takes precedence in EVERY branch (`{field}_{dedupe_token}`), so identical-text REPEATS of DISTINCT operations do not collide. The backend debounce uses a deliberately separate `DEDUPE_TOKEN_FIELDS` manifest.

PLAN-3 adds one deliberately separate token lane outside that field manifest: a severity re-code's supplemental confirmation remains `field:null` but carries `dedupe_token:"obsrecode_<turn>_<observation>_<old>_<new>"`. If frame one (`observation_update`) succeeds and frame two fails, reconnect replays only the owed confirmation. iOS lets only this prefix bypass the post-reconnect stale-confirmation gate and stores its operation key permanently; the same suffix therefore speaks once, while ordinary replay-burst confirmations remain suppressed. Web uses the same special key and permanent-store classification. The token does not enrol a seventh `WIRE_CLIENT_DEDUPE_TOKEN_FIELDS` member and does not change backend debounce.

| Token family | Enrolled fields | Replay-stable identity |
|--------------|-----------------|------------------------|
| `circop_` / `obs_` / `obsdel_` / `clear_` / `desig_` | `circuit_op`, `observation`, `observation_deletion`, `field_cleared`, `circuit_designation` | operation/ref plus turn or server-owned id |
| `secfield_` | `postcode` only | field + effective scope + turn + per-scope ordinal |

PLAN-2C keeps `postcode` OUT of the backend debounce manifest (Phase-0 candidate 1): the server's 1.5 s debounce remains token-blind, while web and iOS use the `secfield_` operation identity to stop a legitimate same-text amendment from colliding with the session-permanent field read-back key. The dispatcher stamps postcode as an installation-global operation before the per-turn write journal records it; the bundler carries that exact field/scope/ordinal identity to the confirmation instead of inferring it from optional `board_id` or the last-write-wins output. Replaying one operation retains the same token and is still suppressed.

> **id-84 (2026-07-24) — value-aware single-circuit key.** The per-circuit shape was previously value-LESS (`{field}_{circuit}`) and kept that way deliberately so the iOS local correction-TTS dedupe could cross-match wire keys. But because field read-back keys are session-**permanent**, a spoken correction (a second reading on the same field+circuit with a DIFFERENT value) collided with the original key forever and was **silently swallowed** — beep-then-silence on a successful correction (session 2ACE7677: "No. It was 0.63." spoke nothing). Fix: fold djb2 of the confirmation TEXT (which encodes the value) into the single-circuit key, matching the multi-circuit branch. A correction (different text) now yields a distinct key and speaks; a genuine duplicate (same field+circuit+SAME text — e.g. the model re-recording circuit 4) still dedupes. The correction-TTS cross-match is **intentionally dropped** (worst case an extra local read-back, never silence). Derek's decisions: TEXT-HASH (not a direct value in the key, which would need wire/decoder changes), and NO new field-key TTL. iOS adds the twin fix to its own client-initiated `correctionDedupeKey`, plus the id-87 fast-path double-read-back suppression (fast clip + bundler safety-net now share a VALUE- and effective-board-aware suppression identity). Parity: `web/docs/parity-ledger.md` `recording/readback-dedup-value-aware`.

> **A2-multiboard item 10 (2026-07-28) — board-aware circuit keys.** Two boards routinely share circuit refs, so the same spoken line about circuit 3 on main and on garage produced the SAME per-circuit key and the second read-back was silently swallowed — Audio-First #1 in the zero-times direction. `board_id` is folded into the HASHED STRING (`text + (board_id ?? '')`) rather than added as a key SEGMENT, so an ABSENT board id hashes byte-identically to the pre-item-10 key and every single-board confirmation keeps the key it has today. The `dedupe_token` precedence branch is deliberately UNCHANGED: the token IS the operation identity and is already replay-stable across boards, so folding a board into it would break the §A1a contract. All three mirrors move together (backend telemetry mirror, web, iOS Swift); the degenerate branch already folded the board and is untouched.

---

## Wire contract — fast-path correlation echo + honest orphan net (Plan B, feedback ids 118/119, 2026-08-13)

The Regex fast-TTS path (above) suppresses the bundler's ordinary confirmation by SLOT identity (`field::circuit::board`) alone, so a value mismatch — the model correcting what the fast clip already spoke — could never suppress. Plan B replaces slot-only matching with a server-side CORRELATION identity that carries the fast clip's rendered value/text, so a mismatch always falls through to the canonical correction.

**Correlation wire hop.** iOS mints a `correlationId` at fast-dispatch time (used for the fast-TTS POST and `/playback-ack`); it is now ALSO threaded onto the transcript envelope as `regex_fast_correlation_id` (string or array — a turn can attempt more than one fast dispatch). The backend reads it into a per-turn `Set` on the active-session entry (`fastPathCorrelationIdByTurn`), seeded at the TOP of `runLiveMode` before the tool loop runs.

**Fast-attempt ledger (`src/extraction/fast-path-accepted-identity.js`).** ONE combined, TTL-scoped (300s) record per `correlationId`, folding two concerns: the B1.2 "accepted identity" (field/circuit/boardId/canonicalValue/comparisonText the fast route committed) and the B3.1 "fast-attempt ledger" state (`pending` → `playback_started` | `failed`). Lifecycle:

1. `markFastAttemptPending` — right after the fast-TTS route's `validateBody` succeeds, before any later gate can still reject. Captures the raw (un-clamped) candidate so a fallback has something to work with even if the route never reaches synthesis.
2. `commitAcceptedIdentity` — ONCE, at the route's FIRST successful `onAudio` write (not at route entry — the HTTP fast request and the WS transcript are concurrent, so entry-time resolution can miss a route accepted mid-turn). Upgrades the record with the CLAMPED value and a RENDERER-ALIGNED comparison text (`designation=null`, matching the fast route's own render — the bundler renders WITH the real circuit designation, so exact-text equality would fail for every named circuit). The boardId committed here is resolved `explicit → session.stateSnapshot.currentBoardId → canonical main` — the same precedence used everywhere else in this codebase for a scope-less action's effective board.
3. `markFastAttemptFailed` — every reject path (a gate rejection or a pre-first-byte synthesis failure) funnels through one `rejectWithDecrement` helper, which marks `failed`.
4. `markFastAttemptPlaybackStarted` — from `voice-latency-playback-ack.js`, when iOS ACKs `source: 'fast_tts'` with a `correlation_id`.

**Echo-stamping (B1.3, `stage6-event-bundler.js`).** Immediately before bundling, the harness resolves this turn's attempted correlation ids into a `Map<slotKey, identity>` (`resolveFastAttemptSlotIdentities`) and hands it to `bundleToolCallsIntoResult` as `fastAttemptBySlotKey`. The bundler stamps `fast_correlation_id` on a Sonnet-confirmed reading ONLY when its slot key joins the map AND its own renderer-aligned comparison text (the same `designation=null` render) plus the canonical value all match — a value or text mismatch (the model correcting the fast clip) NEVER stamps, so the canonical correction is always heard. A fast-attempted single-circuit reading is partitioned out of any multi-circuit grouped confirmation so it gets its own stamped line while the uncovered circuits still group.

**Honest orphan net (B3, `stage6-shadow-harness.js`'s zero-tool-call orphan seam).** When a turn produces zero tool calls, `resolveZeroToolCallDuplicateOutcome` resolves an outcome for EVERY attempted correlation id (never silently dropping one just because a sibling correlation was represented — the fix for a real field defect: a `failed`/never-recorded correlation used to contribute nothing, so a sibling `playback_started` correlation made the whole turn look "handled" and the omitted reading went silent). Precedence per attempted correlation:

- `playback_started` → no second line (the user already heard the fast clip).
- `pending` (committed or not-yet-committed — the plan's explicit "pending, not absence" default covers both the ordinary in-flight race AND the WS-transcript-before-HTTP-POST race, where this module has no record at all yet) → a correlation-STAMPED "Already got …" fallback, so iOS's client-side correlation state machine can still park/reconcile it against the eventual fast-clip outcome.
- `failed`, or no correlation attempted at all, PLUS an exact re-parse match against the current snapshot → an UNSTAMPED "Already got …" (the correlation, if any, is definitively dead — this is the ordinary duplicate re-speak, not a ledger-tracked fallback).
- otherwise → the existing orphan prompt (unchanged wording/selection).

Outcomes that resolve to the identical (field, circuit, board, value) identity coalesce into ONE confirmation regardless of which correlation ids produced them (a client retry with a freshly-minted correlation id must not double-speak). Every fallback/duplicate confirmation carries a `duplicate_<turnId>` (unstamped) or `duplicate_<turnId>_<correlationId>` (stamped) `dedupe_token`, which the client dedupe-key builders (iOS/web/`ios-dedupe-key.js`) check via a dedicated PREFIX branch ahead of the ordinary `WIRE_CLIENT_DEDUPE_TOKEN_FIELDS` field allowlist — this deliberately does NOT enrol the affected field in that allowlist (measured-value fields ignore `dedupe_token` by design, the id-84 correction-swallow fix above).

**Web companion.** Web has no fast-TTS dispatch path (WS3b item 4 still open) — the correlation echo and fast-attempt ledger cause no web-visible change, and web tolerates/ignores `fast_correlation_id` on a confirmation it decodes. The honest-orphan-net exact-duplicate re-speak IS shared backend behaviour: a web zero-tool-call duplicate turn receives the same one-line "Already got …" (`duplicate_<turnId>`-tokened) instead of the pre-Plan-B orphan prompt.

**Key files:** `src/extraction/fast-path-accepted-identity.js`, `src/routes/voice-latency-fast-tts.js`, `src/extraction/stage6-shadow-harness.js` (`resolveZeroToolCallDuplicateOutcome`, `resolveOutcomeIdentityForCoalescing`, `buildFastLedgerFallbackConfirmation`), `src/extraction/stage6-event-bundler.js` (the `fastAttemptBySlotKey` match), `src/extraction/ios-dedupe-key.js` + iOS `buildConfirmationDedupeKey` + web `confirmation-dedupe-key.ts` (the `duplicate_` prefix branch). Tests: `voice-latency-fast-tts-accepted-identity.test.js`, `fast-path-accepted-identity.test.js`, `stage6-event-bundler-fast-attempt-echo.test.js`, `stage6-orphan-net-fast-path-duplicate.test.js`, `stage6-fast-correlation-wire-survival.test.js`.

---

## Dialogue-script leading-circuit scope + cross-utterance delete (Plan F)

> Added 2026-07-28 (feedback ids 98 + 93, session 2D8E432D). Backend-only, **zero wire change** — both clients benefit identically. Verification lane: dialogue-engine unit + replay parity + sonnet-stream ingress tests (NOT the field-replay corpus — dialogue entry runs BEFORE `runShadowHarness`, and the corpus excludes dialogue-answer ingress; `dialogue_answer_ingress` is the recorded corpus capability exclusion).

**id 98 — leading circuit binds.** "Circuit 10, ring continuity lives are 0.61…" used to enter the ring script UNSCOPED (every entry pattern captured `circuit N` only AFTER the trigger) and ask "Which circuit is the ring continuity for?". Now all four pattern files (live ring + IR schemas, both legacy test twins) carry clause-start LEADING-circuit patterns placed first — `(?:^|[.?!][ \t]+)` anchor (horizontal whitespace only), `circuit[ \t]*(\d{1,3})`, ≤20-char clause-bounded gap to that FILE'S OWN trigger vocabulary (per-file garble divergences preserved: schema `insurance` vs twin `international`, twin ring-only terse). Circuit stays capture group 1 everywhere; all SIX `detect*` readers are collect-across-all-patterns returning `{matched, circuit_ref, scope_conflict}`.

**Contradiction resolver.** "Circuit 10, ring continuity for circuit 13" is an EXPLICIT contradiction — different refs bound by different patterns set `scope_conflict` and the engine asks the existing `which_circuit` question instead of picking a silent winner (same number twice stays unambiguous). The conflict branch runs on EVERY path — initial entry, active-episode different-entry, AND `awaiting_confirmation` (which the 5a preflight cannot own: it filters out the CURRENT circuit, so `{current, other}` used to silently switch). Volunteered values on a conflict utterance are extracted from the circuit-span-MASKED text (the raw extractors accept the first digit after a conductor label — "…earths for circuit 3 are 1.19" must never write 3) and queued against an UNRESOLVED episode that drains onto the `which_circuit` answer.

**id 93 — cross-utterance delete.** "delete" then "recontinuity readings for circuit 13." (6 s apart, two STT finals) used to lose the delete: the entry guard tests only the trigger utterance. Now `sonnet-stream.js` owns a one-shot destructive-intent token: every accepted transcript is arrival-stamped ONCE (enumerable server-owned `Symbol`, survives the `{...msg}` queue/requeue spreads, never client-suppliable); a standalone destructive utterance (`DESTRUCTIVE_INTENT_RE`, anchored grammar in `dialogue-engine/helpers/destructive-intent.js` — "fix the socket wiring on circuit 4" never arms) ARMS at the model-commit seam (immediately before `runShadowHarness`, after every pending-ask early-return — a "delete" consumed as an ask answer arms nothing; `{handled:true, fallthrough:true}` script exits DO arm); the NEXT transcript CONSUMES the token exactly once at its terminal disposition (gate-block/ask-resolution returns, or post-dequeue before the three dialogue wrappers), and within the ORDERED ARRIVAL DELTA window (`CROSS_UTTERANCE_DESTRUCTIVE_WINDOW_MS` = 12 s — the repro gap is 6 s; never a consumption-time `now`, so queue latency behind an in-flight extraction can't expire a live token) the engine skips ENTRY for any schema carrying an `entryExclusionPattern` and the trigger reaches the model with the delete intent intact. The live IR schema also gains the ring-shape destructive-verbs-only `entryExclusionPattern` (same-utterance parity — P1 had covered ring only). P1's contracts and live probes are byte-unregressed; the twins deliberately get NO cross-utterance machinery (engine-only test class).

**Key files:** `src/extraction/dialogue-engine/schemas/{ring-continuity,insulation-resistance}.js`, `src/extraction/dialogue-engine/engine.js`, `src/extraction/dialogue-engine/helpers/destructive-intent.js`, `src/extraction/sonnet-stream.js`, twins `src/extraction/{ring-continuity,insulation-resistance}-script.js`; tests `dialogue-engine-leading-circuit-scope.test.js`, `sonnet-stream-cross-utterance-delete-ingress.test.js`, `dialogue-engine-replay.test.js` (+5 parity scenarios).

---

## Dialogue-engine correction paths (PLAN-1, feedback-2026-07-27 wave)

> Added 2026-07-30 (feedback ids 105/109/110b/113, sessions 2C297353/CCFE039C/BE1C53C0). Backend-only, **zero wire change** — both clients benefit identically. Same verification lane as Plan F (dialogue ingress is outside the field-replay corpus boundary).

**Ring correction ladder is bidirectional (ids 109/110b).** The `awaiting_confirmation` ladder's named extractors required label-before-value, so `"0.85 on the lives"` exited engine-silent and an entry-shaped amend re-read the OLD values. The ring slots now carry `namedExtractorCandidates` — a field-first + value-first candidate pair with the legacy twin's smaller-gap/field-first-ties selection rule (`helpers/extraction.js`; the value-first connector `on/for/across/at/down/onto/to` is MANDATORY so circuit/way numbers never mis-classify as readings). The widening reaches every extractor consumer — entry, unresolved-queue/drain, mid-collection, conflict resolution, and the orphan-net `reparseSingleCompleteReading`, which now masks `circuit N` spans (shared canonical `maskCircuitSpans`) before extracting.

**Retained-value negation machine.** `"No. 0.85"` (negation + one bare anchored value, no pending slot) retains the value on `state.confirmation_pending_value` while the existing negation re-ask asks WHICH slot is wrong — routed through `handleNegation` so the P1 latch/counter/cap bookkeeping is shared; the slot answer (`"R1"`) applies the retained value via the 5c write path (one write, one frame, re-confirm) — a two-turn correction. Cleared on every exit and every mid-episode continuation (5b amend, 5c write, value-less 5g re-entry). 5g now PRESERVES the per-episode `confirmation_negation_reask_emitted` latch — resetting it re-opened the feedback-91 byte-identical-repeat silence class. Non-negated bare unnamed triples (`"0.85, 0.86, 0.91"`) stay model-bound — dated known limitation, Derek-confirmed 2026-07-29.

**RCD entry is intent-gated (id 113).** Entry now requires the RCD/ICD token AND (an in-clause `circuit N` OR an enumerated intent term: `test | trip | milliseconds | ms | button | x1 | x5 | times one | times five` — stem-only, both directions, clause-bounded) AND NOT the narrative veto (`no/without RCD protection | RCD absent | not RCD protected` — a third entry-exclusion pattern beside the P1 imperative/denial pair; it outranks circuit scope). Descriptive RCD mentions — including the general-condition sentence the script used to hijack — now reach the model, which owns `record_reading` for RCD fields and can ask (fail-forward, Derek-confirmed). Circuit stays capture group 1 in every trigger; the veto gates script ENTRY only (documented asymmetry: `reparseSingleCompleteReading` consults `schema.triggers`, never `entryExclusionPattern`).

**IR volunteer-both path (id 105).** When both readings arrive before the circuit, the circuit-resolution turn now parses the voltage from the RAW reply with the resolution span masked (whole-reply mask for a bare numeric answer; span-only for `circuit N`/designation, so `"circuit 4, tested at 500"` is byte-identical) — resolution metadata rides additively on `parseCircuitDigitWithSpan` + `findCircuitsByDesignation.matchedDesignation`. A null parse EMITS the voltage ask and stamps `voltage_phase_entered_at` (arming the existing 30 s re-ask + `onExclusiveSlotAbandoned`); a `flushWritesOnce` latch on every enumerated exclusive-branch exit wire-emits the drained writes exactly once (the confirm-gate non-standard prompt flushes on the drain turn). Schema-scan pin: exclusive slots == `{ir_test_voltage_v}` across all registered schemas.

**Key files:** `src/extraction/dialogue-engine/{engine.js, helpers/extraction.js, helpers/circuit-resolution.js, schemas/ring-continuity.js, schemas/rcd.js, parsers/ohms.js}`, `src/extraction/stage6-shadow-harness.js`; tests `dialogue-engine-correction-paths.test.js` (72), `dialogue-engine-rcd-entry-guard.test.js` (decision table), `dialogue-engine-replay.test.js` (+3 value-first parity scenarios — the twin needed zero edits).

---

## Dialogue-engine entry, resolution & decline (PLAN-A, feedback-2026-08-11 wave)

> Added 2026-08-12 (feedback ids 114/116/123, sessions 2026-08-01/08-11). Backend + prompt only, **zero wire change** — both clients receive better ask/confirmation CONTENT over existing frames.

**Morphological designation folding (id 116).** `findCircuitsByDesignation` is now TWO-PASS: pass 1 is the pre-existing normalisation + bidirectional character-substring test, byte-for-byte unchanged (it still owns partial-token plurals like "cookers" ⊂ "Cooker"); pass 2 — consulted ONLY on zero pass-1 candidates — tokenises the ORIGINAL caller text into raw-offset records (hyphen/punctuation folding at token level; leading filler dropped by dropping records) and runs token-sequence containment through a CLOSED equivalence table (`light|lights|lighting → light`, `socket|sockets → socket`, `heater|heating → heater`). "Upstairs lights" now resolves designation "Upstairs Lighting" at entry, active-path answers, and disambiguation restrict alike (all route through the one helper). A unique pass-2 match returns `matchedUserSpan` (raw offsets), consumed by `maskCircuitResolution`'s designation branch BEFORE its literal-designation search — without it a pass-2 match would mask the ENTIRE reply and drop a co-dictated voltage ("Upstairs lights, tested at 500"), the id-105 regression class. No generic s/es suffix stripping (mangles "house"/"mains"), no edit-distance fuzz (banned).

**Value-first compound IR entry (id 123).** `insulationResistanceSchema.compoundEntryExtractor(text)` certifies BOTH IR legs from the field shape "…is greater than 299 live to live and live to earth" (VALUE first, two conjunct trailing labels — the per-slot LABEL→bridge→VALUE extractors structurally cannot match it, so the loop used to re-ask both legs and the re-answers lost the `>`). Consulted by `runEntry` on the ordinary AND scope-conflict extraction paths ONLY when named extraction found neither IR slot, with the RAW entry text (masking would erase the scope guard's evidence). LABEL-PAIR-FIRST algorithm: locate the trailing label pair (both orderings, `and`/`&` only, plus end-of-clause "both"/"both readings"/"both tests" — never "both circuits"); bounded same-clause prefix (rejects `;`/CR/LF and contrast tokens); retain only IR-QUALIFIED candidates (sentinel/greater-than form, explicit megaohm unit, or the closed connector set `is|was|reads|measures|equals`) with conflicting-unit rejection ("tested at 500 volts…" can never certify 500 MΩ); accept exactly ONE qualified candidate; whole-span `\bcircuit\s*\d{1,3}\b` scope guard (the sole marker, `maskCircuitSpans` convention).

**Pending-value decline branch (id 114).** The A4 chain can now be DECLINED: `classifyDeclineReply` is consulted for control flow at the initial pending-value ask and at each brokered outcome (field/value/circuit). A whole-reply decline ("Don't worry.", "Doesn't matter.") drops the pending value and resolves `match_status:'user_declined'` SILENTLY — the P4 answered-ask ack net remains the sole spoken-ack producer (exactly ONE decline-family ack; never the terminal apology). No-reask is ENFORCED: eligibility/capture is hoisted pre-Promise, a dispatcher-local (per-generation) declined-pending fingerprint records canonical field/value/circuit at decline time, and a same-generation model retry of the same operation is resolved `user_declined` pre-registration (no timer/register/ledger entry — the P4 predicate structurally cannot double-ack). Vocabulary: `doesn't matter` → `DECLINE_PHRASE_RE`; `don't worry` + `doesn't matter` (straight AND curly apostrophes — Deepgram emits U+2019) → `CANCEL_PHRASES`, verified across all five consulting families with whole-reply anchoring (a continuation beginning with the phrase never cancels). A decline resolves the ASK only — never deletes an applied reading; the fingerprint dies with the generation, so the next utterance is unaffected. One additive prompt line mirrors the contract.

**Key files:** `src/extraction/dialogue-engine/helpers/circuit-resolution.js`, `src/extraction/dialogue-engine/engine.js`, `src/extraction/dialogue-engine/schemas/insulation-resistance.js`, `src/extraction/stage6-dispatcher-ask.js`, `src/extraction/stage6-answer-resolver.js`, `config/prompts/sonnet_agentic_system.md`; tests `dialogue-engine.test.js` (pass-2 folding), `dialogue-engine-correction-paths.test.js` (id-116 masking), `dialogue-engine-compound-ir-entry.test.js`, `stage6-dispatcher-ask-pending-value.test.js` (decline + fingerprint), `stage6-pending-value-decline-ingress.test.js` (exactly-once ack), `stage6-answer-resolver.test.js` (CANCEL_PHRASES matrix), `stage6-classify-decline-reply.test.js`.

---

## Dialogue-engine provenance ledger & terminal read-backs (PLAN A2, feedback-2026-08-11 wave)

> Added 2026-08-12 (feedback id 117, session CF052DF3). Backend only, **zero wire change** — both clients receive better completion CONTENT over existing frames.

**The bug.** A scoped trip-time correction ("RCD trip time for circuit 5, the 27 ms") entered the RCD script while every askable device slot (BS/type/mA) was already snapshot-filled. `askNextOrFinish` ran the end-of-walkthrough ceremony — the bulk-apply ask, then a `finishMessage` reading back BS/type/mA the inspector never said — while the actually-dictated 27 ms got NO read-back at all (`buildExtractionPayload` carries no `confirmations[]`; `buildScriptInfo`/`finishMessage` was the sole spoken completion frame, and it never named trip time).

**The fix — a per-run dictation-operation ledger.** `initScriptState` gains an ORDERED `state.operations` list: `{operation_id, field, dictated_value, written_value, effective_circuit_ref, source, spoken_owner, disposition, covered_by}`, populated via `markDictated`/`markWritten`/`markSatisfiedExisting`/`markRejected`/`markAbandoned` at every write path — all 8 `applyWriteWithDerivations` call sites (runEntry, the three confirmation-branch amend positions 5b/5c/5d, the IR exclusive branch, steps 7/8, `enterScriptByName`'s Sonnet seed loop), both `pending_writes` drains (rewritten to the full derivation-aware algorithm — the drains previously called the plain `applyWrite` and silently dropped mirrors/pivots), and the `tryEnterScriptFromWrites` triggering field. Every enqueue/upsert site (entry scope-conflict queue, same-reply upsert, unresolved follow-up upsert) carries the operation reference on the queued object (a non-enumerable `OPERATION_REF` symbol) so the eventual drain binds the SAME operation rather than fabricating a new one; a superseded queued operation becomes `abandoned`.

**Seeded-value skip is now canonicalise-and-compare (§A2.3).** The four/five sites that used to skip ANY value already present in `state.values` — equal or not — now canonicalise both sides through the slot's own parser before deciding: canonical-EQUAL → no write, `disposition:'satisfied_existing'` (still read-back-eligible — dictated non-empty must never produce silence); canonical-DIFFERENT → overwrite. A canonical-DIFFERENT Sonnet-forwarded value used to be silently discarded while the closing speech claimed the ledger's (never-written) value.

**Dispatcher-resolved speech ownership (§A2.4).** `stage6-dispatchers-script.js` projects this turn's per-field winners (`projectReadingWinners`) BEFORE calling `enterScriptByName` and passes a `(field, circuit_ref, canonicalValue) => 'bundler'|null` resolver into the engine — timing is the crux, since `enterScriptByName` can synchronously finish-and-clear before the dispatcher's own post-call backfill would otherwise learn about it. The resolver does the canonical comparison itself (it alone holds the prior winner's value) and returns `'bundler'` ONLY when a same-turn prior winner (record_reading, or an earlier seed) is canonical-EQUAL to this seed — the bundler already speaks that exact value, no rewrite, `spoken_owner:'bundler'`. A canonical-DIFFERENT prior winner is NOT authoritative: the resolver returns `null` and the seed falls through to the normal canonicalise-compare-against-snapshot rule, overwriting it and becoming the latest (bundler-backfilled) winner (Codex diff-review r1, 3/3 lenses — an earlier "any prior winner wins unconditionally" draft silently discarded a genuinely different same-turn correction, id 117's exact bug class via a same-turn double-call). Absent any prior winner: canonical-EQUAL → script-owned; canonical-DIFFERENT (a write) → bundler-owned ONLY when a resolver is actually present (the dispatcher's guaranteed post-call backfill) — a direct/test caller with no resolver keeps the seed script-owned. The dispatcher's own backfill REPLACES an occupied winner whose value differs (was: skip unconditionally), so an overwritten seed can never leave the snapshot and the per-turn winner map disagreeing. The resolver is only ever constructed when `perTurnWrites.readings` is a live `Map` (a caller with no backfill guarantee gets `null`, keeping the seed script-owned).

**Ceremony gating + the terminal-sink rule (§A2.5).** `askNextOrFinish` fires the RCD `postCompletionAsk` bulk-apply prompt only when a dictated operation intersects `postCompletionAsk.fields`. `finishScript`'s device-summary text is OPERATION-AWARE and opt-in via `schema.finishCoveredFields` (RCD/RCBO declare it; ring/IR don't, keeping their pre-plan unconditional finishMessage behaviour — ring/IR's mandatory `confirmation` ask already speaks every filled value regardless of dictation provenance, so `finishScript`'s text there is a positive-finish acknowledgment, not a competing summary): every finish-covered field with a script-owned operation → verbatim legacy text; no covered field at all (id 117's exact scenario) → the legacy text is suppressed entirely, never partially. A single shared helper (`computeUncoveredReadback`/`renderTerminalReadback`) computes and marks-covered every UNCOVERED `applied`/`satisfied_existing` non-bundler operation before EVERY one of the 17 `clearScriptState` sites and `runPivot` — TERMINAL sites (cancel, defer, bulk-apply-done, the confirmation cap exit, finish) APPEND the read-back text into their own existing frame (one combined wire message); sites with no natural host message (topic-switch, switched-circuit, the confirmation `clearAndFallThrough`/negation-cap shared helpers, the second-miss unresolvable-circuit discard, the paused-resume hard-timeout, the Sonnet-write all-slots-filled exit) emit it as one distinct info frame. REPLACEMENT sites (`runPivot`, the scope-conflict clear+reinit, the confirmation-branch circuit-switch-via-runEntry) carry the full ordered operation list across instead of rendering — a pivoted-away field's read-back still renders from the operation, not the new schema's `state.values`. `transitionToConfirmation` (ring/IR's mandatory pre-finish readback) marks every field it actually speaks covered, so a later terminal exit never doubles it. Coverage is circuit-scoped throughout (Codex diff-review r2): `finishScript`'s `scriptOwnedDictatedFields` and `askNextOrFinish`'s bulk-ask trigger both require `effective_circuit_ref === state.circuit_ref`, since a REPLACEMENT site can carry a stale operation from a DIFFERENT circuit into the current episode — without the filter, that stale operation could wrongly mark the current circuit's never-dictated, snapshot-only value as "covered." Coverage is per-OPERATION, not per-field (refine-log round 2, reaffirmed by Codex diff-review r2, 2/3 lenses): two same-field APPLIED dictations (a correction made before any terminal exit) are TWO distinct operations and both get spoken — `findCoveringOp`/`transitionToConfirmation` mark only the LATEST matching operation `covered_by` (the one whose value the legacy finish/confirmation text actually renders), so the earlier, genuinely-applied correction remains uncovered and is separately named via the terminal-sink append. This is deliberately asymmetric with a superseded QUEUED write, which never landed on the snapshot and is marked `abandoned` (silent) rather than spoken — a round-1 draft that also excluded a superseded APPLIED operation was reverted after r2 found it contradicted the plan's own test (l) and its round-2 rationale.

**Behaviour preserved.** A full walk-through that dictates its device slots keeps the ceremony verbatim (bulk-apply ask + device summary; every summarised field script-owned) — existing test expectation text for that path is unchanged. The `dialogue-engine-replay.test.js` legacy-vs-engine parity harness treats the new terminal read-backs as a documented, intentional divergence (the legacy scripts are deprecated and never gain this fix) — `normaliseEmits` strips standalone `terminal_readback` frames and appended `"Also got …"` suffixes before comparing.

**Key files:** `src/extraction/dialogue-engine/engine.js`, `src/extraction/dialogue-engine/schemas/{rcd,rcbo}.js`, `src/extraction/stage6-dispatchers-script.js`; tests `dialogue-engine-plan-a2-provenance.test.js` (the named production-ingress probes), `dialogue-engine.test.js`, `dialogue-engine-bulk-apply.test.js`, `dialogue-engine-pd.test.js`, `dialogue-engine-replay.test.js`, `stage6-a2-multiboard-script-backfill.test.js`, `stage6-dispatchers-script.test.js`.

---

## TTS language pin + confirmations-OFF audible-channel integrity (PLAN-D, feedback-2026-08-11 wave)

> Added 2026-08-13 (feedback ids 121, 122, 124). Backend + iOS + web.

**D1 — language pin (id 121).** Every ElevenLabs synthesis site pins `language_code=en` — `eleven_flash_v2_5` (a 32-language auto-detecting model) had NO pin, and a short telegraphic confirmation ("Garage, circuit 3, 1 points") is composed entirely of valid French words, so auto-detection could flip and speak the confirmation in French (log-proven: server-MP3 path, not the AVSpeech fallback). `src/extraction/elevenlabs-stream-client.js` gains a `languageCode` option (default `'en'`, via `opts.languageCode === undefined ? DEFAULT : opts.languageCode` — NOT `??`, which cannot distinguish "omitted" from an explicit `null` disable sentinel) and a shared `synthWithLanguageFailOpen(client, retryClientFactory, text, synthOpts)` helper used by every production caller (`keys.js` streaming + buffered confirmation paths, `loaded-barrel-speculator.js`, `voice-latency-fast-tts.js`): attempt 1 is pinned; on a zero-audio-bytes vendor-attributable rejection (decorated only on `msg.error`/`ws.on('error')`/`ws.on('close')` — timeout/abort/onAudio-throw never carry `bytesReceived` and so are never retry-eligible) it retries ONCE with a fresh instance and `languageCode: null`. `voice-latency-bench.js` is pinned but deliberately FAIL-CLOSED (opens its own WS, not via the shared client — a loud bench failure is the desired signal of vendor incompatibility).

**D2 — confirmations-OFF is the sole documented Audio-First invariant #1 exception (ids 122, 124).** A persisted, user-authorised confirmations-OFF mode does NOT violate "every dictated reading read back exactly once" — it is the one deliberate, opt-in exception. What this plan fixes is UNANNOUNCED silence: an entire 9-minute field session ran with `confirmations_enabled: false` with zero telemetry, zero audible cue, and zero start-of-session warning — the OFF state was indistinguishable, by ear, from a broken pipeline. While OFF, only reading confirmations are suppressed; asks, scripts, voice-command responses, and local-command speech remain audible on both clients.

- **Backend telemetry:** `sonnet-stream.js` `case 'transcript':` emits one `stage6.confirmations_enabled_state` row (`sessionId`, `utterance_id`, `confirmations_enabled: msg.confirmations_enabled === true`) after rate-limit acceptance, immediately before `handleTranscript` — the session_start wire frame does NOT carry the flag (it only arrives per-transcript), so this is the one seam that observes it every turn, unconditionally, regardless of whether the transcript is later queued, resolves a pending ask, or is gate-consumed.
- **Unified cue wording (both clients):** "Voice read-backs off." / "Voice read-backs on." on every toggle flip (both directions — previously iOS had no cue at all on either direction pre-plan, and web only spoke on ON with the retired string "Confirmations on."), plus a one-shot session-start warning "Heads up — voice read-backs are off." Cue delivery bypasses the confirmation dedupe/TTL layer (a rapid off→on→off within 30s produces three distinct cues) and defers behind an active ask or in-progress speech rather than dropping or interrupting — on web this is simply `speakConfirmation(text, {force:true})` with no `dedupeKey`, since the existing FIFO (`enqueueConfirmation`) already provides bypass-dedupe/defer/never-reset; iOS added a dedicated mode-status speech path in `AlertManager.swift` with the equivalent contract (see CertMateUnified's own changelog for iOS specifics).
- **Session-start warning binding:** bound to the PHYSICAL start of a new recording session only — iOS `DeepgramRecordingViewModel.performStartRecording()`, web `recording-context.tsx`'s `start()` (after `buildSleepManager()`/`setState('active')`, before `beginTick()`) — never to a WS reconnect resend (iOS `session_start_resent`) or a sleep/doze auto-resume (web `handleWake()`) or a manual pause-resume (web `resume()`). The setting itself is never auto-reverted — an explicit user choice must survive; only the silence around it is fixed.
- **Web default flip:** `getConfirmationModeEnabled()` in `tts.ts` now defaults to `true` for the never-set case (both storage keys absent) — the prior `false` default combined with a false "matches iOS" comment meant every new web inspector started in the exact silently-muted state this plan fixes, as the DEFAULT experience, not an edge case. An explicitly stored `false` is unchanged.

**Key files:** `src/extraction/elevenlabs-stream-client.js`, `src/routes/keys.js`, `src/routes/voice-latency-fast-tts.js`, `src/routes/voice-latency-bench.js`, `src/extraction/loaded-barrel-speculator.js`, `src/extraction/sonnet-stream.js`, `web/src/lib/recording/tts.ts`, `web/src/components/recording/recording-chrome.tsx`, `web/src/lib/recording-context.tsx`, CertMateUnified `Sources/Recording/{AlertManager,DeepgramRecordingViewModel}.swift`, `Sources/Views/Recording/RecordingOverlay.swift`.

---

## Spares in bulk apply + gate trigger vocabulary (PLAN-F, feedback-2026-08-11 wave)

> Added 2026-08-13 (feedback ids 115, 78). Backend + iOS + web. Not to be confused with the unrelated "Dialogue-script leading-circuit scope" section below, also historically named "Plan F".

**spare_policy grammar (id 115).** `set_field_for_all_circuits`'s `scope` is a SELECTOR (`all` / legacy `non_spare` / `rcd_protected_only`); the new optional `spare_policy` (`automatic`|`include`|`exclude`) is an orthogonal FILTER composing with any selector. Resolution — identical on backend, iOS `VoiceCommandExecutor.resolveSparePolicy`, and web `voice-commands.ts`'s `resolveSparePolicy`: explicit `spare_policy` always wins (including over legacy `non_spare`); explicit `scope:'all'` + omitted policy preserves the documented tested passthrough (include); explicit `scope:'non_spare'` + omitted policy preserves forced-exclude; otherwise the family-aware automatic default applies — `DEVICE_ATTRIBUTE_FIELDS` (OCPD+RCD spec fields, 8-field closed list) include spares, every reading field excludes them. iOS/web local parsers (`ApplyFieldIntent.parse` / `parseVoiceCommand`) recognise spoken "including spares"/"excluding spares"/"except spares" modifiers and attach `sparePolicy` to the parsed command; a contradictory utterance (both directions named) is CONSUMED locally — a deterministic refusal, never forwarded to the server.

**Audible skip disclosure (Decision 4).** Two distinct spoken forms, byte-identical across all three implementations: an append-clause on a surviving confirmation, present-continuous ("…skipping N spare ways"), and a standalone zero-applied sentence, past-tense ("No non-spare circuits were updated; skipped N spare ways.") — used when every scoped target was a spare under an exclude policy, so there is no confirmation to append to. The backend dispatcher stages a `perTurnWrites.bulkOutcomes` ledger entry that `stage6-event-bundler.js` consumes after `synthesiseConfirmations()` returns, joining by a composite `(callId, effectiveBoardId)` identity (PLAN-F2, 2026-08-14) — REPLACE fires only when a repeat call's `appliedRefs` AND `spareSkippedRefs` both match an existing entry EXACTLY (a genuine same-sweep correction); disjoint targets, or a partition that changed between calls, each APPEND their own entry and their own disclosure. The zero-applied/fallback entries also carry a board-discriminated `bulkoutcome_<turnId>_<callId>_<effectiveBoardId>` `dedupe_token`, recognised as a structural prefix by every client/backend dedupe-key builder and the server-side confirmation debounce. A confirmation already carrying PLAN-B's `fast_correlation_id` is never mutated in place (its text must stay byte-identical to the already-spoken fast clip) — the disclosure ships as its own additive line instead.

**Extent/limitations gate vocabulary (id 78).** `extent`, `limitation`, `limitations` joined the WEAK trigger tier on all three synced gates (backend `pre-llm-gate.js`, iOS `TranscriptGate`, web `transcript-gate.ts`) — a 13-month orphan where the fully voice-writable `extent` field had no trigger word in any tier. Weak tier only; standard 3-content-word threshold unchanged.

**Key files:** `src/extraction/stage6-dispatchers-circuit.js`, `src/extraction/stage6-tool-schemas.js`, `src/extraction/stage6-event-bundler.js`, `src/extraction/stage6-per-turn-writes.js`, `src/extraction/device-attribute-fields.js`, `src/extraction/pre-llm-gate.js`, `packages/shared-utils/src/voice-commands.ts`, `web/src/lib/recording/transcript-gate.ts`, CertMateUnified `Sources/Recording/{VoiceCommandExecutor,DeviceAttributeFields,DeepgramRecordingViewModel}.swift`.

---

## Observation apply identity (P7 — server-id keying, marker ④)

> Added 2026-07-24 (feedback id 82, session 36731498). Client-only (iOS `applySonnetObservations` + web `applyObservations`); **zero backend change**.

The observation ENTITY apply path (distinct from the confirmation TTS path above) now keys dedupe on the server-assigned `observation_id`, not client-side text similarity. The backend owns observation identity — it stamps every created observation with a stable id and runs its own dedupe/refinement pipeline (BPG4, RULE-6, D2 chains) — so a server-created observation arriving at the client is already deduped and authoritative.

The old client text-similarity gate (>0.7 word overlap / 40-char prefix, on BOTH clients) was a redundant belt-and-braces filter that false-positive-swallowed genuinely distinct observations sharing common electrical vocabulary — e.g. "small hole in the **side** of the enclosure" vs "small hole present in the **top** of the enclosure" (~0.8 overlap). Session 36731498's top-hole C3 was backend-created, its confirmation SPOKEN, then dropped by this gate — heard, never written (an inverse Audio-First violation).

Apply rules (`applySonnetObservations` / `applyObservations`):

| Incoming `observation_id`                     | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| non-nil, already on a row (`server_id` match) | **IDEMPOTENT REPLAY — PURE NO-OP.** A P4d reconnect replays the ORIGINAL extraction frame PRESERVING ids. Because it is the SAME frame the original apply already consumed, "filling absent fields" could only ever no-op OR restore a field an authoritative `observation_update` has since CLEARED (`regulation_title`/`description` clear to nil on a table-miss refinement; schedule linking is owned by the create path), so a replay fills NOTHING and skips every creation side-effect (append, pending-photo attach, `recentObservationId`/reverse-link, `observation_added` card) AND schedule projection. Authoritative field changes remain `observation_update`'s job. |
| non-nil, not seen                             | apply (server authoritative, already deduped)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| nil/empty (older servers omit it)             | retain the text-similarity fallback for id-less rows ONLY, so a nil-id replay can't duplicate-render                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The `observation_update` handler is **id-first, scoped-fuzzy**: match `server_id` first; on a miss, fuzzy-match ONLY legacy (no-`server_id`) rows and STAMP the incoming id onto the match; NEVER fuzzy-match a row carrying a DIFFERENT server id (that would patch the wrong distinct observation — the same side/top-hole shape). A nil incoming id keeps the unrestricted fuzzy (older-server compat).

One-release diagnostic (iOS): `observation_apply {observation_id, dedupe_bypassed_reason}` on the `client_diagnostic` channel confirms from the field that id-keying introduces no duplicate-render regression. Parity: `web/docs/parity-ledger.md` `recording/observation-id-dedupe`.

---

## Backend transcript normalisation (P6 — canonical ingest layer)

> Added 2026-07-24 (feedback ids 89 + 80A). Backend-only, **zero wire change**.

There is now ONE canonical normalisation layer for the raw dictation transcript, applied at the backend ingest in `src/extraction/sonnet-stream.js`. `src/extraction/transcript-normalise.js` is a pure, enumerated `normalise(text) → {text, rules_hit[]}` with **two evidence-backed rules** (word-boundary, pattern-anchored — **no fuzzy/edit-distance**, per §3E + the research-methodology ban):

| Rule ID          | Rewrite                              | Notes                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a_hundred`      | `"a hundred"` → `"100"`              | The article word-number (iOS/web digit-ise `"one hundred"` + compounds, not `"a hundred"`). Compound guard: `"a hundred and fifty"` is left UNTOUCHED (out of scope, no corruption). Runs FIRST so its digit output satisfies the `zs_field_token` gate. |
| `zs_field_token` | `"Z s"`/`"Zed s"`/`"zed s"` → `"Zs"` | **Context-gated** on a reading-shaped same-clause (connector/scope word + numeric-or-sentinel value) so genuine two-letter dictation (`"Z S Electrical"`, `"designation Z S 1"`, spelled postcodes) is NOT collapsed.                                    |

**Origin:** id 89 (`"Z s on the heating was 0.67"`) failed to anchor because `reading-transcript-anchor.js` looks for the substring `"zs"`, which spaced `"z s"` misses; id 80A (`"A hundred MΩ"`) failed to parse because the word-number produced no digit.

### Raw/canonical split (do NOT mutate `msg.text`)

`msg.text` is **never mutated** — a canonical COPY is derived and threaded to model-facing/behavioural consumers, so the recorded-corpus fixtures + the reverse-race dedupe keys keep the raw garble (a future replay must reproduce the bug, not mask it). There is no live raw-transcript S3 sink on this path (only `cost_summary.json` is uploaded); the authoritative raw artifacts for future replays are the RAW literals pinned in the unit + production-ingress tests plus the field-feedback records (sessions 2ACE7677 / 36731498). No P6 `.yaml` corpus fixture was added — the production-ingress test is the load-bearing raw→canonical proof.

Applied at **two seams**, with this consumer routing table:

| Seam                                                           | CANONICAL (canonical copy)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | RAW (unchanged)                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **A — `handleTranscript`** (top, after the `isStopping` guard) | both content anchors (recentAskAnswers consult + recentTranscripts push), the pre-LLM gate, BOTH `classifyOvertake` calls (pre-queue + transcript-overtake — the latter stays **un-annotated**), `detectStructuredReading`, the model-bound `transcriptText` (incl. the `in_response_to` annotation), the three dialogue-script `rawReplyText` args (normalised but **un-annotated**), `runShadowHarness`                                                                                                                                                                                  | `msg.text`; exact-dedupe on `utterance_id`; log previews (`.slice(0,80)`)                                                 |
| **B — `ask_user_answered`**                                    | **Behavioural (model-facing) consumers** use `canonicalAnswerText` (= normalise of the POST-sanitisation text): the `classifyOvertake` shape check, the new-command gate, `detectStructuredReading`, `resolvePayload.user_text`, the re-injected synthetic transcript. **Dedupe-ledger ops** (the pre-sanitisation reverse-race lookup AND the recentAskAnswers anchor push) use one raw-based `canonicalUserTextForAnchor` (= normalise(`msg.user_text`)) so their keys match Seam A's raw-based transcript stamp in either arrival order — even for a truncated/control-stripped answer. | `sanitiseUserText` runs on RAW `msg.user_text` (length/truncation semantics unchanged); raw previews + sanitisation flags |

**Both content anchors are canonical on BOTH seams** so cross-seam dedupe equality holds in either arrival order (no double-exposure). The re-injected synthetic transcript is already canonical, so Seam A re-normalises it to a no-op.

**Telemetry:** `stage6.transcript_normalised { rules_hit, seam }` (rule IDs ONLY — never the raw/canonical text; leak-filter). At Seam A the result is stashed on a JSON-invisible `Symbol` so the isExtracting queue/drain + `user_moved_on` re-entries reuse it and log EXACTLY once per message.

**Incidental INFO-log previews** (engine / dispatcher-logger) that derive from the now-canonical vars MAY read canonical — that is the documented, pinned behaviour (the load-bearing raw requirement is only the debug/corpus capture boundary, which has no live sink here).

**Web:** zero wire change; web transcripts flow through the same backend ingest, so web benefits identically. The web client-side regex fast-hint tier still sees raw text (acceptable — the server model overwrites).

**Key files:** `src/extraction/transcript-normalise.js` (pure rules), `src/extraction/sonnet-stream.js` (the two seams), `src/__tests__/transcript-normalise.test.js` (unit), `src/__tests__/sonnet-stream-transcript-normalise-ingress.test.js` (the raw→canonical ingress proof for both seams — the direct replay runner bypasses these seams), `src/__tests__/sonnet-stream-transcript-normalise-ir-realengine.test.js` (drives the REAL insulation-resistance dialogue engine end-to-end through `handleTranscript` and asserts it records `ir_live_live_mohm=100` from a raw "A hundred megaohms").

---

## Model-decision prompt steers (P8 — `sonnet_agentic_system.md`)

> Added 2026-07-24 (feedback ids 88 + 83). Backend **prompt-only**, ONE batched edit, **zero wire change** — both clients benefit identically. These are MODEL-DECISION fixes: recorded-lane fixtures cannot lock a should-have-decided-differently bug, so verification is LIVE probes / the nightly live lane, not a corpus fixture.

Two steers were folded into `config/prompts/sonnet_agentic_system.md`. Both land in the SHARED region (outside the `<!--A1:OFF-->`/`<!--A1:ON-->` marker blocks), so they render in BOTH `VOICE_AGENTIC_ANSWERS` flag states.

| Steer                                                               | Where                                                                                                                                                      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Steer 1 — garble-adjacent value writes (id 88)**                  | Folded into **Example 8** (`Calculate Zs vs bare Zs`)                                                                                                      | When a field anchor + an UNAMBIGUOUS circuit/board scope + a schema-valid value are ALL present, WRITE even if a garble (`"n o"`, a stray mid-utterance `"no"`, filler) sits between anchor and value — a mid-utterance garble is not a negation (`"Zs on the cooker is n o 0.55"` → `record_reading`, not a `missing_value` ask). Does NOT weaken missing-scope / contradiction / invalid-range handling; does NOT fire for a leading-`"no"` correction with no in-utterance anchor+scope (`"No. It was 0.63"` stays a correction), nor for a `"no"`+value reply to a pending `ask_user` (that resolves the ask).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Steer 2 — observation C-coding deciding-facts checklist (id 83)** | Inside the existing **AMBIGUOUS C2/C3 SEVERITY** block (reuses its bounded clarification budget + `clarification_chain_id` framing — no parallel ask path) | A compact THREE-class checklist. TWO classes (enclosure penetrations/holes · basic protection at accessories/CUs) share one ACCESS LADDER — live parts accessible TO TOUCH → **C1**; potential access → **C2**; tool/lockable or no danger → **C3**; main protective **bonding** has its OWN tree (for an extraneous-conductive part, absent/ineffective bonding or CSA <6 mm² → C2; thermal damage independently → C2, or C1 if immediate present danger; a sound ≥6 mm² bond with no thermal damage → **C3 at most, never C2**). Per-class BS 7671 citations (416.2.2 top-surface IP4X vs 416.2.1 side IP2X; 411.3.1.2 + 544.1.1/Table 54.8 bonding; 701.415.2 bathroom supplementary; 512.2 environmental IP ≠ 416.2). A FACT-WEIGHTING cue, never a blanket-default code: weight the deciding fact, ASK it first (bounded: one initial ask + at most one continuation), then code. **All outcomes are emittable C1/C2/C3/FI — there is no NC code in `record_observation` (enum is C1/C2/C3/FI); the plan's "NC"/"NO observation" outcomes were reworked to "C3 at most, never C2" during the Codex diff review so an explicit observation always records a valid code (RULE 1a) and no silent-drop / dropped-observation-net path exists.** |

**Prompt-budget note:** the steers added ~+745 tokens (base render) / ~+745 (combined), minimised via the shared ACCESS LADDER consolidation + terse prose. A measured cap bump on BOTH budget assertions in `src/__tests__/stage6-agentic-prompt.test.js` was the EXPECTED path — the plan states "compaction cannot recover ~600 tokens by folding alone" and the ~250-token target is STRUCTURALLY unreachable with Derek's mandated THREE cited C2/C3 classes. Base cap `renderedOn <= 16790` (measured 16705), combined cap `combinedRenderedOn <= 22025` (measured 21943), each `measured + ~100` headroom. One cold-cache window post-deploy (~5-min TTL re-warms).

**Live probes (post-deploy, documented — not run at merge; no `ANTHROPIC_API_KEY` in CI yet):** A) `"Zs on the <designation> is n o <value>"` → WRITE + read-back, no ask. B) read back a value, then `"No. It was <other>"` → correction, not a spurious write. C) `"Observation: small hole in the top of the consumer unit"` (multi-turn) → ONE ask naming the deciding fact, then a DISCRIMINATING code (live-parts-accessible-to-touch → **C1**, not C2). D) bare `"Zs for circuit N."` → still exactly ONE `missing_value` ask (Example-8 / marker-② steer survives).

**Key files:** `config/prompts/sonnet_agentic_system.md` (the two steers), `src/__tests__/stage6-agentic-prompt.test.js` (bumped budget caps + the Group 0b Steer-1 pin + the Group 18 Steer-2 pin, both asserted in BOTH flag renders), `src/__tests__/stage6-agentic-answers-session.test.js` + `src/extraction/eicr-extraction-session.js` + `docs/reference/architecture.md` (stale-comment sweep — the flag-off render is no longer pre-A1 byte-identical once shared-region edits land).

---

## Auto-Sleep (Deepgram Power Saving)

Prevents wasted Deepgram billing when the inspector stops speaking. Three-tier state machine:

| State        | Trigger           | Deepgram WS                   | Sonnet Session           | Visual                               |
| ------------ | ----------------- | ----------------------------- | ------------------------ | ------------------------------------ |
| **Active**   | Recording started | Connected, streaming          | Active                   | Red dot                              |
| **Dozing**   | 60s silence       | Connected, KeepAlive ($0/min) | Compacted, paused        | Grey dot, "Saving power..."          |
| **Sleeping** | 5min in dozing    | Disconnected                  | Preserved (5min timeout) | Grey dot, "Paused — speak to resume" |

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

| Chunk | What was actually said (your transcription) | What Gemini transcribed   | What made it into the UI                 |
| ----- | ------------------------------------------- | ------------------------- | ---------------------------------------- |
| 000   | "Ze is 0.35 ohms"                           | "Ze is 0.35 ohms"         | Ze: 0.35                                 |
| 001   | "Circuit 1 lights, 6 amp B type MCB"        | "Circuit 1 lights, 6 amp" | Circuit 1: lights, 6A (missing MCB type) |
| 002   | "R1 plus R2 is 0.8"                         | "Our one plus R2 is 0.8"  | r1_r2: empty (bad transcription)         |

**To get "What Gemini transcribed":** Parse the debug log (`debug_log.json`). Look at `CHUNK_COMPLETE` events — each has a `transcript=` field showing what Gemini returned for that chunk index.

**To get "What made it into the UI":** Parse `extracted_data.json` which contains the final job state (circuits, supply, installation, observations).

### Step 5: Identify the failure point for each missed value

For every value that was spoken but didn't end up in the UI, classify the failure:

| Failure Type                   | Meaning                                                                          | Example                                                           |
| ------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Audio quality**              | Your transcription also couldn't understand it                                   | Mumbled, background noise, too quiet                              |
| **Gemini transcription error** | You heard it correctly but Gemini got it wrong                                   | "0.35" → "0.25", "MCB" → "and CB"                                 |
| **Extraction miss**            | Gemini transcribed correctly but the value wasn't extracted into structured data | Transcript says "Ze 0.35" but extraction JSON has no Ze field     |
| **Field routing error**        | Value extracted but put in wrong field or wrong circuit                          | Zs value put in Ze field, or circuit 2 data assigned to circuit 1 |
| **Priority/overwrite**         | Value was set but later overwritten by a subsequent chunk                        | Earlier chunk set Ze=0.35, later chunk overwrote with Ze=0.40     |
| **Pre-existing block**         | Field already filled by CCU photo, extraction skipped it                         | CCU set ocpd_rating=32, recording said 40 but was blocked         |

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

| Event                    | Meaning                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `SESSION_START`          | Recording began — shows sessionId, jobId                                           |
| `CHUNK_START`            | Audio chunk created — shows index, duration, sample count                          |
| `CHUNK_COMPLETE`         | Transcription returned results — shows transcript, circuit count, orphans, latency |
| `CHUNK_ERROR`            | Transcription call failed — shows error details                                    |
| `GEMINI_SET`             | Field set for first time by extraction                                             |
| `GEMINI_UPDATE`          | Field overwritten by later extraction                                              |
| `GEMINI_CIRCUIT_CREATED` | New circuit created from extraction data                                           |
| `GEMINI_MERGE`           | Final merge applied — shows total circuit count                                    |
| `SESSION_END`            | Recording stopped — shows total chunks and transcript length                       |

## S3 Paths Reference

| Artifact            | S3 Path                                                   | Format                                              |
| ------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| Audio chunks        | `debug/<userId>/<sessionId>/chunk_XXX.flac`               | FLAC 16kHz mono (5-10s each)                        |
| iOS debug log       | `jobs/<userId>/<address>/output/whisper_debug.json`       | JSON (events, transcripts, field updates)           |
| Backend debug log   | `jobs/<userId>/<address>/output/debug_transcription.json` | JSON (chunk metrics, accumulated transcript)        |
| Job data (UI state) | `jobs/<userId>/<address>/output/extracted_data.json`      | JSON (circuits, supply, installation, observations) |

## Common Recording Issues

| Issue                                | Cause                                                      | Solution                                       |
| ------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------- |
| Values said but not in transcript    | Audio too quiet, mumbled, or background noise              | Speak clearly, closer to mic                   |
| Numbers without context lost         | Said "0.8" without "Ze is 0.8"                             | Always prefix values with field name           |
| Circuit data missing                 | Never said circuit name/number                             | Say "Circuit 1 is..." before readings          |
| Short chunks empty                   | Transcription struggles with <3s audio                     | Speak in longer continuous phrases             |
| Values transcribed but not extracted | Extraction prompt doesn't map the phrasing to a field      | Check extraction prompt — may need synonym     |
| Values in wrong circuit              | Circuit ref wasn't mentioned before values                 | Say circuit number before each set of readings |
| Field blocked by CCU                 | CCU photo pre-filled the field, extraction won't overwrite | Expected — CCU data takes priority over voice  |

## MAIN EARTH vs Ze detector aliases + prompt precedence (Plan E-ship, 2026-07-29)

> Backend prompt + `src/extraction/stage6-pending-value.js`, **zero wire change** — both clients benefit identically. This is the standalone, review-quiet extraction of held PR #126 (plan E main-earth-steer); the C4 concurrent-state ask-answer routing half of that plan (shared semantic-slot identity, ordinary-ask overtake/re-injection lifecycle, generation supersession, reservation/rollback) is **NOT** part of this section and stays on the held branch pending a future re-plan (`sticky-wrong-field-replan`).

**The bug.** Derek dictated *"Main earth is 16"* — a conductor cross-sectional area in mm² — and the model wrote `earth_loop_impedance_ze`, an impedance in ohms. Two quantities, two certificate boxes.

**Prompt precedence ladder** (`config/prompts/sonnet_agentic_system.md`, Group 20): "Ze at the board"/"Ze at DB" keeps its existing `ze_at_db` routing ABOVE bare Ze; a bare-Ze anchor or an explicit ohms unit ⇒ `earth_loop_impedance_ze`; an explicit size anchor ⇒ `earthing_conductor_csa` (bare "conductor" is explicitly NOT a size anchor, so material/continuity/bonding phrasings keep their existing fields); a genuine conflict draws ONE ask naming the unit. Example-8 gains a re-opened-field-choice exception: a reply naming a different field's vocabulary re-maps from the reply's own words.

**Detector aliases** (`detectStructuredReading`'s `DETECTOR_ALIASES` map): two new anchored earth phrases route to `earthing_conductor_csa` — `main earth` and `main earthing conductor` — each with a `notFollowedBy` immediate-lookahead exclusion so an adjacent phrasing ("main earthing conductor material is Copper") is NOT seized as a CSA reading. A bare "earthing conductor" alias is deliberately absent (first-hit-wins would seize the material/continuity fields). `ze at the board`/`ze at db` are ordered ahead of bare `ze` in the same map.

**What this buys standalone (no C4 machinery needed) — and its known limit:** the detector's field label is only ever used as a boolean "is this a fresh structured reading?" guard — nothing downstream writes from the label itself. On the tested pendingValue-class dispatcher path (a `context_field:"none"` ask, or a brokered `pvr-*` ask), an ambiguous main-earth reply that arrives while that kind of ask is pending fails the guard and falls through to the model as a fresh transcript, where the prompt ladder above resolves it — pinned by two DECIDED-pin tests (`src/__tests__/stage6-pending-value.test.js`, `src/__tests__/stage6-dispatcher-ask-pending-value.test.js`). This guard is **NOT** applied on the direct `ask_user_answered` channel for an ORDINARY concrete-field ask (e.g. a pending Zs ask) — that scoping is pre-existing on `origin/main`, untouched by this extraction, and the same limitation applies today to any already-recognised alias (e.g. "Ze is 0.35" answering an open Zs ask). Closing it requires exactly the C4 semantic-slot ask-answer comparison this extraction defers to the re-plan (`sticky-wrong-field-replan`).

**Live probes required (post-deploy, ear-verified only — never closed headlessly):** the main-earth positive pair, a blocking "Ze is 0.35" no-regression check, "the earth is 16" ambiguity, an adversarial precedence set, and the blocking adjacent-field set (`earthing arrangement is TT` / `Ze at the board is 0.2` / `main bonding is 10`). See the ep-digest for outcomes.

## Board-Clear Client Contract (Plan A1b, 2026-07-29)

The `clear_board_reading` tool (A1a, feedback id 101 — "Delete Ze") emits a
BOARD-scope `field_corrected` frame both clients route on:

```
{ type: 'field_corrected', circuit: null, field: 'ze'|'pfc'|'manufacturer',
  previous_value, reason: 'clear_reading', board_id: '<non-null>' }
```

- **Discriminator:** `circuit: null` + non-null `board_id`. The dispatcher
  ALWAYS resolves a board id (`resolveEffectiveBoardIdForClear` → main-board
  fallback), so a scope-less frame (neither circuit nor board_id) is a
  contract violation — both clients REJECT it at decode (iOS throws, web
  drops + logs `field_corrected_scopeless_rejected`). An un-upgraded build
  decode-rejects board frames safely (`DECODE_ERROR` log; nothing mutates).
- **The clearable set is the SCOPE MAP, not the tool enum.** The 78-member
  `clear_board_reading` field enum is model guidance; `BOARD_CLEAR_SCOPE_MAP`
  (`stage6-dispatchers-board.js`) is the authority and the dispatcher fails
  CLOSED (`board_clear_scope_unclassified`, audible) outside it. The committed
  manifest `tests/fixtures/test-contracts/board-clear-scope-keys.json`
  (`{ze:global, pfc:global, manufacturer:board}`) is deep-equal drift-tested
  (field AND scope value) against all three route-map surfaces: the backend
  map, web `BOARD_CLEAR_ROUTE_MAP` (`web/src/lib/recording/board-clear.ts`),
  and iOS (`DeepgramRecordingViewModel` board-clear routing) via a
  byte-identical committed copy in CertMateUnified. Growing the set =
  follow-up plan `board-clear-scope-map-expansion` (backend + both clients +
  fixture in ONE delivery), never a partial ship.
- **Routing semantics.** `global` (`ze`, `pfc`): ONE value per job — the
  clear sweeps EVERY stored representation atomically (iOS: supply store +
  every `BoardInfo.ze`; web: both supply aliases short+long + every
  `boards[].ze` + retained `board_info` copy). `board` (`manufacturer`): the
  target resolves TRI-STATE (A2-multiboard) — canonical-main clears web's
  TWO legs (`board_info` + `boards[canonicalMainIndex]`) atomically but ONE
  leg on iOS (its `board_info` is a decode fallback folded into `boards[]`,
  not a store); a sub-board clears `boards[idx]` only; an explicit board id
  matching NO board FAILS CLOSED (never `boards.first`/index 0).
- **Capability + fence.** Clients advertise `board_clear_v1`; the server is
  deny-first and reads the capability LIVE from the active-sessions entry at
  DISPATCH (never a turn-start snapshot). A mid-session capability change is
  structurally impossible under the current wire (web `session_resume` never
  re-parses capabilities — pinned by test; an iOS build re-advertises its
  own static set on its process-private sessionId); the
  `stage6.capability_changed_on_reparse` telemetry is a zero-expected
  TRIPWIRE, not a handled path. Rollback = server `BOARD_CLEAR_DISABLED`
  (kill-switch), never un-advertising a shipped client.
