/**
 * PLAN-CC round 8 — the completeness guard for Decision 28 rule 2 on web.
 *
 * Rule 2 says a confirmed correction or an import wins over an open draft, and
 * its condition does NOT depend on the value changing. Web detects that through
 * `noteExternalOcpdWrite`, which every path writing `ocpd_bs_en` must call.
 *
 * "Every path must remember to call this" is precisely the instruction that was
 * forgotten twice on the iOS side of this plan — round 6 found two of five apply
 * paths missing a discard, and round 7 found a third. So this file does not ask
 * anyone to remember: it ENUMERATES the write sites in source and fails when one
 * has no announcement beside it. An empty result is the claim, not a sentence.
 *
 * What it does NOT cover, stated so the green is not over-read — and stated
 * this bluntly because review found the first wording still implied more than
 * the scan does. It matches LITERAL dot-assignments plus one bracket form, in
 * `web/src` only. It therefore misses:
 *   - a write through a computed key (`row[someVar] = …`);
 *   - a write that lands via a spread of an object built elsewhere, which is
 *     the shape several current apply paths use;
 *   - the shared writer in `packages/shared-utils`, outside the scanned tree.
 * Every write path in the code today has an explicit announcement, checked by
 * hand rather than by this scan. What the scan buys is that a NEW literal
 * assignment cannot be added without one — which is the failure mode this plan
 * hit three times, not a proof that no unannounced write can exist.
 * The behavioural half is in `ocpd-draft-interruption.test.tsx`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  _ocpdWriteEpochCount,
  noteExternalOcpdWrite,
  ocpdWriteEpoch,
  purgeOcpdWriteEpochs,
  subscribeToOcpdWrites,
} from '@/lib/ocpd-external-writes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('every web write of ocpd_bs_en announces itself', () => {
  it('has no unannounced assignment', () => {
    // Assignment forms, not reads: `x.ocpd_bs_en =` and `x[field] =` inside an
    // `ocpd_bs_en` branch. The editing control's own commit is excluded — that
    // is the inspector committing, not an external writer, and announcing
    // there would make the control reset its own freshly committed value.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(path.join('components', 'job', 'ocpd-standard-field.tsx'))) continue;
      if (file.endsWith('ocpd-external-writes.ts')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // `updates.ocpd_bs_en = …` in `transcript-field-matcher.ts` is a
        // PROPOSAL accumulator, not a circuit write: the matcher returns
        // candidates and `apply-regex-match.ts` performs the only write, under
        // `c.fieldKey === 'ocpd_bs_en'`, where the announcement lives. Verified
        // rather than assumed — that file's other write branch handles
        // `board_info` / `installation_details` / supply targets, none of which
        // carry this circuit field. If the matcher ever writes a row directly,
        // this exclusion is wrong and the assertion below about its consumer
        // is what should fail first.
        const assigns =
          (/\.ocpd_bs_en\s*=[^=]/.test(line) && !/\bupdates\.ocpd_bs_en\s*=/.test(line)) ||
          (/\[field\]\s*=[^=]/.test(line) &&
            lines
              .slice(Math.max(0, i - 3), i)
              .join('\n')
              .includes("'ocpd_bs_en'"));
        if (!assigns) return;
        // The announcement must be within a few lines above the write.
        const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
        if (!window.includes('noteExternalOcpdWrite')) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  /** The exclusion above is only safe while the regex applier still announces
   *  on the candidate's field key. Pin that, so removing the announcement
   *  fails HERE rather than silently widening the exclusion. */
  it('the regex applier announces on the candidate field key', () => {
    const src = readFileSync(path.join(SRC, 'lib', 'recording', 'apply-regex-match.ts'), 'utf8');
    const at = src.indexOf("c.fieldKey === 'ocpd_bs_en'");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toContain('noteExternalOcpdWrite');
  });

  /** The instrument must be able to fail. A check that cannot fail is worse
   *  than no check, because it is trusted. */
  it('the scan would catch an unannounced write', () => {
    const lines = ['function apply(row) {', "  row.ocpd_bs_en = 'BS EN 60898';", '}'];
    const i = 1;
    const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    expect(/\.ocpd_bs_en\s*=[^=]/.test(lines[i])).toBe(true);
    expect(window.includes('noteExternalOcpdWrite')).toBe(false);
  });
});

describe('the epoch registry', () => {
  it('bumps per circuit and notifies subscribers, even for an identical value', () => {
    purgeOcpdWriteEpochs();
    let notifications = 0;
    const unsubscribe = subscribeToOcpdWrites(() => {
      notifications += 1;
    });

    expect(ocpdWriteEpoch('c1')).toBe(0);
    noteExternalOcpdWrite('c1');
    noteExternalOcpdWrite('c1');
    expect(ocpdWriteEpoch('c1')).toBe(2);
    expect(ocpdWriteEpoch('c2')).toBe(0);
    expect(notifications).toBe(2);

    unsubscribe();
    noteExternalOcpdWrite('c1');
    expect(notifications).toBe(2);
  });

  it('ignores a missing circuit id rather than keying on undefined', () => {
    purgeOcpdWriteEpochs();
    noteExternalOcpdWrite(null);
    noteExternalOcpdWrite(undefined);
    noteExternalOcpdWrite('');
    expect(_ocpdWriteEpochCount()).toBe(0);
  });

  it('purges on sign-out', () => {
    noteExternalOcpdWrite('c1');
    purgeOcpdWriteEpochs();
    expect(_ocpdWriteEpochCount()).toBe(0);
  });
});
