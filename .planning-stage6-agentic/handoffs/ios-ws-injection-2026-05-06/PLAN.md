# iOS WebSocket Injection Refactor + Chitchat View-Model Tests

**Author:** Claude (drafted 2026-05-06 after the post-impl code review of the chitchat-pause feature)
**Status:** Awaiting Derek's go-ahead
**Effort:** 1-2 sessions (~3-4 hours total)
**Depends on:** Nothing — self-contained refactor.
**Unblocks:** M3 deferred work — verifying `resumeFromChitchatPause()` actually fires `serverWS.sendChitchatResume()` and the 5-second watchdog re-shows the banner on no-ack.

---

## Goal

Make `ServerWebSocketService` injectable into `DeepgramRecordingViewModel` so its chitchat-pause behaviour (and other WS-dependent paths like Sonnet question dispatch) can be unit-tested without spinning up real network sockets.

Currently `serverWS` is constructed privately at the call site in `Sources/Recording/DeepgramRecordingViewModel.swift:195`:
```swift
private let serverWS = ServerWebSocketService()
```
This makes every WS interaction (`sendChitchatResume`, `sendTranscript`, `sendAskUserAnswered`, …) a fixed dependency — no test seam exists.

## Out of scope

- Refactoring other view models that don't use `ServerWebSocketService` (`AudioImportViewModel`, `JobListViewModel`, etc.).
- Replacing `ServerWebSocketService`'s URLSession usage; this is purely about extracting an interface, not changing transport.
- Mocking the WS for SwiftUI snapshot/UI tests — that's a separate concern.
- The watchdog timer's 5-second wall-clock wait. Plan introduces a clock seam so tests run without a literal 5-s sleep.

## Method surface to extract

`grep serverWS\\. Sources/Recording/DeepgramRecordingViewModel.swift` (2026-05-06 audit) returns these distinct calls:
| Call site | Method | Notes |
|-----------|--------|-------|
| `:715`    | `isConnected` (read-only property) | `Bool` |
| `:1016`   | `delegate` (property write)         | `weak var delegate: ServerWebSocketServiceDelegate?` |
| `:1035`   | `connect(serverURL:token:)`         |  |
| `:1155`   | `sendStop()`                        |  |
| `:1156`   | `disconnect()`                      |  |
| `:1880`   | `sendTranscript(text:regexResults:confirmationsEnabled:inResponseTo:utteranceId:)` |  |
| `:1892`   | `sendAskUserAnswered(toolCallId:userText:consumedUtteranceId:)` |  |
| `:2005`+  | `sendClientDiagnostic(category:payload:)` (3 sites) |  |
| `:4752`   | `sendJobStateUpdate(_:)`            |  |
| `:5705`   | `sendPause()`                       |  |
| `:5745`   | `sendResume()`                      |  |
| `:5849`   | `sendJobStateUpdate(_:)` (second site) |  |
| `:6232`   | `sendChitchatResume()` (slice 4)    |  |
| `:6256`   | `flushPendingMessages()`            |  |
| `:6266` + `:6299` | `sendSessionStart(sessionId:jobId:jobState:)` |  |

Plus one call from `RecordingSessionCoordinator.swift:107`:
```swift
var serverWS: ServerWebSocketService?
```
The coordinator's `serverWS` is settable from outside; updating its type to the protocol is part of the refactor.

**Total method surface: 14 methods + 2 properties.** Manageable.

## Phase 1 — Extract `ServerWebSocketServiceProtocol`

**Goal:** define the interface without changing any callers yet. New file, no behavioural change.

### File: `Sources/Services/ServerWebSocketServiceProtocol.swift` (NEW)

```swift
import Foundation

/// Test-seam interface for `ServerWebSocketService`. Lists the surface
/// `DeepgramRecordingViewModel` and `RecordingSessionCoordinator` actually
/// consume; production code uses the concrete service via this protocol so
/// tests can substitute a mock.
///
/// Protocol scope is deliberately narrow — adding methods to it should
/// require a same-PR usage in the view model, otherwise the surface drifts
/// from the actual call graph. If a new caller appears, audit the current
/// usage with `grep serverWS\\. Sources/Recording/*.swift` and update both
/// this protocol AND the test mock.
@MainActor
protocol ServerWebSocketServiceProtocol: AnyObject {
    var isConnected: Bool { get }
    var delegate: ServerWebSocketServiceDelegate? { get set }

    func connect(serverURL: URL, token: String)
    func disconnect()
    func flushPendingMessages()

    func sendSessionStart(sessionId: String, jobId: String, jobState: [String: Any])
    func sendStop()
    func sendPause()
    func sendResume()
    func sendChitchatResume()

    func sendTranscript(
        text: String,
        regexResults: [[String: Any]]?,
        confirmationsEnabled: Bool,
        inResponseTo: [String: Any]?,
        utteranceId: String?
    )
    func sendAskUserAnswered(toolCallId: String, userText: String, consumedUtteranceId: String?)
    func sendJobStateUpdate(_ jobState: [String: Any])
    func sendClientDiagnostic(category: String, payload: [String: Any])
}
```

### Conformance: `Sources/Services/ServerWebSocketService.swift`

Add the protocol declaration to the `final class` line:
```swift
final class ServerWebSocketService: NSObject, ServerWebSocketServiceProtocol, @unchecked Sendable { … }
```

Verify all listed methods already exist with matching signatures (most should — they're already public). The only nuance: `delegate` is currently declared as `weak var delegate: ServerWebSocketServiceDelegate?`; the protocol's getter/setter pair must allow `weak` storage. Use:
```swift
protocol ServerWebSocketServiceProtocol: AnyObject {
    var delegate: ServerWebSocketServiceDelegate? { get set }
    …
}
```
Concrete class storage stays `weak`. The protocol doesn't mandate weakness; the implementation enforces it.

### Verification

- `xcodebuild -scheme CertMateUnified -destination 'generic/platform=iOS Simulator' build` → BUILD SUCCEEDED with ZERO callers changed yet (refactor is additive).
- New protocol file added to `CertMateUnified.xcodeproj/project.pbxproj` (PBXBuildFile + PBXFileReference + group child + Sources phase entry — same 4-line edit pattern as the `ChitchatPauseBanner.swift` add).

### Commit

`refactor(ws): extract ServerWebSocketServiceProtocol — pure-additive interface`

---

## Phase 2 — Inject the protocol through `DeepgramRecordingViewModel.init`

**Goal:** allow tests to pass a mock; production behaviour unchanged.

### File: `Sources/Recording/DeepgramRecordingViewModel.swift`

**Change 1** (`:195`): replace the constructor-site instantiation with a stored property typed against the protocol.
```swift
// BEFORE
private let serverWS = ServerWebSocketService()

// AFTER
private let serverWS: ServerWebSocketServiceProtocol
```

**Change 2** (`:448-472`): extend the init to accept the WS service as the last parameter, with a default value so all current callers compile unchanged.
```swift
init(
    audioEngine: AudioEngineProtocol = AudioEngine(),
    deepgramService: DeepgramServiceProtocol = DeepgramService.shared,
    alertManager: AlertManagerProtocol? = nil,
    debugLogger: DebugLoggerProtocol = DebugLogger.shared,
    api: APIClientProtocol = APIClient.shared,
    networkMonitor: NetworkMonitorProtocol = NetworkMonitor.shared,
    serverWS: ServerWebSocketServiceProtocol = ServerWebSocketService()
) {
    self.audioEngine = audioEngine
    …
    self.serverWS = serverWS
    …
}
```

The `= ServerWebSocketService()` default keeps every existing instantiation in the production code identical (`JobDetailView.swift` constructs the view model with no arguments AFAICT — verify with grep).

### File: `Sources/Recording/RecordingSessionCoordinator.swift:107`

Update the property type from concrete to protocol:
```swift
// BEFORE
var serverWS: ServerWebSocketService?

// AFTER
var serverWS: ServerWebSocketServiceProtocol?
```

### Verification

- `grep -rn "DeepgramRecordingViewModel(" Sources/` finds every instantiation site. Audit each one to confirm:
  - No-arg construction → keeps working via default.
  - Argument-list construction → either explicitly passes a WS service or uses the default.
- `xcodebuild build` → BUILD SUCCEEDED.
- Manual smoke (build to simulator, briefly run): recording starts, no behavioural change. **No TestFlight required for this commit** — refactor is type-only.

### Commit

`refactor(ws): inject ServerWebSocketServiceProtocol into DeepgramRecordingViewModel`

---

## Phase 3 — Mock service + chitchat state-transition tests

**Goal:** ship the M3 deferred work — actual unit tests for the chitchat banner state machine on the iOS side.

### File: `Tests/CertMateUnifiedTests/Mocks/MockServerWebSocketService.swift` (NEW)

```swift
@testable import CertMateUnified
import Foundation

@MainActor
final class MockServerWebSocketService: ServerWebSocketServiceProtocol {
    weak var delegate: ServerWebSocketServiceDelegate?
    var isConnected: Bool = false

    // Outgoing-call captures. Each `send*` method records the args in a
    // dedicated array so tests can assert exact-call order + payload.
    var connectCalls: [(URL, String)] = []
    var disconnectCalls: Int = 0
    var flushPendingCalls: Int = 0
    var sessionStartCalls: [(sessionId: String, jobId: String, jobState: [String: Any])] = []
    var stopCalls: Int = 0
    var pauseCalls: Int = 0
    var resumeCalls: Int = 0
    var chitchatResumeCalls: Int = 0
    var transcriptCalls: [(String, [[String: Any]]?, Bool, [String: Any]?, String?)] = []
    var askUserAnsweredCalls: [(String, String, String?)] = []
    var jobStateUpdateCalls: [[String: Any]] = []
    var clientDiagnosticCalls: [(String, [String: Any])] = []

    func connect(serverURL: URL, token: String) { connectCalls.append((serverURL, token)) }
    func disconnect() { disconnectCalls += 1 }
    func flushPendingMessages() { flushPendingCalls += 1 }
    func sendSessionStart(sessionId: String, jobId: String, jobState: [String: Any]) {
        sessionStartCalls.append((sessionId, jobId, jobState))
    }
    func sendStop() { stopCalls += 1 }
    func sendPause() { pauseCalls += 1 }
    func sendResume() { resumeCalls += 1 }
    func sendChitchatResume() { chitchatResumeCalls += 1 }
    func sendTranscript(text: String, regexResults: [[String: Any]]?, confirmationsEnabled: Bool, inResponseTo: [String: Any]?, utteranceId: String?) {
        transcriptCalls.append((text, regexResults, confirmationsEnabled, inResponseTo, utteranceId))
    }
    func sendAskUserAnswered(toolCallId: String, userText: String, consumedUtteranceId: String?) {
        askUserAnsweredCalls.append((toolCallId, userText, consumedUtteranceId))
    }
    func sendJobStateUpdate(_ jobState: [String: Any]) {
        jobStateUpdateCalls.append(jobState)
    }
    func sendClientDiagnostic(category: String, payload: [String: Any]) {
        clientDiagnosticCalls.append((category, payload))
    }
}
```

### File: `Tests/CertMateUnifiedTests/Recording/DeepgramRecordingViewModelChitchatTests.swift` (NEW)

```swift
@testable import CertMateUnified
import XCTest

@MainActor
final class DeepgramRecordingViewModelChitchatTests: XCTestCase {
    var sut: DeepgramRecordingViewModel!
    var mockWS: MockServerWebSocketService!
    // … other mocks (audio, deepgram, alert, debug, api, network)

    override func setUp() {
        super.setUp()
        mockWS = MockServerWebSocketService()
        sut = DeepgramRecordingViewModel(
            audioEngine: MockAudioEngine(),
            deepgramService: MockDeepgramService(),
            alertManager: MockAlertManager(),
            debugLogger: MockDebugLogger(),
            api: MockAPIClient(),
            networkMonitor: MockNetworkMonitor(),
            serverWS: mockWS
        )
    }

    // MARK: serverDidEnter / serverDidExit flip the flag

    func testEnterChitchatPause_setsChitchatPausedTrue() async {
        XCTAssertFalse(sut.chitchatPaused)
        sut.serverDidEnterChitchatPause()
        await Task.yield() // let the @MainActor Task run
        XCTAssertTrue(sut.chitchatPaused)
    }

    func testExitChitchatPause_clearsChitchatPaused() async {
        sut.chitchatPaused = true
        sut.serverDidExitChitchatPause(reason: "wake_word")
        await Task.yield()
        XCTAssertFalse(sut.chitchatPaused)
    }

    // MARK: resumeFromChitchatPause hits the WS

    func testResumeFromChitchatPause_sendsChitchatResumeToWS() {
        sut.chitchatPaused = true
        sut.resumeFromChitchatPause()
        XCTAssertEqual(mockWS.chitchatResumeCalls, 1)
        XCTAssertFalse(sut.chitchatPaused) // optimistic local clear
    }

    func testResumeFromChitchatPause_doubleTapDoesNotDoubleSend() {
        sut.chitchatPaused = true
        sut.resumeFromChitchatPause()
        sut.chitchatPaused = true // simulate watchdog re-show
        sut.resumeFromChitchatPause()
        XCTAssertEqual(mockWS.chitchatResumeCalls, 2)
        // Each tap fires once; the SECOND tap's watchdog cancels
        // the FIRST tap's watchdog (avoid timer race).
    }

    // MARK: Watchdog re-shows the banner on no-ack

    func testWatchdog_reshowsBannerWhenNoAckArrives() async {
        // Plan section 5 introduces a clock seam — once it lands, this
        // test injects a fake clock and advances it 5 seconds:
        //
        //   sut.chitchatPaused = true
        //   sut.resumeFromChitchatPause()
        //   XCTAssertFalse(sut.chitchatPaused) // optimistic clear
        //   fakeClock.advance(by: .seconds(5))
        //   await Task.yield()
        //   XCTAssertTrue(sut.chitchatPaused) // watchdog re-showed
        //
        // Without the clock seam this test would need a real 5-s wait,
        // which is too slow for the unit-test gate.
    }

    func testAckBeforeWatchdog_doesNotReshow() async {
        // Same caveat — needs the clock seam. Once landed:
        //
        //   sut.chitchatPaused = true
        //   sut.resumeFromChitchatPause()
        //   sut.serverDidExitChitchatPause(reason: "manual")
        //   await Task.yield()
        //   fakeClock.advance(by: .seconds(5))
        //   await Task.yield()
        //   XCTAssertFalse(sut.chitchatPaused) // ack got there first; banner stays gone
    }
}
```

### Verification

- `xcodebuild test -scheme CertMateUnified -destination 'platform=iOS Simulator,name=iPhone 17 Pro'` runs the new tests.
- All tests pass.
- Existing iOS test suite still green.

### Commit

`test(chitchat): DeepgramRecordingViewModel state transitions + WS dispatch`

---

## Phase 4 — Watchdog clock seam

**Goal:** make the 5-second `chitchatResumeWatchdog` testable without real-time waits.

### Approach

Inject a `Clock` (Swift Clocks API, iOS 16+) into the view model. Production uses `ContinuousClock()`; tests use a custom advance-on-demand clock.

### File: `Sources/Recording/DeepgramRecordingViewModel.swift`

**Change 1** — add a stored property + init parameter:
```swift
private let clock: any Clock<Duration>
…
init(
    …
    clock: any Clock<Duration> = ContinuousClock()
) {
    …
    self.clock = clock
}
```

**Change 2** — replace `Task.sleep(nanoseconds: 5_000_000_000)` in `resumeFromChitchatPause()` with a clock-aware sleep:
```swift
chitchatResumeWatchdog = Task { @MainActor [weak self] in
    try? await self?.clock.sleep(for: .seconds(5))
    …
}
```

The optional-chained `clock.sleep` returns `Void` if `self` is nil; the surrounding `try?` swallows cancellation and other errors.

### File: `Tests/CertMateUnifiedTests/Mocks/FakeClock.swift` (NEW)

```swift
import Foundation

/// Hand-driven Swift Clock for tests. `advance(by:)` resumes any tasks
/// blocked on `sleep(for:)`; tests call `await Task.yield()` after to
/// drain the resumed continuations.
@MainActor
final class FakeClock: Clock {
    typealias Duration = Swift.Duration
    typealias Instant = ContinuousClock.Instant

    private(set) var now: Instant = .now
    private var pending: [(deadline: Instant, continuation: CheckedContinuation<Void, Error>)] = []

    var minimumResolution: Duration { .zero }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        if deadline <= now { return }
        try await withCheckedThrowingContinuation { cont in
            pending.append((deadline, cont))
        }
    }

    func advance(by duration: Duration) {
        now = now.advanced(by: duration)
        let due = pending.filter { $0.deadline <= now }
        pending.removeAll { $0.deadline <= now }
        due.forEach { $0.continuation.resume() }
    }
}
```

### Update tests in Phase 3 to use it

Replace the deferred-comment placeholders in the watchdog tests with real assertions using `FakeClock`. Each watchdog test:
1. Pause + resume.
2. Advance clock by 5 s.
3. `await Task.yield()` (multiple times if needed).
4. Assert `chitchatPaused` matches expectation.

### Verification

- All Phase 3 watchdog tests now pass deterministically.
- Production behaviour unchanged (default `ContinuousClock()` matches the prior `Task.sleep`).

### Commit

`refactor(chitchat): inject Clock to make 5s watchdog deterministically testable`

---

## Risk-honest assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Protocol declaration drifts from concrete class as `ServerWebSocketService` evolves | Medium (over months) | Inline comment on the protocol mandates a same-PR usage check. CI lint could enforce — out of scope here. |
| `delegate` property semantics differ between protocol and class (weak storage) | Low | Concrete class keeps `weak`; protocol is unconcerned. Tested via existing delegate cycle tests. |
| Hidden serverWS users in modules not covered by audit | Low | `grep -rn "ServerWebSocketService\\b" Sources/` found only 2 callers (DeepgramRecordingViewModel, RecordingSessionCoordinator). Audit doc complete. |
| Clock injection breaks existing async behaviour | Low | Default-arg keeps `ContinuousClock()`; production code is byte-identical to today. |
| `FakeClock` doesn't model the real `Clock` protocol perfectly (Swift Concurrency edge cases) | Medium | Limit FakeClock usage to chitchat watchdog tests only — don't claim it's a generic test utility. If needed elsewhere, harden it then. |

---

## Phase ordering rationale

P1 (extract protocol) is purely additive — zero callers changed. Cheapest possible scaffolding commit, ships independently and provides the type for any subsequent in-progress refactor to reference.

P2 (inject) flips the storage type but uses default args so production is unchanged. Ships independently.

P3 (mock + tests) is the tangible deliverable. Builds on P1+P2; can ship without P4 since the watchdog tests are deferred placeholders.

P4 (clock seam) closes the watchdog test gap. Independent of P3 — can ship later.

Each phase passes its own `xcodebuild build`/`test` and is independently reversible.

---

## Definition of done

1. Four commits on the iOS repo:
   - `refactor(ws): extract ServerWebSocketServiceProtocol`
   - `refactor(ws): inject ServerWebSocketServiceProtocol into DeepgramRecordingViewModel`
   - `test(chitchat): DeepgramRecordingViewModel state transitions + WS dispatch`
   - `refactor(chitchat): inject Clock to make 5s watchdog deterministically testable`
2. New files added to `CertMateUnified.xcodeproj/project.pbxproj` (4 entries each: PBXBuildFile + PBXFileReference + group child + Sources phase).
3. `xcodebuild test` runs the new chitchat unit tests + entire existing iOS suite green.
4. Manual smoke on simulator: recording session starts and behaves identically to today (no observable user-facing change).
5. TestFlight push optional — Derek's call. Behavior is unchanged from production today; only test infrastructure improves.

## Status

**Awaiting Derek's go-ahead to start.** Phase 1 can land on its own as a no-risk additive commit if you want to dip your toes in.
