# Handoff — Observation classification correctness sprint (2026-06-03)

**For the next Claude session. Read this first.**

## Context in one paragraph

Derek (inspector, NICEIC-certified, daily user) flagged that BPG4-classification of observations is the bit of an EICR that matters most for correctness and is hardest for a small model. Over the last two days (2026-06-02 and 2026-06-03) we ported the system from BPG4 Issue 7.1 / BS 7671 A2:2022 references to **BPG4 Issue 7.3 / BS 7671:2018+A4:2026**, activated a **tiered model router** so observation turns route to Sonnet 4.6 while non-observation turns stay on Haiku 4.5, inlined the **WRAG (Wiring Regulations Advisory Group) Q&As** (~25 coding-relevant entries hosted by IET/Electrical Safety First) into the observation-tier prompt as a gap-filler corpus, and added an **anti-overcoding reasoning fallback** to prevent the default-to-C2 tendency that the user said plagues NAPIT Codebreakers. We also added a **dispatcher-level validator** that rejects coded observations (C1/C2/C3/FI) with null/empty `suggested_regulation`, after the iOS UI was observed rendering blank regulation columns. **The next field test will verify whether all four of these changes change the outside-light observation routing.**

## What's live on `main` right now

| Commit | Title | What it does |
|---|---|---|
| `a22367a7` | `config: flip OBSERVATION_EXTRACT_MODEL → claude-sonnet-4-6` | Activates the tiered router. Non-observation turns continue on `SONNET_EXTRACT_MODEL` (currently `claude-haiku-4-5-20251001`); observation turns (matched by `OBSERVATION_PATTERN` against the inspector's transcript only — not the wrapped user message) escalate to Sonnet. Net cost: ~£0.17/session vs £0.13 all-Haiku. |
| `4792ec9f` | `fix(prompts): refresh BPG4 references to Issue 7.3 + BS 7671:2018+A4:2026` | Updates version anchors throughout the prompts. Reg renumbering: `414.3(iv) → 414.3(d)`, `443.4.1 → 443.4.1 (a) & (c)`, `543.1.1 → 543.1.1.1`. AFDD scope corrected (`Higher risk → High rise`). Product Recalls explicit C2 row with ESF pointer. Mixed switchgear C2/C3 condition split clarified. Adds "Obs" category concept (mapped to NC since enum doesn't include Obs). Adds anti-FI-overuse guidance ("BPG4 7.3 has no FI examples for domestic; reject 'nice to know' FI"). Removes FI from auto-Unsatisfactory trigger (matches 7.3 §6). |
| `351dcf07` | `feat(prompts): add WRAG corpus + reasoning fallback for observation classification` | New file: `config/prompts/wrag-bs7671-eicr.md` with 25 coding-relevant WRAG Q&As + 4 context entries. Wired into `eicr-extraction-session.js` (appended to `EICR_AGENTIC_SYSTEM_PROMPT` after the Schedule of Inspections) AND into `observation-code-lookup.js` (appended to the refinement prompt). Reasoning fallback at end of WRAG file: default to C3, name the foreseeable event when picking C2, NEVER pattern-match against Codebreakers, NEVER cite forum content. Named authority hierarchy. Token caps bumped 8750 → 11200. |
| `64a94dbe` | `fix(observations): require suggested_regulation when code is C1/C2/C3/FI` | `validateRecordObservation` no longer a no-op — rejects coded observations with null/empty regulation. NC observations still accept null. Dispatcher order: **leak filter FIRST, then validator** (so security event isn't masked). Schema description updated. 7 new validator tests; 4 test files patched to provide a real regulation alongside their existing coded observations. |

## The specific field-test the next session should look at

**Session ID to compare against**: `C112923C-6D57-4A70-9B9B-C936F4947DB5` (2026-06-03 ~08:55 UTC)

Inspector utterance verbatim:
> *"Observation that outside light is not RCD protected."*

**What that session produced (PRE-fix)**:
- `code`: `C2`
- `schedule_item`: `5.12.2` (mobile equipment used outdoors) — WRONG
- `suggested_regulation`: null (rendered blank on iOS UI) — root cause of Derek's complaint
- Routed to Sonnet (tiered router was active) but pre-WRAG, pre-validator

**What the same utterance SHOULD produce post-fix**:
- `code`: `C3` (improvement recommended) — unless inspector dictates evidence of damage/water-ingress/mechanical risk, in which case escalate to C2 **with the foreseeable event named**
- `schedule_item`: `5.12.4` (For final circuits supplying luminaires within domestic (household) premises — 411.3.4)
- `suggested_regulation`: `411.3.4 — Additional protection for AC final circuits supplying luminaires in domestic premises` (or similar). **Null is now schema-rejected** for C1/C2/C3/FI; if the model tries to emit null, the dispatcher rejects with `regulation_required_for_coded_observation` and forces a retry.

**To compare**: pull CloudWatch logs for the next session after Derek runs one. Filter pattern: `record_observation`. Look at the `Client diagnostic` event with `alertMessagePreview` for the schedule_item, and the `stage6_tool_call` for the code. To see the full payload (including regulation), need to find the iOS-bound bundler emission — search for `bundleToolCallsIntoResult` events or look at `stage6_live_extraction` rows for the turn.

```bash
# starter command (adjust --since)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 30m \
  --filter-pattern "record_observation" | head -10
```

## Architecture map (read before editing observation flow)

```
                Inspector dictates "Observation, …"
                              ↓
       OBSERVATION_PATTERN (pre-llm-gate.js:166) — fuzzy regex matches
       observation/obs/obvashon/abservation/… (Deepgram garbles)
                              ↓
    _extractInspectorTranscript (eicr-extraction-session.js:~186)
    isolates "NEW utterance: <text>\n\n…" — JUST the inspector text,
    NOT the wrapped user message (which appends "(observations, …)"
    in the regex-pre-apply notice and would otherwise falsely escalate
    EVERY reading turn)
                              ↓
       Tiered router (eicr-extraction-session.js:~2380):
       observation? → OBSERVATION_EXTRACT_MODEL (Sonnet 4.6)
       not? → SONNET_EXTRACT_MODEL (Haiku 4.5)
                              ↓
      System prompt (cached prefix, ~11000 tokens):
       1. sonnet_agentic_system.md (base agentic prompt)
       2. schedule-of-inspection-bs7671-eicr.md (full BS 7671 SoI)
       3. wrag-bs7671-eicr.md (25 WRAG Q&As + reasoning fallback)
                              ↓
       Model emits record_observation tool call
                              ↓
   stage6-dispatchers-observation.js:dispatchRecordObservation
       1. Leak filter (security-first) — rejects if leak detected
       2. validateRecordObservation — NEW: rejects coded obs with null reg
       3. appendObservation — UUID + push to session.extractedObservations
       4. perTurnWrites bundler — projects to iOS via WS
                              ↓
              iOS receives bundled extraction payload
                              ↓
       Fire-and-forget BPG4 refinement (observation-code-lookup.js):
       gpt-5-search-api re-reads the observation against
       WRAG + Schedule + BPG4 + reasoning fallback, can patch
       code/regulation/schedule_item/text via observation_update WS
```

## Files you'll most likely touch

| Path | What's in it | When to edit |
|---|---|---|
| `config/prompts/wrag-bs7671-eicr.md` | NEW. 25 WRAG Q&As + reasoning fallback + authority hierarchy + Codebreakers anti-pattern. | Adding more WRAG Q&As; BPG5 fire-performance entries; tightening the reasoning fallback after a new field test surfaces an over/under-coding pattern. |
| `config/prompts/sonnet_extraction_system.md` | Legacy non-agentic prompt. Used in `off`-mode rollback only — production uses the agentic one. | Same content updates as agentic (keep in lockstep if you change classification language). |
| `config/prompts/sonnet_agentic_system.md` | Production prompt. ~10000 tokens incl. appended Schedule + WRAG. | FI definition, observation rules, worked examples. Body now points at the WRAG corpus and reasoning fallback. |
| `config/prompts/schedule-of-inspection-bs7671-eicr.md` | BS 7671 SoI — full 99-item list. iOS canonical copy lives at `Sources/PDF/EICRHTMLTemplate.swift` (`InspectionItem2`) — keep in lockstep. | A5/A6 amendments. |
| `src/extraction/observation-code-lookup.js` | Refinement prompt (gpt-5-search-api). Now loads + appends BOTH the Schedule AND the WRAG corpus. | If refinement web-searches start finding unhelpful content. |
| `src/extraction/eicr-extraction-session.js` | Loads + concatenates the prompts at module init (`EICR_AGENTIC_SYSTEM_PROMPT`). Holds the tiered-router logic in `callWithRetry`. | Adding a new prompt appendix; tweaking the tiered-router classifier. |
| `src/extraction/stage6-tool-schemas.js` (~line 414) | `record_observation` schema. `suggested_regulation` is `anyOf: [string, null]` — null still allowed for NC. Description tells the model it's REQUIRED for coded observations. | Adding new tools or tightening the tool surface. |
| `src/extraction/stage6-dispatch-validation.js` (~line 285) | `validateRecordObservation` — NEW regulation-required logic. Returns null for non-coded observations. | Adding more dispatch-level guards (e.g. require schedule_item too?). |
| `src/extraction/stage6-dispatchers-observation.js` | Dispatcher. ORDER MATTERS: leak filter THEN validator THEN appendObservation. Don't reverse. | Adding new pre-mutation guards. |
| `ecs/task-def-backend.json` (lines 54-55) | `SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001` + `OBSERVATION_EXTRACT_MODEL=claude-sonnet-4-6`. The empty-string convention treats unset as off. | Flipping the tiered router or changing default model. |

## Open questions / known constraints

1. **Codebreakers is unreliable per Derek** — defaults to C2 too often. The WRAG file explicitly tells the model NOT to pattern-match against Codebreakers style. If a field test still produces C2-default behaviour, sharpen the reasoning fallback further (currently `wrag-bs7671-eicr.md` lines towards the bottom).

2. **The Obs category in BPG4 7.3 has no schema home** — our `observation_code` enum is `{C1, C2, C3, FI, NC}` with no `Obs`. The prompt routes Obs items to NC with a rationale note. If you ever migrate the schema, the right approach is to ADD `Obs` to the enum + matching iOS rendering — don't repurpose NC further.

3. **WRAG is inline, not RAG** — at 25 entries we deliberately inlined. Documented migration trigger in the commit message: switch to embedding-based retrieval when corpus grows past ~50 entries OR we add IET Wiring Matters articles / manufacturer guides / BPG5 fire-performance content. The file format (one Q# per bullet, code + reg + trigger triple) is retrieval-friendly.

4. **GitHub Actions is the only deploy path** — `./deploy.sh` exists but its `tee`-wrapped invocation masks Docker-Desktop-not-running failures. Always push to `main`, watch via `gh run watch <run-id>`.

5. **Branch reverts between Bash invocations** were observed multiple times this session — switching to main, running a separate bash command, finding myself back on the audit branch. Workaround: chain switch + edit + commit in a single bash invocation, OR use cherry-pick. Don't trust the branch state across bash calls; verify with `git rev-parse --abbrev-ref HEAD` before mutating operations.

6. **iOS observation schema is more permissive than the server now is** — iOS allows null `suggested_regulation` because that was the historical contract. The server now rejects it for coded observations. No iOS migration needed (the rejection happens on the server, the model retries, iOS only sees the eventually-successful emit) — but be aware if anyone reports "iOS shows blank reg" again, the root cause has now shifted from "model emitted null" to "model emitted null AND retry path didn't fire" — a different bug class.

7. **Token caps**: agentic prompt now at ~11036 tokens (cap 11200, 150-token headroom). The CONFIDENTIALITY length cap is at 6400 (also bumped). Future prompt edits should target trimming rather than expansion if cap pressure mounts.

## Verifying the deploy is live

CI run from `64a94dbe` push needs ~13 min. After it goes green:

```bash
# Confirm task-def has the right SONNET_EXTRACT_MODEL + OBSERVATION_EXTRACT_MODEL
aws ecs describe-task-definition --task-definition eicr-backend --region eu-west-2 \
  --query 'taskDefinition.containerDefinitions[0].environment[?contains(name, `EXTRACT_MODEL`)]' \
  --output table

# Sanity: a fresh test session should appear within seconds of Derek hitting record
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 5m \
  --filter-pattern "stage6_live_extraction"
```

## What I'd recommend the next session do FIRST

1. **Read this file** (you just did — well done).
2. **Verify CI run from `64a94dbe` is green** (`gh run list --limit 1`).
3. **Wait for Derek's next field test** — same outside-light utterance ideally, but any observation gives signal. Pull the session logs the way I did at the bottom of this session and report back: did `schedule_item` move from 5.12.2 to 5.12.4? Is `regulation` populated? Is the code C3 (with reasoning rationale) or still C2 (and if C2, did the model name the foreseeable event)?
4. **If the field test still mis-routes**, the next move is to sharpen the FIXED-vs-MOBILE block specifically — currently it lives in `sonnet_extraction_system.md` and `observation-code-lookup.js`, but probably not in the agentic prompt loud enough. Consider hoisting it into the WRAG file as a Q# of its own (`Q-DERIVED.OUTDOOR-LIGHT`).
5. **If the field test routes correctly**, consider the BPG5 fire-performance addition — it'd close another known gap (Derek doesn't routinely deal with fire-barrier breaches but the cases the WRAG corpus links to BPG5 are real).

## Background reading you'd benefit from

- **MEMORY.md** at `~/.claude/projects/-Users-derekbeckley-Developer-EICR-Automation-CertMateUnified/memory/MEMORY.md` — auto-loaded, has Derek's preferences and prior decisions.
- **CLAUDE.md** at the project root — auto-loaded. Key rules: **commit after every logical unit**, **infrastructure changes must come from source** (`ecs/task-def-backend.json` not `aws ecs register-task-definition`), **never use ./deploy.sh** (Docker Desktop isn't kept running).
- **`config/prompts/wrag-bs7671-eicr.md`** — read this in full at least once. It's the load-bearing addition this session.

## What NOT to do

- Don't re-cite Codebreakers as authority. Derek explicitly rejected this and the WRAG file documents why.
- Don't reach for FI to dodge a hard C1/C2/C3 decision. BPG4 7.3 §6 says FI alone no longer auto-Unsatisfactory but reasonable-doubt-about-danger still does — narrower test.
- Don't scrape forums / Reddit / individual electrician blogs even if they look authoritative. The WRAG file names the authority hierarchy: BS 7671 A4 > WRAG > BPG4 7.3 > GN3 > BPG5 > manufacturer docs. Nothing else.
- Don't change the schema-level requirement for `suggested_regulation` to non-null — it'd break NC observations and installation-wide observations that legitimately have no specific reg. The DISPATCH-time validator is the right enforcement layer.
- Don't bump the prompt token caps without explaining WHY in a comment alongside the cap (existing comments at `src/__tests__/stage6-agentic-prompt.test.js` lines 116-185 show the pattern — each bump documents what content drove it).

— End of handoff.
