# CCU → Sonnet State Update Fix

**Date:** 2026-04-18
**Status:** Draft — ready to implement
**Author:** Derek + Claude

---

## 1. Problem statement

When the inspector is recording AND adds/edits circuits via the CCU (consumer unit) photo extraction flow, Sonnet's server-side `stateSnapshot` is NOT refreshed. Sonnet continues reasoning against the pre-CCU circuit list. Subsequent dictation of circuit readings fails to extract correctly because Sonnet thinks the circuit list is still the old one.

### Evidence (session 07:10–07:14 on 2026-04-18, job "29 Acacia Avenue")

- 07:10:01 — `session_start` with `stateSnapshot.circuits: 2`
- 07:13:19 — CCU extraction completes on iOS, `job.circuits.count = 11`
- 07:14:10 — backend CloudWatch still logs `[StateSnapshot] circuits: 2`
- Result: Sonnet cannot map "radial circuit 3" to any circuit it knows about → silent drop of extraction

### Root cause

`CCUExtractionViewModel.processPhoto(...)` and `CCUExtractionViewModel.confirmMatches(...)` mutate `viewModel.job.circuits` (the `JobViewModel`) but **never** notify `DeepgramRecordingViewModel` or its `ServerWebSocketService`. The existing message `job_state_update` is already wired on the backend (`src/extraction/sonnet-stream.js:350`) and called on iOS from `DeepgramRecordingViewModel.sendJobStateToServer()` — but only from these four call sites:

| Line | Trigger |
|------|---------|
| 768 | Initial session start |
| 3040 | Voice-created circuit ("add circuit 8") |
| 3731 | User manual resume |
| 4031 | WebSocket reconnect |

None of these fire after CCU extraction.

---

## 2. Design constraints

- Must NOT change the CCU HTTP flow — `CCUExtractionViewModel` does not (and should not) know about recording state.
- Must work whether or not a recording session is active (CCU can be used outside recording).
- Must handle the three `processPhoto` completion points: `circuitNamesOnly`, `fullCapture` (both apply immediately inside `JobViewModel`), and `hardwareUpdate` (applies later via `confirmMatches`).
- Must not introduce new singletons — `DeepgramRecordingViewModel` is already held on `JobDetailView`.
- Keep it idempotent — if Sonnet is mid-turn, backend's `updateJobState` call on the session must be safe (it already is; it just replaces the snapshot).

---

## 3. Proposed change

### Approach: callback closure injected into `CCUExtractionViewModel`

`CCUExtractionViewModel` gains an optional `onCircuitsApplied: (() -> Void)?` closure. When set, it is invoked at each point where `viewModel.job.circuits` is mutated via CCU:

| Method | Mutation point | Call site |
|--------|----------------|-----------|
| `processPhoto` | `.circuitNamesOnly` succeeds | after `logger.info("[CCU] Circuit names applied…")` |
| `processPhoto` | `.fullCapture` succeeds | after `logger.info("[CCU] Full capture applied…")` |
| `confirmMatches` | `.hardwareUpdate` applies | after `viewModel.applyHardwareUpdate(...)` |
| `resubmitPendingExtraction` | retried CCU succeeds | same three branches (already mirrors processPhoto) |

### Wiring

`JobDetailView` owns both `@State private var recordingVM = DeepgramRecordingViewModel()` (line 22) and `@State private var extractionVM = CCUExtractionViewModel()` (likely line similar). It sets:

```swift
.onAppear {
    extractionVM.onCircuitsApplied = { [weak recordingVM, viewModel] in
        guard let recordingVM else { return }
        // Only fire when a recording session is actually active.
        guard recordingVM.sessionId != nil else { return }
        recordingVM.notifyJobStateChanged(reason: "ccu_extraction")
    }
}
```

### New method on `DeepgramRecordingViewModel`

```swift
/// Public entry-point for non-recording views (e.g. CCU extraction, manual circuit edits
/// on CircuitsTab while recording is active) to refresh Sonnet's stateSnapshot.
/// No-op if no active session. Debounced to 250ms to coalesce burst edits.
@MainActor
func notifyJobStateChanged(reason: String) {
    guard sessionId != nil else { return }
    pendingStateUpdateReason = reason
    stateUpdateDebounceTask?.cancel()
    stateUpdateDebounceTask = Task { @MainActor in
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard !Task.isCancelled else { return }
        debugLogger.info(category: .session, event: "job_state_update_triggered",
                         data: ["reason": self.pendingStateUpdateReason ?? ""])
        self.sendJobStateToServer()
    }
}
```

The existing private `sendJobStateToServer()` stays private; the new public method is the single outward-facing entry point.

### Backend verification

No backend change needed. `sonnet-stream.js:350` already handles `job_state_update` by calling `activeSessions.get(currentSessionId).session.updateJobState(msg)`. We should **add one log line** so the next field session proves the fix end-to-end:

```js
// src/extraction/sonnet-stream.js, inside case 'job_state_update'
logger.info('StateSnapshot refreshed', {
    sessionId: currentSessionId,
    circuits: msg.jobState?.circuits?.length ?? 0,
    reason: msg.reason ?? 'unspecified',
});
```

---

## 4. Verification plan

1. **Unit**: `DeepgramRecordingViewModelTests` — stub `ServerWebSocketService`, call `notifyJobStateChanged`, assert one `sendJobStateUpdate` call within 500ms.
2. **Unit**: `CCUExtractionViewModelTests` — set `onCircuitsApplied` spy, run each completion path, assert closure fires exactly once per completion.
3. **Manual/field**: Start recording → add 2 circuits manually → open CCU photo → capture consumer unit → confirm matches → dictate a reading for a newly-added circuit. Check:
   - iOS debug log contains `job_state_update_triggered reason=ccu_extraction`
   - CloudWatch `[StateSnapshot] circuits: N` log line where N matches post-CCU count
   - Dictated reading lands on the correct circuit

---

## 5. Out of scope / deferred

- **Manual circuit edits on `CircuitsTab`** during recording have the same gap but different surface area (per-field debouncing). Worth a follow-up commit using the same `notifyJobStateChanged` entry point once this lands.
- **Observation/supply field edits** during recording — Sonnet's prompt doesn't currently reason against those fields' values, so lower priority.
- Full review of all `viewModel.job` mutators during recording to confirm no other silent gaps — tracked separately.

---

## 6. Risk / rollback

- **Risk**: Extra `job_state_update` payload (~2–10 KB for typical circuit list) sent per CCU extraction. Negligible bandwidth on cellular.
- **Risk**: Backend's `updateJobState` mid-turn — already safe per existing manual-resume code path which does exactly this.
- **Rollback**: Revert the callback wiring in `JobDetailView.onAppear` — reverts to current behaviour cleanly.

---

## 7. Files touched

| File | Change |
|------|--------|
| `CertMateUnified/Sources/ViewModels/CCUExtractionViewModel.swift` | Add `onCircuitsApplied: (() -> Void)?`, invoke at 4 completion points |
| `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` | Add public `notifyJobStateChanged(reason:)` with 250ms debounce |
| `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift` | Wire closure in `onAppear` |
| `EICR_App/src/extraction/sonnet-stream.js` | One-line log addition in `case 'job_state_update'` |
| Tests: `CCUExtractionViewModelTests.swift`, `DeepgramRecordingViewModelTests.swift` | New tests per §4 |
