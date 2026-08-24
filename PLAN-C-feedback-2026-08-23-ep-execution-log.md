# PLAN-C — `/ep` execution log

- **Run**: `20260824T111526Z-ep` (chain hop 5 of the `feedback-2026-08-23` wave)
- **Plan**: `~/.claude/handoffs/EICR_Automation--feedback-2026-08-23/PLAN-C-final.md`
- **Feedback id**: 129 — a dictated closed-enum value the schema does not offer was written verbatim
- **Repos**: `EICR_Automation` (branch `ep/PLAN-C-20260824T111526Z-ep`, 11 commits) + `CertMateUnified` (branch `ep/PLAN-C-ios-20260824T111526Z-ep`, 7 commits)
- **PRs**: EICR **#196**, CertMateUnified **#69**
- **Review**: **CODEX-CLEAN** after 5 cycles
- **Outcome**: SHIPPED

---

## The defect

Field session `17821FFA`. The inspector dictated a closed-enum circuit value that is not one of the schema's options. It was stored verbatim. Nothing objected, nothing was spoken, and the value reached a certificate where no dropdown, PDF renderer or iOS picker can display it.

The server-side dialogue engine has validated these six fields for months. The reason that validation never fired is the **client-local short-circuit**: when the local voice-command parser succeeds, both clients apply the value and speak, and **do not forward the transcript to Sonnet** (web `recording-context.tsx:1925` `return;`; iOS `DeepgramRecordingViewModel.swift:3441-3444` early-return). Everything downstream of that boundary — including the validation — is unreachable by construction. So this was never a gap in the validator; it was a whole ingress the validator does not sit on.

Six STRING-enum circuit fields are in scope: `wiring_type`, `ref_method`, `ocpd_bs_en`, `ocpd_type`, `rcd_bs_en`, `rcd_type`.

## What shipped

One shared guard — **canonicalise-or-ask** — at every client-local write boundary on both clients, driven by ONE canonical fixture.

**Shared (`packages/shared-utils/src/closed-enum-guard.ts`, 497 lines)**

- `GUARDED_CLOSED_ENUM_FIELDS` + `CLOSED_ENUM_OPTIONS`, mirroring `config/field_schema.json`.
- Canonicalisers for the dictation shapes that genuinely ARE the option — `"twin and earth"` → `T&E`, `"BS 88-2"` → `BS EN 60269-2`, `"reference method one hundred one"` → `101` — and a hard reject for everything else, which becomes a **spoken re-ask** rather than a silent bad write.
- `config/closed-enum-vectors.json` (886 lines) — the single canonical fixture. SHA-256 `ca9fdf6e5750eb2ee1f23df6d1fcc8db3f6dc539d0b41d180fb069fb4d5ab572` pinned in BOTH repos; `scripts/check-closed-enum-fixture-sync.sh` byte-compares them.

**Web** — guard at `applyVoiceCommand`; accepted values store and speak from the SAME canonical value (Audio-First §3); rejected values raise a distinct re-ask. Guard also at the regex instant-fill ingress. An accepted value whose write never landed no longer speaks success.

**iOS** — the same guard, the same fixture bytes, the same six fields, at the same boundary. Plus a tolerant per-field decode of `voice_command_response` params, and the `reference_method` setter alias closed (it reached `setCircuitField` without passing the guard — a complete bypass of the fix).

**Audio-First**: §1 accepted → one confirmation, rejected → one re-ask, never both and never neither. §2 a rejected value is *asked about*, never dropped. §3 stored and spoken are the same value.

## The one place this was nearly a silence bug

The regex-ingress guard is the interesting commit (`4cfc32eb`). The obvious implementation — when the guard rejects a regex value, don't record the key — would have been a **total-silence regression**, and the test suite would not have caught it.

`buildRegexSummary(tracker.consumeTurnWrites(), job)` builds the `regexResults` wire payload, and `gateRegexHit = regexResults.length > 0` (`recording-context.tsx:2065`) is what decides whether the transcript is forwarded to Sonnet at all. Dropping the key removes the evidence that anything was heard, so the gate closes, the transcript is never forwarded, and the inspector gets **nothing** — no write, no re-ask, no sound. The fix separates the two concerns that the single `Set` was conflating: `recordRegexHintOnly()` records **evidence without ownership**, so the gate still fires and the transcript still reaches Sonnet, while the tracker does not claim a write it suppressed. A paired `noteSuppressedRegexValue`/`isRepeatSuppressedRegexValue` stops a repeated identical suppression re-asking on every partial.

## Codex review — 5 cycles, CODEX-CLEAN

`gpt-5.6-sol` high, read-only, reviewing BOTH repo diffs together each cycle. Findings: **9 → 5 → 3 → 2 → 3**.

Cycles 1–3 produced real fixes: `a7c2547c` (an accepted value whose write never landed stopped speaking success), `020e916f` (a guarded apply target must be a real circuit; one NBSP vector), `4cfc32eb` (the gate/wire separation above).

**Cycles 4 and 5 each produced ZERO in-scope defects** against an unchanged diff — that is the convergence signal, and why the loop closed at 5 rather than burning the cap of 10. Every finding in those two cycles was verified individually and refuted:

- **C4-01** bulk-apply wording divergence — real, but `git show origin/main:…voice-commands.ts` proves the template predates this branch (the only diff hunk there is `value`→`spokenValue`), and iOS's line sits before the iOS branch's first hunk. Pre-existing on **every** bulk field → follow-up.
- **C4-02** `cleanValue` changing wire behaviour — mechanism confirmed, verdict refuted. iOS's `normaliseValue` never stripped the suffix and iOS always early-returned. **Web was the divergent client**; this change moves web ONTO iOS canon, which is the documented tiebreak.
- **C5-01** silent write when the server sends no `spoken_response` — reachable, but pre-existing and cross-cutting (it applies to every action type), and this diff strictly *narrows* it. The real cure is a general audibility net on the shared speak-seam → follow-up.
- **C5-02** `BS 88-3` → `BS EN 60269-2` — mechanism confirmed, but the backend has mapped it this way long enough that an existing test pins it (`src/__tests__/dialogue-engine-bs-code-parser.test.js:59`). Fixing the client alone would **create** the client/server split PLAN-C exists to close → decision-class follow-up.
- **C5-03** the `^100[123]$` fold is dead code — **disproved empirically**, see below.

### The comment that nearly cost a load-bearing branch

C5-03 is worth recording as a process finding, not just a disposition. A competent reviewer proposed deleting a branch of `parseClosedEnumRefMethod` on the belief that the word-map above already covered the phrase. It does not — the word-map only sees UN-normalised text, and the number normaliser runs first on both clients.

A probe against `web/src/lib/recording/number-normaliser.ts` settled it. The compound-hundreds rule only absorbs a following TEEN or TENS word, never a ONES word, which splits the two dictations:

```
"reference method one hundred and one"  →  "reference method 100 and 1"
"reference method one hundred one"      →  "reference method 1001"
```

Both are ordinary. Delete the fold and the second stops being a valid reading and starts drawing a re-ask — the exact Audio-First §2 silent-refusal this guard exists to prevent.

**The reviewer reasoned correctly from a wrong comment.** The old comment said the two forms arrive as either shape "depending on which collapse fires first" — vague, and wrong about the cause. Commit `427a1f95` replaces it with the measured behaviour, names the file it was measured against, states why the branch is load-bearing, records that a reviewer already tried to remove it, and adds an end-to-end test driving the REAL chain (`normalise → parseVoiceCommand → applyVoiceCommand`) for both hundred-forms plus bare `100`. The unit fixture pinned the guard in isolation; nothing pinned *why `1001` reaches the guard at all*, which is precisely the half that was misunderstood.

## Gates

| Gate | Result |
|---|---|
| Backend Jest | 9358 passed / 372 suites |
| Web vitest | 2076 passed / 1 skipped / 167 files |
| Field-replay strict gate (pre-push) | green — 12/12 recorded fixtures |
| Cross-repo fixture byte-compare | green |
| CI — Test Backend / Test Frontend / npm Audit | pass |

## Follow-ups

**Decision-class → `ep-digest.md`** (one push notification sent):

1. Two closed-enum options the schema does not offer, now *audible* for the first time because the guard refuses them. (a) `ref_method` granular codes — iOS's picker offers `A1/A2/B1/B2/D1/D2`, `field_schema.json` does not, so a value you can TAP cannot be DICTATED. (b) `ocpd_bs_en` has no `BS EN 60269-3`, so "BS 88-3" is quietly recorded as a **different device standard** on all three surfaces. Both need widen-or-refuse across backend + web dropdown + PDF + iOS picker; neither is fixable client-side.

**Agent-actionable → `todos-certmate.md`**:

2. Hub `CLAUDE.md` char budget exhausted (**44998/45000**) — prune the oldest changelog rows into `changelog.md` before the next wave needs a row. Never raise the budget.
3. Four cross-client circuit-field parity gaps (iOS canon in all four): the failing-and-unwired `check:ios-parity`; the canonical `_ohm`/`_mm2`/`_a` alias union web resolves and iOS does not; range-scope divergence at `voice-commands.ts:1188-1204`; and the C4-01 bulk wording split.
4. Three pre-existing spoken-channel losses on paths this diff did not touch — web's preemptive `speak()` flushing queued confirmations; iOS's `speakBriefConfirmation` DROPPING while awaiting a response *after* registering the fingerprint; and an `action` with an empty `spoken_response` writing with no read-back on both clients. One cure covers all three.
5. A turn carrying both an address-mirror delivery token and a guarded circuit action swallows the re-ask (`sonnet-stream.js:1404` merges two terminals into one string) — **nothing is written but a false success is spoken.** Server-side cure.
