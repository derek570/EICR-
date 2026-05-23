# Loaded Barrel — Execution Handoff

**For the executing session.** This is the entry point. Read this
first, then `LOADED_BARREL_PLAN_FINAL.md` in this folder.

## Status

Plan is **APPROVED** — 0 BLOCKERs from both Claude Plan-agent and
Codex gpt-5.5 after 9 review rounds. Authorised to execute.

## Pre-flight checks (do these BEFORE writing any code)

Run these to confirm the codebase still matches the plan's assumptions
(this plan was written 2026-05-24; if more than a week has passed,
re-verify):

```bash
# 1. perTurnWrites.readings shape (plan assumes flat Map with encoded composite key)
grep -n "encodeReadingKey\|readings\.set\|readings\.get" \
  /Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-per-turn-writes.js | head -20

# 2. buildConfirmationText still local (plan extracts it to confirmation-text.js in Phase 1.B)
grep -n "buildConfirmationText\|CONFIRMATION_FRIENDLY_NAMES\|CONFIRMATION_MIN_CONFIDENCE" \
  /Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-event-bundler.js

# 3. dispatchers return shape unchanged
grep -n "return.*tool_use_id\|return.*is_error" \
  /Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-dispatchers-circuit.js | head -10

# 4. elevenlabs-stream-client.synth signature still takes complete text
grep -n "async synth\|client\.synth" \
  /Users/derekbeckley/Developer/EICR_Automation/src/extraction/elevenlabs-stream-client.js | head -10

# 5. iOS AlertManager.expandForTTS still at lines ~986-1082
grep -n "expandForTTS\|expandNumbers" \
  /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Recording/AlertManager.swift

# 6. keys.js streamConfirmationViaElevenLabs still exists
grep -n "streamConfirmationViaElevenLabs" \
  /Users/derekbeckley/Developer/EICR_Automation/src/routes/keys.js
```

If ANY of these returns nothing or unexpected output, STOP and update
the plan before proceeding.

## Mandatory rules (from `EICR_Automation/CLAUDE.md`)

These are NON-NEGOTIABLE:

1. **Backend (`src/`, `config/prompts/`, `packages/shared-types`,
   `packages/shared-utils`) is shared with iOS.** Any change must be
   acknowledged to coexist with current iOS. This plan adds new
   files + extends existing wire shapes BACKWARDS-COMPAT (new
   optional fields). Verify each iOS-facing change in Phase 4 ships
   FIRST and waits for adoption before backend depends on it.

2. **Infrastructure changes must come from source.** Phase 1.E adds 2
   env vars to `ecs/task-def-backend.json`. Do NOT register a task
   def out-of-band — let CI deploy from source.

3. **Deploy via GitHub Actions only.** Do NOT use `./deploy.sh`
   locally — Docker Desktop is not kept running.

4. **Commit after every logical unit of work** with detailed
   WHAT+WHY+WHY-this-approach commit messages.

5. **Never skip pre-commit hooks (`--no-verify`)** unless the user
   explicitly asks for it.

## Execution order

Follow `LOADED_BARREL_PLAN_FINAL.md` §C "Phase plan + ordering"
TABLE EXACTLY. Critical sequencing:

1. **Phase 0 first** (week 1) — produces deliverables that gate
   everything else. If parity fixtures don't pass at end of Phase 0,
   STOP and re-plan.

2. **iOS Phase 4a ships BEFORE Phase 2 backend** — backend speculator
   code can land on `main` with flag OFF, but the feature won't work
   until 4a is on enough iOS clients. Readiness probe (Phase 1.F)
   gates the flag flip.

3. **Flag stays OFF in production until** readiness probe reports
   ≥80% 4a adoption. This may take 2-4 weeks of TestFlight cycle —
   plan for the wall-clock wait.

4. **Ramp 1% → 10% → 50% → 100%** with 1-week observation per step.
   Phase 7 metrics gate each step.

## Verification gates (G1-G8)

See `LOADED_BARREL_PLAN_FINAL.md` §G. Each gate is a hard
checkpoint — do NOT proceed past a gate without all conditions met.

## What to do if you find blockers during implementation

Plan went through 9 review rounds. If during code-writing you find a
real BLOCKER (not just an "I'd do this differently"), STOP and:

1. Write a `BLOCKER_<n>.md` in this folder with: what you tried, why
   it doesn't work, what's the minimum spec change needed.
2. Resume only after the user reviews. Do NOT silently change the
   plan or invent new architecture.

The plan's open-questions section (§F) lists everything the reviewers
flagged that turned out non-blocking when verified against the actual
codebase. Cross-reference there first.

## Where to read about prior decisions

- `LOADED_BARREL_PLAN_FINAL.md` (this folder) — the executable plan
- `../LOADED_BARREL_PLAN_v9.md` — the as-approved revision (with
  v10/FINAL adding 7 small tightenings on top)
- `../LOADED_BARREL_PLAN_v8.md` ... `v1.md` — full revision history
- `REVIEW_HISTORY.md` (this folder) — every reviewer verdict round
  by round
- The compacted context summary in the orchestrator's session, if
  available — covers the prior 822ms fast-path that's already shipped
  to prod, and why Loaded Barrel exists for Sonnet-path turns

## Critical: this plan does NOT solve multi-round Sonnet latency

Loaded Barrel saves ~470ms on the FINAL synthesis step. Sonnet's
3-round agentic tool loop (~3.5s) is unchanged. Audible-end-to-end
on multi-round turns will improve from ~4.5s → ~4.0s, NOT to the
2-2.5s target. To hit that target requires a SEPARATE sprint on
prompt-side single-round-preference work. Do NOT scope-creep this
sprint to include that — it has its own design surface and is
documented as a follow-on in §E.

## Author / chain of custody

- Original plan + 9 reviews: orchestrator session
  `/Users/derekbeckley/.claude/projects/-Users-derekbeckley-Developer-EICR-Automation-CertMateUnified/2dcfd580-8512-4cec-980c-855bf688ec1c.jsonl`
- Plan-agent review tool: Claude Code Plan subagent
- Codex review tool: gpt-5.5 via `mcp__codex-cli__ask-codex`, high
  reasoning, read-only sandbox
- Convergence: v1 (7 BLOCKERs) through v9 (0) — see REVIEW_HISTORY.md
