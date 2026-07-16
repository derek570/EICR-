/**
 * aws-credential-deny.mjs — the COMPLETE recorded-mode AWS-credential DENY
 * policy, enforced INSIDE the runner, not only the workflow (plan Item 2 —
 * the existing pwa-replay assertion checks only AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY, weaker than claimed). The legacy voice-latency
 * key loader falls back to `aws secretsmanager get-secret-value` via
 * execSync and would silently acquire the PRODUCTION key on any machine
 * with AWS creds (the dev box has them) — the recorded lane makes every
 * standard credential source unreachable.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AWS_CREDENTIAL_VARS = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
]);

/** Deny all standard AWS credential sources. Returns a restore function. */
export function denyAwsCredentials() {
  const touched = [...AWS_CREDENTIAL_VARS, 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED'];
  const snapshot = {};
  for (const k of touched) snapshot[k] = process.env[k];

  for (const k of AWS_CREDENTIAL_VARS) delete process.env[k];
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frc-aws-deny-'));
  const emptyCreds = path.join(emptyDir, 'credentials');
  const emptyConfig = path.join(emptyDir, 'config');
  fs.writeFileSync(emptyCreds, '');
  fs.writeFileSync(emptyConfig, '');
  process.env.AWS_SHARED_CREDENTIALS_FILE = emptyCreds;
  process.env.AWS_CONFIG_FILE = emptyConfig;
  process.env.AWS_EC2_METADATA_DISABLED = 'true';

  return function restore() {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(emptyDir, { recursive: true, force: true });
  };
}
