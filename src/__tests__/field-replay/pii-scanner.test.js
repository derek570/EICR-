/**
 * pii-scanner.test.js — positive AND negative vectors for every location
 * class of the schema-aware privacy scanner (plan Item 1 PII policy + Item 5
 * two-tier docs rule).
 *
 * Positive = sanitized content is ACCEPTED (a naive key ban would reject
 * every valid fixture); negative = raw identifiers in values, comments,
 * keys, anchors, filenames, and free-form evidence prose are REJECTED.
 */

import {
  scanRawContent,
  scanParsedFixture,
  scanAddedLines,
  SYNTHETIC_GRAMMAR,
  PII_FINDING_CODES,
} from '../../../scripts/field-replay/lib/pii-scanner.mjs';

describe('synthetic grammar', () => {
  test('accepts exactly the reserved forms', () => {
    expect(SYNTHETIC_GRAMMAR.person.test('fixture_person_1')).toBe(true);
    expect(SYNTHETIC_GRAMMAR.address.test('12 Example Street, Testtown')).toBe(true);
    expect(SYNTHETIC_GRAMMAR.address.test('12 Example Street, Testtown, ZZ99 9ZZ')).toBe(true);
    expect(SYNTHETIC_GRAMMAR.postcode.test('ZZ99 9ZZ')).toBe(true);
  });
  test('rejects everything else that parses as a name/address/postcode', () => {
    expect(SYNTHETIC_GRAMMAR.person.test('John Smith')).toBe(false);
    expect(SYNTHETIC_GRAMMAR.address.test('14 Acacia Road, Nuneaton')).toBe(false);
    expect(SYNTHETIC_GRAMMAR.postcode.test('CV11 4LX')).toBe(false);
  });
});

describe('raw-byte scan (tier 1) — negative vectors by location class', () => {
  test('UUID in a YAML comment rejects', () => {
    const r = scanRawContent('# original: 550e8400-e29b-41d4-a716-446655440000\nfoo: 1\n', 'x.yaml');
    expect(r.findings.some((f) => f.code === PII_FINDING_CODES.UUID)).toBe(true);
  });
  test('raw session/job identifiers reject (values AND keys)', () => {
    expect(scanRawContent('id: sess_mrbnds2d_jczh\n', 'x.yaml').ok).toBe(false);
    expect(scanRawContent('job_1778443465217: yes\n', 'x.yaml').ok).toBe(false);
    expect(scanRawContent('ref: harness_17529384756_ab\n', 'x.yaml').ok).toBe(false);
  });
  test('real-shaped postcode rejects; ZZ99 range passes', () => {
    expect(
      scanRawContent('postcode: CV11 4LX\n', 'x.yaml').findings.some(
        (f) => f.code === PII_FINDING_CODES.POSTCODE,
      ),
    ).toBe(true);
    expect(
      scanRawContent('postcode: ZZ99 9ZZ\n', 'x.yaml').findings.some(
        (f) => f.code === PII_FINDING_CODES.POSTCODE,
      ),
    ).toBe(false);
  });
  test('address-like value outside the grammar rejects; Example Street passes', () => {
    expect(
      scanRawContent('address: 14 Acacia Road\n', 'x.yaml').findings.some(
        (f) => f.code === PII_FINDING_CODES.ADDRESS,
      ),
    ).toBe(true);
    expect(
      scanRawContent('address: 12 Example Street, Testtown\n', 'x.yaml').findings.some(
        (f) => f.code === PII_FINDING_CODES.ADDRESS,
      ),
    ).toBe(false);
  });
  test('private machine paths and timestamped capture filenames reject', () => {
    expect(scanRawContent('src: /Users/derekbeckley/thing\n', 'x.yaml').ok).toBe(false);
    expect(scanRawContent('see .claude/handoffs for details\n', 'x.yaml').ok).toBe(false);
    expect(scanRawContent('from dr_2026-07-16T06-13-58-753Z.json\n', 'x.yaml').ok).toBe(false);
    expect(scanRawContent('parsed session_full.jsonl rows\n', 'x.yaml').ok).toBe(false);
  });
  test('manifest-listed fragments reject at acceptance time', () => {
    const r = scanRawContent('note: mentions 36731498 here\n', 'x.yaml', {
      manifestFragments: ['36731498'],
    });
    expect(r.findings.some((f) => f.code === PII_FINDING_CODES.MANIFEST_FRAGMENT)).toBe(true);
  });
  test('date-bearing or raw-prefixed FILENAMES reject', () => {
    expect(
      scanRawContent('a: 1\n', 'corpus/field-2026-07-16.yaml').findings.some(
        (f) => f.code === PII_FINDING_CODES.FILENAME,
      ),
    ).toBe(true);
    expect(
      scanRawContent('a: 1\n', 'corpus/sess_abc.yaml').findings.some(
        (f) => f.code === PII_FINDING_CODES.FILENAME,
      ),
    ).toBe(true);
  });
  test('a fully sanitized fixture body is ACCEPTED (positive vector)', () => {
    const body = [
      'corpus_id: frc_0123456789abcdef0123456789abcdef',
      'client_name: fixture_person_1',
      'address: 12 Example Street, Testtown',
      'postcode: ZZ99 9ZZ',
      'turns:',
      '  - transcript: "zed s naught point three five circuit two"',
      '    tool_calls:',
      '      - id: sym_tc_1',
      '',
    ].join('\n');
    const r = scanRawContent(body, 'tests/fixtures/field-replay-corpus/frc_0123456789abcdef0123456789abcdef/fixture.yaml');
    expect(r.findings).toEqual([]);
  });
});

describe('parsed-layer scan — canonical PII fields', () => {
  test('sanitized canonical fields accepted; raw values rejected with paths', () => {
    const ok = scanParsedFixture({
      job_state: {
        client_name: 'fixture_person_1',
        install: { address: '12 Example Street, Testtown', postcode: 'ZZ99 9ZZ' },
      },
    });
    expect(ok.findings).toEqual([]);
    const bad = scanParsedFixture({
      job_state: { client_name: 'John Smith', install: { address: '14 Acacia Road, Nuneaton' } },
    });
    expect(bad.ok).toBe(false);
    expect(bad.findings.every((f) => f.code === PII_FINDING_CODES.PII_FIELD_GRAMMAR)).toBe(true);
    expect(bad.findings.some((f) => f.path.includes('client_name'))).toBe(true);
  });
  test('empty canonical fields are not violations', () => {
    expect(scanParsedFixture({ client_name: '' }).ok).toBe(true);
  });
});

describe('two-tier docs scanning (tier 2 — added lines only)', () => {
  test('an unchanged legacy identifier passes (it is not an added line)', () => {
    // Tier 2 receives ONLY added lines — a legacy row with a raw session id
    // never reaches the scanner, so scanning zero added lines passes.
    expect(scanAddedLines([], 'AGENTS.md').ok).toBe(true);
  });
  test('a newly added raw identifier fails', () => {
    const r = scanAddedLines(['| 2026-07-17 | fixed session sess_mrbnds2d_jczh |'], 'AGENTS.md');
    expect(r.ok).toBe(false);
    expect(r.findings[0].file).toBe('AGENTS.md');
    expect(r.findings[0].line).toBe(1);
  });
  test('added lines with opaque corpus ids pass', () => {
    const r = scanAddedLines(
      ['| 2026-07-17 | field-replay corpus fixture frc_0123456789abcdef0123456789abcdef went RED→GREEN |'],
      'AGENTS.md',
    );
    // Note: the date in the changelog CELL is fine — dates are only banned in
    // FILENAMES and identifiers; the raw-id scan drives added-line rejection.
    expect(r.ok).toBe(true);
  });
  test('the filename check is skipped for legacy tracked docs', () => {
    const r = scanAddedLines(['plain text'], 'docs/reference/changelog.md');
    expect(r.ok).toBe(true);
  });
});
