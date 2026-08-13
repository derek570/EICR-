# PLAN-E execution log — installation address ingestion + postcode mapping (feedback id 125)

- **Session ID:** `20260812T213215Z-ep`
- **Branch (backend + web, EICR_Automation):** `ep/PLAN-E-20260812T213215Z-ep`
- **Branch (iOS, CertMateUnified):** `ep/PLAN-E-installation-e2-20260812T213215Z-ep`
- **Chain:** hop 2 of the feedback-2026-08-11 wave (`--chain --chain-hop=2`)

## Step-by-step

### E1 — installation address ingestion into the snapshot
- Status: applied
- Decision: implemented exactly as specified — `selectInstallationContainer`/`normaliseInstallationIngest` mirror `selectSupplyContainer`'s pattern; SEED writes all 8 keys unconditionally, MID-SESSION MERGE is fill-empty-only via FACT_FIELDS exclusion; `_seedStateFromJobState`'s whole-function `jobState.circuits` gate removed, circuit loop individually guarded; `job-state-frame.js`'s `JOB_STATE_FIELDS` gains the three bucket spellings.
- Files: `src/extraction/eicr-extraction-session.js`, `src/extraction/job-state-frame.js`
- Commit: `3419e437`

### E2 — iOS + web client payload completeness
- Status: applied
- Decision: iOS `buildJobStateForServer` gains the missing site postcode/town/county keys. Web: preflight search located the real jobState producer (`recording-context.tsx`, NOT `job-context.tsx`, matching the plan's explicit correction); new `installation-wire-shape.ts` normalises `installation_details`'s four `client_*` snake_case keys to the frozen camelCase wire shape at both send sites (`session_start`, `job_state_update`); site keys pass through unrenamed.
- Files: `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`, `web/src/lib/recording-context.tsx`, `web/src/lib/recording/installation-wire-shape.ts` (new)
- Commits: `f105956c` (web), iOS commit `d61061e` on the CertMateUnified worktree branch

### E3 — tighten postcode_lookup.js mapping
- Status: applied
- Decision: town ← `parish || admin_district` (never `admin_ward`); county ← `admin_county` only, blank on null; `region` never read.
- Files: `src/postcode_lookup.js`
- Commit: `3b5579f5`

### E4 — audible locality fold into postcode confirmation
- Status: applied
- Decision: both egress seams (live bundler via a new `stateSnapshot` option threaded from `runLiveMode`; legacy path via new exported `foldLocalityIntoLegacyConfirmations`) fold the effective post-apply snapshot town/county into the existing postcode confirmation.
- Files: `src/extraction/stage6-event-bundler.js`, `src/extraction/stage6-shadow-harness.js`, `src/extraction/eicr-extraction-session.js`
- Commit: `3b5579f5`

### E5 — direct-mirror grammar widening
- Status: skipped (per plan — explicitly dropped from this wave's scope)
- Decision: filed as a repo todo in `todos-certmate.md` per the plan's own instruction, rather than coded.

### Tests
- Status: applied
- Decision: 66 new tests across 6 files (backend: E1/mirror-provenance 25, E3 mapping 8, E4 both egress seams 21, applier regression 3; web: E2 contract 7; iOS: E2 wire-shape 2).
- Files: `src/__tests__/eicr-extraction-session.plan-e-installation-ingest.test.js`, `src/__tests__/postcode-lookup.plan-e-mapping.test.js`, `src/__tests__/stage6-postcode-locality-confirmation.plan-e.test.js`, `src/__tests__/postcode-snapshot-applier.test.js` (extended), `web/tests/installation-wire-shape.test.ts`, `CertMateUnified/Tests/CertMateUnifiedTests/Recording/A2MultiboardCompanionTests.swift` (extended)
- Commit: `4231e0b0` (backend/web), iOS tests bundled in `d61061e`

### Docs
- Status: applied
- Decision: updated `certmate-voice-wire-protocol/SKILL.md` (new job_state_update table row for the installation bucket), `docs/reference/architecture.md` (full paragraph on the seeding gap + mapping fix + the reverted drift-clear deviation), `docs/reference/changelog.md` (full commit-body entry), hub `CLAUDE.md` (one-line row — dropped the oldest row to stay under the 45000-char budget, since the file was already 43 chars over on `main` before this row from a sibling PLAN-A merge).
- Files: `.claude/skills/certmate-voice-wire-protocol/SKILL.md`, `docs/reference/architecture.md`, `docs/reference/changelog.md`, `CLAUDE.md`
- Commit: `12c96b5b`

## Codex diff review

Ran with the default model (`gpt-5.6-luna`) for most probing calls after `gpt-5.6-sol` returned
persistent `Rate Limit Exceeded` errors across ~2.5 hours of waits (20/30/30/50 min, escalating per
protocol); root-caused as an `additionalProperties` JSON-Schema-strict-mode requirement my outputSchema
was missing — NOT a genuine quota exhaustion (a trivial ping and small combined-file calls without the
schema succeeded throughout). Once the schema carried `additionalProperties: false` on every object,
`gpt-5.6-sol` itself worked normally and was used for the substantive review calls.

**Cycle 1 (3-lens parallel — wire-contract faithfulness, silent-path hunt, edge interactions):**
- Wire-contract faithfulness: 2 findings, both **WITHDRAWN** by the reviewer on re-challenge with the
  exact plan text (bucket-key-rename misreading; snake_case-field-tolerance misreading — see below).
- Silent-path hunt: 7 findings.
  - **APPLIED (BLOCKER):** same-turn dictated town/county alongside a postcode write spoke the locality
    twice. Fixed on both egress seams.
  - **APPLIED (BLOCKER, later reverted in cycle 3):** stored drift county could never be cleared by a
    blank lookup. Applied, refined in a mini-review, narrowed in cycle 2, then FULLY REVERTED in cycle 3
    — see below.
  - Duplicate of the withdrawn wire-contract finding (client_* snake_case tolerance) — not applied.
  - Recovery-path `stateSnapshot` threading claim — investigated directly against source
    (`sonnet-stream.js:518,3026,5180,5738`); all three additional `bundleToolCallsIntoResult` call sites
    are address-mirror recovery paths dealing exclusively with `derived:true` writes (confirmations
    always suppressed by design) or `confirmationsEnabled:false` — not applied, finding was incorrect.
  - `client_postcode` dedupe-token gap: **OUT_OF_SCOPE, Codex verdict WITHIN_INTENT** (quoted Audio-First
    exactly-once invariant from the context file) — deliberately NOT applied. Requires synchronized
    3-repo edits (backend + web + iOS mirrors + their drift/parity tests); judged too large and risky to
    verify safely within this run's remaining budget. Filed to `todos-certmate.md` instead of shipped.
  - Test-completeness + changelog test-count arithmetic error: applied — corrected the count.
  - E5-todo-not-actually-filed: applied — filed the todo.
- Edge interactions: 2 findings.
  - `start()` re-running on reconnect with a stale snapshot — investigated directly against source
    (`sonnet-stream.js:4103-4123`); the reconnect branch returns BEFORE `session.start()` is ever
    reached (a fresh session object only calls `.start()` when genuinely new). **Incorrect, not applied.**
  - The drift-clear-to-blank finding (same as above).

**Per-fix mini-review** (cheap focused pass on just the cycle-1 fix hunks): found the double-speech fix
suppressed the WHOLE locality tail when EITHER town or county had its own confirmation (silencing an
unrelated derived sibling), and treated field presence as proof a sibling would speak (an empty-valued
sibling produces no confirmation at all). Both fixed: `resolveEffectiveLocalityTail` now accepts
`skipTown`/`skipCounty` so each component is excluded independently, gated on the sibling actually
carrying a non-empty value/text.

**Cycle 2** (single-pass verification): found the blank-drift-clear fix was applied symmetrically to
town, but `UK_REGION_DRIFT` contains values that can also be real town names ("london") — clearing town
to blank risked erasing a correct manually-set town. Scoped down to county-only.

**Cycle 3** (final convergence sweep): found the county-only blank-drift-clear was STILL unsafe —
`_mergeIncomingJobStateIntoSnapshot`'s fill-empty-only merge means a client whose own cache still shows
the pre-clear value structurally guarantees resurrecting it on its very next `job_state_update` push
(verified directly against source via a dedicated Explore sub-agent, both the backend merge path and
web's `apply-extraction.ts` gate — not a rare reconnect race, but a guaranteed same-session
resurrection). Also recognised this capability exceeded the plan's own explicit non-goal ("no
retroactive repair of already-written drift values… Derek corrects by voice"). **Fully reverted** —
`applyPostcodeLookupToSnapshot` is back to its exact pre-Plan-E form for both fields.

**Cycle 4** (final convergence check + full 3-dimension sweep): clean. 0 findings.

**Verdict: ALL PASSED.** No sanctioned plan deviations shipped (the one WITHIN_INTENT candidate —
client_postcode's dedupe-token gap — was deliberately deferred rather than applied, given its
cross-repo scope).

## Plan deviations
None shipped. One candidate (client_postcode dedupe-token widening, Codex-verified WITHIN_INTENT)
was deliberately NOT applied — see Codex diff review section above and the follow-up entry below.

## Assumed decisions
None — the plan's ambiguities were all resolved during `/rp` refinement before this run began (5
rounds, both reviewers clean at round 5).

## Skipped / blocked / failed steps
- E5 (direct-mirror grammar widening) — skipped per the plan's own explicit instruction, filed as a
  todo instead of coded.

## Stashes left behind
None.

## Tests run + result
- Backend Jest: 8567 passed, 19 skipped (pre-existing, unrelated), 0 failed.
- Web vitest: 1646 passed, 1 skipped (pre-existing, unrelated), 0 failed.
- Field-replay corpus (strict prepush gate): 9/9 fixtures pass, 0 unsupported_pending, 0 failed.
- iOS (`A2MultiboardCompanionTests`, iPhone 17 Pro simulator): 19/19 passed.
- Hub-size guard (`check-hub-size.mjs`): OK, 44996/45000 chars.
- Semantic-oracle digest: regenerated 5 times across the review cycles (each fix edited an enumerated
  oracle input, and the pre-commit lint-staged hook reformatted files after each digest computation at
  least twice) — final state verified green.

## Follow-ups noticed

- `[FOLLOWUP]` **Widen the direct-mirror grammar (E5)** — `address-mirror-controller.js:256`, the
  fully-anchored `SITE_TO_CLIENT`/`CLIENT_TO_SITE` regex rejects natural phrasing like "Can you use the
  installation address for the client address too?"; E1 makes the model path answer it anyway, so this
  is latency/cost sugar. Filed to `todos-certmate.md`.
- `[FOLLOWUP]` **`client_postcode` confirmations have no dedupe-token operation identity** — pre-existing
  gap (predates PLAN-E), `WITHIN_INTENT` per Codex's own verdict but deliberately deferred given the
  3-repo synchronized-edit scope. Filed to `todos-certmate.md`.
- `[FOLLOWUP]` **Loaded-barrel speculator's postcode pre-synth lacks the E4 locality tail** — will
  barrel-cache-MISS on most postcode turns (a doubled read-back, not silent). Out of E4's two named
  egress seams. Filed to `todos-certmate.md`.
- `[FOLLOWUP]` **A blank-value drift-clear for postcode county was tried and reverted (see Codex diff
  review above)** — if Derek wants stored drift values proactively cleared rather than corrected by
  voice, it needs a DIFFERENT mechanism (e.g. a client-side apply-gate change so an incoming empty
  derived clear is accepted, or a one-off backend migration) — not a silent snapshot-only clear under
  the current fill-empty-only client-authoritative merge contract. Filed to `todos-certmate.md`.

Follow-ups noticed: 4 (capped at 5 per protocol; all 4 filed to `todos-certmate.md`, none required the
decision-class `ep-digest` — all are agent-actionable).

## Completed 2026-08-13T02:20:00Z

**Outcome: ALL PASSED.**
