# Field-feedback wave 2026-07-22 — plan index

Source: 14 voice-feedback reports pulled from prod (`Voice feedback captured` CloudWatch rows + S3 `debug-reports/`), investigated against client realtime debug logs (S3 `session-logs/…/realtime/`) and backend CloudWatch. Sessions:

- `36731498` (2026-07-16, iOS, **pre**-marker-① backend) — feedback ids **79–83**
- `2ACE7677` (2026-07-22, iOS, backend `:334` = latest, PLAN-C P4d live) — ids **84–89**
- `B4C45F25` (2026-07-22, iOS, backend `:334`) — ids **90–92**

id79 (garbled no-op chime-then-silence) is **already fixed** — it is the marker-① keystone (#97). Everything else is open and mapped below.

| Plan | Feedback ids | Repo(s) | Verification lane |
|---|---|---|---|
| P1 ring-script-hardening — **moved to `~/.claude/handoffs/EICR_Automation--ring-script-hardening-2026-07-22/PLAN.md` (in /rp)** | 90, 91, 92 | backend only | recorded-lane fixture + unit |
| [P2 readback-exactly-once](plan-p2-readback-exactly-once.md) | 84, 87 | iOS + web (+backend mirror) | unit + device smoke (TestFlight) |
| [P3 lim-for-zs](plan-p3-lim-for-zs.md) | 86 | backend only | unit + recorded fixture |
| [P4 ask-decline-ack-net](plan-p4-ask-decline-ack-net.md) | 85 | backend only | recorded-lane fixture + unit |
| [P5 same-turn-clear-write-wipe](plan-p5-same-turn-clear-write-wipe.md) | 80(B), 81 (marker T10) | backend only | recorded-lane fixture (T10) |
| [P6 transcript-normaliser](plan-p6-transcript-normaliser.md) | 89, 80(A) (+megaron/milligrams todos) | backend only | unit + voice-regression |
| [P7 obs-dedupe-demotion](plan-p7-obs-dedupe-demotion.md) | 82 (marker ④) | iOS + web check | unit + device smoke (TestFlight) |
| [P8 prompt-steers-batch](plan-p8-prompt-steers-batch.md) | 88, 83 (marker ⑤) (+optional 85 belt) | backend (prompt only) | LIVE-lane probes post-deploy |

## Recommended execution order

1. **P1** — worst live UX cascade (delete hijack → question loop → wrong-circuit swallow); backend-only, ships alone.
2. **P5** — silent data loss (value spoken then wiped); backend-only.
3. **P3** — explicit Derek feature ask, small; backend-only.
4. **P4** — Audio-First silence gap; backend-only.
5. **P6** — deterministic garble/normaliser layer; backend-only. (Reduces P8's load: fewer garbles reach the model.)
6. **P2 + P7** — the two client fixes; independent plans but **ride ONE TestFlight build** (+ one web deploy for P2's web half).
7. **P8** — single batched prompt edit (one cache invalidation), verified by live probes.

P1–P6 are mutually independent (different files); P2/P7 are independent of each other (different subsystems, same app binary). P8 last so the prompt steer is tested against the fixed deterministic layers.

## Integration notes across seams

- P1, P4 both add speech on previously-silent paths — both ride the existing field-nil confirmation channel; no wire change; wording must stay distinct from the marker-①/② apology families (client 30s text-keyed dedupe).
- P2's backend part is telemetry-mirror only (`ios-dedupe-key.js`) — it does NOT change wire frames; the behavioural change is client-side. Not a backend-immutability violation, but flag in review.
- P6 normalises the transcript BEFORE `classifyOvertake`/`runShadowHarness` — P1's entry regexes and P8's steers then see normalised text; keep P6's map enumerated-only (fuzzy ban, parity §3E).
- P3 touches `record_reading` validation; P1 touches the dialogue engine — no file overlap.
- Shared-test-file rule: P1/P4/P5 all add tests under `src/__tests__/stage6-*`/dialogue-engine — if run as parallel workstreams, re-run the full backend suite on main between merges (MANDATORY hub rule).
