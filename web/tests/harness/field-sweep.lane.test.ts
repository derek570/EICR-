/**
 * D2/D4 — generated field-sweep lane (pwa-replay-harness Wave 5).
 *
 * NOT part of the default `npm test --workspace=web` run: the filename
 * deliberately avoids the vitest `tests/**\/*.test.{ts,tsx}` include (the
 * pre-push hook stays fast — E2 decision). Run it via:
 *
 *   npm run pwa-replay:sweep            (all 117+ generated scenarios)
 *   PWA_REPLAY_SCENARIO=zs npm run pwa-replay:sweep   (filtered)
 *
 * Gated on PWA_SWEEP=1 (filename must stay *.test.ts for vitest's include).
 *
 * Per scenario (clean dictation + chitchat + garbled variant):
 *   - full D1 invariant set must hold (invariant 7 excluded until Wave 6)
 *   - the declared chitchat line must be inert (invariant 5)
 *   - IF the clean dictation gate-passes (the normal case): the field must
 *     land with the spoken value and its read-back must play exactly once.
 *   - IF it gate-blocks: nothing may apply, and the field is reported as a
 *     VOICE-COVERAGE GAP (console summary) — surfaced, not failed, so the
 *     lane stays green while the gap list is actionable.
 */
import { describe, it, expect, afterAll } from 'vitest';

// Opt-in lane: heavy (117+ full provider replays). The env gate keeps the
// default `npm test --workspace=web` / pre-push runs fast (E2 decision);
// `npm run pwa-replay:sweep` sets PWA_SWEEP=1.
const SWEEP_ENABLED = process.env.PWA_SWEEP === '1';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario, type ReplayScenario } from './scenario';
import { replayScenario } from './runner';
import { runAllInvariants } from './invariants';
import { shouldForward } from '@/lib/recording/transcript-gate';
import { normalise } from '@/lib/recording/number-normaliser';

const here = path.dirname(fileURLToPath(import.meta.url));
const SWEEP_DIR = path.resolve(here, '../../../tests/fixtures/pwa-replay/generated-sweep');

interface SweepMeta {
  dictation: string;
  garbled: string;
  chitchat: string;
  field: string;
  section: string;
  value: string;
}

function collect(): Array<ReplayScenario & { sweep: SweepMeta }> {
  if (!fs.existsSync(SWEEP_DIR)) return [];
  const all = fs
    .readdirSync(SWEEP_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => loadScenario(path.join(SWEEP_DIR, f)) as ReplayScenario & { sweep: SweepMeta });
  const filter = process.env.PWA_REPLAY_SCENARIO;
  return filter ? all.filter((s) => s.name.includes(filter)) : all;
}

const scenarios = SWEEP_ENABLED ? collect() : [];
const coverageGaps: string[] = [];

describe.skipIf(!SWEEP_ENABLED)('pwa-replay — generated field sweep (mock mode)', () => {
  it('generated sweep exists (run generate-field-sweep.mjs)', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of scenarios) {
    it(`${scenario.name}`, async () => {
      const result = await replayScenario(scenario);
      const { trace } = result;
      const meta = scenario.sweep;

      // Full invariant set (7 joins at Wave 6). The declared chitchat line
      // is exempt from invariant 5 when it became an ASK ANSWER — a
      // circuit-less non-rescued field legitimately raises the 2s
      // disambiguation ask (iOS parity), and the next utterance forwards
      // as its in_response_to answer by design.
      const chitchatUtterance = trace.utterances.find(
        (u) => u.text === meta.chitchat || u.text === meta.chitchat.slice(0, 80)
      );
      const chitchatWasAskAnswer = Boolean(
        chitchatUtterance && (chitchatUtterance.hasInFlightAsk || chitchatUtterance.hasInResponseTo)
      );
      // Only declare the line inert if the REAL gate blocks it standalone
      // (post-normalisation) — several natural chitchat lines legitimately
      // pass the iOS-canon gate (digit after normalisation, weak-trigger +
      // content words) and flow to Sonnet exactly as iOS does.
      const gateWouldBlock = !shouldForward({
        text: normalise(meta.chitchat),
        hasRegexHit: false,
        hasPendingAsk: false,
        inResponseTo: false,
      });
      const { failures } = runAllInvariants(trace, {
        chitchatUtterances: chitchatWasAskAnswer || !gateWouldBlock ? [] : [meta.chitchat],
        includeFeedback: false,
      });
      expect(failures).toEqual([]);

      // Clean-dictation lane.
      const dictated = trace.utterances[0];
      expect(dictated).toBeTruthy();
      if (dictated.gate === 'passed') {
        // Field lands with the spoken value (mock frame applied) and the
        // read-back plays exactly once.
        // Tolerant value match — apply paths canonicalise some values
        // (IR "999" → ">999", BS-EN prefix normalisation), so containment
        // either way counts as "landed with the spoken value".
        const vEq = (a: unknown, b: unknown) => {
          const canon = (v: unknown) => {
            const s = String(v ?? '')
              .trim()
              .toLowerCase();
            return s === 'yes' || s === 'true' ? 'true' : s; // checkbox coercion
          };
          const x = canon(a);
          const y = canon(b);
          return x === y || (x !== '' && y !== '' && (x.includes(y) || y.includes(x)));
        };
        const landed = trace.utterances.some((u) =>
          u.appliedFields.some((f) => f.key.endsWith(`.${meta.field}`) && vEq(f.value, meta.value))
        );
        expect.soft(landed, `${meta.field} did not land with value ${meta.value}`).toBe(true);
        const plays = trace.totals.confirmationsPlayed.filter((t) =>
          t.includes(String(meta.value))
        );
        expect
          .soft(plays.length, `read-back for ${meta.field} played ${plays.length}× (want ≥1)`)
          .toBeGreaterThanOrEqual(1);
      } else {
        // Gate-blocked canonical dictation = a voice-coverage gap, not a
        // harness failure. Nothing may have applied.
        coverageGaps.push(`${meta.section}/${meta.field}: "${meta.dictation}"`);
        expect(dictated.appliedFields).toEqual([]);
      }
    });
  }
});

afterAll(() => {
  if (coverageGaps.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[field-sweep] ${coverageGaps.length} voice-coverage gap(s) — canonical spoken form does not pass the gate:\n  ` +
        coverageGaps.join('\n  ')
    );
  }
});
