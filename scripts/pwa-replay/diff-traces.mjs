#!/usr/bin/env node
/**
 * C3 — iOS↔web behavioural-trace differ (pwa-replay-harness Wave 4).
 *
 *   node scripts/pwa-replay/diff-traces.mjs --web=<web.trace.json>
 *        --ios=<ios.trace.json> [--out=<report.md>] [--json=<report.json>]
 *
 * Two-lane tolerance model (plan §2.5 / §4 WS-C3):
 *
 * STRICT lanes (deterministic client logic — divergence = FAIL):
 *   - gate pass/block decision per aligned utterance
 *   - whether the utterance was forwarded to Sonnet
 *   - orphan/ask decision class (asked vs rescued vs applied)
 *   - TTS invariants on the WEB trace (no permanent defer, no
 *     discard-without-replay — evaluated by the scenario suite's seed
 *     invariants; surfaced here from the trace totals)
 *   - feedback-marker detection (post-Wave-6)
 *
 * Documented iOS-canon quirk → WARN, not FAIL: iOS's circuit-HINT loop
 * (DeepgramRecordingViewModel.swift:5188-5210) inserts regex hit keys
 * WITHOUT a value-equality check, so a stale cumulative circuit re-match
 * CAN pass the iOS gate where the web (A3 freshness) blocks. Detected as:
 * iOS=passed & web=blocked & the iOS utterance re-matched a previously
 * seen (field, value) regex pair → `WARN ios-stale-hint-quirk`.
 *
 * State-fidelity downgrade: fixtures with
 * `initial_state_fidelity: empty_fallback` get their STATE-DEPENDENT
 * strict lanes (gate + forward — both depend on the freshness baseline /
 * job contents) downgraded to WARN; only `session_start`/`hand_authored`
 * fixtures count toward the Wave-4 zero-strict-false-positive gate.
 *
 * LOOSE lanes (LLM-dependent — WARN with thresholds):
 *   - end-of-session applied field/value set (order-insensitive,
 *     trimmed-string canonicalisation)
 *   - question count
 *   - confirmation text SEMANTIC comparison (field+value present, not
 *     verbatim — §8 decision 3)
 *
 * Exit codes: 0 = clean or warns only; 1 = strict-lane FAIL.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const webPath = opt('web');
const iosPath = opt('ios');
if (!webPath || !iosPath) {
  console.error('diff-traces: --web=<trace.json> --ios=<trace.json> required');
  process.exit(2);
}
const web = JSON.parse(fs.readFileSync(webPath, 'utf8'));
const ios = JSON.parse(fs.readFileSync(iosPath, 'utf8'));
const fidelity = ios.initial_state_fidelity ?? 'empty_fallback';
const stateLanesStrict = fidelity === 'session_start' || fidelity === 'hand_authored';

const findings = []; // {lane, level: FAIL|WARN|OK, utterance, detail}
const add = (lane, level, utterance, detail) => findings.push({ lane, level, utterance, detail });

// ── alignment: by order; text sanity-checked (web text is the dispatched
// normalised preview, iOS text is its own normalised form — same ported
// normaliser, so prefix-compare after lowercase/trim) ──
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
const pairs = [];
const webUtts = web.utterances ?? [];
const iosUtts = ios.utterances ?? [];
for (let i = 0; i < Math.max(webUtts.length, iosUtts.length); i++) {
  const w = webUtts[i];
  const g = iosUtts[i];
  if (!w || !g) {
    add('alignment', 'WARN', (w ?? g)?.text ?? `#${i}`, w ? 'web-only utterance' : 'ios-only utterance');
    continue;
  }
  // Web trace text is the RAW dispatched preview; the iOS trace carries
  // BOTH raw + normalised — match against either (same order guarantees
  // hold; this is a sanity check, not the alignment key).
  const a = norm(w.text);
  const candidates = [norm(g.text), norm(g.raw)];
  const matches = candidates.some(
    (b) => a === b || a.startsWith(b.slice(0, 30)) || b.startsWith(a.slice(0, 30))
  );
  if (!matches) {
    add('alignment', 'WARN', w.text, `text mismatch at #${i}: web="${w.text}" ios="${g.text}"`);
  }
  pairs.push({ w, g, i });
}

// ── strict: gate + forward decisions ──
// iOS stale-hint quirk detection needs the running set of previously-seen
// regex (field, value) pairs.
const seenRegex = new Set();
for (const { w, g } of pairs) {
  const gateLevel = stateLanesStrict ? 'FAIL' : 'WARN';
  const iosRematchedStale = (g.regexMatches ?? []).some((m) => seenRegex.has(`${m.field}=${m.value}`));
  for (const m of g.regexMatches ?? []) seenRegex.add(`${m.field}=${m.value}`);

  if (w.gate !== g.gate) {
    if (g.gate === 'passed' && w.gate === 'blocked' && iosRematchedStale) {
      add('gate', 'WARN', w.text, 'ios-stale-hint-quirk: iOS passed via a stale cumulative circuit-hint re-insert (no-equality loop, DeepgramRecordingViewModel.swift:5188-5210) — iOS quirk, not a web regression');
    } else if (g.gate === 'none' || w.gate === 'none') {
      // 'none' = no observable decision on that side (e.g. iOS logs no
      // explicit block for silence-adjacent finals) — evidence gap, WARN.
      add('gate', 'WARN', w.text, `gate evidence gap: web=${w.gate} ios=${g.gate}`);
    } else {
      add('gate', gateLevel, w.text, `gate divergence: web=${w.gate} ios=${g.gate}`);
    }
  } else {
    add('gate', 'OK', w.text, `both ${w.gate}`);
  }

  const webForwarded = Boolean(w.sonnetSent);
  const iosForwarded = Boolean(g.sonnetForwarded);
  if (webForwarded !== iosForwarded && w.gate === g.gate) {
    add('forward', gateLevel, w.text, `forward divergence: web=${webForwarded} ios=${iosForwarded}`);
  }

  // Downstream lanes are strict ONLY when the upstream gate/forward
  // decisions agreed — a derivative divergence (e.g. iOS forwarded
  // chitchat and its orphan produced an ask; web blocked it upstream)
  // must not double-count as a strict FAIL when the root cause was
  // already recorded on the gate lane.
  const upstreamAgreed = w.gate === g.gate && Boolean(w.sonnetSent) === Boolean(g.sonnetForwarded);
  const downstreamLevel = upstreamAgreed && stateLanesStrict ? 'FAIL' : 'WARN';

  // strict: ask-decision class — a circuit-disambiguation ask on one side
  // only. (Web trace records pendingReadingsAsks; iOS asks arrive as
  // question_asked with circuit-ish wording — approximate by count.)
  const webAsks = w.pendingReadingsAsks ?? 0;
  const iosCircuitAsks = (g.questions ?? []).filter((q) => /which circuit/i.test(q)).length;
  if (webAsks !== iosCircuitAsks) {
    add('ask-class', downstreamLevel, w.text, `circuit-disambiguation ask divergence: web=${webAsks} ios=${iosCircuitAsks}`);
  }

  // strict (post-Wave-6): feedback-marker detection parity.
  const webFeedback = (w.feedbackEvents ?? []).length > 0;
  const iosFeedback = (g.feedbackEvents ?? []).length > 0;
  if (webFeedback !== iosFeedback) {
    add('feedback', downstreamLevel, w.text, `feedback-marker divergence: web=${webFeedback} ios=${iosFeedback}`);
  }
}

// ── strict: web TTS invariants from trace totals ──
if ((web.totals?.deferredNeverResumed ?? 0) > 0) {
  add('tts', 'FAIL', '(run)', `${web.totals.deferredNeverResumed} web confirmation(s) permanently deferred`);
}
if ((web.totals?.confirmationsDiscarded ?? 0) > 0) {
  add('tts', 'FAIL', '(run)', `${web.totals.confirmationsDiscarded} web confirmation(s) discarded without replay`);
}

// ── loose: applied field/value set (order-insensitive) ──
const canon = (v) => String(v ?? '').trim();
const webApplied = new Map();
for (const u of webUtts) {
  for (const f of u.appliedFields ?? []) webApplied.set(`${f.key}`, canon(f.value));
}
const iosApplied = new Map();
for (const u of iosUtts) {
  for (const f of u.fieldSets ?? []) iosApplied.set(f.key, canon(f.value));
}
// Keys use different naming (web: section.field / circuits[ref].field;
// iOS: supply.camelCase / circuit.N.key) — compare VALUES loosely: every
// iOS-applied value should appear somewhere in the web applied set.
const webValues = new Set([...webApplied.values()]);
for (const [key, value] of iosApplied) {
  if (!value) continue;
  if (!webValues.has(value)) {
    add('applied-values', 'WARN', key, `iOS applied ${key}=${value}; no web-applied field carries that value`);
  }
}

// ── loose: question count ──
const webQ = webUtts.reduce((n, u) => n + (u.questionsAsked?.length ?? 0), 0);
const iosQ = iosUtts.reduce((n, u) => n + (u.questions?.length ?? 0), 0);
if (webQ !== iosQ) add('questions', 'WARN', '(run)', `question count: web=${webQ} ios=${iosQ}`);

// ── loose: confirmation text semantic (field+value present) ──
const webConfText = (web.totals?.confirmationsPlayed ?? []).join(' | ').toLowerCase();
for (const u of iosUtts) {
  for (const c of u.confirmations ?? []) {
    const valueToken = (c.text.match(/[\d.]+|lim/gi) ?? []).pop();
    if (valueToken && !webConfText.includes(String(valueToken).toLowerCase())) {
      add('confirmation-text', 'WARN', u.text, `iOS spoke "${c.text}" — no web confirmation carries value "${valueToken}"`);
    }
  }
}

// ── report ──
const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');
const lines = [];
lines.push(`# pwa-replay differential — ${ios.session_id ?? '?'}`);
lines.push('');
lines.push(`- fidelity: **${fidelity}** (state-dependent strict lanes ${stateLanesStrict ? 'ENFORCED' : 'downgraded to WARN'})`);
lines.push(`- result: **${fails.length === 0 ? 'PASS' : 'FAIL'}** — ${fails.length} strict fail(s), ${warns.length} warn(s)`);
lines.push('');
lines.push('| # | utterance | lane | level | detail |');
lines.push('|---|-----------|------|-------|--------|');
findings
  .filter((f) => f.level !== 'OK')
  .forEach((f, i) =>
    lines.push(`| ${i + 1} | ${String(f.utterance).slice(0, 40)} | ${f.lane} | ${f.level} | ${f.detail} |`)
  );
const md = lines.join('\n') + '\n';
const outMd = opt('out');
if (outMd) fs.writeFileSync(outMd, md);
const outJson = opt('json');
if (outJson) fs.writeFileSync(outJson, JSON.stringify({ fidelity, findings }, null, 2));
console.log(md);
process.exit(fails.length === 0 ? 0 : 1);
