# Plan G — iOS: the LIM keyboard-accessory button needs two taps to show

**Feedback id:** 99 · session `2D8E432D`
**Repos:** `CertMateUnified/` only
**Verification lane:** iOS unit/snapshot + device smoke (TestFlight)

---

## 1. Problem

Tapping **LIM** on the circuit keyboard accessory bar does not visibly populate the focused cell. A second tap (or moving focus away and back) is needed before the value appears.

LIM ("limitation") is a first-class reading value — a real, recordable outcome, not a placeholder. A control that appears not to work trains the inspector to tap twice, which risks double-writes on other accessory buttons and undermines confidence in the whole accessory bar.

## 2. Evidence

`CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:1067`:

```swift
Button("LIM") { writeFocusedCellValue("LIM") }
```

`…JobDetailView.swift:959–974` — `writeFocusedCellValue(_:)`:

```swift
private func writeFocusedCellValue(_ value: String) {
    guard let focused = focusedCircuitField,
          let idx = viewModel.job.circuits.firstIndex(where: { $0.localId == focused.circuitId })
    else { return }
    let previousRatingA = viewModel.job.circuits[idx].ocpdRatingA
    viewModel.job.circuits[idx].setSchemaField(focused.fieldKey, to: value)
    if focused.fieldKey == "ocpd_rating_a" {
        viewModel.job.circuits[idx].recalculateMaxZs(previousRatingA: previousRatingA)
    }
    viewModel.save()
}
```

The write to the **model** is unconditional and correct. The symptom is therefore a **display** problem, not a data problem: the value is stored, but the on-screen control does not re-read it.

### Leading hypothesis (must be confirmed in Phase 0, not assumed)

The focused cell in `CircuitsTab` is a `TextField` bound to a **local `@State` text buffer** rather than directly to the model. While the field holds focus, that buffer owns the displayed text and is not refreshed when the model changes underneath it. `writeFocusedCellValue` mutates the model; the buffer keeps showing the old text until focus changes and the buffer is re-seeded — which is exactly the "second tap / move away and back" behaviour.

This matches the standing debugging rule: **when a binding behaves oddly, the difference is in the value going in, not the rendering layer** — here, the displayed value is sourced from a stale buffer, so the model write is invisible.

Related surfaces to check for the same pattern (LIM appears as a quick-set on all of them):
- `CertMateUnified/Sources/Views/JobDetail/SupplyTab.swift:226, 239, 254` — `QuickSetButton(title: "LIM", binding: …)`
- `CertMateUnified/Sources/Views/Components/OutcomeButtonGroup.swift:19` — `.limitation`

## 3. Phase 0 — confirm the mechanism before fixing

Do **not** skip this. Instrument, then fix:

1. Locate the focused cell's `TextField` in `CircuitsTab.swift` and record exactly what it is bound to (model keypath vs local `@State`/`@FocusState`-scoped buffer).
2. Log the value at the assignment site: emit the model value and the displayed buffer value immediately after `writeFocusedCellValue` runs. If they differ, the hypothesis is confirmed.
3. Only then choose the fix. If the mechanism turns out to be different (e.g. the button steals focus and `focusedCircuitField` is already `nil` by the time the closure runs, so the `guard` returns early), the fix is different — and that alternative is worth checking explicitly, since a `guard`-return would also present as "nothing happened".

## 4. Fix (conditional on Phase 0)

**If stale local buffer (leading hypothesis):** after `writeFocusedCellValue` mutates the model, re-seed the focused cell's text buffer from the model — or bind the cell directly to the model keypath so there is one source of truth. Prefer the latter where it does not break per-keystroke behaviour; the accessory-bar path already deliberately bypasses `CircuitsTab`'s per-keystroke side effects (see the P3 comment at `:963–967`), so keep those side effects working.

**If early `guard` return on focus loss:** ensure the accessory bar does not take focus (`Button` in a keyboard accessory should not), or capture `focusedCircuitField` before the button's action runs.

Either way, keep the P3 rating→LIM transition intact: `recalculateMaxZs(previousRatingA:)` must still fire on `ocpd_rating_a`, so a stale auto-derived max-Zs cannot feed a false circuit result.

## 5. Files

| File | Change |
|---|---|
| `CertMateUnified/Sources/Views/JobDetail/CircuitsTab.swift` | cell binding / buffer re-seed (Phase 0 output) |
| `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:959–974` | possible focus capture or post-write refresh |
| `CertMateUnified/Sources/Views/JobDetail/SupplyTab.swift:226,239,254` | verify `QuickSetButton` does not share the defect |

## 6. Tests

- **iOS unit** — one call to `writeFocusedCellValue("LIM")` on a focused cell leaves both the model **and** the displayed value as `LIM`.
- **iOS unit** — the P3 `ocpd_rating_a` → LIM transition still clears the derived max-Zs (regression pin on existing behaviour).
- **iOS unit** — the other accessory buttons (N/A, prev, next, Done) are unaffected.
- **Device smoke** — tap LIM once on a circuit cell; the value appears immediately. Repeat on the Supply tab quick-sets.

## 7. Web companion

**None required.** Web has its own accessory bar (WS7, `circuit-keyboard-accessory.tsx`) with a **documented deliberate divergence**: web renders prev/next but **not** LIM/N/A (iOS renders those as dropdowns). Confirm during execution that the web bar has no equivalent staleness, and record a dated parity-ledger note either way. Owner: **Derek**.

## 8. Risks

- **Wrong mechanism.** Fixing a hypothesised cause without Phase 0 confirmation is exactly the failure mode the mistakes log warns about (5 TestFlight builds chasing a "SwiftUI flakiness" bug that was a `body: null` from the API). Phase 0 is mandatory.
- **Binding change side effects.** Binding the cell directly to the model could reintroduce per-keystroke side effects the accessory path deliberately bypasses. Verify the P3 comment's intent is preserved.
- **Shared TestFlight build with plan C.** Both are iOS; they touch different files, but sequence the build so both are in it.

## 9. Acceptance criteria

1. One tap on LIM populates the focused cell visibly and immediately.
2. The model value and displayed value never diverge after an accessory-bar write.
3. P3 rating→LIM derivation behaviour is unchanged.
4. Full iOS suite green; device smoke passes on iPhone.
