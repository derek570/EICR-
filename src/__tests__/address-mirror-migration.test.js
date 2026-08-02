import { createRequire } from 'node:module';
import { MigrationBuilder } from 'node-pg-migrate';

const require = createRequire(import.meta.url);
const migration = require('../../migrations/014_address_mirror_intents.cjs');

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('address mirror migration', () => {
  test('emits JSONB defaults as SQL literals rather than JSON strings', () => {
    const pgm = new MigrationBuilder({}, undefined, false, silentLogger);

    migration.up(pgm);
    const sql = pgm.getSql();

    expect(sql).toContain('"source_snapshot" jsonb DEFAULT \'{}\'::jsonb NOT NULL');
    expect(sql.match(/"source_writes" jsonb DEFAULT '\[\]'::jsonb NOT NULL/g)).toHaveLength(2);
    expect(sql).not.toContain("$pga$'{}'::jsonb$pga$");
    expect(sql).not.toContain("$pga$'[]'::jsonb$pga$");
  });
});
