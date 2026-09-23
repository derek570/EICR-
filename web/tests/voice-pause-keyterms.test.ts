/**
 * PLAN-D D1 recognition aid — Acceptance 10 (web) and 13.
 *
 * The voice-pause grammar REQUIRES the brand word, so every accepted brand
 * spelling must reach the FINAL admitted Deepgram URL on both web keyterm
 * lists: the Flux curated list (the live model) and the nova-3
 * `BASE_KEYWORD_BOOSTS` map (in use whenever the DEEPGRAM_STT_MODEL
 * kill-switch falls back). Asserted on the URL the production builder
 * emits, within the existing caps, with and without heavy CCU augmentation.
 */
import { describe, it, expect } from 'vitest';
import { resolveUplinkURLConfig } from '@/lib/recording/uplink-url-config';
import { KEYTERM_INTERNALS } from '@/lib/recording/keyword-boosts';

const BRAND_FORMS = ['CertMate', 'Cert Mate', 'sert mate', 'cert-mate'];

const heavyAnalysis = {
  board_manufacturer: 'Acme',
  board_model: 'X1',
  circuits: Array.from({ length: 80 }, (_, i) => ({
    circuit_number: i + 1,
    label: `Room ${i} sockets and lighting spur`,
    ocpd_type: 'mcb',
    rcd_rating_ma: `${i}`,
  })),
};

function admittedKeyterms(model: 'flux' | 'nova3', analysis: unknown): string[] {
  const { url } = resolveUplinkURLConfig({
    model,
    latchedCodec: null,
    ccuAnalysis: analysis as Parameters<typeof resolveUplinkURLConfig>[0]['ccuAnalysis'],
  });
  const params = new URL(url).searchParams;
  return params.getAll('keyterm').map((v) => v.replace(/:\d+\.\d$/, ''));
}

describe('PLAN-D — the brand word reaches the admitted Deepgram URL', () => {
  for (const model of ['flux', 'nova3'] as const) {
    for (const [label, analysis] of [
      ['no CCU', null],
      ['heavy CCU augmentation', heavyAnalysis],
    ] as const) {
      it(`${model}, ${label}: all four brand forms admitted within the caps`, () => {
        const terms = admittedKeyterms(model, analysis);
        const lc = terms.map((t) => t.toLowerCase());
        for (const form of BRAND_FORMS) {
          expect(lc, `${form} missing on ${model}`).toContain(form.toLowerCase());
        }
        const { url } = resolveUplinkURLConfig({
          model,
          latchedCodec: null,
          ccuAnalysis: analysis as Parameters<typeof resolveUplinkURLConfig>[0]['ccuAnalysis'],
        });
        if (model === 'flux') {
          expect(terms.length).toBeLessThanOrEqual(KEYTERM_INTERNALS.FLUX_MAX_KEYTERMS);
          expect(url.length).toBeLessThanOrEqual(KEYTERM_INTERNALS.FLUX_URL_LENGTH_BUDGET);
        } else {
          expect(terms.length).toBeLessThanOrEqual(KEYTERM_INTERNALS.MAX_KEYTERMS);
          expect(url.length).toBeLessThanOrEqual(KEYTERM_INTERNALS.URL_LENGTH_BUDGET);
        }
      });
    }
  }

  it('adds the brand forms once each: two new nova-3 keys, four Flux entries', () => {
    const base = Object.keys(KEYTERM_INTERNALS.BASE_KEYWORD_BOOSTS);
    for (const form of BRAND_FORMS) {
      const keys = base.filter((k) => k.toLowerCase() === form.toLowerCase());
      expect(keys).toHaveLength(1);
      expect(KEYTERM_INTERNALS.BASE_KEYWORD_BOOSTS[keys[0]]).toBe(3.0);
    }
    const flux = KEYTERM_INTERNALS.FLUX_CURATED_KEYTERMS_PROVISIONAL;
    for (const form of BRAND_FORMS) expect(flux).toContain(form);
    expect(flux).toHaveLength(47);
  });
});
