# Plan 05 — pre-synthesise `answer_user` while retaining the full Luna loop

Status: **DRAFT — not RP-reviewed**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
iOS repo: `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`
Dependencies: Plan 02 (real engineering order); Plan 03 recommended. No formal Plan 00 evidence-gate DONE required (2026-08-07, Derek: the gate was dropped for sole-user field testing); proceed once the informal Luna field test feels solid.

## Outcome

Overlap ElevenLabs synthesis of a successfully validated `answer_user` with Luna's remaining rounds, then play it only after the canonical full-loop result proves the same answer survived. This targets the TTS tail on conversational question turns without restoring the removed fast exit.

Luna still sees tool results, may continue reasoning, may inspect session state, and must reach its normal terminal. No answer is audible early.

## Verified starting point

- `createAnswerDispatcher()` validates, normalizes, truncates and leak-filters the first answer, then stages it in `perTurnWrites.answer.stagedText`.
- post-loop finalization may replace a failed attempt with fixed server fallback text.
- `bundleToolCallsIntoResult()` later projects the surviving text to `result.spoken_response`.
- `sonnet-stream.js` sends that through the existing exactly-once/reconnect-safe `voice_command_response` path.
- Loaded Barrel is designed for reading confirmations and must not be reused blindly for model-authored answers.

## Scope

### 1. Parked answer-synthesis owner

- After `answer_user` has passed all server validation and staging, invoke a dedicated callback with normalized text, session/turn/generation ID and no raw logging.
- Start one cancellable ElevenLabs synthesis and park its bytes/chunks under a cryptographically unguessable, short-lived prefetch ID.
- Do not send a client envelope or count it as heard at this point.
- Enforce one candidate per turn. A second `answer_user`, model retry, fallback or cancellation invalidates/finishes the owner deterministically.
- Keep answer prefetch storage separate from reading-confirmation caches and keys.

### 2. Canonical claim after full-loop finalization

- After all current finalization, bundling, mutual-exclusion and fallback nets, compare the canonical `result.spoken_response` with the parked normalized text byte-for-byte.
- Claim only when generation, session, utterance and text all match and no disqualifying ask/cancel/refusal replaced it.
- If they differ, abort/discard the candidate and synthesize the canonical answer normally.
- If they match, attach an optional versioned `tts_prefetch_id` to the existing `voice_command_response`; older clients ignore it and synthesize text normally.
- iOS claims the parked stream/audio through an authenticated endpoint, then feeds it into Plan 02's single FIFO/player. It must never play both prefetched and normal synthesis.
- Define expiry, one-time GET/claim, reconnect replay and idempotence. A replayed voice envelope must resolve to already-claimed/heard state or canonical text fallback, never duplicate audio.

### 3. Strict eligibility

Eligible only for a successful model-authored `answer_user` with voice answers enabled.

Exclude:

- reading confirmations, corrections and observations;
- `ask_user` questions;
- fixed fallback/apology text unless separately proven worthwhile;
- answer text that did not pass leak filtering;
- cancelled or superseded generations;
- mixed turns until tests prove answer and read-back ordering;
- any turn already owned by another speculative audio path.

### 4. Accounting and privacy

- Attribute ElevenLabs characters once whether the candidate is claimed, discarded, failed or falls back.
- Record prefetch start/first byte/final, canonical decision, claim/playback and waste reason without answer text.
- Cap bytes, items, TTL and per-session concurrent work.
- Abort vendor work as soon as a mismatch/supersession is known.

Likely backend files:

- `src/extraction/stage6-dispatchers-answer.js` (callback seam only; keep dispatcher transport-free)
- `src/extraction/stage6-shadow-harness.js`
- new answer-prefetch owner/cache module
- `src/extraction/sonnet-stream.js`
- authenticated claim route and tests

Likely iOS files:

- `Sources/Services/ServerWebSocketService.swift`
- `Sources/Services/APIClient.swift`
- `Sources/Recording/AlertManager.swift`
- capability declarations and focused tests

## Tests and gates

- candidate starts after normalization/leak filter, not from raw model arguments;
- full-loop exact match claims once;
- fallback, changed answer, cancellation, ask collision and generation replacement discard;
- reconnect before/after claim is idempotent;
- expired/missing/failed prefetch falls back to canonical text once;
- mixed reading+answer ordering is deterministic or remains ineligible;
- no interaction with reading Loaded Barrel keys/double-TTS dedupe;
- no raw model answer in logs/IDs;
- full answer-user, prompt-leak, wire/reconnect, TTS FIFO and field-replay suites pass.

Acceptance:

- full Luna rounds and terminal reason are unchanged versus control;
- no answer is audible before canonical finalization;
- zero double or wrong-answer playback;
- TTS tail is materially reduced on eligible question turns, with waste/cancel rate reported;
- if the saved tail is only marginal, keep the simpler canonical path.

## Rollout and rollback

- Backend support ships dark and backward compatible.
- TestFlight advertises a versioned prefetch capability only with Plan 02's player/fallback.
- Enable for session questions before general conversation. Keep mixed turns excluded initially.
- Kill switch returns all clients to canonical post-loop synthesis.
- Update wire/reference docs, iOS pipeline, architecture, deployment, changelog and parity ledger.

## Reviewer pressure points

- Can any candidate be claimed after a later Luna round semantically withdraws it?
- Is byte equality applied after all normalization/fallback layers?
- What happens when the claim request races reconnect replay or expiry?
- Can failed speculative synthesis consume the normal exactly-once key and silence the answer?
- Is the modest expected saving worth the new cache/wire surface?
