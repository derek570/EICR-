# Codebase research — focused-answer plumbing + Flux event handling

> Explore agent run 2026-05-24. Source repos: `EICR_Automation/` (backend) and
> `CertMateUnified/` (iOS). Verbatim agent output.

## 1. Flux event handling in iOS

Flux turn events are parsed in `DeepgramService.swift:861-1080` via
`handleJSON()` → `handleFluxEvent()`. The switch statement (line 997+)
implements:

- `StartOfTurn` (line 997→1008) — fires `didDetectSpeechStarted`
- `EndOfTurn` (line 1010→1066) — fires `didReceiveFinalTranscript`
  + `didReceiveUtteranceEnd`
- `EagerEndOfTurn` (line 1068→1072) — **logged only**
- `TurnResumed` (line 1074→1075) — **logged only**

Forward path: all final transcripts trigger
`delegate?.deepgramService(didReceiveFinalTranscript:...)` which
`DeepgramRecordingViewModel` consumes at line 1668.

**Verdict**: EagerEndOfTurn is currently dropped. The comment at
1069-1072 reads: *"V1 has eager mode disabled (no eager_eot_threshold in
the URL)"*. Wiring it through is trivial — the parse path already
exists, only the delegate forwarding is missing.

## 2. The "awaiting focused answer" state

iOS already maintains per-question state via the `InFlightQuestion`
struct (`DeepgramRecordingViewModel.swift:2489-2505`):

```swift
struct InFlightQuestion {
    let question: String
    let toolCallId: String
    let askedAt: Date
}
```

Set at line 2600 when TTS actually starts playing (via
`handleAlertTTSStarted()`). Also tracks `firedAskUserAnsweredToolCallIds:
Set<String>` (lines 2508-2509) to ensure idempotent 1:1 answer emission.
When a transcript arrives with a `toolCallId` in flight, lines
2039-2044 gate the substantive path:

```
!normalisedTrimmed.isEmpty && !firedAskUserAnsweredToolCallIds.contains(toolCallId)
```

**Verdict**: awaiting-focused-answer state already exists. The non-nil
`inFlightQuestion` + the Set membership test is the trigger surface this
sprint can hook into.

## 3. Keyterm generation — reactive or static

`KeywordBoostGenerator.swift:1-250` is **purely static per session**. The
`generate(from:)` method (line 36) takes board photo analysis and
produces keyterms once at session init. There is no reactive update to
ask_user context; the generator only merges:

- (a) config-based electrical vocabulary (`generateFromConfig`, lines 113-128)
- (b) board-specific terms from photo (lines 40-102) — manufacturer,
  OCPD types, SPD, switch type, circuit labels/numbers, RCD ratings

Call site: `DeepgramRecordingViewModel.startRecording()` →
`KeywordBoostGenerator.generate(boardAnalysis)` →
`DeepgramService.connect(keywords:)` (line 337).

**Verdict**: static throughout the session; no context-aware ask_user
keyword injection today. To inject ask_user question terms (digits,
yes/no), this sprint needs to either (a) call `updateKeywords()` (line
637) which currently forces reconnect, or (b) use Deepgram's `Configure`
mid-stream message to update keyterms without reconnect.

## 4. Dispatch path: final transcript → Sonnet

`EndOfTurn` fires `didReceiveFinalTranscript` →
`DeepgramRecordingViewModel.deepgramService(_:didReceiveFinalTranscript:...)`
(lines 1666-2175). The handler applies regex, builds a `utteranceId`
UUID, routes via Stage 6 ask_user path (lines 2039-2100) or legacy
path (lines 2130-2137).

Send order is atomic:

- line 2078: `serverWS.sendTranscript()`
- line 2090: `serverWS.sendAskUserAnswered()`

Both enqueued on the same serial queue
(`ServerWebSocketService.swift:410`). **No debounce/buffer between
final transcript and WS send.**

**Verdict**: direct path, no intermediate buffer; both messages queued
in order without delay. Latency budget is entirely Flux-side
(turn-detection wait), not iOS-side.

## 5. Loaded Barrel feature — turn context capability

Recent commits `81c5a6d` ("Loaded Barrel Phase 4a — iOS turnId + boardId
pass-through") and `acd34b9` (stage0 bench harness) show iOS already
passing `turnId` + `boardId` to backend:

- `RollingExtractionResult` gains `turnId` (decoded from `turn_id`)
- `ValueConfirmation` gains `boardId`
- `AlertManager.speakBriefConfirmation()` gains
  `loadedBarrelContext: LoadedBarrelTTSContext?` (turnId / boardId /
  field / circuit)
- Forwarded to `proxyElevenLabsTTS` in `APIClient`
- Plan v10 (`LOADED_BARREL_PLAN_FINAL.md:73-74`) uses
  `sha1(sessionId+turnId+boardId+field+circuit+expandedText)` as the
  cache key

**Verdict**: iOS already advertises turn-context (turnId, boardId,
field, circuit) capability to backend. If this sprint needs to add
"eager dispatch + retract" plumbing (Layer 2), the `turnId` channel
already exists as the cancellation handle.

## 6. Mid-stream config updates — reconnect-on-config-change

**(Codebase-only verdict; superseded by web research in
RESEARCH_APIS.md §6 — see correction below)**

The codebase agent reported: *"Deepgram Flux WebSocket does NOT support
mid-session eot_threshold changes. The entire URL is set at WebSocket
handshake; no JSON control messages exist. The only way to change
config is `updateKeywords()` (line 637), which forces a full
reconnect."*

This conclusion was drawn from inspecting the iOS code and finding only
the reconnect path. **It is incorrect.** Web research found Deepgram's
official docs at
[flux-on-the-fly-configuration](https://deepgram.com/learn/flux-on-the-fly-configuration)
documenting a `Configure` WebSocket message that updates
`eot_threshold`, `eot_timeout_ms`, and `keyterms` mid-stream without
reconnect. The mechanism just isn't used in our codebase today.

**Corrected verdict**: Flux supports mid-stream config via `Configure`
message. The iOS code needs a new send path (the only added capability
this sprint requires).

---

## Actionable summary

State of play, surface by surface:

| Surface | Today | What the sprint needs |
|---|---|---|
| Flux event handling | StartOfTurn + EndOfTurn forwarded; EagerEndOfTurn + TurnResumed logged only | Wire EagerEndOfTurn + TurnResumed through to delegate. Decide whether iOS dispatches on eager or waits for final. |
| Focused-answer state | `inFlightQuestion` non-nil during ask_user lifecycle (line 2600 → first answer) | Reuse as trigger. No new state needed. |
| Keyterm injection | Static per session | Send `Configure` with question-specific keyterms (digits, yes/no) on ask_user enter; restore on exit. |
| Dispatch path | Atomic, no buffer | Unchanged for now. (Layer 2 — speculative dispatch on eager — would add a retract path.) |
| Loaded Barrel turn context | turnId + boardId pass-through shipping | Reuse turnId as cancellation key if speculative dispatch is added. |
| Mid-stream config | Reconnect-only today; native `Configure` message available but unused | Add `sendConfigureMessage(eotThreshold:, eotTimeoutMs:, keyterms:)` to DeepgramService. |
