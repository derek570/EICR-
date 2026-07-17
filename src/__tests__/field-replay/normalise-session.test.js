/**
 * normalise-session.test.js — source adapters, TOTAL event ordering, UTC
 * parsing, and chime→turn correlation boundaries (plan Item 1 architecture
 * bullet). All fixtures are SANITIZED structural replicas — symbolic
 * session ids, synthetic text, no raw capture content.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  CHIME_CORRELATION_MAX_MS,
  parseUtcTimestamp,
  makeSource,
  normaliseSources,
  correlateChimes,
} from '../../../scripts/field-replay/lib/normalise-session.mjs';
import {
  computeSessionSourceFreshness,
  computeSourceVerdict,
  linkDebugReport,
  FRESHNESS_STATUS,
  ISSUE_PREFIX_CHARS,
} from '../../../scripts/field-replay/lib/source-freshness.mjs';

const T0 = Date.UTC(2026, 0, 10, 6, 11, 42); // fixture epoch (no real capture date)
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

function cwRow(obj) {
  return JSON.stringify(obj);
}

function cwSource(rows, pathName = 'cw.jsonl') {
  return makeSource({
    type: 'cloudwatch',
    role: 'primary',
    path: pathName,
    bytes: Buffer.from(rows.join('\n') + '\n', 'utf8'),
  });
}

const chimeRow = (ms, extra = {}) =>
  cwRow({
    timestamp: iso(ms),
    message: 'Client diagnostic',
    category: 'chime_invoke',
    sessionId: 'sym_session_1',
    branch: 'confirmation',
    ...extra,
  });
const transcriptRow = (ms, text = 'synthetic transcript', extra = {}) =>
  cwRow({
    timestamp: iso(ms),
    message: 'transcript',
    sessionId: 'sym_session_1',
    text,
    ...extra,
  });

describe('parseUtcTimestamp', () => {
  test('timezone-free second-resolution strings parse as UTC', () => {
    expect(parseUtcTimestamp('2026-01-10 06:11:42')).toBe(T0);
    expect(parseUtcTimestamp('2026-01-10T06:11:42')).toBe(T0);
  });
  test('explicit zones are trusted', () => {
    expect(parseUtcTimestamp('2026-01-10T06:11:42Z')).toBe(T0);
    expect(parseUtcTimestamp('2026-01-10T07:11:42+01:00')).toBe(T0);
  });
  test('epoch numbers pass through (s and ms)', () => {
    expect(parseUtcTimestamp(T0)).toBe(T0);
    expect(parseUtcTimestamp(Math.floor(T0 / 1000))).toBe(T0);
  });
  test('vectors are TZ-independent: identical under TZ=UTC and TZ=Europe/London (incl. DST date)', () => {
    // Node latches TZ at startup, so the cross-TZ vector runs as a
    // subprocess per zone. A BST (DST) date is included — the exact case a
    // host-timezone parse would shift by an hour.
    const script = `
      import { parseUtcTimestamp } from '${path
        .resolve('scripts/field-replay/lib/normalise-session.mjs')
        .replace(/\\/g, '/')}';
      console.log(parseUtcTimestamp('2026-07-16 06:11:42'), parseUtcTimestamp('2026-01-10 06:11:42'));
    `;
    const run = (tz) =>
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      }).trim();
    expect(run('UTC')).toBe(run('Europe/London'));
  });
});

describe('adapters + total ordering', () => {
  test('the reference chime shape (top-level Client diagnostic + chime_invoke) maps to kind chime with branch retained', () => {
    const events = normaliseSources([cwSource([chimeRow(T0)])]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('chime');
    expect(events[0].branch).toBe('confirmation');
    expect(events[0].timestamp_ms).toBe(T0);
  });
  test('nested Client-log-batch envelopes unwrap to client_event', () => {
    const row = cwRow({
      timestamp: iso(T0),
      message: 'Client log batch entry',
      sessionId: 'sym_session_1',
      client_log: { category: 'playback', event: 'observation_deduped', data: { id: 'sym_obs_1' } },
    });
    const events = normaliseSources([cwSource([row])]);
    expect(events[0].kind).toBe('client_event');
    expect(events[0].event).toBe('observation_deduped');
  });
  test('byte-identical duplicate sources are REJECTED', () => {
    const rows = [chimeRow(T0)];
    const a = cwSource(rows, 'a.jsonl');
    const b = cwSource(rows, 'b.jsonl');
    expect(() => normaliseSources([a, b])).toThrow(/duplicate source rejected/);
  });
  test('total ordering is CLI-argument-order independent for same-type equal-timestamp equal-row sources', () => {
    // Two debug reports (same type ⇒ same priority) with EQUAL timestamps
    // and equal (single-row) indexes — only the private fingerprint breaks
    // the tie, so both argument orders must produce the same order.
    const repA = makeSource({
      type: 'debug_report',
      role: 'supporting',
      path: 'rep-a.json',
      bytes: Buffer.from(JSON.stringify({ timestamp: iso(T0), description: 'alpha report' })),
    });
    const repB = makeSource({
      type: 'debug_report',
      role: 'supporting',
      path: 'rep-b.json',
      bytes: Buffer.from(JSON.stringify({ timestamp: iso(T0), description: 'bravo report' })),
    });
    const order1 = normaliseSources([repA, repB]).map((e) => e.description);
    const order2 = normaliseSources([repB, repA]).map((e) => e.description);
    expect(order1).toEqual(order2);
  });
  test('priority orders cloudwatch(0) < ios(1) < debug_report(2) at equal timestamps', () => {
    const cw = cwSource([transcriptRow(T0)]);
    const ios = makeSource({
      type: 'ios',
      role: 'supporting',
      path: 'ios.jsonl',
      bytes: Buffer.from(
        JSON.stringify({ timestamp: iso(T0), event: 'tts_played', category: 'playback', data: {} }) + '\n',
      ),
    });
    const rep = makeSource({
      type: 'debug_report',
      role: 'supporting',
      path: 'rep.json',
      bytes: Buffer.from(JSON.stringify({ timestamp: iso(T0), description: 'x' })),
    });
    const events = normaliseSources([rep, ios, cw]);
    expect(events.map((e) => e.source_type)).toEqual(['cloudwatch', 'ios', 'debug_report']);
  });
});

describe('chime→turn correlation (fallback interval, EXCLUSIVE bound)', () => {
  const MAX = CHIME_CORRELATION_MAX_MS;

  function correlate(rows) {
    const events = normaliseSources([cwSource(rows)]);
    return correlateChimes(events);
  }

  test('pinned constant', () => {
    expect(MAX).toBe(15000);
  });
  test('interval−1 correlates', () => {
    const { correlations, failures } = correlate([chimeRow(T0), transcriptRow(T0 + MAX - 1)]);
    expect(failures).toEqual([]);
    expect(correlations).toHaveLength(1);
    expect(correlations[0].method).toBe('interval');
    expect(correlations[0].branch).toBe('confirmation');
  });
  test('exactly-at the bound does NOT correlate (exclusive; conversion failure)', () => {
    const { correlations, failures } = correlate([chimeRow(T0), transcriptRow(T0 + MAX)]);
    expect(correlations).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe('no_candidate');
  });
  test('interval+1 does not correlate', () => {
    const { failures } = correlate([chimeRow(T0), transcriptRow(T0 + MAX + 1)]);
    expect(failures).toHaveLength(1);
  });
  test('a transcript after the NEXT chime does not correlate to the first chime', () => {
    const { correlations, failures } = correlate([
      chimeRow(T0),
      chimeRow(T0 + 2000),
      transcriptRow(T0 + 3000),
    ]);
    // First chime: its only in-window transcript sits after the following
    // chime → failure. Second chime: the transcript correlates.
    expect(failures).toHaveLength(1);
    expect(correlations).toHaveLength(1);
    expect(correlations[0].chime.timestamp_ms).toBe(T0 + 2000);
  });
  test('final chime is bounded by the interval alone (no following chime required)', () => {
    const { correlations } = correlate([chimeRow(T0), transcriptRow(T0 + 5000)]);
    expect(correlations).toHaveLength(1);
  });
  test('same-second chime/transcript correlates by total order (quantisation absorbed by the bound, never reordering)', () => {
    const { correlations, failures } = correlate([chimeRow(T0), transcriptRow(T0)]);
    expect(failures).toEqual([]);
    expect(correlations).toHaveLength(1);
  });
  test('two candidate transcripts = ambiguity = conversion failure (never a guess)', () => {
    const { correlations, failures } = correlate([
      chimeRow(T0),
      transcriptRow(T0 + 2000, 'first'),
      transcriptRow(T0 + 4000, 'second'),
    ]);
    expect(correlations).toEqual([]);
    expect(failures[0].reason).toBe('ambiguous_candidates');
    expect(failures[0].candidate_count).toBe(2);
  });
  test('identifier join wins over the interval fallback', () => {
    const rows = [
      chimeRow(T0, { utteranceId: 'sym_utt_9' }),
      transcriptRow(T0 + 60000, 'far away but same utterance', { utteranceId: 'sym_utt_9' }),
    ];
    const { correlations, failures } = correlate(rows);
    expect(failures).toEqual([]);
    expect(correlations[0].method).toBe('identifier');
  });
  test('cross-session transcripts never correlate', () => {
    const { failures } = correlate([
      chimeRow(T0),
      transcriptRow(T0 + 1000, 'other session', { sessionId: 'sym_session_2' }),
    ]);
    expect(failures).toHaveLength(1);
  });
});

describe('source freshness (recomputed from bytes, fail-closed)', () => {
  const primaryWindow = { min: T0, max: T0 + 30 * 60 * 1000 };

  test('overlapping capture with the session identity is fresh', () => {
    const events = normaliseSources([cwSource([transcriptRow(T0 + 1000)])]);
    const v = computeSessionSourceFreshness({
      events,
      expectedSessionId: 'sym_session_1',
      primaryWindow,
    });
    expect(v.status).toBe(FRESHNESS_STATUS.FRESH);
  });
  test('the stale-upload class: a source whose window predates the primary computes stale', () => {
    const staleMs = T0 - 60 * 24 * 60 * 60 * 1000; // two months earlier
    const events = normaliseSources([cwSource([transcriptRow(staleMs)])]);
    const v = computeSessionSourceFreshness({
      events,
      expectedSessionId: 'sym_session_1',
      primaryWindow,
    });
    expect(v.status).toBe(FRESHNESS_STATUS.STALE);
    expect(v.reason).toMatch(/stale upload/);
  });
  test('missing session identity fails closed', () => {
    const events = normaliseSources([
      cwSource([cwRow({ timestamp: iso(T0), message: 'transcript', text: 'no session id' })]),
    ]);
    const v = computeSessionSourceFreshness({
      events,
      expectedSessionId: 'sym_session_1',
      primaryWindow,
    });
    expect(v.status).toBe(FRESHNESS_STATUS.MISSING_IDENTITY);
  });
});

describe('debug-report linkage (100-char issue-prefix algorithm)', () => {
  // Five sanitized, structurally equivalent replicas of the real report/
  // event pairs: the 100-character-prefix boundary cases PRESERVED (short,
  // exactly-100, >100 with divergent tails), plus zero-match and
  // ambiguous-prefix failure cases.
  const longBase = 'D'.repeat(ISSUE_PREFIX_CHARS);
  const reports = [
    { desc: 'short issue text', label: 'short' },
    { desc: 'E'.repeat(ISSUE_PREFIX_CHARS), label: 'exact-100' },
    { desc: `${longBase} tail A differs beyond the boundary`, label: 'long-a' },
  ];

  function uploadEvent(ms, desc, extra = {}) {
    return cwRow({
      timestamp: iso(ms),
      message: 'Client log batch entry',
      sessionId: 'sym_session_1',
      client_log: {
        category: 'feedback',
        event: 'debug_report_uploaded',
        data: { description: desc.slice(0, ISSUE_PREFIX_CHARS) },
      },
      ...extra,
    });
  }

  function reportEvent(desc, ms = T0 + 1000) {
    const src = makeSource({
      type: 'debug_report',
      role: 'supporting',
      path: 'rep.json',
      bytes: Buffer.from(JSON.stringify({ timestamp: iso(ms), description: desc })),
    });
    return normaliseSources([src])[0];
  }

  test('each replica links to EXACTLY one upload event (full-description equality would zero-match the >100 cases)', () => {
    for (const r of reports) {
      const primary = normaliseSources([
        cwSource([uploadEvent(T0 + 500, r.desc), uploadEvent(T0 + 700, `unrelated ${r.label}`)]),
      ]);
      const link = linkDebugReport(reportEvent(r.desc), primary);
      expect(link.ok).toBe(true);
      expect(link.sessionId).toBe('sym_session_1');
    }
  });
  test('a >100-char report whose PREFIX matches links even though the tail differs from the stored event text', () => {
    const primary = normaliseSources([cwSource([uploadEvent(T0 + 500, `${longBase} stored tail`)])]);
    const link = linkDebugReport(reportEvent(`${longBase} report-side tail (different)`), primary);
    expect(link.ok).toBe(true);
  });
  test('zero matches FAIL', () => {
    const primary = normaliseSources([cwSource([uploadEvent(T0 + 500, 'a different issue')])]);
    const link = linkDebugReport(reportEvent('no such upload'), primary);
    expect(link).toMatchObject({ ok: false, reason: 'zero_matches', matches: 0 });
  });
  test('ambiguous prefixes (two events sharing the 100-char prefix in-window) FAIL', () => {
    const primary = normaliseSources([
      cwSource([uploadEvent(T0 + 500, `${longBase} x`), uploadEvent(T0 + 900, `${longBase} y`)]),
    ]);
    const link = linkDebugReport(reportEvent(`${longBase} anything`), primary);
    expect(link).toMatchObject({ ok: false, reason: 'ambiguous_matches', matches: 2 });
  });
  test('out-of-window events do not match (bounded timestamp)', () => {
    const primary = normaliseSources([cwSource([uploadEvent(T0 + 60 * 60 * 1000, 'short issue text')])]);
    const link = linkDebugReport(reportEvent('short issue text', T0), primary);
    expect(link.ok).toBe(false);
  });
  test('computeSourceVerdict: an unlinked report fails closed; a linked one binds the session', () => {
    const primary = normaliseSources([cwSource([uploadEvent(T0 + 500, 'short issue text')])]);
    const src = makeSource({
      type: 'debug_report',
      role: 'supporting',
      path: 'rep.json',
      bytes: Buffer.from(JSON.stringify({ timestamp: iso(T0 + 1000), description: 'short issue text' })),
    });
    const events = normaliseSources([src]);
    const ok = computeSourceVerdict({ source: src, events, expectedSessionId: 'sym_session_1', primaryEvents: primary });
    expect(ok.status).toBe(FRESHNESS_STATUS.FRESH);
    expect(ok.boundSessionId).toBe('sym_session_1');
    const bad = computeSourceVerdict({ source: src, events, expectedSessionId: 'sym_session_2', primaryEvents: primary });
    expect(bad.status).toBe(FRESHNESS_STATUS.STALE);
  });
});
