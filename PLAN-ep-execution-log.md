# EP Execution Log — P6 transcript-normaliser

**Session:** 20260724T072723Z-ep
**Plan:** PLAN-final.md
**Repo:** /Users/derekbeckley/Developer/EICR_Automation
**Branch:** ep/PLAN-20260724T072723Z-ep
**Started:** 2026-07-24T07:28Z
**Chain:** hop 2, `.ep-queue` wave member (feedback-2026-07-22 batch, P6 of 7)

## Plan summary
Backend-only. New `src/extraction/transcript-normalise.js` (pure, `normalise(text[,context]) → {text, rules_hit[]}`) applied at TWO seams in `sonnet-stream.js`:
- Seam A: top of `handleTranscript` (after `entry.isStopping` guard, before ask-answer anchor) — canonical/raw split, do NOT mutate `msg.text`.
- Seam B: `ask_user_answered` handler (after `sanitiseUserText`, ~:1599).
TWO evidence-backed rules: (1) context-gated "Z s"/"Zed s"/"zed s"→"Zs"; (2) "a hundred"→"100".

## Phase 0 — line-ref & raw-sink verification (2026-07-24T07:35Z)
- Status: applied
- File is `src/extraction/sonnet-stream.js` (4965 lines). Plan line refs verified against current main — accurate:
  - `:3217` `handleTranscript` def; `:3243` `entry.isStopping` guard (Seam A goes right after).
  - `:3294` + `:3355` `normaliseForAskMatch(msg.text)` content anchors; `:3399` gate; `:3514` pre-queue classifyOvertake; `:3570` detectStructuredReading; `:3714` `let transcriptText = msg.text`; `:3758` in_response_to annotation; `:3802/3847/3875` rawReplyText args; `:4061` transcript-overtake classifyOvertake.
  - Seam B: `ask_user_answered` case `:1438`; `msg.user_text` validated string at `:1447`; `srv-*` early-exit `:1472`; reverse-race anchor `:1563`; `sanitised = sanitiseUserText` `:1599`; classifyOvertake shape `:1663`; detectStructuredReading `:1722`; synthetic transcript `:1760`; resolvePayload.user_text `:1672/1787`; recentAskAnswers push `:1893`.
  - Mirror ledger: recentTranscripts pushed at `:3355` (consulted by Seam B `:1563`); recentAskAnswers pushed at Seam B `:1893` (consulted by Seam A `:3294`). BOTH content anchors must be canonical on BOTH seams for cross-seam dedupe equality (double-exposure guard).
- **RAW-SINK determination (Phase-0 deliverable) = plan Option (c).** The live voice path (`sonnet-stream.js`) uploads ONLY `session-analytics/<user>/<sid>/cost_summary.json` (`:4870`). There is NO raw-transcript S3/jsonl capture in this path (the `recording.js` `debug_transcription.json` is the OLD Whisper batch route, not the Flux/Sonnet voice pipeline). `session.activeTurnTranscript` (stage6-shadow-harness.js:702) becomes canonical by design. Recorded-corpus fixtures are hand-authored `.yaml` (already carry raw garble). So raw preservation is satisfied by NOT mutating `msg.text` in memory; the authoritative raw artifact for future replays is the hand-authored fixture. Incidental INFO-log previews (dispatcher-logger, engine) MAY become canonical — documented + pinned by test per plan.
- `parseMegaohms`/`parseBareMegaohmsWithUnit` confirmed: "a hundred" yields no digit (fails); "100 MΩ" parses to "100". megaron/milligrams already aliased (unit rule correctly dropped).
- Integration test harness: `ws._emit('message', Buffer.from(JSON.stringify(frame)))` drives handlers captured via `ws.on` mock (sonnet-stream-ask-routing.test.js pattern); `runShadowHarnessSpy.mock.calls.at(-1)[1]` is the `transcriptText` arg.
- Non-string `msg.text` edge preserved: `canonicalTranscriptText = typeof msg.text === 'string' ? normResult.text : msg.text` so pathological non-string frames see byte-identical behaviour.


## Steps executed
- **Step: new module `src/extraction/transcript-normalise.js`** — applied. Pure `normalise(text)→{text,rules_hit[]}`; two enumerated rules (a_hundred, context-gated zs_field_token); rule order load-bearing (a_hundred first). Commit a53c9b23.
- **Step: Seam A wiring (handleTranscript)** — applied. canonicalTranscriptText derived after isStopping guard; routed to both content anchors, gate, BOTH classifyOvertake, detectStructuredReading, transcriptText+in_response_to, 3× rawReplyText, runShadowHarness; non-string fallback; enumerable Symbol telemetry dedupe. Commit bb63ab66.
- **Step: Seam B wiring (ask_user_answered)** — applied. sanitiseUserText on RAW; canonicalUserTextForAnchor (raw-based) for both dedupe keys; canonicalAnswerText for behavioural consumers. Commit bb63ab66.
- **Step: production-ingress integration test** — applied. `sonnet-stream-transcript-normalise-ingress.test.js` (both seams, anchor flip, real parser, dedupe both orders, queue/drain single-log). Commit 6426c4ce.
- **Step: real-engine IR ingress test** — applied (added during Codex review; plan required "activate the REAL IR dialogue state"). `sonnet-stream-transcript-normalise-ir-realengine.test.js`. Commit 896bdb36.
- **Step: docs (ios-pipeline.md + changelog + hub rows)** — applied. Commits f8e3ee3a + review-cycle doc fixes.

## Phase-0 determinations
- Raw-sink = plan Option (c): no live raw-transcript S3 sink (only cost_summary.json); authoritative raw artifacts = the raw literals in the unit/ingress tests + field-feedback records (2ACE7677 / 36731498). No P6 .yaml corpus fixture needed.
- All plan line refs verified accurate against current main.

## Codex diff review — the ship gate
- **Verdict: PASSED (converged clean at cycle 8, zero BLOCKER/IMPORTANT).**
- Cycle 1 (parallel 3-lens): 6 findings (4 BLOCKER-class) — Zs false-positive (connector+value anywhere), ReDoS, compound-guard holes, telemetry-Symbol-lost-on-queue-spread, cross-seam anchor divergence, mocked-IR-test. All fixed. Commit 896bdb36.
- Per-fix mini-review 1: 4 IMPORTANT (compound-guard "and"/multi-digit, connector false-positives, scope-cap). Fixed. Commit d3d221db.
- Cycle 2: 2 BLOCKER (name-with-later-reading collapse; "a hundred point oh five"/"and half" decimals) + docs. Fixed. Commit b8970b82.
- Per-fix mini-review 2: 1 IMPORTANT (120-char bound too permissive → reverted to 60, name-safety). Fixed. Commit 5af66b91.
- Cycle 3: 3 BLOCKER (newline-crossing; overtake raw-length-cap bypass; missing AGENTS.md hub row) + docs NIT. Fixed. Commit 04c7a2e3.
- Cycle 4: 1 BLOCKER (CR + sentinel-internal \s newline-crossing) + 2 doc NITs. Fixed. Commit 4da45474.
- Cycle 5: 1 BLOCKER (at/of address corruption). Fixed. Commit 5d194d0d.
- Cycle 6: 1 IMPORTANT (comma-bridge to later field). Fixed. Commit addc778d.
- Cycle 7: 1 IMPORTANT (a_hundred uncertainty markers → false exact 100). Fixed. Commit e0e09d6a.
- Cycle 8: EMPTY — converged.
- ACCEPTED residuals (documented, not fixed — within the plan's "grows from field evidence"): "reads as"-style extra-word Zs false-negatives; F8/§A4 "Ze is a hundred" reinjection double-speak (pre-existing, identical for digit readings); AGENTS.md P4-row gap (pre-existing divergence); no P6 .yaml corpus fixture (Option-c); pathological no-comma name+reading run-on in one utterance.
- No SANCTIONED_DEVIATIONS (every fix was in-scope; none required going beyond the plan's intent).

## Completed 2026-07-24T09:10Z
- **Outcome: ALL PASSED** (every step applied; full backend suite green; Codex diff review PASSED).
- Commits: 16 (module, seams, tests, docs, 8 review-cycle fixes, count sync). Feature branch `ep/PLAN-20260724T072723Z-ep`.
- Files touched: `src/extraction/transcript-normalise.js` (new), `src/extraction/sonnet-stream.js`, `src/__tests__/transcript-normalise.test.js` (new), `src/__tests__/sonnet-stream-transcript-normalise-ingress.test.js` (new), `src/__tests__/sonnet-stream-transcript-normalise-ir-realengine.test.js` (new), `docs/reference/ios-pipeline.md`, `docs/reference/changelog.md`, `CLAUDE.md`, `AGENTS.md`.
- Assumed decisions: none load-bearing (the plan was execution-ready).
- Skipped/blocked/failed steps: none.
- Stashes: none.
- Tests: 49 P6-specific tests; full backend suite 6080 passed / 19 skipped / 0 failed. ReDoS-guard 0.06–0.13ms on 72–140KB inputs.
- Deploy: backend-only, ZERO wire change → backend PR→merge→ECS. No iOS changes → no TestFlight.
