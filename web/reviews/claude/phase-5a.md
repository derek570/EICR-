# Phase 5a — CCU photo capture + GPT Vision merge (commit `35b5310`)

Rigorous code review. File:line references are against the working tree of the
commit under review.

---

## 1. Summary

Phase 5a ports the iOS `FuseboardAnalysisApplier.hardwareUpdate` flow to the
web rebuild. A new hidden `<input type="file" capture="environment">` on the
Circuits tab feeds `api.analyzeCCU(photo)` (multipart POST to
`/api/analyze-ccu`), whose response is folded onto the active `JobDetail`
through `applyCcuAnalysisToJob`. The merge helper writes board identity,
main‑switch fields, SPD device and supply fields, and the per-device circuits
array, while preserving manually-typed values (via `hasValue`) and never
dropping a circuit that carries existing test readings. Unresolved
RCD-protected circuits surface as dismissible "what is the RCD type for
circuit X?" chips next to an error banner and a spinner on the CCU rail
button.

Overall quality is high and parity with iOS is well-reasoned. Primary gaps:
(a) the merge runs against a stale-closure `job`, (b) `ccu_analysis` is
overwritten on the patch every time (no deep merge / no partial response
tolerance), (c) upload-size / content-type guard-rails are absent client-side,
(d) there is no automated test coverage of the merge, and (e) the Circuits tab
is purely in-memory — Phase 4 persistence is not yet wired so a CCU merge is
lost on reload. Details below.

---

## 2. Alignment with Phase 5a brief

| Checklist item from the commit body | Status |
|---|---|
| Port iOS `hardwareUpdate` (preserve readings, overwrite hardware) | Done — `apply-ccu-analysis.ts:247-288` mirrors iOS lines 128-168 |
| Data-loss guard for circuits with readings that analyser omits | Done — `apply-ccu-analysis.ts:237-242` |
| `hasValue` re-use for 3-tier priority guard | Done — import at `apply-ccu-analysis.ts:30`, used throughout |
| `board.spd_*` vs `supply.spd_*` split | Done — `buildBoardPatch` vs `buildSupplyPatch` |
| Auto-generate missing-RCD questions | Done — `apply-ccu-analysis.ts:328-336` |
| `capture="environment"` picker | Done — `circuits/page.tsx:275` |
| Loading / error / question-chip surface | Done — `circuits/page.tsx:297-346` |
| CLAUDE.md changelog row | Done |
| Backend endpoint unchanged | Confirmed — `src/routes/extraction.js:679` |

Unclaimed but reasonable gaps (documented in the commit): Levenshtein
designation matcher; persistence/save round-trip; retry without re-upload.

---

## 3. Correctness

### P0 — must fix before shipping

**P0-1. Stale-closure `job` during concurrent typing** — `circuits/page.tsx:141-145`
The handler awaits the network POST (typically 2-6s for GPT Vision) then calls
`applyCcuAnalysisToJob(job, analysis, …)` using the `job` captured at render
time. If the inspector types into any tab during the await, that keystroke
bumps state → a new render → the CCU handler is still sitting on the old
closure. On resolution the helper diffs against the pre-keystroke `job` and
`updateJob(patch)` shallow-merges the stale sections (installation, supply,
board, circuits, ccu_analysis) back onto state. **Any typing done during the
2-6s wait is silently clobbered.** The whole point of `hasValue` guarding
individual fields is defeated by shallow-overwriting whole section objects
(`patch.board = { … }`, `patch.circuits = [ … ]`) built from the stale
snapshot.

Fix: read latest `job` inside the handler (a ref, or use the functional form of
an updater). `updateJob` currently exposes only `(patch) => setJob(prev => ({
...prev, ...patch }))`; the merge needs `prev`, so either (a) expose a
functional `updateJob((prev) => partial)` variant, or (b) store a `jobRef` and
read from it at merge time.

**P0-2. `patch.ccu_analysis = analysis` stomps prior analyses**
`apply-ccu-analysis.ts:359`. This is a total replacement — re-shooting a
different board on a multi-board install overwrites the first board's stored
CCU output. Either key by `boardId` (`patch.ccu_analysis = { ...existing,
[boardId]: analysis }`) or at minimum merge.

### P1 — should fix in this phase

**P1-1. `spd_status` always written when `spd_present` is a boolean, regardless of existing**
`apply-ccu-analysis.ts:143-149`. Unlike every other field, these lines assign
directly (`next.spd_status = 'Fitted' / 'Not Fitted'`, `next.spd_type =
'N/A'`) without a `hasValue` guard. If an inspector has manually set
`spd_status: 'Not Required'` or a custom value, the next CCU pass overrides
it. iOS parity is asserted in the comment but not verified — review the iOS
behaviour and either add the `hasValue(existing[key]) ? skip` guard or
document the deviation. Same concern for `next.spd_type = 'N/A'` on line 148.

**P1-2. Supply-patch dead write**
`apply-ccu-analysis.ts:181-186`. The `for` loop sets `next[key] = 'N/A'`
but the `apply` closure on lines 190-191 later calls `apply('spd_rated_current',
…)` / `apply('spd_type_supply', …)` — `apply` checks `hasValue(existing[key])`,
not `hasValue(next[key])`, so the N/A writes are never overshadowed, but the
pair `next` / `existing` divergence is confusing and brittle: if the analyser
returns both `spd_present:false` AND a non-null `spd_rated_current`, the N/A
loop runs first, then `apply('spd_rated_current', …)` checks
`hasValue(existing['spd_rated_current'])` (still empty) and overwrites the
just-written `'N/A'`. Intent unclear — the N/A sentinel is fragile when the
backend also sends a main-switch fallback.

**P1-3. Cross-board circuit leakage when `board_id == null`**
`apply-ccu-analysis.ts:207-212`. `boardCircuits` includes any row with
`board_id == null`, then replaces the board circuit list. That's correct on
first merge (orphan circuits get adopted). But on a second run against the
*same* selected board, rows in `otherBoardCircuits` are only those with a
non-null `board_id` that differs from the target. So any orphans on the job
persistently get re-adopted by whatever board happens to be running CCU. If
an inspector has two boards and happened to produce a null `board_id` row via
an earlier path, that row hops between boards every CCU run. Low-severity
because the wire-up for null `board_id` is ad-hoc, but the invariant isn't
enforced.

**P1-4. RCBO rows aren't synthesised in the `CircuitCard` type's RCD_TYPES chip set**
`circuits/page.tsx:57-62`. After a CCU merge, rows created via
`buildNewCircuit` for an RCBO with no resolvable type get `rcd_type: 'RCBO'`
(line 318 of merge helper) — but the `SelectChips` component for RCD type only
offers `['AC','A','B','F']`. The UI will render the chips without any active
selection, and the `'RCBO'` value becomes invisible to the inspector (they'd
have to clear and pick AC/A/B/F; selecting any overwrites 'RCBO'). Decide
whether 'RCBO' should be exposed as a chip option or whether the normaliser
on the merge side should never write the string.

**P1-5. Client has no upload-size guard**
`api-client.ts:161-168` + `circuits/page.tsx:130-171`. The backend rejects at
20MB (`CCU_MAX_UPLOAD_BYTES`, `src/routes/extraction.js:24`) with a 413. A
modern iPhone rear-camera JPEG can be 10-15MB; a HEIC converted via
Safari's picker can be larger still. No client-side size check → inspector
waits for a full slow-network upload only to see "Analysis failed (413)".
Add `if (file.size > 20*1024*1024)` short-circuit with a friendly message;
consider an in-browser canvas downscale for anything > 8MB before posting.

**P1-6. `ccuQuestions` is not cleared on subsequent CCU runs**
`circuits/page.tsx:158` sets `setCcuQuestions(questions)`. Previously-present
chips that the inspector never dismissed survive a second CCU upload only if
the new response re-emits them (it won't — different questions for different
circuits). Actually this line replaces the state wholesale, which is correct;
BUT if the second response has *zero* questions, the chips correctly clear —
this is a non-issue on re-read. Marking P1 because of a related gap:
`setCcuQuestions` is not cleared when `setSelectedBoardId` changes, so
questions from Board 1 stay visible after switching to Board 2.

### P2 — nice to have

**P2-1. `main_switch_position` is typed in `CCUAnalysis` but never consumed**
`types.ts:274`, absent from `buildBoardPatch`. Either wire it to a board
field or drop the type entry so the contract stays honest.

**P2-2. `confidence` / `gptVisionCost` not surfaced anywhere** (`types.ts:285-296`).
iOS uses these for an orange "low confidence" banner and for cost tracking.
Web just discards them. Consider a small "model reported X fields uncertain"
chip + a dev-mode cost log.

**P2-3. `analysed.label === 'null'` string check on two lines**
`apply-ccu-analysis.ts:258`, `:293`. The analyser sometimes returns the
literal string "null" (a prompt artefact). Both sites handle it but the
defence is repeated — extract to a helper so a future call site can't
regress.

**P2-4. `normaliseRcdType` silently drops 'A-S' / 'B-S' / 'B+'** not returned
by the analyser's enum (`types.ts:260` only lists `'AC' | 'A' | 'B' | 'F' |
'S'`). The `VALID_RCD_TYPES` set on `apply-ccu-analysis.ts:35` is wider than
the typed prompt contract. If prompt evolves to return 'A-S' literally, the
merge accepts it; if the prompt hand-codes "A S" (space), the normaliser's
regex doesn't cover the hyphen → 'AS' → rejected. Minor; align the regex and
enum.

**P2-5. `buildCircuitsPatch` return value**
`apply-ccu-analysis.ts:203-204` returns `null` when `incoming.length === 0`,
which the caller (`applyCcuAnalysisToJob:354-355`) turns into "no patch".
Fine, but if the analyser returns an empty circuits array while still
reporting SPD data changes, the `circuits` section isn't re-written even if
existing orphans exist. This is a defensible early-exit; just flag that the
case "analyser returned no devices but the user wants the empty board
populated with a data-loss-guarded preserved list" isn't handled.

---

## 4. Security

- **4-1 File MIME trust** — `circuits/page.tsx:274` sets `accept="image/*"`
  which is advisory only; the backend is the security boundary. Backend does
  accept anything multer doesn't reject at `limits: { fileSize: 100MB }`
  (`src/routes/extraction.js:40`) and then the JPEG re-encode on line 719 is
  `sharp(imageBytes)` which will throw on non-image input — that throw
  currently returns a 500 rather than a 400. Out of scope for the client, but
  worth knowing: a large corrupt "image" costs a round-trip. Client-side a
  quick `file.type.startsWith('image/')` gate would be cheap defence.
- **4-2 Blob URL lifecycle** — Phase 5a does not create any `URL.createObjectURL`
  for the CCU capture (the Blob is posted, not previewed), so no revoke
  leak. Good.
- **4-3 Questions XSS** — `circuits/page.tsx:334` renders the raw `q` string
  inside JSX `{q}` which React escapes. Analyser output is untrusted (derived
  from OCR on inspector-supplied imagery), but text interpolation is safe.
  Nothing uses `dangerouslySetInnerHTML`. Good.
- **4-4 Auth** — `api.analyzeCCU` uses the standard `request()` wrapper
  which attaches bearer token + credentials. Consistent with the rest of
  the client. No header stripping concern for HTTP multipart. Good.
- **4-5 Error message leakage** — `circuits/page.tsx:162` concatenates the
  full server body (`err.message` for `ApiError` is the raw response text,
  `api-client.ts:63`) into the on-screen banner. If the backend ever starts
  returning a stack trace (it doesn't today, but 500 paths are prone), it
  surfaces to the user. Consider clipping to first line.

No hard vulnerabilities.

---

## 5. Performance

- **5-1 Full-object shallow merge** — `updateJob(patch)` replaces whole
  section bags (`circuits`, `board`, `supply`, `ccu_analysis`). On a
  36-circuit job every CCU run creates 36 new object refs → every
  `CircuitCard` re-renders. `CircuitCard` isn't memoised (`circuits/page.tsx:452`
  is a plain function component), so each render runs the `FloatingLabelInput`
  tree. For 36 cards this is O(100s of inputs) re-rendering on every CCU
  merge. Minor today; becomes meaningful at 60+ circuits.
- **5-2 No debounce / no in-flight cancel** — if the picker fires twice
  quickly (iOS Safari sometimes double-fires file inputs after a permissions
  prompt), both requests run. The server tolerates it; the second response
  wins the `updateJob` race, and the UI shows whichever `actionHint`
  resolves last. `setCcuBusy(true)` does disable the button (line 402) but
  only *after* `handleCcuFile` is entered — an already-in-flight multipart
  that fires `onChange` a second time before the disable takes effect
  isn't guarded. Low probability, low harm.
- **5-3 Base64 / resize is server-side** — client posts raw bytes; the
  backend resizes with sharp (`extraction.js:719`). Healthy split; the iOS
  client does the same.
- **5-4 Ring-buffer / streaming concerns** — none; this is a one-shot REST
  call.

---

## 6. Accessibility

- **6-1 Spinner on "Analysing" button** — `circuits/page.tsx:398-404` swaps
  the icon and the label text. Screen-reader users hear the label change
  (good); sighted keyboard users see the `animate-spin`. But there is no
  `aria-live` region announcing "Analysis started" / "Analysis complete".
  The `role="status"` on the `actionHint` paragraph (line 300) handles the
  completion case; the initial "Analysing consumer unit…" text is also set
  into that paragraph (line 139) so a polite announcement fires. Good
  trajectory, but consider explicit `aria-live="polite"` on line 300 in
  case a future variant drops `role="status"`.
- **6-2 Error banner** — `role="alert"` on lines 309, 317. Correct.
- **6-3 Question chip dismiss** — `aria-label="Dismiss question"` on line
  338. Good. The chip button is 20px (`h-5 w-5`, line 339) — below the 44px
  iOS target. Mobile users will miss-tap. P1 A11y.
- **6-4 Focus management** — after CCU success, focus stays on the (now
  disabled) rail button, which re-enables when `ccuBusy` flips false, so
  keyboard focus is retained. No focus jump to the newly-added question
  chips, which means screen-reader users may not know the chips appeared
  unless the `actionHint` polite region has fired by then.
- **6-5 File input** — `className="sr-only"` (not `display:none`) keeps it
  focusable; it's labelled via the rail button that calls `.click()`. Fine.
- **6-6 Rail button colour contrast** — orange `#ff9f0a` on white text at
  the "CCU" button. Passes 4.5:1 at the 10px uppercase label size. OK but
  borderline; the shadow stroke helps.
- **6-7 `aria-hidden` on decorative icons** — consistently applied. Good.

---

## 7. Code quality

- **7-1 Double-casting of `boards`** — `apply-ccu-analysis.ts:94-95`
  uses a `BoardRecord` local type plus a cast; `circuits/page.tsx:92-93`
  does an inline `as { boards?: { … }[] } | undefined`. Centralise via
  a `BoardsState` type in `types.ts` so both sites read the same contract.
- **7-2 `CircuitRow` uses `[key: string]: unknown`** — `types.ts:213`.
  The merge helper reads `row.board_id`, `row.circuit_ref`, `row.number`,
  `row[reading_key]` and trusts the string index. This loses autocomplete
  and allows typos through. A stricter `CircuitRow` with known keys + an
  optional `extra` bag would catch e.g. `row['measured_zs_ohms']` (extra
  s) at compile time.
- **7-3 `mergeField` generic bound** — `apply-ccu-analysis.ts:68` is
  `<T>(existing: T | undefined, incoming: T | undefined | null)` but
  callers pass `next.manufacturer as string | undefined` (line 114)
  everywhere, so `T` is inferred as `string`. The generic adds no safety
  because the cast already erased type info at the call site. Either drop
  the generic or type `next.manufacturer` natively in `BoardRecord`.
- **7-4 Inline `globalThis.crypto?.randomUUID?.() ?? \`board-${Date.now()}\``**
  appears in both `apply-ccu-analysis.ts:101, :291` and `circuits/page.tsx:72`.
  Extract to a single `newId(prefix)` helper; the `board-` / `c-` prefix
  can be a parameter.
- **7-5 `Circuit` type alias in `circuits/page.tsx`** — line 49 defines
  `type Circuit = Record<string, string | undefined> & { id: string }`,
  but the merge helper types `CircuitRow` with `unknown` values. After
  `updateJob` runs, `circuits` may contain non-string values (e.g.
  `polarity_confirmed` the helper doesn't touch but other code paths do),
  which the `as unknown as Circuit[]` on line 91 papers over. Pick one.
- **7-6 `ccuQuestions` keyed by index+slice** — `circuits/page.tsx:331`
  `key={\`${i}-${q.slice(0, 32)}\`}`. If two questions share a 32-char
  prefix (unlikely but possible with long auto-generated "What is the RCD
  type for circuit 1, 2, 3, 4, 5, 6, 7, 8, 9?" strings), keys collide.
  Index alone is fine here — dismissal already mutates by index.
- **7-7 `buildNewCircuit` hard-codes `'Spare'`** — `apply-ccu-analysis.ts:295`.
  iOS uses the same literal; fine for parity but drop a constant.
- **7-8 Persistence gap** — `updateJob` does not call `api.saveJob` yet
  (Phase 4 item per `job-context.tsx:47`). So a CCU merge lives only in
  memory until a user navigates and loses it. **The error banner claims
  "no data lost" but a page reload loses everything.** Document this or
  trigger a manual save after CCU.

---

## 8. Test coverage

- No tests added. `web/tests/` does not exist; no `__tests__/` folder
  under `web/src/lib/recording/`. `apply-ccu-analysis.ts` is 367 lines
  of branchy merge logic (6 matchers, 3 fallback paths, 2 data-loss
  guards) with zero unit tests.
- The iOS counterpart (`FuseboardAnalysisApplier.hardwareUpdate`) is
  likely covered by Swift tests the commit references but doesn't port.
- **Minimum test set I'd require before merging** (numbered against
  files in §9):
  1. Merge into an empty job → board is synthesised, circuits present.
  2. Merge into a job with 1 matching circuit that has test readings
     → readings preserved, hardware overwritten.
  3. Merge into a job where analyser omits a circuit with readings
     → data-loss guard appends that row.
  4. Merge twice with `spd_present:true` then `spd_present:false`
     → SPD state tracks latest (or respects manual, pending P1-1).
  5. Merge with an RCBO whose `rcd_type` is null → row gets
     `rcd_type:'RCBO'` and shows up as a question.
  6. Merge with `rcd_type:'RCD'` (invalid) → normaliser drops it.
  7. `hasValue` respects empty string / whitespace / `null` / `0`.
  8. Cross-board guard — circuits on a *different* board are untouched.

---

## 9. Suggested fixes (numbered, file:line)

1. `web/src/lib/job-context.tsx:55` — change `updateJob` signature to accept
   a functional updater `(prev: JobDetail) => Partial<JobDetail>` OR expose
   a `jobRef` so async merge helpers always see the latest state.
   Then `web/src/app/job/[id]/circuits/page.tsx:141-145` reads latest `job`
   inside the handler. Fixes **P0-1**.
2. `web/src/lib/recording/apply-ccu-analysis.ts:359` — namespace the stored
   analysis by board: `patch.ccu_analysis = { ...(job.ccu_analysis ?? {}),
   [boardId]: analysis }`. Update `types.ts:204` accordingly. Fixes **P0-2**.
3. `web/src/lib/recording/apply-ccu-analysis.ts:143-149` — gate the
   `spd_status` / `spd_type` writes behind `hasValue(existing[key])`,
   mirroring the `apply` closure used in `buildSupplyPatch`. Fixes **P1-1**.
4. `web/src/lib/recording/apply-ccu-analysis.ts:179-191` — swap the
   `existing[key]` check in `apply` for `next[key]` (or drop the N/A loop
   in favour of a single pass). Fixes **P1-2**.
5. `web/src/lib/recording/apply-ccu-analysis.ts:207-212` — only adopt
   `board_id == null` circuits when `targetBoardId` was passed explicitly,
   to avoid cross-run hop. Fixes **P1-3**.
6. `web/src/app/job/[id]/circuits/page.tsx:57-62` — add
   `{ value: 'RCBO', label: 'RCBO' }` to the chip list, or stop the merge
   helper from writing 'RCBO' to `rcd_type`. Fixes **P1-4**.
7. `web/src/app/job/[id]/circuits/page.tsx:131-137` — add client-side
   size+MIME guard before POST. Fixes **P1-5**.
8. `web/src/app/job/[id]/circuits/page.tsx:240` — clear `ccuQuestions`
   when the board selector changes (add
   `setCcuQuestions([])` inside the board-selector `onClick`). Fixes **P1-6**.
9. `web/src/app/job/[id]/circuits/page.tsx:337-342` — enlarge the dismiss
   hit-area to 44x44px (`h-11 w-11` with inner 12px icon) or wrap in a
   `p-2` parent with the small glyph inside. Fixes **6-3**.
10. `web/src/app/job/[id]/circuits/page.tsx:162-166` — clip server error
    bodies to the first line / first 160 chars before display. Fixes
    **4-5**.
11. `web/src/app/job/[id]/circuits/page.tsx:452` — wrap `CircuitCard` in
    `React.memo` with a prop-equality check on `circuit`, `expanded`.
    Fixes **5-1**.
12. `web/src/lib/recording/apply-ccu-analysis.ts:257-258, :292-293` —
    extract `cleanLabel(raw): string | undefined` helper that handles the
    literal `"null"` + trim + empty cases. Fixes **P2-3**.
13. `web/src/lib/types.ts:213` — narrow `CircuitRow` to known keys + a
    `extras?: Record<string, unknown>` escape hatch. Fixes **7-2**.
14. `web/src/lib/recording/__tests__/apply-ccu-analysis.test.ts` (new) —
    implement the 8-case matrix from §8.
15. `web/src/app/job/[id]/circuits/page.tsx` — after `updateJob(patch)`,
    call `api.saveJob(userId, jobId, patch)` (or enqueue through the
    Phase 7c outbox). Closes the **7-8** persistence gap.

---

## 10. Verdict + top 3 priorities

**Verdict:** Approve with changes. The merge logic is faithful to the iOS
reference, the UI affordances (capture-first picker, spinner, question
chips, error banner) are appropriate, and the public surface is well-typed.
However, the stale-closure bug (P0-1) and the unconditional
`ccu_analysis` overwrite (P0-2) are correctness issues that *will* bite a
real inspector on a real site, and the absence of any unit test for
367 lines of merge logic is not sustainable. Land P0s + at least
test-case §8.1-8.3 before any customer exposure.

**Top 3 priorities (in order):**

1. **Fix P0-1 (stale closure) and P0-2 (ccu_analysis overwrite)** —
   Suggested fixes #1 and #2.
2. **Add unit tests for the merge helper** — Suggested fix #14;
   minimum 8 cases listed in §8.
3. **Client-side upload-size guard + `spd_status` hasValue gating** —
   Suggested fixes #7 and #3. Both are cheap and both prevent a bad UX
   / silent overwrite in the field.
