'use client';

/**
 * Client diagnostic plumbing — fires a `client_diagnostic` WS frame at the
 * backend (mirrors iOS `ServerWebSocketService.sendClientDiagnostic`) AND a
 * matching `console.info` so the same trail is visible in the browser
 * devtools without a CloudWatch round-trip.
 *
 * Used to debug the prod ask_user / TTS no-show on the PWA pipeline
 * (sess_moyo7wmd_mdpr 2026-05-09): the wire round-trip works (the PWA
 * answered ask_user with the right toolCallId) but neither the AlertCard
 * nor the ElevenLabs proxy fetch fired. The instrumentation pins which
 * step in the chain (decode → onQuestion → speak() → ElevenLabs) drops
 * the question.
 *
 * Design:
 * - The recording-context.tsx wires the active SonnetSession in once via
 *   `setDiagnosticSink(session)` so call sites in deep modules
 *   (elevenlabs-tts.ts, tts.ts) don't need to import or plumb the session
 *   reference through every layer.
 * - When no sink is active (SSR, post-stop, pre-connect window), the
 *   helper logs to console only and quietly drops the WS emit. This is
 *   the same drop-on-floor policy as iOS so a stale diagnostic from a
 *   torn-down session can't pollute a fresh one.
 *
 * The console.info prefix `[client-diagnostic]` is greppable in the
 * devtools console; the CloudWatch counterpart is `Client diagnostic`
 * (logged by sonnet-stream.js:1127).
 */

interface DiagnosticSink {
  sendClientDiagnostic(category: string, payload?: Record<string, unknown>): void;
}

let activeSink: DiagnosticSink | null = null;

/**
 * Wire the active SonnetSession (or any object exposing
 * `sendClientDiagnostic`) so subsequent `clientDiagnostic()` calls
 * forward to the backend. Pass `null` on session teardown.
 */
export function setDiagnosticSink(sink: DiagnosticSink | null): void {
  activeSink = sink;
}

/**
 * Fire-and-forget diagnostic. Always console-logs; forwards to the
 * backend WS when a sink is active. Never throws.
 */
export function clientDiagnostic(category: string, payload: Record<string, unknown> = {}): void {
  try {
    console.info(`[client-diagnostic] ${category}`, payload);
  } catch {
    /* ignore */
  }
  try {
    activeSink?.sendClientDiagnostic(category, payload);
  } catch {
    /* ignore — diagnostics must never tear down the recording session */
  }
}
