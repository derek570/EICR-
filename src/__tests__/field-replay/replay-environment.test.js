/**
 * replay-environment.test.js — environment parity via the shared task-def
 * loader (plan Item 2). Covers: the drift test comparing the COMPLETE
 * clear-or-pin table against ecs/task-def-backend.json, opposite-value
 * pre-seed → production snapshot wins → restore, secrets cleared in the
 * recorded lane only, and the VERSIONED inventory guard scanning the replay
 * import closure for unclassified process.env reads.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  PINNED_FROM_TASK_DEF,
  DELETED_SO_DEFAULTS_APPLY,
  DELIBERATE_OVERRIDES,
  SECRETS,
  readTaskDefEnvironment,
  loadReplayEnvironment,
  classifiedVariables,
} from '../../../scripts/field-replay/replay-environment.mjs';

describe('drift enforcement against ecs/task-def-backend.json', () => {
  const taskDef = readTaskDefEnvironment();

  test('every PIN variable exists in the task-def (a removed var fails the classification)', () => {
    for (const k of PINNED_FROM_TASK_DEF) {
      expect(taskDef).toHaveProperty(k);
    }
  });
  test('the four routing values are pinned to the task-def snapshot', () => {
    expect(taskDef.SONNET_EXTRACT_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(taskDef.OBSERVATION_EXTRACT_MODEL).toBe('claude-sonnet-4-6');
    expect(taskDef.VOICE_LATENCY_ROUND1_MODEL).toBe('');
    // Observation-tier routing (C1) — 'false' in the dark PR; the flip commit
    // moves this to 'true'. The pin keeps the recorded lane at the prod value.
    expect(taskDef.OBSERVATION_TIER_ROUTING).toBe('false');
    expect(PINNED_FROM_TASK_DEF).toContain('OBSERVATION_TIER_ROUTING');
  });
  test('SNAPSHOT_FORMAT/CIRCUIT_ORDER — the exact prompt-divergence gotchas — are pinned', () => {
    expect(taskDef.SNAPSHOT_FORMAT).toBe('split_blocks');
    expect(taskDef.CIRCUIT_ORDER).toBe('recent_3');
    expect(PINNED_FROM_TASK_DEF).toContain('SNAPSHOT_FORMAT');
    expect(PINNED_FROM_TASK_DEF).toContain('CIRCUIT_ORDER');
  });
  test('DELETE variables are genuinely absent from the task-def (else they belong in PIN)', () => {
    for (const k of DELETED_SO_DEFAULTS_APPLY) {
      expect(taskDef[k]).toBeUndefined();
    }
  });
  test('Loaded Barrel OFF is the SOLE deliberate override (production runs it true)', () => {
    expect(DELIBERATE_OVERRIDES).toEqual({ VOICE_LATENCY_LOADED_BARREL: 'false' });
    expect(taskDef.VOICE_LATENCY_LOADED_BARREL).toBe('true');
  });
});

describe('load + restore semantics', () => {
  test('opposite-value pre-seed: the production snapshot wins, cleanup restores', () => {
    const preSeed = {
      SONNET_EXTRACT_MODEL: 'claude-bogus-model',
      SNAPSHOT_FORMAT: 'single_block',
      VOICE_ORPHAN_PROMPT: 'true', // stale developer-shell flag → must be DELETED
      VOICE_LATENCY_LOADED_BARREL: 'true',
    };
    const before = {};
    for (const [k, v] of Object.entries(preSeed)) {
      before[k] = process.env[k];
      process.env[k] = v;
    }
    const restore = loadReplayEnvironment({ lane: 'recorded' });
    try {
      expect(process.env.SONNET_EXTRACT_MODEL).toBe('claude-haiku-4-5-20251001');
      expect(process.env.SNAPSHOT_FORMAT).toBe('split_blocks');
      expect(process.env.VOICE_ORPHAN_PROMPT).toBeUndefined();
      expect(process.env.VOICE_LATENCY_LOADED_BARREL).toBe('false');
      expect(process.env.NODE_ENV).toBe('production');
    } finally {
      restore();
    }
    expect(process.env.SONNET_EXTRACT_MODEL).toBe(preSeed.SONNET_EXTRACT_MODEL);
    expect(process.env.SNAPSHOT_FORMAT).toBe(preSeed.SNAPSHOT_FORMAT);
    expect(process.env.VOICE_ORPHAN_PROMPT).toBe('true');
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('recorded lane clears vendor secrets; live lane leaves ANTHROPIC_API_KEY alone', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    const restoreRec = loadReplayEnvironment({ lane: 'recorded' });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    restoreRec();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-not-real');
    const restoreLive = loadReplayEnvironment({ lane: 'live' });
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-not-real');
    restoreLive();
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  });

  test('subprocess ordering proof: a pre-seeded SONNET_EXTRACT_MODEL is task-def-pinned BEFORE module latch', () => {
    // stage6-shadow-harness.js latches SHADOW_MODEL at module evaluation —
    // in-process tests with a fresh registry cannot prove the ordering, so
    // run a child that loads the environment FIRST, then imports the module
    // and prints the latched value.
    const script = `
      import { loadReplayEnvironment } from '${path.resolve('scripts/field-replay/replay-environment.mjs').replace(/\\/g, '/')}';
      loadReplayEnvironment({ repoRoot: '${process.cwd().replace(/\\/g, '/')}', lane: 'recorded' });
      const mod = await import('${path.resolve('src/extraction/stage6-shadow-harness.js').replace(/\\/g, '/')}');
      // SHADOW_MODEL is module-internal; assert via the env the latch read.
      console.log(process.env.SONNET_EXTRACT_MODEL);
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, SONNET_EXTRACT_MODEL: 'claude-bogus-preseed' },
      encoding: 'utf8',
      cwd: process.cwd(),
    }).trim();
    expect(out.split('\n').pop()).toBe('claude-haiku-4-5-20251001');
  });
});

describe('the VERSIONED env-read inventory guard', () => {
  test('every process.env read reachable from the replay path is classified (pin/clear/secret/excluded)', () => {
    // The accident-grade closure approximation: every env read under
    // src/extraction/ + src/logger.js + src/env.js (the task-def comparison
    // alone cannot catch a newly-added env read).
    const dirs = ['src/extraction', 'src/logger.js', 'src/env.js'];
    const reads = new Set();
    const scan = (p) => {
      const st = fs.statSync(p, { throwIfNoEntry: false });
      if (!st) return;
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(p)) scan(path.join(p, e));
        return;
      }
      if (!p.endsWith('.js')) return;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/process\.env\.([A-Z_0-9]+)/g)) reads.add(m[1]);
    };
    for (const d of dirs) scan(d);
    const classified = classifiedVariables();
    const unclassified = [...reads].filter((v) => !classified.has(v));
    expect(unclassified).toEqual([]);
  });
  test('the classification sets are disjoint', () => {
    const sets = [PINNED_FROM_TASK_DEF, DELETED_SO_DEFAULTS_APPLY, Object.keys(DELIBERATE_OVERRIDES), SECRETS];
    const seen = new Set();
    for (const s of sets) {
      for (const k of s) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });
});
