# Multi-Board / Sub-Main Support — Fresh-Context Handoff

**Read this first** in a new session. Full plan in sibling `PLAN.md` (~870 lines, refer as needed).
Last updated 2026-05-07. Status: **Phases 1, 2, 2a, 3, 4, 4a SHIPPED. Phase 5 slices 5.1–5.5 SHIPPED (`afd928f` + `4df60ee` + `68d7b6e` for 5.5). Phase 6.0 SHIPPED — backend wire channel (`2706123`) + iOS BoardOp decoder (`3734b67`) close Codex deal-breaker #3. Slice 5.6 (legacy `circuits[0]` removal) is held back until `STAGE6_MULTI_BOARD=true` soaks for ≥1 deploy cycle. Phase 6 (the tools themselves: `add_board` / `select_board` / `mark_distribution_circuit` dispatchers + tool schemas) is the next concrete step.**

> If you are resuming Phase 5 specifically, jump straight to
> [PHASE5_HANDOFF.md](PHASE5_HANDOFF.md) — it is self-contained and
> captures the Codex-corrected snapshot shape, file:line audit, and
> recommended slice order.

---

## What this is

Closing the gap between the iOS app — which already supports multiple consumer units per job and "fed-from" sub-main relationships — and the rest of the stack (backend types, Stage 6 dictation, PDF, validation), which today silently drops or ignores those concepts.

Also drops `sub_main_cable_length` (not BS 7671 mandatory).

---

## What you need to know cold

### iOS already has it; backend doesn't

iOS `CertMateUnified/Sources/Models/BoardInfo.swift:51-61` defines `boardType`, `parentBoardId`, `feedCircuitRef`, `sortOrder`, `subMainCableMaterial/Csa/Length/CpcCsa`. iOS UI in `BoardTab.swift` lets users add boards, mark them as `.subMain` / `.subDistribution`, pick a parent. PDF in `EICRHTMLTemplate.swift:1472` already loops over `job.boards`.

The backend `packages/shared-types/src/circuit.ts:38-47` `BoardInfo` interface has only **9 fields** (none of the hierarchy/cable ones). Stage 6 has zero board-aware tools. `/api/analyze-ccu` is board-blind. CSV export drops unknown fields. None of this is the user's bug today because most flows go iOS-only.

### Stage 6 architecture is FULLY tool-call-based

13 tools live in `src/extraction/stage6-tool-schemas.js` (TOOL_SCHEMAS array starts L795). Dispatched via `stage6-dispatchers.js`. State in `session.stateSnapshot` — a **keyed object** `{circuit: {field: value}}`, NOT an array. `circuits[0]` is the legacy "supply / board / installation" namespace woven through 6+ files; do NOT retire it in one pass.

---

## Locked decisions (do NOT relitigate)

| Q | Decision | Why |
|---|---|---|
| **0.1** state-model shape | Flat `circuits` keyed by `${board_id}::${circuit}` + sibling `boards[]` array | Less invasive than nested boards[].circuits[]; Codex Option D internally |
| **0.2** tool surface | `board_id` **required when `boards.length > 1`**, optional when single-board | Avoids contradicting the existing "no implicit active circuit" prompt principle (`sonnet_agentic_system.md:49`) |
| **0.3** legacy snapshot default | Synthesise `boards = [{ id: 'main', designation: 'DB-1', board_type: 'main' }]` and stamp legacy circuits with `board_id: 'main'`. Idempotent. | Trivial migration; no new fields to backfill |
| **0.4** sub_main_cable_length | **Remove entirely** (model + UI + wire format) | Codable.decodeIfPresent tolerant; no migration script needed |
| **Q2** web UI | **Defer to separate sprint** | Out of scope for this plan |
| **Q3** EIC certificates | **In scope** — multi-board applies to both EICR and EIC | New-installs can include sub-mains too |
| **Q4** sub-board CCU photo UX | **Add a 5th `CCUExtractionMode` case `.addNewBoard`** alongside `circuitNamesOnly` / `hardwareUpdate` / `fullCapture` / `appendRail` | Reuses existing mode-picker pattern |
| **Q5** circuit numbering | Inspector switches between boards via `select_board`. Each board's circuits start from 1. | Composite-key approach (`board_id::circuit_ref`) handles collisions |
| **Q6** forward references in `mark_distribution_circuit` | **Ask before assuming.** If `feeds_board_id` doesn't exist yet → `ask_user("Would you like to add DB-2 as a sub-board fed from circuit 4?")`. Server resolver chains `add_board` then `mark_distribution_circuit` on YES. | Same principle for weak `add_board` cues |
| **Q7** PDF page layout | Each sub-board gets its own page in the schedule. Sub-main section as its own `<h3>` on that page. | Existing per-board loop already paginates |

---

## Deal-breakers from Codex review (verified — DO NOT redo wrong)

These are the three things that blocked the original plan from shipping. Each got a NEW phase:

1. **CSV export drops new fields** — `src/export.js:42` defines fixed `CIRCUIT_FIELD_ORDER`. Adding fields without extending it = silent data loss. → **Phase 2a** (persistence hardening). MUST land before Stage 6 work.
2. **Recording.js collapses to `boards[0]`** — `src/routes/recording.js:1655` literally `session.accumulator.board = { ...jobData.boards[0] }`. Whisper path is single-board-only. → **Phase 4a** — formally scope whisper as single-board-only and route multi-board exclusively through Stage 6.
3. **No `board_ops` wire channel in Stage 6** — `stage6-per-turn-writes.js:58` and `stage6-event-bundler.js:38` have no plumbing to send board mutations to iOS over the WS. Without this, `add_board` / `select_board` / `mark_distribution_circuit` are no-ops at the user level. → **Phase 6.0** — implement the wire protocol BEFORE the tools that need it.

Also: original plan's snapshot-mutation sketch used `circuits.find(...)` and `.push(...)`. **WRONG** — `stateSnapshot.circuits` is a keyed object `{}`, not an array. Use composite-key keys: `'main::1'`. Already corrected in PLAN.md Phase 5.

---

## Phase order (revised after review)

| # | Phase | iOS / Backend / Stage 6 | Risk | Estimate |
|---|---|---|---|---|
| 1 | Drop `sub_main_cable_length` | iOS only | Trivial | 30 min |
| 2 | shared-types parity + field_schema + hierarchy validator | Backend | Low | 1 session |
| 2a | **NEW** Persistence hardening (CSV headers + audit) | Backend | Medium (data) | 1 session |
| 3 | PDF sub-main section | iOS only | Low | 1 session |
| 4 | `/api/analyze-ccu` board attribution + iOS `.addNewBoard` mode | Both | Low | 1 session |
| 4a | **NEW** Recording.js single-board scope decision | Backend | Low | 30 min |
| 5 | Stage 6 state model widening (corrected keyed-object shape + circuits[0] strangler) | Stage 6 | High | 2-3 sessions |
| 6.0 | **NEW** Stage 6 board-ops wire protocol | Stage 6 + iOS | Medium | 1 session |
| 6 | Stage 6 new tools (`add_board`, `select_board`, `mark_distribution_circuit`) + extending 9 existing | Stage 6 | High | 2 sessions |
| 7 | System prompt + ask-user resolver multi-board awareness | Stage 6 | Medium | 1 session |
| 8 | Tests, telemetry, feature flag rollout, field test | All | Low | 1 session |

**Total: 7-11 sessions.** Phases 1-4a deployable as a **near-term sprint** (~3-4 sessions). Phases 5-8 are the **Stage 6 widening** — separate decision when Derek wants to commit the time.

---

## NEXT ACTION: Phase 1

**Goal**: drop `sub_main_cable_length` everywhere it's referenced. iOS-only. No backend touch. Reversible.

**Files to edit:**

1. `CertMateUnified/Sources/Models/BoardInfo.swift`:
   - Line 60: delete `var subMainCableLength: String?`
   - Line 91: delete `case subMainCableLength = "sub_main_cable_length"`
   - Line 107: drop `subMainCableLength: String? = nil` from `init` parameter list
   - Lines 121-122: drop `self.subMainCableLength = subMainCableLength` from init body
   - Custom `init(from decoder:)` (line 126+): drop the `decodeIfPresent` call for `subMainCableLength`

2. `CertMateUnified/Sources/Views/BoardTab.swift:226-242`: drop the cable-length input row from the sub-main cable section. Keep material, live CSA, CPC CSA.

3. Tests: grep `subMainCableLength` and `sub_main_cable_length`; update fixtures.

**Build + verify:**

```bash
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified
xcodebuild -scheme CertMateUnified -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

**Commit message:**
> `refactor(BoardInfo): drop sub_main_cable_length — not required by BS 7671 and never used in field`
>
> Body: explain that the field appeared in the data model but was never specified by BS 7671 nor used by inspectors during field testing. Codable.decodeIfPresent is tolerant of stale keys in old job snapshots, so no migration script is needed.

---

## Memory cross-refs

After completion, update:
- Append delivery log to `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PLAN.md` (chitchat-pause-style)
- Add row to `EICR_Automation/CLAUDE.md` Changelog table dated 2026-05-07 with one-line summary + commit ref
- Existing memory entry `multi_board_plan_2026-05-07.md` (this handoff) — update Status field

## Reference files

- **PLAN.md** (sibling) — full 870-line plan with verbatim Codex review + Claude self-review, all phases detailed
- **CLAUDE.md** at `/Users/derekbeckley/Developer/EICR_Automation/CLAUDE.md` — repo-level architecture
- **CLAUDE.md** at `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/CLAUDE.md` — iOS-specific
- Recent shipped handoffs in same style: `chitchat-pause-2026-05-06/PLAN.md`, `bs-en-alignment-2026-05-06/PLAN.md`

## Critical rules from past mistakes

- **Auto-commit after every logical unit of work** (CLAUDE.md commit rules) — small, focused commits.
- **NEVER use `./deploy.sh`** — Docker Desktop isn't running on the dev Mac. Always push to main + `gh run watch`.
- **Build the iOS app from CertMateUnified/, not the parent repo** — they're separate git repos.
- **Local Xcode builds for testing** — don't deploy to TestFlight unless explicitly asked.
- When sending shell commands containing `sleep`, use the longer `until <check>; do sleep 2; done` form rather than chaining short sleeps.
