/**
 * A01P (2026-09-08) — shared job-state fixture, web half.
 *
 * Both platforms start from IDENTICAL bytes
 * (`src/__tests__/fixtures/job-state/input-job.json`, byte-copied to iOS
 * `Tests/CertMateUnifiedTests/Fixtures/job-state/`). The web leg drives the
 * fixture through the REAL job adapter — `JobDetailSchema.parse`, the zod
 * strip-mode envelope `api.job()` applies to every GET response (there is no
 * other transform: sections stay permissive records) — then through
 * `buildJobStateForWire` (the `session_start.jobState` builder), key-sorts
 * the result and compares it to the committed expected shape. The backend
 * Jest leg sends that committed shape as `session_start.jobState` through
 * the real `initSonnetStream` and asserts the circuits[0] client_name and
 * long-form supply Ze seed.
 *
 * Regenerate ONLY when the builder contract deliberately changes:
 *   A01P_REGEN_WIRE_FIXTURE=1 npx vitest run tests/job-state-fixture.test.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyVoiceCommand, parseVoiceCommand, resolveJobZe } from '@certmate/shared-utils';
import { JobDetailSchema } from '@/lib/adapters';
import { buildJobStateForWire } from '@/lib/recording/installation-wire-shape';
import type { JobDetail } from '@/lib/types';

const FIXTURE_DIR = resolve(process.cwd(), '../src/__tests__/fixtures/job-state');
const INPUT = resolve(FIXTURE_DIR, 'input-job.json');
const EXPECTED = resolve(FIXTURE_DIR, 'web-build-job-state-for-wire.json');

/** Recursive, stable key sort so both platforms' outputs compare as bytes. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const canonical = (value: unknown): string => `${JSON.stringify(sortKeys(value), null, 2)}\n`;

function loadInput(): Record<string, unknown> {
  return JSON.parse(readFileSync(INPUT, 'utf8')) as Record<string, unknown>;
}

/** The real adapter: what `api.job()` returns to the app for this GET body. */
function adapt(raw: Record<string, unknown>): JobDetail {
  return JobDetailSchema.parse(raw) as unknown as JobDetail;
}

describe('[invariant] A01P shared job-state fixture — web builder', () => {
  it('the input fixture is the shared bytes (digest pinned so a drifted copy is caught here, not on iOS)', () => {
    const digest = createHash('sha256').update(readFileSync(INPUT)).digest('hex');
    expect(digest).toBe('103832fb0a21b4a7a08bfc5adf684b5688bfc87714dad3275c0aead5ee76a281');
  });

  it('JobDetailSchema.parse → buildJobStateForWire equals the committed key-sorted expected shape', () => {
    const wire = buildJobStateForWire(adapt(loadInput()));
    const actual = canonical(wire);
    if (process.env.A01P_REGEN_WIRE_FIXTURE === '1') {
      writeFileSync(EXPECTED, actual);
    }
    expect(existsSync(EXPECTED)).toBe(true);
    expect(actual).toBe(readFileSync(EXPECTED, 'utf8'));
  });

  it('the wire shape carries the identity and alias carriers the backend seeds from', () => {
    const wire = buildJobStateForWire(adapt(loadInput())) as unknown as Record<string, unknown>;
    const installation = wire.installation_details as Record<string, unknown>;
    // Snake `client_name` passes through; the four client_* address keys
    // take the frozen camel wire spelling (Plan E).
    expect(installation.client_name).toBe('Mrs Smith');
    expect(installation.clientAddress).toBe('1 Other Road');
    expect('client_address' in installation).toBe(false);
    const supply = wire.supply_characteristics as Record<string, unknown>;
    expect(supply.earth_loop_impedance_ze).toBe('0.50');
    expect(supply.ze).toBe('0.50');
    const boards = wire.boards as Array<Record<string, unknown>>;
    expect(boards.map((b) => b.id)).toEqual(['main', 'garage']);
    expect(boards[1].ze).toBe('0.38');
  });

  it.each(['single-board-boards-null.json', 'single-board-boards-empty.json'])(
    'twin %s through the real adapter into the local Calculate path selects board_info over supply → 0.55',
    (file) => {
      const raw = JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), 'utf8')) as Record<
        string,
        unknown
      >;
      const job = adapt(raw);
      expect(resolveJobZe(job as never)).toMatchObject({
        state: 'finite',
        value: 0.35,
        source: 'board_ze',
      });
      const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for circuit 1')!, job as never);
      expect(out.response).toBe('Circuit 1, Zs calculated as 0.55 ohms');
      expect((out.patch?.circuits as Array<Record<string, unknown>>)[0].measured_zs_ohm).toBe(
        '0.55'
      );
    }
  );

  it('the two twins are byte-identical apart from `boards` (null vs []) and their ids', () => {
    const a = JSON.parse(
      readFileSync(resolve(FIXTURE_DIR, 'single-board-boards-null.json'), 'utf8')
    );
    const b = JSON.parse(
      readFileSync(resolve(FIXTURE_DIR, 'single-board-boards-empty.json'), 'utf8')
    );
    expect(a.boards).toBeNull();
    expect(b.boards).toEqual([]);
    const strip = (o: Record<string, unknown>) =>
      canonical({ ...o, boards: undefined, id: undefined });
    expect(strip(a)).toBe(strip(b));
  });
});
