/**
 * network-and-aws-guards.test.js — the recorded-lane network + AWS credential
 * denial (plan Item 2). Covers the complete AWS credential-source matrix
 * (a fake shared-credentials file, AWS_PROFILE, session credentials, web
 * identity, container credential vars), the recorded fetch deny, the live
 * outbound-host policy + vendor-call ceiling, and the execSync-throw proof
 * that the AWS Secrets Manager fallback is structurally unreachable when the
 * key is a dummy string.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  AWS_CREDENTIAL_VARS,
  denyAwsCredentials,
} from '../../../scripts/field-replay/lib/aws-credential-deny.mjs';
import {
  installRecordedFetchDeny,
  installLiveFetchPolicy,
} from '../../../scripts/field-replay/lib/network-guard.mjs';

describe('AWS credential deny (recorded lane)', () => {
  test('clears every standard credential source and points shared files at empty', () => {
    const seeded = {
      AWS_ACCESS_KEY_ID: 'AKIAFAKE',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
      AWS_PROFILE: 'prod',
      AWS_ROLE_ARN: 'arn:aws:iam::1:role/x',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/token',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/creds',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/creds',
    };
    const prev = {};
    for (const [k, v] of Object.entries(seeded)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    const restore = denyAwsCredentials();
    try {
      for (const k of AWS_CREDENTIAL_VARS) expect(process.env[k]).toBeUndefined();
      expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toMatch(/frc-aws-deny-/);
      expect(process.env.AWS_CONFIG_FILE).toMatch(/frc-aws-deny-/);
      expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
    } finally {
      restore();
    }
    for (const [k, v] of Object.entries(seeded)) {
      expect(process.env[k]).toBe(v);
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
});

describe('recorded fetch deny', () => {
  test('every fetch throws and is recorded', () => {
    const guard = installRecordedFetchDeny();
    try {
      expect(() => globalThis.fetch('https://api.postcodes.io/postcodes/SW1A1AA')).toThrow(/DENIED/);
      expect(() => globalThis.fetch('https://api.anthropic.com/v1/messages')).toThrow(/DENIED/);
      expect(guard.attempts).toHaveLength(2);
    } finally {
      guard.restore();
    }
  });
});

describe('live outbound-host policy + vendor-call ceiling', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('permits the Anthropic host, denies postcodes.io and arbitrary hosts', () => {
    globalThis.fetch = () => Promise.resolve('ok'); // stand-in original
    const policy = installLiveFetchPolicy({ allowedHosts: ['api.anthropic.com'], hardMaxVendorCalls: 100 });
    try {
      expect(() => globalThis.fetch('https://api.postcodes.io/x')).toThrow(/DENIED/);
      expect(() => globalThis.fetch('https://example.com/x')).toThrow(/DENIED/);
      expect(globalThis.fetch('https://api.anthropic.com/v1/messages')).resolves.toBe('ok');
      expect(policy.state.vendorCalls).toBe(1);
      expect(policy.state.denied).toHaveLength(2);
    } finally {
      policy.restore();
    }
  });

  test('the hard vendor-call ceiling blocks the next Anthropic call at the fetch boundary', () => {
    globalThis.fetch = () => Promise.resolve('ok');
    const policy = installLiveFetchPolicy({ allowedHosts: ['api.anthropic.com'], hardMaxVendorCalls: 2 });
    try {
      globalThis.fetch('https://api.anthropic.com/1');
      globalThis.fetch('https://api.anthropic.com/2');
      expect(() => globalThis.fetch('https://api.anthropic.com/3')).toThrow(/hard_max_vendor_calls/);
    } finally {
      policy.restore();
    }
  });
});

describe('the AWS Secrets Manager fallback is structurally unreachable in the recorded lane', () => {
  test('a recorded corpus run never invokes execSync/aws (execSync stub would throw if reached)', () => {
    // Subprocess: monkeypatch child_process.execSync to THROW, then run the
    // recorded lane against an empty corpus. Recorded mode constructs the
    // session with a dummy key and never calls getAnthropicKey(), so the
    // AWS-fallback execSync path must never fire — if it did, the throwing
    // stub would crash the run with a distinctive marker.
    const script = `
      import { execSync } from 'node:child_process';
      import cp from 'node:child_process';
      cp.execSync = () => { throw new Error('FIELD_REPLAY_EXECSYNC_REACHED'); };
      const { runFieldCorpusCli } = await import('${path
        .resolve('scripts/voice-latency-bench/transcript-replay-direct-runner.mjs')
        .replace(/\\/g, '/')}');
      const code = await runFieldCorpusCli({ lane: 'recorded', argv: ['--corpus=/nonexistent-corpus-dir'] });
      process.stdout.write('\\nEXIT_CODE=' + code + '\\n');
    `;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        cwd: process.cwd(),
        env: { ...process.env, ANTHROPIC_API_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      out = (err.stdout ?? '') + (err.stderr ?? '');
    }
    expect(out).not.toMatch(/FIELD_REPLAY_EXECSYNC_REACHED/);
    expect(out).toMatch(/EXIT_CODE=0/);
  });
});
