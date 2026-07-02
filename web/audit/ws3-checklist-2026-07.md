# WS3 checklist — backend wire-shape changes merged 2026-06-17 → 2026-07-02

**Produced by:** WS0 item 2 of the parity WS0+WS1 plan (`~/.claude/handoffs/EICR_Automation--parity-ws0-ws1-audit-governance-2026-07-01/PLAN-final.md`), executed 2026-07-02.
**Purpose:** the definitive input list for WS3 (voice behavioural catch-up). Every backend change that landed on `main` since the last web commit (2026-06-17) is classified below as **backend-only** (no client-visible contract effect), **iOS-companion-shipped** (iOS already shipped the matching client change — web needs the same), or **dormant-behind-capability** (behaviour exists server-side but only activates when the client advertises a capability web does not yet send).

## Method (reproducible)

```bash
# Merge-level log (11 first-parent merges in range):
git log origin/main --first-parent --since=2026-06-17T00:00:00 --diff-merges=first-parent \
  --name-status --format='%H %cs %s' -- src/ config/prompts/ config/field_schema.json \
  config/baseline_config.json config/eic_baseline_config.json packages/shared-types/ \
  packages/shared-utils/ docs/reference/changelog.md

# Completeness cross-check (tree diff from the pre-cutoff base):
BASE=$(git rev-list --first-parent -1 --until=2026-06-17T00:00:00 origin/main)   # = fca7dc26
git diff --name-status $BASE origin/main -- <same path set>
```

**Reconciliation result:** the union of the log's `--name-status` entries and the tree diff (93 paths) match EXACTLY — zero paths in either direction needed investigation. The full first-parent history in range is exactly 11 merges (#58, #60, #61, #62, #64, #65, #66, #67, #68, #69, #70); PRs #59/#63 never landed on `main`. Commit `8c1a4d24` (surge baseline seeds, committed 2026-06-17T13:17, via merge `90368f87` #58) appears on both sides as expected with the explicit `T00:00:00` cutoff. `06257456` (field_schema `comments` field) surfaces via merge `7af396a1` #66.

## Merges in range (newest first)

| Merge | Date | PR | Subject |
|---|---|---|---|
| `489d7483` | 2026-06-26 | #70 | ElevenLabs model consolidation (turbo→flash + per-model cost tracking) |
| `9a917251` | 2026-06-25 | #69 | Field feedback 2026-06-25 (M1/M4 voltage re-ask, IR note 60s→30s) |
| `286b82f8` | 2026-06-25 | #68 | obs-followups (#49 EIC proactive + #52 Fix B canonical wording end-to-end) |
| `3f734446` | 2026-06-25 | #67 | Field feedback 2026-06-24 (orphan apply-complete, answer resolver) |
| `7af396a1` | 2026-06-23 | #66 | Observation feedback (regulation-lookup Fix A+B, `comments` field) |
| `a730f4f3` | 2026-06-23 | #65 | Field feedback 2026-06-23 phase 2 (IR script, TTS spoken forms) |
| `9c224aeb` | 2026-06-23 | #64 | Field feedback 2026-06-23 backend (pre-LLM gate, OCPD/RCBO/RCD schemas) |
| `8231468c` | 2026-06-19 | #62 | Field feedback ad0ae9fa (ring-continuity, event bundler) |
| `ac63680d` | 2026-06-18 | #61 | Read-back correction Option B (universal read-back, `low_conf_readback_v1`) |
| `61bfe1d9` | 2026-06-17 | #60 | Loaded Barrel agentic restore (Plan A+B) |
| `90368f87` | 2026-06-17 | #58 | Surge-protection box (`surge_*` namespace, Option A spd split) |

## Classification — every touched non-test runtime file

### Wire-shape / contract-bearing config

| File | PR(s) | Class | Web action |
|---|---|---|---|
| `config/field_schema.json` | #58, #66 | **iOS-companion-shipped** | #58 adds the `surge_*` namespace (`surge_spd_present/type/bs_en`, `surge_status_indicator`) — distinct from the `spd_*` DNO-cutout family. Web already references `surge_spd` in 4 files (`supply/page.tsx`, `live-fill-view.tsx`, `apply-ccu-analysis.ts`, `apply-document-extraction.ts`) — VERIFY completeness vs iOS Fix D (form cells, regex apply, display keywords). #66 adds installation-level `comments` (EIC divert-to-comments flow; iOS renders in EIC PDF comments cell) — verify web EIC form + PDF payload carry it. |
| `config/baseline_config.json`, `config/eic_baseline_config.json` | #58 (`8c1a4d24`) | **iOS-companion-shipped** | Baseline seeds for the new `surge_*` fields — new jobs arrive with these keys present. Web forms must render/accept them (same check as field_schema above). |
| `config/prompts/sonnet_agentic_system.md` | #58,#61,#62,#66,#68,#69 | **backend-only** | Prompt steering (RULE 0 EIC proactive, surge disambiguation, MERGED naming, confidence rewrite). No client decode change; effects arrive via existing frame types. |
| `config/prompts/extraction_system.md`, `sonnet_extraction_system.md`, `sonnet_extraction_eic_system.md` | #58, #69 | **backend-only** | Same — prompt-side surge/EIC steering. |
| `config/prompts/wrag-bs7671-eicr.md` | #66 | **backend-only** | Regulation RAG source text. |

### New/deleted runtime modules

| File | PR | Class | Web action |
|---|---|---|---|
| `src/extraction/regulation-lookup.js` (A) | #66 | **iOS-companion-shipped** | Server now emits canonical `regulation_title`/`regulation_description` on observation paths. iOS renders them (2026-06-25 iOS commit, ObservationCardView). Web decodes NEITHER key (verified: zero `regulation_title|regulationTitle` hits in `web/src/`) → WS3 item 3 (obs-card canonical wording). |
| `src/extraction/readback-window.js` (A) | #61 | **backend-only** | Rolling ~3-turn read-back context for bare-"no" resolution — server-internal state. |
| `src/extraction/stage6-early-terminate.js` (D) | #60 | **backend-only** | Early-terminate predicate folded into tool-loop/speculator; no frame change. |

### Observation / read-back / ask wire surface

| File | PR(s) | Class | Web action |
|---|---|---|---|
| `src/extraction/sonnet-stream.js` | #61,#64,#68,#69 | **iOS-companion-shipped** (obs + ask fields) | #68 threads `lookupRegulation` into ALL `observation_update` payloads (rename/refinement/RULE-6 edit) — web must decode + render (WS3 item 3). #61 threads `context_board_id` through ask flows. |
| `src/extraction/stage6-tool-schemas.js` | #61, #66 | **iOS-companion-shipped** | `ask_user` gains `context_board_id` (#61); observation tool schemas gain canonical-wording plumbing (#66). Web question handling should carry `context_board_id` the way iOS does (focus-asks / board scope). |
| `src/extraction/stage6-event-bundler.js` | #61,#62,#67 | **dormant-behind-capability** + **backend-only** | Universal read-back (no confidence gate) + debounce re-key field+circuit+board+value: read-back TEXT synthesis is server-side (arrives via existing confirmation frames), BUT the `< 0.5` write path is PRE-APPLY gated on `low_conf_readback_v1`, which web does NOT advertise (web hello sends only `protocol_version`, verified `sonnet-session.ts:740`). WS3 item 1: advertise after verifying web has no local confidence drop-filter. |
| `src/extraction/stage6-dispatchers-reading` (via #61 circuit/board dispatchers) / `stage6-dispatchers-circuit.js` | #61, #69 | **dormant-behind-capability** | Same `low_conf_readback_v1` PRE-APPLY gate + `context_board_id` auto-resolve write sites. |
| `src/extraction/stage6-dispatchers-observation.js` | #66 | **iOS-companion-shipped** | Canonical wording written into observation records (client renders it). |
| `src/extraction/confirmation-text.js` | #58,#61,#64 | **backend-only** | Read-back text phrasing (surge spoken forms, never-clear apologetic re-ask). Text arrives in existing frames. |
| `src/extraction/tts-text-expander.js` | #65, #69 | **backend-only** | TTS spoken-form expansion. |
| `src/extraction/stage6-answer-resolver.js` | #61, #67 | **backend-only** | Server-side answer resolution. |
| `src/extraction/stage6-dispatcher-ask.js`, `stage6-ask-gate-wrapper.js` | #61 | **backend-only** | Ask-budget re-key (board-scoped) — server-internal. |
| `src/extraction/pre-llm-gate.js` | #61, #64 | **backend-only** | Server-side forward gate (bare-no forwarding). NOTE: distinct from the CLIENT-side TranscriptGate iOS has and web lacks entirely (ledger gap, WS3 item 7). |
| `src/extraction/stage6-prompt-leak-filter.js`, `stage6-snapshot-mutators.js`, `stage6-shadow-harness.js` | #66,#61,… | **backend-only** | Prompt hygiene / snapshot / shadow-harness (harness is test-support that ships in src/). |
| `src/extraction/eicr-extraction-session.js` | #58, #68 | **backend-only** | #68's `CERTIFICATE TYPE: EIC` snapshot line steers the model; no client decode. |
| `src/extraction/known-fields.js`, `field-name-corrections.js` | #58, #66 | **iOS-companion-shipped** (follows field_schema) | New `surge_*` + `comments` keys become valid reading fields → web apply paths must accept them (same sweep as field_schema row). |

### Dialogue engine / scripts (voice flow)

| File | PR(s) | Class | Web action |
|---|---|---|---|
| `src/extraction/dialogue-engine/engine.js` | #64(schemas),#67,#69 | **backend-only** | Per-slot no-progress caps, orphan handling — server flow. |
| `src/extraction/dialogue-engine/schemas/{insulation-resistance,ring-continuity,ocpd,rcbo,rcd}.js` | #62,#64,#67,#69 | **backend-only** | Script schema fixes (LIM handling, re-ask carriers). NOTE: LIM as an IR *display* value is already a separate ledger gap (WS3 item 6) — these schema changes don't add a new client field, they make the server accept/route LIM. |
| `src/extraction/insulation-resistance-script.js`, `ring-continuity-script.js`, `insulation-resistance-timeout.js` | #64,#65,#62,#69 | **backend-only** | Legacy-twin + timeout tuning (IR note 60s→30s). |

### Latency / cost machinery

| File | PR(s) | Class | Web action |
|---|---|---|---|
| `src/extraction/loaded-barrel-speculator.js` | #60, #70 | **backend-only** | Speculative synth + per-model cost attribution. |
| `src/extraction/stage6-tool-loop.js`, `voice-latency-turn-summary.js` | #60 | **backend-only** | Tool-loop restore; round-1 `tool_choice` force removed. |
| `src/extraction/voice-latency-config.js` | #60, #61 | **dormant-behind-capability** (reference) | Defines `VOICE_LATENCY_KNOWN_SUPPORTS` (`regex_fast_v2`, `client_playback_telemetry`, `low_conf_readback_v1`) + the `low_conf_readback_v1` contract at `:159-171`. READ-ONLY reference for WS3 item 1 capability strings. |
| `src/extraction/cost-tracker.js`, `active-sessions.js` | #70 | **backend-only** | Per-model ElevenLabs cost buckets; `toCostUpdate` back-compat preserved (derived `elevenLabsCharacters` getter) → cost_update frame shape unchanged. |
| `src/routes/keys.js` | #70 | **backend-only** | TTS proxy model `eleven_turbo_v2_5` → `eleven_flash_v2_5` — explicitly contract-preserving (same voice/format/settings; audio bytes contract unchanged). No web change. |

### Top-level src + routes (the #58 surge sweep)

| File | PR | Class | Web action |
|---|---|---|---|
| `src/utils/jobs.js` | #58 | **iOS-companion-shipped** | Job payloads now carry `surge_spd_present/type/bs_en`, `surge_status_indicator`; Option A also REMOVED the `board.spd_type` fallback into `spd_type_supply` (supply Main Fuse box no longer polluted by board surge data). Web supply form + job mappers must mirror both the new keys and the fallback removal. |
| `src/export.js`, `src/extract_chunk.js`, `src/extract_session.js` | #58 | **iOS-companion-shipped** | CSV/export headers + extraction paths gain `surge_*` — web CSV round-trip must include them (check web CSV import/export if present). |
| `src/ocr_certificate.js` | #58 | **backend-only** | OCR document-extraction path emits the new keys via existing extraction responses — covered by the `apply-document-extraction.ts` check above; no separate web decode change. |
| `src/routes/extraction.js`, `src/routes/recording.js`, `src/routes/pdf.js` | #58 | **iOS-companion-shipped** | Extraction/recording responses + server PDF payload include `surge_*`. Web PDF page (server-generated PDF is the web path) should show surge fields once supply form carries them. |

## Supporting test/doc changes (not wire shapes)

`src/__tests__/**`: 38 test files touched/added in range — companions to the runtime changes above (notable adds: `surge-protection-contract.test.js`, `readback-window.test.js`, `regulation-lookup.test.js`, `sonnet-stream-observation-update-regulation.test.js`, `eicr-extraction-session.cert-type-snapshot.test.js`, `stage6-orphan-net.test.js`, `stage6-orphan-apply-complete.test.js`, `loaded-barrel-speculator-drift-validate.test.js`, `stage6-shadow-harness-b1a-suppress.test.js`; deleted: `stage6-early-terminate.test.js`). `docs/reference/changelog.md`: doc-only (changelog rows for each PR).

## Ignored non-contract diff entries

- `packages/shared-types/node_modules` (A, via #61 `ac63680d`) — dependency/build artifact, the ONLY post-2026-06-17 path under `packages/shared-types/`; NOT a wire-shape change. `packages/shared-utils/` had zero changes in range.

## WS3 work list distilled (in priority order)

1. **Advertise `low_conf_readback_v1`** after verifying web has no local confidence drop-filter (contract: `voice-latency-config.js:159-171`) — activates universal read-back for web users (#61's dormant behaviour).
2. **Observation canonical wording** — decode + render `regulation_title`/`regulation_description` (+ existing undecoded-rendered `rationale`) end-to-end (#66/#68). Web currently decodes `rationale` into types but renders NONE of the three.
3. **`surge_*` completeness sweep** — verify the 4 existing web `surge_spd` touchpoints cover the full iOS Fix D surface (form cells, apply paths, CSV, PDF payload) incl. the `spd_type_supply` fallback removal (#58).
4. **`comments` field (EIC divert-to-comments)** — web EIC form + PDF (#66).
5. **`ask_user.context_board_id`** — carry board scope in web question handling like iOS (#61).
6. Everything else in range verified **backend-only** — no web work required from this window (read-back text, dialogue scripts, latency/cost machinery, prompts, TTS proxy model swap).

Cross-cutting WS3 items that predate this window (TranscriptGate port, gate-pass chime, capability array itself, FIFO TTS, fast-path TTS, LIM display) are tracked in `web/docs/parity-ledger.md` + `web/audit/INDEX-2026-07.md`, not here.
