# WS9 — PDF fidelity acceptance diff (2026-07-02)

Page-by-page comparison of the **web client renderer** (ported iOS
template + foreignObject capture + pdf-lib, `web/src/lib/pdf/`) against
the **iOS canon** (`EICRHTMLTemplate.swift` → WKWebView `createPDF()`),
both rendering the SAME seeded parity fixture jobs. This is the WS9
plan's acceptance evidence; the ledger row `pdf/pdf-fidelity` stays
`partial` until FIELD validation accepts the client renderer (then the
server generate-pdf button flips behind the debug page — parent
program §6.5).

## Inputs

| Artefact | Where |
|---|---|
| Fixture jobs (raw production GET bodies) | `~/.claude/handoffs/EICR_Automation--parity-ws9-pdf-parity-2026-07-02/ios-reference/{eicr,eic}-job.json` — EICR `job_1782978942222`, EIC `job_1782978943693` (parity-test account) |
| iOS reference PDFs | same folder, `ios-reference-{eicr,eic}.pdf` — rendered on the iPhone 17 Pro simulator through the real `EICRHTMLTemplate.build` + `HTMLPDFRenderer.render` (WKWebView), company/inspectors nil (the parity account has no company settings and both jobs carry nil staff ids) |
| Web PDFs | same folder, `web-{eicr,eic}.pdf` — produced by `web/tests-e2e/ws9-acceptance-render.spec.ts` (WebKit project), same nil company/inspector inputs |
| Page rasters (100 dpi) + band crops (300 dpi) | same folder, `diff/` |

Re-run any time:

```
WS9_FIXTURE_DIR=~/.claude/handoffs/EICR_Automation--parity-ws9-pdf-parity-2026-07-02/ios-reference \
  npx playwright test tests-e2e/ws9-acceptance-render.spec.ts --project=webkit
```

## Geometry gate (automated, in the spec)

- EICR: **9/9 pages**, EIC: **5/5 pages** — counts equal.
- Every page box equal: 595×842 pt portrait / 842×595 pt landscape.
- Page order equal (portrait set, then landscape circuit pages).

## Page-by-page visual verdicts (executor eyeball, 100 dpi + 300 dpi crops)

| Pages | Content | Verdict |
|---|---|---|
| EICR 1 / web 1 | Title, client, reason, installation, extent/limitations, summary, recommendations | MATCH — same face, sizes, red bars, values (`02 Jul 2026`, `5 years…`, `Next inspection due by: 02/07/2031`, cert `EICR-JOB_1782`, `Page 1 of 8`) |
| EICR 2 | Observations page (0 observations, code cards `0 items`) | MATCH |
| EICR 3 | General condition, declaration, contractor, signatures, supply, particulars, bonding | MATCH — every table/checkbox/unit annotation/N-A cell |
| EICR 4–7 | Inspection schedule chunks (28/pg) | MATCH — same items per page, same auto-controls (2.0 N/A microgeneration, 3.2 N/A TT, 4.11/4.21/4.22 N/A), same badges |
| EICR 8 | Guidance page | MATCH |
| EICR 9 (landscape) | Board details + empty circuit table (`No circuits recorded.`) + testing info | MATCH — incl. the iOS `Page 8 of 8` totalPages-estimate quirk reproduced verbatim |
| EIC 1 | Title, client, description/extent, design & construction, 3-role signatures, next inspection | MATCH |
| EIC 2 | Particulars of signatories, supply, particulars, bonding | MATCH |
| EIC 3 | Schedule of inspections (14 items, all ticks — fixture stores outcomes under a non-canon key both platforms ignore) | MATCH |
| EIC 4 | Guidance | MATCH |
| EIC 5 (landscape) | DB-1 board details + 3 circuit rows | MATCH — all readings, `PASS`/`LIM`/`22`/`N/A` cells identical |

## Fixes the diff caught (shipped in this PR)

1. **Serif fallback** — the template's `body { font-family … }` rule
   matched nothing inside the foreignObject wrapper div; every page
   rasterised in the engine default serif. Fix: capture copies the
   body's computed typography onto the wrapper (`render/capture.ts`).
2. **Group-header band white-out** — the circuit-table striping rule
   out-specifies `.circuit-table .group-header`, leaving a white band
   with invisible white labels where iOS paints red. Fix: web-only
   higher-specificity re-assertion appended after the byte-identical
   iOS CSS block (`template/css.ts`, dated comment).

## Accepted rasterisation-level differences (not layout bugs)

- **Raster vs vector text**: web pages are 3× (~267 dpi) rasters —
  crisp in print but text is not selectable; iOS output is vector.
  Documented Step 0 trade-off (`render/capture.ts` header).
- **Sub-line word-wrap** in two long paragraphs (page-1
  recommendations + note): line breaks fall one word earlier/later from
  engine text-metric differences. Same box sizes, same content.
- Group labels (CONDUCTORS etc.) are *more* legible on the web render
  at equal zoom; same 5px type, different hinting.

## Fixture-data bugs found (NOT fixed — job data is read-only)

- EICR fixture `installation_details.next_inspection_years: ""`
  (string) — **iOS cannot decode this job at all** (strict Int decode
  throws, job detail unopenable). Reference production and the web
  decoder coerce `''`→unset / numeric-string→number (documented in
  `template/decode.ts`).
- Both fixtures carry several non-canon keys (`premises_type`,
  `system_type`, `outcomes`, `extent_of_installation`…) that BOTH
  platforms ignore — those fields render blank on both, so the diff
  stays valid, but the seeds don't exercise every populated field.
  Field validation should use a real job.
