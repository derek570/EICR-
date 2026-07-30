# /ep execution log — PLAN-2A-partial-failure-notices

- **Plan:** `~/.claude/handoffs/EICR_Automation--feedback-2026-07-27/PLAN-2A-partial-failure-notices.md`
- **Authority for pointers:** `PLAN-2-final.md` §0/§3.1/§4/§5/§7 + `PLAN-2-ep-execution-log.md` Step 4 + its first `[FOLLOWUP]`
- **Session:** `20260730T095739Z-ep`
- **Repo:** `/Users/derekbeckley/Developer/EICR_Automation`
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260730T095739Z-ep`
- **Branch:** `ep/PLAN-2A-partial-failure-notices-20260730T095739Z-ep` (base `main` @ `913ec5ca`, post-#133)
- **Chain:** single-shot. PLAN-2A carries no `.ep-queue` marker and `--chain` was not passed; independently, the plan orders PLAN-3 AFTER 2B/2C/2D, so auto-chaining `PLAN-3-final.md.ep-queue` would violate dependency order.
- **Scope:** §3.1 ONLY (partial-failure notice machinery). §3.3-code (PLAN-2B), §3.5 (2C), §3.6 (2D) are explicitly out.

## Session hygiene

`~/.claude/scripts/ep-reap.sh sweep` → `ep-reap: reaped=0 held=0 working=1` (no HELD sessions, no orphaned claims).

## Read-first

| Input | Status |
|---|---|
| `PLAN-2A-partial-failure-notices.md` | read (37-line scope wrapper) |
| `PLAN-2-final.md` §0 / §3.1 / §3.7 / §5 / §6 / §7 | read |
| `PLAN-2-conversation-context.md` | read |
| `PLAN-2-refine-log.md` | read — "Skipped (ambiguous fix)" = **none** in both rounds ⇒ no rule-3 soft spots |
| `PLAN-2-ep-execution-log.md` Step 4 + `[FOLLOWUP]` | read (the file:line authority) |

Plan-size check: 5 build items, ONE feature group (the notice machinery), one subsystem ⇒ no split trigger.

## Pre-implementation source verification

Every plan pointer independently confirmed against source before any edit (line numbers as-found; several differ from the plan's prose and the plan's are noted where they drift):

| Claim | Verified at |
|---|---|
| `allRejected` block-scoped, must be hoisted | `stage6-shadow-harness.js:2398` (expression), hoist site `:866-880` |
| coverage helpers read `mandatoryNotices` only | `:2434-2443` (`stampCoveredNoticesNonDraining`), `:2446-2463` (`coveredUnion`) |
| plan-B net-0 drain block boundaries | `:2949`–`:3086` (`catch (mandatoryErr)`); F7 net comment `:3088`; marker-② `:3173`, `survivingPromptCount` `:3216` |
| channel 1 rejection site | `stage6-dispatchers-circuit.js:253-269`; error shape `{code:'circuit_not_found', field:'circuit'}` from `stage6-dispatch-validation.js:163-166` |
| channel 6a direct LIM skip | `stage6-dispatchers-circuit.js:226-251` (plan said `:215-249`) |
| channel 6b low-conf skip | `:324-346` (plan said `:324-344`) |
| channel 6c bulk LIM skip | `:1866-1886` (plan said `:1862-1884` / `:1842+`) |
| bulk gate is PRE-iteration | gate `:1866` precedes `requestedExcludes` `:1922`, `snapshot` `:1943`, `iterationPlan` `:1944-1950`, apply loop `:1952-2023` |
| `!bucket` before excludes | `if (!bucket) continue;` `:1957`; `if (requestedExcludes.has(ref)) continue;` `:1963` |
| `createAskDispatcher` has no `perTurnWrites` | `stage6-dispatcher-ask.js:170-221` (opts = fallbackToLegacy, autoResolveWrite, onAskUserStarted, onAskAnswered, onAskRegistered, signal, generationId, responseEpochRef) |
| channel 3 exists in TWO branches | enum auto-resolve `:1070-1132`, value auto-resolve `:1169-1224` (plan cites only the latter) |
| survivor-test primitives | `stage6-per-turn-writes.js` `projectReadingWinners` `:477`, `EFFECTIVE_CIRCUIT_SLOT` `:107`, accumulator factory `mandatoryNotices: []` `:626` |
| canonical field identity | `canonicaliseNumericReadingField` (`value-enum-validator.js:150-204`), `FIELD_CORRECTIONS` (`field-name-corrections.js:37-125`), `CLEAR_WIRE_EXEMPT = {r2_ohm}` (`stage6-event-bundler.js:64-91`) |
| no import cycle | `refusal-notices.js` header declares dependency-downstream-only; `value-enum-validator.js` imports 1 module, `field-name-corrections.js` imports 0 |
| trusted-label precedent | `stage6-dispatchers-circuit.js:579-628` (`unsupported_clear` — label ONLY from `FIELD_SCHEMA.circuit_fields[f].label`, integer-circuit + board-ordinal trust guards, stage NOTHING when untrusted) |

## Steps

_(appended as work proceeds)_

### Step 1 — the partial-failure notice class (§3.1 build item 1)

- **Status:** DONE
- **Decision:** built as a THIRD regime alongside plan-A1a's DIRECT route and plan-B's B-STAGED route, sharing `refusal-notices.js` but with its own accumulator, its own counter store and its own rotation rule. Reusing plan-B's per-slot `session.refusedOps` was rejected: its counter is keyed on a REFUSAL slot (an operation the model asked for and was denied), whereas a partial-failure identity is a RENDERED-TEXT identity (what the inspector will actually hear), and those two are not the same key — folding them would make one regime's repeat advance the other's ordinal.
- **Files:** `src/extraction/refusal-notices.js` (+`PARTIAL_FAILURE_FAMILIES`, `PARTIAL_FAILURE_TERMINALS`, `PARTIAL_FAILURE_SCOPE_FAMILIES`, `describePartialFailureTargets`, `bumpPartialFailureRepeat`, `selectPartialFailureNoticeText`, `renderPartialFailureNoticeText`, `partialFailureTextIdentity`, `canonicalPartialFailureFieldIdentity`, `resolvePartialFailureFieldLabel`, `stagePartialFailureNotice`); `src/extraction/stage6-per-turn-writes.js` (+`partialFailureNotices: []`).
- **Commit:** `a728c9ab`
- **Notes:** the module's dependency-downstream-only contract is preserved — it still imports exactly two pure modules (`canonicaliseNumericReadingField`, `FIELD_CORRECTIONS`) and never `field_schema.json`. The label is therefore resolved by the CALLER (which does hold the schema) and passed in, which is also what keeps the leak guard at the staging boundary rather than inside the renderer.

### Step 2 — the drain (§3.1 build item 2)

- **Status:** DONE
- **Decision:** placed AFTER plan-B's net-0 mandatory-notice drain and BEFORE the F7 pre-emission net, per §3.1. `allRejected` was hoisted from its block scope to the top of the turn so rule (1) can read it. The whole block is `try`/`catch` **fail-open** — a throw inside the notice machinery must never cost the turn its read-backs.
- **Files:** `src/extraction/stage6-shadow-harness.js` (`let allRejected` hoisted to `:910`; drain `:3134-3277`; channel-3 callback wired into the LIVE `createAskDispatcher` opts `:1138-1152`).
- **Commit:** `568a40eb`
- **Notes:** the survivor test runs over `projectReadingWinners(perTurnWrites)`, never a raw `readings`-Map scan — post-A2 the raw Map key is board-AMBIGUOUS by construction, so a Map scan would subtract the wrong board's write and silently swallow a genuine miss. Field identity is canonicalised on BOTH sides of the comparison.

### Step 3 — `pendingVoicePrompts` materialisation

- **Status:** DONE (defect found by self-review during Step 2 verification, fixed before the test matrix)
- **Decision:** the drain pushed onto `session.pendingVoicePrompts` assuming it existed. On a turn where nothing else had queued a prompt it is undefined, so the push threw a `TypeError` — straight into the net's OWN fail-open catch, i.e. the notice vanished with no error surfaced. Order-dependent COMPLETE SILENCE on exactly the turns the plan exists to make audible. Now materialised lazily AT the push.
- **Files:** `src/extraction/stage6-shadow-harness.js:3237-3245`
- **Commit:** `bbc51ca6`

### Step 4 — producer channels (§3.1 build item 3)

- **Status:** DONE
- **Decision:** staged at every silent non-write in the touched dispatchers — channel 1 (`circuit_not_found` rejection), channels 6a/6b/6c (direct LIM capability skip, low-confidence skip, bulk LIM skip), the `!bucket` miss and the scope-policy silence, plus channel 3 (ask auto-resolve failure) in all THREE auto-resolve loops. The plan cites only the value loop; the enum loop and the circuit loop were found by source verification (the circuit loop was additionally UNWIRED — see review cycle 1).
- **Files:** `src/extraction/stage6-dispatchers-circuit.js` (11 edits), `src/extraction/stage6-dispatcher-ask.js` (10 edits)
- **Commit:** `3949c459`
- **Notes:** every staging site follows the `unsupported_clear` trusted-label precedent — the spoken field label comes ONLY from `FIELD_SCHEMA.circuit_fields[field].label`, the circuit ref must be `Number.isInteger`, and when any spoken discriminator is untrusted the site stages NOTHING rather than rendering a model-controlled string.

### Step 5 — test matrix (§5)

- **Status:** DONE
- **Files:** `src/__tests__/stage6-partial-failure-notices.test.js` (109 tests), `src/__tests__/stage6-partial-failure-notices-ask.test.js` (16 tests)
- **Commit:** `5c9fd42b` (+ later fix-cycle additions)
- **Notes:** includes the plan's HEADLINE scenario end-to-end (four writes land, circuits 7 and 8 miss ⇒ four read-backs PLUS one notice naming 7 and 8), the skip-then-write subtraction case, the `allRejected` suppression case, the skip-only-is-not-`allRejected` case, and a 32-line rendered-notice distinctness sweep across all three regimes.

### Step 6 — docs

- **Status:** DONE
- **Files:** `CLAUDE.md` (changelog row), `docs/reference/architecture.md` (the notice-regime section), `docs/reference/changelog.md` (full entry), `web/docs/parity-ledger.md` (dated row `recording/partial-failure-notices`, owner Derek — backend-only, zero wire change, so no web code companion is owed)
- **Commit:** `cf76a91c` (+ fix-cycle amendments)

## Gates

| Gate | Result |
|---|---|
| Backend Jest (`npm test`) | **6848 passed**, 0 failed, 19 skipped (290/292 suites; 2 pre-existing skips) |
| Field-replay corpus (`npm run replay:field-corpus`) | **9/9 passed**, 0 failed, exit 0 |
| ESLint (changed files) | exit 0, zero problems (repo-wide `npm run lint` exits 2 on the main baseline — not a regression from this diff) |
| Parity ledger (`scripts/check-parity-ledger.mjs`) | exit 0 — 11 changed files, 421 rows, 0 blank-dated, 0 stale warnings, 0 duplicate ids |

No recorded corpus fixture was authored for feedback id 112. Phase 0 established the class is MODEL-SIDE-adjacent: the trigger is a turn shape (some writes land, some don't), not a frozen model response, so a recorded fixture would lock the harness's handling of a hand-built envelope rather than the field behaviour. Synthetic tests + a live probe are the honest lane.

## Codex diff review

| Cycle | Scope | Findings | Outcome |
|---|---|---|---|
| 1 | full diff, THREE parallel lenses | 6 | all fixed → `49896327` |
| 2 | full diff, single pass | 1 BLOCKER (no terminals ⇒ a 4th repeat of one identity renders byte-identically to the 1st and is swallowed) | fixed → `d5fde829` |
| 2 mini | fix hunks only | 1 BLOCKER (variant index came from a shared per-family cursor, so a SECOND identity's arrival could rotate the FIRST back onto a string it had already spoken) | fixed → `559dd767` |
| 2b mini | fix hunks only | 1 BLOCKER (the repeat key was derived in parallel with the rendered text, so the two could disagree) | fixed → `dba75998` |
| 2b2 mini | fix hunks only | 1 BLOCKER (`capitaliseFirst` in the `write_failed` terminal is non-injective, and the schema carries a live colliding pair) | fixed → `3fc21eb1` |
| 2b2 mini (re-review) | fix hunks only | 0 | clean |
| **3** | **full diff, single pass** | **0** | **clean ⇒ ship** |

Converging series 6 → 1 → 1 → 1 → 1 → 0. Four consecutive fixes were resolved by REMOVING a mechanism (shared cursor → count-driven index; parallel key derivation → derive from the descriptor; `capitaliseFirst` → raw label), which is what the churn circuit-breaker asks for — the alternative each time was to add a compensating mechanism that tracked the first one.

One cycle-2b2 Codex response was REJECTED as a dead lens: an 89-token, near-instant "Findings: none." with no evidence of any file having been opened. Re-run with `resetSession: true` and a MANDATORY evidence section, it returned the BLOCKER above. A verdict is only evidence when the reviewer's WORK is evidenced.

## `[ASSUMED]` / `[DEVIATION]`

- `[ASSUMED]` §3.1's wording bullet specifies "≥3 byte-distinct rotating variants" and is silent on what happens once the pool is exhausted for one identity. Read as a FLOOR, not a ceiling: the ordinal-bearing TERMINALS added in cycle 2 are additive to the stated requirement and are the only way to satisfy the bullet's own stated PURPOSE (escape the client's 30 s text-keyed dedupe) at repeat 4+. Logged as WITHIN_INTENT rather than a deviation.
- `[DEVIATION]` The plan cites ONE ask auto-resolve loop (the value loop). Source verification found THREE (`resolveEnumAnswer`, `resolveValueAnswer`, `resolveCircuitAnswer`), the third of which sat below an early `return` and was structurally unreachable for staging. All three are now staged and the third is wired. WITHIN_INTENT — §3.1's rule is "every genuine rejection or silent skip inside a turn that ends with ≥1 sibling success", which is a property of the SITE, not of which loop the plan happened to enumerate.
- `[DEVIATION]` Codex cycle 1 proposed canonicalising the field label before rendering. NOT taken — canonicalisation folds distinct wire spellings onto one identity, which is correct for the SLOT key and wrong for the spoken LABEL (it would speak a field name the inspector did not use). Implemented raw-first with a canonical fallback instead, and the divergence is pinned by a test.

## `[FOLLOWUP]`

1. **LIVE PROBE — decision-class, needs Derek's ear.** Dictate *"Zs for circuits 5 to 10 is 0.4"* on a board where circuits 7 and 8 do not exist. Expected: four read-backs for 5, 6, 9, 10 AND exactly ONE notice naming 7 and 8. This cannot be verified headlessly — the failure mode it guards is *what a human hears*. Routed to the `/ep` digest.
2. `hasLowConfReadbackV1` is not threaded to the low-confidence staging site, so channel 6b currently stages on the pre-capability shape. Harmless today (the notice is correct either way) but it should read the live capability like the LIM channel does. → repo todo.
3. The rendered ref list has no cap: a 40-circuit bulk miss would speak all 40 refs. §3.1 does not specify a cap; a "…and 34 others" tail is the obvious shape. → repo todo.
4. The 30 s repeat window is measured server-side from the previous notice's RENDER, while the client's dedupe TTL runs from PLAYBACK. A notice rendered at 29.9 s and played after TTS latency can therefore cross the boundary in one direction and not the other. PRE-EXISTING — plan B's regime shares it identically; not introduced or worsened here. → repo todo.
5. Plan-A1a's and plan-B's notice pools use `capitaliseFirst` on board-field labels in 15 places. Their keys are slot/field-based and they draw on a different label namespace, so the cycle-2b2 collision does not obviously reach them — but nobody has actually checked. → repo todo.
