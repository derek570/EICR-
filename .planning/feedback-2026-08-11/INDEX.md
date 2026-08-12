# Field-feedback wave 2026-08-11 — plan index

Source: 13 untriaged voice-feedback reports — ids **114–125** (sessions `341A3F1A` 2026-08-01,
`CF052DF3` + `8F686701` 2026-08-11, iOS build ~431 against `eicr-backend:392`) plus the id **78**
orphan (2026-07-14, session `F5D22332`, flagged-never-triaged by the 07-27 wave). Pulled from prod
(`voice_feedback` via `GET /api/voice-feedback/admin/all`) + S3 debug-reports + realtime session
logs + the CF052DF3 server analytics bundle.

**Verification status:** every id was root-caused by one of four read-only investigation agents on
2026-08-12 against main `e7f8b428`, with log-row + file:line evidence — the full verbatim reports
are in [EVIDENCE.md](EVIDENCE.md). **None of the 13 is fixed on current main.** The fixes shipped
2026-08-11 afternoon (normaliser `second`→`circuit`, ask-path playback-ACK telemetry, 08B board_id
vocabulary) were checked and are unrelated to all 13.

| Plan | Feedback ids | Root cause (one line) | Repos | TestFlight? |
|---|---|---|---|---|
| [PLAN-A](PLAN-A.md) — dialogue-engine script & ask lifecycle | 114, 116, 117, 123 | No decline branch in pending-value chain; substring-only designation matching; unconditional completion ceremony; missing value-first compound IR parser | backend only | no |
| [PLAN-B](PLAN-B.md) — fast-path TTS exactly-once | 118, 119 | Slot identity board-inconsistent + turn-less marker → double, then silent, then false apology | iOS + backend companion | yes |
| [PLAN-C](PLAN-C.md) — retire the Sleeping tier | 120 | Auto-sleep (sleeping tier) still live, 18 cycles/session; + wake-during-close race destroys the replay buffer | iOS + web + docs | yes |
| [PLAN-D](PLAN-D.md) — audible-channel integrity | 121, 122, 124 | No `language_code` on ElevenLabs (French clip); confirmations toggle off with zero telemetry and zero audible cue | backend + iOS + web | yes |
| [PLAN-E](PLAN-E.md) — address authority completion | 125 | `jobState.installation` never ingested into the snapshot; postcode lookup maps ward→town and region→county | backend + iOS/web payload | yes (small) |
| [PLAN-F](PLAN-F.md) — vocabulary & scope sync | 115, 78 | Bulk "all" always excludes spares (3-way divergent predicates); extent/limitation in no gate vocabulary | iOS + backend + web | yes |

## Recommended execution order (/ep chain)

1. **PLAN-A** — backend-only, densest daily-pain set, no client wait.
2. **PLAN-E** — certificate correctness regression (address pipeline); backend keystone first,
   additive client payload halves ride the wave-end client builds.
3. **PLAN-D** — D1 (language pin) is the cheapest certain win in the wave; D2 telemetry/cue.
4. **PLAN-B** — hardest client concurrency work (exactly-once slot identity).
5. **PLAN-F** — three-implementation vocabulary/scope sync.
6. **PLAN-C** — sleep retirement last: biggest ambient behaviour change, wants a full field
   session to verify, and its docs updates can absorb the wave's changelog rows.

**Client delivery:** ONE wave-end TestFlight build carries the iOS halves of B/C/D/E/F (plus one
web deploy) — the established ride-along pattern. The wave is not done until both clients are on
the shipped versions (hub MANDATORY rule). NOTE for /ep: /ep sandbox worktrees cannot sign iOS
builds — the TestFlight step runs from the main checkout (`deploy-testflight.sh`) after the iOS
PRs merge, per deploy-testflight.md.

## Split / churn notes (planning.md rule)

- PLAN-A carries three pre-authorised internal seams (IR entry/resolution; completion ceremony;
  pending-value decline) — split mid-refine if one churns while others are quiet.
- PLAN-D and PLAN-F each bundle two mechanically-independent small items — same pre-authorisation.
- PLAN-C encodes a product decision (retire, config-gated, warn-don't-auto-revert in D2.3);
  provenance for each decision is stated inline. Reviewers challenge with scenarios, not
  re-litigation.

## Integration notes across seams

- Spoken-string hygiene: PLAN-A (decline ack), PLAN-B (duplicate re-speak + orphan-net rewording),
  PLAN-D (toggle cues), PLAN-F (skip disclosure) ALL add spoken lines — every new string must be
  distinct from every existing apology/notice family (client 30s text-keyed dedupe) AND from each
  other. Round-1 reviewers: sweep the rendered-notice inventory across all six finals.
- Session-start telemetry rows: PLAN-C and PLAN-D both add iOS session-start flag logging — one
  shared row convention (whoever merges second adapts).
- `sonnet_agentic_system.md`: PLAN-A (one decline line) and PLAN-F (bulk-scope guidance) both edit
  it — different sections, trivial rebase.
- `stage6-shadow-harness.js`: only PLAN-B touches it.
- Shared-test-file rule: PLANs A/B/E all add tests under `src/__tests__/` — after each merge to
  main, re-run the full suite on main before the next merge (MANDATORY hub rule).
- The 08C wave (latency benchmarking) is still executing in a parallel worktree — its files
  (`scripts/voice-latency-bench/*`, analyzer) don't overlap this wave, but the same
  full-suite-between-merges rule applies to sequencing against its merges.

## Follow-ups (not in any plan — queue separately)

- **Triage hygiene (now actionable):** after this wave ships, PATCH `voice_feedback` rows:
  ids covered here → `actioned`; ids 1–113 from prior shipped waves → `actioned`/`reviewed`
  (111 = positive → `reviewed`). ALL 125 rows are still `open` today — the 07-27 wave's same
  follow-up was never executed; next reconstruction is archaeology again until this is done.
- **`>` -sentinel fidelity in ask answers** (found in id 123's trace): re-answered IR values lost
  the `>` prefix (`299` stored, not `>299`). PLAN-A fixes the re-ask away for the compound shape,
  but bare numeric answers to ANY megaohm ask likely still drop `>` unless the user repeats it —
  small standalone check+fix, dialogue-engine parsers.
- **Wake-race hardening if sleep is ever re-enabled** (PLAN-C keeps the machinery config-gated):
  the three hardenings from the EVIDENCE.md addendum (generation-gated replay, non-destructive
  drain, close-in-flight invalidation) — only relevant while the flag exists.
- **Stale iOS comment sweep**: `DeepgramRecordingViewModel.swift:2857` "Stage 6 has no batch-apply
  tool" (PLAN-F fixes); check for siblings citing pre-set_field_for_all_circuits state.
- **Web fast-TTS path** (WS3b item 4, long-open): PLAN-B's correlation echo lands the wire
  groundwork; the web fast path itself remains its own future plan.
