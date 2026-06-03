# Session Optimizer Rewrite Plan — 2026-06-03

## Why this plan exists

The session optimizer was built 2026-02-26 to learn from production sessions and propose iOS-side regex / keyterm / Sonnet-prompt improvements. The world has moved on substantially:

| Then (Feb 2026) | Now (Jun 2026) |
|---|---|
| Deepgram Nova-3 | Deepgram Flux (`flux-general-en`) |
| `:boost` suffix worked | `:boost` suffix ignored — keyterms are inclusion-priority only |
| TranscriptFieldMatcher.swift was the primary capture path | Dialogue engine + Sonnet (Stage 6) is primary; regex is a pre-LLM gate |
| Single Sonnet model | Tiered router (Haiku for fast turns, Sonnet for complex) |
| iOS-only keyterm config | Per-ask Flux Configure (focused-mode) plumbed |
| No harness probes | 100+ probe YAMLs as the regression substrate |
| 500-token keyterm budget rules | Different budget shape on Flux's `/v2/listen` |

The optimizer is unaware of all of this. Its 47 recommendations from the last 30 days are skewed toward regex_improvement in TranscriptFieldMatcher.swift and keyword_boost numbers that Flux ignores. It hasn't proposed a single dialogue-engine schema tighten — the fix class that yesterday's L-L=2 bug needed (verified by grepping the last 30 days of `optimizer-reports/*.json` for `category == "dialogue_engine_*"` — zero hits; the category does not yet exist as an enum value, per `scripts/optimizer-prompt-session.md:183`).

This plan brings the optimizer in line with the current architecture across **eight items**, organised into **three clusters**.

---

## Cluster 1 — Stop misleading recommendations (½ day, single PR)

Goal: stop the optimizer from telling Claude things that are flat-out wrong. Once landed, every new report immediately becomes more useful.

> **Two prompt surfaces, not one.** `session-optimizer.sh` invokes Claude through TWO separate prompts: `scripts/optimizer-prompt-session.md` (per-session reports — the default path) AND `scripts/optimizer-prompt-debug.md` (standalone voice-debug reports — invoked when the optimizer processes a `debug-reports/*` payload). Both prompts currently contain the same Nova-era / regex-first / stale `CertMateUnified/Resources/default_config.json` content. **Every prompt-text edit in this plan must be applied to BOTH prompt files in lockstep** — Items 2 + 3 in Cluster 1, Item 5 in Cluster 2, AND Item 4's category-enum / advisory-schema split (also Cluster 2). The debug prompt has its own output-schema example that today requires `file` / `old_code` / `new_code` on every recommendation and has no `category` field at all — Item 4's `implementation_status` + advisory rules must be added to it explicitly, otherwise debug reports cannot emit the new categories and would still be pushed toward fabricated diffs for advisory-only fixes. The two prompts have similar-but-not-identical structure — adapt wording where the prompt's existing surrounding context requires it (don't blindly copy/paste).

### Item 1 — Filter harness sessions out of the poll

**What.** Skip session keys whose **basename** starts with `harness_` in `session-optimizer.sh`'s poll loop. `SESSION_PATH` is a full S3 key shaped `session-analytics/{userId}/{sessionId}` — a literal `^harness_` regex against the full path will NEVER match (the path starts with `session-analytics/`). Apply the check after basename extraction:

```sh
SESSION_BASENAME="${SESSION_PATH##*/}"
if [[ "$SESSION_BASENAME" == harness_* ]]; then
    # mark processed, delete .first_seen[$SESSION_PATH], continue
fi
```

Apply the same basename check in the missed-sessions audit loop for `AUDIT_PATH` before adding it to `first_seen`. This is the primary filter and is sufficient in practice — Derek's iOS app uses UUID-shaped session IDs, so a `harness_` prefix on the basename is unambiguous evidence of harness origin.

> Implementation note: an earlier draft of this item proposed a belt-and-braces second filter on `transcripts_sent < 3 AND first_transcript_to_extraction_ms == 0`. Those fields exist ONLY in `scripts/voice-latency-bench/transcript-replay.mjs` output (the benchmark runner), NOT in production session-analytics S3 payloads — so the secondary filter would have been a silent no-op (every real session matches `== 0` because the field is absent). If a stronger filter is ever needed: first run a one-line `jq` probe against a real production `manifest.json`/`cost_summary.json` to identify a field that actually exists, THEN define the second tier. Until then, rely on the `^harness_` regex plus the existing 3600s skip-after grace timeout.

**Why.** The log right now is spamming `New session analytics: session-analytics/82b54893-…/harness_1780479…` every 3 seconds, then "No debug_log.jsonl — waiting" because harness sessions never upload one. The optimizer treadmills until the 3600s skip-after kicks in, burning Claude tokens (and wall-clock) on dead inputs. Yesterday's probe run alone left dozens of stuck entries in the state file.

**Files.**
- `scripts/session-optimizer.sh` — poll loop, around the `aws s3 ls session-analytics/` block (`for SESSION_PATH in $SESSIONS` ~line 1845). Apply the basename check in BOTH the main poll iteration AND the audit/re-inject path that adds `AUDIT_PATH` to `first_seen`.
- One-time cleanup of stuck harness entries in `~/.certmate/optimizer_state.json`. The state file mutates `first_seen`, `retry_counts`, and `processed_sessions` keys keyed by full S3 path; harness entries pollute the first two. Concrete one-shot:

  ```sh
  jq '
    .first_seen   |= with_entries(select(.key | test("/harness_") | not))
    | .retry_counts |= with_entries(select(.key | test("/harness_") | not))
  ' ~/.certmate/optimizer_state.json > ~/.certmate/optimizer_state.json.tmp \
    && mv ~/.certmate/optimizer_state.json.tmp ~/.certmate/optimizer_state.json
  ```

  Leave `processed_sessions` alone — it's append-only, bloat-tolerant, and editing it risks re-processing real sessions.

  **Verification one-shot after applying both fixes**: `jq '.first_seen | keys[]' ~/.certmate/optimizer_state.json | grep -E '/[^/]*harness_[^/]*$'` should return empty (basename-anchored — same scope as the poll filter, so the check is consistent if a future S3 layout ever places `harness_` elsewhere in the path). If non-empty, the cleanup pass missed entries — re-run.

**Effort.** 30 min. Mostly a regex + a state-cleanup snippet.

**Risks.** Genuine sessions starting with `harness_` (none in practice — Derek's iOS app uses UUIDs).

### Item 2 — Flip Nova-3 → Flux in the prompt; drop the boost-suffix tier logic

**What.** Rewrite the "KEYWORD TOKEN BUDGET" section of `scripts/optimizer-prompt-session.md` from Nova-3 facts to Flux facts:

| Before | After |
|---|---|
| "Deepgram Nova-3 has a 500-TOKEN limit" | "Flux has **two distinct keyterm paths with different budgets** — keep them straight: (1) **Session-start keyterms** are URL query params passed at WebSocket open; `DeepgramService.buildFluxURL` (~line 1308) silently *truncates* the keyterm list at `DEEPGRAM_MAX_URL_LENGTH = 2000` chars (`DeepgramService.swift:48`, rationale 18-47). In the current bundled config that's roughly 95 keyterms. (2) **Focused-mode Configure keyterms** are JSON array entries in a `keyterms` field of the Configure message; `DeepgramService.mergeFocusedKeyterms` (~line 1244) caps the final array at 100 entries. Recommendations must preserve critical terms under BOTH caps. There is NO 'rejected at Configure-send time' — both caps are silent truncation. The optimizer should reference `DeepgramServiceTests.testKeytermURLBudgetUnderCap` for the URL-budget regression test." |
| "Tier 1 (boost >= 2.0) sent WITH boost suffix" | "Boost suffixes are stripped on Flux — boost numbers act only as inclusion priority when the URL hits its char cap." |
| "Tier 2 (boost < 2.0) sent as PLAIN keyterm" | "All entries are sent as plain keyterms regardless of `:boost` value." |

Drop the "two-tier" framing entirely. Replace with one paragraph explaining that Flux uses the keyterm list as a vocabulary hint, not an acoustic-bias multiplier, and that the right knob for per-slot vocabulary is **focused-mode Configure** (see Item 5).

**Why.** Every "Bump 'test voltage' keyword boost from 1.5 to 2.5"–style recommendation from the past month is built on a false model. Claude is solving the wrong problem. This is the single biggest dishonesty in the prompt right now.

**Files.**
- `scripts/optimizer-prompt-session.md` lines 40-50 (the KEYWORD TOKEN BUDGET heading + its 7 bullets). The two-tier framing also repeats at line 58 (KeywordBoostGenerator file-list comment under "Current code reference") and line 168 (the `keyword_boost` category description) — all three locations must be rewritten in lockstep, otherwise Claude will still see "two-tier" language and act on it.
- `scripts/session-optimizer.sh` lines 1061-1086 and 1175-1199 — the Nova-style `TOKEN_BUDGET=450` / `KEYWORD_TOKENS` Python computation reads from `$IOS_DIR/Resources/default_config.json` (line 1064). This path is **stale**: the live bundled config is `$IOS_DIR/Sources/Resources/default_config.json` — fix the path AND the computation in one pass.

  Replace the Python computation with separate raw and sent estimates so the prompt surfaces truncation pressure rather than masking it. **Drop `TOKEN_BUDGET` / `TOKEN_HEADROOM` entirely** — Flux has no token budget. Add these template vars instead:

  - `{{KEYTERM_RAW_COUNT}}` — total keyterms in the bundled `default_config.json` (uncapped).
  - `{{KEYTERM_GENERATOR_SENT_COUNT}}` — after iOS-side dedupe/sort/cap-100 (matching `KeywordBoostGenerator.dedupAndCap`); approximated as `min(100, KEYTERM_RAW_COUNT)`.
  - `{{KEYTERM_URL_CHARS_ESTIMATE}}` — sum of `len(URL-encoded(kw)) + 11` per keyterm (10 chars for `&keyterms=` + 1 buffer for URL-encoding overhead from spaces / punctuation). Acknowledged as a static heuristic — Deepgram's URL-encoding is "best effort", and the optimizer can't read the actual runtime URL the iOS client builds.
  - `{{KEYTERM_URL_ESTIMATED_SENT_COUNT}}` — count of keyterms that would survive `buildFluxURL`'s truncation at `DEEPGRAM_MAX_URL_LENGTH = 2000`, walking the priority-sorted list and stopping when the estimate exceeds 2000.
  - `{{KEYTERM_CONFIGURE_CAP_REMAINING}}` — Configure cap headroom AFTER `FocusedAnswerKeyterms.all` is prepended. `enterFocusedAnswerMode` (`DeepgramService.swift:~1058`) calls `mergeFocusedKeyterms(essential: FocusedAnswerKeyterms.all, session: sessionKeyterms, cap: 100)` — the 58 focused-essential terms (digits 1-50 + ~8 sentinels) are prepended FIRST, leaving `100 - 58 = 42` slots for session keyterms. Compute as `max(0, 100 - FOCUSED_KEYTERM_ESSENTIAL_COUNT - KEYTERM_GENERATOR_SENT_COUNT)`. Also surface `{{FOCUSED_KEYTERM_ESSENTIAL_COUNT}}` (read from `FocusedAnswerKeyterms.swift` `digits.count + sentinels.count` — currently 58 — verify at implementation time) and `{{KEYTERM_CONFIGURE_SESSION_DROPPED_COUNT}}` (how many session keyterms get truncated by focused-mode merge after essentials). Without these the prompt would tell Claude there are 95+ Configure slots available when in practice 42 is the binding ceiling for focused-mode.
  - `{{KEYTERM_URL_CAP_REMAINING}}` = `95 - KEYTERM_URL_ESTIMATED_SENT_COUNT` (soft URL-char-derived headroom).

  Update the prompt heading at line 40 + bullets to: (a) reference the new var names; (b) warn explicitly when `KEYTERM_RAW_COUNT > KEYTERM_GENERATOR_SENT_COUNT` (terms being dropped before send); (c) instruct Claude to preserve high-priority terms before suggesting any new session-level keyterm.

  Also: update `scripts/optimizer-prompt-session.md` line 59 from `CertMateUnified/Resources/default_config.json` to `CertMateUnified/Sources/Resources/default_config.json`. The `CertMateUnified/Resources/default_config.json` copy is **stale** (different keyterm data + budget notes) and must not be used for optimizer recommendations.

  **Downstream report-surface lockstep** (caught late; easy to miss): `session-optimizer.sh` line ~1604 in `generate_implementation_plan()` currently emits the success-criterion `- Deepgram keyword boost budget stays under 450 tokens.` for `keyword_boost` / `keyword_removal` / `config_change` recommendations — Nova-era language that contradicts the rewritten prompt. Replace with two Flux-relevant lines: `- Deepgram session-start keyterms stay under the 2000-char URL budget (DEEPGRAM_MAX_URL_LENGTH).` and `- Focused-mode Configure keyterms stay under 100 total after merging FocusedAnswerKeyterms.all essentials (~58 reserved → ~42 session-keyterm slots).` Update the stale `CertMateUnified/Resources/default_config.json` reference in the same function (and anywhere else that grep finds it in `scripts/`) to `Sources/Resources/default_config.json`. Also: `scripts/generate-report-html.js` ~line 115 labels the STT cost line as "Deepgram Nova-3" — update to "Deepgram Flux" (or a model-agnostic "Deepgram" label) so the rendered report stops mis-attributing cost to a model the optimizer hasn't used in months.

**Effort.** 1 hour (re-read Flux docs + rewrite the section + update the category description for `keyword_boost` lower down).

**Risks.** Prompt-length increase if we explain Flux mechanics verbosely; offset by killing the tier-1/tier-2 paragraph. Net should be neutral or slightly shorter. Also: recommendations that push total session-start keyterms over the ~95 char-derived ceiling will be **silently truncated** by `buildFluxURL` — bake both caps (URL-truncation at 95 estimated, Configure-array hard 100) into the prompt explicitly so Claude doesn't propose configurations that lose terms silently. There is no rejection event to debug against; only the unit test (`testKeytermURLBudgetUnderCap`) catches over-cap session-start configs at build time.

### Item 3 — Add dialogue engine + new code paths to "Current code reference"

**What.** Extend the file list in the prompt to include the schemas, parsers, dispatcher validators, and Flux Configure path:

```
- src/extraction/dialogue-engine/schemas/{ocpd,rcd,rcbo,ring-continuity,insulation-resistance}.js
  — schema definitions for the active walk-through paths
- src/extraction/dialogue-engine/parsers/{amps,bs-code,circuit-range,ka,ma,mcb-type,megaohms,ms,ohms,rcd-type,voltage}.js
  — value parsers (full set of 11); bare-bridge value groups live here. Note: there is NO `insulation-resistance.js` parser — insulation-resistance is exclusively a schema (`src/extraction/dialogue-engine/schemas/insulation-resistance.js`), not a parser.
- src/extraction/dialogue-engine/helpers/extraction.js
  — named-field extractor; multi-group capture rules
- src/extraction/loaded-barrel-speculator.js
  — pre-fill speculator
- src/extraction/stage6-dispatch-validation.js
  — numeric-range / value-enum dispatcher guards
- src/extraction/field-name-corrections.js
  — canonical ↔ legacy field-name table
- CertMateUnified/Sources/Services/DeepgramService.swift
  — Flux Configure / focused-mode Configure path
- tests/fixtures/voice-latency-scenarios/{garbles,schema_ambiguity,dispatcher_gaps}/
  — harness probes — read these to learn the bug-class shapes already known
```

Mark each with a sentence on what to look at and when. Keep the legacy files (`TranscriptFieldMatcher.swift`, `NumberNormaliser.swift`, etc.) but reframe them as "secondary / pre-LLM-gate path".

Additionally, soften the three explicit regex-first nudges in THIS PR (rather than waiting for Item 5 to land them) — otherwise the gap between Cluster 1 and Cluster 2 shipping leaves a known-misleading prompt active:

- `scripts/optimizer-prompt-session.md` line 78 — `### CORE PRINCIPLE: REGEX-FIRST` header → change to `### CORE PRINCIPLE: EXTRACTION-PATH-AWARE`, and add a one-sentence forward reference to the decision tree Item 5 will introduce. (Grep for the literal string `CORE PRINCIPLE: REGEX-FIRST` if the line number has drifted.)
- `scripts/optimizer-prompt-session.md` line 98 — priority-1 `1. **Regex miss** (MOST LIKELY):` → change to `1. **Regex miss** (for board-level / installation fields only):`. (Same grep fallback if the line has drifted.)
- `scripts/optimizer-prompt-session.md` line 168 — the `keyword_boost` category description → rewrite to drop the two-tier framing (this is the same rewrite Item 2 requires; coordinate the edit).

(Line numbers 78 + 98 above match Item 5's "lines 78-110" citation for the same section — they refer to the same block. An earlier draft of this Item 3 had stale numbers (44 + 64) carried over from a pre-Stage-6 version of the prompt; the current file is at 78 + 98 as of this plan's last verification.)

The full decision-tree replacement lands in Item 5; this PR softens, not rewrites. Also add `CertMateUnified/Sources/Recording/FocusedAnswerKeyterms.swift` to the file list alongside `DeepgramService.swift` — that's where per-slot keyterm subsets live (consumed by the Configure path; see Item 4's `flux_configure_keyterms_per_slot` category).

**Why.** Yesterday's L-L=2 fix tightened `insulation-resistance.js`'s namedExtractor by splitting it into two value-group arms. The optimizer can't propose that today because it doesn't know those files exist — and Claude won't Read files outside the listed set per the prompt's instructions.

**Files.** `scripts/optimizer-prompt-session.md` "Current code reference" section.

**Effort.** 30 min — mostly typing the bullet list + a 1-sentence "when to read this" per entry.

**Risks.** None.

**Cluster 1 verification.** Run optimizer manually on the last 2-3 real sessions and confirm:
- No `harness_*` sessions enter the queue.
- Claude no longer mentions `:boost` tiers in recommendations.
- At least one recommendation references a `dialogue-engine/` file.

---

## Cluster 2 — Architectural awareness (1–2 days)

Goal: teach Claude not just *what* files exist, but *which path* a given symptom lives on, and *what shape* of recommendation to emit. Without this, even with Cluster 1 the recommendations stay shaped like "add a regex".

### Item 4 — Add new categories

**What.** Extend the `category` enum in `scripts/optimizer-prompt-session.md` (in BOTH the bulleted category list at lines 165-173 AND the JSON-output schema enum literal at line 183 — without the line-183 update, Claude emits new categories that fail output validation) plus the HTML report renderer in `scripts/generate-report-html.js` plus the `REC_CAT` short-label switch in `session-optimizer.sh` (the `case "$REC_CAT" in` block opens at ~line 1302) with these new values:

| New category | When to use |
|---|---|
| `dialogue_engine_schema_tighten` | Schema regex over-matches or under-matches; bare-bridge form needs a `MEGAOHMS_BARE_SAFE_VALUE_GROUP`-style tighten; a trigger needs a new alternation. Yesterday's L-L=2 fix would have been this. |
| `dialogue_engine_schema_extend` | Schema needs a new slot, new derivation, or new postCompletionAsk. Distinct from `_tighten` because the shape of the change is different. |
| `dispatcher_validator` | `stage6-dispatch-validation.js` needs a new range guard, value-enum, or invalid-field check. Audit Phase 1 numeric-range validator was this shape. |
| `flux_configure_keyterms_per_slot` | iOS Configure message should push a different keyterm subset on entering a specific ask. Distinct from `keyword_boost` which targets the session-level default. **DORMANT until prerequisite lands**: `CertMateUnified/Sources/Recording/FocusedAnswerKeyterms.swift` currently exposes a *single global static list* (`FocusedAnswerKeyterms.all`) — there is no per-slot map and `enterFocusedAnswerMode` (DeepgramService.swift ~line 1058) only accepts `sessionKeyterms`, not a `field`. Per-slot keyterm support is explicitly **out of scope** (see "Out of scope" section). Until a separate iOS sprint adds `FocusedAnswerKeyterms.keyterms(for: slotField)` and threads `field` through `enterFocusedAnswerMode`, recommendations under this category must surface as **advisory only** ("If a per-slot keyterm map existed, the slot for field X would benefit from keyterm Y") and NOT carry concrete `old_code`/`new_code` blocks. The report renderer must visibly tag these as `awaiting infrastructure`. The send path schema lives at `DeepgramService.swift:94-138` (types); the actual send is `sendConfigureMessage` (~line 803) and `enterFocusedAnswerMode` (~line 1058) — optimizer recommendations must NEVER edit any of those. |
| `flux_eot_threshold` | Per-ask `eot_threshold` / `eot_timeout_ms` tuning via Configure. Right place to recommend faster commit on terse-reply slots. Recommendation payload MUST use the canonical Flux key names: `eot_threshold` (0.5-0.9), `eot_timeout_ms` (500-10000), `eager_eot_threshold` (0.3-0.9, optional). NOT `eot_confidence` — that was a v2 draft mistake (see DeepgramService.swift:130-133 — the Thresholds struct comment block inside FluxConfigureMessage). **Rollback constraint** (must be encoded in the prompt): the global focused-mode defaults `0.7 / 5000ms` were chosen after split-final regressions when tighter values were tried; do NOT recommend changing the global values in `enterFocusedAnswerMode`. Only recommend a *future per-slot threshold table* — and only when (a) replay evidence exists on the affected scenario, AND (b) a 20-30x harness probe sweep shows no regression — before suggesting any value below the current defaults. |
| `loaded_barrel_speculator_hint` | Speculator's `onToolUseStreamed` hook should pre-fill another field shape. |
| `field_name_correction_add` | A canonical Sonnet name leaked to iOS unmapped — add it to `FIELD_CORRECTIONS`. |
| `harness_probe` | The session reveals a bug class worth a new probe scenario; either alongside or instead of a code recommendation. (Pairs with Item 8.) Surfaces in the HTML report as a separate "Suggested regression probes" section, not as a badge in the main code-change list — update `scripts/generate-report-html.js` to render that section. |

Update each existing category description to explicitly say "use only when the symptom can't be addressed via one of the new categories above".

**Schema split for advisory categories.** Three of the new categories — `flux_configure_keyterms_per_slot`, `flux_eot_threshold`, `harness_probe` — must NOT carry concrete `old_code` / `new_code` blocks (the first two because the consumer infrastructure doesn't exist yet; the third because it's a regression-probe scenario, not a code change). The existing prompt at `scripts/optimizer-prompt-session.md` lines 125-128 + the output-schema example require `old_code` and `new_code` on every recommendation. If left unchanged, Claude will fabricate diffs for these advisory categories. Update the prompt:

- Add a new optional field `implementation_status: "implementable" | "awaiting_infrastructure" | "probe_only"` to the recommendation schema. Default `"implementable"` to preserve existing behaviour.
- Mark `flux_configure_keyterms_per_slot` and `flux_eot_threshold` as `"awaiting_infrastructure"` and `harness_probe` as `"probe_only"`.
- Make `old_code` / `new_code` REQUIRED only when `implementation_status == "implementable"`; FORBIDDEN otherwise. Add an explicit instruction: "For non-implementable categories, emit `metadata` (a JSON object describing the suggested shape). For `harness_probe`, `metadata` carries the probe template id, suggested scenario id, and the bug-class signature it would pin."
- **`generated_probe_path` is OPTIONAL and populated only by the optimizer post-hoc — Claude never emits it.** When Item 8 (Cluster 3) lands and successfully writes a probe YAML, the optimizer post-processes the matching `harness_probe` recommendation and injects `generated_probe_path` pointing at the written file. If Cluster 2 ships independently before Cluster 3, the field is simply absent — the renderer must show a link only when `generated_probe_path` is present, never fabricate one. (Avoids the bug where Cluster 2 standalone would have Claude inventing probe paths that don't exist on disk.)
- `scripts/generate-report-html.js` and the `generate_implementation_plan()` codepath must reject any `accept` action targeting an index whose recommendation has `implementation_status != "implementable"` — silently filter them out of accept-selected, render them in their own non-actionable sections, no checkboxes / no accept controls.

**Why.** Without these, every protective-device or IR bug gets shoehorned into `regex_improvement` (TranscriptFieldMatcher.swift) — which is the wrong layer.

**Files.**
- `scripts/optimizer-prompt-session.md` — THREE locations in this file must be extended in lockstep, otherwise Claude emits new categories that fail downstream parser / consumer checks: (1) the categories list + descriptions at lines 165-173; (2) the JSON-output schema category enum literal at line 183 (`"category": "regex_improvement|number_normaliser|..."`); (3) the `category` note at ~line 202 currently saying "must be one of the 8 categories listed above" — rewrite to "must be one of the categories listed above" (avoids hard-coding any count and stays correct as the enum grows).
- `scripts/generate-report-html.js` — extend `CATEGORY_COLORS` (lines 72-80) with the 8 new entries. **Pre-flight fix**: the existing table is already missing `keyword_removal` (it appears in the prompt categories at line 169 AND the REC_CAT switch at line 1310, but has no badge). Add `keyword_removal` first as a baseline fix before adding the 8 new entries; otherwise the new-entry PR also lands the existing baseline bug. Additionally, split the recommendations array on render: filter by the new `implementation_status` field (see Item 4 "Schema split for advisory categories" above) — `implementable` entries go into the existing checkbox/accept/reject flow with `old_code`/`new_code` blocks; `awaiting_infrastructure` (currently `flux_configure_keyterms_per_slot`, `flux_eot_threshold`) goes into an "Advisory — awaiting infrastructure" section with no accept controls; `probe_only` (currently `harness_probe`) goes into "Suggested regression probes" with no accept controls. `acceptSelected()` MUST silently filter out any non-`implementable` indices even if submitted.
- `scripts/session-optimizer.sh` — Pushover `REC_CAT` short-label switch at `case "$REC_CAT" in` line 1302. **Remove the `| head -c 20` truncation on line 1301** (`REC_CAT=$(echo "$rec_line" | jq -r '.category // ""' | head -c 20)`) — several new categories are longer than 20 chars (e.g. `dialogue_engine_schema_tighten` = 30, `flux_configure_keyterms_per_slot` = 32, `loaded_barrel_speculator_hint` = 29) and the truncation silently breaks the `case` match. Only truncate the rendered label/explanation if needed (`REC_EXPLAIN` already has `head -c 120` on line 1299; that's fine).

  **Short-label mapping for the 8 new categories** (Pushover-length-constrained, ≤10 chars; these MUST match the `.label` strings in `CATEGORY_COLORS` in `generate-report-html.js` — single source of truth for category display names across the optimizer):

  | category | REC_CAT short label | CATEGORY_COLORS .label |
  |---|---|---|
  | `dialogue_engine_schema_tighten` | `DE Tighten` | `DE Tighten` |
  | `dialogue_engine_schema_extend` | `DE Extend` | `DE Extend` |
  | `dispatcher_validator` | `Validator` | `Validator` |
  | `flux_configure_keyterms_per_slot` | `Per-Slot KT` | `Per-Slot KT` |
  | `flux_eot_threshold` | `EOT Thresh` | `EOT Thresh` |
  | `loaded_barrel_speculator_hint` | `Speculator` | `Speculator` |
  | `field_name_correction_add` | `Field Map` | `Field Map` |
  | `harness_probe` | `Probe` | `Probe` |
- **No `parse-optimizer-output` change required.** Verified: `scripts/parse-optimizer-output.cjs` performs no category validation (it only extracts and repairs JSON); `scripts/__tests__/parse-optimizer-output.test.mjs` only asserts on category in one passing-through fixture. The closed-allowlist surfaces are `CATEGORY_COLORS` (generate-report-html.js) and the `REC_CAT` switch (session-optimizer.sh) — two files plus the prompt enum, not three.

**Final category enum (line 183 after extension — 16 entries total)**: the pipe-delimited list must contain the 8 existing categories (`regex_improvement`, `number_normaliser`, `keyword_boost`, `keyword_removal`, `sonnet_prompt_trim`, `sonnet_prompt_addition`, `config_change`, `bug_fix`) plus the 8 new (`dialogue_engine_schema_tighten`, `dialogue_engine_schema_extend`, `dispatcher_validator`, `flux_configure_keyterms_per_slot`, `flux_eot_threshold`, `loaded_barrel_speculator_hint`, `field_name_correction_add`, `harness_probe`). Verify the count before merging — Claude will silently drop any category absent from this enum.

**Effort.** 2-3 hours. Mostly straightforward enum extension across three files.

**Risks.** Confusion between `dialogue_engine_schema_tighten` and `regex_improvement`. Mitigation: explicit "if the field is captured by a dialogue-engine schema slot, use the dialogue_engine_* category, not regex_improvement" rule.

### Item 5 — Add a DIALOGUE-ENGINE-FIRST decision tree to the prompt

**What.** Replace the prompt's current "CORE PRINCIPLE: REGEX-FIRST" section with a decision tree:

```
For every missed value, ask in this order:

1. Was this a protective-device, ring-continuity, or IR-related field?
   → If yes, the dialogue-engine schema owns the capture. Categories:
     dialogue_engine_schema_tighten / _extend / dispatcher_validator.
     Do NOT propose a TranscriptFieldMatcher regex — that path is
     downstream and will be ignored for these field families.

2. Was the value missed because Flux mis-heard a single technical word
   (cooker → cucumber, RCD → RCT, Zs → Zen-s)?
   → If yes, options are (in priority order):
     a) flux_configure_keyterms_per_slot — push a slot-specific
        keyterm at Configure time.
     b) bug_fix in iOS NumberNormaliser to rewrite the garble.
     c) keyword_boost (session-level default) — last resort; Flux
        only uses it as inclusion priority.

3. Was the value out-of-enum / out-of-range when it landed?
   → dispatcher_validator (audit Phase 1 shape).

4. Was the value sent to iOS with a canonical name iOS doesn't decode?
   → field_name_correction_add.

5. Was this a board-level / installation field (Ze, PFC, MCB rating
   on the supply, etc.)?
   → THEN check TranscriptFieldMatcher.swift + the legacy regex
     path. regex_improvement / number_normaliser / keyword_boost
     apply here.

6. Did Sonnet not see the value at all (transcript wasn't forwarded,
   field not in prompt)?
   → sonnet_prompt_addition / sonnet_prompt_trim.

7. None of the above?
   → bug_fix.
```

Keep the "FORBIDDEN RECOMMENDATIONS" section (the active-circuit-expiry one) as-is; it's still valid.

**Why.** Without an explicit routing rule, Claude defaults to the loudest section of the prompt — which is currently "REGEX-FIRST" pointing at TranscriptFieldMatcher.swift. Every protective-device bug then gets misrouted there.

**Files.** `scripts/optimizer-prompt-session.md` (lines 78-110 — the "CORE PRINCIPLE" + "1. Scan utterance-level data" sections).

**Effort.** 3-4 hours. Needs care to balance prescriptive vs flexible. Worth running by Codex review before landing.

**Risks.** Over-prescription forces Claude into the wrong category when the symptom is genuinely cross-cutting. Mitigation: each step has an "if uncertain, fall through to the next" escape.

### Item 6 — `analyze-session.js` extracts per-slot Flux focused-mode + dialogue-engine state

> **Prerequisite (structural — caught in R9; do not skip): backend telemetry ingestion path.** Today `session-optimizer.sh` only downloads iOS-side S3 artifacts (`debug_log.jsonl`, `field_sources.json`, `manifest.json`, `job_snapshot.json`, `cost_summary.json`). The dialogue-engine `stage6.*_script_*` events AND the `stage6_tool_call` rows that Item 6's `dialogue_engine_transitions` and `stage6_tool_calls` arrays depend on are emitted by the BACKEND logger (`src/extraction/insulation-resistance-script.js:552/650/714`, `src/extraction/stage6-dispatcher-logger.js:95` and siblings) and are NOT present in the uploaded iOS debug log. Without solving this, Item 6's two new sections will be empty for every session and Item 7's signature detectors will never match. Three options for the ingestion path — pick one explicitly before Item 6 starts:
>
> 1. **CloudWatch Logs query** by `sessionId` during `process_session` (lowest infrastructure change, but adds AWS query latency + IAM perms to optimizer). Filter to `stage6.*` event names; download the matching rows into a `backend_events.jsonl` sidecar in the work dir.
> 2. **Backend writes a sanitised event tape to the session's S3 prefix** at session-close (one `backend_events.jsonl` per session next to `debug_log.jsonl`). Requires a small backend change in `src/extraction/sonnet-stream.js`'s session-close path; survives CloudWatch log expiry.
> 3. **Backend emits sanitised diagnostics back through the ServerWebSocket** to iOS, where they land in iOS's `debug_log.jsonl` alongside the local events (requires extending the existing `client_diagnostic` reverse channel from `iOS → backend` to `backend → iOS`; widest blast radius).
>
> **Recommended path**: (2) — purpose-built sidecar, no AWS API contract change, no iOS round-trip. Backend writes are append-only during the session and one `S3 PutObject` at close. Verify the `eicr/api-keys` S3 IAM scope allows the backend role to write to `session-analytics/{userId}/{sessionId}/` before locking the choice. Effort: ~half a day backend + a small `session-optimizer.sh` change to `aws s3 cp` the new file. Item 6's `analyze-session.js` work proceeds against this sidecar; without the sidecar, Item 6 ships dead code.


**What.** Add three new sections to the analysis output:

- `focused_mode_timeline`: an array of `{at_ms, tool_call_id, slot_field, keyterm_count, enter_elapsed_ms, exit_reason}` rows pulled from `focused_mode_enter` / `focused_mode_enter_result` / `focused_mode_exit` events. Each row is one entry into a focused ask.

  **Decision (resolves an open implementation choice — context summary section 6 says no questions remain, so this lands as a decision not a deferral): take the iOS telemetry path.** The current iOS log for `focused_mode_enter` carries only `toolCallId` and `sessionKeytermCount`; `inflight_question_anchored` carries no `field` / `circuit` / `toolCallId`, so `slot_field` cannot be reliably populated from the existing stream. Extend `DeepgramRecordingViewModel.handleAlertTTSStarted` (around line 3186) to include `field`, `circuit`, and `toolCallId` in both: (a) the `debugLogger.info("inflight_question_anchored", ...)` call around line 3219, and (b) the `focused_mode_enter` / `focused_mode_enter_result` client diagnostics around lines 3268-3296. This is the only iOS-side edit in scope for this plan and is a **hard prerequisite** for `flux_garble_single_word` detection. Note: line numbers should be verified at implementation time — `DeepgramRecordingViewModel.swift` evolves quickly. The alternative (emit `slot_field: null` and degrade signature anchoring to unanchored substring matching) was considered and rejected because it produces a worse Item 7 outcome with negligible savings.
- `dialogue_engine_transitions`: an array of `{at_ms, schema, event, circuit_ref, slot, values_snapshot}` rows for events whose names start with the actual `logEventPrefix` values defined in `src/extraction/dialogue-engine/schemas/*.js`: `stage6.ocpd_script`, `stage6.rcd_script`, `stage6.rcbo_script`, `stage6.ring_continuity_script`, `stage6.insulation_resistance_script`. Capture all suffixes that affect routing — `_entered`, `_entered_from_sonnet_write`, `_completed`, `_cancelled`, `_topic_switch`, `_disambiguation_retry`, etc. (Grep the schema files for `logEventPrefix` to enumerate exhaustively at implementation time — the canonical list lives in the code, not the plan.) **`values_snapshot` MUST be populated from the event's `data.values` field VERBATIM** — keep raw schema field names (e.g. `ir_live_live_mohm`, NOT a display label like "L-L"). The engine emits `values: { ...state.values }` on completion; preserving the raw shape is what makes signature detectors like Item 7's `ir_bare_bridge_single_digit` work. This is the engine's state machine viewed as a tape.
- `bug_signature_hits`: a list of known bug-class signatures observed (Item 7 builds the matchers; this is the surface for them).
- `unmapped_readings`: an array of `{at_ms, field, value, source}` rows aggregated from iOS-side `unmapped_field_buffered` (`DeepgramRecordingViewModel.swift:5759` — `source: "field_buffered"`) and `unmapped_readings_at_end` (line 1614 — `source: "end_of_session"`) events. Item 7's `canonical_name_leak_to_ios` detector reads from this section; without it that detector has no defined input. Source events are already in iOS `debug_log.jsonl` — no telemetry contract extension needed for this section (in contrast to the `stage6_tool_calls` section which depends on the backend sidecar prerequisite).

Then pass these into the prompt as new template variables so Claude can correlate "the user mis-spoke during focused-mode for slot X, vocabulary Y" with "field X ended up empty".

**Why.** Right now Claude sees a flat transcript + sonnet-IO + uncaptured values. It can't see which ask was active when a Flux mis-hear happened, or which dialogue-engine state was being processed. The L-L=2 bug class is *invisible* to the current analyzer.

**Files.**
- `scripts/analyze-session.js` — add new sections (`focused_mode_timeline`, `dialogue_engine_transitions`, `bug_signature_hits`, `stage6_tool_calls`) to the output structure + parsing logic for the new event names. The `stage6_tool_calls` array (referenced by Item 7's `value_out_of_enum_no_validator` detector) preserves `{at_ms, tool, outcome, validation_error, input_summary}` from underlying `stage6_tool_call` events; it sits alongside the existing aggregated `tool_count` / `validation_error_count` summary at line ~916.
- `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` — telemetry-only iOS edit (the Decision above). Extend the payloads of `inflight_question_anchored`, `focused_mode_enter`, `focused_mode_enter_result`, AND `focused_mode_exit` to include `field`, `circuit`, and `toolCallId`. Without `focused_mode_exit` carrying the same join keys, the analyzer cannot safely match enter/exit pairs when entries overlap or focused-mode resets occur (Codex R4 catch). Treat all four event payloads as a single contract change.
- `src/extraction/sonnet-stream.js` (BACKEND prerequisite — recommended path 2 from the prerequisite block at the top of this item) — at session-close, write `backend_events.jsonl` to `s3://eicr-session-analytics/session-analytics/{userId}/{sessionId}/backend_events.jsonl` containing the engine + dispatcher logger events the analyzer needs (`stage6.*_script_*`, `stage6_tool_call`, plus any related guard events). Sanitise payloads — drop user-uttered transcript content not already in the engine event payload. Verify the backend's IAM role can `PutObject` to that prefix before locking the choice.
- `scripts/session-optimizer.sh` download stanza (around the existing `aws s3 cp debug_log.jsonl` block) — add a matching `aws s3 cp ... backend_events.jsonl 2>/dev/null || true` so sessions recorded BEFORE the backend PR lands still process — they'll produce empty `dialogue_engine_transitions` / `stage6_tool_calls` arrays rather than erroring. Match the existing `2>/dev/null || true` pattern already used elsewhere in this file (e.g. lines 1892-1896). **Do not invent a `--no-error-on-missing` flag — `aws s3 cp` has no such flag; suppress missing-object errors at the shell level only.**
- `scripts/session-optimizer.sh` around the `process_session` JSON-vars builder (lines ~1175-1199 region where existing template vars like `KEYWORD_COUNT` / `TOKEN_BUDGET` are populated via `jq --arg` and emitted into the flat vars file consumed by `render-prompt.cjs`). Add new flat keys `FOCUSED_MODE_TIMELINE`, `DIALOGUE_ENGINE_TRANSITIONS`, `BUG_SIGNATURE_HITS`, `UNMAPPED_READINGS` populated by extracting the matching arrays from `analysis.json`. No change to `render-prompt.cjs` itself is needed.

  > **NOTE — load-bearing constraint.** `render-prompt.cjs` is a flat `{KEY: stringValue}` substituter. Any nested JSON structure (the new timeline / transitions / signature-hits arrays are all nested) MUST be pre-stringified — `jq -c` or equivalent — before being passed as a template var. Pass it raw and the placeholder renders as `[object Object]`; this is a silent failure mode.
- `scripts/optimizer-prompt-session.md` — add `{{FOCUSED_MODE_TIMELINE}}` / `{{DIALOGUE_ENGINE_TRANSITIONS}}` / `{{BUG_SIGNATURE_HITS}}` / `{{UNMAPPED_READINGS}}` template variables in new section headers ("FOCUSED-MODE TIMELINE", "DIALOGUE ENGINE STATE", "AUTO-DETECTED BUG SIGNATURES", "DROPPED iOS READINGS").

**Effort.** 1.5 days end-to-end — 1 day optimizer-side (analyzer extensions + template var wiring + session-optimizer.sh download stanza + the iOS telemetry payload extension) plus 0.5 day backend-side for the `backend_events.jsonl` sidecar writer in `sonnet-stream.js`. Existing unit tests in `scripts/__tests__/analyze-session.test.mjs` provide the optimizer-side regression bed; backend side needs a small test in `src/__tests__/sonnet-stream-*.test.js` covering the session-close sidecar write.

**Risks.** Output size growth — currently the prompt is bounded. Mitigation: cap each new section at N events (most-recent + most-relevant via uncaptured-value correlation).

**Cluster 2 verification.** Force a re-process of yesterday's session 284CBBCD — by the time Cluster 2 lands, 284CBBCD is already in `processed_sessions` in `~/.certmate/optimizer_state.json`, so the optimizer will skip it unless re-injected. Either: (a) delete the `processed_sessions` entry for 284CBBCD via `jq 'del(.processed_sessions[] | select(. | test("284CBBCD")))' ~/.certmate/optimizer_state.json > .tmp && mv .tmp ~/.certmate/optimizer_state.json` (note the explicit `. |` before `test` — required because `processed_sessions` is an array of strings and `test()` needs its input piped in) then wait one poll cycle, or (b) use the existing audit/re-run mechanism — the actual `first_seen` re-inject jq write is at `scripts/session-optimizer.sh` ~line 2166 (line 2142 is the "skip if currently being tracked" guard that PREVENTS re-injection; the missed-sessions audit loop must bypass it by deleting any existing entry first).

**Verification split** — re-processing a historical S3 session cannot backfill telemetry that wasn't emitted at the original recording time. Run the verification in two parts:

- Against historical 284CBBCD: verify (i) at least one recommendation in the new `dialogue_engine_schema_tighten` category, (ii) the decision-tree-driven routing puts the L-L=2 symptom on the dialogue-engine path (not TranscriptFieldMatcher). Expect `focused_mode_timeline.slot_field` to be **null** for every row — historical logs predate the iOS telemetry edit; that's correct, not a regression.
- Against a freshly-recorded session (post-iOS-telemetry-PR TestFlight build): verify `focused_mode_timeline.slot_field` is non-null and `flux_garble_single_word` signature can anchor against it. Synthetic harness fixture is an acceptable substitute if a fresh real session isn't available.

Then confirm:
- At least one recommendation in the new `dialogue_engine_schema_tighten` category.
- `focused_mode_timeline` section in the analysis output is non-empty.
- The decision-tree-driven routing puts the L-L=2 symptom on the dialogue-engine path, not TranscriptFieldMatcher.

---

## Cluster 3 — Per-slot keyterms + bug-class signatures + probe generation (3–5 days)

Goal: the optimizer becomes a force multiplier. It both *identifies* a bug class by signature and *generates* both the recommended code change AND a harness probe that pins the fix. This is where the real time savings appear.

### Item 7 — Bug-class signature recognition

**What.** Add a `KNOWN_BUG_SIGNATURES` registry to `scripts/analyze-session.js`:

```js
// NOTE: every entry carries `auto_pr: false` from day one (Decision 1).
// Flipping a single entry to `auto_pr: true` is the manual-promotion step
// after a watch period; the field is wired but dormant until then.
const KNOWN_BUG_SIGNATURES = [
  {
    id: 'ir_bare_bridge_single_digit',
    detect: (analysis) => {
      // Match: an IR script `_completed` event whose values has a
      // single-digit bare integer (1-9) on ir_live_live_mohm or
      // ir_live_earth_mohm, alongside a sentinel value (string
      // starting with '>') on the sibling slot. This is the exact
      // failure class commit 3c77b1bb tightens (yesterday's L-L=2 fix).
      //
      // Schema field names come straight from the schema definition
      // (src/extraction/dialogue-engine/schemas/insulation-resistance.js:30,106)
      // and the engine's logged event payload `data.values` (engine.js
      // emits `values: { ...state.values }` on completion). The Item 6
      // analyzer must populate `values_snapshot` from `data.values`
      // verbatim (raw schema keys, not display labels like "L-L").
      const events = analysis.dialogue_engine_transitions || [];
      return events.some(e => {
        if (e.schema !== 'insulation_resistance') return false;
        if (!e.event.endsWith('_completed')) return false;
        const ll = e.values_snapshot?.ir_live_live_mohm;
        const le = e.values_snapshot?.ir_live_earth_mohm;
        const llBareSingle = Number.isInteger(Number(ll)) && Number(ll) >= 1 && Number(ll) < 10 && !String(ll).includes('.');
        const leBareSingle = Number.isInteger(Number(le)) && Number(le) >= 1 && Number(le) < 10 && !String(le).includes('.');
        const llSentinel = typeof ll === 'string' && ll.trim().startsWith('>');
        const leSentinel = typeof le === 'string' && le.trim().startsWith('>');
        return (llBareSingle && leSentinel) || (leBareSingle && llSentinel);
      });
    },
    recommend_category: 'dialogue_engine_schema_tighten',
    recommend_shape: {
      file: 'src/extraction/dialogue-engine/schemas/insulation-resistance.js',
      change: 'split namedExtractor into bare-arm using BARE_SAFE_VALUE_GROUP',
      reference_commit: '3c77b1bb',
    },
    probe_template: 'scripts/probe-templates/garbles/probe_ir_bare_bridge_single_digit.yaml',
    auto_pr: false, // promote only after 5+ correct matches and zero false positives in production
  },
  {
    id: 'flux_garble_single_word',
    detect: (analysis) => {
      // Match: transcript contains a known confusion-pair pattern
      // (RCT/RCD, cucumber/cooker, lyve/live, etc.); the wrong word
      // appears in an ask_user_routed_to_engine where the asked
      // field's value vocabulary is well-defined.
    },
    recommend_category: 'flux_configure_keyterms_per_slot',
    recommend_shape: {
      // ADVISORY ONLY — flux_configure_keyterms_per_slot is DORMANT
      // until the per-slot keyterm map infrastructure lands (see
      // Item 4 dormant note). This signature inherits the dormancy:
      // emit a suggested vocabulary mapping in `metadata`, NOT a
      // concrete file/old_code/new_code block.
      metadata: { suggested_keyterm_for_slot: '<inferred from garble pattern>' },
    },
    requires_infrastructure: 'per_slot_keyterm_map', // analyzer + renderer short-circuit on this
    implementation_status: 'awaiting_infrastructure',
    probe_template: 'scripts/probe-templates/garbles/probe_flux_garble_<word>.yaml',
    auto_pr: false,
  },
  {
    id: 'value_out_of_enum_no_validator',
    detect: (analysis) => {
      // Match: a record_reading wrote a value that doesn't match
      // any option in the field's schema; no value_not_in_options
      // rejection fired.
      //
      // TWO PREREQUISITES:
      //
      // (1) BACKEND src/ EDIT — export CIRCUIT_FIELD_VALUE_ENUMS from
      //     `src/extraction/stage6-dispatch-validation.js` line 89.
      //     One-line change: `const CIRCUIT_FIELD_VALUE_ENUMS = (() => {`
      //     → `export const CIRCUIT_FIELD_VALUE_ENUMS = (() => {`.
      //     Verified at file:89 the constant is currently NOT exported
      //     (only BOARD_FIELD_VALUE_ENUMS at line 111 has `export`).
      //     The constant is a `Map<string, Set<string>>` — detector
      //     accessors must use `.get(field)` / `set.has(value)`, NOT
      //     object indexing.
      //
      // (2) BACKEND TELEMETRY INGESTION — `stage6_tool_call` events are
      //     emitted by the BACKEND logger and are NOT in the iOS
      //     debug_log.jsonl. See Item 6's prerequisite block for the
      //     three options (recommended: backend-written sidecar file).
      //     Without that path landing, this detector cannot fire.
      //
      // (3) TELEMETRY CONTRACT EXTENSION — `input_summary` today only
      //     carries `{field, circuit, reason}` (verified at
      //     stage6-dispatchers-circuit.js:137,206,241,263,301 and
      //     stage6-dispatcher-logger.js:78); no `value` field. The
      //     detector below uses `input_summary.value`, so the logger
      //     contract must be extended: add a sanitised `value` field to
      //     accepted AND rejected `record_reading` telemetry. Update
      //     stage6-dispatcher-logger.js's documented schema + the
      //     dispatcher call sites that build input_summary, and add
      //     test coverage (`src/__tests__/stage6-dispatcher-logger.test.js`)
      //     for the new field. Alternative if the value cannot be added
      //     safely (PII risk): correlate via per-turn write patches or
      //     iOS field-set events instead and rewrite the detector.
      //
      // (4) ANALYZER OUTPUT — once (2)+(3) are in place, extend
      //     `scripts/analyze-session.js` to emit a `stage6_tool_calls`
      //     array alongside the existing per-tool summary at line 916.
      //     Each entry preserves `{at_ms, tool, outcome,
      //     validation_error, input_summary}` from the ingested backend
      //     events. (Currently the analyzer aggregates these into
      //     `tool_count` / `validation_error_count`; the detector
      //     needs the per-call rows.)
      //
      // IMPLEMENTATION (after both prereqs). ESM imports — the repo
      // is `"type": "module"` so use `import`, NOT `require()`:
      //
      //   import { CIRCUIT_FIELD_VALUE_ENUMS } from '../src/extraction/stage6-dispatch-validation.js';
      //
      //   const calls = analysis.stage6_tool_calls || [];
      //   const writes = calls.filter(c => c.tool === 'record_reading'
      //     && c.outcome !== 'rejected');
      //   const fieldGotRejected = (field, value) => calls.some(c =>
      //        c.tool === 'record_reading'
      //     && c.outcome === 'rejected'
      //     && c.validation_error?.code === 'value_not_in_options'
      //     && c.input_summary?.field === field
      //     && c.input_summary?.value === value);
      //   return writes.some(c => {
      //     const field = c.input_summary?.field;
      //     const value = String(c.input_summary?.value);
      //     const enumSet = CIRCUIT_FIELD_VALUE_ENUMS.get(field);
      //     if (!enumSet) return false;                 // no enum yet for this field
      //     if (enumSet.has(value)) return false;       // value valid
      //     return !fieldGotRejected(field, value);     // validator missed it
      //   });
      //
      // Analyzer tests must cover: accepted enum value (no match);
      // persisted off-enum value with no rejection (match); rejected
      // off-enum value (no match).
    },
    recommend_category: 'dispatcher_validator',
    recommend_shape: {
      file: 'src/extraction/stage6-dispatch-validation.js',
      change: 'add entry to CIRCUIT_FIELD_VALUE_ENUMS for the offending field',
    },
    probe_template: 'scripts/probe-templates/dispatcher_gaps/probe_<field>_off_enum.yaml',
    auto_pr: false,
  },
  {
    id: 'canonical_name_leak_to_ios',
    detect: (analysis) => {
      // Match: extraction.readings includes a canonical name that
      // (a) is not in `KNOWN_FIELDS` in src/extraction/sonnet-stream.js,
      // (b) is not already mapped in src/extraction/field-name-corrections.js
      //     FIELD_CORRECTIONS, AND
      // (c) is not covered by the iOS dual-alias decoder allowlist for
      //     IR / ring / Zs / cable fields (iOS accepts both canonical
      //     and legacy names for these — a leak is not a bug there).
      // Only emit the recommendation when the value is actually dropped
      // or not decoded on iOS — otherwise it's a noise hit.
      //
      // PREREQUISITE (hard, not inline-fixable — split out as its own
      // sub-step in Item 7's effort budget, BEFORE writing the detector):
      // extract KNOWN_FIELDS into a side-effect-free module
      // (e.g. `src/extraction/known-fields.js`) and expose the iOS
      // dual-alias allowlist from the same module or a new
      // `field-alias-allowlist.js`. Both sonnet-stream.js and this
      // analyzer file then import the constants. Without this step,
      // `analyze-session.js` cannot safely `require('sonnet-stream.js')`
      // (runtime side effects + WebSocket bootstrapping at module load).
      //
      // IMPLEMENTATION TBD after prerequisite lands. ESM imports —
      // repo is `"type": "module"`; do NOT use `require()` (will throw
      // ReferenceError in scripts/analyze-session.js):
      //
      //   import { KNOWN_FIELDS, IOS_DUAL_ALIAS_ALLOWLIST }
      //     from '../src/extraction/known-fields.js';
      //   import { FIELD_CORRECTIONS }
      //     from '../src/extraction/field-name-corrections.js';
      //
      //   // `analysis.extraction?.readings` does NOT exist in the
      //   // current analyzer output (verified). The real evidence of
      //   // dropped fields is logged on iOS as
      //   // `unmapped_field_buffered` (DeepgramRecordingViewModel.swift:5759)
      //   // and `unmapped_readings_at_end` (line 1614) — both ARE
      //   // present in iOS debug_log.jsonl. analyze-session.js must
      //   // surface an `unmapped_readings` section pulling these two
      //   // event names: `{at_ms, field, value, source}` per row.
      //   const unmapped = analysis.unmapped_readings || [];
      //   const leaks = unmapped.filter(r =>
      //        !KNOWN_FIELDS.has(r.field)
      //     && !(r.field in FIELD_CORRECTIONS)
      //     && !IOS_DUAL_ALIAS_ALLOWLIST.has(r.field));
      //   return leaks.length > 0;
      //
      // Analyzer tests must cover: canonical accepted (no row in
      // unmapped_readings), canonical corrected (in FIELD_CORRECTIONS
      // → filtered out), canonical dropped (lands in unmapped_readings,
      // not in any allowlist → matches).
      //
      // PREREQUISITE on the analyzer side (separate from the KNOWN_FIELDS
      // module extraction): add `unmapped_readings` to Item 6's new
      // analyzer sections so this detector has a defined input.
    },
    recommend_category: 'field_name_correction_add',
    recommend_shape: {
      file: 'src/extraction/field-name-corrections.js',
      change: 'add canonical→legacy entry to FIELD_CORRECTIONS',
    },
    probe_template: null,
    auto_pr: false,
  },
  // ... etc.
];
```

For each signature that matches in a session, the optimizer emits one pre-canned recommendation alongside whatever Claude generates. This raises the floor: even when Claude misses the right framing, signature-matched recommendations always come through.

**Why.** Every bug we ship a fix for is also a class. Yesterday's L-L=2 was a class — and there will be a next one of the same class. The optimizer should learn the class shapes incrementally so the second instance auto-detects.

**Files.** `scripts/analyze-session.js` (new registry + matcher), `scripts/session-optimizer.sh` (merge signature recommendations with Claude's), `scripts/generate-report-html.js` (badge signature-matched recommendations as "auto-detected pattern").

**Effort.** 2 days. The matchers are simple JS; the wiring is moderate. Initial registry of ~5-8 known signatures covers the bug classes from the last 2 months.

**Risks.** False matches recommending the wrong fix. Mitigation: each signature has a confidence threshold; recommendations below it go in as "low confidence" not as auto-apply.

### Item 8 — Harness probe generation alongside recommendations

**What.** When a signature matches AND has a `probe_template`, the optimizer writes the probe YAML to `tests/fixtures/voice-latency-scenarios/auto-generated/<suite>/probe_<id>_<timestamp>.yaml` (the **`auto-generated/`** sibling directory locked in Decision 2 — NOT the main scenarios dir) and references the generated path in the recommendation's metadata. The default harness sweep and CI MUST NOT pick up this directory; this is enforced via an explicit `auto-generated/` skip in `scripts/voice-latency-bench/transcript-replay.mjs`'s `loadScenarios().walk()` (see Decision 2 Implementation note for the code snippet). Promotion to the main regression suite is a manual `mv` after replay-verification.

The recommendation body includes a one-line instruction: "After applying this fix, run `node scripts/voice-latency-bench/transcript-replay.mjs --scenario=<path>` against staging; it should flip from FAIL → PASS."

Optional follow-on: a `--dry-run` flag on the optimizer that generates probes without proposing code changes — useful for filling test coverage gaps detected from production sessions.

**Template format and location.** Templates live as YAML files at `scripts/probe-templates/<suite>/probe_<bug-class-id>.yaml` — same `<suite>/probe_<id>` shape used in the `probe_template` registry values in Item 7 (e.g. `scripts/probe-templates/garbles/probe_ir_bare_bridge_single_digit.yaml`). Use `{{TRANSCRIPT}}`, `{{EXPECTED_VALUE}}`, `{{ACTUAL_VALUE}}`, `{{CIRCUIT_REF}}` placeholders. Substitution reuses `scripts/render-prompt.cjs`'s flat `{{KEY}}` semantics so we don't introduce a second templating tool. **Justification for a separate directory over inlining the templates as JS string-literals in `analyze-session.js`**: probe YAMLs are read by `scripts/voice-latency-bench/transcript-replay.mjs` as standalone files for replay, and editing a template should not require touching `analyze-session.js` (different change cadence, different reviewer audience). `tests/fixtures/voice-latency-scenarios/**/*.yaml` are immutable regression fixtures, not mutable templates — keep the two locations distinct.

**Pushover batching skeleton (Decision 3 wiring).** Add `NOTIFY_MODE=per_session|batched_daily|batched_weekly` config flag in `scripts/session-optimizer.sh`, defaulting to `per_session`. Queue storage is a **separate** `~/.certmate/digest_queue.json` (NOT the existing `optimizer_state.json` — keeping queues in their own file avoids teaching every existing state-write path about queueing). Use the same `jq | mv .tmp` atomic-swap pattern already used at `session-optimizer.sh` lines 1873/1906/1915. The session-optimizer (append-only writer) and a new dormant `scripts/digest_sender.sh` (read-and-truncate drainer) coordinate via `flock` on the queue file to prevent jq read-modify-write races. Add a non-active LaunchAgent plist skeleton for the daily/weekly digest path. None of this activates by default — single config-flag flip (and LaunchAgent load for the digest path) switches modes once the multi-tester load arrives.

**Why.** Right now every fix that ships needs a hand-authored harness probe to act as a regression guard. Yesterday's L-L=2 fix took maybe 20 minutes to write `probe_ir_bare_bridge_single_digit.yaml`. The optimizer has the raw materials (transcript + expected vs actual values) and a probe template — it can write the YAML in seconds.

**Files.** `scripts/session-optimizer.sh` (probe-write step after recommendation generation), `scripts/analyze-session.js` (probe-template lookup), templates under `scripts/probe-templates/` (new directory).

**Effort.** 1-2 days depending on template count. Start with 3-4 templates (IR bare-bridge, off-enum value, canonical-leak, garble-mishear), grow incrementally.

**Risks.** Generated probes that don't actually reproduce because the optimizer mis-detected the bug class. Mitigation: probes go into `tests/fixtures/.../auto-generated/` initially with a `description` block saying "auto-generated, verify before relying on"; Derek (or me) promotes them to the main directory after a manual replay.

**Cluster 3 verification.** Re-process the 16 substantive sessions from the last month and confirm:
- Each of the ~5 known bug-class signatures finds at least one historical match.
- At least 3 generated probe YAMLs that reproduce the symptom against the deployed backend.
- A signature-matched recommendation produces a working code change when applied (test via Item 7's reference_commit lookup).

---

## Sequencing + cost

| Cluster | Effort | Order | Why this order |
|---|---|---|---|
| 1 | ½ day | First | Quick wins — every subsequent report immediately becomes more useful. Land before anything else. |
| 2 | 1–2 days | Second | Categories + decision tree depend on the prompt structure that Cluster 1 normalises. Doing Cluster 2 before 1 means rewriting twice. |
| 3 | 3–5 days | Third | Signature recognition reads the analysis output that Cluster 2's Item 6 produces. Genuine dependency. |

Total: **~5–7 days end-to-end** (optimizer side) + ~1 day of backend `src/` prerequisites (see the backend-edits bullet below). The optimizer-side changes split into 3 PRs landed independently and do not themselves require a backend deploy — but Items 6 + 7 carry backend `src/` prerequisites that DO ship via separate backend PRs (see each item's prerequisite block for detail and the dedicated bullet below). Pickup semantics for landed optimizer changes:

- **Prompt template** (`scripts/optimizer-prompt-session.md`) and **per-invocation node scripts** (`scripts/analyze-session.js`, `scripts/render-prompt.cjs`, `scripts/generate-report-html.js`) are picked up on their next invocation — these are re-read on each session-processing pass.
- **`scripts/session-optimizer.sh` itself is a long-running `while true` poll process** — edits to the shell script do NOT take effect until the running LaunchAgent process is restarted. After each PR that touches `session-optimizer.sh`, run: `launchctl kickstart -k gui/$(id -u)/com.certmate.session-optimizer` (one-line cycle, not a deploy, but it IS a required step — call it out so you don't end up wondering why a freshly-landed shell-script change isn't reflected in recommendations).
- **LaunchAgent plist itself** still requires `launchctl unload/load`.
- **Cluster 2 includes ONE iOS instrumentation PR** — `DeepgramRecordingViewModel.swift` telemetry payload extension (Item 6 prerequisite: `field` / `circuit` / `toolCallId` added to `inflight_question_anchored`, `focused_mode_enter`, `focused_mode_enter_result`, and `focused_mode_exit`). Effort: ~1-2 hours of iOS work plus a TestFlight cycle before the Cluster 2 verification step (re-processing 284CBBCD) can produce a non-null `focused_mode_timeline.slot_field`. Without this iOS PR, the `flux_garble_single_word` signature degrades to unanchored substring matching. This is the documented exception to "Out of scope: per-slot Flux Configure keyterm subset implementation" — instrumentation ≠ infrastructure, but it IS still an iOS commit-and-deploy step that shouldn't surprise the timeline reader.
- **Cluster 2 + Cluster 3 include FOUR backend `src/` edits** — schedule during a backend-eligible window OR land as separate small backend PRs independent of the optimizer rewrite, but treat each as a hard blocker for the dependent optimizer-side item:
  - (0) **Cluster 2 Item 6 backend prerequisite** — write `backend_events.jsonl` sidecar to S3 prefix `session-analytics/{userId}/{sessionId}/` at session-close in `src/extraction/sonnet-stream.js` (the recommended path-(2) from Item 6's prerequisite block). Sanitise event payloads (drop any user-uttered transcript text not already in the engine event payload). Must land BEFORE Cluster 2 verification can produce non-empty `dialogue_engine_transitions`.
  - (1) **Cluster 3 Item 7 prereq** — `export const CIRCUIT_FIELD_VALUE_ENUMS = ...` at `src/extraction/stage6-dispatch-validation.js:89` (one-line).
  - (2) **Cluster 3 Item 7 prereq** — extract `KNOWN_FIELDS` from `src/extraction/sonnet-stream.js` into a side-effect-free `src/extraction/known-fields.js` plus expose the iOS dual-alias allowlist (same or sibling module).
  - (3) **Cluster 3 Item 7 prereq** — extend `src/extraction/stage6-dispatcher-logger.js` documented schema (line 78) AND the dispatcher call sites that build `input_summary` (`src/extraction/stage6-dispatchers-circuit.js:137/206/241/263/301`) to include a sanitised `value` field on `record_reading` accepted AND rejected telemetry. Add test coverage in `src/__tests__/stage6-dispatcher-logger.test.js`. Without this the `value_out_of_enum_no_validator` detector cannot fire.

  Per CLAUDE.md the backend `src/` directory is IMMUTABLE during PWA-only work windows — confirm the work falls in a backend-eligible window before scheduling, or split into a backend-only PR train.

## Out of scope (for this plan)

- **Per-slot Flux Configure keyterm subset implementation** in iOS / backend. The optimizer learning to *recommend* this is in scope (Item 4 + Item 7); the actual iOS/backend Configure-message work is a separate sprint of its own. This plan is about teaching the optimizer to identify the right shape of fix, not about implementing the fixes themselves.

- **Optimizer migration to a different LLM or harness mode**. Current Claude-Code-in-readonly works; out of scope to swap it for batch-API or something else.

- **Multi-session aggregate reports** ("here are the 5 most common bug classes this week"). Worth doing eventually, but each cluster above lands per-session value first.

## Decisions (locked 2026-06-03)

### 1. Auto-PR for signature-matched recommendations — REPORT-ONLY with per-signature switch

**Decision**: Stay report-only by default. Build a **per-signature** `auto_pr: true|false` flag from the start, defaulting to `false` on every entry in `KNOWN_BUG_SIGNATURES`. Once a signature proves itself on real sessions (say, 5+ correct matches with no false positives), flipping that one entry to `auto_pr: true` only changes the report badge for that signature to "promoted auto-apply candidate" — **it does NOT create branches, edit files, push, or open PRs in this plan** (see the Implementation note below). The actual auto-PR execution path is intentionally deferred to a separate future plan that re-opens the HIL and source-editing constraints.

**Why per-signature, not a global toggle**: a global "auto-PR on" flag is all-or-nothing. Per-signature lets us promote `ir_bare_bridge_single_digit` (a tight, well-understood class) without also auto-PRing `flux_garble_single_word` (which has subtler classification edges). Also lets us *demote* a signature back to report-only if it starts misfiring without touching the rest.

**Implementation note**: add the per-signature `auto_pr: false` flag to the `KNOWN_BUG_SIGNATURES` registry in Cluster 3 Item 7 so the schema is in place from day one. **Do NOT implement branch creation, source edits, push, or `gh pr create` in this plan** — the optimizer remains report-only / plan-only, in line with both the existing architecture comment ("plan-only mode" per the v4 block) and the HIL constraint that the optimizer must never touch backend or iOS source files directly. The path from "auto_pr field is true on a signature" to "an actual PR exists" needs a separate plan that re-opens both the HIL constraint and the source-editing constraint explicitly; that plan is out of scope here. Until then, even a signature with `auto_pr: true` will only surface a stronger "promoted to auto-apply candidate" badge in the report — no Git/gh actions taken.

### 2. Auto-generated probes location — Option B (sibling directory)

**Decision**: Auto-generated probes write to `tests/fixtures/voice-latency-scenarios/auto-generated/<suite>/probe_<id>_<timestamp>.yaml`. They are NOT picked up by the default harness sweep or by GitHub Actions. Verification step (manual `transcript-replay --scenario=...` against the proposed fix's branch) then `mv` to the main directory promotes the probe to the regression suite.

**Why Option B over A**: the failure mode in Option A — a falsely-detected bug class auto-adding a probe that then masks a real regression in CI — is exactly the silent failure that's hard to debug later. Option B keeps the main probe suite as the manually-curated trustworthy regression bed, and lets the optimizer fill a "candidates" bucket Derek (or me) promotes after replay-verification.

**Implementation note**: the harness CLI flag lives in `scripts/voice-latency-bench/transcript-replay.mjs`, and the implementation must be a **skip**, not a glob expansion. `loadScenarios().walk()` (line 84-100) recursively walks every subdirectory under `tests/fixtures/voice-latency-scenarios` and loads all `.yaml` files by default — so a file added to `auto-generated/` is loaded immediately unless explicitly skipped. Concrete:

```js
const INCLUDE_AUTO_GENERATED = !!args['include-auto-generated'];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!INCLUDE_AUTO_GENERATED && entry.name === 'auto-generated') continue;
      walk(path.join(dir, entry.name));
    }
    // ... existing yaml-loading logic
  }
}
```

Document the flag as "remove the `auto-generated/` skip" — NOT as "expand the glob". Default sweep + CI behave unchanged. Effort: ~30 min, folded into Cluster 3 Item 8.

### 3. Pushover notification cadence — per-session now, batch mode behind a flag

**Decision**: Per-session notifications stay as-is today (1 Pushover per session report). Build a `NOTIFY_MODE: per_session | batched_daily | batched_weekly` config flag in `session-optimizer.sh`, default `per_session`. When more testers start producing sessions, flip to `batched_daily` (digest at e.g. 18:00 local) without code changes — single config edit + LaunchAgent reload.

**Why bake the batch path in now**: same logic as (1) — adding it later means changing the optimizer twice. Adding it now with the default off costs maybe 1 extra hour during Cluster 3 and is a one-line flip when the multi-tester load arrives.

**Implementation note**: batched mode uses a **separate** `~/.certmate/digest_queue.json` (NOT a new column in `optimizer_state.json`) — see Item 8 "Pushover batching skeleton" for the locking + atomic-swap pattern. Only the `NOTIFY_MODE` flag itself lives in optimizer config/state. A separate `digest_sender.sh` LaunchAgent on a daily cron drains the queue. Skeleton lands in Cluster 3 Item 8 alongside the probe generator; activation deferred.
