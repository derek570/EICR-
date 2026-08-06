# PLAN — EIC field-test fixes (2026-06-17)

Two distinct field-test feedback markers from **today's EIC voice session** `ADC93801-290C-479D-A284-923902C90D9C` (job `job_1775132057313`, user `82b54893…`). Both were captured live via the in-app "feedback" command and indexed in `voice_feedback` (ids **28** and **29**).

> Scope note: the 5 markers from 2026-06-16 session `F1AC26FB` (ids 23–27) are already handled — 4 via the executed `ir-loop-lim-fix-2026-06-16` wave, and the "main fuse → SPD label" one via the separate `surge-protection-box-2026-06-17` plan. This plan covers ONLY the two NEW markers (28, 29).

---

## §0 — Evidence (CloudWatch + S3, pulled 2026-06-17)

### Issue A — feedback id 28 (09:58:24Z): blocking ask for installation address ignored an equality statement

Reconstructed turn timeline (log group `/ecs/eicr/eicr-backend`):

| Time (UTC) | Event |
|---|---|
| 09:57:37 | `Extracting from transcript` — textPreview **"Customer is Graham Richardson."** |
| 09:57:41 | `record_board_reading` → `field=client_name`, conf 0.95 → TTS confirm "customer name Graham Richardson" |
| 09:57:48 | `Extracting from transcript` — textPreview **"The client address is the same as the installation address."** |
| 09:57:53 | TTS `confirmation` — **"What is the installation address?"** |
| 09:57:59 | `stage6.ask_user` — question="What is the installation address?", **reason=`missing_value`**, context_field=`address`, answer_outcome=answered, **user_text="Stop."** |
| 09:58:24 | Feedback id 28 logged: *". Ask for the installation address after it had populated the client. Address."* |

No `address` / `client_address` field was ever written in the session — only `client_name`. The inspector's spoken equality statement was treated as a truncated address value, not as a coreference instruction.

**Spoken feedback (verbatim, S3 `debug_report.json`):** ". Ask for the installation address after it had populated the client. Address." (Deepgram split; intent = *"it asked for the installation address even after I'd told it the client address is the same as the installation address"*).

### Issue B — feedback id 29 (10:02:31Z): no way to comment on the existing installation in the EIC form

**Spoken feedback (verbatim):** ". There is no way to put comments on current installation. in the EIC form."

BS 7671 model EIC carries a **"Comments on existing installation"** box (used when the EIC covers an addition/alteration to an existing installation — Reg 633). The app has a generic EIC "Comments" field in the UI/PDF, but it is **unreachable by voice**, and a field inspector works hands-free.

---

## §1 — Root cause (grounded in code)

### Issue A root cause
`config/prompts/sonnet_agentic_system.md`:
- **Line 79:** "Every spoken value must produce a write, `ask_user`, or `record_observation`."
- **Line 81:** "Bare field, no value, OR **topic-without-value** for non-ring tests → `ask_user reason="missing_value"` with `context_field`… empty trailing values mean Deepgram missed something; **ask, don't wait**."
- **Lines 153–177 ("CLIENT BILLING ADDRESS — SITE COPY RULE"):** the ONLY address-mirroring logic. It fires a one-shot `ask_user` *after the first address-family value lands* ("Should I use this same address for the [customer|site]?"). It assumes the inspector answers Y/N to that ask.

There is **no rule** for the inspector **volunteering an equality statement** ("the client address is the same as the installation address"), and especially not **before any address value exists**. So the engine fell through to the line-81 default: address topic named, no value → `ask_user reason=missing_value` → "What is the installation address?". The mirror rule (153–177) never engaged because no address-family value had landed to trigger it.

Supporting facts:
- `config/field_schema.json:405–459` — site slots `address/postcode/town/county`; billing slots `client_address/client_postcode/client_town/client_county` (distinct families).
- `src/extraction/eicr-extraction-session.js:1030–1042` — **EIC and EICR share the same agentic prompt** (`EICR_AGENTIC_SYSTEM_PROMPT`); cert type only switches the *legacy* (`toolCallsMode==='off'`) prompt, which is NOT the live path.
- iOS already detects "same address" phrasing locally: `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift:1117–1119` (regex) → sets `clientAddressSameAsInstallation` (`:2146–2149`); applied in `DeepgramRecordingViewModel.swift:5444–5458` only when `clientAddressMirrorEnabled` is already true. **This iOS-local intent is never forwarded to Sonnet**, so the agentic engine asks anyway.

### Issue B root cause
- Voice-reachable field enum `BOARD_FIELD_ENUM` (`src/extraction/stage6-tool-schemas.js:130`) = keys of `supply_characteristics_fields` + `board_fields` + `installation_details_fields` (with `_ui_*` filtered). **`eic_extent_and_type_fields` and `eic_design_construction_fields` are NOT included** → `record_board_reading` cannot target `extent` / `installation_type` / `comments`. (Anthropic strict-mode rejects off-enum field names before they reach our dispatcher — `stage6-tool-schemas.js:14-19`.)
- The EIC "Comments" field exists everywhere EXCEPT voice:
  - schema `config/field_schema.json:895–900` (`eic_extent_and_type_fields.comments`, label "Comments")
  - iOS model `CertMateUnified/Sources/Models/ExtentAndType.swift:6` (`comments`)
  - iOS UI `CertMateUnified/Sources/Views/JobDetail/ExtentTab.swift:46–61` (multiline, EIC-only tab, registered `JobDetailView.swift:494` tag 6)
  - iOS PDF `CertMateUnified/Sources/PDF/EICRHTMLTemplate.swift:562` (rendered inside **"DESIGN AND CONSTRUCTION"**, not "Description & Extent")
  - web `web/src/app/job/[id]/extent/page.tsx:87–93`
  - persistence: flexible JSONB `extent_and_type` blob (`src/routes/jobs.js:592,665,779`) — no migration needed.
- The legacy off-mode EIC prompt mentions `extent_of_installation` / `design_comments` (`config/prompts/sonnet_extraction_eic_system.md:101–107`) but that path is **dead** for live voice. The live agentic prompt has **zero** EIC-extent guidance.

Net: the field is real and persists; it is simply **orphaned from the live voice contract**.

---

## §2 — Fix for Issue A (stop the spurious "what is the address?" ask on an equality statement)

> **Scope locked with user (2026-06-17).** The existing flow is CORRECT and stays unchanged: dictate an address → AMBIGUOUS-SLOT DEFAULT routes it to the SITE/installation family → the one-shot mirror ask "Should I use this same address for the customer?" fires (prompt `:153–177`). The user confirmed this is the intended behaviour and "should already be in code".
>
> **The bug is narrow:** when the inspector *explicitly stated the equality* — "the client address is the same as the installation address" — with **no address value in the utterance**, the engine misread it as a truncated address (line-81 "topic-without-value → ask, don't wait") and fired a **blocking `ask_user reason=missing_value` "What is the installation address?"**. The single fix is to stop that spurious ask. **Backend-prompt-only; no iOS change** (decision A2 below).

### A1 — Rewrite the address section of the agentic prompt (backend, shared)
File: `config/prompts/sonnet_agentic_system.md` — the "CLIENT BILLING ADDRESS — SITE COPY RULE" block (`:153–177`) plus a targeted carve-out on the line-81 default. The user asked to **"add rewriting the prompt into this plan"**, so this is an explicit, careful rewrite of the address-handling rules (not a one-line bolt-on). The rewrite must:

1. **Recognise an address EQUALITY / COREFERENCE statement** — an utterance that *asserts the two address families are identical* rather than *dictating an address value*. Field-observed and adjacent phrasings:
   - "the client address is the same as the installation address" (the exact field case)
   - "client and site address are the same" / "same address for both" / "they're the same address"
   - "the client is at the same address" / "billing address is the same as the site"
2. **Carve equality statements OUT of the line-81 `missing_value` default.** Add explicit text: *"An utterance that asserts two address families are the SAME is NOT a topic-without-value. Do NOT emit `ask_user reason=missing_value` (or any 'what is the address?' question) in response to it. The inspector has given you a relationship, not a truncated value."*
3. **Behaviour after an equality statement (no value present):** do nothing that blocks. Simply note the two families are linked and **wait for the inspector to dictate the address** — at which point the EXISTING site-default + mirror-ask flow handles it. The engine must NOT treat the absent value as a Deepgram truncation here.
4. **Optional minor enhancement (keep only if it stays prompt-only and low-risk):** once equality is stated, when the address value later lands on the site family, auto-copy to the client family WITHOUT re-firing the mirror ask (since the inspector already stated they're the same). If this needs server state it is **out of scope** — the user is content with the existing mirror ask firing, so default to leaving the mirror ask in place and only suppressing the bad `missing_value` ask.
5. **Do NOT change** the AMBIGUOUS-SLOT DEFAULT (site-first), the one-shot mirror ask, or the four-write copy pattern. Those are field-validated and the user explicitly wants them retained.

> Keep the rewrite surgical and self-consistent with the surrounding rules (`:140–177`). Preserve the trust-boundary / no-prompt-leak constraints (`:12–15`).

### A2 — iOS forwarding: DEFERRED (decision, 2026-06-17)
iOS already detects the phrase locally (`TranscriptFieldMatcher.swift:1117–1119` → `clientAddressSameAsInstallation` `:2146–2149`) but does not forward it to Sonnet. The user chose **prompt-only**; iOS forwarding is **not in this plan**. Logged as a possible later robustness add (forward an explicit `address_equality` hint so Sonnet need not re-derive from raw transcript). No TestFlight build is required for Issue A.

### A3 — Worked example in the prompt
Add ONE worked example in the style of `:169–176`:
- *"The client address is the same as the installation address."* spoken with no address value → **no ask of any kind**; the engine waits. Inspector then says *"71 Hexham Road, Reading, RG30 6PT, Berkshire"* → site writes land → existing mirror ask "use the same for the customer?" fires → "yes" → four-write copy. (Demonstrates the equality statement is inert/safe, and the normal flow still works.)

### A4 — Tests (backend)
- New prompt-contract / dispatcher test (pattern: `src/__tests__/stage6-agentic-prompt.test.js` + the address-mirror tests): an equality statement with no address value must **NOT** yield `ask_user reason=missing_value` with `context_field=address` (this is the exact regression from session ADC93801).
- Regression: a normal address dictation (no equality stated) still routes to the SITE family and still fires the one-shot mirror ask (`:153–177`) — unchanged.
- Regression: equality statement followed by an address dictation reaches the same end-state (both families populated) as the plain "dictate + say yes to mirror" path.

---

## §3 — Fix for Issue B (EIC "Comments on existing installation" reachable by voice)

**Recommended approach: REUSE + RELABEL the existing `eic_extent_and_type_fields.comments` field and wire it into the live voice path.** (Rejected alternative: add a brand-new `comments_on_existing_installation` field — duplicates an already end-to-end field for no benefit and risks a second orphan.)

### B1 — Schema relabel (backend, shared)
File: `config/field_schema.json:895–900`.
- Relabel `eic_extent_and_type_fields.comments` → label **"Comments on existing installation"**; update `description`/`ai_guidance` to reference Reg 633 ("comments/observations on the existing installation when this EIC covers an addition or alteration"). Keep the **key `comments`** (no rename → no data/contract migration; iOS `ExtentAndType.comments` and web both already bind to it).

### B2 — Make EIC extent fields voice-reachable (backend, shared) — the core fix
File: `src/extraction/stage6-tool-schemas.js:130` (`BOARD_FIELD_ENUM`).
- Add the `eic_extent_and_type_fields` keys (`extent`, `installation_type`, `comments`) to the enum union (filtering `_ui_*`). **`eic_design_construction_fields` is OUT of scope this pass (decision 5).**
- **CRITICAL persistence wiring (must verify, do not assume):** board readings are routed through `circuits[0]` / the state seed (`_seedStateFromJobState`, `eicr-extraction-session.js`; legacy `KNOWN_FIELDS` in `sonnet-stream.js:~538`). The EIC extent fields are NOT currently seeded there, so merely widening the enum will let Sonnet *emit* the write but it may not *persist* into the `extent_and_type` blob the UI/PDF read. At execution time:
  1. Trace where `record_board_reading` values are committed to the job (`validateRecordBoardReading` / dispatcher → job patch).
  2. Ensure `extent` / `installation_type` / `comments` land in `extent_and_type.{extent,installation_type,comments}` (not `circuits[0]`).
  3. Add seed entries so the cached prefix reflects existing `extent_and_type` values (so the engine doesn't re-ask / overwrite).
- Add an `installation_type` value-coercion check (enum `new_installation|addition|alteration`) consistent with `config/stage6-enumerations.json` patterns, since spoken forms ("addition", "an alteration") must map to the select options.

### B3 — Prompt guidance for EIC comments (backend, shared)
File: `config/prompts/sonnet_agentic_system.md`.
- Add an **"EIC EXTENT & COMMENTS"** section: explicit triggers route free-text to `record_board_reading({field:"comments", …})`:
  - "comment on the existing installation", "make a comment", "note that…", "add a comment", "comment for the certificate".
  - "extent of the work is…", "this is an addition / alteration / new installation" → `extent` / `installation_type`.
- Disambiguate from EICR observations: on EIC there are no C1/C2/C3/FI observations; a "comment" is free text to the EIC `comments` field, NOT `record_observation`. (iOS already empties observations for EIC — `Job.swift:56–63`.) Gate this guidance so it does not change EICR behaviour (the engine knows cert type via the state snapshot; if it doesn't, see B6).

### B4 — iOS apply + PDF placement (iOS)
Files: `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` (`applySonnetReadings`), `Sources/Models/ExtentAndType.swift` (exists), `Sources/PDF/EICRHTMLTemplate.swift:562`.
- Add `applySonnetReadings` cases mapping incoming `extent` / `installation_type` / `comments` board readings into `job.extentAndType?.…` (verify none exist today; the address/circuit cases are at `:5444+`). Respect 3-tier priority (pre-existing/manual wins).
- **PDF placement (decision 4 = MOVE):** relocate the `comments` render from "DESIGN AND CONSTRUCTION" (`:562`) to a clearly-labelled **"Comments on existing installation"** row under the EIC "DESCRIPTION AND EXTENT OF THE INSTALLATION" section (`:520–545`). Single row, no duplicate — remove the old render site.
- Relabel the on-screen field: `ExtentTab.swift:46–61` "Comments" → "Comments on existing installation". **Always shown on EIC** (decision 6 — no `installation_type` gating).

### B5 — Web parity (web/, PWA-only surface)
File: `web/src/app/job/[id]/extent/page.tsx:87–93` — relabel the Comments section to "Comments on existing installation"; no contract change (key stays `comments`).

### B6 — Cert-type visibility to the engine (verify)
If B3's EIC-only guidance needs the engine to KNOW it's an EIC session: confirm the cached state snapshot exposes cert type to the agentic prompt. `eicr-extraction-session.js:1030–1042` shows cert type is known server-side but only switches the legacy prompt. If the live prompt can't see cert type, add it to the snapshot/system block so EIC-comments guidance activates only on EIC. (Likely already present via job state — verify, don't assume.)

### B7 — Tests
- Backend: enum membership test (extent/installation_type/comments present in `BOARD_FIELD_ENUM`); dispatcher persistence test (a `comments` board reading lands in `extent_and_type.comments`); `installation_type` coercion test; prompt-contract test (EIC comment trigger → `record_board_reading field=comments`, NOT `record_observation`).
- iOS: `applySonnetReadings` round-trip test for the three extent fields (pattern: existing alias/applier tests); PDF snapshot includes the relabelled section.
- Web: extent page renders the relabelled field.

---

## §4 — Sequencing & deploy (mandatory order)

Both fixes change the **shared backend voice contract** (`config/prompts/*`, `src/extraction/*`, `config/field_schema.json`). This is the user's explicit cross-platform mandate (field-reported voice bugs).

1. **Backend first.** Land §2 (A1/A2/A4) + §3 (B1/B2/B3/B7-backend) on `main` → CI → `gh run watch <id> --exit-status` → confirm ECS rollout COMPLETED.
2. **iOS after backend is live.** Land §2 A3 (optional) + §3 B4 + B7-iOS. Build/test with `-derivedDataPath /tmp/certmate-dd`; run `xcodegen generate` if files added. **TestFlight is currently HELD** per memory until the stale-test PRs are resolved — coordinate so new tests don't collide; do not ship iOS red.
3. **Web** (§3 B5) can ship independently (PWA-only, no contract change).

Never local `./deploy.sh` / Docker — CI only (`EICR_App/CLAUDE.md`). Backend drift guard: any task-def/env change must be source-committed.

---

## §5 — Decisions (RESOLVED with user 2026-06-17)

1. **Issue A behaviour:** Keep the existing site-default + one-shot mirror-ask flow unchanged. The fix is ONLY to stop the spurious `missing_value` "what is the installation address?" ask that fires on an explicit equality statement. **Backend-prompt rewrite of the address section.** ✅
2. **Issue A — iOS equality-forwarding:** **Deferred.** Prompt-only fix; no iOS/TestFlight work for Issue A. ✅
3. **Issue B — reuse vs new field:** **Reuse + relabel** the existing `eic_extent_and_type_fields.comments` (no migration; key stays `comments`). ✅
4. **Issue B — PDF placement:** **Move** the comments row from "Design and Construction" to under "Description and Extent of the Installation" (single source of truth, BS 7671-faithful). ✅
5. **Issue B — voice scope:** **Extent & Type group only** (`extent`, `installation_type`, `comments`). `eic_design_construction_fields` deferred. ✅
6. **Issue B — field visibility:** **Always available on EIC**, regardless of `installation_type`. No conditional UI/voice gating. ✅

---

## §6 — Verification (post-deploy)

- Re-run an EIC voice session: (A) say client name, then "the client address is the same as the installation address" → assert NO "What is the installation address?" block-ask; dictate one address → both families populate. (B) say "comment on the existing installation: …" → assert text lands in the EIC Comments field and renders on the PDF under the correct section.
- CloudWatch: confirm no `ask_user reason=missing_value context_field=address` fires on an equality utterance; confirm a `record_board_reading field=comments` round-trips.

## §7 — Files touched (index)

**Backend (shared):** `config/prompts/sonnet_agentic_system.md` (A1/A3 address rewrite + B3 EIC-comments guidance), `config/field_schema.json:895` (B1 relabel), `src/extraction/stage6-tool-schemas.js:130` (B2 enum), `src/extraction/eicr-extraction-session.js` (seed/persist, B2/B6), dispatcher/validation (`stage6-dispatch-validation.js`, B2), `src/__tests__/*` (A4/B7).
**iOS (Issue B only — Issue A is prompt-only):** `DeepgramRecordingViewModel.swift` (B4 `applySonnetReadings` extent-field cases), `Sources/Views/JobDetail/ExtentTab.swift` (B4 relabel), `Sources/PDF/EICRHTMLTemplate.swift:562→520-545` (B4 move), `Sources/Models/ExtentAndType.swift` (verify CodingKeys), iOS tests.
**Web:** `web/src/app/job/[id]/extent/page.tsx:87` (B5 relabel).
