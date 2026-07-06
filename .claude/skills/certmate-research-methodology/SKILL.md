---
name: certmate-research-methodology
description: >
  Load this skill BEFORE proposing, evaluating, adopting, or retiring any idea in the
  CertMate/EICR repo — a new heuristic, a tuning-constant change, a model/config flip, a
  prompt rule, a "clever" correction layer, or a fix whose mechanism you have not proven.
  It defines the project's evidence bar (one mechanism must explain ALL observations
  including negatives, and survive two-reviewer adversarial refutation), the
  hypothesis-predicts-numbers-first rule, the experiment-flag → bench → field-session →
  adopted-default-or-documented-retirement lifecycle, and the wrongness-ledger habit.
  Also load it when you are tempted to add fuzzy/edit-distance transcript correction
  (banned — read the case study first) or to re-try a previously-failed experiment.
  Do NOT load it for step-by-step debugging of a live symptom (use
  certmate-debugging-playbook), for the history of specific past investigations (use
  certmate-failure-archaeology), or for how to run the measurement tools themselves (use
  certmate-diagnostics-and-tooling).
---

# CertMate Research Methodology — how a hunch becomes an accepted result

This repo (EICR_Automation — voice-driven electrical-certificate automation) has a
specific, historically-earned discipline for turning ideas into shipped defaults. Ideas
that skip it get reverted, sometimes the same day. This skill encodes the discipline
with worked examples you can verify with `git show`.

**Vocabulary** (defined once): an **EICR** is a UK electrical safety certificate — the
output is safety-critical, which shapes every rule below. A **field session** is a real
inspection Derek (the sole production user) performs with the app; each has a session ID
(e.g. `F1AC26FB`) and produces S3 debug logs. **Stage 6** is the server-side agentic
LLM extraction loop. **CCU** is a consumer unit (fuse board) photographed for vision
extraction. A **garble** is a Deepgram speech-to-text mishearing ("lion" for "LIM").
A **keyterm/boost** is a vocabulary hint sent to Deepgram. A **task-def** is the
source-controlled ECS task definition (`ecs/task-def-*.json`). **/rp → /ep** is the
project's plan-refinement → autonomous-execution pipeline. A **kill-switch** is a
runtime config flip that reverts a behaviour without a rebuild.

---

## 1. The evidence bar

A hypothesis is accepted here only when ALL of these hold:

| # | Requirement | What it kills |
|---|---|---|
| 1 | ONE mechanism explains ALL observations — including the negatives (the sessions where the bug did NOT fire, the fields that were NOT corrupted) | Pet theories that fit only the headline symptom |
| 2 | The mechanism is demonstrated at the site (log the value at the assignment site, reproduce with a fixture, or cite the exact prod extraction ID) | "I think the framework is flaky" hand-waving |
| 3 | It survives adversarial refutation — the two-reviewer gate (§1.1) | Confirmation bias in a solo-authored fix |
| 4 | The fix does not violate a MANDATORY invariant in `CLAUDE.md` (Audio-First #1–#3, backend-immutable-during-parity, infra-from-source) | Locally-clever fixes that break the product contract |

Gold-standard example of the bar being met — read the commit body of the phase-lock
revert:

```bash
git show -s --format=%B fc1602a5   # revert(ccu): drop phase-lock
```

It names the exact production extraction (`1777978605408-np6v97`), the measured numbers
(`phaseOffsetSamples=15`, `pitchSamples=68`, `phaseShiftPx=84.3` = a 22%-of-pitch shift),
the downstream mechanism (shifted crops → slot 12 straddles two devices → circuit
"Ovens" vanishes), AND why the design assumption ("one uniform phase shift") was wrong.
That is what "root cause" means in this repo. A fix without that chain is a guess.

### 1.1 The two-reviewer doctrine

Every substantial plan/phase ends with a **dual-reviewer gate: Claude + Codex**. This is
institutionalised, not folklore:

- `scripts/README-stage6-review.md` — "Every phase ends with a dual-reviewer gate
  (Claude + Codex)". `scripts/stage6-review.sh` is the Codex half.
- `web/reviews/` — parallel `claude/phase-N.md` + `codex/phase-N.md` review streams;
  `FIX_PLAN.md` is "written only after BOTH review streams finish".
- The `/rp` plan-refinement loop iterates until BOTH reviewers raise no
  BLOCKER/IMPORTANT findings.

Why two: the reviewers have complementary blind spots — **Claude catches architectural
and contract errors; Codex catches numeric/coordinate/type errors**. Neither alone
suffices; historically each has caught classes the other missed. Corollary
(as of 2026-07-06): the Codex reviewer model is gpt-5.5/high; a benchmarked attempt to
substitute gpt-5.4-mini scored 0/9 recall on known plan findings — do not downgrade the
reviewer to save cost. (Benchmark is recorded in project memory, not in-repo — treat as
UNVERIFIED-in-repo but binding until re-benchmarked.)

**Your obligation as a cheaper session:** you do not get to self-certify a nontrivial
result. Route it through `/rp` (plans) or `/code-review` (diffs), and treat "a reviewer
found nothing" as necessary, not sufficient — the field session is the final arbiter (§3).

---

## 2. Hypothesis predicts numbers BEFORE running

State the expected measurement, in writing, before you run the experiment. If you only
decide what "good" looks like after seeing the output, you have measured nothing.

Worked in-repo examples of pre-declared pass criteria:

| Experiment | Pre-declared criterion (in the file header, before any run) | Where |
|---|---|---|
| Sonnet TTFT bench | "Pass criterion (PLAN_v3 §3.B): P50 cached TTFT ≤ 900 ms" | `scripts/voice-latency-bench/sonnet-ttft-bench.mjs` header |
| Golden-session divergence | "≤ 10% divergence rate BEFORE any over-ask guards added"; exit 0/1 on the threshold | `scripts/stage6-golden-divergence.js` header |
| WS4 Flux keyterm probe (2026-07-03) | Plan pre-committed: an INCONCLUSIVE probe is NOT a green light — and when the probe came back inconclusive on 2 of 3 garbles, the iOS keyterm curation was HELD, not shipped | `docs/reference/changelog.md` 2026-07-03 WS4 row |
| EDGE_SEARCH_PAD widening (2026-05-13) | Corpus module-count tests were the gate; the widening regressed Wylex 16→15 and Protek 20→22 → reverted same day and documented | comment above `EDGE_SEARCH_PAD` in `src/extraction/ccu-rail-quad.js:66-73` |

The WS4 probe is the most important pattern: **the decision rule was written into the
plan before the data existed**, so an ambiguous result could not be rationalised into a
pass. Copy that. When you write a plan phase that gates on a measurement, write the
branch table too: "expected X; if you see Y instead → do Z".

Practical rule: any claim of the form "this makes it faster / more accurate / less
noisy" must ship with (a) the number you predict, (b) the command that produces the
number, (c) the number you got. The bench suite lives in `scripts/voice-latency-bench/`
(`npm run voice-test`, `npm run voice-regression`, `run-cheap.sh` for a Haiku-priced
run) — see `certmate-diagnostics-and-tooling` for operating instructions.

---

## 3. The idea lifecycle

```
idea → experiment flag / kill-switch → bench evidence → field-session validation
     → adopted default (flip committed FROM SOURCE)  or  documented retirement
```

Every stage is source-controlled. No stage is skippable; in particular you may not jump
from "bench looks good" to "default" without field evidence, and you may not retire an
idea without writing down why (§5).

### Stage gates

| Stage | What it requires | Change-control hook |
|---|---|---|
| Experiment flag | The new behaviour behind an env var / runtime flag, default = old behaviour. E.g. web Flux shipped behind `DEEPGRAM_STT_MODEL` with `SAFE_STT_MODEL='nova3'` as a never-flip fail-safe (`web/src/lib/runtime-config.ts`) | Flag value lives in the task-def source (`ecs/task-def-*.json`) — never a live AWS edit |
| Bench evidence | Deterministic/offline harness numbers vs the pre-declared criterion (§2). Committed result JSONs (e.g. `scripts/voice-latency-bench/*-result.json`) are the receipts | Commit the results next to the script |
| Field validation | 1–2 real field sessions on the deployed code; forensics via `scripts/analyze-session.js` (§4). Bench-green + field-untested = still an experiment | Some decisions explicitly wait: voice-latency Phase 2.2 (`FINALIZER_TIMEOUT_MS` widen vs iOS `local_fallback`) is deliberately parked "once 1–2 field sessions hit the deployed code" — CLAUDE.md Current Focus |
| Adopted default | ONE commit flipping the default in source (code default + task-def), with the evidence in the commit body | Deploy via CI only; the kill-switch stays as rollback |
| Documented retirement | Revert commit with full mechanism narrative + a do-not-retry note at the code site if the idea is likely to be re-invented | §5 wrongness ledger |

### Worked lifecycle examples (all verifiable via `git show -s --format=%B <hash>`)

1. **Phase-lock: add → revert → re-add bounded (three commits, one day, 2026-05-05).**
   `03563576` added phase-locking of the CCU slot grid; `fc1602a5` reverted it after one
   production photo produced a runaway 22%-of-pitch shift that deleted a circuit;
   `7f8ec5af` re-instated it with a **bounded ±12% search window** (`PHASE_CAP_FRACTION`),
   the cap chosen empirically (working photo needed 7%; the pathological one wanted 22%).
   Lesson: the full revert was itself wrong ("took the centring with it") — the mature
   move was *bound the mechanism*, not delete it. Reverts are data too.

2. **EDGE_SEARCH_PAD widening: failed AND documented at the constant (2026-05-13,
   `0dadcbbd`).** Widening 0.03→0.08 to feed the edge regressor more points was a sound
   instinct; corpus tests caught module-count regressions because the constant controls
   BOTH crop padding and search-strip thickness. The retirement is a `NOTE 2026-05-13`
   comment directly above `const EDGE_SEARCH_PAD = 0.03` saying "do NOT just widen this
   constant" and naming the surgical alternatives. That comment exists because "the next
   person debugging too-tight-ROI failures will have the same instinct". When you kill
   an idea someone will re-have, leave the tombstone AT the site.

3. **nova3 → flux STT flip (web, 2026-07-03, `ff620997`).** Textbook full lifecycle:
   Flux path built BEHIND a runtime kill-switch with the default held at nova3 → Phase-0
   synthetic probe validated the keyterm mechanism but was inconclusive elsewhere → flip
   HELD per the pre-declared rule → then a FIELD report (nova-3 partial-sentence sends)
   supplied the evidence and the flip landed as one source commit to
   `ecs/task-def-frontend.json` (`DEEPGRAM_STT_MODEL=flux`), reversible in ~3–5 min via
   the `frontend-taskdef` CI fast path. As of 2026-07-06 the code default
   (`DEFAULT_STT_MODEL` in `web/src/lib/runtime-config.ts`) is still `'nova3'` — the env
   var carries the flip; nova3 remains the fail-safe.

4. **Universal read-back superseding suppress-low-confidence (2026-06-18).** A settled
   stance ("suppress low-confidence confirmations to cut TTS noise") was overturned by a
   product-invariant argument: on an audio-first tool, a silently-dropped reading is
   invisible to a hands-free inspector. The supersession is written into Audio-First
   invariant #2 in `CLAUDE.md` ("This supersedes BOTH the older … stance AND the interim
   … stance") — including the *interim* stance ("low-confidence readings ASK"), so the
   full doctrine history is one paragraph. `CONFIRMATION_MIN_CONFIDENCE = 0.8`
   (`src/extraction/confirmation-text.js:193`) survives ONLY as the loaded-barrel
   speculator's pre-synth cost gate, and the docs say exactly that so nobody
   re-interprets it as a behavioural gate.

5. **Board-majority guessing revert: blank beats guessed-wrong (2026-05-05,
   `aa529115`).** A plausible recovery heuristic (fill a partial-crop slot with the
   board's majority breaker pattern) was killed on direct user feedback: "I would rather
   it be blank than guessed wrong. They're often C-types mixed in with B-types for
   motors." The commit body enumerates WHY majority-fill is unsafe on UK domestic boards
   (mixed curves/RCD types/amperages) and states the doctrine: *wrong-but-pre-populated
   is harder to spot than blank-and-obviously-needs-filling*. This doctrine governs all
   extraction fills — cross-ref `certmate-ccu-pipeline`.

6. **Amplitude TTS barge-in revert (2026-05-18, `6b55b58d`).** Field session evidence
   (all 6 TTS rounds self-cancelled within 0–60 ms of playback start) plus a mechanism
   (speaker output bleeds into the mic; web software echo-cancellation is too weak,
   unlike iOS hardware AEC) → reverted, replaced by echo-suppression fingerprinting.
   Note the negative-observation discipline: iOS running the same pattern fine was part
   of the explanation, not an inconvenience to ignore.

7. **Same-day paired reverts (2026-05-22).** Dewarp margin 10%→15% (`325d9465`) and the
   asymmetric VLM-undercount retake gate (`53649b11`) both reverted within hours
   (`fc2c8489`, `b98078ed`). Fast reverts are normal and cheap here BECAUSE the corpus
   harness gives immediate ground truth; do not defend a change past its evidence.

---

## 4. Where good ideas come from here

**Field-session forensics and recurrence analysis — not speculation.** The repo's
highest-yield fixes trace to a named session, not a brainstorm.

- **Session IDs are provenance.** Field sessions (`F1AC26FB`, `15B88D6B`, `F03B590C`)
  and prod sessions (`sess_mpathxlt_uwth`, `sess_mr8qrvcm_20jn`) appear in commit
  subjects/bodies; defects within a session are numbered and referenced as
  `fix(voice/#2)`. Verify: `git log --oneline --grep="F1AC26FB"` → 6+ commits, PR #55.
- **The forensics pipeline:** each session writes
  `s3://<bucket>/session-analytics/{userId}/{sessionId}/debug_log.jsonl` (prefix
  construction: `src/routes/recording.js:1428`); pre-process with
  `node scripts/analyze-session.js /path/to/session-analytics-dir/` (needs
  `debug_log.jsonl` + `field_sources.json` + `manifest.json`; emits `analysis.json`),
  then `scripts/generate-report-html.js` for the report. Operating detail:
  `certmate-diagnostics-and-tooling`.
- **Recurrence analysis is a first-class idea source.** When the same class bites twice,
  the fix is a *guard*, not another patch: env vars dropped by CI task-def
  re-registration bit twice (JWT_SECRET 2026-04-19, CCU_DEWARP_OUTPUT_WIDTH 2026-05-22)
  → `scripts/check-task-def-env-drift.sh` now gates every deploy. The IR re-ask loop
  re-fixed on 2026-06-16 explicitly cites being "a repeat of 2026-02-18". If your fix
  does not make the recurrence structurally impossible (CI gate, code default,
  contract test), expect to meet the bug again.
- **One session, many defects.** A single 66-minute field session (F1AC26FB) yielded a
  5-defect cluster and 6 backend commits. Mine sessions exhaustively; the marginal
  defect in a session you already have logs for is far cheaper than a new session.

Anti-source: "this framework is being flaky" appearing repeatedly on one symptom. The
standing rule (earned over 5 blind TestFlight builds): **3+ builds/attempts on the same
symptom → STOP fixing, START instrumenting.** The input data is nearly always the bug.

---

## 5. The wrongness ledger habit

When a settled stance is superseded, the docs of record say **what superseded it and
when** — the old stance is not silently deleted, and the new text names its predecessor.
This prevents the two failure modes of doctrine drift: re-adopting a retired idea, and
"correcting" current behaviour back to an obsolete rule found in a stale doc.

In-repo instances of the pattern (imitate these):

| Site | Wrongness note |
|---|---|
| `CLAUDE.md` Audio-First invariant #2 | "This supersedes BOTH the older 'suppress low-confidence confirmations' stance AND the interim 'low-confidence readings ASK' stance" — dated via the 2026-06-18 changelog rows |
| `src/extraction/dialogue-engine/parsers/megaohms.js` header | "LIM ACCEPTANCE (reversed 2026-06-16): 'LIM' was previously rejected here on the theory a 'separate limitation-handling flow' owned it. That flow never existed…" — names the wrong theory AND the job ID that disproved it |
| `src/extraction/ccu-rail-quad.js:66` | "NOTE 2026-05-13: a 0.03 → 0.08 experiment was reverted after corpus tests showed module-count regressions… do NOT just widen this constant" |
| `web/docs/parity-ledger.md` / `web/audit/INDEX-2026-07.md` | "Deliberately NOT gaps (… do not 'fix')" sections listing rejected ideas so parity sweeps don't re-propose them |
| Hub changelog rows | e.g. the 2026-06-18 row explains the `< 0.5` write decision is "a capability-gated PRE-APPLY rollout step, not a behavioural confidence threshold" — pre-empting the misreading |

**Rule:** if your change overturns a documented position, your docs edit must (a) state
the new position, (b) name the old one, (c) date the supersession, (d) land in the same
commit series (per the CLAUDE.md docs-with-every-change mandate; mechanics in
`certmate-change-control`).

---

## 6. Case study: NO fuzzy garble correction — rejecting a plausible idea on safety grounds

**The idea (plausible, repeatedly tempting):** Deepgram garbles domain terms
("tryptoid" for "trip time", "lion" for "LIM", "insurance resistance" for "insulation
resistance"). Why not run edit-distance / fuzzy matching over the transcript and
auto-correct near-misses to domain vocabulary?

**The rejection (project-wide, recorded 2026-07-02 in `web/docs/parity-ledger.md:704`
and `web/audit/INDEX-2026-07.md:36`):** "fuzzy/edit-distance Deepgram garble correction
is rejected project-wide (curated equal-weight keyterms are the only sanctioned
correction mechanism)". The 2026-07-03 WS4 changelog row re-affirms it as a HARD RULE.

**The reasoning:** the output is a safety-critical legal certificate. A *false
correction* silently files a wrong reading against a circuit — indistinguishable from a
real reading, discoverable only by the inspector re-testing. A *miss* is loud: the value
doesn't land, the inspector repeats it. On a certificate, **a confident wrong value is
strictly worse than a visible gap** — the same asymmetry as the blank-beats-guessed-wrong
doctrine (§3 example 5). Open-vocabulary edit-distance correction cannot bound its false
positive rate over arbitrary speech, so no bench number could ever clear the bar.

**What IS sanctioned (know the boundary precisely):**

| Mechanism | Why it passes | Examples |
|---|---|---|
| Curated explicit alias lists | Human-reviewed, enumerable, per-term justified — each alias came from an observed field garble | LIM garbles `lim/limb/limp/limit(ation|ed)/lynn/lym` in `megaohms.js` (set traced to a prompt doc + F1AC26FB); "tryptoid"→RCD (`f4267147`); "international"→"insulation" (`21faef6d`) |
| Deepgram keyterms/boosts (pre-transcription) | Biases the recogniser toward vocabulary; never rewrites what was said | equal-weight `keyterm=` on Flux; `web/src/lib/recording/keyword-boosts.ts` on nova-3 |
| Closed-set unique-match fuzzy on a tiny canonical table | Target set is a handful of BS-EN codes; accepts ONLY if exactly one target is at Levenshtein distance ≤ 1, else no-op — false-positive surface is provably tiny | `fuzzyMatchBsCode` in `src/extraction/dialogue-engine/parsers/bs-code.js` (added `c36f75a5`, 2026-05-06, pre-dating the project-wide rule; kept because it is closed-set + unique-match, NOT transcript rewriting) |

**How to use this case study:** when you (or a reviewer, or the model itself) propose a
correction/inference layer, ask the C1 question — *what does a false positive cost on
the certificate?* If the answer is "a wrong value the inspector won't notice", the idea
needs a bounded, enumerable false-positive story or it dies regardless of how much
recall it would add. Plausibility + benchmark recall do not outrank the safety
asymmetry.

---

## 7. Pre-flight checklist for any new idea

Run this before writing code:

- [ ] Can I state the mechanism in one sentence, and does it explain the negative
      observations too?
- [ ] What number do I predict, from which command, and what is the branch plan if the
      number disagrees? (§2)
- [ ] Has this been tried? Check the tombstones: `git log --all -i --grep="<keyword>"`,
      grep for `NOTE 20` / `do NOT` comments near the constant, the "Deliberately NOT
      gaps" sections in `web/docs/parity-ledger.md` and `web/audit/INDEX-2026-07.md`,
      and `docs/reference/changelog.md`.
- [ ] What is the flag/kill-switch, and is its default the current behaviour, defined in
      source (task-def / code default)?
- [ ] What is the false-positive cost on the certificate? (§6 asymmetry)
- [ ] Which MANDATORY invariant could this touch (Audio-First #1–#3, backend-immutable,
      infra-from-source, web-companion)? If any: route through change control first.
- [ ] What field-session evidence will promote it to default — and what evidence will
      retire it? Write both down in the plan.
- [ ] Who refutes it? (/rp two-reviewer gate for plans; /code-review for diffs; never
      self-certified.)

---

## When NOT to use this skill

| You actually need… | Load instead |
|---|---|
| Symptom→triage for a live failure (login bounce, empty circuits tab, decoder crash) | `certmate-debugging-playbook` |
| The full chronicle of a past investigation / revert (what exactly happened, all hashes) | `certmate-failure-archaeology` |
| How to RUN analyze-session, the latency benches, stage6 harnesses, CloudWatch | `certmate-diagnostics-and-tooling` |
| What counts as a passing test / CI gate / parity-ledger evidence | `certmate-validation-and-qa` |
| The change-classification rules, MANDATORY blocks, docs/commit discipline itself | `certmate-change-control` |
| The live dictate→confirm latency campaign with its decision gates | `certmate-latency-campaign` |
| Analysis recipes (latency budget decomposition, contract tests, A/B via kill-switch) | `certmate-proof-and-analysis-toolkit` |
| Zero-touch-certification frontier strategy and external positioning | `certmate-research-frontier` |
| CCU pipeline internals and its experiment history in depth | `certmate-ccu-pipeline` |

---

## Provenance and maintenance

All facts dated as of 2026-07-06. Re-verify before relying:

| Fact | One-line re-verification |
|---|---|
| Phase-lock add/revert/re-add trio | `git show -s --format="%ad %s" 03563576 fc1602a5 7f8ec5af` |
| EDGE_SEARCH_PAD tombstone still at the constant | `grep -n -B7 "const EDGE_SEARCH_PAD" src/extraction/ccu-rail-quad.js` |
| Flux flip commit + current prod STT value | `git show -s ff620997 && grep DEEPGRAM_STT_MODEL ecs/task-def-frontend.json` |
| Code default still nova3 (env var carries the flip) | `grep -n "DEFAULT_STT_MODEL\|SAFE_STT_MODEL" web/src/lib/runtime-config.ts` |
| CONFIRMATION_MIN_CONFIDENCE role + value | `grep -n "CONFIRMATION_MIN_CONFIDENCE" src/extraction/confirmation-text.js` |
| FINALIZER_TIMEOUT_MS (Phase 2.2 target) | `grep -n "FINALIZER_TIMEOUT_MS" src/extraction/voice-latency-turn-summary.js` |
| Supersession text in Audio-First #2 | `grep -n "supersedes BOTH" CLAUDE.md` |
| LIM reversal note | `grep -n "LIM ACCEPTANCE" src/extraction/dialogue-engine/parsers/megaohms.js` |
| Fuzzy-garble ban wording | `grep -rn "rejected project-wide" web/docs/parity-ledger.md web/audit/INDEX-2026-07.md` |
| BS-code closed-set fuzzy still unique-match ≤1 | `grep -n "distance" src/extraction/dialogue-engine/parsers/bs-code.js` |
| Dual-reviewer gate wording | `head -8 scripts/README-stage6-review.md` |
| Pre-declared bench criteria | `head -10 scripts/stage6-golden-divergence.js scripts/voice-latency-bench/sonnet-ttft-bench.mjs` |
| Bench/forensics entry points | `grep -n "voice-test\|voice-regression" package.json && sed -n '8,12p' scripts/analyze-session.js` |
| Blank-beats-guessed-wrong + barge-in reverts | `git show -s --format="%ad %s" aa529115 6b55b58d` |
| Field-session provenance convention | `git log --oneline --grep="F1AC26FB" \| head` |
| Phase 2.2 still parked on field evidence | `grep -n "Phase 2.2" CLAUDE.md` |
