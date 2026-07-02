/**
 * Certificate stylesheet — verbatim port of
 * `CertMateUnified/Sources/PDF/EICRHTMLTemplate.swift` `cssStyles()`
 * (lines 124-274 at port time, 2026-07-02).
 *
 * PARITY RULE: any change to the iOS `cssStyles()` MUST be mirrored here
 * byte-for-byte (ledger row `pdf/pdf-fidelity`). The page boxes
 * (.page 595×842, .page-landscape 842×595) are load-bearing: the capture
 * renderer snapshots each div at exactly these CSS-pixel sizes and maps
 * 1px → 1pt in the PDF, matching `HTMLPDFRenderer.swift:26-27`.
 */
export function cssStyles(): string {
  return `
        @page { size: A4; margin: 0; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Helvetica, Arial, sans-serif; font-size: 7pt; color: #000; }

        .page {
            width: 595px; height: 842px; padding: 10px 18px 18px 18px;
            page-break-after: always; break-after: page;
            position: relative; overflow: hidden;
        }
        .page-landscape {
            width: 842px; height: 595px; padding: 8px 8px 14px 8px;
            page-break-after: always; break-after: page;
            position: relative; overflow: hidden;
        }
        .page:last-child, .page-landscape:last-child {
            page-break-after: avoid; break-after: avoid;
        }

        .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2pt; }
        .header-left { display: flex; align-items: center; gap: 6pt; }
        .header-logo img { max-height: 35pt; max-width: 110pt; }
        .header-title { }
        .header-title .main-title { font-size: 13pt; font-weight: bold; color: #000; line-height: 1.1; }
        .header-title .sub-info { font-size: 6.5pt; color: #333; }
        .header-right { text-align: right; font-size: 6.5pt; color: #333; }
        .header-right .cert-num { font-size: 8pt; font-weight: bold; color: #000; }

        .page-title { font-size: 13pt; font-weight: bold; margin-bottom: 1pt; }
        .page-subtitle { font-size: 6.5pt; color: #333; margin-bottom: 2pt; }

        .red-bar {
            background: #CC0000; color: white; font-weight: bold; font-size: 7.5pt;
            padding: 2pt 5pt; margin-top: 4pt; margin-bottom: 0;
        }
        .red-bar-small {
            background: #CC0000; color: white; font-weight: bold; font-size: 7pt;
            padding: 1.5pt 4pt; margin-top: 3pt; margin-bottom: 0;
        }

        table { width: 100%; border-collapse: collapse; }
        .form-table td {
            border: 0.75pt solid #CCC; padding: 1.5pt 3pt; font-size: 6.5pt;
            vertical-align: middle; min-height: 12pt;
        }
        .form-table .label {
            background: #F0F0F0; font-weight: bold; color: #333; white-space: nowrap;
        }
        .form-table .value { background: #FFFFFF; }
        .form-table .value-alt { background: #FFFEF5; }
        .form-table .value-wide { background: #FFFFFF; min-height: 20pt; }

        .badge {
            display: inline-block; padding: 1.5pt 5pt; border-radius: 10pt;
            color: white; font-weight: bold; font-size: 6.5pt; text-align: center;
            min-width: 20pt;
        }
        .badge-c1 { background: #CC0000; }
        .badge-c2 { background: #FF8C00; }
        .badge-c3 { background: #0066CC; }
        .badge-fi { background: #DAA520; color: #333; }
        .badge-tick { background: #228B22; }
        .badge-na { background: #808080; }
        .badge-lim { background: #6C757D; }
        .badge-nv { background: #9370DB; }

        .obs-table td { border: 0.75pt solid #CCC; padding: 1.5pt 3pt; font-size: 6.5pt; }
        .obs-table th {
            background: #CC0000; color: white; font-size: 6.5pt; font-weight: bold;
            padding: 2pt 3pt; border: 0.75pt solid #CC0000; text-align: left;
        }

        .summary-box {
            border: 2pt solid #CCC; padding: 3pt 5pt; margin-top: 2pt;
            display: flex; align-items: center; gap: 6pt;
        }
        .summary-label { font-size: 7pt; flex: 0 0 150px; }
        .summary-result {
            flex: 1; background: #FFFFFF; border: 0.75pt solid #CCC;
            padding: 4pt; text-align: center; font-size: 10pt; font-weight: bold;
            min-height: 22pt;
        }
        .summary-note { font-size: 6pt; color: #333; flex: 0 0 135px; }

        .inspection-table td { border: 0.75pt solid #CCC; padding: 1.5pt 3pt; font-size: 6.5pt; }
        .inspection-table .section-header {
            background: #E0E0E0; font-weight: bold; font-size: 6.5pt; padding: 1.5pt 3pt;
        }
        .inspection-table .item-ref { width: 40pt; text-align: center; font-weight: bold; }
        .inspection-table .item-outcome { width: 50pt; text-align: center; }

        .circuit-table { font-size: 5px; border-collapse: collapse; table-layout: fixed; width: 100%; }
        .circuit-table th {
            background: #CC0000; color: white; font-size: 4.5px; font-weight: bold;
            padding: 0.5px 0.5px; border: 0.5px solid #B80000; text-align: center;
            white-space: nowrap; writing-mode: vertical-lr; text-orientation: mixed;
            height: 55px; overflow: hidden;
        }
        .circuit-table .group-header {
            background: #B80000; color: white; font-size: 5px; font-weight: bold;
            padding: 1px; text-align: center; border: 0.5px solid #990000;
            writing-mode: horizontal-tb;
        }
        .circuit-table td {
            border: 0.5px solid #CCC; padding: 0.5px 0.5px; font-size: 5px;
            text-align: center; vertical-align: middle;
            white-space: nowrap;
        }
        .circuit-table td:nth-child(2) {
            white-space: normal; word-wrap: break-word; overflow-wrap: break-word;
            text-align: left;
        }
        .circuit-table tr:nth-child(even) td { background: #FAFAFA; }
        .circuit-table tr:nth-child(odd) td { background: #FFFFFF; }
        .circuit-table td:first-child { font-weight: bold; }

        .board-detail-table td {
            border: 0.75pt solid #CCC; padding: 1.5pt 2pt; font-size: 6pt;
        }
        .board-detail-table .label { background: #F0F0F0; font-weight: bold; white-space: nowrap; }
        .board-detail-table .value { background: #FFFFFF; }

        .footer {
            font-size: 5.5pt; color: #666; display: flex; justify-content: space-between;
            border-top: 0.5pt solid #CCC; padding-top: 2pt; margin-top: 4pt;
        }

        .guidance-list { margin: 3pt 0 3pt 10pt; font-size: 6pt; line-height: 1.3; }
        .guidance-list li { margin-bottom: 1pt; }

        .sig-line { border-bottom: 0.75pt solid #000; display: inline-block; min-width: 100pt; height: 12pt; }
        .sig-img { max-height: 24pt; max-width: 100pt; }

        .code-card {
            display: inline-block; border: 0.75pt solid #CCC; border-radius: 3pt;
            padding: 3pt 6pt; text-align: left; vertical-align: top;
            width: 23%; margin-right: 1%;
        }
        .code-card .count { font-size: 8pt; font-weight: bold; }
        .code-card .desc { font-size: 5.5pt; color: #333; }

        .checkbox { display: inline-block; width: 9pt; height: 9pt; border: 0.75pt solid #000;
            text-align: center; font-size: 6pt; line-height: 9pt; margin-right: 3pt; }

        .legend-bar {
            display: flex; gap: 5pt; padding: 3pt 0; font-size: 6pt; align-items: center;
            flex-wrap: wrap; margin-bottom: 1pt;
        }
        .legend-item { display: flex; align-items: center; gap: 2pt; }
        `;
}

/** Shared document skeleton — port of `EICRHTMLTemplate.htmlHead()`. */
export function htmlHead(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=595, initial-scale=1.0">
<style>
${cssStyles()}
</style>
</head>
<body>
`;
}
