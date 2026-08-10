# Plan 03 — persistent ElevenLabs session and synthesis tuning

Status: **MEASURED 2026-08-10 — the whole plan is worth ≤ ~100 ms. §3 benchmark run (results below, ear test outstanding); §1–2 pooling now firmly TIER C and probably never.** Keep the two independently flagged, as the plan already requires, so their effects and rollbacks stay attributable.

## Measured 2026-08-10 — read this before doing any work here

`scripts/model-ab/tts-settings-bench.mjs` (added 2026-08-10) benchmarked the production
single-context frame sequence against the live vendor, 7 field-shaped confirmation lines,
`expandForTTS`-expanded, medians over 3–5 repeats per cell.

**Total ElevenLabs contribution to perceived latency is ≈ 215 ms**, split:

| Segment | Median | Owned by |
|---|---|---|
| WS handshake (DNS+TCP+TLS+upgrade) | **≈ 66 ms** | §1–2 pooling |
| BOS → first audio byte | **≈ 147 ms** | §3 tuning |
| → cold total to first audible byte | **≈ 215 ms** | |

Per-variant, one variable per arm, delta vs baseline on first-audio-byte:

| Variant | Δ vs baseline | Note |
|---|---|---|
| `normalization_off` | **−35 ms** | fastest — and the highest pronunciation risk |
| `pcm_16000` | −12 ms | not shippable alone; clients expect the negotiated rate |
| `style: 0` | −2 ms | noise |
| `use_speaker_boost: false` | −2 ms | noise |
| `auto_mode: true` | **+18 ms (WORSE)** | contradicts the vendor's framing of it as a latency lever |

### What this means

- **The best available tuning win is 35 ms, on the one arm most likely to mispronounce
  electrical values.** Against a dictate→read-back loop measured in seconds, that is noise.
  §3 is not where the latency is.
- **`auto_mode` is a regression here, not a lever.** The plan listed it first among the
  vendor's documented latency options; measured, it costs 18 ms. Do not adopt it, and do not
  let a future reviewer reinstate it on the strength of vendor documentation alone.
- **Pooling (§1–2) has a hard ceiling of ≈ 66 ms** and would cost a connection owner, a
  session-scoped pool, context routing, reconnect generations, capacity limits and
  cross-session isolation proofs — the largest and most concurrency-dangerous body of work in
  this plan, for the smallest measured prize in the wave. It stays TIER C. Revive it only if
  Plan 02's client-side numbers show handshake time is somehow much larger in the field than
  from a dev machine, and even then weigh it against Plan 08.
- Read this alongside the wave INDEX: it is direct evidence that the latency is upstream of
  the speech vendors, which is what Plan 08 exists to attack.

### Outstanding — the ear test (Derek)

Latency alone must not select a setting; the plan's own rule is that "a faster setting that
misreads electrical values fails". The bench emits 42 WAV clips, a **blind** listening sheet
(opaque `clip-NNN` labels) and a separate answer key. Given a 35 ms ceiling the honest
recommendation is **change nothing** — but the clips exist if you want to confirm
`normalization_off` by ear before it is closed for good.
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Dependencies: production activation after Plan 02 (real engineering order — reuses Plan 02's transport). No formal Plan 00 evidence-gate DONE required (2026-08-07, Derek: the gate was dropped for sole-user field testing); proceed once the informal Luna field test feels solid.

## Outcome

Remove repeated ElevenLabs WebSocket setup from the confirmation path by keeping a bounded multi-context connection alive for the active voice session. Separately benchmark low-latency synthesis settings and adopt only settings whose field audio remains clear and natural.

Connection reuse and voice-setting changes must be independently flagged so their effects and rollbacks remain attributable.

## Verified starting point

- `ElevenLabsStreamClient` supports both `stream-input` and `multi-stream-input` URLs.
- `synth()` creates a new `WebSocket` every time, including in multi-context mode, and closes it at `isFinal`.
- `streamConfirmationViaElevenLabs()` constructs a new client for each HTTP request. The current multi-context flag changes the endpoint and context ID but does not pool a socket.
- Defaults are Flash v2.5, PCM 22050, `style:0.3`, speaker boost on, speed 1.0 and text normalization on.
- ElevenLabs documents multi-context sockets for concurrent isolated contexts and identifies `auto_mode`, normalization and voice settings as latency/quality levers. Current official behaviour must be rechecked during RP execution.

## Scope

### 1. Persistent connection prototype

- Refactor the vendor client into a connection owner plus per-context synthesis handles.
- One live socket may carry multiple context IDs; route frames by context and close each context independently.
- Add open/ready state, reconnect generation, inactivity refresh, heartbeat if documented, and a hard connection lifetime.
- A socket failure must terminal every owned context exactly once and permit the next request to use legacy/new-connection fallback.
- Prove concurrency: interleaved frames for two contexts cannot cross voices, response bodies, callbacks, cost rows or correlation IDs.

### 2. Session-scoped pool

- Add a bounded pool keyed by authenticated active voice session and compatible synthesis configuration—not by text or user-controlled raw IDs alone.
- Tie lifecycle to server session start/resume/stop, WebSocket disconnect, TTL and ECS shutdown.
- Limit sessions, contexts per connection and queued synthesis to prevent file-descriptor/memory exhaustion.
- Reject or fall back deterministically when pool capacity is reached.
- Keep Loaded Barrel and ordinary confirmations from accidentally creating two owners for the same context.
- Do not put raw confirmation text in pool keys or logs.

Likely files:

- `src/extraction/elevenlabs-stream-client.js`
- a new `src/extraction/elevenlabs-session-pool.js`
- `src/routes/keys.js`
- `src/extraction/sonnet-stream.js` session lifecycle hooks
- `src/extraction/loaded-barrel-speculator.js` only if shared ownership is required
- focused unit/integration tests with a scripted WebSocket server

### 3. Tune one variable at a time

Create a repeatable benchmark using the real confirmation corpus, including circuit numbers, decimals, units, `R1 plus R2`, `live-to-live`, unusual designations and longer questions. Test independently:

- `auto_mode=true` versus current scheduling;
- text normalization on versus off after server `expandForTTS`;
- `style:0` versus 0.3;
- speaker boost off versus on;
- supported PCM sample rates/output formats;
- stability/similarity only if the earlier changes do not meet the target.

Record vendor first audio, full synth, bytes, pronunciation score and blind naturalness preference. Do not flip multiple settings in one cohort. A faster setting that misreads electrical values fails.

### 4. Observability and accounting

- Log connection generation, cold/warm socket, context count, queue delay, vendor first audio, final and terminal reason.
- Preserve exactly one started and one terminal cost attribution per synthesis across reconnect/fallback.
- Add pool gauges without session PII or spoken text.
- Join the existing playback ACK so backend improvements are distinguished from iOS buffering.

## Tests and acceptance

- cold open, warm reuse, two interleaved contexts, out-of-order frames and context close;
- vendor error for one context does not kill siblings unless the connection fails;
- connection failure terminals all owners once and reconnects on a new generation;
- request abort, client disconnect, session stop, TTL and process shutdown clean up;
- no cross-session audio or correlation leakage;
- bounded capacity/fallback under load;
- cost counters remain exactly once;
- existing Loaded Barrel dedupe and read-back suites remain green;
- warm connection reduces vendor-first-audio p50/p95 materially;
- selected setting passes an ear-verification sheet with zero numeric/unit pronunciation regressions.

Commands include the focused suites, full backend Jest, web tests when the route contract changes, and the field replay gate.

## Rollout and rollback

- Ship connection pooling dark behind a source-controlled env flag.
- Soak with internal synthetic calls, then one field session after Plan 02 is live.
- Enable setting experiments as separate flags/cohorts after pool reuse is measured.
- Roll back pooling and each setting independently; legacy single-shot ElevenLabs and native iOS fallback remain intact.
- Persist task-definition flags in source, update replay pins, `architecture.md`, `deployment.md`, `ios-pipeline.md` and `changelog.md`.

## Reviewer pressure points

- Is the object called “multi-context” actually reusing one socket?
- Can context IDs collide after reconnect or process/session reuse?
- Does an HTTP response outlive its owning context or receive another context's bytes?
- Can a pool retain active-session state after authentication/session termination?
- Are latency gains from connection reuse separated from iOS incremental playback and tuning changes?
