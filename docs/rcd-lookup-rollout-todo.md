# RCD-type lookup — rollout TODO

> Companion doc for the deterministic `(manufacturer, model) → rcd_type` lookup
> introduced 2026-05-05. Tracks open concerns, pre-rollout actions, and follow-ups
> deferred from the initial implementation. Delete entries as they're closed; add
> new ones when something surfaces during the tester period.

## Architecture summary (one-liner)

The Stage 1 classifier already returns a clean `(board_manufacturer, board_model)`
pair on most photos. Given those, the RCD type is deterministic from the
manufacturer's published spec — there is no need for the per-slot VLM to read
the sub-millimetre BS-EN 61009 waveform glyph. This feature short-circuits the
unreliable read whenever the table has a hit, and grows the table organically
as testers see new boards.

Code:
- `config/rcd-type-lookup.json` — seed table.
- `src/extraction/rcd-type-lookup.js` — pure `lookupRcdType` + apply.
- `src/extraction/rcd-pending-writer.js` — S3 auto-grow.
- `scripts/promote-rcd-lookup.js` — interactive promote CLI.
- Wired in `src/routes/extraction.js` before `lookupMissingRcdTypes`.

---

## Before tester rollout (P0 — must do)

- [ ] **Audit `config/rcd-type-lookup.json` against your real-world experience.**
      Twelve of the thirteen manufacturer defaults are `verified_by: "literature"`
      — that's me reading datasheets and industry knowledge, not you confirming
      the brands you actually fit. Walk through each entry and either:
      - Demote anything you don't personally vouch for to `confidence: "low"`
        (so it only fills nulls and never overrides), or
      - Promote brands you fit regularly to `confidence: "high"` with
        `verified_by: "field"` and the date.
      Particular call-outs to verify:
      - **Wylex**: NHXBSC = Type A modern, NSBS older = Type AC. The default is
        currently `medium`. Consider whether the older-stock risk is high enough
        to keep at medium, or whether you only see modern stock now.
      - **Hager**: kept `null` deliberately because VML/VYP/VKM split. Confirm
        whether any specific Hager models you fit should be added as `model`-level
        entries.
      - **Eaton / Crabtree / Contactum / Lewden**: all kept `null` for the same
        reason. Add models you trust.

- [ ] **Smoke-test the route handler end-to-end** with a known Elucian CU1SPD275
      shot (the one from the production logs on 2026-05-05 would be ideal).
      Confirm the new `RCD type lookup applied` log line appears with
      `outcome: "hit"` and that `rcd_type_source: "model"` lands on every
      RCD-protected circuit in the response payload. Check iOS still decodes
      the payload — `rcd_type_source` etc. are additive new fields, no breaking
      change expected, but verify before testers see it.

---

## During tester rollout (P1 — operational)

- [ ] **Weekly review pass** — run
      `S3_BUCKET=eicr-uploads node scripts/promote-rcd-lookup.js --list`
      to surface what's accumulating in `rcd-lookup-pending/`. Then run without
      `--list` to interactively promote the high-agreement entries.

- [ ] **Watch CloudWatch** for these new structured log events:
      - `RCD type lookup outcome` — emitted on every extraction; outcome field
        is `hit` / `default` / `no_type` / `miss`.
      - `RCD type lookup applied` — only when a type was actually applied;
        includes `applied`, `overridden`, `kept` counts and `waysWarning`.
      - `RCD pending entry recorded` — emitted on auto-grow writes.
      Useful query (CloudWatch Logs Insights):
      ```
      fields @timestamp, outcome, matchedKey, rcdType, applied, overridden, kept
      | filter message like /RCD type lookup/
      | sort @timestamp desc
      ```

- [ ] **Backup before promotions.** The promote CLI already writes a `.bak`
      next to the JSON before any change. After promoting, also commit the
      updated `config/rcd-type-lookup.json` so the table change ships in the
      next deploy.

---

## Deferred follow-ups (P2 — improvements, not blockers)

- [x] **(2026-05-05) Use `ways` to override the box-tightener count.**
      `tightenAndChunk` now accepts `{ waysOverride }`; route handler looks
      it up (post-classifier, pre-geometry) and forces the count when the
      datasheet ways is known. Refinement still runs but cannot change the
      count when the override is in effect. This is the structural fix for
      the Hob-disappearing problem on Elucian CU1SPD275.

- [x] **(2026-05-05) Confusable-pair model matching.** `lookupRcdType`
      now generates single-character substituted variants (S↔5, O↔0, I↔1,
      L↔1, B↔8, G↔6, Z↔2) and tries each against the manufacturer's
      models. Catches Stage 1 OCR errors like `CU1SPD27S` → `CU1SPD275`.
      Abstains when 2+ variants match (ambiguous → fall through to
      manufacturer default rather than guess).

- [x] **(2026-05-05) Manufacturer alias support.** `manufacturer_aliases`
      section in the JSON. Seeded with `click_scolmore→elucian`,
      `bg_electrical→bg`, `crabtree→eaton`, `schneider_electric→schneider`,
      etc. Cycle-bounded at 8 hops.

- [x] **(2026-05-05) Surface `ways_warning` via `questionsForInspector`.**
      When the count override didn't fire (e.g. only manufacturer default
      hit, no `ways`) but the lookup knows the expected count, an inspector
      question is appended: "Module count check: detected N modules but X
      datasheet expects M. Please verify all end devices are present."
      Safety net for the cases the override can't catch.

- [x] **(2026-05-05) Startup self-test for the table.** `selfTest()` runs
      on backend boot from `src/server.js`. Checks the file loads, the
      Elucian canary resolves to Type A, the Click Scolmore alias resolves,
      and the CU1SPD275 confusable matches. Logs at `error` level on fail
      so CloudWatch can alarm on a malformed JSON deploy.

- [ ] **Plumb `waysOverride` through `prepareModernGeometry` too.** The
      shipped override only flows through the `tightenAndChunk` path (which
      is what fires on iOS uploads, since they always include a railRoiHint
      and `CCU_BOX_TIGHTEN=true`). The legacy `prepareModernGeometry` →
      `getModuleCount` path still uses the height-anchor formula. Low
      priority because production traffic doesn't hit it, but worth doing
      for parity / web-frontend uploads.

- [ ] **Saved CloudWatch Logs Insights query** for promote-time analysis. The
      promote CLI currently only sees S3 sighting payloads. A saved query that
      pulls the inspector's final corrections (where they over-rode the lookup)
      would let us promote at higher confidence.

- [ ] **Per-RCBO part-number OCR (separate sprint).** The bigger architectural
      improvement we discussed: rather than relying on the *board* model
      identifying every device on it uniformly, OCR the part number printed on
      each RCBO's front face and look up its individual datasheet. This handles
      the long-tail case where individual RCBOs in a board are mixed (older
      retrofits in an otherwise-uniform-A board). Needs PaddleOCR (or
      equivalent) in the container plus a separate part-number lookup table.
      Right scope for a follow-up; this lookup feature handles the common case
      first.

- [ ] **Box-tightener homography rewrite (separate sprint).** Discussed
      separately: replace the single-scalar `pxPerMm` formula with a 4-point
      quadrilateral rectification so off-axis CCU shots stop dropping end
      devices. The shipped `waysOverride` mitigates this for boards whose
      model is identifiable AND has a `ways` entry — but for unknown boards
      the underlying CV is still fragile. Homography fixes the long tail.

---

## Known limitations / risks

- **Pending writer is fire-and-forget.** Failures are logged but not retried.
  If S3 is briefly down during a tester session, that sighting is lost.
  Acceptable for a learning-loop mechanism (we'll see the same board again),
  but worth knowing if you spot a board missing from the pending list that you
  expected to be there.

- **Mtime cache could (rarely) miss in-millisecond updates.** If the lookup
  table is ever updated and the cache check happens within the same
  millisecond as the write, the cache could miss the change. Vanishingly rare
  in practice (JSON edits are not sub-ms apart from extractions). Tested
  against forced `utimesSync` to ensure the path works when timestamps do
  change.

- **Manufacturer normalisation is aggressive.** See the alias TODO above —
  same brand spelled differently across photos won't match. Promote CLI
  output will surface this as duplicate entries; treat as a signal, not a bug.

- **No ALL_TYPES seed for B/F/S types.** The schema supports them (the
  lookup module's `VALID_TYPES` set covers AC/A/B/F/S) but no seed entries
  use them. Type B is rare on UK domestic; if any tester hits an EV-charge
  point with a Type B RCBO upstream, the system will fall through to the
  existing logic.

---

## Done (kept for reference)

- [x] **2026-05-05** — Initial scaffolding shipped: seed table + lookup module +
      pending writer + promote CLI + 50 unit tests + route handler integration.
      All 2695 tests in the suite green. Zero ESLint errors.

- [x] **2026-05-05** — Second wave shipped after the first tester extraction
      reproduced the Hob-disappearing problem under the new lookup
      (extraction `1777971668353-cu13i3`):
      - `tightenAndChunk` accepts `{ waysOverride }`; refinement no longer
        changes the count when override is active.
      - `lookupRcdType` does confusable-pair model matching (CU1SPD27S →
        CU1SPD275) and resolves manufacturer aliases (Click Scolmore →
        Elucian).
      - Route handler runs the lookup pre-geometry and feeds `ways` into
        the box-tightener.
      - `applyRcdTypeLookup` appends a `Module count check` question to
        `questionsForInspector` when the override didn't fire but the
        warning data is available.
      - `selfTest()` runs at backend boot from `src/server.js`.
      All 2719 tests green (24 new). Zero ESLint errors.
