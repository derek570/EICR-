# Plan D — the read-back must speak the value that was stored

**Feedback id:** 100(b) · session `C06B9904` (post-`:344`, iOS build 421)
**Repos:** backend `src/` + `packages/shared-utils/` + `web/` + `CertMateUnified/`
**Severity:** SAFETY-CRITICAL — highest in the wave
**Verification lane:** unit + recorded fixture (backend) + device smoke (iOS/web)

---

## 1. Problem

Derek dictated a Ze reading. The assistant **spoke "Ze 16"**. The value **stored in the job was `1.6`**.

The inspector's only verification channel is his ear (Audio-First invariant #1: *hands-free, no eyes on the screen*). A read-back that speaks a different number from the one written to the certificate is worse than silence — it is an *actively false* confirmation of a measured electrical value that ends up on a signed BS 7671 document.

## 2. Evidence

The divergence is a client-side silent auto-correction that the server-side read-back never sees.

- `packages/shared-utils/src/circuit-derivations.ts:258` — `clampImpedance(field, value, earthing?)`. When a value falls outside the typical range it tries `÷10` then `÷100` and returns `{ kind: 'divided', original, corrected, divisor }`.
- iOS `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:5420–5490` — `clampedImpedance(...)`. Its own doc comment states the contract:
  > *"2. Out-of-range but exactly /10 or /100 lands in-range → return the divided value **silently**. Logged for analytics."*

  The `.divided` case emits an `impedance_auto_divided` debug event and returns `corrected` — **no TTS**. The neighbouring `.outOfRange` case, by contrast, *does* speak: `"I heard \(v) for \(displayName). Please check the value."`.
- Swift mirror: `CertMateUnified/Sources/Processing/CircuitDerivations.swift:236`.
- Web consumer: `web/src/lib/recording/apply-extraction.ts:876` — same `clampImpedance` from `packages/shared-utils/src/index.ts:39`. **The bug is cross-platform**, not iOS-only.
- **The clamp exists only on the clients.** `grep clampImpedance src/` returns nothing. The backend synthesises the spoken confirmation from the value the model emitted (`16`), then each client independently divides it to `1.6` before writing. Server state and client state diverge silently.

### Downstream consequence (links this plan to A/B)

The bogus `ze = 1.6` left in the job is precisely why Derek then said *"Delete Ze"* — which failed, because no board/supply-scope clear tool exists (feedback id 101, plans A and B). D removes the trigger; A/B fix the recovery.

## 3. Root cause

Two sources of truth for a written value:

1. the **server**, which synthesises the read-back text and holds session state, and
2. the **client**, which post-processes the value with a range clamp before persisting it.

Any client-side transformation of a value after the server has spoken it is unrepresentable in the read-back by construction.

## 4. Fix — primary approach: move the clamp server-side

Make the server the single source of truth for the written value, so the confirmation text is synthesised **from the clamped value**.

1. **Port `clampImpedance` into the backend** as a shared import from `@certmate/shared-utils` (the package is already a workspace dependency of `src/`). Do **not** re-implement — import the existing function so the three implementations cannot drift further.
2. **Apply it in the `record_reading` / `record_board_reading` dispatch path**, before the value enters `readings` and before the confirmation text is built. The `earthing` argument must come from the session snapshot's earthing arrangement (the same value the clients pass); resolve it once per dispatch.
3. **`divided` outcome ⇒ the read-back speaks the corrected value AND signals the correction.** Proposed wording (must be string-distinct from every existing apology/confirmation family — the clients apply a 30 s text-keyed dedupe):
   > *"Ze recorded as 1.6 — I corrected 16 to 1.6."*

   Rationale: the inspector hears both the stored value and the fact that an automatic correction happened, so a genuinely-16 reading (impossible for Ze, but the principle generalises) is immediately audible as wrong and can be re-dictated.
4. **`out_of_range` outcome ⇒ keep the existing behaviour** (do not write; ask). This path already speaks and is not part of the defect.
5. **Client clamps become idempotent no-ops.** Once the server clamps, the value the client receives is already in range, so `clampImpedance` returns `{ kind: 'ok' }`. **Leave the client clamps in place** as defence-in-depth for older backends and for the client-side regex fast-path (which writes before the server round-trip), but:
   - iOS: change the `.divided` case from silent to **spoken** — reuse the existing correction phrasing so a fast-path divide is audible too.
   - web: same change in `apply-extraction.ts:876`.

   This keeps the invariant true on *every* write path, not just the server-extraction one.

### Alternative considered (and rejected)

*Leave the clamp client-side and have the client speak a follow-up correction.* Rejected: the server has already spoken the wrong number by then, so the inspector hears two contradictory values in sequence; and it duplicates the correction logic in three places instead of collapsing it to one.

## 5. Backend-immutability escalation (REQUIRED before execution)

The hub rule makes `src/`, `config/prompts/`, and `packages/shared-*` **immutable during PWA-only work**, with iOS canon for the data contract. This plan deliberately changes backend behaviour and a shared package. That is allowed only under an **explicit cross-platform mandate**, because:

- the defect exists identically on iOS and web (same shared function),
- it cannot be fixed client-side alone without the server speaking a wrong value first, and
- the wire **shape** does not change — only the numeric value carried in an existing field, plus confirmation text.

**Action:** surface this to Derek and get an explicit go-ahead before executing plan D. Do not bundle it silently into a client fix.

## 6. Files

| File | Change |
|---|---|
| `packages/shared-utils/src/circuit-derivations.ts` | none expected (function reused as-is); confirm `ImpedanceField` covers every field the backend dispatches |
| `packages/shared-utils/src/index.ts` | none (already exported at `:39`) |
| `src/extraction/` — `record_reading` / `record_board_reading` dispatch + confirmation synthesis | apply clamp; carry `divided` metadata into the confirmation text |
| `src/extraction/stage6-event-bundler.js` | correction-aware confirmation wording |
| `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:5420–5490` | `.divided` → speak instead of silent |
| `web/src/lib/recording/apply-extraction.ts:876` | `.divided` → speak instead of silent |

## 7. Tests

- **Backend unit** — for each `ImpedanceField`: in-range value passes through byte-identical (no rounding — the existing contract at `circuit-derivations.ts:265` is explicit about this); `÷10` and `÷100` cases produce the corrected value in `readings` **and** the corrected number in the confirmation text; `out_of_range` still asks and does not write.
- **Backend unit** — earthing-dependent bounds resolve from the session snapshot, and a missing/unknown earthing falls back to the same default the clients use.
- **Recorded fixture** — this is a **backend-deterministic** fix (the model's output is frozen; only the backend's handling of it changes), so it *is* fixture-lockable. Author a fixture from session `C06B9904` asserting: written value `1.6`, spoken text containing `1.6`, and **no** spoken text containing a bare `16`.
- **iOS unit** — `.divided` produces a TTS call; `.ok` and `.outOfRange` behave as before.
- **web unit** — mirror of the iOS assertion in the apply-extraction suite.
- **Device smoke** — dictate an out-of-range Ze on iOS with AirPods in; confirm the spoken number matches the cell.

## 8. Web companion

**Ships in the same wave.** `web/src/lib/recording/apply-extraction.ts` gains the spoken-correction change alongside iOS. Parity-ledger row: `recording/impedance-clamp-readback` → `partial` until the iPhone/Safari device smoke passes, owner **Derek**.

## 9. Risks

- **Double correction.** If the server clamps and a client clamp then divides *again*, a value could be divided by 100 in total. Mitigation: the server-clamped value is in range by construction, so the client clamp returns `ok`. Pin this with a test that feeds a server-clamped value through the client clamp and asserts `ok`.
- **Rounding drift.** `formatCorrected` rounds to 2 dp and trims trailing zeros. In-range values are preserved exactly. Verify no existing fixture depends on an unrounded divided value.
- **Prompt-cache invalidation** — none; this plan does not touch `config/prompts/`.

## 10. Acceptance criteria

1. For every impedance field, the number spoken in the read-back equals the number stored in the job, on every write path (server extraction, client regex fast-path, both platforms).
2. An automatic `÷10`/`÷100` correction is **always** audible.
3. `out_of_range` behaviour is unchanged.
4. No wire-shape change; no client decoder change.
5. Full backend suite + web suite + iOS suite green.
