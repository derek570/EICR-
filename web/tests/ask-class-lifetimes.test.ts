/**
 * PLAN-CD (feedback-2026-09-17 wave; Decision 22) — the CD2 ask-class
 * classifier and the unresolved-backend-ask authority.
 *
 * `config/ask-class-lifetimes-v1.json` is the ONLY statement of the rule.
 * Every expectation below is READ from that file: this test carries no id
 * prefix and no lifetime literal of its own, so a test that passes proves the
 * classifier implements the fixture rather than a second copy of it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASK_CLASS_LIFETIMES,
  ASK_CLASS_LIFETIMES_DIGEST,
} from '@/lib/recording/ask-class-lifetimes-v1.generated';
import { UnresolvedAskAuthority, classifyAskId } from '@/lib/recording/unresolved-ask-authority';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '..', 'config', 'ask-class-lifetimes-v1.json');

type Fixture = {
  rows: Array<{ prefix: string; class: string; lifetime_ms: number }>;
  default: { class: string; lifetime_ms: number };
  vectors: Array<{
    id: string;
    tool_call_id: string;
    expect_class: string;
    expect_lifetime_ms: number;
  }>;
};
const fixture = require('../../config/ask-class-lifetimes-v1.json') as Fixture;
const vector = (id: string) => {
  const v = fixture.vectors.find((x) => x.id === id);
  if (!v) throw new Error(`fixture has no vector ${id}`);
  return v;
};

describe('ask-class-lifetimes fixture — cross-platform pins', () => {
  /** Cross-repo contract pin. CertMateUnified's bundled copy is asserted
   *  against the SAME hex constant by its own suite, so an edit to either
   *  copy alone fails one side. When the fixture legitimately changes: edit
   *  it, run `node scripts/generate-ask-class-lifetimes-module.mjs`, copy it
   *  to `CertMateUnified/Sources/Resources/`, and update BOTH constants. */
  it('fixture bytes match the pinned cross-platform digest', () => {
    const digest = createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex');
    expect(digest).toBe('b682bed1d1b099651ba39b6adce29c5d9d91d573fc9aae55e7f9ad04461c654f');
  });

  it('the generated web module carries the fixture bytes and its digest', () => {
    const digest = createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex');
    expect(ASK_CLASS_LIFETIMES_DIGEST).toBe(digest);
    expect(JSON.parse(JSON.stringify(ASK_CLASS_LIFETIMES))).toEqual(fixture);
  });

  it('no hand-written web source carries a prefix or a lifetime literal', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'recording', 'unresolved-ask-authority.ts'),
      'utf8'
    );
    for (const row of fixture.rows) expect(src).not.toContain(`'${row.prefix}'`);
    const lifetimes = new Set([
      ...fixture.rows.map((r) => r.lifetime_ms),
      fixture.default.lifetime_ms,
    ]);
    for (const ms of lifetimes) {
      expect(src).not.toMatch(new RegExp(`\\b${ms}\\b`));
      expect(src).not.toMatch(new RegExp(`\\b${ms.toLocaleString('en-US').replace(/,/g, '_')}\\b`));
    }
  });
});

describe('classifyAskId walks the fixture vectors (guard obligation 4)', () => {
  for (const v of fixture.vectors) {
    it(`${v.id}: "${v.tool_call_id}" → ${v.expect_class} / ${v.expect_lifetime_ms}`, () => {
      expect(classifyAskId(v.tool_call_id)).toEqual({
        askClass: v.expect_class,
        lifetimeMs: v.expect_lifetime_ms,
      });
    });
  }
});

describe('UnresolvedAskAuthority — Decision 18', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('interactive-only admission: an expected_answer_shape "none" frame never latches', () => {
    const c = clock();
    const a = new UnresolvedAskAuthority(c.now);
    expect(a.latch(vector('script_srv_rcs_slot').tool_call_id, 'none')).toBe(false);
    expect(a.hasLive()).toBe(false);
    expect(a.latch(vector('script_srv_rcs_slot').tool_call_id, 'free_text')).toBe(true);
    expect(a.hasLive()).toBe(true);
    // No id → no entry (nothing could ever answer or cancel it by id).
    expect(a.latch(null, 'free_text')).toBe(false);
    expect(a.latch('', 'free_text')).toBe(false);
  });

  it('is a SET: a second ask never drops the first', () => {
    const c = clock();
    const a = new UnresolvedAskAuthority(c.now);
    a.latch(vector('live_openai_call').tool_call_id, 'free_text');
    a.latch(vector('broker_mdr').tool_call_id, 'free_text');
    a.resolve(vector('broker_mdr').tool_call_id);
    expect(a.liveEntries().map((e) => e.toolCallId)).toEqual([
      vector('live_openai_call').tool_call_id,
    ]);
  });

  it('clears on answer (resolve or the answered-set screen), cancellation by prefix, and reset — reading consumes nothing', () => {
    const c = clock();
    const a = new UnresolvedAskAuthority(c.now);
    const script = vector('script_srv_ocpd_which').tool_call_id;
    const dispatcher = vector('live_openai_call').tool_call_id;
    a.latch(script, 'free_text');
    a.latch(dispatcher, 'free_text');
    // Non-consuming: repeated reads leave both entries live.
    expect(a.hasLive()).toBe(true);
    expect(a.hasLive()).toBe(true);
    expect(a.liveEntries()).toHaveLength(2);
    // The answered-set screen clears an answered id.
    expect(a.liveEntries((id) => id === dispatcher).map((e) => e.toolCallId)).toEqual([script]);
    // Cancellation by the backend's `cancel_pending_tts` prefix.
    a.cancelByPrefix(script.slice(0, script.indexOf('-', 4) + 1));
    expect(a.hasLive()).toBe(false);
    a.latch(dispatcher, 'free_text');
    a.reset();
    expect(a.hasLive()).toBe(false);
  });

  it('a re-emitted id keeps its ORIGINAL latch time', () => {
    const c = clock();
    const a = new UnresolvedAskAuthority(c.now);
    const id = vector('live_openai_call').tool_call_id;
    a.latch(id, 'free_text');
    const first = a.liveEntries()[0];
    c.advance(first.lifetimeMs - 10);
    a.latch(id, 'free_text');
    c.advance(10);
    expect(a.hasLive()).toBe(false);
  });

  // The backend-equivalent timeout, per class, as ELAPSED TIME. The lifetime
  // is read from the latched entry at test time, never written here.
  for (const v of fixture.vectors.filter((x) => x.tool_call_id !== '')) {
    it(`${v.id}: live one tick before the entry's lifetime, empty one tick after`, () => {
      const c = clock();
      const a = new UnresolvedAskAuthority(c.now);
      a.latch(v.tool_call_id, 'free_text');
      const [entry] = a.liveEntries();
      expect(entry.askClass).toBe(v.expect_class);
      expect(entry.lifetimeMs).toBe(v.expect_lifetime_ms);
      c.advance(entry.lifetimeMs - 1);
      expect(a.hasLive()).toBe(true);
      c.advance(2);
      expect(a.hasLive()).toBe(false);
    });
  }
});
