#!/usr/bin/env node
/**
 * Hub CLAUDE.md size guard.
 *
 * WHAT: fails CI when the hub CLAUDE.md exceeds its stated budget — total
 * size, changelog row count, or per-row length.
 *
 * WHY: CLAUDE.md is auto-loaded into EVERY session, EVERY subagent, EVERY
 * /rp reviewer and EVERY /ep execution. Its cost is paid per-context, not
 * per-read, so growth is invisible at the point it happens and compounds
 * silently across a wave. Between 2026-07-17 and 2026-08-04 the changelog
 * table grew to 122 rows / ~158,000 chars — single rows reached 11,031
 * characters — and the whole file cost ~45,000 tokens on every boot,
 * despite its own MANDATORY block declaring it an "index only" and the
 * changelog header declaring "one line each". Nothing enforced either
 * claim, so nothing stopped it. This script is that enforcement.
 *
 * The fix when this fails is never "raise the limit". It is: move the
 * detail into docs/reference/changelog.md (which has no budget and is
 * loaded on demand) and leave a genuine one-line summary here.
 *
 * HARD FAIL by design, unlike the warn-only parity-ledger check. The
 * failure is mechanical and unambiguous, the remedy is trivial, and a
 * warning is exactly what failed to hold the line last time. Emergency
 * bypass: put [skip-hub-size] in the commit message (mirrors
 * scripts/check-task-def-env-drift.sh) — then fix it properly in the
 * follow-up commit.
 *
 * Usage:
 *   node scripts/check-hub-size.mjs [--file CLAUDE.md]
 */
import { readFileSync } from 'node:fs';

// Budgets. Headroom over the 2026-08-05 post-trim baseline (38,238 chars /
// 31 rows / 1,383 max row) is deliberately modest: enough that a normal
// wave's entries land without ceremony, tight enough that a 10k-char row
// or a 90-row backlog trips immediately rather than after a month.
const MAX_TOTAL_CHARS = 45000;
const MAX_ROWS = 35;
const MAX_ROW_CHARS = 1600;

const argv = process.argv.slice(2);
const fileIdx = argv.indexOf('--file');
const file = fileIdx !== -1 ? argv[fileIdx + 1] : 'CLAUDE.md';

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (err) {
  console.error(`check-hub-size: cannot read ${file}: ${err.message}`);
  process.exit(1);
}

const ROW_RE = /^\| 20\d\d-\d\d-\d\d \|/;
const rows = text.split('\n').filter((l) => ROW_RE.test(l));
const failures = [];

if (text.length > MAX_TOTAL_CHARS) {
  failures.push(
    `${file} is ${text.length} chars, over the ${MAX_TOTAL_CHARS} budget ` +
      `(+${text.length - MAX_TOTAL_CHARS}). This file is loaded into every ` +
      `session and subagent — move detail to docs/reference/changelog.md.`,
  );
}

if (rows.length > MAX_ROWS) {
  failures.push(
    `Changelog table has ${rows.length} rows, over the ${MAX_ROWS} limit. ` +
      `Migrate the oldest rows into docs/reference/changelog.md (keep them ` +
      `newest-first there) and delete them here — the pointer below the ` +
      `table already tells readers where to look.`,
  );
}

const longRows = rows.filter((r) => r.length > MAX_ROW_CHARS);
if (longRows.length > 0) {
  failures.push(
    `${longRows.length} changelog row(s) exceed ${MAX_ROW_CHARS} chars — the ` +
      `hub is an INDEX, one line each. Put the detail in ` +
      `docs/reference/changelog.md and leave a one-line summary + a ` +
      `"Full detail" link:\n` +
      longRows
        .map((r) => `    ${r.slice(2, 12)}  ${r.length} chars  ${r.slice(14, 90)}…`)
        .join('\n'),
  );
}

if (failures.length > 0) {
  console.error(`\ncheck-hub-size: FAILED (${failures.length} issue(s))\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  console.error(
    `  Budgets: ${MAX_TOTAL_CHARS} chars total, ${MAX_ROWS} rows, ` +
      `${MAX_ROW_CHARS} chars/row.\n` +
      `  Raising a budget is not the fix — see the header comment in this file.\n` +
      `  Emergency bypass only: [skip-hub-size] in the commit message.\n`,
  );
  process.exit(1);
}

console.log(
  `check-hub-size: OK — ${file} ${text.length}/${MAX_TOTAL_CHARS} chars, ` +
    `${rows.length}/${MAX_ROWS} rows, longest row ` +
    `${rows.length ? Math.max(...rows.map((r) => r.length)) : 0}/${MAX_ROW_CHARS} chars.`,
);
