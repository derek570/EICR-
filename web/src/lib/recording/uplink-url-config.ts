/**
 * PLAN-E1 E0 test seam — `resolveUplinkURLConfig(model, latchedCodec,
 * keywords)`. A PURE function returning the full URL + the resolved
 * SENDER codec + an EXPLICIT keepalive policy, so production and the
 * {flux, nova3} × {linear16, opus} test matrix exercise the SAME code
 * path (`buildURL()` below is a thin wrapper passing `this.sttModel`
 * through it).
 *
 * Safety invariant regardless of the probe outcome: when the effective
 * STT model is nova-3, the sender is FORCED to linear16 (URL never
 * declares opus; the linear16 keepalive silence stays valid) whatever the
 * key-response `uplink_codec` says — a lone model rollback can never
 * break STT.
 *
 * Keyterm-budget invariance (Test 3b, split-round-2 IMPORTANT): the
 * appended keyterm list must be IDENTICAL across every codec route a
 * given model supports, so the budget is computed from the MAXIMUM
 * complete base-URL length across every codec this model supports —
 * never from the specific encoding being used this connection, which
 * would let two arms of an A/B ship different keyterm sets and confound
 * the accuracy measurement.
 */

import {
  appendKeytermsToUrl,
  appendFluxKeytermsToUrl,
  generateKeyterms as generateNova3Keyterms,
  generateFluxKeyterms,
  type CcuAnalysisLite,
} from './keyword-boosts';
import type { SttModel } from './deepgram-service';

export type UplinkCodec = 'linear16' | 'opus';

/** Every codec route ANY supported model can select. Used to compute the
 *  codec-independent keyterm budget — extend this list, not a per-call
 *  computation, when a new codec/container is added. */
const ALL_SUPPORTED_CODECS: readonly UplinkCodec[] = ['linear16', 'opus'];

export type UplinkKeepalivePolicy = 'nova3-silence-linear16' | 'disabled';

export interface UplinkURLConfig {
  readonly url: string;
  readonly resolvedSenderCodec: UplinkCodec;
  readonly keepalivePolicy: UplinkKeepalivePolicy;
}

function baseParams(model: SttModel, encoding: UplinkCodec): URLSearchParams {
  if (model === 'flux') {
    return new URLSearchParams({
      model: 'flux-general-en',
      encoding,
      sample_rate: '16000',
      eot_threshold: '0.7',
      eot_timeout_ms: '5000',
      mip_opt_out: 'true',
    });
  }
  return new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    numerals: 'true',
    encoding,
    sample_rate: '16000',
    channels: '1',
    language: 'en-GB',
    interim_results: 'true',
    endpointing: '400',
    utterance_end_ms: '1000',
    vad_events: 'true',
    mip_opt_out: 'true',
  });
}

function wsBaseUrl(model: SttModel): string {
  return model === 'flux' ? 'wss://api.deepgram.com/v2/listen' : 'wss://api.deepgram.com/v1/listen';
}

/** The keyterm-truncation budget for THIS model — the max complete
 *  base-URL length across every codec route this model supports, so
 *  every codec admits an identical keyterm list. */
function codecIndependentBaseLength(model: SttModel): number {
  const base = wsBaseUrl(model);
  let max = 0;
  for (const codec of ALL_SUPPORTED_CODECS) {
    const len = base.length + '?'.length + baseParams(model, codec).toString().length;
    if (len > max) max = len;
  }
  return max;
}

export function resolveUplinkURLConfig(params: {
  model: SttModel;
  latchedCodec: UplinkCodec | null;
  ccuAnalysis: CcuAnalysisLite | null;
}): UplinkURLConfig {
  const { model, latchedCodec, ccuAnalysis } = params;

  // Safety invariant: nova-3 ALWAYS forces linear16, regardless of the
  // latched codec — a model rollback can never accidentally ship opus to
  // a listener that wasn't part of the A/B.
  //
  // Codex diff-review r2 BLOCKER fix (mirrored on iOS) — an unrecognised
  // latched value (never actually reachable from the real backend, which
  // already normalises server-side in `resolveUplinkCodec()`, but a
  // defensive fail-safe against a version-skew/malformed-response edge
  // case) must fall back to `linear16` explicitly rather than being
  // passed through: `dispatchFrame`'s `else` branch treats anything that
  // isn't literally `'linear16'` as the Opus path, and the encoder is
  // only constructed when this value is literally `'opus'` — an
  // unrecognised third value would reach a null `opusEncoder`, silently
  // dropping every sample.
  const latched = model === 'flux' ? (latchedCodec ?? 'linear16') : 'linear16';
  const resolvedSenderCodec: UplinkCodec = latched === 'opus' ? 'opus' : 'linear16';

  const searchParams = baseParams(model, resolvedSenderCodec);
  const budget = codecIndependentBaseLength(model);

  if (model === 'flux') {
    appendFluxKeytermsToUrl(searchParams, generateFluxKeyterms(ccuAnalysis), budget);
  } else {
    appendKeytermsToUrl(searchParams, generateNova3Keyterms(ccuAnalysis), budget);
  }

  const url = `${wsBaseUrl(model)}?${searchParams.toString()}`;
  const keepalivePolicy: UplinkKeepalivePolicy =
    model === 'nova3' ? 'nova3-silence-linear16' : 'disabled';

  return { url, resolvedSenderCodec, keepalivePolicy };
}
