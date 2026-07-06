---
name: certmate-failure-archaeology
description: >
  The chronicle of every major CertMate/EICR investigation, dead end, rejected fix,
  and revert — symptom → root cause → evidence (commit hashes, dates) → current status.
  Load this BEFORE proposing a fix, an experiment, or an "obvious improvement" in the CCU
  photo pipeline, voice/TTS pipeline, Deepgram auth, deploy/env-var handling, or board
  hierarchy — to check whether the idea was already tried and why it died. Also load when
  a symptom looks familiar (login bounce, [REDACTED] data, 502 on CCU, unsyncable job,
  re-ask loop) to find the settled root cause instead of re-investigating. Do NOT load for
  live-symptom triage steps (use certmate-debugging-playbook), for how the system is
  designed today (certmate-architecture-contract), or for CCU pipeline operation detail
  (certmate-ccu-pipeline).
---

# CertMate Failure Archaeology

Purpose: stop cheaper sessions from re-fighting settled battles. Every entry is
**symptom → root cause → evidence → status**. All hashes below were re-verified against
this repo's `git log` on 2026-07-06. Read an entry's full commit body with:

```bash
git show -s --format='%ad%n%B' --date=short <hash>
```

Longer prose for most entries: `docs/reference/changelog.md` (~3400 lines, verbatim
commit-body-level). Hub `CLAUDE.md` changelog table is the one-line index.

## When NOT to use this skill

| You want... | Use instead |
|---|---|
| Symptom→triage steps for a CURRENT bug | `certmate-debugging-playbook` |
| How the system is designed now + invariants | `certmate-architecture-contract` |
| CCU pipeline stage-by-stage operation, tuning vars | `certmate-ccu-pipeline` |
| Why a MANDATORY rule exists / change gating | `certmate-change-control` |
| The latency campaign's fenced-off wrong paths, executable | `certmate-latency-campaign` |
| How results were proven (method, not events) | `certmate-research-methodology` |
| Env var / flag catalog | `certmate-config-and-flags` |

---

## 0. The 2026-02-23 history reset — why `git log` starts late

The repo history begins at `a421194f` (2026-02-23) `"chore: fresh repo baseline — recover
after hardware failure"`. **Everything before that date was LOST as commits** and survives
ONLY as prose rows in `docs/reference/changelog.md` (rows back to 2026-02-14: iOS PDF
generation, server-side Sonnet extraction 2026-02-17, 3-tier regex restore 2026-02-18,
auto-sleep 2026-02-19, etc.).

Consequences for you:
- `git log`/`git blame` CANNOT explain any decision made before 2026-02-23. The changelog
  prose is the only record — treat its pre-baseline rows as authoritative.
- At least one pre-baseline fix has already been silently re-fought: the IR re-ask loop
  (see §5.3). If a fix "feels like it must already exist" but you can't find the commit,
  check the changelog tail before concluding it never happened.
- `CertMateUnified/` (iOS) is a SEPARATE nested git repo with its own history.

---

## 1. Settled production incidents (do not re-investigate)

| Symptom | Root cause | Fix + evidence | Status |
|---|---|---|---|
| Address/postcode/client fields flipping to `[REDACTED]` on job open, corrupting S3 + DB | `redactPiiInPlace` in `src/logger.js` mutated the LIVE caller ref; GET handler logged `installation_details` directly; client persisted the redacted payload on next auto-save | Copy-on-write redaction `5bf304ac` + stop logging live refs `d5adb2e3` (2026-05-27) | SETTLED. Lesson: never log a live ref through a mutating sanitiser |
| 500 on every attestation request in prod | Migrations 010/011 never applied — migration step wasn't part of deploy | CI-gated Fargate one-off runs `node-pg-migrate up` before every service update `b50a37fb` (2026-05-29); follow-up `ed897e4d` (2026-05-31) re-included `migrations/` + `scripts/migrate-from-secrets.js` in the Docker build context | SETTLED. Migrations are a CI step; exit≠0 halts deploy |
| 502 on every CCU photo request | `extractJson` brace heuristic choked when the VLM appended trailing content after the JSON | Balanced-brace walker `13b8454e` (2026-04-30) | SETTLED |
| One job permanently unsyncable for a WEEK (`job_1778443465217`); client retried identical PUT every 30s 2026-06-05→06-12; all inspector edits silently lost | PUT board-hierarchy validator REJECTED (400) any invalid hierarchy — a dangling `feed_circuit_ref` made every save fail | Rearchitected: PUT path REPAIRS deterministically (clear dangling pointers, demote duplicate mains), echoes `hierarchy_repairs`; strict validation stays only on interactive `add_board`. `45c4e8aa` (2026-06-12), `repairBoardHierarchy` in `src/extraction/board-hierarchy-validator.js` | SETTLED DOCTRINE: persistence-path validation repairs, never rejects. Do not re-add a reject gate to PUT |
| PWA Circuits tab silently empty on legacy single-board jobs | Board-id scoping treated `''` differently from `null`/`undefined` | Shared `isUnscopedBoardId(id)` across 8 call sites, `fa250ca1` (2026-05-28) | SETTLED |
| Every page using `max-w-3xl` collapsed to ~48px | Tailwind v4 `--spacing-*` theme tokens hijack `max-w-*` utilities | `e9a7cf92` (2026-05-11) — after 4 days of wrong "Safari BFC quirk" hypotheses. Spawned the standing "measure computed styles from live DOM FIRST" rule | SETTLED |
| Tool-loop-created circuits invisible to designation lookup (prod session 286D500D) | Designation key mismatch between creation path and lookup | `7f0cf4dc` (2026-05-24) | SETTLED |
| Blank doc silently saved OVER a hydrated job (P1 data loss, hit the parity fixture) | Installation/supply auto-seed defaulters ran before network hydration; a transient GET failure let them seed-and-save a blank doc | `isHydrated` gate `851ba63e` (2026-07-03; same commit fixed login `company_id: null` schema rejection + styled-dialog double-offset) | SETTLED |
| Two-circuit voice turn read back only the LAST circuit; deferred question stranded (PWA session `sess_mr8qrvcm_20jn`) | Second `speakConfirmation` cancelled the first 5ms in; phantom SpeechStarted cleared the speaking flag without draining deferred TTS | Web TTS FIFO queue + `cancel_pending_tts` handling — iOS AlertManager Phase 7.1 ported to web, PR #85 merge `b281ec28` (2026-07-06) | SETTLED code-wise; device ear-verify pending (ledger `recording/tts-fifo`) |

---

## 2. CCU pipeline thrash timeline (the most re-fought territory)

CCU = consumer unit (the breaker board an inspector photographs). The extraction pipeline
churned through FOUR architectures in ~3 weeks. Each prior approach was **demoted, not
deleted** — the code for dead paths is still in the tree, which is exactly why a fresh
session can mistake a legacy path for live. As of 2026-07-06 the LIVE path is single-shot
gpt-5.5 (`src/extraction/ccu-single-shot.js`, `CCU_USE_SINGLE_SHOT=true` in
`ecs/task-def-backend.json`; code default is `false` at `src/routes/extraction.js:2191`).

### 2.1 Architecture succession

| Date | Move | Evidence |
|---|---|---|
| 2026-04-16 | Geometric (CV slot grid) Phase-B module added | `2b94a2d3` |
| 2026-04-17 | Stage-3 per-slot VLM classification on top of geometric | `800ff308` |
| 2026-04-22 | Per-slot promoted to PRIMARY circuits[] source; Stage-4 label pass; single-shot dropped as merger fallback | `13011107`, `778e9076`, `613d54b4` |
| 2026-04-29 | Single-shot **Sonnet** RETIRED ("per-slot is now the only path"); legacy Stage-2 populated-area path DELETED, `CCU_STAGE2_GROUPS` retired (−359 lines) | `30875530`, `83e337e6` |
| 2026-05-05 | Sliding-window extraction shipped behind `CCU_SLIDING_WINDOW` flag (one day of harness iteration, 5 commits) | `7b2c148f`, `0ad7bdaa` |
| 2026-05-07 | **Single-shot RE-ADOPTED as gpt-5.5** — "collapses sliding-window pipeline". Field test on a Wylex NHRS12SL: sliding-window Sonnet gave 25 slots on a 16-module board (+9), 6.6s, $0.10; single-shot gpt-5.5 matched CV. New `CCU_USE_SINGLE_SHOT` flag | `f4b740fe`, `89eca488` |
| 2026-05-12→22 | Dewarp refinement + the dewarp-width saga (§5.1) | `9fb0bd76`, `10aabca4`, `01c081e5` |

Takeaway: single-shot was retired (as Sonnet) and re-adopted (as gpt-5.5) EIGHT DAYS
later. The architecture question is settled by MODEL CAPABILITY, not by pipeline shape —
don't relitigate "per-slot vs single-shot" without a new model and corpus numbers.

### 2.2 Same-day reverts and documented failures (fenced-off ideas)

| Idea | What happened | Evidence | Verdict |
|---|---|---|---|
| Phase-lock slot grid to device boundaries | Added, reverted ("per-slot anchoring is the right fix"), then RE-INSTATED same day with a bounded ±12% search window — 3 commits, 2026-05-05 | `03563576` → `fc1602a5` → `7f8ec5af` | SETTLED: bounded-window phase-lock. Unbounded phase-lock and no-phase-lock both rejected |
| Board-majority guessing on partial-crop slots | Reverted 2026-05-05: **"blank > guessed wrong"** — a guessed device on a safety certificate is worse than an empty cell | `aa529115` | DOCTRINE. Do not reintroduce majority/default guessing anywhere in CCU output |
| Dewarp horizontal margin 10%→15% | Shipped and reverted within hours (2026-05-22) | `325d9465` → `fc2c8489` | DEAD |
| Asymmetric VLM-undercount retake gate (force retake on ≥2 missing modules) | Shipped and reverted within hours (2026-05-22) | `53649b11` → `b98078ed` | DEAD |
| `EDGE_SEARCH_PAD` widening 0.03→0.08 | Tried 2026-05-13; corpus tests immediately regressed 3 fixtures (Wylex 16→15 under-count, Protek 20→22 over-count, phase-shift 16→15). A "do not retry this" note was committed INTO the code (`ccu-rail-quad.js`) | `0dadcbbd` (2026-05-13) | DEAD, documented in-code |
| RCDs-out-of-groups Stage-2 prompt change | Reverted 2026-04-28; kept gap-tolerance + cascade-break parts | `84088d2c` | DEAD (partial keep) |
| Native pixel density dewarp default | Shipped 2026-05-13 (`10aabca4`, "more pixels = better OCR"; the dewarp itself landed 2026-05-12 in `9fb0bd76`); empirically regressed gpt-5.5 module counting on Wylex NHRS12SL 2026-05-13 → hotfixed live with `CCU_DEWARP_OUTPUT_WIDTH=2048` → env var silently dropped by CI (§5.1) | `10aabca4` → `01c081e5` | DEAD. 2048-fixed is the empirically proven default, now hardcoded |

CCU experiment discipline that emerges from this table: (a) every CCU tuning change runs
the corpus tests FIRST (`scripts/ccu-cv-corpus/`, harnesses in `certmate-ccu-pipeline`);
(b) blank beats guessed-wrong, always; (c) if an experiment fails, document it AT the
constant in code, not just in a commit message.

---

## 3. Voice / TTS dead ends and reverts

| Idea | Why it died | Evidence | Replacement / status |
|---|---|---|---|
| Amplitude-based TTS barge-in (mic level cuts TTS) | Field session sess_mpathxlt_uwth (2026-05-18): all 6 TTS rounds barged THEMSELVES in within 0–60ms of playback — speaker output bled back through the mic. iOS gets away with the pattern only because AVAudioSession voice-processing gives hardware AEC; web has no equivalent | Added `cc4082e0` + cooldown latch `aca33275` (2026-05-17), reverted `6b55b58d` (2026-05-18) | DEAD on web. The TTS **fingerprint echo gate** (`6f86eb66`, 2026-05-11) is the surviving echo defence. Do not re-add mic-amplitude barge-in on web |
| SPLIT UTTERANCE CARRYOVER prompt rule (fix Deepgram splitting "Circuit N is" from its value) | Prompt-level fix reverted the same day; the correct fix was CODE-level buffering of the split finals before dispatch (Bug K) | `c744055b` (revert) + `039e9c75` (buffering), both 2026-05-11 | DOCTRINE: transcript-segmentation problems are fixed in dispatch code, not by prompt rules |
| Mid-stream canonical filter | Disabled — values were lost whenever the speculator emit didn't reach iOS | `57f44498` (2026-05-29) | DEAD |
| Snapshot-restructure Phase 3 canary | Canary task-def deployed and came back RED; scaffold removed same day | `2b7cb1b5` → `bc3c96ef` (2026-05-28) | Reverted; snapshot restructure did not ship via that route |
| Fuzzy/edit-distance correction of Deepgram garbles (general) | REJECTED project-wide as a HARD RULE: a false correction that mis-files a reading on a safety-critical certificate is worse than a miss. Recorded in the 2026-07-03 WS4 changelog row ("NO fuzzy/edit-distance garble correction anywhere — HARD RULE") | `docs/reference/changelog.md` 2026-07-03 WS4 row | BANNED. Curated equal-weight keyterms are the only sanctioned correction. **Nuance:** the BS-code parser's Lev-1 fallback (`c36f75a5`, 2026-05-06) PREDATES the ban, is ambiguity-gated (returns only on a UNIQUE distance-≤1 match among 12 canonical BS numbers), and is live — it is a bounded exception, not a precedent. Do not extend it |
| "Suppress low-confidence confirmations to cut TTS chatter", then "low-confidence readings ASK" | Both superseded by universal read-back (2026-06-18): structurally complete readings WRITE at any confidence and are read back; Haiku 4.5 self-confidence is not a trustworthy gate | Hub `CLAUDE.md` Audio-First invariant #2 + 2026-06-18 changelog rows | SUPERSEDED — any suppression-based latency/noise idea violates Audio-First #1/#2 (see `certmate-latency-campaign`) |

**Accidental adoption worth knowing:** `e2b0a787` (2026-06-02) is labelled
`test(extraction): switch live extraction model to Haiku 4.5 for latency probe` — a
throwaway probe — but it is the commit that put `SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001`
into `ecs/task-def-backend.json`, and it was never reverted. Haiku 4.5 IS the live
extraction model as of 2026-07-06. If you're reading commit subjects to infer intent,
verify against the current task def.

---

## 4. Deepgram auth + connection churn (3 rounds, then stability)

Chronology (web client → Deepgram WebSocket auth):

1. `49628c19` (2026-03-28) — token **query param returned 401** → switched to WebSocket
   subprotocol auth.
2. `550278ea` (2026-03-31) — hotfix bypassing `/v1/auth/grant` temp tokens for WS streaming.
3. `248953bc` (2026-04-18) — master-key bypass removed (per-company keys), which forced:
4. `dec4d34b` (2026-04-19) — subprotocol switched `['token', key]` → `['bearer', key]` for JWT.

Same-day TTL thrash (2026-04-19): mid-session WS 1006 drops → `fbf83df2` bumped temp-token
TTL 30s→1h → REVERTED `3a379ab0` → replaced by **client-side auto-reconnect on JWT expiry**
`5bf91b13` (iOS parity, no backend TTL flex). SETTLED: reconnect client-side; do not touch
token TTL to paper over 1006s.

Note for iOS work: iOS strips `Authorization` headers (and `setValue`-set
`Sec-WebSocket-Protocol`) during the WS upgrade — query param or
`webSocketTask(with:protocols:)` only.

---

## 5. Recurrence pairs — battles fought TWICE (the guardrails exist because of these)

### 5.1 Env vars dropped by CI task-def re-registration — twice

1. **`JWT_SECRET`** (2026-04-19): missing from the `eicr-pwa` task def → middleware
   fails closed (`a1815098`) → login bounce. Hotfix #1 added it LIVE (`eicr-pwa:32` + IAM
   grant); the bounce RECURRED the same day because local `deploy.sh` re-registered the
   task def WITHOUT it. Permanent fix: secret added to `ecs/task-def-frontend.json` source
   (`c918b88a`).
2. **`CCU_DEWARP_OUTPUT_WIDTH=2048`** (2026-05-13): set live on the task def to fix
   gpt-5.5 under-counting; silently dropped by the next CI deploy (hub records 2026-05-14);
   the SAME Wylex board failed the SAME way on 2026-05-22 and cost a re-investigation
   before anyone suspected the env var. Fix: default moved INTO CODE (`01c081e5`) +
   `scripts/check-task-def-env-drift.sh` wired into CI (`abe14858`) — fails the deploy if
   any live-only env var would be stripped.

Standing rule (hub `CLAUDE.md` MANDATORY): infra changes originate from source
(`ecs/*.json`, `.github/workflows/deploy.yml`), never live AWS edits. See
`certmate-change-control`.

### 5.2 PWA login bounce — twice in two days

Both instances above (5.1 item 1). Diagnostic shortcut now standing: login bounce on the
PWA = check `JWT_SECRET` presence on the `eicr-pwa` task def + execution-role
`secretsmanager:GetSecretValue` BEFORE anything else (`certmate-debugging-playbook`).

### 5.3 IR re-ask loop — a pre-baseline fix re-fought

Symptom: dialogue engine re-asks the same insulation-resistance (IR) slot forever when the
answer doesn't parse ("LIM for live-to-live" re-asked indefinitely). First closed
2026-02-18 — **pre-baseline, the commit is LOST (§0)**, survives only as changelog prose.
Re-fought and re-closed 2026-06-16 by `88e5a320` (field session F1AC26FB, defect #4):
"LIM" accepted as a first-class IR sentinel across parser + legacy twin + coercion, PLUS a
per-slot no-progress cap in `engine.js` (2nd unparseable answer → format hint; 3rd → skip
slot, fall through to Sonnet) so ANY garble can no longer loop a slot. The cap is the
structural fix; the LIM sentinel is the instance fix. IR/megaohm handling is a perennial —
related: RCBO "BS number?" double-ask loop `104735e2` + garble defer triggers `684d7ffa`
(2026-05-31), RCD focus-loop gate bypass `45662e0c` (2026-05-31), BS-code Lev-1
`c36f75a5` (2026-05-06).

### 5.4 Deepgram config drift iOS↔web

Recurring class: web and iOS Deepgram params drifting (`endpointing`, `utterance_end_ms`,
model params) produces garbage transcripts on one platform only. Example fix: `d1389691`
bumped web endpointing 300→400ms to match iOS. Standing rule: the config set moves as a
UNIT across platforms.

---

## 6. The dual-frontend postmortem — and its reincarnation

**Original (2026-04):** CertMate ran TWO web frontends simultaneously — `frontend/` and
`web/`. Nearly every UI bug regressed because fixes landed in one tree only.
`POST_MORTEM.md` (repo root, dated 2026-04-13) documents four bugs where successive
commits each fixed a different sub-problem in a different tree and the user-visible bug
survived all of them. Resolution: `frontend/` workspace REMOVED (`db978a0a`, 2026-04-15),
ground-up rebuild started in `web/` (`881d437d`, 2026-04-17; old client archived at
`_archive/web-legacy/`), production cutover 2026-04-18 (`9202351c`, PR #1).

**Reincarnation (2026-05→07):** the same failure mode returned in a subtler shape —
**web TypeScript ports of iOS Swift logic with no cross-checking mechanism**:
`web/src/lib/recording/number-normaliser.ts`, `transcript-field-matcher.ts`,
`transcript-gate.ts`, `confirmation-dedupe-key.ts`, `tts-queue.ts` are hand-ports of
Swift canon. Between 2026-06-17 and 2026-07-01, ~8 voice waves shipped backend+iOS
companions and ZERO web companions, leaving MANDATORY behaviour (universal read-back)
dormant for web users. That drift is the root cause the iOS↔Web Full-Parity Program
(WS0–WS9) exists to fix; the durable guard is the WS1 web-companion MANDATORY rule +
`web/docs/parity-ledger.md` + `scripts/check-parity-ledger.mjs` (warn-only CI).

Lesson to apply: any time logic exists in two languages (Swift canon + TS port), a change
to one WITHOUT a dated ledger row for the other is the dual-frontend bug pattern
recurring. Check the ledger row before and after. See `certmate-change-control`.

---

## 7. OPEN battles — do not treat as settled (as of 2026-07-06)

| Item | State |
|---|---|
| `FINALIZER_TIMEOUT_MS` widen vs iOS `local_fallback` (voice-latency Phase 2.2, deferred from PR #52, 2026-06-05) | OPEN — decision gated on 1–2 field sessions on deployed code. Owned by `certmate-latency-campaign` |
| WS3b items 4/5: regex fast-path TTS consumption on web + playback telemetry | OPEN (item 8, TTS FIFO, shipped 2026-07-06 PR #85) |
| ~84 parity-ledger rows `partial` (device smokes: WS2 iPad, WS7 iPhone A2HS, TTS-FIFO ear-verify; `pdf/pdf-fidelity` until field validation) | OPEN |
| iOS keyterm curation for Flux (WS4) | HELD — the synthetic TTS→Flux probe was INCONCLUSIVE on insulation/trip-time (voice too clean); needs real-audio spot check + TestFlight. Web already flipped to Flux 2026-07-03 (`ff620997`), reversible in ~3–5 min via the frontend-taskdef deploy path |
| CCU in-scope failure modes: gpt-5.5 mis-counts in long identical-MCB runs, label-column mis-alignment, `slotsToCircuits` phase-walking | OPEN — see `certmate-ccu-pipeline` |
| Deferred `[contract]` items #3.4 (designation not crossing wire) + #5.3 (atomic swap tool — Sonnet currently fakes swaps, once inventing scratch circuit 999) | DEFERRED, tagged `[contract]` in git |
| iOS `deduplicateApiJobs` address-dedupe hides same-address jobs (blocked WS0 EIC baseline) | LOGGED, unfixed |

---

## 8. Reading and extending the chronicle

Conventions that make archaeology possible here (keep them):

- **Field/prod session IDs in commit subjects** (`F1AC26FB`, `15B88D6B`, `286D500D`,
  `sess_mr8qrvcm_20jn`) — ground truth provenance. Find a session's fixes:
  `git log --grep='F1AC26FB' --oneline`.
- **Revert style:** either `revert(scope): <why it was wrong>` with a full rationale body,
  or plain `Revert "<subject>"`. Search both: `git log --grep='revert' -i --oneline`.
- **Documented failures live AT the code** (e.g. the EDGE_SEARCH_PAD "do not retry" note
  in `ccu-rail-quad.js`). When you retire an idea, write the tombstone where the next
  person will trip over it.
- **Demote, don't delete** is the CCU norm — so ALWAYS check which path is live
  (`CCU_USE_SINGLE_SHOT` in the task def) before reasoning from code presence.
- New settled battles go: full body in `docs/reference/changelog.md`, one-liner in hub
  `CLAUDE.md`, and (if it changes doctrine) the matching `docs/reference/*.md`. Per house
  rules in `certmate-change-control`.

Fast queries:

```bash
# All reverts, newest first
git log --oneline -i --grep='revert' | head -40
# Everything about one battle
git log --oneline --all -S 'EDGE_SEARCH_PAD'
# What a dead flag used to do
git log --oneline -S 'CCU_STAGE2_GROUPS' | tail -5
# Pre-baseline history (prose only)
tail -60 docs/reference/changelog.md
```

---

## Provenance and maintenance

All commit hashes verified 2026-07-06 against this repo. One-line re-verification per
drift-prone fact:

| Fact | Re-verify with |
|---|---|
| History starts 2026-02-23 hardware reset | `git log --reverse --oneline \| head -1` |
| Live extraction model still Haiku 4.5 | `grep SONNET_EXTRACT_MODEL ecs/task-def-backend.json` |
| CCU live path still single-shot (`CCU_USE_SINGLE_SHOT=true`) | `grep CCU_USE_SINGLE_SHOT ecs/task-def-backend.json src/routes/extraction.js` |
| Web STT still `flux` (flipped 2026-07-03) | `grep DEEPGRAM_STT_MODEL ecs/task-def-frontend.json` |
| Drift guard still wired | `grep -l check-task-def-env-drift .github/workflows/deploy.yml` |
| Hierarchy PUT still repairs (not rejects) | `grep -n repairBoardHierarchy src/extraction/board-hierarchy-validator.js src/routes/jobs.js` |
| EDGE_SEARCH_PAD tombstone still in code | `grep -rn EDGE_SEARCH_PAD src/extraction/ \| head -3` |
| Open items in §7 (fast-moving) | hub `CLAUDE.md` "Current Focus" + changelog top rows; `git log --oneline -10` |
| Any hash in this file | `git show -s --format='%ad %s' --date=short <hash>` |

Known label-vs-date corrections baked in above (trust these over older summaries): the
EDGE_SEARCH_PAD doc commit is 2026-05-13 (not 05-22); board-majority revert is 2026-05-05;
amplitude barge-in revert is 2026-05-18; the max-w-3xl fix is 2026-05-11; Deepgram auth
order is `49628c19` (03-28) → `550278ea` (03-31) → `dec4d34b` (04-19).

UNVERIFIED (in-repo) items, labelled as such: the fuzzy-garble ban's original decision
date (2026-06-24 per project memory) — the earliest IN-REPO record is the 2026-07-03
changelog row calling it a HARD RULE; and the exact CI deploy that dropped
`CCU_DEWARP_OUTPUT_WIDTH` (hub says 2026-05-14; the `01c081e5` body says only "between
2026-05-13 and 2026-05-22").
