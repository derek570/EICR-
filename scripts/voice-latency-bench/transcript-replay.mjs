#!/usr/bin/env node
/**
 * Stage 0.G — Transcript-replay harness ("simulated Deepgram").
 *
 * Per PLAN_v3 §3.G: connects to the backend session WS as if it were
 * iOS, sends `session_start` (with optional capability handshake),
 * replays a YAML scenario file's transcript messages with timing
 * offsets, captures every server response (extraction, ask_user,
 * cost_update, voice_command_response), optionally POSTs each
 * extracted `confirmations[]` text through /api/proxy/elevenlabs-tts
 * and times the response, then evaluates the scenario's `expect.*`
 * assertions.
 *
 * Scenario schema: tests/fixtures/voice-latency-scenarios/SCHEMA.md.
 *
 * Usage:
 *   node scripts/voice-latency-bench/transcript-replay.mjs \
 *     --base-url=http://localhost:3000 \
 *     --token=<JWT>             # or: --user=email --password=pw → auto-login
 *     --suite=baseline          # or --suite=protocol,stage2_streaming
 *     --scenario=tests/fixtures/voice-latency-scenarios/baseline/normal_npts.yaml
 *     --output=/tmp/results     # one .json per scenario; default = stdout only
 *
 * Defaults:
 *   --base-url=http://localhost:3000
 *   no --token, no --user → no auth (will fail on the /api/sonnet-stream
 *                                     upgrade unless you ran `npm start`
 *                                     locally with a dev bypass)
 *
 * Exit code: 0 if all scenarios passed, 1 if any failed, 2 if usage/
 * connection errors prevented evaluation.
 */

import WebSocket from 'ws';
import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const BASE_URL = (args['base-url'] ?? 'http://localhost:3000').replace(/\/$/, '');
const WS_URL = BASE_URL.replace(/^http/, 'ws');
const TOKEN = args.token ?? process.env.HARNESS_TOKEN ?? null;
const USER = args.user ?? null;
const PASSWORD = args.password ?? process.env.HARNESS_PASSWORD ?? null;
const SCENARIO_PATH = args.scenario ?? null;
const SCENARIO_DIR =
  args['scenario-dir'] ?? path.resolve('tests/fixtures/voice-latency-scenarios');
const SUITE_FILTER = args.suite ? String(args.suite).split(',') : null;
const OUTPUT_DIR = args.output ?? null;
const VERBOSE = !!args.verbose;

if (!TOKEN && !(USER && PASSWORD)) {
  console.error('Provide either --token=<JWT> or --user=...+ --password=...');
  process.exit(2);
}

async function loginIfNeeded() {
  if (TOKEN) return TOKEN;
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER, password: PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.token) throw new Error(`Login response missing token: ${JSON.stringify(json).slice(0, 200)}`);
  return json.token;
}

function loadScenarios() {
  if (SCENARIO_PATH) {
    return [{ file: SCENARIO_PATH, ...yaml.load(fs.readFileSync(SCENARIO_PATH, 'utf8')) }];
  }
  const scenarios = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        try {
          const data = yaml.load(fs.readFileSync(p, 'utf8'));
          if (!data || typeof data !== 'object') continue;
          scenarios.push({ file: p, ...data });
        } catch (err) {
          console.error(`Skipping ${p}: ${err.message}`);
        }
      }
    }
  }
  walk(SCENARIO_DIR);
  return scenarios.filter((s) => {
    if (!SUITE_FILTER) return true;
    return SUITE_FILTER.includes(s.suite);
  });
}

const ns2ms = (a, b) => Number((b - a) / 1000000n);

class ScenarioRunner {
  constructor(scenario, token) {
    this.s = scenario;
    this.token = token;
    this.events = []; // { at_ms, type, payload }
    this.t0 = process.hrtime.bigint();
    this.transcriptSentAt = []; // monotonic ns per transcript sent
    this.extractions = []; // raw extraction payloads
    this.askUsers = [];
    this.errors = [];
    this.firstExtractionAt = null;
    this.sessionAckAt = null;
    this.ttsTimings = []; // per fetch
  }

  rel(now = process.hrtime.bigint()) {
    return ns2ms(this.t0, now);
  }

  record(type, payload = null) {
    this.events.push({ at_ms: this.rel(), type, summary: this.summarize(type, payload) });
  }

  summarize(type, payload) {
    if (!payload) return null;
    if (type === 'extraction') {
      const r = payload.result ?? {};
      const readings = (r.readings ?? r.extracted_readings ?? []).length;
      const confs = (r.confirmations ?? []).length;
      return `readings=${readings} confirmations=${confs}`;
    }
    if (type === 'question') return `q=${(payload.question || '').slice(0, 60)}`;
    if (type === 'cost_update') return `running=$${payload.running_cost ?? '?'}`;
    return JSON.stringify(payload).slice(0, 120);
  }

  async fetchTTS(text) {
    const startNs = process.hrtime.bigint();
    let firstByteNs = 0n;
    let bytes = 0;
    const res = await fetch(`${BASE_URL}/api/proxy/elevenlabs-tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ text, sessionId: this.s.sessionId ?? null }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TTS proxy ${res.status}: ${body.slice(0, 200)}`);
    }
    // Stream the response so we get a true first-byte time. Node's
    // fetch returns a ReadableStream we can read incrementally.
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteNs === 0n) firstByteNs = process.hrtime.bigint();
      bytes += value.length;
    }
    const endNs = process.hrtime.bigint();
    const result = {
      text_preview: text.slice(0, 60),
      first_byte_ms: firstByteNs > 0n ? ns2ms(startNs, firstByteNs) : null,
      total_ms: ns2ms(startNs, endNs),
      bytes,
    };
    this.ttsTimings.push(result);
    return result;
  }

  async run() {
    const ws = new WebSocket(`${WS_URL}/api/sonnet-stream?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        reject(new Error('scenario timeout'));
      }, this.s.config?.timeout_ms ?? 30000);

      ws.on('open', async () => {
        try {
          await this.runTimeline();
          // Wait for any in-flight server responses to drain.
          await new Promise((r) => setTimeout(r, 500));
          // Fetch TTS for each confirmation if requested.
          const fetchTTS = this.s.config?.fetch_tts ?? true;
          if (fetchTTS) {
            const allConfirmations = this.extractions
              .flatMap((e) => e.result?.confirmations ?? [])
              .map((c) => (typeof c === 'string' ? c : c?.text))
              .filter(Boolean);
            for (const text of allConfirmations) {
              try {
                await this.fetchTTS(text);
              } catch (err) {
                this.errors.push(`TTS fetch failed: ${err.message}`);
              }
            }
          }
          if (this.s.config?.session_stop_at_end !== false) {
            ws.send(JSON.stringify({ type: 'session_stop' }));
            await new Promise((r) => setTimeout(r, 200));
          }
          clearTimeout(timeout);
          try {
            ws.close();
          } catch {
            /* noop */
          }
          resolve();
        } catch (err) {
          clearTimeout(timeout);
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
        this.record(msg.type ?? 'unknown', msg);
        if (msg.type === 'extraction') {
          if (this.firstExtractionAt === null) this.firstExtractionAt = process.hrtime.bigint();
          this.extractions.push(msg);
        }
        if (msg.type === 'question' && msg.question_type === 'ask_user') {
          this.askUsers.push(msg);
        }
        if (msg.type === 'session_ack' && this.sessionAckAt === null) {
          this.sessionAckAt = process.hrtime.bigint();
        }
        if (msg.type === 'error') {
          this.errors.push(msg.message ?? JSON.stringify(msg));
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async runTimeline() {
    const sessionId =
      this.s.sessionId ?? `harness_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.s.sessionId = sessionId;
    const jobId = this.s.jobId ?? `harness_job_${Date.now()}`;
    const sessionStart = {
      type: 'session_start',
      sessionId,
      jobId,
      jobState: this.s.job_state ?? defaultJobState(),
      // Advertise the stage6 protocol so the backend's ask_user dispatcher
      // doesn't fall back to shadow-mode (protocol_version_mismatch_shadow
      // log line). Scenario can override.
      protocol_version: this.s.protocol_version ?? 'stage6',
      // Tell backend we want confirmation read-backs so result.confirmations[]
      // gets populated and the harness can time the TTS leg.
      confirmations_enabled: this.s.confirmations_enabled ?? true,
    };
    // Advertise streaming capabilities by default so the Stage 2 streaming
    // path activates when VOICE_LATENCY_STREAM_CONFIRMATIONS=true on the
    // server. A scenario can pass `capabilities: null` to opt OUT for a
    // baseline-only run, or override with a subset.
    sessionStart.capabilities = this.s.capabilities ?? {
      voice_latency: {
        version: 1,
        supports: [
          'streaming_http_audio',
          'source_field_in_tts_post',
          'voice_latency_ack',
          'kill_switch_drop_queue',
        ],
      },
    };
    this.ws.send(JSON.stringify(sessionStart));
    this.record('session_start_sent', { sessionId });

    // Wait briefly for the server to ack the session before sending
    // transcripts, so pre-session-buffer behaviour doesn't muddy the
    // baseline timings.
    await new Promise((r) => setTimeout(r, 50));

    const startTimeline = process.hrtime.bigint();
    this._fastPathTimings = [];
    for (const t of this.s.transcript ?? []) {
      const dueAtMs = t.at_ms ?? 0;
      const elapsedMs = ns2ms(startTimeline, process.hrtime.bigint());
      if (dueAtMs > elapsedMs) {
        await new Promise((r) => setTimeout(r, dueAtMs - elapsedMs));
      }
      const sendNs = process.hrtime.bigint();
      this.transcriptSentAt.push(sendNs);
      // Fast-path scenario: POST direct to /api/voice-latency/regex-fast-tts
      // INSTEAD of sending a transcript over the WS. Times the full
      // request lifecycle (POST → first audio byte).
      if (t.fast_path === true && t.candidate) {
        const fpStart = process.hrtime.bigint();
        let firstByteNs = 0n;
        let bytes = 0;
        try {
          const res = await fetch(`${BASE_URL}/api/voice-latency/regex-fast-tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
            body: JSON.stringify({ sessionId: this.s.sessionId, transcript: t.text, candidate: t.candidate }),
          });
          if (!res.ok) {
            this.errors.push(`fast_path HTTP ${res.status}: ${(await res.text()).slice(0,160)}`);
          } else {
            const reader = res.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (firstByteNs === 0n) firstByteNs = process.hrtime.bigint();
              bytes += value.length;
            }
          }
        } catch (err) {
          this.errors.push(`fast_path threw: ${err.message}`);
        }
        const fpEnd = process.hrtime.bigint();
        const fb = firstByteNs === 0n ? null : Number((firstByteNs - fpStart) / 1000000n);
        const total = Number((fpEnd - fpStart) / 1000000n);
        this._fastPathTimings.push({ text: t.text, firstByteMs: fb, totalMs: total, bytes });
        this.record('fast_path_complete', { firstByteMs: fb, totalMs: total, bytes });
        continue;
      }
      const payload = {
        type: 'transcript',
        text: t.text,
        isFinal: t.isFinal ?? true,
        // confirmations_enabled is read from the TRANSCRIPT message
        // (per sonnet-stream.js:3777), NOT from session_start. iOS sends
        // it on every transcript with the Voice toggle's current value.
        confirmations_enabled: this.s.confirmations_enabled ?? true,
      };
      if (t.regexResults) payload.regexResults = t.regexResults;
      this.ws.send(JSON.stringify(payload));
      this.record('transcript_sent', { text: t.text });
    }

    // After last transcript, wait up to (timeout - elapsed) for the
    // server to emit its extraction(s). We give 8s as a default unless
    // the scenario expects more (long ask_user paths can take longer).
    const drain = this.s.config?.drain_ms ?? 8000;
    await new Promise((r) => setTimeout(r, drain));
  }

  evaluate() {
    const failures = [];
    const expect = this.s.expect ?? {};

    // extraction_count
    if (expect.extraction_count) {
      if (expect.extraction_count.min !== undefined && this.extractions.length < expect.extraction_count.min) {
        failures.push(
          `extraction_count.min=${expect.extraction_count.min}, got ${this.extractions.length}`,
        );
      }
      if (expect.extraction_count.max !== undefined && this.extractions.length > expect.extraction_count.max) {
        failures.push(
          `extraction_count.max=${expect.extraction_count.max}, got ${this.extractions.length}`,
        );
      }
    }

    // has_reading
    if (expect.has_reading) {
      const allReadings = this.extractions.flatMap((e) => e.result?.readings ?? []);
      for (const need of expect.has_reading) {
        const match = allReadings.find(
          (r) =>
            String(r.circuit) === String(need.circuit) &&
            r.field === need.field &&
            (need.value === undefined || String(r.value) === String(need.value)),
        );
        if (!match) {
          // Surface what we DID get so debug doesn't need a re-run.
          const actual = allReadings
            .map((r) => `${r.field}=${JSON.stringify(r.value)} (circuit=${r.circuit})`)
            .join(', ');
          failures.push(
            `has_reading missing: circuit=${need.circuit} field=${need.field} value=${need.value ?? '*'} | actual readings: [${actual || 'none'}]`,
          );
        }
      }
    }

    // ask_user_count
    if (expect.ask_user_count) {
      if (expect.ask_user_count.min !== undefined && this.askUsers.length < expect.ask_user_count.min) {
        failures.push(`ask_user_count.min=${expect.ask_user_count.min}, got ${this.askUsers.length}`);
      }
      if (expect.ask_user_count.max !== undefined && this.askUsers.length > expect.ask_user_count.max) {
        failures.push(`ask_user_count.max=${expect.ask_user_count.max}, got ${this.askUsers.length}`);
      }
    }

    // saw_event_types
    if (Array.isArray(expect.saw_event_types)) {
      const seen = new Set(this.events.map((e) => e.type));
      for (const t of expect.saw_event_types) {
        if (!seen.has(t)) failures.push(`saw_event_types missing: ${t}`);
      }
    }

    // audible_latency_ms_p50 = first transcript_sent → first TTS first_byte
    const firstTranscriptAt =
      this.transcriptSentAt.length > 0 ? this.transcriptSentAt[0] : null;
    let audibleP50 = null;
    if (firstTranscriptAt && this.ttsTimings.length > 0) {
      const firstTtsAbsoluteMs = ns2ms(this.t0, firstTranscriptAt) + this.ttsTimings[0].first_byte_ms;
      const firstTranscriptRelMs = ns2ms(this.t0, firstTranscriptAt);
      // audible = (transcript_sent → first audible byte for that confirmation)
      // The TTS fetch happens AFTER extraction, so the practical
      // wall-clock for audible is: extraction_first_received_at -
      // first_transcript_sent_at + first_byte_ms_of_tts.
      if (this.firstExtractionAt) {
        audibleP50 =
          ns2ms(firstTranscriptAt, this.firstExtractionAt) + this.ttsTimings[0].first_byte_ms;
      }
    }
    if (expect.audible_latency_ms_p50 && audibleP50 !== null) {
      if (expect.audible_latency_ms_p50.max !== undefined && audibleP50 > expect.audible_latency_ms_p50.max) {
        failures.push(
          `audible_latency_ms_p50.max=${expect.audible_latency_ms_p50.max}, got ${audibleP50}`,
        );
      }
      if (expect.audible_latency_ms_p50.min !== undefined && audibleP50 < expect.audible_latency_ms_p50.min) {
        failures.push(
          `audible_latency_ms_p50.min=${expect.audible_latency_ms_p50.min}, got ${audibleP50}`,
        );
      }
    }

    if (this.errors.length > 0) {
      for (const e of this.errors) failures.push(`server_error: ${e}`);
    }

    const timings = {
      session_start_to_ack_ms: this.sessionAckAt ? ns2ms(this.t0, this.sessionAckAt) : null,
      first_transcript_to_extraction_ms:
        this.firstExtractionAt && this.transcriptSentAt[0]
          ? ns2ms(this.transcriptSentAt[0], this.firstExtractionAt)
          : null,
      first_transcript_to_audible_ms: audibleP50,
      transcripts_sent: this.transcriptSentAt.length,
      extractions_received: this.extractions.length,
      confirmations_total: this.extractions.reduce(
        (acc, e) => acc + (e.result?.confirmations?.length ?? 0),
        0,
      ),
      tts_fetches: this.ttsTimings,
      fast_path: this._fastPathTimings ?? [],
    };

    return {
      name: this.s.name,
      suite: this.s.suite,
      pass: failures.length === 0,
      failures,
      timings,
      events: VERBOSE ? this.events : this.events.slice(0, 20),
    };
  }
}

function defaultJobState() {
  // Shape MUST match what _seedStateFromJobState reads in
  // src/extraction/eicr-extraction-session.js — flat `circuits[]` at
  // top level (NOT nested inside boards[].circuits). Each circuit
  // carries `number` (or ref/circuitNumber) + `board_id`. Without
  // this shape the seeder bails (`if (!jobState?.circuits) return;`)
  // and Sonnet's record_reading hits `circuit_not_found` validation.
  return {
    boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
    circuits: [
      { number: 1, board_id: 'main', designation: 'Lighting', ocpd_rating_a: 6, ocpd_type: 'B' },
      { number: 2, board_id: 'main', designation: 'Sockets', ocpd_rating_a: 32, ocpd_type: 'B' },
    ],
  };
}

async function main() {
  const token = await loginIfNeeded();
  const scenarios = loadScenarios();
  console.log(`Loaded ${scenarios.length} scenario(s) from ${SCENARIO_PATH ?? SCENARIO_DIR}`);
  if (SUITE_FILTER) console.log(`Suite filter: ${SUITE_FILTER.join(',')}`);
  if (scenarios.length === 0) {
    console.error('No scenarios matched filter.');
    process.exit(2);
  }

  let passed = 0;
  let failed = 0;
  const allResults = [];

  for (const s of scenarios) {
    process.stdout.write(`\n[${s.suite ?? 'no-suite'}] ${s.name} ... `);
    const runner = new ScenarioRunner(s, token);
    try {
      await runner.run();
    } catch (err) {
      console.log(`THREW — ${err.message}`);
      const result = {
        name: s.name,
        suite: s.suite,
        pass: false,
        failures: [`runner threw: ${err.message}`],
        timings: null,
      };
      allResults.push(result);
      failed++;
      continue;
    }
    const result = runner.evaluate();
    if (result.pass) {
      passed++;
      console.log(
        `PASS (extr=${result.timings.first_transcript_to_extraction_ms}ms, audible=${result.timings.first_transcript_to_audible_ms}ms)`,
      );
    } else {
      failed++;
      console.log('FAIL');
      for (const f of result.failures) console.log(`   - ${f}`);
    }
    allResults.push(result);
    if (OUTPUT_DIR) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUTPUT_DIR, `${s.suite ?? 'no-suite'}__${s.name}.json`),
        JSON.stringify(result, null, 2),
      );
    }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed (${allResults.length} total) ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Harness failed:', err);
  process.exit(2);
});
