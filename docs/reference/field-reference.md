> Last updated: 2026-07-31
> Related: [Architecture](architecture.md) | [iOS Pipeline](ios-pipeline.md) | [Deployment](deployment.md) | [File Structure](file-structure.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# Complete UI Field Reference (Single Source of Truth)

**IMPORTANT:** This document lists ALL fields in the PWA UI. When the UI changes, update both this document AND `config/field_schema.json`. The AI extraction (`src/extract.js`) reads the field schema to know exactly what fields to extract from audio transcripts.

## How to Keep AI in Sync with UI Changes

1. When you add/modify a UI field, update `config/field_schema.json`
2. The schema includes `ai_guidance` for each field telling the AI how to extract it
3. Update the relevant table below to document the change
4. The AI will automatically use the updated schema for extraction

## Voice-reading route contract (PLAN-2D, 2026-07-31)

`src/extraction/client-routable-reading-fields.js` is the authoritative
server-to-client route manifest for every Stage-6 reading that may leave the
backend. Its committed JSON mirror at
`tests/fixtures/test-contracts/client-routable-reading-fields.json` is
byte-identical to the Swift test fixture and deep-compared with the live web
router. Each field names one destination: `circuit`, `board_info`,
`supply_characteristics`, `installation_details`, `extent_and_type`, or
`design_construction`.

The dispatcher field universe must remain a complete, pairwise-disjoint
partition of client-routable readings, deliberately unroutable legacy
sub-main fields, structural/hierarchy fields, and correction-only aliases.
`cpc_csa_mm2` corrects to `cable_size_earth`; `max_zs` and `ocpd_max_zs`
correct to `ocpd_max_zs_ohm`. The three sub-main fields are rejected with a
Board-tab notice, and structural fields never escape as ordinary readings.
Only positive `is_distribution_circuit` intent on a source circuit is
recoverable via `mark_distribution_circuit`; `feeds_board_id` and all other
structural attempts are terminal. All three write tools check raw membership
at their first dispatcher boundary before any other validation and stage one
shared, covered, leak-safe refusal. Ordinary circuit writes first normalise an
empty board scope to absent; authoritative board writes retain it so
`record_board_reading` still rejects an injected empty id as `wrong_board`
instead of silently retargeting the current board.
The legacy extraction path sanitises before snapshot mutation; if a malformed
turn also contains valid siblings, their model prose is replaced with exactly
one server-built read-back per surviving slot, while untrusted questions,
alerts, speech, and actions are removed. Rejected turns rebuild their stored
assistant-history text from this sanitized result before it can enter a later
message window. The later egress pass is idempotent.

Board attribution is separate from clearing scope. The server stamps
`board_id` on `manufacturer`, `name`, `location`, `phases`, `ze_at_db`, and
`ipf_at_db`; the clients additionally retain the legacy `zs_at_db` board
route. An explicit sub-board write updates only that board, while an unknown
or ambiguous board fails closed. A legacy job with no `boards[]` materialises
the backend-default `main` record in both clients, so the server's stamped
identity is applied rather than mistaken for an orphan. Web translates legacy
`design_comments` only
into the rendered/PDF `comments` destination rather than retaining an invisible
raw property. Web and iOS accept inspection intervals 1–10, and iOS preserves
both true and false `supply_polarity_confirmed` values while rejecting unknown
tokens. Web and iOS source is held for PLAN-4's
wave-end deploy/TestFlight build rather than shipped independently.

## Voice clearing of board/supply/installation fields (`clear_board_reading` — plan A1a, 2026-07-27)

The `clear_board_reading` Stage-6 tool is **DEPLOYED but DISPATCHER-DENIED for
every session** pending client rollout (plan A1b) — do NOT describe board/
supply/installation fields as voice-clearable yet. The tool is advertised to
the model unconditionally, but no shipped client advertises the
`board_clear_v1` capability, so every call is soft-denied (no mutation, no
`field_corrected` frame; the inspector hears a specific capability notice).
Circuit-field clearing via `clear_reading` is unchanged and live.

The candidate enum is `BOARD_FIELD_ENUM` minus `BOARD_CLEAR_EXCLUSIONS` (78
members today) — the exclusions are the five structural/hierarchy keys that
define WHAT a board is (`name`, `board_type`, `parent_board_id`,
`feed_circuit_ref`, `sort_order`) plus `earth_loop_impedance_ze` (a wire-alias
duplicate of `ze`: `FIELD_CORRECTIONS` collapses both onto one wire name, so
only the canonical spelling is advertised; the mutator still sweeps BOTH
snapshot spellings on a clear). A NEW `field_schema.json` key added to any
board/supply/installation section becomes a clear-enum candidate automatically
and FAILS the literal pin in `stage6-clear-board-reading-enum.test.js` until a
human classifies it (clearable vs structural exclusion) — that fail-closed
step is deliberate; do not blindly re-paste the literal. A1b's advert-time
sweep re-narrows the enum to the both-clients-routable subset before any
client advertises.

## Circuit designation — canonical storage & repair semantics (PLAN-B/B2, 2026-08-24)

Derek's product rule (feedback id 128): the word "circuit" never appears at a stored
designation's EDGES — the certificate column is already headed "Circuit description".

- **Canonical form:** standalone LEADING/TRAILING `circuit`/`circuits` tokens are stripped
  (iteratively, case-insensitive, delimiter grammar — hyphen is NOT a delimiter, so
  "Short-circuit tester" is untouched). INTERIOR tokens are kept ("Ring circuit sockets")
  — interior removal is a deferred Derek decision.
- **Caller policy:** backend interactive dispatchers REJECT a banned-token-only value
  (`invalid_designation`); every persistence/client boundary uses REPAIR-never-reject —
  a banned-token-only value ("Circuit") stays UNCHANGED, because an EMPTY designation
  classifies the row as a SPARE on both clients.
- **Implementations (three, contract-locked):** backend
  `src/extraction/designation-canonicaliser.js`; web/shared
  `packages/shared-utils/src/designation-canonicaliser.ts`; iOS
  `Sources/Utilities/DesignationCanonicaliser.swift`. All three assert the shared
  37-vector fixture `config/designation-canonical-vectors.json`; the iOS copy is pinned
  by a paired SHA-256 digest and `scripts/check-designation-fixture-sync.sh`
  (pre-TestFlight byte-compare). Change vectors only cross-platform.
- **Client boundaries (PLAN-B2):** voice appliers (entry, storage+speech from the same
  canonical value), wire-frame applies + a grammar-aware confirmation slot rewrite,
  draft-buffered manual edits (commit on focus-loss, never per keystroke), CCU/document/
  preset imports (incoming copy repaired BEFORE matching), load-boundary repair of
  pre-existing dirty jobs, and PDF preflights on both clients' engines.

## Closed-enum circuit fields — client-local validate-or-ask (PLAN-C, 2026-08-24)

Feedback id 129, field session 17821FFA: a garbled dictation put `"FOR"` into
`wiring_type` on two circuits and the ordinary success line was read back, so the
inspector heard a confident confirmation of a value no dropdown offers. The
CLIENT-LOCAL apply paths never validated against the closed option list — only the
server-extraction lane did — and iOS's transport had already truncated the residue to
a plausible-looking first word, destroying the evidence a guard would need.

- **Guarded fields (5):** `wiring_type`, `ref_method`, `ocpd_type`,
  `rcd_bs_en`, `rcd_type`. Derived from `config/field_schema.json` `circuit_fields`
  where `type === 'select'`, MINUS the four boolean/confirmable selects
  (`polarity_confirmed`, `rcd_button_confirmed`, `afdd_button_confirmed`,
  `is_distribution_circuit` — spoken yes/no vocabulary, not closed code lists) and
  MINUS the `''` blank option (blank is a `missing_value` re-ask, never a blanking
  write).
- **`ocpd_bs_en` LEFT this set on 2026-09-23 (PLAN-CC)** — see the section below. It is
  free text now, so there is no option list to test membership against. It keeps its
  re-ask label, noun and example rows in `config/closed-enum-vectors.json` and speaks
  through the SAME renderer, because a canonicalisation miss still re-asks and that copy
  must not drift between the clients.
- **Contract:** a value outside the closed list is REFUSED — nothing written — and ONE
  complete-restatement re-ask is spoken, naming the field, echoing what was heard, and
  giving a concrete example. An accepted value is stored AND spoken from the SAME
  canonical string (casing snapped by the guard, e.g. `gg` → `gG`). Recovery is a full
  restatement through the normal parse path; there is deliberately no pending-correction
  state machine.
- **Placement discipline:** validate ONCE, before scope resolution/iteration — never
  inside a per-circuit setter. A guard inside the loop would speak N times on a bulk
  write, and the setter's zero-updates branch would clobber the spoken override.
- **Transport:** the value residue crosses to the guard WHOLE — no first-word truncation
  and no re-uppercasing. Both clients lowercase the transcript before matching
  (`packages/shared-utils/src/voice-commands.ts`), so the residue reaching the guard is
  lowercase on both and casing is exclusively the guard's business.
- **Implementations (two, contract-locked):** web/shared
  `packages/shared-utils/src/closed-enum-guard.ts`; iOS
  `Sources/Utilities/ClosedEnumGuard.swift`. Both assert the shared fixture
  `config/closed-enum-vectors.json` (option sets, accepted/rejected value vectors, and
  the FROZEN re-ask render vectors); the iOS copy is pinned by a paired SHA-256 digest
  and `scripts/check-closed-enum-fixture-sync.sh` (pre-TestFlight byte-compare). The
  web suite re-derives the fixture's option lists from `field_schema.json`, so a schema
  edit fails loudly in a required CI job instead of silently making a dictated value
  unspeakable. The re-ask wordings join the backend spoken-string distinctness union
  (`stage6-honest-refusal.test.js` §5.12) because the client TTS dedupe is family-blind
  — a colliding re-ask would be swallowed as a repeat.
- **Deliberately NOT ported from the backend BS-code parser:** its Levenshtein-1 fuzzy
  fallback. That maps `1362` → `BS 1361`, a DIFFERENT protective device; a silently
  substituted device standard on a certificate is exactly the failure this guard exists
  to prevent. PLAN-CS (2026-09-24) removed that fallback from the backend too.
- **Guarded ingresses:** both client-local voice dispatchers on each platform
  (`update_field` and `apply_field`), the wire-frame apply boundary, and web's regex
  instant-fill (`applyRegexMatchToJob`) — the instant-fill path is GUARDED because it
  writes ~40 ms before any server opinion exists. The legacy `extracted_readings` lane
  is documented-unguarded and deferred (C2b): it is a server-extraction egress the
  backend validator already constrains, and duplicating the guard there would risk a
  second spoken refusal for a value the server already refused.
- **Deliberate picker/schema divergence (queued as a Derek decision):** iOS's
  `Constants.refMethods` offers the granular BS 7671 methods `A1/A2/B1/B2/D1/D2` and its
  OCPD-type picker is a superset; `field_schema.json` carries neither. Those values are
  therefore refused when DICTATED while remaining tappable — which matches what the
  backend validator already does. Widening the schema is a separate backend + web
  dropdown + PDF change; the divergence is pinned by named tests on BOTH clients so it
  cannot be "fixed" one-sidedly.

## Free-text OCPD standard + standard-aware max Zs (PLAN-CC, 2026-09-23)

EVIDENCE.md item 140. `ocpd_bs_en` was a closed list of eight schema options, and an
inspector reads whatever standard is printed on the device. `BS 3871`, `BS 88-6`,
`BS EN 60947-4-1` and `BS 1362` are all real device standards that were not on the
list, so dictating one drew a re-ask and the certificate recorded nothing.

- **The field is free text on both clients.** One shared ten-step canonicaliser
  (`packages/shared-utils/src/ocpd-standard.ts` and its Swift twin
  `Sources/Utilities/OcpdStandard.swift`) turns the forms Deepgram Flux produces into a
  canonical string and returns a MISS for anything the grammar cannot read. No edit
  distance anywhere — the project's hard rule against fuzzy garble correction is intact.
- **The normative source is `config/ocpd-bs-suggestions.json`, not this document and not
  the plan.** Its `accepted_value_vectors` / `rejected_value_vectors` ARE the alias
  table; both clients are driven through every vector and compared byte for byte. It is
  byte-copied into the iOS repo with paired SHA-256 pins, and
  `scripts/check-ocpd-bs-fixture-sync.sh` runs as a named hard-fail pre-TestFlight step.
- **A miss behaves differently by boundary.** At an interactive one (a dictated
  apply-field command) it re-asks, because there is someone to ask. At an automatic one
  (server apply, CCU photo, document import) or a manual one (a picker) the value is
  stored exactly as it arrived and the row wears a compatibility marker — never dropped.
- **Max Zs keys on the (standard, type) pair.** Keying on the type alone was safe only
  while the standard was a closed list the type implied: a `BS 3871` breaker dictated
  with the legacy type `2` read the BS 1361 cartridge-fuse row. The tuple lookup returns
  null far more often, so every write to `ocpd_bs_en`, `ocpd_type`, `ocpd_rating_a` or
  `max_disconnect_time_s` routes through one helper per client.
- **`ocpd_max_zs_source` is an additive optional circuit key with THREE states.** `auto`
  is recomputed and cleared as the tuple changes; `manual` (a human edit, or an import
  that carried an explicit max Zs) is never touched; ABSENT means pre-plan data of
  unknown origin and is preserved and marked "unverified" rather than cleared on a
  guess. It rides the job JSON PUT/GET and `test_results.csv` (`src/export.js`
  `CIRCUIT_FIELD_ORDER` + `CIRCUIT_HEADERS`); no WebSocket frame carries it, and it is
  deliberately absent from `config/field_schema.json` so ADR-008 derives no model tool
  enum for it — the model must never set its own provenance.

### The backend half (PLAN-CS, 2026-09-24)

PLAN-CC made both clients tolerate any string; PLAN-CS flips the backend to match.

- **Schema.** `ocpd_bs_en` is `type: "text"` in `config/field_schema.json`, with
  `suggestions` (Tier 1) and `suggestions_extended` (Tier 2) arrays asserted identical to
  `config/ocpd-bs-suggestions.json` by `ocpd-bs-suggestions.test.js`. It left
  `CIRCUIT_FIELD_VALUE_ENUMS`, so the dispatcher's closed-enum gate no longer covers it.
  `rcd_bs_en` stays a `select`.
- **Two parsers** in `src/extraction/dialogue-engine/parsers/bs-code.js`, each bound to its
  own slots. `parseOcpdStandard` is the backend twin of the client canonicaliser, driven
  through every manifest vector byte for byte. `parseRcdBsCode` canonicalises the same way
  and then accepts only an `rcd_bs_en` option (the `""` sentinel excluded).
  `parseBsCode` and its Levenshtein-1 fallback are gone.
- **One shape rule at every boundary.** `record_reading` and `set_field_for_all_circuits`
  reject an unreadable standard as `ocpd_standard_shape` (the tool result lists the
  accepted forms); the Loaded Barrel speculator skips pre-synthesis for it
  (`voice_latency.speculator_skipped_ocpd_shape`); a dialogue seed drops it as
  `seed_unparseable`. The rule is registered as the `parser_backed` descriptor for
  `ocpd_bs_en` in `circuit-value-descriptors.js`, so the handoff note's validation entry
  and the dispatcher gate share one predicate.
- **The one ask after a rejection** is read by `resolveOcpdStandardAnswer`
  (`stage6-answer-resolver.js`), ahead of the enum resolver. A readable answer is written
  (`match_status: "ocpd_standard_resolved"`); a bulk answer is written through
  `set_field_for_all_circuits` carrying the rejected call's own `scope`, `spare_policy`
  and `exclude_circuits` verbatim. An unreadable answer stages PLAN-C3's post-ask refusal
  and returns `ocpd_standard_rejected_after_ask`, which is terminal. An `ask_user` about
  `ocpd_bs_en` with no circuit, no circuit set and no bulk lineage is refused before
  registration as `ask_requires_target`.
- **RCBO dialogue.** Neither RCBO BS slot is named-extracted and no BS mirror exists
  anywhere: one utterance used to fill both slots, so an RCD answer overwrote the OCPD
  standard. Both are ordinary asked slots (`ocpd_bs_en`, then `rcd_bs_en`, then the
  curve). `rcd_bs_en` counts as filled only when its stored value parses (`slotIsFilled`
  in `helpers/extraction.js`); a skip verb on a stored value that does not parse hands
  off to the model instead of keeping it. The RCBO finish line names the RCD's number
  only when it differs from the OCPD standard.
- **The prompt's Tier-1 list is rendered**, not written: `{{OCPD_STANDARD_TIER1}}` in
  `config/prompts/sonnet_agentic_system.md` is replaced from the manifest in both prompt
  variants by `renderAgenticSystemPrompt`.

## Installation Details Tab (`/job/[id]/installation`)

| Field | Type | Options | AI Extraction Guidance |
|-------|------|---------|----------------------|
| `client_name` | text | - | Name of client/property owner. Listen for "Mrs Smith", "Mr Jones", etc. Dispatcher REJECTS address-shaped values written here (`client_name_looks_like_address`) — those belong in the `client_*` family below (Phase 4.3). **Installation-GLOBAL identity field (A01P, 2026-09-08):** the fixed `GLOBAL_IDENTITY_FIELDS` set in `stage6-snapshot-mutators.js` makes record, clear, and inspect bypass board scope for it — it always lives in `circuits[0]`, never on a `boards[]` record, any `board_id` spelling (absent, current, other, unknown, empty) reaches it, and `inspect_session_state` answers it with `board_id: null`. Seeded from the job's installation bucket (`client_name` or iOS `clientName`, snake precedence). |
| `client_address` | text | - | BILLING address — distinct from site address. Voice writes are server-owned. When the inspector accepts or explicitly commands a site→client mirror, the deterministic backend controller copies a complete captured source family as designed-silent `derived:true` writes; clients never perform a local mirror. |
| `client_postcode` | text | UK postcode pattern | BILLING postcode. Companion to `client_address`. |
| `client_town` | text | - | BILLING town. Derived from postcode when omitted. |
| `client_county` | text | - | BILLING county. Derived from postcode when omitted. |
| `address` | text | - | Full SITE/installation address. Listen for street, house number, town. Voice writes are server-owned; client regex may provide only a non-mutating current-utterance postcode lookup hint. |
| `postcode` | text | - | SITE UK postcode like "RG1 1AA". The authoritative dictated postcode is read back. Matching `postcodes.io` town/county enrichment is journalled as `derived:true` for client delivery but remains designed-silent and produces no extra confirmations; the hint itself never selects the site/client family. |
| `premises_description` | select | Residential, Commercial, Industrial, Agricultural, Other | Usually "Residential" for houses |
| `installation_records_available` | boolean | - | True if previous certificates/records available |
| `evidence_of_additions_alterations` | boolean | - | True if unrecorded work found |
| `next_inspection_years` | numeric stepper | Whole years 1–10 | Typically 5 years domestic, 3 for rented |
| `extent` | text | - | What was inspected: "Whole installation", "Main CU only" |
| `agreed_limitations` | text | - | What couldn't be accessed: "No loft access", "Floor boxes not lifted" |
| `agreed_with` | text | - | Who agreed to limitations: "Mrs Smith", "The tenant" |
| `operational_limitations` | text | - | Technical issues: "Could not isolate supply" |

## Supply Characteristics Tab (`/job/[id]/supply`)

| Field | Type | Options | AI Extraction Guidance |
|-------|------|---------|----------------------|
| `earthing_arrangement` | select | TN-S, TN-C-S, TT, IT, TN-C | Listen for "PME", "TN-C-S", "earth rod" (TT), "separate earth" (TN-S) |
| `live_conductors` | select | AC - 1-phase (2 wire), AC - 3-phase (4 wire), etc. | Usually "AC - 1-phase (2 wire)" domestic |
| `number_of_supplies` | select | 1, 2, 3, 4, 5, N/A | Usually "1" for domestic |
| `nominal_voltage_u` | select | 230, 400, 110, N/A, Other | 230V single-phase, 400V three-phase |
| `nominal_voltage_uo` | select | 230, 400, 110, N/A, Other | 230V for UK domestic |
| `nominal_frequency` | select | 50, 60, N/A | Always 50Hz in UK |
| `prospective_fault_current` | text | - | Listen for "PFC", "prospective fault current". Format: "2.5" |
| `earth_loop_impedance_ze` | text | - | Listen for "Ze", "external earth". TN-C-S typical <0.35 |
| `supply_polarity_confirmed` | boolean | - | True if origin polarity confirmed correct |
| `spd_bs_en` | text | - | DNO supply cutout fuse standard: "88-2.2", "1361" (NOT the main switch) |
| `spd_type_supply` | text | - | DNO supply cutout fuse type: "gG" (NOT the main switch) |
| `spd_short_circuit` | text | - | Supply cutout breaking capacity kA |
| `spd_rated_current` | text | - | DNO supply cutout fuse rating: "60", "80", "100" (NOT the main switch rating) |

## Board Info Tab (`/job/[id]/board`)

| Field | Type | Options | AI Extraction Guidance |
|-------|------|---------|----------------------|
| `name` | text | - | Board designation: "DB-1", "Main CU" |
| `location` | text | - | Physical location: "Under stairs", "Garage" |
| `manufacturer` | text | - | CU make: "Hager", "MK", "Wylex", "Crabtree", "BG" |
| `phases` | select | 1, 3 | Usually "1" for domestic single-phase |
| `earthing_arrangement` | select | TN-C-S, TN-S, TT | Same as supply - duplicated for board-specific |
| `ze` | text | - | Ze reading at board |
| `zs_at_db` | text | - | Zs reading at board. Should be Ze + R1+R2 |
| `ipf_at_db` | text | - | PFC at board. Domestic typically 1-6kA |

## Circuits Tab (`/job/[id]/circuits`) - All 29 Columns

### Circuit Details Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `circuit_ref` | Sequential numbers: 1, 2, 3... |
| `circuit_designation` | Brief description: "Lights Kitchen", "Sockets Ring", "Cooker". **Designation hygiene (PLAN-B, 2026-08-23):** the word "circuit"/"circuits" is never stored as a standalone leading/trailing token (the certificate column is already headed "Circuit description") — write dispatchers strip it, persistence repairs it, and interactive paths reject a banned-token-only value; interior tokens ("Ring circuit sockets") and hyphen compounds are kept. |
| `wiring_type` | Usually "A" for domestic |
| `ref_method` | Usually "A" for domestic |
| `number_of_points` | Count of outlets: 1-12 lighting, 4-8 sockets |
| `live_csa_mm2` | Cable size: 1.0 (lights), 2.5 (sockets), 6.0 (cooker), 10.0 (shower) |
| `cpc_csa_mm2` | Earth size: 1.0, 1.5, 2.5, 4.0 |
| `max_disconnect_time_s` | Usually "0.4" for 230V circuits |

### OCPD Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `ocpd_bs_en` | Free text, canonicalised: "60898" → "BS EN 60898" (MCB), "61009" → "BS EN 61009" (RCBO), "3871" → "BS 3871". Any standard-shaped value; see the PLAN-CS section above. |
| `ocpd_type` | "B" domestic, "C" motors |
| `ocpd_rating_a` | 6A lights, 16/20A radial, 32A ring/cooker, 40A shower |
| `ocpd_breaking_capacity_ka` | Usually "6" domestic |
| `ocpd_max_zs_ohm` | Max Zs from BS7671 tables |

### RCD Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `rcd_bs_en` | "61008" (RCCB), "61009" (RCBO) |
| `rcd_type` | "A" most common, "AC" basic |
| `rcd_operating_current_ma` | Usually "30" for additional protection |

### Ring Final Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `ring_r1_ohm` | End-to-end r1 reading. Typical 0.2-0.8 |
| `ring_rn_ohm` | End-to-end rn reading. Similar to r1 |
| `ring_r2_ohm` | End-to-end r2 (CPC). Slightly higher than r1 |

### Continuity Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `r1_r2_ohm` | R1+R2 at furthest point. Typical 0.1-2.0 |
| `r2_ohm` | R2 only reading |

### Insulation Resistance Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `ir_test_voltage_v` | Usually "500" standard, "250" for electronics |
| `ir_live_live_mohm` | L-N reading. Must be >1M. Use ">200" if high |
| `ir_live_earth_mohm` | L-E reading. Must be >1M. Use ">200" if high |

### Test Results Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `polarity_confirmed` | "OK" or "Y" if passed |
| `measured_zs_ohm` | Zs reading. Typical 0.3-1.5 domestic |
| `rcd_time_ms` | Trip time at 1x. Must be <300ms. Typical 15-30ms |
| `rcd_button_confirmed` | "OK" or "Y" if test button works |
| `afdd_button_confirmed` | "OK" if AFDD fitted and tested |

> **LIM on numeric reading fields (P3, 2026-07-23, feedback id 86):** "LIM"
> (limitation — the reading could not be obtained) is an accepted value on the
> numeric READING fields — the six ranged fields (`measured_zs_ohm`,
> `rcd_time_ms`, `rcd_operating_current_ma`, `ocpd_rating_a`,
> `ocpd_breaking_capacity_ka`, `ir_test_voltage_v`) and the ungated numerics
> (`r1_r2_ohm`, `r2_ohm`, the ring legs, `ocpd_max_zs_ohm`, the two IR mohm
> fields). Only the four spoken forms `LIM`/`limb`/`limp`/`limitation` are
> accepted (near-matches like `limit`/`limited` are rejected). It reads back as
> "…recorded as LIM — limitation". Closed-enum classification fields
> (`ocpd_bs_en`/`ocpd_type`/`rcd_*`/`wiring_type`/`ref_method`/polarity/button
> results) do **not** accept LIM — a limitation is a missing *reading*, not a
> classification. Voice acceptance of LIM on the ranged fields is gated behind
> the `lim_ranged_write_v1` client capability (sentinel-safe derivation guards).

> **The discontinuity sentinel `∞` on continuity fields (PLAN-A2, 2026-09-23,
> feedback ids 141 and 142):** an open conductor is stored as the literal
> character `∞` (U+221E) on the five continuity fields — `r1_r2_ohm`, `r2_ohm`,
> `ring_r1_ohm`, `ring_rn_ohm`, and `ring_r2_ohm`. Six spoken forms map to it:
> `infinite`, `infinity`, `open`, `open circuit`, `open ring`, and
> `discontinuous`.
>
> **Which phrasings actually write, and which don't.** The ring slot parser
> accepts a sentinel only as a bare or near-bare reply — "open circuit",
> "it's open circuit", "an open ring" — or as the value captured next to a field
> word, as in "the CPC is open circuit". That anchoring is deliberate: the
> engine parses the whole utterance when no field word matched, so a looser
> match would let "I'll open the board", said mid-walk-through, certify a
> conductor as broken. Three gaps follow from it and are not yet closed:
>
> - A reply that names no field and isn't near-bare — "the circuit is open" —
>   re-asks instead of writing.
> - After you pick a leg to correct ("R2" → "What should R2 be?"), the answer
>   "open circuit" is rejected. That slot accepts numbers only.
> - The value-first form "open circuit on the lives" doesn't match, because the
>   grammar captures only the head word "open".
>
> A bare LIM reply still wins over all six sentinels: a limitation means the
> test wasn't performed, while `∞` means it was performed and the conductor is
> open. A reply carrying both — "limitation, the circuit is open" — matches
> neither and re-asks, because those are contradictory claims. Note that the
> model answer path (`stage6-answer-resolver.js`) still resolves the same words
> to `LIM`; the two paths disagree, and that's recorded as a follow-up. A
> sentinel mixed with a digit ("open circuit on the 2.5") still yields `2.5`.
>
> **Stored as the character, spoken as the word "infinity".** Every TTS voice
> reads a bare `∞` as silence, so `speakSentinelValue` in
> `src/extraction/confirmation-text.js` renders it for every spoken producer:
> the dispatcher read-backs through `buildValueSpokenTail`, the ring triple
> ("R1 0.43, Rn 0.43, R2 infinity. All correct?"), the terminal read-back when a
> walk-through is cancelled or deferred before its triple is confirmed ("Also
> got lives infinity."), and the amendment breadcrumb. Storage, the UI, and the
> PDF keep the character.
>
> Which field a result lands on depends on the circuit, not on the words alone.
> On a ring final circuit — the designation contains "ring", the circuit already
> holds a ring leg value, or the utterance names the ring — a CPC result writes
> `ring_r2_ohm`, and a live or neutral leg writes `ring_r1_ohm` or
> `ring_rn_ohm`. On a radial circuit, "CPC" or "R2" alone writes `r2_ohm`, and
> "R1 plus R2" writes `r1_r2_ohm`. If the utterance names no leg, the model asks
> once and defers the observation until the answer arrives. This is a prompt
> rule, so the model follows it imperfectly; the structural tests pin the rule's
> wording, not the model's compliance.
>
> Insulation resistance is deliberately different. "Infinite" on an IR reading
> means the meter saturated, a good result recorded as `>999`; `open circuit`
> isn't an IR sentinel at all. For more information, see the parity tests in
> `src/__tests__/dialogue-ohms-discontinuity.test.js`.

## Observations Tab (`/job/[id]/observations`)

| Field | Type | Options | AI Extraction Guidance |
|-------|------|---------|----------------------|
| `code` | select | C1, C2, C3, FI | C1=Danger, C2=Potentially dangerous, C3=Improvement, FI=Investigate |
| `item_location` | text | - | Where found: "Kitchen socket", "Consumer unit" |
| `observation_text` | text | - | Clear defect description |
| `schedule_item` | text | - | BS7671 reference: "3.6", "4.4", "5.12.1" |
| `schedule_description` | text | - | Full description from schedule (auto-filled when linked) |
| `photos` | array | - | Array of photo filenames attached to this observation |

**Linked Observations (Phase 7F):**
- Observations can be created directly from the Inspection Schedule tab
- Clicking C1/C2/C3 on a schedule item auto-creates a linked observation
- The `schedule_item` and `schedule_description` are pre-filled
- Changing to tick/N/A deletes the linked observation
- Deleting an observation sets its schedule item back to tick
- Photos can be selected from job photos or uploaded directly

## Inspection Schedule Tab (`/job/[id]/inspection`) - EICR Only

Each schedule item (1.1, 1.2, 3.1, 3.6, 4.4, etc.) gets an outcome:
- **tick** = Inspected and satisfactory
- **N/A** = Not applicable
- **C1** = Danger present
- **C2** = Potentially dangerous
- **C3** = Improvement recommended
- **LIM** = Limitation - unable to inspect

Common items to flag:
- **3.6** - Main bonding conductor sizes (undersized bonding = C2)
- **4.4** - Fire rating of enclosure (non-combustible CU required)
- **4.9** - Circuit identification/labelling
- **5.12.1** - RCD protection for socket outlets 32A or less

## EIC-Only Tabs

**Extent & Type (`/job/[id]/extent`):**

| Field | Type | Options |
|-------|------|---------|
| `extent` | text | What work was done |
| `installation_type` | select | new_installation, addition, alteration |
| `comments` | text | Additional notes |

**Design & Construction (`/job/[id]/design`):**

| Field | Type | Notes |
|-------|------|-------|
| `departures_from_bs7671` | text | Usually "None" |
| `departure_details` | text | Explanation if departures exist |

## Inspector Profile (Home Page Modal)

| Field | Type | Notes |
|-------|------|-------|
| `name` | text | Inspector's full name |
| `organisation` | text | Company name |
| `enrolment_number` | text | NICEIC/NAPIT registration |
| `position` | text | Job title |
| `signature_file` | file | Uploaded signature image |

---

## Circuit CSV Column Mapping

The extraction pipeline (`extract.js`) outputs CSV with these columns, which the editor maps to different names:

| CSV Column (extract.js) | Editor Column (eicr_editor.py) |
|-------------------------|-------------------------------|
| `circuit_ref` | `circuit_ref` (no change) |
| `description` | `circuit_designation` |
| `protective_device` | `ocpd_type` |
| `zs` | `measured_zs_ohm` |
| `ir_500v_mohm` | `ir_live_earth_mohm` |
| `rcd_rating_ma` | `rcd_operating_current_ma` |
| `rcd_trip_times_ms` | `rcd_time_ms` |

This mapping is handled by `map_circuit_columns()` in `eicr_editor.py`.

## Central Field Schema (config/field_schema.json)

The field schema is the single source of truth for all circuit schedule fields. It defines:
- Field names, labels, and types (text, select)
- Options for dropdown fields
- AI guidance for extraction
- Default values and circuit-specific defaults

**All 29 Circuit Schedule Columns (matching PDF output):**

| Group | Fields |
|-------|--------|
| Circuit Details | circuit_ref, circuit_designation, wiring_type, ref_method, number_of_points, live_csa_mm2, cpc_csa_mm2, max_disconnect_time_s |
| OCPD | ocpd_bs_en, ocpd_type, ocpd_rating_a, ocpd_breaking_capacity_ka, ocpd_max_zs_ohm |
| RCD | rcd_bs_en, rcd_type, rcd_operating_current_ma |
| Ring Final | ring_r1_ohm, ring_rn_ohm, ring_r2_ohm |
| Continuity | r1_r2_ohm, r2_ohm |
| Insulation Resistance | ir_test_voltage_v, ir_live_live_mohm, ir_live_earth_mohm |
| Test Results | polarity_confirmed, measured_zs_ohm, rcd_time_ms, rcd_button_confirmed, afdd_button_confirmed |

The schema is loaded by:
- `extract.js` - Builds AI extraction prompts dynamically
- `eicr_editor.py` - Uses `CIRCUIT_TEMPLATE_FIELDS` for UI column configs and defaults

### Circuit Defaults

All 29 circuit fields can have default values set in the Defaults tab. These are saved to `config/user_defaults_{user}.json` and applied when loading new jobs.

---

## Keeping This Documentation in Sync

When you modify the iOS app or backend:

1. **Add a new field to a form?**
   - Add it to `config/field_schema.json` with `ai_guidance`
   - Add it to the relevant table in this document
   - The AI extraction will automatically pick it up

2. **Change dropdown options?**
   - Update the `options` array in field_schema.json
   - Update the iOS app constants/model files
   - Update the table in this document

3. **Remove a field?**
   - Remove from field_schema.json
   - Remove from this document
   - The AI will stop extracting it

4. **Change field name?**
   - Update everywhere: schema, iOS model files, backend API
   - Update the tables in this document

---

## Bulk write tools

### `set_field_for_all_circuits` (Stage 6)

Apply ONE `(field, value)` pair to every active circuit in the schedule. Inspector triggers: "all circuits are 0.32", "every circuit", "RCD time 25 ms for all".

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `field` | string | yes | Any `circuit_fields` key from `config/field_schema.json`. |
| `value` | string | yes | Post-normalisation value; same coercion contract as `record_reading`. |
| `confidence` | number | yes | 0.0–1.0; dispatcher rejects out-of-range. |
| `source_turn_id` | string | yes | Dedup + correlation. |
| `scope` | enum | no | `non_spare` (default), `all`, `rcd_protected_only`. |
| `board_id` | string | no | Defaults to `currentBoardId`. Pass `"*"` to apply across every board on the job. |
| `exclude_circuits` | integer[] | no | **PLAN-backend-final §8.1.** Subtractive selector for "apart from / except / excluding / all but circuit N". Integers only (Stage 6 uses numeric refs throughout). Honored regardless of `scope`. The dispatcher's response carries `excluded_count` = inspector intent count (deduped validated input), independent of scope; `applied_count` is the post-exclude post-scope total; `skipped_count` continues to count scope-rule drops only. Example: `set_field_for_all_circuits({field:"rcd_time_ms", value:"25", scope:"non_spare", exclude_circuits:[1], ...})` for "RCD time is 25 milliseconds for all circuits apart from circuit 1." |

### `clear_field_for_all_circuits` (Stage 6, PLAN-C3 2026-09-17)

Clear ONE field on every circuit in scope. Inspector triggers: "clear the reference method for all circuits", "wipe the R1+R2 on every circuit".

This is the only supported way to empty a field in bulk. `set_field_for_all_circuits` with an empty `value` used to do the job and is now rejected — see [No silent clear](#no-silent-clear-blank-writes-plan-c3-2026-09-17).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `field` | string | yes | Any key in `CLEAR_READING_FIELD_ENUM` — the same enum `clear_reading` uses, so `circuit_ref`, `is_distribution_circuit`, and `feeds_board_id` are excluded. An excluded key returns `field_not_clearable`. |
| `source_turn_id` | string | yes | Dedup and correlation. |
| `scope` | enum | no | `non_spare`, `all`, `rcd_protected_only`. Same grammar as `set_field_for_all_circuits`. Prefer omitting it. |
| `spare_policy` | enum | no | `automatic`, `include`, `exclude`. Same grammar as `set_field_for_all_circuits`. |
| `board_id` | string | no | Defaults to `currentBoardId`. Pass `"*"` to clear across every board on the job. |
| `exclude_circuits` | integer[] | no | Subtractive selector, honored regardless of `scope`. |

The response is `{ok: true, cleared: [], already_empty: [], failed: []}`.

- `cleared` lists the circuits whose value was removed.
- `already_empty` lists circuits that held no value. They count as cleared, not as failures: the inspector asked for the field to be empty across the scope, and it is. These produce no `field_corrected` event and no spoken member.
- `failed` lists circuits the sweep could not reach, each with a reason. Every entry also stages a partial-failure notice, so a miss inside a scope the inspector asked for is always audible.

On the wire the tool emits one `field_corrected` per cleared circuit, exactly as `clear_reading` does. The grouping is a speech decision: the bundler collapses same-call clears into one line, such as "Circuits 1 to 14, reference method cleared". Two bulk clears in one turn stay two lines, because they are two statements about two scopes.

## No silent clear: blank writes (PLAN-C3, 2026-09-17)

On September 17 the model was twice rejected on `BS 3871` for `ocpd_bs_en`, wrote `""`, and the dispatcher accepted it. Nothing was read back worth hearing, so a certificate value emptied while the inspector, working hands-free, heard nothing. Decision 5: a blank field stays blank, audibly.

### The predicate

`isBlankWrite(value)` in `src/extraction/blank-write-policy.js` is true when `value` is a string that trims to nothing. It lives in a module with no imports so the dialogue engine and the dispatchers share one definition.

An explicit blank is rejected with `empty_write_not_allowed` at every model-controlled mutation boundary:

| Boundary | Behavior |
|---|---|
| `record_reading` | Rejected. The tool result names `clear_reading`. |
| `record_board_reading` | Rejected. The tool result names `clear_board_reading`. |
| `set_field_for_all_circuits` | Rejected. The tool result names `clear_field_for_all_circuits`. |
| `create_circuit` / `rename_circuit`, on `designation` and `phase` | An explicit blank is rejected. An omitted or `null` argument keeps today's leave-unchanged or default behavior. |
| `start_dialogue_script.pending_writes` | The seed is dropped with reason `seed_blank`. The script still enters, so the slot is asked. |
| `mark_distribution_circuit.feeds_board_id` | Out of scope by construction: the shipped `invalid_feeds_board_id` shape gate rejects a blank before board resolution. |

### Exemptions

The blank predicate does not fire on `STRUCTURAL_READING_FIELDS` or the `clear_reading` exclusions (`circuit_ref`, `is_distribution_circuit`, `feeds_board_id`). Those fields already have a truthful refusal naming `mark_distribution_circuit`, and `clear_reading` cannot clear them, so a "say clear" hint would name a tool that refuses them. The exemption set is the imported union of both manifests, never a retyped copy.

`BLANK_WRITE_ALLOWED_FIELDS` is a separate escape for a field whose blank is a legitimate written value that no clear tool can reach. Rejecting a blank there would make the field permanently unclearable by voice. The set is committed empty and derived by `src/__tests__/stage6-blank-write-allowlist.test.js` from the live schema on every run; a mismatch fails the suite.

### Audibility

Every rejection stages one notice on the existing `stageMandatoryNotice` channel, drained at net 0. Six families cover the boundaries: `empty_write_blocked`, `empty_bulk_write_blocked`, `create_blocked`, `rename_blocked`, `enum_rejected`, and `enum_rejected_after_ask`.

Each line names what the certificate still holds, read from the snapshot after the rejection: "OCPD BS/EN on circuit 1, still BS EN 60898", or "still blank". The model's rejected string is never spoken and never logged. These families are value-bearing, so the drain's `stage6.mandatory_notice_emitted` row omits its text preview for them.

A notice is retired when a same-slot write or clear survives the turn, when a same-`(op, key_ref, board)` create or rename succeeds, or when a covering `ask_user` is registered. A bulk notice is per call and only a covering ask retires it: a later per-circuit write does not make a statement about a scope true.

These six families also survive a cancelled generation, which every other family on the channel does not. A cancellation must not make a silent clear silent again.

### `rejection_ref`

Every rejecting dispatcher returns `rejection_ref: "<turnId>:<toolCallId>"` and journals the rejection. `ask_user` and `answer_user` each take an optional model-facing `rejection_ref` input. There is no wire change; neither field reaches a client frame.

A staged notice is authoritative. An `answer_user` carrying the matching ref is dropped and the notice speaks, because a ref proves association with a rejection and never the truth of the answer's words. An answer with no ref, or an unresolvable one, is dropped the same way. Only `rejection_ref: "unrelated"` lets a model line speak beside a refusal.
