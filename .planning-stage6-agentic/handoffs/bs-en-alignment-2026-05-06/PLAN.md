# BS-EN Canonical Alignment Sprint

**Author:** Claude (drafted 2026-05-06 after the post-impl code review of the chitchat-pause feature)
**Status:** Awaiting Derek's go-ahead
**Effort:** 2-3 sessions (~6-8 hours total) including production data migration window
**Depends on:** Nothing — `e5a5bc8` already shipped the migration script and the schema change.
**Risk class:** **Medium** — touches production job data via a one-shot script. Plan includes a dry-run audit, rollback strategy, and a coordinated deploy window.

---

## Goal

Eliminate the three-way canonical drift on BS-EN code values across:
1. **Backend `field_schema.json`** options (post-`e5a5bc8` — bare-digit `"60898-1"` for BS-EN, prefixed `"BS 3036"` for older standards).
2. **iOS `Constants.swift`** picker options (still pre-`e5a5bc8` — `"BS EN 60898"` everywhere, including for older standards as `"BS 3036"`).
3. **Backend `parseBsCode`** dialogue-engine canonical output (matches iOS Constants — `"BS EN 60898"` etc.).

Today these don't match; tomorrow they should all emit/accept the same string for each standard.

## Background

### Why we're here

Commit `e5a5bc8` (2026-05-06) flipped `ocpd_bs_en` and `rcd_bs_en` from `type: text` to `type: select` in `config/field_schema.json`, with options aligned to `BS_EN_LOOKUP` at `src/routes/extraction.js:257` (which the CCU pipeline writes for fresh extractions). At commit time:
- Schema options were aligned with what the CCU pipeline writes ✓
- iOS Constants were not updated ✗
- `parseBsCode` was not updated ✗

The `e5a5bc8` commit ALSO landed `scripts/normalise-bs-en-values.js` — the one-shot data migration script that converts all historical `"BS EN 60898"`-style values in `job_versions.data_snapshot` to the new bare-digit canonical. **The script has not been run on production.**

### The current state of each producer

| Path | Value written for "MCB BS EN 60898" |
|------|-------------------------------------|
| CCU Vision pipeline (`BS_EN_LOOKUP`) | `"60898-1"` |
| Dialogue-engine `parseBsCode` (mid-recording dictation) | `"BS EN 60898"` |
| Manual iOS picker selection | `"BS EN 60898"` (whatever Constants.swift contains) |
| Stage 6 ask_user resolver `resolveEnumAnswer` | `"60898-1"` (validates against schema) |

So a given job can carry both forms depending on which path filled the field. The iOS picker shows whichever one happens to match its `circuitFieldOptions` list — empty cell otherwise.

### Why no user has reported a bug

- Most fields are filled by `parseBsCode` (dictation) or manual picker tap → both write `"BS EN 60898"` → matches iOS picker → renders correctly.
- The CCU pipeline writes `"60898-1"` → does NOT match iOS picker → SHOULD render empty, but most users are dictating over the CCU-detected values during the recording session, so the empty cell only flashes briefly.
- The resolver path (`resolveEnumAnswer`) writes `"60898-1"` and is the path the recent `8dfe660` / `72d01a8` / `e5a5bc8` enum-validation work targeted — that's why those tests pass against bare-digit options.

The drift hasn't caused a visible bug, but it has made every code change in the area harder to reason about, and any future feature that reads `ocpd_bs_en` or `rcd_bs_en` has to handle both forms.

## Out of scope

- Other field-type-vs-picker mismatches (only BS-EN fields are in scope).
- Adding new BS-EN codes to the schema (62606 AFDD, 4293 legacy RCD aren't in the OCPD/RCD schema options today; that's a separate schema-extension decision).
- Changing how the dialogue engine selects the appropriate BS code for a device (the trigger logic stays unchanged).
- Migrating data on the per-user iOS sync layer — only server-side `job_versions` rows are touched.

## Phase 0 — Decision: which canonical form

Before writing any code, decide which form is the single source of truth.

### Option A — Bare-digit (e.g. `"60898-1"`) — schema's current form

**Pros:**
- Already what `BS_EN_LOOKUP` writes for new CCU detections (~the bulk of new data).
- Already what the resolver-path enum check validates against.
- More compact — easier to read on dense PDFs.
- Closer to "the canonical BS-EN reference" as published by IEC.

**Cons:**
- Inspectors don't say `"60898-1"` aloud — they say `"BS EN 60898"` or just `"60898"`. This is a display canonical, not a speech canonical.
- iOS picker would change visually for every existing user.
- All existing job data has the prefixed form — needs migration.

### Option B — Prefixed (e.g. `"BS EN 60898"`) — iOS Constants' current form

**Pros:**
- Matches what's printed on a UK certificate ("BS EN 60898" is the standard reference inspectors quote).
- Matches what every previous TestFlight build wrote.
- No iOS picker visual change for existing users.
- Existing job data already in this form for ~everything except CCU detections.

**Cons:**
- CCU pipeline (`BS_EN_LOOKUP`) needs updating to write the prefixed form.
- Schema options need re-flipping back to prefixed form.
- The migration script (`scripts/normalise-bs-en-values.js`) maps the wrong direction — would need rewriting.
- Resolver enum check needs to compare on a normalised digit form (already does — `normaliseBsEnDigits`).

### Option C — Both forms accepted; canonical chosen per render context

**Pros:**
- No data migration.
- iOS picker accepts either; renders the prefixed form regardless of stored form.

**Cons:**
- Doubles the surface area of every value comparison forever.
- Doesn't fix the underlying drift; just papers over it.
- Hard to reason about: which form does a given DB query return?

### Recommendation: **Option B (prefixed)**

Rationale:
- Inspectors and certificates use the prefixed form. The iOS picker, the printed PDF, and the spoken vocabulary should all align with what the user already sees in print.
- Migration burden is smaller in absolute terms — the CCU pipeline writes ~hundreds of values per day; existing data is bigger but the migration script only has to handle one direction (bare → prefixed).
- The migration script already exists for the OPPOSITE direction (bare-digit canonical), but extending it for the reverse mapping is mechanical (literally swap the keys/values in the existing maps).

The recommendation is overridable. **Decision required from Derek before Phase 1 starts.**

If you choose A, this plan is mostly fine but the migration script runs as-is.
If you choose B, the plan needs minor rewriting of phase 1 + phase 4 (covered below in inline notes).

---

## Phase 1 — Pre-flight production audit

**Goal:** know exactly what's in production before changing anything.

### Script: `scripts/audit-bs-en-values.js` (NEW)

Read-only script that walks `job_versions.data_snapshot` and reports:
- Histogram of distinct values for `ocpd_bs_en` and `rcd_bs_en` per row.
- Count of rows containing each form (prefixed vs bare-digit vs unknown).
- Top 20 unknown values (not in any FIXED list) so the migration mapping table can be extended before --apply.
- Per-user breakdown (do older accounts still use the prefixed form predominantly?).

Output: a CSV + summary JSON.

```js
// Pseudo-shape:
{
  total_rows_scanned: 12_345,
  rows_with_ocpd_bs_en: 8_421,
  rows_with_rcd_bs_en: 4_120,
  ocpd_distribution: {
    "BS EN 60898": 5_200,
    "60898-1": 1_100,
    "60898": 800,
    "MCB": 50,
    // …
  },
  rcd_distribution: { /* similar */ },
  unknown_values: ["BS 60898 (sic)", "61008 1", /* … 18 more */],
  rows_per_user_ocpd: { "user-uuid-1": 1_200, /* … */ }
}
```

### Run

```bash
node scripts/audit-bs-en-values.js > audit-2026-05-06.json
```

### Decision gate

After reading the audit:
- If unknown values are < 1% of rows → migration is safe. Proceed.
- If unknown values are > 5% → extend the mapping table in `normalise-bs-en-values.js` to cover them, then re-run audit.
- If a single user holds > 30% of all rows → coordinate the migration window with that user's expected job-recording schedule (avoid mid-job migration where possible).

### Verification

- Audit script is read-only — `EXPLAIN` query confirms no UPDATE statements.
- Run on a staging DB clone first; verify summary counts vs. raw `SELECT COUNT(*)`.
- Run on production; commit the audit JSON to `.planning-stage6-agentic/handoffs/bs-en-alignment-2026-05-06/audit-results-{date}.json`.

### Commit

`feat(scripts): add audit-bs-en-values.js — read-only pre-flight for the alignment sprint`

---

## Phase 2 — Update `parseBsCode` canonical output

> If Option A is chosen, this phase changes parseBsCode TO write bare-digit form.
> If Option B is chosen, this phase is a NO-OP — parseBsCode already writes the prefixed form. Skip ahead to Phase 3.

### File: `src/extraction/dialogue-engine/parsers/bs-code.js` (only if Option A)

Replace the `PATTERNS` table canonicals:
```js
// BEFORE (Option A target)
{ re: /\b60898\b/, canonical: 'BS EN 60898' },
{ re: /\b61008\b/, canonical: 'BS EN 61008' },
…

// AFTER
{ re: /\b60898\b/, canonical: '60898-1' },
{ re: /\b61008\b/, canonical: '61008' },
…
```

Update `FUZZY_TARGETS` to match:
```js
// BEFORE
{ digits: '60898', canonical: 'BS EN 60898' },

// AFTER
{ digits: '60898', canonical: '60898-1' },
```

Pre-EN forms (`BS 3036`, `BS 1361`, `BS 4293`, `BS 88-2`, `BS 88-3`) keep the `"BS X"` prefix — they're not BS-EN standards and the schema already uses that form.

### Tests to update

- `src/__tests__/dialogue-engine-bs-code-parser.test.js` — every assertion of canonical strings (e.g. `expect(parseBsCode('60898')).toBe('BS EN 60898')` becomes `.toBe('60898-1')`).
- `src/__tests__/dialogue-engine-pd.test.js` — 50+ assertions of `circuit.ocpd_bs_en` / `circuit.rcd_bs_en` need updating.

### Commit (Option A only)

`refactor(stage6): align parseBsCode canonicals to schema bare-digit form`

---

## Phase 3 — Update iOS `Constants.swift`

> Both Option A and Option B require a Constants.swift change.
> Option A: change to bare-digit form.
> Option B: confirm current Constants matches the chosen form (no change), but update the BACKEND schema in Phase 4 instead.

### File: `Sources/Utilities/Constants.swift` (Option A scenario)

```swift
// BEFORE
static let ocpdBsEnOptions = ["BS EN 60898", "BS EN 61009", "BS EN 60947-2", "BS 88-2", "BS 88-3", "BS 1361", "BS 3036", "BS EN 62606"]
static let rcdBsEnOptions = ["BS EN 61008", "BS EN 61009", "BS EN 62423", "BS 4293", "N/A"]

// AFTER (Option A)
static let ocpdBsEnOptions = ["60898-1", "61009", "60947-2", "60947-3", "60269-2", "BS 3036", "BS 1361", "N/A"]
static let rcdBsEnOptions = ["61008", "61009", "62423", "N/A"]
```

Note: `"BS 88-2"`, `"BS 88-3"`, `"BS EN 62606"`, `"BS 4293"` drop OUT — they're not in the backend schema options. If the team decides they should be (especially `BS EN 62606` for AFDDs which are increasingly common), Phase 4 also extends the schema.

### Picker rendering check

The iOS picker uses the option list directly as the `Picker` content. A value not in the list renders as empty selection. Verify by:
1. Build to simulator.
2. Open a job that has `ocpd_bs_en = "BS EN 60898"` (pre-migration data).
3. Confirm the picker renders empty (this is the bug we're fixing).
4. After migration: same job should render with the new value selected.

### Migration handling for in-flight TestFlight builds

If older TestFlight builds (Build 282, 313, etc.) are still in circulation, those builds will see migrated data with the WRONG canonical (bare-digit) and render empty pickers. Mitigations:
- Force-update the in-circulation TestFlight: bump `CFBundleVersion` and push a new build BEFORE running the migration. Old build pinged in App Store Connect → users see the update prompt.
- OR: keep both forms in `Constants.swift` temporarily as a tolerant transition list, drop the old forms in a follow-up build a week later.

### Commit (Option A)

`feat(constants): align iOS BS-EN picker options to backend schema bare-digit form`

---

## Phase 4 — Update backend schema (Option B only) OR confirm alignment (Option A)

> Option A: schema is already correct, no edit needed.
> Option B: revert the schema change from `e5a5bc8` so options match the prefixed form.

### File: `config/field_schema.json` (only if Option B)

```jsonc
// BEFORE
"ocpd_bs_en": {
  "type": "select",
  "options": ["", "60898-1", "61009", "60947-2", "60947-3", "60269-2", "BS 3036", "BS 1361", "N/A"],
  …
}

// AFTER (Option B)
"ocpd_bs_en": {
  "type": "select",
  "options": ["", "BS EN 60898", "BS EN 61009", "BS EN 60947-2", "BS EN 60947-3", "BS EN 60269-2", "BS 3036", "BS 1361", "N/A"],
  …
}
```

The `resolveEnumAnswer` resolver already normalises both sides via `normaliseBsEnDigits` — comparing on the digit form — so the resolver's ability to match `"6898"` (typo) to either canonical form is preserved.

### `BS_EN_LOOKUP` in `src/routes/extraction.js:257` (Option B only)

```js
// BEFORE
const BS_EN_LOOKUP = {
  MCB: '60898-1',
  RCBO: '61009',
  …
};

// AFTER
const BS_EN_LOOKUP = {
  MCB: 'BS EN 60898',
  RCBO: 'BS EN 61009',
  …
};
```

CCU pipeline tests need their canonical assertions updated.

### Commit (Option B)

`feat(schema): align ocpd_bs_en and rcd_bs_en options to BS-EN-prefixed canonical form`

---

## Phase 5 — Migration script update

### Direction: Option A

Existing `scripts/normalise-bs-en-values.js` already maps prefixed → bare-digit. **No change required.** Mapping table verified as comprehensive against the Phase 1 audit.

### Direction: Option B

Mapping table needs INVERTING:
```js
// BEFORE (script as-shipped)
const OCPD_BS_EN_MAP = {
  '60898': '60898-1',
  'bs en 60898': '60898-1',
  // …
};

// AFTER (Option B)
const OCPD_BS_EN_MAP = {
  '60898-1': 'BS EN 60898',
  '60898': 'BS EN 60898',
  'bs en 60898': 'BS EN 60898', // already canonical, no-op write
  // …
};
```

Same for `RCD_BS_EN_MAP`.

### Tests: `scripts/__tests__/normalise-bs-en-values.test.mjs`

Update all assertions to the chosen direction.

### Commit (whichever direction)

`refactor(scripts): adjust normalise-bs-en-values.js mapping table to chosen canonical`

---

## Phase 6 — Coordinated deploy + migration

### The deploy window

This is the only phase that touches production data. Plan it carefully.

**Pre-flight (T-24h):**
1. Confirm Phase 1 audit JSON is recent (re-run if > 7 days old).
2. Take a logical backup of the `job_versions` table:
   ```bash
   pg_dump -h <host> -U <user> -t job_versions <db> > backup-job_versions-{date}.sql
   ```
3. Push the schema/parser/Constants commits to `main` and let CI deploy them. Schema/parser changes are backward-compatible because the migration hasn't run yet — the pre-fix data still works through the old paths.

**T-0 (deploy window):**
1. SSH to the bastion host (or run from a CI step with DB credentials).
2. Run dry-run:
   ```bash
   node scripts/normalise-bs-en-values.js --report-only > migrate-report.json
   ```
3. Eyeball `migrate-report.json` for surprises. Distribution should match Phase 1 audit ± a small drift for new rows.
4. Apply:
   ```bash
   node scripts/normalise-bs-en-values.js --apply > migrate-applied.log
   ```
5. The script processes rows in per-row transactions; a partial run is recoverable.
6. Verify:
   ```sql
   SELECT data_snapshot->'circuits' AS circuits FROM job_versions
   WHERE data_snapshot::text LIKE '%bs en 60898%' LIMIT 5;
   -- expect 0 rows after Option A migration; expect prefixed form after Option B
   ```

**T+1h (smoke check):**
- Open production iOS picker on a recent job. Verify `ocpd_bs_en` cell renders the migrated value.
- Open a CCU-detected circuit. Verify the picker matches.
- Run a fresh dictation session: dictate "BS EN 60898" — verify it lands as the chosen canonical.
- Run a fresh CCU extraction: verify `BS_EN_LOOKUP` writes the chosen canonical.

**T+24h (monitor):**
- CloudWatch query for `Schema validation failed` log lines on `ocpd_bs_en` / `rcd_bs_en` fields. None expected.
- Spot-check 10 random recent jobs in the iOS app — pickers should all display correctly.

### Commit (none — this is a runtime operation)

Run-log committed to `.planning-stage6-agentic/handoffs/bs-en-alignment-2026-05-06/migrate-applied-{date}.log`.

---

## Rollback strategy

If anything is wrong post-migration:

### Soft rollback (preferred)

1. Run the inverse mapping by writing a reverse migration script — same shape as the forward one with key/value swap.
2. Apply.
3. Eyeball the same verification queries.

This avoids the heavy hammer of a `pg_restore` and keeps any post-migration writes intact.

### Hard rollback

If the soft rollback would itself be unreliable (e.g. the bug is "wrong values written for some rows" where the inverse isn't well-defined):
1. Stop the backend (ECS desired count → 0). All in-flight users see "Server disconnected" — temporarily acceptable for a 5-10 minute restore window.
2. `pg_restore` the `job_versions` backup taken at Phase 6 pre-flight.
3. Resume backend.
4. Users will see their job state rewound to whatever it was at backup time. Communicate via inspector group + email.

### Decision gate

If the migration's `--report-only` output looks unexpected (high unknown-value count, surprising distribution shifts), DO NOT --apply. Investigate first. Phase 1's audit + this report-only step together provide two checkpoints; the apply commit is intentionally the third gate.

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| Migration overwrites a user's mid-job state at apply time | Low | High | Coordinate window with field schedule; per-row transactions limit blast radius |
| Some unknown value not in mapping table is silently left as-is | Medium | Low | The script REPORTS unknowns; Phase 1 audit catches them upfront |
| In-flight TestFlight build (older `Constants.swift`) shows empty pickers post-migration | Medium | Medium | Force a TestFlight bump BEFORE migration; or use a tolerant transition list (Option A) |
| BS_EN_LOOKUP and parseBsCode disagree post-migration | Low | High | The phase plan updates both in Phase 2 + Phase 4 in the same release |
| Migration runs partially due to network blip | Medium | Low | Per-row transactions; the script is idempotent — re-run picks up where it stopped |
| Post-migration value is rejected by the resolver (Option A) or accepted but mis-rendered (Option B) | Low | Medium | Phase 6 smoke check catches this in the first hour |

---

## Phase ordering rationale

P0 (decision) gates everything else; can't write the script otherwise.

P1 (audit) is read-only and can run anytime. Outputs a concrete number for the unknown-value risk.

P2-P4 (schema/parser/iOS/lookup updates) are code commits, deployable independently. Schema/parser/lookup land via CI; iOS via TestFlight. Each adds a column-mismatch risk window — if Phase 4 lands but Phase 5 hasn't run, fresh iOS dictations write the new canonical while old DB rows still hold the old canonical. Acceptable for a few hours; the migration in Phase 6 closes the gap.

P5 (script update) — only if Option B (existing script handles Option A unchanged).

P6 (deploy + migrate) is the apex. Everything before this is reversible by reverting commits; this phase touches data. Plan the window.

---

## Definition of done

1. All commits on `main` (backend) and a TestFlight push (iOS).
2. Migration applied with verified `migrate-applied.log` showing zero unknown values left over.
3. Smoke checks at T+1h and T+24h all green.
4. CLAUDE.md changelog row added describing the alignment + the migration outcome.
5. `.planning-stage6-agentic/handoffs/bs-en-alignment-2026-05-06/` archive contains: this PLAN.md, audit-results-{date}.json, migrate-applied-{date}.log, and a one-paragraph retro on whether the chosen Option (A or B) was correct.

---

## Open questions for Derek

1. **Option A vs B?** This blocks Phase 1.
2. **TestFlight migration window** — willing to push a "force-update" build before migration? Affects how many users see broken pickers during the gap.
3. **AFDD (BS EN 62606) and BS 4293 status** — should the schema add these as valid options, or are they explicitly out-of-scope for the OCPD/RCD pickers?
4. **Migration run timing** — is there a known job-recording lull (e.g. weekend morning) when the migration window has the lowest disruption risk?

## Status

**Awaiting Derek's go-ahead and the four open-question answers.** Phase 1 (audit) can run independently of those decisions; the rest blocks on Phase 0.
