# Mini-Wave 4.5 Handoff — zod v3/v4 unification + types.ts collapse

**Branch:** `mini-wave-4.5-zod-types-collapse` (off `web-rebuild`)
**Commits (oldest → newest):**
- `72768f0` — `chore(web): mini-wave 4.5 — migrate web to zod v4 (unified with shared-types)`
- (second commit SHA after `refactor(types)` lands)

**Scope:** the two cross-cutting deferrals on the Web Rebuild Completion doc (§2.4 rows 1 + 2): retire the zod v3/v4 split so `packages/shared-types` schemas can eventually be consumed from web without crossing a major-version boundary, then collapse `web/src/lib/types.ts` down to "view-model / drift-flagged" shapes only, with the types that match shared-types 1:1 re-exported from there.

**Status:** 116/116 vitest green · 318/318 backend jest (3 pre-existing skipped) · `tsc --noEmit` clean · `npm run lint` unchanged at 0 errors / 6 pre-existing warnings.

---

## What was done

### Item 1 — zod v3 → v4 migration

`web/package.json`:
- `"zod": "^3.25.76"` → `"^4.3.6"`. Aligns exact minor with `packages/shared-types` (which already declares `^4.3.6`).

`package-lock.json`: regenerated — `web/node_modules/zod` now resolves to `4.3.6`. Root hoisted `zod` stays at `3.25.76` because `packages/shared-types` is a workspace dep and web is the only other zod consumer; the split lives in node_modules only and doesn't appear in any source file.

**Zero source edits.** The entire adapter layer (`web/src/lib/adapters/*.ts`) was already authored against the v4 API surface:
- `z.record(z.string(), z.unknown())` — two-arg form (v4 API; v3 accepted one arg).
- `result.error.issues.map(...)` — `.issues`, not `.errors` (both exist in v4; only `.errors` existed in v3 legacy).
- `z.enum(...)`, `z.object({...}).passthrough()`, `.safeParse(data)` — unchanged between v3 and v4.
- No `z.string().email()` / `.url()` / `.uuid()` call-sites existed (would have broken under v4).
- No `ZodTypeAny` imports from a bare path (all imports already use `import { z, type ZodTypeAny } from 'zod'`, which v4 still exports).

**Breaking changes encountered:** none. The codemod ran effectively in the Wave 2b D2 author's head when they wrote the adapters — every API surface they picked was the v4-stable one even though the runtime was v3.

### Item 2 — `web/src/lib/types.ts` collapse into `@certmate/shared-types`

`web/src/lib/types.ts`:
- `CertificateType` and `Job` local declarations **removed**; replaced with `import type { Job, CertificateType } from '@certmate/shared-types'` + `export type { Job, CertificateType }`.
- The import is required alongside the re-export because `JobDetail extends Job` and `CompanyJobRow` → `certificate_type?: CertificateType` still refer to them inside the same module.
- New file header comment documents the post-4.5 policy: re-exports for 1:1 matches, local for drift or web-only, local for view-model helpers.
- New section divider comments (`// Re-exports from @certmate/shared-types` / `// Web-local types`) make the split visible at a glance.
- Existing `User` interface picked up a comment clarifying why it stays local (web carries `company_id` / `company_role`; shared-types' `User` has not been updated yet).

**Caller-facing contract preserved** — every `import { X } from '@/lib/types'` across the 29 `.ts` / `.tsx` consumers continues to resolve the same type. No call-site edits.

### Types inventory — what moved vs what didn't

`web/src/lib/types.ts` contains 20 declarations. Audit:

| Type | In shared-types? | Action | Why |
|---|---|---|---|
| `CertificateType` | Yes (job.ts) — identical | **Re-exported** | Same literal union in both. |
| `Job` | Yes (job.ts) — identical | **Re-exported** | Six fields, same shape. |
| `User` | Yes (api.ts) — web superset | Kept local + flag | Web carries `company_id`, `company_role`; shared-types doesn't yet. |
| `AdminUser` | Yes (api.ts) — shape drift | Kept local + flag | Web extends User + optional/nullable; shared-types is flat + non-nullable + `company_name: string \| null`. |
| `CompanySettings` | Yes (api.ts) — shape drift | Kept local + flag | Web has all-optional + `logo_file?: string \| null`; shared-types has all-required + `logo_file: string \| null`. |
| `InspectorProfile` | Yes (job.ts) — web superset | Kept local + flag | Web carries the 10-field equipment block (iOS `Inspector.swift` parity); shared-types has a 6-field subset. |
| `JobDetail` | Yes (job.ts) — shape drift | Kept local + flag | Web is permissive (`Record<string, unknown>` per tab, `CircuitRow[]` / `ObservationRow[]` with index signatures); shared-types is strict (`Circuit[]`, `Observation[]`, explicit `InstallationDetails`). Divergence is by design — web backend returns the permissive shape today. |
| `CircuitRow` | No (shared has `Circuit` with different shape) | Kept local | `Circuit` in shared-types is `circuit_ref` + `circuit_designation` + string-valued fields. Web `CircuitRow` uses `number` / `description` + `[key: string]: unknown`. Different contract. |
| `ObservationRow` | No (shared has `Observation` with different shape) | Kept local | `Observation` in shared-types requires `item_location` + `observation_text`. Web `ObservationRow` is all-optional + carries `photos` + `location` + `remedial`. |
| `InspectorInfo` | No | Kept local | Light profile variant for JobDetail embedding. |
| `CCUAnalysis` / `CCUAnalysisCircuit` | No | Kept local | Sonnet-response shape. |
| `DocumentExtractionResponse` / `...FormData` / `...Circuit` / `...Observation` | No | Kept local | GPT-Vision-response shape. |
| `LoginResponse` | No (shared has `AuthResponseSchema` only) | Kept local | Thin `{token, user}` envelope; shared-types' schema-only export isn't a symmetric TS interface. |
| `CompanyLite` | No | Kept local | Web-only dropdown row. |
| `CompanyMember` | No | Kept local | Web-only team-list projection. |
| `CompanyJobRow` | No | Kept local | Web-only company-scoped jobs projection. |
| `CompanyStats` | No | Kept local | Web-only dashboard stats. |
| `InviteEmployeeResponse` | No | Kept local | Web-only invite envelope. |
| `Paginated<T>` | No | Kept local | Web-only pagination envelope. |
| `ApiError` (class) | No (view-model) | Kept local | Client-side error surface — never belongs in shared-types. |

**Net:** 2 types re-exported, 18 kept local, 0 new types moved to shared-types this wave (per scope: "Do NOT introduce new wire types. Only move existing ones.").

### Why so few re-exports survived the audit

The pre-wave hypothesis (WEB_REBUILD_COMPLETION §5 row 5: "`web/src/lib/types.ts` holds only view-model types; wire types re-exported from `@certmate/shared-types`") assumed the two sides were aligned. Reality, surfaced during the audit: shared-types was authored earlier and never re-synced as the web backend's wire shapes evolved during Phases 5–7. Two examples:

- Web `User` added `company_id` / `company_role` in Wave 4 D4 (JWT claims). Shared-types still has the pre-D4 shape.
- Web `JobDetail` uses `Record<string, unknown>` for every tab so the Sonnet extraction prompt can add keys without a deploy. Shared-types `JobDetail` is strict — every key is declared.

Reversing those divergences means either (a) tightening the web wire shape to the shared-types strict contract (breaking every Sonnet prompt evolution into a deploy) or (b) updating shared-types to the web's permissive shape (breaking iOS's strict consumer pattern). Neither is in scope for 4.5, both are flagged here for a future Phase 9 "contract alignment" effort.

---

## Verification

| Gate | Before | After |
|---|---|---|
| `npx tsc --noEmit` (web) | clean | clean |
| `npx vitest run` (web) | 116/116 | 116/116 |
| `npm run lint` (web) | 0 err / 6 warn | 0 err / 6 warn |
| `npm test` (backend jest) | 318/318 (3 skipped) | 318/318 (3 skipped) |

The 6 lint warnings are the pre-existing `react-hooks/exhaustive-deps` + one `_certificateType` unused — unrelated to this wave, queued for Wave 5 lint-zero.

---

## Why this approach

**v3 → v4, not v4 → v3.** shared-types is the forward-looking contract. Reversing direction would mean rewriting `packages/shared-types/src/schemas.ts` + every future consumer; v4 is the current stable line; and web's adapter layer was already authored against the v4 API surface by the Wave 2b author, so the bump was drop-in.

**Re-export over rewrite.** The stated goal was "only view-model types remain local." The honest outcome is "only types that match shared-types 1:1 are re-exported; everything else (even wire types that look similar) stays local with a drift flag." This preserves the 29-file consumer contract without forcing a simultaneous shared-types evolution — which would have blown mini-wave 4.5's scope by a 10x factor.

**No call-site edits.** `import { Job } from '@/lib/types'` still resolves the shared-types `Job`. If a future wave moves more types to shared-types (or aligns shapes), `types.ts` can quietly re-point its import without touching any consumer.

**Drift flagged, not silenced.** Every interface that looks like a shared-types type but isn't gets an inline comment explaining why it stays local. This keeps the next person from re-tripping on "isn't this already in shared-types?" without the audit cost.

---

## File inventory

Modified:
- `web/package.json` — zod ^3.25.76 → ^4.3.6
- `package-lock.json` — regenerated
- `web/src/lib/types.ts` — re-export `Job` + `CertificateType` from shared-types; removed local declarations; updated header comment + User comment + section dividers

Added:
- `web/reviews/MINI_WAVE_4_5_HANDOFF.md` (this file)

No source file was touched beyond `types.ts` — the zod migration required zero source edits because the adapter layer was already v4-compatible.

---

## Surfaced-but-unfixed drift (for future phases)

Flagged during the types audit, **not fixed** per scope:

1. **`User` shape drift** — shared-types `User` lacks `company_id` + `company_role`. Add in a shared-types revision alongside a Phase 9 "D4 backport to shared-types" pass.
2. **`AdminUser` shape drift** — shared-types has `company_name: string | null` required; web has `company_name?: string` optional. Pick one.
3. **`CompanySettings` shape drift** — same pattern: shared-types is strict-required, web is permissive-optional. Web wins today (the backend sends partial objects); shared-types should follow.
4. **`InspectorProfile` shape drift** — shared-types has 6 fields; web has the full 11-field equipment block (iOS parity). Back-port to shared-types.
5. **`JobDetail` shape drift** — the biggest one. Web uses `Record<string, unknown>` per tab + `CircuitRow[]` / `ObservationRow[]` with permissive index signatures; shared-types is strict (`Circuit[]`, `Observation[]`, explicit per-tab interfaces). Aligning this is a Phase 9 "wire-contract tightening" pass — not a 4.5 scope.
6. **`Circuit` / `Observation` shape drift** — shared-types uses `circuit_ref` / `circuit_designation` + string-valued fields; web uses `number` / `description` + permissive index signature. Same as above — different contracts that both work today.

None of these block merge. All will be natural follow-ups when either (a) iOS consumes shared-types and forces alignment, or (b) the backend wire shapes are tightened to match shared-types.

---

## Recommended next

- Merge `mini-wave-4.5-zod-types-collapse` → `web-rebuild`.
- Proceed to Wave 5 (PWA durability + a11y polish + lint-zero) — the zod unification unblocks any Wave 5 surface that wants to import shared-types schemas directly, but none of the listed Wave 5 items need it.
- Phase 9 candidate: "shared-types / web wire-shape alignment" — touch every flagged drift above in one coherent pass with a coordinated iOS release for any that alter what the backend returns. Not urgent; the adapter layer absorbs the drift today.
