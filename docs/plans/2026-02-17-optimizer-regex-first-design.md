# Session Optimizer: Regex-First Extraction Optimization

**Date:** 2026-02-17
**Status:** Design

## Goal

Make the session optimizer run after every recording job, analyze what was missed by regex and Sonnet, and prioritize regex improvements to keep the Sonnet prompt lean. Recommendations sent to phone via URL for individual approval with context re-run support.

## Current State

The optimizer infrastructure exists and is functional:
- `session-optimizer.sh` daemon polls S3 every 120s for new `session-analytics/` uploads
- `analyze-session.js` pre-processes JSONL debug logs into structured analysis
- HTML report generation + Pushover notification with URL
- Report page has per-recommendation checkboxes (accept/reject) + re-run textarea
- iOS uploads full analytics on recording stop (debug_log.jsonl, field_sources.json, manifest.json, job_snapshot.json)

## Changes Required

### 1. Optimizer Claude Prompt Rewrite (session-optimizer.sh:667-766)

**Current:** Generic "find missed values and suggest code changes" prompt.

**New:** Regex-first philosophy with explicit categories and token awareness.

Key additions to the prompt:
- **Regex-first rule:** For every missed value, FIRST check if a regex pattern can handle it. Only touch Sonnet prompt if the value genuinely requires AI understanding (ambiguous context, variable phrasing with no clear pattern).
- **Sonnet prompt audit section:** Review the current `EICR_SYSTEM_PROMPT` for: redundant instructions, rules that could be simpler, examples that could be removed, fields that regex now handles reliably.
- **Categorize every recommendation** as one of: `regex_improvement`, `sonnet_prompt_trim`, `sonnet_prompt_addition`, `number_normaliser`, `keyword_boost`, `config_change`, `bug_fix`.
- **Token impact:** For any Sonnet prompt change, note approximate token delta (+X / -X tokens).
- **Output format update:** Add `category` and `token_impact` fields to each recommendation.

### 2. Enhanced Analysis (analyze-session.js)

Add to `analysis.json`:
- `regex_opportunities`: Array of `{field, value, spoken_phrase, pattern_suggestion}` for values Sonnet extracted that have consistent/predictable spoken forms.
- `sonnet_prompt_stats`: `{estimated_tokens, field_count_in_prompt, rules_count}` for the current system prompt.
- `extraction_efficiency`: `{sonnet_calls, fields_per_call, cost_per_field_usd}`.

### 3. Updated HTML Report (generate-report-html.js)

Add to the report page:
- **Scoreboard header:** Regex fields / Sonnet fields / Missed fields / Total spoken values
- **Category badge** on each recommendation card (color-coded: green=regex, blue=sonnet, yellow=normaliser)
- **Token impact indicator** on Sonnet prompt changes (+12 tokens / -45 tokens)
- **Sonnet efficiency** metric in the summary bar

### 4. Reliable Daemon (launchd plist)

Create `com.certmate.session-optimizer.plist` for `~/Library/LaunchAgents/`:
- Runs `session-optimizer.sh` on login
- Restarts on crash (KeepAlive)
- Logs to `~/.certmate/session_optimizer.log`
- StandardErrorPath + StandardOutPath for debugging

### 5. Verify iOS Upload for All Sessions

Confirm `DeepgramRecordingViewModel.stopRecording()` always uploads analytics. The upload code runs unconditionally after recording stops (lines 537-543), so this should work for every session.

## Existing Features (Preserved)

- Per-recommendation checkboxes for selective approval
- Re-run textarea for adding context (triggers full re-analysis with context injected)
- Git-based rollback on feedback
- Multi-repo support (iOS + Backend)
- Auto-deployment on accept

## Files to Modify

| File | Change |
|------|--------|
| `EICR_App/scripts/session-optimizer.sh` | Rewrite Claude prompt (lines 667-766) with regex-first instructions |
| `EICR_App/scripts/analyze-session.js` | Add regex_opportunities, sonnet_prompt_stats, extraction_efficiency |
| `EICR_App/scripts/generate-report-html.js` | Add scoreboard, category badges, token impact indicators |
| `~/Library/LaunchAgents/com.certmate.session-optimizer.plist` | New file: launchd daemon config |

## Files NOT Modified

- `eicr-extraction-session.js` (Sonnet prompt) — optimizer will recommend changes to this, but we don't change it directly
- iOS code — no changes needed, upload already works
- Backend API routes — already support the full flow
