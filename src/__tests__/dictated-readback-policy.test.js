import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildConfirmationText,
  buildGroupedConfirmationText,
} from '../extraction/confirmation-text.js';

const policyUrl = new URL('../../config/dictated-readback-policy-v1.json', import.meta.url);
const policyBytes = readFileSync(fileURLToPath(policyUrl));
const policy = JSON.parse(policyBytes);
const PINNED_DIGEST = '05936a20f2f4443f8b366abe0105020f5b7520461756c0e0e4cb31132b5ecdb9';

describe('DictatedReadbackPolicyV1', () => {
  test('canonical policy bytes and closed action outcomes are pinned', () => {
    expect(createHash('sha256').update(policyBytes).digest('hex')).toBe(PINNED_DIGEST);
    expect(policy).toMatchObject({
      schema_version: 1,
      policy_id: 'DictatedReadbackPolicyV1',
      policy_version: 1,
      preference: { meaning: 'extra_prompts', default: true },
      action_outcomes: ['applied', 'unapplied', 'failed', 'unsupported'],
    });
  });

  test.each(
    policy.vectors.filter(
      (vector) => vector.field && vector.expected_spoken.length > 0 && vector.kind !== 'unsupported'
    )
  )('$id renders the canonical accepted outcome without consulting the preference', (vector) => {
    const text = Array.isArray(vector.circuits)
      ? buildGroupedConfirmationText(vector.field, vector.value, vector.circuits, null, {
          calculated: vector.calculated === true,
        })
      : buildConfirmationText(vector.field, vector.value, vector.circuit, null, {
          calculated: vector.calculated === true,
        });
    expect([text]).toEqual(vector.expected_spoken);
  });

  test('silent and unsupported vectors distinguish application policy from rendering', () => {
    expect(
      policy.vectors.find((vector) => vector.id === 'automatic_derivation').expected_spoken
    ).toEqual([]);
    expect(policy.vectors.find((vector) => vector.id === 'typed_edit').expected_spoken).toEqual([]);
    expect(policy.vectors.find((vector) => vector.id === 'calculation_unreadable_ze')).toEqual(
      expect.objectContaining({
        kind: 'unsupported',
        reason: 'ze_unreadable',
        expected_spoken: [policy.strings.ze_unreadable],
      })
    );
  });
});
