# Deviations from PLAN.md

Logged 2026-05-06 by Claude during execution. Cross-reference against
PLAN.md sections; everything else shipped as written.

## 1. Protocol is not `@MainActor`-isolated

**Plan said:** `@MainActor protocol ServerWebSocketServiceProtocol: AnyObject`
(PLAN.md §"Phase 1 — Extract `ServerWebSocketServiceProtocol`").

**Shipped:** plain `protocol ServerWebSocketServiceProtocol: AnyObject`.

**Why:** Conforming `ServerWebSocketService` to a `@MainActor` protocol
made Swift infer the conforming class's `init()` as main-actor isolated,
which broke the `serverWS: ServerWebSocketServiceProtocol = ServerWebSocketService()`
default-arg in `DeepgramRecordingViewModel.init`. Default arguments
evaluate in nonisolated context, so calling a main-actor-only
initialiser there is illegal.

The other peer protocols in `ServiceProtocols.swift` (`AudioEngineProtocol`,
`DeepgramServiceProtocol`, `NetworkMonitorProtocol`, etc.) are all
non-isolated for the same reason; only `AlertManagerProtocol` is
`@MainActor` and it sidesteps the issue with `alertManager: …? = nil`
+ `?? AlertManager.shared` in the init body.

Matching the more common pattern keeps the diff small and avoids the
optional-unwrap dance for what is conceptually a required dependency.
The view model that holds the property IS `@MainActor`, so call sites
need no `await` ceremony either way.

Documented in `ServerWebSocketServiceProtocol.swift` doc-comment.

## 2. Protocol surface gained `send(_:)` and `sendCompactRequest()`

**Plan said:** 14 methods + 2 properties (PLAN.md §"Method surface to
extract" table, audited from `DeepgramRecordingViewModel.swift` only).

**Shipped:** 16 methods + 2 properties — added `send(_:)` and
`sendCompactRequest()`.

**Why:** The audit missed callers in `RecordingSessionCoordinator.swift`:
`serverWS?.send([...])` at line 281 (barge-in `tts_cancelled_by_user`
event) and `serverWS?.sendCompactRequest()` at line 394 (sleep-entry
compaction). Phase 2 build failed without these. They already exist on
the concrete service; surfacing them on the protocol keeps the
"protocol = what the call graph actually consumes" invariant intact.

Documented in the protocol doc-comments.

## 3. Watchdog test race fix not in original plan

**Plan said:** call `fakeClock.advance(by: .seconds(5))` after
`resumeFromChitchatPause()`, then yield (PLAN.md §"Phase 4" deferred-
comment placeholders).

**Shipped:** yield FIRST (`await drainMainActor()`), THEN advance, THEN
yield again.

**Why:** `Task { @MainActor in ... }` enqueues the body — it does not
run inline. Without an initial yield, the watchdog body has not yet
called `clock.sleep(for: .seconds(5))`, so `FakeClock.pending` is empty
and `advance(by:)` is a no-op. The Task body would later run, register
its continuation, and hang forever waiting for an `advance` that never
comes. Test would fail or flake.

Caught in self-review after the initial commit; fixed before merge.

## 4. tearDown drains the clock

**Plan said:** "Existing iOS test suite still green" (PLAN.md §"Phase
3 — Verification") — no specific tearDown guidance.

**Shipped:** `tearDown` is `async`, yields 5×, advances clock by 60 s,
yields 10×, then niles fixtures. Without this, sync tests
(e.g. `testResumeFromChitchatPause_sendsChitchatResumeToWS`) leave a
suspended watchdog Task whose `CheckedContinuation` is dropped at
`fakeClock = nil`, triggering "leaked continuation" runtime warnings
and leaking the suspended Task across tests.

## 5. FakeClock does not propagate Task cancellation

**Documented in:** `FakeClock.swift` doc-comment.

A Task awaiting `FakeClock.sleep(...)` that gets cancelled stays parked
until `advance(by:)` reaches its deadline; cancellation does not throw
out of the suspended sleep the way it does on `ContinuousClock`. This
is acceptable for the chitchat watchdog because the watchdog body has
a post-sleep `if Task.isCancelled { return }` guard, but the FakeClock
contract should not be extended without first reworking
`sleep(until:tolerance:)` around `withTaskCancellationHandler`.

## Verification gap (not a deviation, but flagged)

Build: `xcodebuild build-for-testing` succeeded for both targets in
this environment.

Runtime: I could not actually run the test target. Three blockers, in
order of escalation:

1. CoreSimulator default device set lives at
   `~/Library/Developer/CoreSimulator/Devices` which is sandboxed
   "Operation not permitted" in this shell. `xcrun simctl create` in
   the default set fails with "stuck in creation state" because the
   underlying volume is `/Volumes/Ezekers/...`, mounted read-only-ish
   for sample-content copying (I see `Operation not permitted` in
   `~/Library/Logs/CoreSimulator/CoreSimulator.log` for every
   `Error copying sample content to path` entry).
2. Custom device sets via `simctl --set /tmp/...` can be created, but
   `xcodebuild` only discovers simulators in the default set — env
   vars like `SIMULATOR_DEVICESET_PATH` do not redirect its discovery.
3. `xcodebuild test-without-building` against an explicit
   `id=...` from a custom set hits the same discovery wall. Direct
   `xcrun simctl spawn xctest` fails because the
   `iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest`
   binary isn't installed (only the on-device variants exist).

Resolution path: from the dev Mac with normal sandboxing, run
`xcodebuild test -scheme CertMateUnified -destination 'platform=iOS
Simulator,name=iPhone 17 Pro' -only-testing
CertMateUnifiedTests/DeepgramRecordingViewModelChitchatTests` and
confirm green. The 6 active tests should each pass; the watchdog test
trace was reasoned through during self-review and matches the
production `resumeFromChitchatPause` body line-for-line.
