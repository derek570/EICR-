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
    return (
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/${path}` +
      `?model_id=${encodeURIComponent(this.modelId)}` +
      `&output_format=${encodeURIComponent(this.outputFormat)}` +
      `&inactivity_timeout=20` +
      `&apply_text_normalization=on`
    );
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
          if (onError) onError(err);
          reject(err);
        }
      });

      ws.on('error', (err) => {
        cleanup();
        this._closed = true;
        if (onError) onError(err);
        reject(err);
      });

      ws.on('close', (code) => {
        cleanup();
        if (timings.isFinalNs === 0n && !this._closed) {
          const err = new Error(`elevenlabs_ws_closed_before_final code=${code}`);
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

/** Re-export helpers for tests / consumers. */
export const _internals = {
  DEFAULT_VOICE_ID,
  DEFAULT_MODEL_ID,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_VOICE_SETTINGS,
  DEFAULT_SYNTH_TIMEOUT_MS,
};
