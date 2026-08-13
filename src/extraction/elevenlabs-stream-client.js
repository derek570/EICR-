/**
 * ElevenLabsStreamClient — production streaming-TTS client.
 *
 * Stage 2 commit 2.4 per PLAN_v3 §5.2 + PLAN_v3 §1.14 (PCM-default).
 *
 * Wraps the ElevenLabs `stream-input` WS for a single synth, OR the
 * `multi-stream-input` WS for the pooled multi-context use case (when
 * VOICE_LATENCY_USE_MULTI_CONTEXT=true AND Stage 0.F passed). Pipes the
 * vendor's base64-encoded PCM frames out via the provided `onAudio`
 * callback so the calling route can stream the bytes directly into the
 * client's chunked HTTP response.
 *
 * Public API:
 *   const client = new ElevenLabsStreamClient({ apiKey, voiceId, modelId,
 *     outputFormat, voiceSettings, contextId? });
 *   await client.synth(text, { onAudio, onError, signal? });
 *   client.close();
 *
 *   ElevenLabsStreamClient.fromConfig({ env: process.env })
 *     — convenience factory that reads the locked decisions from env.
 *
 * Wire shape (PLAN_v3 §3.F — verified empirically in
 * scripts/voice-latency-bench/elevenlabs-multi-context-bench.mjs):
 *   client → server (single-shot stream-input):
 *     BOS:     { text: " ", voice_settings }
 *     text:    { text, try_trigger_generation: true }
 *     EOS:     { text: "" }
 *   server → client:
 *     audio:   { audio: <b64>, normalizedAlignment? }
 *     final:   { isFinal: true }
 *     error:   { error: <string> }
 *
 *   multi-stream-input variant uses context_id everywhere and emits
 *   `contextId` (camelCase) on server frames.
 *
 * Does NOT manage suppression, in-flight dedupe, or the cost-tracker —
 * those are the route handler's job (keys.js for confirmations,
 * voice-latency.js for fast-path in Stage 4). This module only owns
 * the WS lifecycle and the audio-byte pipeline.
 */

import WebSocket from 'ws';
import logger from '../logger.js';

const DEFAULT_VOICE_ID = 'Fahco4VZzobUeiPqni1S'; // Archer Conversational — PLAN_v2 1.4
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const DEFAULT_OUTPUT_FORMAT = 'pcm_22050'; // PLAN_v3 1.14
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.3,
  use_speaker_boost: true,
  speed: 1.0,
};

// Wall-clock ceiling per synth. ElevenLabs documents an idle-timeout
// query param (default 20s) but a hung WS could still sit there forever
// without ever emitting audio. The hard cap protects the request path.
const DEFAULT_SYNTH_TIMEOUT_MS = 25000;

// D1 (feedback id 121) — eleven_flash_v2_5 auto-detects language from text
// with no pin, and a short telegraphic confirmation ("Garage, circuit 3, 1
// points") is composed entirely of valid French words, so detection can
// flip. Pinned to English by default on every production caller.
const DEFAULT_LANGUAGE_CODE = 'en';

/** Returns the content-type header value for a given ElevenLabs output_format. */
export function contentTypeForFormat(outputFormat) {
  if (typeof outputFormat !== 'string') return 'application/octet-stream';
  if (outputFormat.startsWith('pcm_')) {
    const rate = outputFormat.slice(4);
    return `audio/L16; rate=${rate}; channels=1`;
  }
  if (outputFormat.startsWith('mp3_')) return 'audio/mpeg';
  if (outputFormat.startsWith('ulaw_')) return 'audio/basic';
  return 'application/octet-stream';
}

export class ElevenLabsStreamClient {
  /**
   * @param {{
   *   apiKey: string,
   *   voiceId?: string,
   *   modelId?: string,
   *   outputFormat?: string,
   *   voiceSettings?: object,
   *   timeoutMs?: number,
   *   multiContext?: boolean,
   *   languageCode?: string|null,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.apiKey) throw new Error('ElevenLabsStreamClient: apiKey required');
    this.apiKey = opts.apiKey;
    this.voiceId = opts.voiceId ?? DEFAULT_VOICE_ID;
    this.modelId = opts.modelId ?? DEFAULT_MODEL_ID;
    this.outputFormat = opts.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
    this.voiceSettings = opts.voiceSettings ?? DEFAULT_VOICE_SETTINGS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_SYNTH_TIMEOUT_MS;
    this.multiContext = opts.multiContext === true;
    // D1 fail-open contract: `??` cannot distinguish "omitted" from an
    // explicit `null` disable sentinel (both are nullish), so an omitted
    // option must resolve to the 'en' default while an explicit `null`
    // (the compatibility-retry's suppression signal) must NOT be coerced
    // back to 'en' — else the retry would silently resend the rejected URL.
    this.languageCode = opts.languageCode === undefined ? DEFAULT_LANGUAGE_CODE : opts.languageCode;
    this.ws = null;
    this._closed = false;
  }

  /**
   * Convenience factory that picks up the locked-decision config from
   * env vars + the AWS-Secrets-fetched API key (looked up by the caller
   * and passed in).
   */
  static fromConfig({ apiKey, env = process.env }) {
    return new ElevenLabsStreamClient({
      apiKey,
      multiContext: env.VOICE_LATENCY_USE_MULTI_CONTEXT === 'true',
    });
  }

  _buildUrl() {
    const path = this.multiContext ? 'multi-stream-input' : 'stream-input';
    let url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/${path}` +
      `?model_id=${encodeURIComponent(this.modelId)}` +
      `&output_format=${encodeURIComponent(this.outputFormat)}` +
      `&inactivity_timeout=20` +
      `&apply_text_normalization=on`;
    // Truthiness check, NOT `??` — an explicit `languageCode: null` (the
    // fail-open retry's disable sentinel) must omit the param entirely.
    if (this.languageCode) {
      url += `&language_code=${encodeURIComponent(this.languageCode)}`;
    }
    return url;
  }

  /**
   * Open the WS, send BOS + text + EOS for one synth, deliver audio
   * frames to `onAudio` as they arrive, resolve on isFinal.
   *
   * @param {string} text — what to synthesise.
   * @param {{
   *   onAudio: (Buffer) => void,
   *   onError?: (Error) => void,
   *   signal?: AbortSignal,
   *   contextId?: string,                      // multi-context only
   * }} opts
   * @returns {Promise<{firstAudioNs: bigint|null, isFinalNs: bigint|null, bytes: number, audioFrames: number}>}
   */
  synth(text, opts) {
    if (!opts || typeof opts.onAudio !== 'function') {
      throw new Error('ElevenLabsStreamClient.synth: onAudio callback required');
    }
    if (typeof text !== 'string' || !text.trim()) {
      return Promise.reject(new Error('ElevenLabsStreamClient.synth: non-empty text required'));
    }
    const { onAudio, onError, signal, contextId = null } = opts;

    if (this.multiContext && !contextId) {
      return Promise.reject(
        new Error('ElevenLabsStreamClient.synth: contextId required when multiContext=true')
      );
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._buildUrl(), { headers: { 'xi-api-key': this.apiKey } });
      this.ws = ws;
      const timings = {
        wsOpenNs: process.hrtime.bigint(),
        bosSentNs: 0n,
        firstAudioNs: 0n,
        isFinalNs: 0n,
        bytes: 0,
        audioFrames: 0,
      };

      const timer = setTimeout(() => {
        this._closed = true;
        try {
          ws.close();
        } catch {
          /* noop */
        }
        reject(new Error(`elevenlabs_stream_timeout_${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const onAbort = () => {
        this._closed = true;
        try {
          ws.close();
        } catch {
          /* noop */
        }
        clearTimeout(timer);
        reject(new Error('elevenlabs_stream_aborted'));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          return reject(new Error('elevenlabs_stream_aborted'));
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      ws.on('open', () => {
        try {
          if (this.multiContext) {
            ws.send(
              JSON.stringify({
                text: ' ',
                context_id: contextId,
                voice_settings: this.voiceSettings,
              })
            );
            timings.bosSentNs = process.hrtime.bigint();
            ws.send(JSON.stringify({ text, context_id: contextId, flush: true }));
            ws.send(JSON.stringify({ context_id: contextId, close_context: true }));
          } else {
            ws.send(JSON.stringify({ text: ' ', voice_settings: this.voiceSettings }));
            timings.bosSentNs = process.hrtime.bigint();
            ws.send(JSON.stringify({ text, try_trigger_generation: true }));
            ws.send(JSON.stringify({ text: '' })); // EOS
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // Server returns camelCase `contextId` in multi-context mode
        // (PLAN_v3 §3.F bench confirmed); single-context omits it.
        // When contextId is in use, drop frames not for us.
        if (this.multiContext) {
          const cid = msg.contextId ?? msg.context_id;
          if (cid && cid !== contextId) return;
        }
        if (msg.audio) {
          if (timings.firstAudioNs === 0n) timings.firstAudioNs = process.hrtime.bigint();
          const buf = Buffer.from(msg.audio, 'base64');
          timings.bytes += buf.length;
          timings.audioFrames += 1;
          try {
            onAudio(buf);
          } catch (err) {
            // Caller's onAudio threw — propagate as a synth error and stop.
            cleanup();
            this._closed = true;
            try {
              ws.close();
            } catch {
              /* noop */
            }
            reject(err);
            return;
          }
        }
        if (msg.isFinal) {
          timings.isFinalNs = process.hrtime.bigint();
          cleanup();
          this._closed = true;
          try {
            ws.close();
          } catch {
            /* noop */
          }
          resolve(timings);
        }
        if (msg.error) {
          cleanup();
          this._closed = true;
          try {
            ws.close();
          } catch {
            /* noop */
          }
          const err = new Error(
            `elevenlabs_error: ${typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)}`
          );
          // D1 fail-open: the caller's retry wrapper decides eligibility on
          // bytesReceived, so every vendor-attributable rejection carries it.
          err.bytesReceived = timings.bytes;
          err.timings = timings;
          if (onError) onError(err);
          reject(err);
        }
      });

      ws.on('error', (err) => {
        cleanup();
        this._closed = true;
        try {
          ws.close();
        } catch {
          /* noop */
        }
        err.bytesReceived = timings.bytes;
        err.timings = timings;
        if (onError) onError(err);
        reject(err);
      });

      ws.on('close', (code) => {
        cleanup();
        if (timings.isFinalNs === 0n && !this._closed) {
          const err = new Error(`elevenlabs_ws_closed_before_final code=${code}`);
          err.bytesReceived = timings.bytes;
          err.timings = timings;
          if (onError) onError(err);
          reject(err);
        }
      });
    });
  }

  close() {
    this._closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }

  // Telemetry hop helpers — caller passes the correlationId and the
  // ns timings the synth() promise returned; this module formats the
  // logger.info lines so the voice_latency.span shape stays consistent
  // across confirmation + fast-path emitters in Stages 2/4.
  static logSynthSpans(correlationId, timings, recordSpan) {
    if (!correlationId || !timings) return;
    if (timings.wsOpenNs && timings.bosSentNs) {
      recordSpan(correlationId, 'vendor_ws_open', timings.wsOpenNs, timings.bosSentNs);
    }
    if (timings.bosSentNs && timings.firstAudioNs) {
      recordSpan(correlationId, 'vendor_first_audio', timings.bosSentNs, timings.firstAudioNs);
    }
    if (timings.firstAudioNs && timings.isFinalNs) {
      recordSpan(correlationId, 'vendor_isFinal', timings.firstAudioNs, timings.isFinalNs);
    }
  }
}

// D1 fail-open — known-unrelated-failure markers. The WS protocol carries
// no structured vendor error code for a language_code rejection (unlike
// the buffered HTTP path, which gets a JSON body naming the field), so
// eligibility can't be a positive match on "this is a language_code
// error." Instead this is a NEGATIVE deny-list: failure classes that are
// clearly NOT a language_code problem (auth, quota, rate-limit, DNS/
// connection-level errors) are excluded from the retry, so those don't
// pay an extra useless round-trip before their (identical either way)
// terminal failure. Anything not matching this list stays eligible —
// deliberately permissive, since under-matching only costs one wasted
// retry on a rare unrelated failure, while over-matching would exclude
// the very failure class D1 exists to recover from.
// Deliberately does NOT deny-list abnormal WS close codes (e.g. 1006) or
// generic "connection reset" markers close to a handshake — a rejected
// language_code query param is exactly the kind of failure that could
// surface as an abnormal close rather than a parseable error body, so
// excluding those would risk removing retry eligibility for the one
// failure class D1 exists to recover from.
const KNOWN_UNRELATED_FAILURE_RE =
  /quota|payment[_-]?required|unauthorized|invalid[_-]?api[_-]?key|rate[_-]?limit|too many requests|\b401\b|\b402\b|\b403\b|\b429\b|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|self[_\s-]signed certificate/i;

function isKnownUnrelatedFailure(err) {
  const message = typeof err?.message === 'string' ? err.message : '';
  return KNOWN_UNRELATED_FAILURE_RE.test(message);
}

/**
 * D1 fail-open contract, shared by every production `ElevenLabsStreamClient`
 * caller (`keys.js` streaming gate, `loaded-barrel-speculator.js`,
 * `voice-latency-fast-tts.js`) so the two-attempt construction and its
 * safety invariants live in exactly one place.
 *
 * Attempt 1 is the caller-supplied `client` (built with the default pinned
 * `language_code=en`, per the constructor's `undefined` → DEFAULT_LANGUAGE_CODE
 * resolution). If it rejects with a vendor-attributable, zero-audio-bytes
 * error (only `msg.error` / `ws.on('error')` / `ws.on('close')` rejections
 * carry `bytesReceived` — a timeout, an abort, or a caller-callback throw
 * never do, so those never retry) that isn't a KNOWN unrelated failure class
 * (`isKnownUnrelatedFailure` — auth/quota/rate-limit/DNS), a SECOND,
 * freshly-constructed client (never the same instance — `_closed` latches
 * permanently) retries once with `languageCode: null` (the explicit disable
 * sentinel). Any error received after the first audio byte, or a second
 * failure, is terminal.
 *
 * Correlation id and cost attribution stay caller-threaded: this helper
 * does not call any telemetry/cost function itself, so a caller that opens
 * one ledger entry before invoking this helper still closes exactly one
 * ledger entry after it settles, regardless of whether 1 or 2 attempts ran.
 *
 * @param {ElevenLabsStreamClient} client — attempt 1, already constructed.
 * @param {() => ElevenLabsStreamClient} retryClientFactory — builds attempt
 *   2 (must pass `languageCode: null`) lazily, only if a retry is eligible.
 * @param {string} text
 * @param {object} synthOpts — passed through verbatim to `client.synth()`.
 * @returns {Promise<{timings: object, client: ElevenLabsStreamClient, attempts: 1|2}>}
 */
export async function synthWithLanguageFailOpen(client, retryClientFactory, text, synthOpts) {
  try {
    const timings = await client.synth(text, synthOpts);
    return { timings, client, attempts: 1 };
  } catch (err) {
    const eligibleForRetry =
      typeof err?.bytesReceived === 'number' &&
      err.bytesReceived === 0 &&
      !isKnownUnrelatedFailure(err);
    if (!eligibleForRetry) throw err;
    if (client && typeof client.close === 'function') {
      try {
        client.close();
      } catch {
        /* noop */
      }
    }
    const retryClient = retryClientFactory();
    try {
      const timings = await retryClient.synth(text, synthOpts);
      return { timings, client: retryClient, attempts: 2 };
    } catch (retryErr) {
      // Belt-and-braces: most synth() reject paths already close their own
      // WS before rejecting, but `ws.on('error')` (a raw transport error)
      // does not — close explicitly rather than relying on that.
      if (retryClient && typeof retryClient.close === 'function') {
        try {
          retryClient.close();
        } catch {
          /* noop */
        }
      }
      throw retryErr;
    }
  }
}

/** Re-export helpers for tests / consumers. */
export const _internals = {
  DEFAULT_VOICE_ID,
  DEFAULT_MODEL_ID,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_VOICE_SETTINGS,
  DEFAULT_SYNTH_TIMEOUT_MS,
  DEFAULT_LANGUAGE_CODE,
  isKnownUnrelatedFailure,
};
