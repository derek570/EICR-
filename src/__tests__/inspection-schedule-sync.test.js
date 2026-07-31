/**
 * BS 7671 Schedule of Inspections — iOS ↔ server sync check.
 *
 * The 99-item schedule lives in two places that drift independently:
 *   - iOS:    `Sources/PDF/EICRHTMLTemplate.swift` — InspectionItem2(ref:, ...)
 *             entries used to render the EICR PDF. The canonical inspector-
 *             facing source.
 *   - Server: `config/prompts/schedule-of-inspection-bs7671-eicr.md` —
 *             appended to the Stage 6 system prompt + the BPG4 refinement
 *             prompt as the ref list Sonnet picks `schedule_item` from.
 *
 * If the two diverge, Sonnet may pick a ref that no longer matches what
 * shows on the certificate — the user-visible bug class is "iOS auto-tick
 * silently fails because the ref Sonnet wrote no longer exists in the
 * Swift schedule".
 *
 * Implementation: parse both files for the ITEM-level refs (skipping
 * section headers on both sides) and assert the lists match. The iOS
 * repo lives at `../CertMateUnified` from the backend repo root; the
 * test skips cleanly when the iOS repo isn't present (CI environments
 * that only clone the backend), and runs the assertion locally where
 * maintainers have both repos checked out — which is the realistic
 * point-of-edit catch.
 */

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_SCHEDULE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'config',
  'prompts',
  'schedule-of-inspection-bs7671-eicr.md'
);

// iOS repo lives at backend-root/CertMateUnified (sibling-via-nesting,
// distinct git remotes). The Swift file is the canonical source for the
// PDF rendering — the inspector sees these refs on the certificate.
const IOS_SCHEDULE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'CertMateUnified',
  'Sources',
  'PDF',
  'EICRHTMLTemplate.swift'
);
const PYTHON_PDF_PATH = path.join(__dirname, '..', '..', 'python', 'eicr_pdf_generator.py');
const PYTHON_EDITOR_PATH = path.join(__dirname, '..', '..', 'python', 'eicr_editor.py');
const AFDD_ROW_TEXT = 'AFDD fitted where required (421.1.7)?';
// PLAN-3 2026-07-31: the reviewed iOS 5.22 source is deliberately held for
// PLAN-4's coordinated TestFlight build. Backend CI has no nested iOS clone,
// but a maintainer's dual-repo checkout must remain pushable during this
// sanctioned source-drift window. Remove 5.22 when PLAN-4 lands the held iOS
// branch; the dedicated PLAN-3 tests still pin all seven reviewed copies.
const HELD_IOS_PENDING_REFS = new Set(['5.22']);

/**
 * Extract the ITEM refs from the iOS Swift source. Each
 * `InspectionItem2(ref: "X.Y", ...)` is on a single line in the source
 * (the multi-line descriptions use `\n` escape sequences inside string
 * literals, not real newlines). Skips header rows (`isHeader: true`)
 * because those carry section names ("4. Consumer unit(s)...") rather
 * than picking targets for `schedule_item`.
 */
function parseSwiftItemRefs(src) {
  const refs = [];
  for (const line of src.split('\n')) {
    const refMatch = line.match(/InspectionItem2\(ref:\s*"([\d.]+)"/);
    if (!refMatch) continue;
    // Header rows have isHeader: true. Item rows have isHeader: false.
    // We only care about the latter.
    if (!line.includes('isHeader: false')) continue;
    refs.push(refMatch[1]);
  }
  return refs;
}

/**
 * Extract the ITEM refs from the server markdown. The schedule is a
 * markdown bullet list under `## Section N` headers; only `- X.Y —` lines
 * are item refs. Section headers (`## Section 4 — ...`) and free-text
 * notes are excluded by anchoring the regex on `^- ` followed by digits.
 */
function parseMarkdownItemRefs(src) {
  const refs = [];
  // U+2014 EM DASH is what the markdown uses; require it explicitly so
  // a contributor accidentally typing a hyphen-minus would be flagged.
  const re = /^- (\d[\d.]*) — /;
  for (const line of src.split('\n')) {
    const m = line.match(re);
    if (m) refs.push(m[1]);
  }
  return refs;
}

function computeScheduleRefDrift(swiftRefs, mdRefs) {
  const swiftSet = new Set(swiftRefs);
  const mdSet = new Set(mdRefs);
  return {
    onlyInSwift: swiftRefs.filter((r) => !mdSet.has(r)).sort(),
    onlyInMarkdown: mdRefs
      .filter((r) => !swiftSet.has(r) && !HELD_IOS_PENDING_REFS.has(r))
      .sort(),
  };
}

describe('BS 7671 Schedule of Inspections — iOS ↔ server sync', () => {
  const iosPresent = fssync.existsSync(IOS_SCHEDULE_PATH);

  if (!iosPresent) {
    test.skip(`iOS schedule not present at ${IOS_SCHEDULE_PATH} — sync check skipped (typical for backend-only CI environments)`, () => {});
    return;
  }

  test('item refs match between iOS Swift and server markdown', () => {
    const swiftSrc = fssync.readFileSync(IOS_SCHEDULE_PATH, 'utf8');
    const mdSrc = fssync.readFileSync(SERVER_SCHEDULE_PATH, 'utf8');

    const swiftRefs = parseSwiftItemRefs(swiftSrc);
    const mdRefs = parseMarkdownItemRefs(mdSrc);

    // Sanity: both files should have produced ≥80 refs. If either parser
    // returns 0 it means the file shape changed (e.g. someone replaced
    // InspectionItem2 with a new struct, or the markdown reformat
    // dropped the bullets). Catch that as a parse failure rather than a
    // misleading empty diff.
    expect(swiftRefs.length).toBeGreaterThan(80);
    expect(mdRefs.length).toBeGreaterThan(80);

    // Wrap the diff in a single object so a Jest failure shows BOTH
    // sides at once — easier triage than two separate expectations.
    expect(computeScheduleRefDrift(swiftRefs, mdRefs)).toEqual({
      onlyInSwift: [],
      onlyInMarkdown: [],
    });
  });

  test('item refs are unique within each source (no duplicate refs)', () => {
    const swiftSrc = fssync.readFileSync(IOS_SCHEDULE_PATH, 'utf8');
    const mdSrc = fssync.readFileSync(SERVER_SCHEDULE_PATH, 'utf8');

    const swiftRefs = parseSwiftItemRefs(swiftSrc);
    const mdRefs = parseMarkdownItemRefs(mdSrc);

    const swiftDupes = swiftRefs.filter((r, i, a) => a.indexOf(r) !== i);
    const mdDupes = mdRefs.filter((r, i, a) => a.indexOf(r) !== i);

    expect({ swiftDupes, mdDupes }).toEqual({ swiftDupes: [], mdDupes: [] });
  });
});

describe('PLAN-3 — AFDD Section-5 row on server/Python legal-document surfaces', () => {
  test('held iOS drift allowance is exactly 5.22 and does not hide another missing ref', () => {
    expect(computeScheduleRefDrift(['5.21'], ['5.21', '5.22'])).toEqual({
      onlyInSwift: [],
      onlyInMarkdown: [],
    });
    expect(computeScheduleRefDrift(['5.21'], ['5.21', '5.22', '5.23'])).toEqual({
      onlyInSwift: [],
      onlyInMarkdown: ['5.23'],
    });
  });

  test('5.22 is appended after 5.21 in the server prompt and before Section 6', () => {
    const src = fssync.readFileSync(SERVER_SCHEDULE_PATH, 'utf8');
    const row = `- 5.22 — ${AFDD_ROW_TEXT}`;
    expect(src.split(row)).toHaveLength(2);
    expect(src.indexOf('- 5.21 —')).toBeLessThan(src.indexOf(row));
    expect(src.indexOf(row)).toBeLessThan(src.indexOf('## Section 6'));
    expect(src).not.toMatch(/^- 5\.23 —/m);
  });

  test('Python fallback PDF renders 5.22 as an ordinary schedule item, not a header', () => {
    const src = fssync.readFileSync(PYTHON_PDF_PATH, 'utf8');
    const row = `("5.22", "${AFDD_ROW_TEXT}", False)`;
    expect(src).toContain(row);
    expect(src.indexOf('("5.21"')).toBeLessThan(src.indexOf(row));
    expect(src.indexOf(row)).toBeLessThan(src.indexOf('# Section 6:'));
    // The renderer iterates this exact list, so presence here is the render
    // contract rather than a disconnected documentation constant.
    expect(src).toMatch(
      /for idx, \(item_no, description, is_section_header\) in enumerate\(INSPECTION_SCHEDULE_ITEMS\)/
    );
  });

  test('Streamlit editor carries 5.22 in BOTH schedule maps', () => {
    const src = fssync.readFileSync(PYTHON_EDITOR_PATH, 'utf8');
    const occurrences = src.match(/"5\.22": "AFDD fitted where required \(421\.1\.7\)\?"/g) ?? [];
    expect(occurrences).toHaveLength(2);
    expect(src).toMatch(
      /SCHEDULE_ITEMS = \{[\s\S]*"5\.22": "AFDD fitted where required \(421\.1\.7\)\?"/
    );
    expect(src).toMatch(
      /ALL_SCHEDULE_ITEMS = \{[\s\S]*"5\. Final circuits": \{[\s\S]*"5\.22": "AFDD fitted where required \(421\.1\.7\)\?"/
    );
  });
});
