# Conversation context — pre-round-1 dump

This file captures the session that produced `plan-session-c0c21546-rcd-tts-wiring-fixes-2026-06-04.md`. Reviewers cross-reference this against the plan to catch "discussed but not written down" gaps.

## Source

Substantive prior conversation. The user asked me to investigate three bugs from session C0C21546 (2026-06-04), I performed code-level investigation across iOS and backend, then the user said "write a plan for all fixes". This dump summarises the investigation findings that informed the plan and the project-level constraints in CLAUDE.md / memory that constrain what the plan is allowed to do.

## Decisions the user explicitly made

- "Investigate all of these thoroughly" before writing any fix or plan. Implementation without thorough diagnosis was implicitly rejected.
- After the investigation summary, "Please write a plan for all fixes" — all three bugs in scope, in one document, plan-only (not execute).
- The CloudWatch evidence + code-level root-cause work I did in this session is what the plan is meant to encode. The plan must be self-contained enough for a future session to execute.

## Constraints surfaced

- **iOS-shared-backend MANDATORY rule** (project CLAUDE.md): `eicr-backend` task def is shared with iOS. Backend changes must not break iOS contract. PWA-only work goes in `web/` only. Bug 1 + Bug 3 are backend changes — must be additive / backward-compatible.
- **Deploy via GitHub Actions only** (saved memory, project CLAUDE.md). Never use local `./deploy.sh`. Docker Desktop isn't kept running on the dev Mac. `gh run watch <run-id>` for monitoring.
- **iOS TestFlight only on explicit ask** (saved memory). iOS commits land on `main` but `deploy-testflight.sh` runs ONLY when Derek asks.
- **Infrastructure changes from source files** (project CLAUDE.md MANDATORY): no out-of-band ECS task-def edits or AWS-console mutations. Source first, then deploy.
- **Don't add features beyond what task requires** (main instructions). The plan must cover only the three bugs from session C0C21546 — no opportunistic refactor.
- **Auto-commit after each logical unit** (project CLAUDE.md). The plan recommends one commit per fix.
- **Stage 6 agentic prompt is the production prompt**; the others (`sonnet_extraction_system.md`, `sonnet_text_system.md`) are legacy / fallback. Plan explicitly says NOT to update the legacy prompts.

## Alternatives considered and rejected

- **Bug 1 option B — server-side 150-300 ms delay before `mid_stream_emit`.** Rejected: eats half the speculator's perceived-latency benefit that landed yesterday (commit `8844391`, Tier 1 + 2 voice latency project). Trade is wrong direction.
- **Bug 1 option C — iOS-side intercept buffer with `cancel_speculation` protocol.** Rejected as scope-creep for this fix: requires backend protocol addition AND iOS audio-queue intercept AND another TestFlight cycle. Listed as deferred follow-up.
- **Bug 1 option D — pure broader heuristic** (any plural-circuit pattern without noun anchor). Rejected: risks false positives on natural value dictation like "1 to 6 megohms" or "1, 3 megohms". Plan went with option A (enumerated garbles of "circuits") which keeps the noun anchor.
- **Bug 3 schema variant — widen `context_circuit` to accept array.** Rejected: would confuse Sonnet's understanding of the existing single-int semantics. Plan chose a separate plural `context_circuits` field that's additive.
- **Bug 3 prompt variant — update all sonnet_*.md prompts.** Rejected: Stage 6 agentic is the production prompt. Legacy prompts kept untouched to minimise blast radius.
- **Bug 2 fix variant — drop dedupe entirely for broadcasts.** Implicitly rejected: the dedupe was originally added for a real bug (P0-1, server re-sends same confirmation). Keep dedupe, just fix the key to be value-aware.

## Gotchas / hidden requirements

- **Bug 2 dedupe formula appears in TWO sites:** `DeepgramRecordingViewModel.swift:4143` (deferred flush path) AND `:8498` (inline path). Both must change. A correction-TTS dedupe at line 6852 uses a DIFFERENT key (`correctionDedupeKey`) and must NOT be touched.
- **Bug 3 `wiring_type` schema:** options are `["A","B","C","D","E","F","G","H","O"]` per `config/field_schema.json:24-32`. Stage 6 agentic prompt at line 30 says "Return a SINGLE letter only". iOS `Constants.swift` likely has a matching dropdown — plan did not explicitly verify iOS parity; this may need a check.
- **Existing prior fix for the same failure mode:** session 08469BFC saw the same "Sonnet acknowledges but never writes" pattern for single-circuit value asks; `resolveValueAnswer` was shipped for it (comment at `stage6-answer-resolver.js:546-557`). Bug 3 is the multi-circuit generalisation of that fix.
- **Existing prior fix nearby:** session DC946608 added `resolveEnumAnswer` (BS-EN values). Bug 3 widens it.
- **Existing prior fix nearby:** 2026-06-02 handoff (`handoff-2026-06-02-fixes.md`) shipped Fix A — the `broadcastIntentByTurn` pre-detect. Bug 1 widens its trigger regex.
- **Recent voice-correctness sprint shipped 2026-06-03** added "speculator skips off-enum round-1 synth" (Fix C in F03B590C). Plan's Bug 1 fix must not regress that gate.
- **iOS `String.hashValue` is platform-stable within a process run** (Swift docs). Two runs of the app produce different hashes for the same string. This is fine for session-scoped dedupe but worth noting in the plan.
- **`field-name-corrections.js` has no entry for "warming"** (greped during investigation). Plan defers this (Gap C).

## Open questions the user deferred

- **Warming→wiring garble correction (Gap C):** plan explicitly defers as a follow-up. User did not ask to fix it now.
- **iOS speculator-cancel protocol (Bug 1 option C):** plan explicitly defers.
- **Speculator pre-text delay (Bug 1 option B):** plan explicitly defers (and rationale: protect Tier 1 latency win).
- **Fuzzy match for broadcast garbles vs enumerated:** plan went with enumerated; user did not push back during investigation, but plan does not state whether fuzzy is being entertained later.
- **iOS Constants.swift wiring_type dropdown parity:** plan does not explicitly call out checking this. Could be an oversight if the iOS form has a different enum than the backend schema.
- **The plan does NOT touch the legacy prompts** (`sonnet_extraction_system.md` etc.) — explicit decision, but worth confirming that Stage 6 agentic is the only path that runs in production.
