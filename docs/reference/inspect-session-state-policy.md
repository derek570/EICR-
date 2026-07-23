# `inspect_session_state` — certificate-completeness policy (A1 Phase 0.6 appendix)

Status: **APPROVED APPENDIX** for the A1 agentic-voice plan (`~/.claude/handoffs/EICR_Automation--agentic-voice-2026-07-22/PLAN-final.md`, Phase 0.6).
This document is the authoritative policy for the `inspect_session_state` tool's
`summary`/`board` scope promises ("missing-field NAMES", "what's left" counts). Item 1b
implements exactly this; changing the policy means changing this file first.

## 1. Authoritative sources

- **`.claude/skills/bs7671-domain-reference/SKILL.md`** — the in-repo BS 7671 canon: the
  29 circuit columns / 7 groups (§5), IR sentinels + LIM semantics (§3), ring vs continuity
  distinction (§2), EICR-vs-EIC differences (§1).
- **`config/field_schema.json`** — the single source of truth for field keys, labels, and
  option lists (`circuit_fields`, 31 keys). The policy below classifies exactly those keys.
- The repo has NO pre-existing required-fields declaration; this appendix derives one from
  the canon. Where BS 7671 practice and this appendix disagree, this appendix is the shipped
  behaviour and should be amended by a follow-up commit, not routed around.

## 2. The ONE pure policy function

```
getApplicableRequiredFields({ certType, circuit }) -> string[]   // circuit-field keys
```

- `certType`: `'EICR' | 'EIC'` — **the applicability matrix is IDENTICAL for both**: the
  BS 7671 Schedule of Test Results columns are shared by EICR and EIC (canon §1 — the
  certificate types differ at certificate level: observations vs EIC extent/design sections,
  which are NOT circuit-completeness inputs). The parameter is retained so a future
  divergence is a policy edit, not a signature change.
- `circuit`: the circuit BUCKET (the object stored in the snapshot `circuits` map), read
  through `getCircuitBucket` — never a raw index. The function is pure: no session access,
  no mutation, deterministic on the bucket's own values.

### 2.1 Classification of the 31 `circuit_fields` keys

**Identity (never counted as missing):** `circuit_ref` — present by construction.

**REQUIRED_BASE (every tested circuit, both cert types):**
`circuit_designation`, `wiring_type`, `ref_method`, `number_of_points`, `live_csa_mm2`,
`cpc_csa_mm2`, `max_disconnect_time_s`, `ocpd_bs_en`, `ocpd_type`, `ocpd_rating_a`,
`ocpd_breaking_capacity_ka`, `ocpd_max_zs_ohm`, `r1_r2_ohm`, `ir_test_voltage_v`,
`ir_live_live_mohm`, `ir_live_earth_mohm`, `polarity_confirmed`, `measured_zs_ohm`
(18 keys — the schedule columns every completed row carries; `r1_r2_ohm` on a ring is
normally auto-derived from (r1+r2)/4 by the existing derivation pass, but an empty cell is
still reported missing — the schedule cell would print blank).

**CONDITIONAL:**

| Fields | Required iff | Predicate (on the bucket) |
|---|---|---|
| `ring_r1_ohm`, `ring_rn_ohm`, `ring_r2_ohm` | ring final circuit | `circuit_designation` matches `/\bring\b/i` OR any of the three `ring_*` values is populated |
| `rcd_bs_en`, `rcd_type`, `rcd_operating_current_ma`, `rcd_time_ms`, `rcd_button_confirmed` | RCD-protected circuit | any `rcd_*` field populated with a value other than `N/A`, OR `ocpd_bs_en === 'BS EN 61009'` (RCBO) |
| `feeds_board_id` | distribution circuit | `is_distribution_circuit === 'yes'` |

**NEVER REQUIRED (optional / diagnostic):**
`r2_ohm` (alternative CPC-only measurement), `afdd_button_confirmed` (blank ≡ N/A per
schema ai_guidance), `is_distribution_circuit` (blank ≡ 'no').

**SPARE-WAY EXEMPTION:** if `circuit_designation` matches `/\bspare\b/i`, NOTHING beyond
`circuit_designation` is required — spare ways carry no tests. (Canonical CCU output names
spares "Spare".)

Evaluation order: spare-way exemption → REQUIRED_BASE → conditional adds. The returned
array is the union, in schema declaration order (stable for tests).

### 2.2 Empty-value / N/A / LIM semantics

A field is **missing** ⇔ its value is `null`/`undefined`, OR a string whose `trim()` is `''`.
Every non-empty recorded value **satisfies** requiredness, explicitly including:
- `LIM` — a recorded limitation IS an outcome (canon §3: first-class valid value; rejecting
  it looped the IR ask — never re-litigate).
- `N/A` — recorded inapplicability.
- Saturation sentinels `>200`, `>999`, and comparison forms.
- `FAIL` / `N` — a recorded failure is complete data (it drives observations, not gaps).

Non-string non-null values (numbers, booleans) are present.

## 3. Immutable response shapes (all four scopes)

All shapes are emitted as the dispatcher tool_result `content` (JSON.stringify), with
`is_error` per §5. All user-derived strings (designations, free-text values) pass through
the shared sanitise + `<<<USER_TEXT>>>` wrap helpers (extracted leaf module — identical
output to snapshot rendering). Totals are computed BEFORE truncation, so counts stay
accurate even when lists are cut.

### scope=summary  (args: none used)
```json
{ "ok": true, "scope": "summary", "cert_type": "EICR",
  "boards": [ { "board_id": "main", "designation": "<wrapped>", "circuit_count": 8,
                "complete_circuits": 5, "incomplete_circuits": 3 } ],
  "total_circuits": 12, "total_complete": 7, "total_incomplete": 5,
  "observation_count": 2, "truncated": false }
```
`cert_type` null when unknown; `observation_count` null when the session carries no
observation ledger. A circuit is *complete* ⇔ its missing set (per §2) is empty.

### scope=board  (args: `board_id` optional → currentBoardId)
```json
{ "ok": true, "scope": "board", "board_id": "main", "designation": "<wrapped>",
  "circuit_count": 8,
  "circuits": [ { "circuit": 4, "designation": "<wrapped>",
                  "missing": ["measured_zs_ohm", "polarity_confirmed"], "missing_count": 2 } ],
  "truncated": false }
```
`circuits[]` lists ONLY incomplete circuits (complete rows add nothing to "what's left").
Missing-field NAMES are the schema keys (the model translates to spoken labels).

### scope=circuit  (args: `circuit` required; `board_id` optional → currentBoardId)
```json
{ "ok": true, "scope": "circuit", "board_id": "main", "circuit": 2,
  "designation": "<wrapped>",
  "values": { "measured_zs_ohm": "0.42", "ocpd_rating_a": "32" },
  "missing": ["ir_live_earth_mohm"], "truncated": false }
```
`values` carries every POPULATED field (missing ones are in `missing`).

### scope=field  (args: `field` required; `circuit` optional — absent ⇒ supply/board-level
lookup in the legacy `circuits[0]` bucket + board record; `board_id` optional)
```json
{ "ok": true, "scope": "field", "board_id": "main", "circuit": 2,
  "field": "measured_zs_ohm", "recorded": true, "value": "0.42" }
```
Known field with no value → `{ ok: true, ..., "recorded": false, "value": null }` (that IS
the answer — "no Zs recorded yet"), `is_error: false`.

## 4. Serialized-size cap and truncation

`INSPECT_MAX_RESULT_BYTES = 4096` (UTF-8 byte length of the serialized `content`).
When exceeded, truncate deterministically and set `"truncated": true`:
1. `board`/`summary`: first drop per-circuit `missing` arrays (keep `missing_count`),
2. then drop tail entries of `circuits[]`/`boards[]` (lowest refs kept, list order stable),
3. `circuit`: drop `values` entries from the tail (keep `missing` names),
4. `field`: byte-truncate the value string to 512 bytes (code-point-safe, marker-aware —
   a wrapped USER_TEXT value keeps BOTH markers; the INNER payload is what shrinks),
5. *(amended 2026-07-23, Codex diff-review r2)* byte-trim every retained wrapped string
   (top-level `designation`, surviving per-circuit/board designations, `values` entries)
   to 256 bytes each, code-point-safe + marker-preserving,
6. *(fail-closed)* if STILL over the cap, return the minimal fixed shape
   `{ok:true, scope, board_id?, circuit?, truncated:true, overflow:true}` — never an
   over-cap payload.
Counts/totals are never recomputed after truncation. Re-serialize after each stage; stop
as soon as the cap is met. All byte measures are UTF-8 (`Buffer.byteLength`), never
`String.length`.

## 5. `is_error` for every outcome (mirrors PLAN Item 1b)

| Outcome | body | `is_error` |
|---|---|---|
| success (all scopes, incl. `recorded:false`) | `{ok:true, ...}` | `false` |
| unknown scope value / missing scope-required arg / unknown field name / malformed circuit arg | `{ok:false, code:'invalid_scope'}` | `true` (retry signal — model may correct args) |
| `board_id` not in `boards[]`, or circuit not present in the target board | `{ok:false, code:'not_found'}` | `true` |

Both codes are safe as retry signals because `answer_user`/`inspect_session_state` are
name-guard-excluded from the A3 orphan net's `allRejected` (PLAN Item 4).

## 6. Trust boundary

- The projector reads ONLY through `listCircuitRefsInBoard` / `getCircuitBucket` /
  `getMainBoardId` (`stage6-multi-board-shape.js`) — never direct `circuits[...]` keying
  (main and sub-boards can share a ref).
- Every user-derived string returned in a tool_result is sanitised + USER_TEXT-wrapped via
  the SAME helpers the snapshot uses (extracted to a leaf module — never duplicated).
- No mutation: the dispatcher deep-equal-pins the snapshot before/after in tests.
