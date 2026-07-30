/**
 * Plan 2A §5 — partial-failure notices (feedback id 112).
 *
 * The defect class: a turn where SOME targets landed and others were rejected
 * or silently skipped spoke ONLY the successes. "Zs for circuits 5 to 10 is
 * 0.4" on a board where 7 and 8 do not exist read back four values and said
 * NOTHING about the two misses — the inspector walks away believing six
 * circuits were recorded. Audio-First #1 in the zero-times direction, and
 * invisible to a hands-free inspector by construction.
 *
 * Two blocks:
 *
 *   BLOCK A — pure unit over `refusal-notices.js`: wording families, target
 *   grammar, rotation, staging guards, canonical field folding, and the
 *   inventory distinctness sweep. No harness, no mocks.
 *
 *   BLOCK B — the harness SEAM. `runToolLoop` is mocked so the test drives the
 *   REAL composed dispatcher (`opts.dispatcher`), which means capability
 *   threading, validation ORDER, the four producer channels, the arbitration
 *   against `allRejected` and the net-0-adjacent drain all run end-to-end
 *   exactly as production composes them. Copied from
 *   `stage6-honest-refusal.test.js` — the same idiom, for the same reason: a
 *   unit test of the drain in isolation would not catch a producer staging a
 *   target the drain then cannot subtract.
 *
 * Channel 3 (`ask_user` fan-out `resolved_writes`) is NOT reachable here —
 * `createAskDispatcher` is mocked out at this seam — and lives in the
 * companion file `stage6-partial-failure-notices-ask.test.js`.
 */

import { jest } from '@jest/globals';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const FIELD_SCHEMA = require_('../../config/field_schema.json');
/** Server-owned spoken label — the ONLY string a notice may render for a field. */
const label = (field) => FIELD_SCHEMA.circuit_fields[field].label;

const SESSION_ID = 'sess-partial-failure';

// ───────────────────────────────────────────────────────────────────────────
// BLOCK A — pure unit (no mocks needed; imported statically)
// ───────────────────────────────────────────────────────────────────────────

const {
  PARTIAL_FAILURE_FAMILIES,
  PARTIAL_FAILURE_TERMINALS,
  PARTIAL_FAILURE_SCOPE_FAMILIES,
  NOTICE_FIELD_IDENTITY_EXEMPT,
  canonicalPartialFailureFieldIdentity,
  describePartialFailureTargets,
  selectPartialFailureNoticeText,
  stagePartialFailureNotice,
  renderPartialFailureNoticeText,
  renderedNoticeInventory,
  resolvePartialFailureFieldLabel,
} = await import('../extraction/refusal-notices.js');
const { CLEAR_WIRE_EXEMPT } = await import('../extraction/stage6-event-bundler.js');
const { createPerTurnWrites } = await import('../extraction/stage6-per-turn-writes.js');

const circuitTarget = (ref) => ({ kind: 'circuit', ref });
const SCOPE_TARGET = { kind: 'scope' };

/** The §3.1 gap-only PRIMARY render for a (reason, targets, field) triple. */
function primaryText(reason, targets, fieldLabel) {
  const descriptor = describePartialFailureTargets(targets, fieldLabel);
  return PARTIAL_FAILURE_FAMILIES[reason][0](descriptor);
}
/** Every variant of a family for the same triple (order-insensitive matching). */
function variantTexts(reason, targets, fieldLabel) {
  const descriptor = describePartialFailureTargets(targets, fieldLabel);
  return PARTIAL_FAILURE_FAMILIES[reason].map((f) => f(descriptor));
}
/** The descriptor for a set of circuit refs at the default headline label. */
function descriptorFor(refs, fieldLabel = label('measured_zs_ohm')) {
  return describePartialFailureTargets(refs.map(circuitTarget), fieldLabel);
}

describe('§5.A1 — wording families', () => {
  test('every family carries ≥3 byte-distinct variants and renders a non-empty string', () => {
    const reasons = Object.keys(PARTIAL_FAILURE_FAMILIES);
    expect(reasons.length).toBeGreaterThanOrEqual(4);
    for (const reason of reasons) {
      const rendered = variantTexts(reason, [circuitTarget(7)], label('measured_zs_ohm'));
      expect(rendered.length).toBeGreaterThanOrEqual(3);
      expect(new Set(rendered).size).toBe(rendered.length);
      for (const text of rendered) expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  test('variant 0 is the gap-only primary — it names the miss and never restates a success', () => {
    // The successful siblings are read back individually; repeating them here
    // would bury the one thing the inspector cannot otherwise discover.
    const text = primaryText(
      'circuit_not_found',
      [circuitTarget(7), circuitTarget(8)],
      label('measured_zs_ohm')
    );
    expect(text).toBe(
      "Circuits 7 and 8 weren't found — no Measured Zs (ohm) recorded for them."
    );
  });

  test('the field label is ALWAYS the server-owned schema label (leak safety)', () => {
    // A notice never renders a model-supplied string. Every family interpolates
    // `fieldLabel`, which producers may only source from field_schema.json.
    for (const reason of Object.keys(PARTIAL_FAILURE_FAMILIES)) {
      for (const text of variantTexts(reason, [circuitTarget(3)], label('r1_r2_ohm'))) {
        expect(text).toContain('R1+R2 (ohm)');
      }
    }
  });
});

describe('§5.A2 — describePartialFailureTargets', () => {
  test('singular / plural / three-ref grammar', () => {
    const one = describePartialFailureTargets([circuitTarget(7)], 'X');
    expect(one).toMatchObject({ subject: 'Circuit 7', wasWere: "wasn't", pronoun: 'it' });
    const two = describePartialFailureTargets([circuitTarget(7), circuitTarget(8)], 'X');
    expect(two).toMatchObject({ subject: 'Circuits 7 and 8', wasWere: "weren't", pronoun: 'them' });
    const three = describePartialFailureTargets(
      [circuitTarget(7), circuitTarget(8), circuitTarget(11)],
      'X'
    );
    expect(three.subject).toBe('Circuits 7, 8 and 11');
  });

  test('refs are deduped and ASCENDING regardless of staging order', () => {
    // The same miss-set must speak the same BYTES whatever order the
    // dispatcher happened to reject in, or the clients' 30 s text dedupe stops
    // recognising a genuine repeat as a repeat.
    const forward = describePartialFailureTargets(
      [circuitTarget(7), circuitTarget(8), circuitTarget(11)],
      'X'
    );
    const shuffled = describePartialFailureTargets(
      [circuitTarget(11), circuitTarget(7), circuitTarget(8), circuitTarget(7)],
      'X'
    );
    expect(shuffled).toEqual(forward);
  });

  test('a scope-only target speaks "those circuits"; a mixed list prefers the refs', () => {
    expect(describePartialFailureTargets([SCOPE_TARGET], 'X')).toMatchObject({
      subject: 'Those circuits',
      pronoun: 'them',
    });
    // Refs are strictly more informative than the scope phrasing.
    expect(describePartialFailureTargets([SCOPE_TARGET, circuitTarget(4)], 'X').subject).toBe(
      'Circuit 4'
    );
  });

  test('returns null when nothing can be named honestly', () => {
    expect(describePartialFailureTargets([], 'X')).toBeNull();
    expect(describePartialFailureTargets([{ kind: 'circuit' }], 'X')).toBeNull();
    expect(describePartialFailureTargets([circuitTarget(4)], '')).toBeNull();
    expect(describePartialFailureTargets(null, 'X')).toBeNull();
  });
});

describe('§5.A3 — variant selection: primary-first, then strictly monotonic', () => {
  test('first selection per family is variant 0, then advances by one and wraps', () => {
    const session = {};
    const target = describePartialFailureTargets([circuitTarget(7)], 'X');
    const variants = PARTIAL_FAILURE_FAMILIES.circuit_not_found;
    const seen = [];
    for (let i = 0; i < variants.length + 1; i++) {
      seen.push(selectPartialFailureNoticeText(session, 'circuit_not_found', target));
    }
    expect(seen[0]).toBe(variants[0](target));
    expect(seen[1]).toBe(variants[1](target));
    expect(seen[2]).toBe(variants[2](target));
    // Wraps — never two byte-identical lines back to back inside the client
    // dedupe window, which is what would turn a repeat into SILENCE.
    expect(seen[3]).toBe(variants[0](target));
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  test('families rotate INDEPENDENTLY and never touch A1a’s cursor', () => {
    const session = {};
    const target = describePartialFailureTargets([circuitTarget(7)], 'X');
    selectPartialFailureNoticeText(session, 'circuit_not_found', target);
    selectPartialFailureNoticeText(session, 'circuit_not_found', target);
    const first = selectPartialFailureNoticeText(session, 'write_failed', target);
    expect(first).toBe(PARTIAL_FAILURE_FAMILIES.write_failed[0](target));
    expect(session._partialFailureRotation).toEqual({ circuit_not_found: 1, write_failed: 0 });
    // Plan A1a's own cursor is a DIFFERENT key — its byte-parity pins must not
    // be perturbed by a partial-failure notice on the same session.
    expect(session._mandatoryNoticeRotation).toBeUndefined();
  });

  test('an unknown family or a null target selects nothing', () => {
    const session = {};
    expect(selectPartialFailureNoticeText(session, 'nope', { subject: 'x' })).toBeNull();
    expect(selectPartialFailureNoticeText(session, 'write_failed', null)).toBeNull();
  });
});

describe('§5.A4 — stagePartialFailureNotice: guards + aggregation', () => {
  const spec = (over = {}) => ({
    reason: 'circuit_not_found',
    field: 'measured_zs_ohm',
    fieldLabel: label('measured_zs_ohm'),
    boardId: null,
    target: circuitTarget(7),
    producer: 'test',
    ...over,
  });

  test('aggregates by (reason, canonical field, board) and retains per-target refs', () => {
    const ptw = createPerTurnWrites();
    stagePartialFailureNotice(ptw, spec({ target: circuitTarget(8) }));
    stagePartialFailureNotice(ptw, spec({ target: circuitTarget(7) }));
    expect(ptw.partialFailureNotices).toHaveLength(1);
    expect(ptw.partialFailureNotices[0]).toMatchObject({
      noticeKind: 'partial_failure',
      reason: 'circuit_not_found',
      field: 'zs',
      boardId: null,
      targets: [circuitTarget(8), circuitTarget(7)],
    });
  });

  test('the same target twice does not duplicate inside one aggregate', () => {
    const ptw = createPerTurnWrites();
    stagePartialFailureNotice(ptw, spec());
    stagePartialFailureNotice(ptw, spec());
    expect(ptw.partialFailureNotices[0].targets).toEqual([circuitTarget(7)]);
  });

  test('different reason / different field / different board never merge', () => {
    const ptw = createPerTurnWrites();
    stagePartialFailureNotice(ptw, spec());
    stagePartialFailureNotice(ptw, spec({ reason: 'write_failed' }));
    stagePartialFailureNotice(ptw, spec({ field: 'r1_r2_ohm', fieldLabel: label('r1_r2_ohm') }));
    stagePartialFailureNotice(ptw, spec({ boardId: 'sub-1' }));
    expect(ptw.partialFailureNotices).toHaveLength(4);
    expect(new Set(ptw.partialFailureNotices.map((n) => n.key)).size).toBe(4);
  });

  test('rejects a malformed spec rather than staging an unspeakable notice', () => {
    const ptw = createPerTurnWrites();
    stagePartialFailureNotice(ptw, spec({ reason: 'not_a_family' }));
    stagePartialFailureNotice(ptw, spec({ field: '' }));
    stagePartialFailureNotice(ptw, spec({ field: 42 }));
    stagePartialFailureNotice(ptw, spec({ fieldLabel: '   ' }));
    stagePartialFailureNotice(ptw, spec({ fieldLabel: undefined }));
    stagePartialFailureNotice(ptw, spec({ target: null }));
    stagePartialFailureNotice(ptw, spec({ target: { kind: 'ordinal', ref: 2 } }));
    stagePartialFailureNotice(ptw, spec({ target: { kind: 'circuit', ref: '7' } }));
    stagePartialFailureNotice(ptw, spec({ target: { kind: 'circuit', ref: 7.5 } }));
    stagePartialFailureNotice(ptw, undefined);
    expect(ptw.partialFailureNotices).toHaveLength(0);
  });

  test('no-ops (never throws) when the accumulator is absent', () => {
    expect(() => stagePartialFailureNotice(null, spec())).not.toThrow();
    expect(() => stagePartialFailureNotice({}, spec())).not.toThrow();
  });

  test('a SCOPE target is accepted only on a scope-eligible family', () => {
    // `circuit_not_found` variant 2 asserts something about the board that
    // would be a LIE for a whole-instruction refusal, so the guard lives here
    // rather than trusting every future producer to remember.
    const ptw = createPerTurnWrites();
    stagePartialFailureNotice(ptw, spec({ target: SCOPE_TARGET }));
    expect(ptw.partialFailureNotices).toHaveLength(0);
    stagePartialFailureNotice(
      ptw,
      spec({ reason: 'lim_capability_gated', target: SCOPE_TARGET })
    );
    expect(ptw.partialFailureNotices).toHaveLength(1);
    expect([...PARTIAL_FAILURE_SCOPE_FAMILIES]).toEqual(['lim_capability_gated']);
  });
});

describe('§5.A5 — canonical field identity (the drain’s subtraction key)', () => {
  test('folds dialogue-slot aliases and legacy wire names onto one identity', () => {
    // rcd_trip_time is the dialogue-slot alias of rcd_time_ms; both must land
    // on ONE identity or an alias-spelled retry would fail to subtract and the
    // inspector would hear a FALSE "not recorded" over a value that did land.
    expect(canonicalPartialFailureFieldIdentity('rcd_time_ms')).toBe(
      canonicalPartialFailureFieldIdentity('rcd_trip_time')
    );
    expect(canonicalPartialFailureFieldIdentity('measured_zs_ohm')).toBe('zs');
    expect(canonicalPartialFailureFieldIdentity('r1_r2_ohm')).toBe('r1_plus_r2');
  });

  test('staging stores the CANONICAL field so no call site can forget to fold', () => {
    const ptw = createPerTurnWrites();
    stagePartialFailureNotice(ptw, {
      reason: 'circuit_not_found',
      field: 'rcd_time_ms',
      fieldLabel: label('rcd_time_ms'),
      boardId: null,
      target: circuitTarget(4),
      producer: 'test',
    });
    expect(ptw.partialFailureNotices[0].field).toBe(
      canonicalPartialFailureFieldIdentity('rcd_time_ms')
    );
  });

  test('is total — an unknown or non-string field passes through unchanged', () => {
    expect(canonicalPartialFailureFieldIdentity('not_a_field')).toBe('not_a_field');
    expect(canonicalPartialFailureFieldIdentity('')).toBe('');
    expect(canonicalPartialFailureFieldIdentity(undefined)).toBeUndefined();
  });

  test('DRIFT LOCK — the exemption set matches the bundler’s CLEAR_WIRE_EXEMPT twin', () => {
    // P5's `r2_ohm` exemption exists because canonicalising it to `r2` would
    // MIS-address R1+R2. The notice identity must exempt exactly the same
    // members or a notice and its write would key differently.
    expect([...NOTICE_FIELD_IDENTITY_EXEMPT].sort()).toEqual([...CLEAR_WIRE_EXEMPT].sort());
    expect(canonicalPartialFailureFieldIdentity('r2_ohm')).toBe('r2_ohm');
  });
});

describe('§5.A5b — resolvePartialFailureFieldLabel: RAW first, canonical only as fallback', () => {
  // Codex diff-review cycle 1 (lens 2) proposed canonicalising BEFORE the label
  // lookup. These tests exist because that would have silenced the headline
  // id-112 utterance: canonicalisation is not label-preserving and loses far
  // more labels than it gains.
  const circuitFields = FIELD_SCHEMA.circuit_fields;

  test('the headline field keeps its RAW label — canonicalising first would stage NOTHING', () => {
    expect(resolvePartialFailureFieldLabel(circuitFields, 'measured_zs_ohm')).toBe(
      'Measured Zs (ohm)'
    );
    // The proof that the order matters: the canonical identity has no label.
    const canonical = canonicalPartialFailureFieldIdentity('measured_zs_ohm');
    expect(canonical).toBe('zs');
    expect(circuitFields?.[canonical]?.label).toBeUndefined();
  });

  test('every raw-labelled alias whose canonical form is label-LESS still resolves', () => {
    for (const raw of ['measured_zs_ohm', 'rcd_time_ms', 'r1_r2_ohm', 'ir_live_live_mohm']) {
      const label = resolvePartialFailureFieldLabel(circuitFields, raw);
      expect(typeof label).toBe('string');
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).toBe(circuitFields[raw].label);
    }
  });

  test('the FALLBACK rescues the opposite direction — a short spelling with no label of its own', () => {
    // `max_zs` / `ocpd_max_zs` carry no schema label; their canonical form does.
    // Before the fallback these staged nothing and the turn went silent.
    for (const short of ['max_zs', 'ocpd_max_zs']) {
      expect(circuitFields?.[short]?.label).toBeUndefined();
      expect(canonicalPartialFailureFieldIdentity(short)).toBe('ocpd_max_zs_ohm');
      expect(resolvePartialFailureFieldLabel(circuitFields, short)).toBe(
        circuitFields.ocpd_max_zs_ohm.label
      );
    }
  });

  test('a field NEITHER spelling can name returns null — the caller then stages nothing', () => {
    expect(resolvePartialFailureFieldLabel(circuitFields, 'not_a_field')).toBeNull();
    expect(resolvePartialFailureFieldLabel(circuitFields, '')).toBeNull();
    expect(resolvePartialFailureFieldLabel(circuitFields, undefined)).toBeNull();
    expect(resolvePartialFailureFieldLabel(undefined, 'measured_zs_ohm')).toBeNull();
  });

  test('LEAK SAFETY — the resolved label is always a schema string, never the model’s own', () => {
    // A model-supplied name that happens to differ only in case must not leak.
    expect(resolvePartialFailureFieldLabel(circuitFields, 'MEASURED_ZS_OHM')).toBeNull();
  });
});

describe('§5.A6 — renderPartialFailureNoticeText', () => {
  const aggregate = {
    reason: 'circuit_not_found',
    field: 'zs',
    fieldLabel: label('measured_zs_ohm'),
    boardId: null,
    targets: [circuitTarget(7), circuitTarget(8)],
  };

  test('renders from the SURVIVING list, not the staged list', () => {
    const text = renderPartialFailureNoticeText({}, aggregate, [circuitTarget(8)]);
    expect(text).toBe(primaryText('circuit_not_found', [circuitTarget(8)], aggregate.fieldLabel));
    expect(text).not.toContain('7');
  });

  test('returns null (speaks nothing) when nothing nameable survives', () => {
    expect(renderPartialFailureNoticeText({}, aggregate, [])).toBeNull();
    expect(renderPartialFailureNoticeText({}, null, [circuitTarget(7)])).toBeNull();
    expect(renderPartialFailureNoticeText(null, aggregate, [circuitTarget(7)])).toBeNull();
    expect(
      renderPartialFailureNoticeText({}, { ...aggregate, reason: 'gone' }, [circuitTarget(7)])
    ).toBeNull();
  });

  test('a null render does NOT consume a rotation slot', () => {
    // Selection happens at drain time precisely so a dropped notice cannot make
    // the NEXT turn's notice skip a variant for no audible reason.
    const session = {};
    expect(renderPartialFailureNoticeText(session, aggregate, [])).toBeNull();
    expect(session._partialFailureRotation).toBeUndefined();
    expect(renderPartialFailureNoticeText(session, aggregate, [circuitTarget(7)])).toBe(
      primaryText('circuit_not_found', [circuitTarget(7)], aggregate.fieldLabel)
    );
  });

  test('belt-and-braces: a scope-only survivor on a non-scope family renders nothing', () => {
    expect(renderPartialFailureNoticeText({}, aggregate, [SCOPE_TARGET])).toBeNull();
  });
});

describe('§5.A6b — repeat escalation: never a byte-repeat inside the 30 s dedupe window', () => {
  // Codex diff-review cycle 2 BLOCKER. Notices ride the field-nil channel,
  // whose client dedupe is TEXT-KEYED with a 30 s TTL. Three variants rotating
  // mod 3 means the 4th repeat of ONE spoken identity wraps to variant 0 —
  // byte-identical to the 1st, therefore swallowed, therefore a chimed turn
  // goes silent with marker-② already suppressed by the queued prompt.
  const aggregate = {
    reason: 'circuit_not_found',
    field: 'zs',
    fieldLabel: label('measured_zs_ohm'),
    boardId: null,
    targets: [circuitTarget(7)],
  };
  const render = (session, nowMs, agg = aggregate, survivors = [circuitTarget(7)]) =>
    renderPartialFailureNoticeText(session, agg, survivors, { nowMs });

  test('four consecutive repeats of ONE identity render four DISTINCT strings', () => {
    const session = {};
    const t0 = 1_000_000;
    const spoken = [
      render(session, t0),
      render(session, t0 + 1_000),
      render(session, t0 + 2_000),
      render(session, t0 + 3_000),
    ];
    for (const s of spoken) expect(typeof s).toBe('string');
    // The assertion that fails without the terminal: #4 would equal #1.
    expect(new Set(spoken).size).toBe(4);
  });

  test('repeats 1..3 are byte-UNCHANGED — the pinned id-112 render still leads', () => {
    const session = {};
    const t0 = 2_000_000;
    expect(render(session, t0)).toBe(
      primaryText('circuit_not_found', [circuitTarget(7)], aggregate.fieldLabel)
    );
    const second = render(session, t0 + 500);
    const third = render(session, t0 + 1_000);
    expect(second).toBe(PARTIAL_FAILURE_FAMILIES.circuit_not_found[1](descriptorFor([7])));
    expect(third).toBe(PARTIAL_FAILURE_FAMILIES.circuit_not_found[2](descriptorFor([7])));
  });

  test('the 4th and every later repeat is the ordinal TERMINAL, distinct each time', () => {
    const session = {};
    const t0 = 3_000_000;
    for (let i = 0; i < 3; i++) render(session, t0 + i * 100);
    const fourth = render(session, t0 + 300);
    const fifth = render(session, t0 + 400);
    expect(fourth).toBe(PARTIAL_FAILURE_TERMINALS.circuit_not_found(descriptorFor([7]), 4));
    expect(fifth).toBe(PARTIAL_FAILURE_TERMINALS.circuit_not_found(descriptorFor([7]), 5));
    expect(fourth).not.toBe(fifth);
  });

  test('past the 30 s window the counter RESETS — a fresh attempt 1 is honest', () => {
    const session = {};
    const t0 = 4_000_000;
    for (let i = 0; i < 4; i++) render(session, t0 + i * 100);
    // Outside the window the earlier text is no longer in the client's dedupe
    // store, so the primary wording is the right thing to say again.
    const afterWindow = render(session, t0 + 40_000);
    expect(afterWindow).not.toContain('attempt');
  });

  test('TWO BOARDS, same field and same refs, share ONE counter — no identical terminals', () => {
    // The board never appears in the spoken sentence, so board-keying the
    // counter would let each board reach "attempt 4" independently and emit
    // byte-identical terminals — reopening the swallow this closes.
    const session = {};
    const t0 = 5_000_000;
    const main = { ...aggregate, boardId: null };
    const garage = { ...aggregate, boardId: 'garage' };
    const spoken = [];
    for (let i = 0; i < 3; i++) {
      spoken.push(render(session, t0 + i * 200, main));
      spoken.push(render(session, t0 + i * 200 + 50, garage));
    }
    for (const s of spoken) expect(typeof s).toBe('string');
    expect(new Set(spoken).size).toBe(spoken.length);
  });

  // Every interleaving of two identities, up to 5 renders. A shared per-family
  // cursor (cycle 2's shape) fails `X, X, Y, X` — indices 0, 1, 2, 0 — because
  // the cursor is advanced by the OTHER identity and the one-step skip only
  // remembers X's immediately previous index (Codex cycle-2 mini-review
  // BLOCKER). Tying the variant to the identity's OWN repeat count makes the
  // invariant structural, so assert it EXHAUSTIVELY rather than on one
  // favourable alternation.
  const interleavings = (() => {
    const out = [];
    for (let mask = 0; mask < 32; mask++) {
      out.push(
        Array.from({ length: 5 }, (_, i) => ((mask >> i) & 1 ? 'Y' : 'X'))
      );
    }
    return out;
  })();

  test.each(interleavings.map((seq) => [seq.join(''), seq]))(
    'interleaving %s never repeats bytes inside the window',
    (_name, seq) => {
      const session = {};
      const t0 = 6_000_000;
      const refs = { X: [circuitTarget(7)], Y: [circuitTarget(9)] };
      const spoken = seq.map((who, i) => render(session, t0 + i * 100, aggregate, refs[who]));
      for (const s of spoken) expect(typeof s).toBe('string');
      // All five renders land inside ONE 30 s dedupe window, so ANY duplicate
      // here is a swallowed notice — i.e. a chimed turn that says nothing.
      expect(new Set(spoken).size).toBe(spoken.length);
    }
  );

  // Codex cycle-2-mini-review-2 BLOCKER. The repeat identity used to be
  // re-derived from `survivingTargets` in PARALLEL with the descriptor, and the
  // two derivations disagreed about scope: `describePartialFailureTargets` gives
  // refs PRECEDENCE (a scope target is invisible in the rendered text whenever
  // any ref is present), while the key appended `|scope` whenever a scope target
  // existed at all. So these two aggregates rendered IDENTICAL bytes under two
  // different keys — two counters, both at repeat 1, both variant 0, the second
  // swallowed by the 30 s text dedupe. The key is now derived FROM the
  // descriptor, so identical bytes cannot have distinct keys by construction.
  //
  // Reachable because `record_reading`'s LIM gate stages a CIRCUIT target while
  // `set_field_for_all_circuits`' LIM gate stages a SCOPE target, and both fold
  // into one reason/field/board aggregate.
  test('a scope target that the RENDER ignores does not fork the counter', () => {
    const session = {};
    const t0 = 6_500_000;
    const limAggregate = {
      reason: 'lim_capability_gated',
      field: 'zs',
      fieldLabel: label('measured_zs_ohm'),
      boardId: null,
      targets: [circuitTarget(4)],
    };
    // Turn 1: the bulk path also gated, so the aggregate carries a scope target.
    const withScope = render(session, t0, limAggregate, [SCOPE_TARGET, circuitTarget(4)]);
    // Turn 2, inside the window: only the per-circuit path gated.
    const withoutScope = render(session, t0 + 100, limAggregate, [circuitTarget(4)]);
    expect(typeof withScope).toBe('string');
    expect(typeof withoutScope).toBe('string');
    // The refs-win grammar rule means both name circuit 4 and NEITHER says
    // "those circuits" — the scope target is invisible to the rendered text.
    // (Case-insensitive: the variants use `subject` or `subjectLower` per their
    // own sentence position, which is not what this test is about.)
    expect(withScope.toLowerCase()).toContain('circuit 4');
    expect(withoutScope.toLowerCase()).toContain('circuit 4');
    expect(withScope.toLowerCase()).not.toContain('those circuits');
    // ...so they MUST NOT be byte-identical, or the second is swallowed.
    expect(withoutScope).not.toBe(withScope);
    // One shared counter, not two: the second render is repeat 2.
    expect(Object.keys(session.partialFailureRepeats)).toHaveLength(1);
    expect(Object.values(session.partialFailureRepeats)[0].count).toBe(2);
  });

  test('duplicate refs in the target list do not fork the counter either', () => {
    // The descriptor de-duplicates and sorts refs, so [4, 4] and [4] speak the
    // same sentence; the parallel key joined the raw list and forked.
    const session = {};
    const t0 = 6_700_000;
    const first = render(session, t0, aggregate, [circuitTarget(7), circuitTarget(7)]);
    const second = render(session, t0 + 100, aggregate, [circuitTarget(7)]);
    expect(second).not.toBe(first);
    expect(Object.keys(session.partialFailureRepeats)).toHaveLength(1);
  });

  // Codex cycle-2b mini-review BLOCKER. The repeat key interpolates
  // `descriptor.fieldLabel` RAW, so any template that renders that same label
  // through a NON-INJECTIVE transform can fold two distinct identities onto one
  // spoken string — two counters, both bumping independently, and the second
  // line swallowed by the very 30 s text dedupe the terminals exist to escape.
  // `capitaliseFirst` was exactly such a transform, and the hazard is LIVE: the
  // circuit-field schema carries a case-colliding label pair today.
  //
  // Assert the invariant STRUCTURALLY (every family, every variant, and the
  // terminal) rather than only on the one template that had the bug, so the
  // next transform-bearing line fails here instead of in the field.
  describe('label-case collisions never fold two identities onto one string', () => {
    /** Every case-insensitively colliding circuit-field label pair in the schema. */
    const collidingLabelPairs = (() => {
      const byFolded = new Map();
      for (const [field, def] of Object.entries(FIELD_SCHEMA.circuit_fields)) {
        const text = def?.label;
        if (typeof text !== 'string' || text.length === 0) continue;
        const folded = text.toLowerCase();
        if (!byFolded.has(folded)) byFolded.set(folded, new Map());
        byFolded.get(folded).set(text, field);
      }
      const out = [];
      for (const spellings of byFolded.values()) {
        const distinct = [...spellings.entries()];
        for (let i = 0; i < distinct.length; i++) {
          for (let j = i + 1; j < distinct.length; j++) {
            out.push([distinct[i], distinct[j]]);
          }
        }
      }
      return out;
    })();

    test('the schema still carries a live colliding pair (regression stays real)', () => {
      // If this ever goes to zero the sweep below still runs on the synthetic
      // pair, but the FIELD hazard has gone — worth knowing, not worth failing
      // silently on.
      expect(collidingLabelPairs.length).toBeGreaterThan(0);
      // `ring_r2_ohm` => "r2 (ohm)" vs `r2_ohm` => "R2 (ohm)": both circuit
      // fields on the same ring-continuity dictation, so both are reachable
      // inside ONE 30 s window.
      expect(label('ring_r2_ohm').toLowerCase()).toBe(label('r2_ohm').toLowerCase());
      expect(label('ring_r2_ohm')).not.toBe(label('r2_ohm'));
    });

    // Synthetic pair FIRST: the invariant is structural, so it must hold even
    // if the schema's live collision is ever renamed away.
    const pairs = [
      [['r2 (ohm)', '<synthetic-lower>'], ['R2 (ohm)', '<synthetic-upper>']],
      ...collidingLabelPairs,
    ];

    test.each(
      pairs.flatMap(([[labelA, fieldA], [labelB, fieldB]]) =>
        Object.keys(PARTIAL_FAILURE_FAMILIES).map((family) => [
          `${family} — ${fieldA} vs ${fieldB}`,
          family,
          labelA,
          labelB,
        ])
      )
    )('%s renders byte-distinct lines for both spellings', (_name, family, labelA, labelB) => {
      const refs = [circuitTarget(4)];
      const a = describePartialFailureTargets(refs, labelA);
      const b = describePartialFailureTargets(refs, labelB);
      const variants = PARTIAL_FAILURE_FAMILIES[family];
      for (let i = 0; i < variants.length; i++) {
        expect(variants[i](a)).not.toBe(variants[i](b));
      }
      // The terminal is the line that actually broke: it opened on
      // `capitaliseFirst(fieldLabel)`, which folds "r2 (ohm)" and "R2 (ohm)"
      // into the same bytes at the same ordinal.
      const terminal = PARTIAL_FAILURE_TERMINALS[family];
      for (const ordinal of [4, 5, 12]) {
        expect(terminal(a, ordinal)).not.toBe(terminal(b, ordinal));
      }
    });

    test('two colliding labels keep SEPARATE counters end to end', () => {
      // The end-to-end proof: four repeats each, interleaved, all inside one
      // window. Distinct keys AND distinct bytes — the pre-fix terminal made
      // the 4th render of each pair identical.
      const session = {};
      const t0 = 7_500_000;
      const spoken = [];
      for (let i = 0; i < 4; i++) {
        for (const field of ['ring_r2_ohm', 'r2_ohm']) {
          spoken.push(
            renderPartialFailureNoticeText(
              session,
              {
                reason: 'write_failed',
                field,
                fieldLabel: label(field),
                boardId: null,
                targets: [circuitTarget(4)],
              },
              [circuitTarget(4)],
              { nowMs: t0 + spoken.length * 100 }
            )
          );
        }
      }
      expect(spoken.every((s) => typeof s === 'string')).toBe(true);
      expect(new Set(spoken).size).toBe(spoken.length);
      expect(Object.keys(session.partialFailureRepeats)).toHaveLength(2);
    });
  });

  test('a DIFFERENT field on the same refs is a different identity (own counter)', () => {
    const session = {};
    const t0 = 7_000_000;
    const zs = aggregate;
    const r1r2 = { ...aggregate, field: 'r1_plus_r2', fieldLabel: label('r1_r2_ohm') };
    for (let i = 0; i < 3; i++) render(session, t0 + i * 100, zs);
    // The r1+r2 notice has been spoken ZERO times, so it must NOT terminal.
    expect(render(session, t0 + 400, r1r2)).not.toContain('attempt');
  });

  test('a null render never bumps the repeat counter', () => {
    const session = {};
    expect(render(session, 8_000_000, aggregate, [])).toBeNull();
    expect(session.partialFailureRepeats).toBeUndefined();
  });
});

describe('§5.A7 — client-dedupe distinctness sweep', () => {
  test('every rendered notice line in the inventory is mutually distinct', () => {
    // Byte-identical repeats inside the clients' 30 s text dedupe are
    // SWALLOWED — a duplicate anywhere in this inventory is a silence bug.
    const inventory = renderedNoticeInventory();
    expect(inventory.length).toBeGreaterThan(0);
    const texts = inventory.map((e) => e.text ?? e);
    expect(new Set(texts).size).toBe(texts.length);
  });

  test('the partial-failure families are ENROLLED (singular + plural samples)', () => {
    const inventory = renderedNoticeInventory();
    const partial = inventory.filter((e) => e.route === 'partial_failure');
    // 4 families × (3 variants + 1 terminal) × 2 grammar samples.
    expect(partial).toHaveLength(32);
    // Every family present, and BOTH grammatical numbers rendered for each —
    // the plural fill is what the id-112 headline speaks, so a template that
    // silently ignored the number slots must fail this sweep, not pass it.
    expect(new Set(partial.map((e) => e.family))).toEqual(
      new Set(Object.keys(PARTIAL_FAILURE_FAMILIES))
    );
    for (const family of Object.keys(PARTIAL_FAILURE_FAMILIES)) {
      const rows = partial.filter((e) => e.family === family);
      expect(rows.filter((e) => e.kind.endsWith('_singular'))).toHaveLength(4);
      expect(rows.filter((e) => e.kind.endsWith('_plural'))).toHaveLength(4);
      // Singular and plural must be DIFFERENT bytes for every variant.
      for (let i = 0; i < 3; i++) {
        const s = rows.find((e) => e.kind === `variant_${i}_singular`);
        const p = rows.find((e) => e.kind === `variant_${i}_plural`);
        expect(s.text).not.toBe(p.text);
      }
      // Every family carries its ordinal TERMINAL — the wrap-silence fix. A
      // family without one can go silent on the 4th repeat inside 30 s.
      expect(rows.find((e) => e.kind === 'terminal_singular')?.text).toBeTruthy();
      expect(rows.find((e) => e.kind === 'terminal_plural')?.text).toBeTruthy();
    }
    // The A1a/plan-B regimes are still enrolled beside them (no clobbering).
    expect(inventory.some((e) => e.route === 'direct')).toBe(true);
    expect(inventory.some((e) => e.route === 'b_staged')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BLOCK B — the harness seam (the REAL composed dispatcher)
// ───────────────────────────────────────────────────────────────────────────

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);
const runToolLoopSpy = jest.fn(async () => ({
  stop_reason: 'end_turn',
  rounds: 1,
  tool_calls: [],
  aborted: false,
  messages_final: [],
  usage: {},
  terminal_reason: 'end_turn',
}));
const createSpeculatorSpy = jest.fn(() => ({
  onSnapshotPatch: jest.fn(),
  onLoopComplete: jest.fn(),
  onToolUseStreamed: jest.fn(),
  validateAgainstConfirmations: jest.fn(),
  abortBySlot: jest.fn(),
  shutdown: jest.fn(),
}));

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: createAskDispatcherSpy,
  ASK_USER_TIMEOUT_MS: 20000,
}));
jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));
jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: createSpeculatorSpy,
}));

const {
  runShadowHarness,
  CATCHALL_AUDIBILITY_PROMPTS,
  REJECTED_PROMPTS,
  ORPHAN_PROMPTS,
  ASK_AUDIBILITY_FALLBACK_TEXT,
} = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');

const CATCHALL_SET = new Set(CATCHALL_AUDIBILITY_PROMPTS);
const REJECTED_SET = new Set(REJECTED_PROMPTS);
const ORPHAN_SET = new Set(ORPHAN_PROMPTS);

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(stateOverrides = {}, extra = {}) {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    certType: 'eicr',
    turnCount: 0,
    costTracker: {
      addSonnetUsage: jest.fn(),
      recordElevenLabsSpeculativeStarted: jest.fn(() => true),
      recordElevenLabsSpeculativeTerminal: jest.fn(),
    },
    stateSnapshot: {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
      ...stateOverrides,
    },
    extractedObservations: [],
    activeTurnTranscript: null,
    _snapshot: null,
    buildSystemBlocks() {
      return [
        { type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
    ...extra,
  };
}

/**
 * Register the live-session entry the dispatcher reads capabilities from.
 * DEFAULT for this suite is the DARK client — no `lim_ranged_write_v1`, no
 * `low_conf_readback_v1` — because that is the state channels 6a/6b/6c exist
 * for and the state a real older build is in.
 */
function registerEntry(supports = []) {
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: {
      flags: { loadedBarrel: false },
      capabilities: parseVoiceLatencyCapabilities({ voice_latency: { version: 1, supports } }),
    },
  });
}

const makePendingAsks = (size = 0) => ({
  __tag: 'pending-asks-registry',
  size,
  entries: () => [],
});

const baseOpts = (overrides = {}) => ({
  logger: makeLogger(),
  pendingAsks: makePendingAsks(),
  ws: { readyState: 1, OPEN: 1, send: jest.fn() },
  confirmationsEnabled: true,
  chimeObserved: true,
  ...overrides,
});

/** Drive the REAL composed dispatcher with a scripted list of tool calls. */
function loopDispatching(calls) {
  runToolLoopSpy.mockImplementation(async (opts) => {
    const toolCalls = [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const result = await opts.dispatcher(
        { tool_call_id: c.id ?? `toolu_${i}`, name: c.name, input: c.input },
        opts.ctx
      );
      toolCalls.push({ tool_call_id: c.id ?? `toolu_${i}`, name: c.name, input: c.input, result });
    }
    return {
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: toolCalls,
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    };
  });
}

const reading = (circuit, field, value, over = {}) => ({
  name: 'record_reading',
  input: { field, circuit, value, confidence: 0.95, source_turn_id: 't1', ...over },
  id: `toolu_${field}_${circuit}_${String(value).replace(/\W/g, '')}`,
});
const bulk = (field, value, over = {}) => ({
  name: 'set_field_for_all_circuits',
  input: { field, value, confidence: 0.95, source_turn_id: 't1', ...over },
  id: `toolu_bulk_${field}`,
});

const audibleConfs = (result) =>
  (result.confirmations ?? []).filter(
    (c) => typeof c.text === 'string' && c.text.trim().length > 0
  );
const noticeRows = (logger) =>
  logger.info.mock.calls.filter(([ev]) => ev === 'stage6.partial_failure_notice_emitted');
const subtractedRows = (logger) =>
  logger.info.mock.calls.filter(([ev]) => ev === 'stage6.partial_failure_notice_subtracted');
const suppressedRows = (logger) =>
  logger.info.mock.calls.filter(
    ([ev]) => ev === 'stage6.partial_failure_notices_suppressed_all_rejected'
  );

/** No generic "say that again" line may ride alongside a specific notice. */
function assertNoGenericApologies(result, logger) {
  for (const c of audibleConfs(result)) {
    expect(CATCHALL_SET.has(c.text)).toBe(false);
    expect(REJECTED_SET.has(c.text)).toBe(false);
    expect(ORPHAN_SET.has(c.text)).toBe(false);
    expect(c.text).not.toBe(ASK_AUDIBILITY_FALLBACK_TEXT);
  }
  expect(
    logger.info.mock.calls.filter(([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted')
  ).toHaveLength(0);
}

/** The single notice line in `result.confirmations`, asserted to be field-nil. */
function soleNotice(result, expectedTexts) {
  const matches = audibleConfs(result).filter((c) => expectedTexts.includes(c.text));
  expect(matches).toHaveLength(1);
  expect(matches[0].field).toBeNull();
  expect(matches[0].circuit).toBeNull();
  return matches[0];
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  registerEntry([]); // DARK client — the state channels 6a/6b/6c defend
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
  delete process.env.LIM_RANGED_WRITE_DISABLED;
});

// ---------------------------------------------------------------------------
describe('§5.B1 — channel 1: record_reading circuit_not_found (the id-112 shape)', () => {
  test('HEADLINE: four writes land, circuits 7 and 8 miss ⇒ read-backs PLUS one notice naming 7 and 8', async () => {
    const session = makeSession({
      circuits: {
        5: { circuit_designation: 'Sockets' },
        6: { circuit_designation: 'Lights' },
      },
    });
    loopDispatching([
      reading(5, 'measured_zs_ohm', '0.4'),
      reading(6, 'measured_zs_ohm', '0.4'),
      reading(7, 'measured_zs_ohm', '0.4'),
      reading(8, 'measured_zs_ohm', '0.4'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(
      session,
      'Zs for circuits 5 to 8 is 0.4.',
      [],
      opts
    );

    // The successes are still read back — this net is ADDITIVE, never a gate.
    expect(session.stateSnapshot.circuits[5].measured_zs_ohm).toBe('0.4');
    expect(session.stateSnapshot.circuits[6].measured_zs_ohm).toBe('0.4');
    expect(audibleConfs(result).some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    // ...and the two misses are named ONCE, aggregated into one sentence.
    soleNotice(result, [
      primaryText(
        'circuit_not_found',
        [circuitTarget(7), circuitTarget(8)],
        label('measured_zs_ohm')
      ),
    ]);
    expect(noticeRows(opts.logger)).toHaveLength(1);
    expect(noticeRows(opts.logger)[0][1]).toMatchObject({
      reason: 'circuit_not_found',
      producer: 'record_reading_circuit_not_found',
      staged_target_count: 2,
      spoken_target_count: 2,
      spoken_refs: '7,8',
    });
    assertNoGenericApologies(result, opts.logger);
  });

  test('two different fields on the same miss ⇒ two aggregates, each naming its own label', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([
      reading(4, 'measured_zs_ohm', '0.4'),
      reading(9, 'measured_zs_ohm', '0.4'),
      reading(9, 'r1_r2_ohm', '0.6'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs and R1 R2 on 9.', [], opts);

    const rows = noticeRows(opts.logger);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r[1].field).sort()).toEqual(['r1_plus_r2', 'zs']);
    const texts = audibleConfs(result).map((c) => c.text);
    expect(texts.some((t) => t.includes(label('measured_zs_ohm')))).toBe(true);
    expect(texts.some((t) => t.includes(label('r1_r2_ohm')))).toBe(true);
    // Same family twice in one turn ⇒ byte-distinct variants (rotation).
    const noticeTexts = texts.filter((t) => t.includes("weren't") || t.includes("wasn't") || t.includes('couldn’t') || t.includes("couldn't"));
    expect(new Set(noticeTexts).size).toBe(noticeTexts.length);
    assertNoGenericApologies(result, opts.logger);
  });

  test('a wrong_board rejection is a DIFFERENT class and stages no notice', async () => {
    const session = makeSession({
      circuits: { 4: { circuit_designation: 'Sockets' } },
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        { id: 'sub-1', designation: 'Garage', board_type: 'sub_distribution', parent_board_id: 'main' },
      ],
    });
    loopDispatching([
      reading(4, 'measured_zs_ohm', '0.4'),
      reading(4, 'measured_zs_ohm', '0.5', { board_id: 'no-such-board' }),
    ]);
    const opts = baseOpts();
    await runShadowHarness(session, 'Zs on 4 is 0.4.', [], opts);
    expect(noticeRows(opts.logger)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('§5.B2 — rule (1): an ALL-REJECTED turn stays byte-identical to plan B', () => {
  test('single rejected call ⇒ notices SUPPRESSED, the generic line is the only audible output', async () => {
    const session = makeSession({ circuits: { 4: {} } });
    loopDispatching([reading(9, 'measured_zs_ohm', 'LIM', { confidence: 0.9 })]);
    // NOTE: capable client, so the LIM value is accepted and the ONLY rejection
    // is circuit_not_found — an all-error turn.
    registerEntry(['lim_ranged_write_v1', 'low_conf_readback_v1']);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Record that one.', [], opts);

    expect(suppressedRows(opts.logger)).toHaveLength(1);
    expect(suppressedRows(opts.logger)[0][1]).toMatchObject({ aggregate_count: 1 });
    expect(noticeRows(opts.logger)).toHaveLength(0);
    // Plan B's generic rejected-prompt still owns the turn — never silent, and
    // never a specific notice competing with it.
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(REJECTED_SET.has(speakers[0].text)).toBe(true);
  });

  test('multi-call all-rejected ⇒ still exactly ONE generic line, zero notices', async () => {
    const session = makeSession({ circuits: { 4: {} } });
    registerEntry(['lim_ranged_write_v1', 'low_conf_readback_v1']);
    loopDispatching([
      reading(7, 'measured_zs_ohm', '0.4'),
      reading(8, 'measured_zs_ohm', '0.4'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Record those two.', [], opts);

    expect(suppressedRows(opts.logger)).toHaveLength(1);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(REJECTED_SET.has(speakers[0].text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('§5.B3 — rule (2): a surviving same-slot write SUBTRACTS its target', () => {
  test('skip then write (same field, same circuit) ⇒ nothing spoken, subtraction logged', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([
      reading(4, 'measured_zs_ohm', 'LIM'), // channel 6a — DARK client, staged
      reading(4, 'measured_zs_ohm', '0.50'), // the retry that LANDS
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 is LIM. No, 0.50.', [], opts);

    expect(session.stateSnapshot.circuits[4].measured_zs_ohm).toBe('0.50');
    expect(noticeRows(opts.logger)).toHaveLength(0);
    expect(subtractedRows(opts.logger)).toHaveLength(1);
    // A false "didn't save" over a value that DID land is the worst outcome
    // this net can produce — the read-back must be the only thing spoken.
    for (const c of audibleConfs(result)) {
      expect(variantTexts('lim_capability_gated', [circuitTarget(4)], label('measured_zs_ohm')))
        .not.toContain(c.text);
    }
    assertNoGenericApologies(result, opts.logger);
  });

  test('write then skip (reverse dispatch order) subtracts identically', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([
      reading(4, 'measured_zs_ohm', '0.50'),
      reading(4, 'measured_zs_ohm', 'LIM'),
    ]);
    const opts = baseOpts();
    await runShadowHarness(session, 'Zs on 4 is 0.50.', [], opts);
    expect(noticeRows(opts.logger)).toHaveLength(0);
    expect(subtractedRows(opts.logger)).toHaveLength(1);
  });

  test('CANONICAL SYMMETRY: the aggregate keys on `zs`, the write’s raw key is `measured_zs_ohm` — it still subtracts', async () => {
    // The staged aggregate stores the CANONICAL identity while the surviving
    // write's raw Map key carries the schema spelling. If the drain compared
    // raw-to-canonical it would miss and speak a FALSE "not recorded".
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([
      reading(4, 'measured_zs_ohm', 'LIM'),
      reading(4, 'measured_zs_ohm', '0.50'),
    ]);
    const opts = baseOpts();
    await runShadowHarness(session, 'Zs on 4.', [], opts);
    expect(subtractedRows(opts.logger)[0][1]).toMatchObject({ field: 'zs' });
  });

  test('PARTIAL subtraction leaves a residual that names only the survivors', async () => {
    const session = makeSession({
      circuits: { 4: { circuit_designation: 'Sockets' }, 5: { circuit_designation: 'Lights' } },
    });
    loopDispatching([
      reading(4, 'measured_zs_ohm', 'LIM'),
      reading(5, 'measured_zs_ohm', 'LIM'),
      reading(4, 'measured_zs_ohm', '0.50'), // only 4 is rescued
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 and 5.', [], opts);

    soleNotice(result, [
      primaryText('lim_capability_gated', [circuitTarget(5)], label('measured_zs_ohm')),
    ]);
    expect(noticeRows(opts.logger)[0][1]).toMatchObject({
      staged_target_count: 2,
      spoken_target_count: 1,
      spoken_refs: '5',
    });
  });

  test('a DIFFERENT field’s write never subtracts the notice', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([
      reading(4, 'measured_zs_ohm', 'LIM'),
      reading(4, 'r1_r2_ohm', '0.60'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs LIM, R1 R2 0.6 on 4.', [], opts);
    soleNotice(result, [
      primaryText('lim_capability_gated', [circuitTarget(4)], label('measured_zs_ohm')),
    ]);
    expect(subtractedRows(opts.logger)).toHaveLength(0);
  });

  test('a same-ref write on ANOTHER board never subtracts (two boards, one ref)', async () => {
    const session = makeSession({
      circuits: {
        4: { circuit_designation: 'Sockets' },
        'sub-1::4': { circuit_designation: 'Garage sockets', board_id: 'sub-1' },
      },
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        {
          id: 'sub-1',
          designation: 'Garage',
          board_type: 'sub_distribution',
          parent_board_id: 'main',
        },
      ],
    });
    loopDispatching([
      reading(4, 'measured_zs_ohm', 'LIM', { board_id: 'sub-1' }), // skipped on SUB
      reading(4, 'measured_zs_ohm', '0.50'), // lands on MAIN
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4.', [], opts);

    // Boards are part of the slot identity — a main-board write must not
    // silence a sub-board miss, or the inspector loses a whole circuit.
    soleNotice(result, [
      primaryText('lim_capability_gated', [circuitTarget(4)], label('measured_zs_ohm')),
    ]);
    expect(subtractedRows(opts.logger)).toHaveLength(0);
    expect(noticeRows(opts.logger)[0][1]).toMatchObject({ board: 'sub-1' });
  });
});

// ---------------------------------------------------------------------------
describe('§5.B4 — channel 6a/6b: capability-gate skips are audible (is_error:false)', () => {
  test('SKIP-ONLY turn speaks the notice — the class marker-② cannot see', async () => {
    // A capability skip is `is_error:false`, so the turn is NOT allRejected and
    // plan B's prompt structurally cannot fire. Before this net the turn was
    // completely silent after the chime.
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', 'LIM')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 is LIM.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(
      variantTexts('lim_capability_gated', [circuitTarget(4)], label('measured_zs_ohm'))
    ).toContain(speakers[0].text);
    expect(speakers[0].field).toBeNull();
    // The specific notice SUPPRESSES the generic catch-all — never both.
    assertNoGenericApologies(result, opts.logger);
    expect(suppressedRows(opts.logger)).toHaveLength(0);
  });

  test('mixed: one LIM skip beside a sibling write ⇒ read-back AND notice', async () => {
    const session = makeSession({
      circuits: { 4: { circuit_designation: 'Sockets' }, 7: { circuit_designation: 'Lights' } },
    });
    loopDispatching([
      reading(7, 'measured_zs_ohm', 'LIM'),
      reading(4, 'r1_r2_ohm', '0.60'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 7 LIM, R1 R2 on 4 is 0.6.', [], opts);

    expect(session.stateSnapshot.circuits[4].r1_r2_ohm).toBe('0.60');
    expect(audibleConfs(result).some((c) => c.field === 'r1_r2_ohm')).toBe(true);
    soleNotice(result, variantTexts('lim_capability_gated', [circuitTarget(7)], label('measured_zs_ohm')));
    assertNoGenericApologies(result, opts.logger);
  });

  test('a CAPABLE client is byte-identical to pre-2A: LIM lands, no notice', async () => {
    registerEntry(['lim_ranged_write_v1']);
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', 'LIM')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 is LIM.', [], opts);
    expect(session.stateSnapshot.circuits[4].measured_zs_ohm).toBe('LIM');
    expect(noticeRows(opts.logger)).toHaveLength(0);
    expect(audibleConfs(result).some((c) => c.field === 'measured_zs_ohm')).toBe(true);
  });

  test('the LIM kill-switch also produces an audible notice', async () => {
    registerEntry(['lim_ranged_write_v1']);
    process.env.LIM_RANGED_WRITE_DISABLED = 'true';
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', 'LIM')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 is LIM.', [], opts);
    soleNotice(result, variantTexts('lim_capability_gated', [circuitTarget(4)], label('measured_zs_ohm')));
  });

  test('channel 6b: the low-confidence pre-apply gate speaks a REPEAT-inviting notice', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', '0.40', { confidence: 0.4 })]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 is 0.4.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(
      variantTexts('low_conf_capability_gated', [circuitTarget(4)], label('measured_zs_ohm'))
    ).toContain(speakers[0].text);
    // Unlike the capability families, saying it again IS the fix — every
    // variant of this family invites a repeat.
    expect(noticeRows(opts.logger)[0][1]).toMatchObject({
      reason: 'low_conf_capability_gated',
      producer: 'record_reading_low_conf_capability',
    });
    assertNoGenericApologies(result, opts.logger);
  });

  test('a low-conf-capable client is byte-identical to pre-2A', async () => {
    registerEntry(['low_conf_readback_v1']);
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', '0.40', { confidence: 0.4 })]);
    const opts = baseOpts();
    await runShadowHarness(session, 'Zs on 4 is 0.4.', [], opts);
    expect(session.stateSnapshot.circuits[4].measured_zs_ohm).toBe('0.40');
    expect(noticeRows(opts.logger)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('§5.B5 — channel 6c + the set_field_for_all_circuits bucket miss', () => {
  test('the bulk LIM gate refuses the WHOLE instruction ⇒ one scope-level notice', async () => {
    const session = makeSession({
      circuits: { 4: { circuit_designation: 'Sockets' }, 5: { circuit_designation: 'Lights' } },
    });
    loopDispatching([bulk('measured_zs_ohm', 'LIM', { scope: 'all' })]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs is LIM on all circuits.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(speakers[0].text).toBe(
      primaryText('lim_capability_gated', [SCOPE_TARGET], label('measured_zs_ohm'))
    );
    expect(speakers[0].text).toContain('Those circuits');
    expect(noticeRows(opts.logger)[0][1]).toMatchObject({
      producer: 'set_field_for_all_circuits_lim_capability',
      spoken_target_count: 1,
      spoken_refs: '',
    });
    // Nothing was written — the gate runs BEFORE the iteration.
    expect(session.stateSnapshot.circuits[4].measured_zs_ohm).toBeUndefined();
    assertNoGenericApologies(result, opts.logger);
  });

  test('a ref offered by the board census with NO bucket is named (the one silent in-loop miss)', async () => {
    const session = makeSession({
      circuits: { 4: { circuit_designation: 'Sockets' }, 9: null },
    });
    loopDispatching([bulk('r1_r2_ohm', '0.60', { scope: 'all' })]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'R1 R2 is 0.6 on all circuits.', [], opts);

    expect(session.stateSnapshot.circuits[4].r1_r2_ohm).toBe('0.60');
    soleNotice(result, [
      primaryText('circuit_not_found', [circuitTarget(9)], label('r1_r2_ohm')),
    ]);
    expect(noticeRows(opts.logger)[0][1]).toMatchObject({
      producer: 'set_field_for_all_circuits_bucket_miss',
      spoken_refs: '9',
    });
    assertNoGenericApologies(result, opts.logger);
  });

  test('an EXPLICITLY excluded ref is never announced — the inspector asked for that', async () => {
    const session = makeSession({
      circuits: { 4: { circuit_designation: 'Sockets' }, 9: null },
    });
    loopDispatching([bulk('r1_r2_ohm', '0.60', { scope: 'all', exclude_circuits: [9] })]);
    const opts = baseOpts();
    await runShadowHarness(session, 'R1 R2 is 0.6 on all but 9.', [], opts);
    expect(noticeRows(opts.logger)).toHaveLength(0);
  });

  test('DESIGNED-SILENT pin: scope-policy skips (spare_circuit) stage nothing', async () => {
    // "All the non-spare circuits" excluding a spare is the instruction working
    // as asked. Announcing every spare slot on a 12-way board would bury the
    // read-back the turn exists for.
    const session = makeSession({
      circuits: {
        4: { circuit_designation: 'Sockets' },
        5: { circuit_designation: 'Spare' },
        6: { circuit_designation: '' },
      },
    });
    loopDispatching([bulk('r1_r2_ohm', '0.60', { scope: 'non_spare' })]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'R1 R2 is 0.6 on the non-spares.', [], opts);

    expect(session.stateSnapshot.circuits[4].r1_r2_ohm).toBe('0.60');
    expect(session.stateSnapshot.circuits[5].r1_r2_ohm).toBeUndefined();
    expect(noticeRows(opts.logger)).toHaveLength(0);
    assertNoGenericApologies(result, opts.logger);
  });

  test('DESIGNED-SILENT pin: scope-policy skips (no_rcd) stage nothing', async () => {
    const session = makeSession({
      circuits: {
        4: { circuit_designation: 'Sockets', rcd_type: 'A' },
        5: { circuit_designation: 'Lights' },
      },
    });
    loopDispatching([bulk('rcd_time_ms', '28', { scope: 'rcd_protected_only' })]);
    const opts = baseOpts();
    await runShadowHarness(session, 'RCD time 28 on the RCD circuits.', [], opts);
    expect(noticeRows(opts.logger)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('§5.B6 — net interactions', () => {
  test('a spoken notice SUPPRESSES marker-②’s generic apology (one line, not two)', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', 'LIM')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 is LIM.', [], opts);
    expect(audibleConfs(result)).toHaveLength(1);
    expect(
      opts.logger.info.mock.calls.filter(
        ([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted'
      )
    ).toHaveLength(0);
  });

  test('ACCEPTED double-mention (churn circuit-breaker, plan 2A §3.1): a notice may ride beside an ask about the same slot', async () => {
    // §3.1 RETIRED ask-coverage suppression after three rounds of churn: the
    // suppression design kept generating regressions, and P2's precedent says
    // "worst case an extra read-back, never silence". This test PINS the
    // accepted behaviour so a future reader knows it is a decision, not a bug.
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([
      reading(4, 'measured_zs_ohm', 'LIM'),
      { name: 'ask_user', input: { question: 'What was the Zs on 4?' }, id: 'toolu_ask' },
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 is LIM.', [], opts);
    // The notice still speaks — declining to speak is the failure mode that
    // matters, and the ask dispatcher is mocked here so only the notice lands.
    soleNotice(result, variantTexts('lim_capability_gated', [circuitTarget(4)], label('measured_zs_ohm')));
  });

  test('confirmations OFF ⇒ no notice (the whole channel is a spoken one)', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', 'LIM')]);
    const opts = baseOpts({ confirmationsEnabled: false });
    await runShadowHarness(session, 'Zs on 4 is LIM.', [], opts);
    expect(noticeRows(opts.logger)).toHaveLength(0);
  });

  test('no chime ⇒ no notice (a turn that never promised a reply)', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', 'LIM')]);
    const opts = baseOpts({ chimeObserved: false });
    await runShadowHarness(session, 'Zs on 4 is LIM.', [], opts);
    expect(noticeRows(opts.logger)).toHaveLength(0);
  });

  test('a turn with NO partial failures is byte-identical to pre-2A', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([reading(4, 'measured_zs_ohm', '0.86')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Zs on 4 is 0.86.', [], opts);
    expect(noticeRows(opts.logger)).toHaveLength(0);
    expect(subtractedRows(opts.logger)).toHaveLength(0);
    expect(suppressedRows(opts.logger)).toHaveLength(0);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(speakers[0].field).toBe('measured_zs_ohm');
  });
});
