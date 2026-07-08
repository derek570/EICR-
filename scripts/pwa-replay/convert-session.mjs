#!/usr/bin/env node
/**
 * C1 + C2 — iOS session → PWA replay fixture + iOS behavioural trace
 * (pwa-replay-harness Wave 4).
 *
 *   node scripts/pwa-replay/convert-session.mjs --dir=<fetched-session-dir>
 *        [--name=<fixture-name>] [--out-dir=tests/fixtures/pwa-replay-sessions]
 *        [--initial-state=<hand-authored-job-state.json>]
 *
 * Input: a session dir from fetch-session-analytics.sh (debug_log.jsonl +
 * manifest.json + job_snapshot.json). WEB sessions have no debug_log in S3
 * (analytics-upload gap, ledger row crosscutting/session-analytics-upload)
 * — this exits with an explicit error telling you to use a checked-in
 * fixture instead.
 *
 * Outputs:
 *   <out>/<name>.yaml            — replay fixture (transcript timeline from
 *                                  final_transcript.raw — FLUX_END_OF_TURN
 *                                  detail is 40-char truncated; timestamps
 *                                  from the real events; interims are
 *                                  synthesised at replay time)
 *   <out>/<name>.ios-trace.json  — the iOS behavioural trace for the differ
 *
 * MOCK-FRAME PROVENANCE (B3 rule): frames are reconstructed from
 * SERVER-ORIGIN events ONLY (`sonnet/` category: field_set, field_update,
 * confirmation_received, question_asked). `regex/` category events
 * (field_matched, regex field_set) are CLIENT trace and must never become
 * frames — feeding a client regex write back as fake backend output would
 * mask exactly the A3 bug class. Enforced here + pinned by
 * mock-frame-provenance.test.ts.
 *
 * initial_state_fidelity: `job_snapshot.json` is the FINAL state — using
 * it as the initial state would make every re-dictation look stale. The
 * manifest carries no session-start snapshot (verified on the 2026-06-25
 * corpus), so: --initial-state → 'hand_authored'; else → 'empty_fallback'
 * (the differ downgrades state-dependent strict lanes to WARN, and
 * empty_fallback fixtures do NOT count toward the Wave-4
 * zero-strict-false-positive gate).
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const dir = opt('dir');
if (!dir) {
  console.error('convert-session: --dir=<session dir> is required');
  process.exit(2);
}
const debugLogPath = path.join(dir, 'debug_log.jsonl');
if (!fs.existsSync(debugLogPath)) {
  console.error(
    `convert-session: ${dir} has no debug_log.jsonl — web sessions have no debug_log.jsonl in S3 ` +
      '(analytics-upload gap); use a checked-in fixture in tests/fixtures/pwa-replay-sessions/ instead.'
  );
  process.exit(3);
}

const lines = fs
  .readFileSync(debugLogPath, 'utf8')
  .trim()
  .split('\n')
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const manifest = readJsonIfExists(path.join(dir, 'manifest.json'));
const sessionId =
  manifest?.sessionId ?? lines.find((e) => e.data?.sessionId)?.data?.sessionId ?? 'unknown';
const name = opt('name') ?? `ios-${String(sessionId).slice(0, 8)}`;
const outDir = opt('out-dir') ?? 'tests/fixtures/pwa-replay-sessions';

function readJsonIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ── C1: utterance timeline from final_transcript (raw, full text) ──
const startTs = Date.parse(lines.find((e) => e.event === 'session_start')?.timestamp ?? lines[0].timestamp);
const utterances = [];
for (const e of lines) {
  if (e.event === 'final_transcript' && e.data?.raw) {
    utterances.push({
      at_ms: Math.max(0, Date.parse(e.timestamp) - startTs),
      raw: e.data.raw,
      normalised: e.data.normalised ?? e.data.raw,
      events: [],
    });
  } else if (utterances.length > 0) {
    utterances[utterances.length - 1].events.push(e);
  }
}
if (utterances.length === 0) {
  console.error('convert-session: no final_transcript events found');
  process.exit(4);
}

// ── mock-frame reconstruction (SERVER-ORIGIN 'sonnet' category ONLY) ──
// iOS internal field_set keys → wire field names the web pipeline expects.
// Approximate by design (plan §4 WS-B3): confidence/board_id synthesised,
// unknown keys pass through snake_cased.
const CIRCUIT_KEY_TO_WIRE = {
  zs: 'measured_zs_ohm',
  r1r2: 'r1_r2_ohm',
  r1_r2: 'r1_r2_ohm',
  irLiveEarth: 'ir_live_earth_mohm',
  irLiveLive: 'ir_live_live_mohm',
  rcd: 'rcd_time_ms',
  rcdTimeMs: 'rcd_time_ms',
  polarity: 'polarity_confirmed',
};
const camelToSnake = (s) => s.replace(/([A-Z])/g, '_$1').toLowerCase();

function frameReadingsFor(u) {
  const readings = [];
  for (const e of u.events) {
    if (e.category !== 'sonnet') continue; // provenance rule — server-origin only
    if (e.event !== 'field_set' && e.event !== 'field_update') continue;
    const key = e.data?.key ?? '';
    const value = e.data?.value;
    // Approximate-reconstruction limit: some iOS applies log no field_set
    // value (e.g. rescue-path supply writes). A reading without a value
    // can't be replayed meaningfully — skip it (the paired confirmation
    // still exercises the read-back lanes); the loose applied-fields lane
    // tolerates the miss.
    if (value === undefined) continue;
    const circuitMatch = /^circuit\.(\d+)\.(.+)$/.exec(key);
    if (circuitMatch) {
      const inner = circuitMatch[2];
      readings.push({
        circuit: Number(circuitMatch[1]),
        field: CIRCUIT_KEY_TO_WIRE[inner] ?? camelToSnake(inner),
        value,
      });
    } else {
      const inner = key.replace(/^(supply|board|installation)\./, '');
      // Section readings ride circuit 0 on the wire (applyCircuit0Readings
      // requires === 0; null never routes).
      readings.push({ circuit: 0, field: camelToSnake(inner), value });
    }
  }
  return readings;
}

function frameConfirmationsFor(u) {
  const out = [];
  for (const e of u.events) {
    if (e.category !== 'sonnet' || e.event !== 'confirmation_received') continue;
    const c = e.data ?? {};
    out.push({
      field: c.field ?? 'unknown',
      circuit: c.circuit === 'nil' || c.circuit == null ? null : Number(c.circuit),
      text: c.text ?? '',
    });
  }
  return out;
}

function frameQuestionsFor(u) {
  return u.events
    .filter((e) => e.category === 'sonnet' && e.event === 'question_asked')
    .map((e) => ({
      type: 'question',
      question: e.data?.question ?? '',
      question_type: 'clarification',
    }));
}

const mock_frames = [];
for (const u of utterances) {
  const readings = frameReadingsFor(u);
  const confirmations = frameConfirmationsFor(u);
  const questions = frameQuestionsFor(u);
  const frames = [];
  if (readings.length > 0 || confirmations.length > 0) {
    frames.push({ type: 'extraction', readings, confirmations });
  }
  frames.push(...questions);
  if (frames.length > 0) mock_frames.push({ on_transcript: u.raw, frames });
}

// ── initial state ──
const handAuthored = opt('initial-state');
const initialState = handAuthored ? readJsonIfExists(handAuthored) : null;
const fidelity = handAuthored ? 'hand_authored' : 'empty_fallback';

const fixture = {
  name,
  description: `Differential replay fixture converted from iOS session ${sessionId} (${fidelity}).`,
  suite: 'pwa-replay-sessions',
  metadata: {
    session_id: sessionId,
    session_date: new Date(startTs).toISOString().slice(0, 10),
    source: 'convert-session.mjs (iOS debug_log.jsonl)',
    platform: 'ios',
    initial_state_fidelity: fidelity,
    synthetic_interims: true,
    frame_reconstruction: 'approximate (server-origin events only — B3 provenance rule)',
  },
  ...(initialState ? { job_state: initialState } : {}),
  transcript: utterances.map((u) => ({ at_ms: u.at_ms, text: u.raw, isFinal: true })),
  mock_frames,
  expect: { web: {} }, // seed invariants still run in the scenario suite
};

// ── C2: iOS behavioural trace ──
const iosTrace = {
  session_id: sessionId,
  initial_state_fidelity: fidelity,
  utterances: utterances.map((u) => {
    const gateBlocked = u.events.some((e) => e.event === 'transcript_gate_blocked');
    const serverTurns = u.events.filter((e) => e.event === 'server_extraction_received');
    const confirmations = u.events
      .filter((e) => e.category === 'sonnet' && e.event === 'confirmation_received')
      .map((e) => ({
        field: e.data?.field ?? '',
        circuit: e.data?.circuit === 'nil' ? null : (e.data?.circuit ?? null),
        text: e.data?.text ?? '',
        deferred: Boolean(e.data?.deferred),
      }));
    return {
      text: u.normalised,
      raw: u.raw,
      // Approximation: iOS logs no explicit "sent" event; a server
      // extraction turn attributed to the utterance implies a forward —
      // EXCEPT when the gate explicitly blocked (authoritative): a late
      // server response to the PREVIOUS turn can attribute to this
      // utterance (attribution-to-latest), so gate-block wins.
      gate: gateBlocked ? 'blocked' : serverTurns.length > 0 ? 'passed' : 'none',
      sonnetForwarded: gateBlocked ? false : serverTurns.length > 0,
      fieldSets: u.events
        .filter((e) => e.category === 'sonnet' && (e.event === 'field_set' || e.event === 'field_update'))
        .map((e) => ({ key: e.data?.key ?? '', value: e.data?.value })),
      regexMatches: u.events
        .filter((e) => e.category === 'regex' && e.event === 'field_matched')
        .map((e) => ({ field: e.data?.field ?? '', value: e.data?.value })),
      confirmations,
      confirmationsDeduped: u.events.filter((e) => e.event === 'confirmation_deduped').length,
      ttsPlays: u.events.filter((e) => e.event === 'tts_elevenlabs_playing').length,
      ttsDeferred: u.events.filter((e) => e.event === 'tts_playback_deferred').length,
      ttsDeferredResumed: u.events.filter((e) => e.event === 'tts_deferred_resumed').length,
      questions: u.events
        .filter((e) => e.event === 'question_asked')
        .map((e) => e.data?.question ?? ''),
      feedbackEvents: u.events
        .filter((e) => /feedback|debug_report/i.test(e.event ?? ''))
        .map((e) => e.event),
      sleepWake: u.events
        .filter((e) => /^sleep_|_sleeping|_dozing|wake/.test(e.event ?? ''))
        .map((e) => e.event),
    };
  }),
};

fs.mkdirSync(outDir, { recursive: true });
const yamlPath = path.join(outDir, `${name}.yaml`);
const tracePath = path.join(outDir, `${name}.ios-trace.json`);
fs.writeFileSync(
  yamlPath,
  `# GENERATED by scripts/pwa-replay/convert-session.mjs — do not hand-edit.\n# Source: iOS session ${sessionId}; regenerate with the C5 one-liner.\n` +
    yaml.dump(fixture, { lineWidth: 100 })
);
fs.writeFileSync(tracePath, JSON.stringify(iosTrace, null, 2));
console.log(`convert-session: wrote ${yamlPath} (${utterances.length} utterances, fidelity=${fidelity})`);
console.log(`convert-session: wrote ${tracePath}`);
