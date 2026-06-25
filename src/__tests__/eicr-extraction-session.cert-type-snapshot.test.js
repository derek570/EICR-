/**
 * eicr-extraction-session.cert-type-snapshot.test.js
 *
 * Plan 06-23 obs-#49 Follow-up 1 — make EIC observation-handling PROACTIVE by
 * surfacing the CERTIFICATE TYPE into the model's cached snapshot prefix so
 * RULE 0 (config/prompts/sonnet_agentic_system.md) can steer the model AWAY
 * from `record_observation` on an EIC before it wastes a rejected round-trip.
 *
 * Contract pinned here:
 *   1. EIC session → snapshot prefix contains the cert-type line, positioned
 *      AFTER the TRUST BOUNDARY preamble and BEFORE CIRCUIT SCHEDULE.
 *   2. EICR session → cert-type line ABSENT (default path, byte-unchanged).
 *   3. EIC EMPTY session → snapshot is NON-NULL and contains ONLY the preamble
 *      + cert-type line (no orphaned circuit/board/EXTRACTED/observation
 *      sections). This is Resolved decision 3 — unconditional EIC emission, so
 *      the proactive steer is present from turn 1 (before any reading exists).
 *   4. EICR EMPTY session → snapshot still NULL (legacy null-gate contract
 *      untouched for the dominant cert type).
 *   5. The cert-type line is authoritative SYSTEM context, NOT quoted user
 *      data — it is OUTSIDE the <<<USER_TEXT>>> markers.
 *   6. The null-gate contract change: an empty EIC off-mode session now emits a
 *      snapshot user/assistant pair from buildMessageWindow (previously none).
 *
 * REQUIREMENT: obs-#49 proactive EIC (Resolved decision 3, unconditional EIC).
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));

const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');

const CERT_TYPE_LINE =
  'CERTIFICATE TYPE: EIC (Electrical Installation Certificate — NEW installation, NO observations section). Do NOT call record_observation on this certificate; if the inspector dictates an observation, offer to note it under the certificate comments instead.';

/** Seed a minimal populated surface so the snapshot is non-empty. */
function seedContent(session) {
  session.circuitSchedule = 'Circuit 1: kitchen sockets [Ring, 32A]';
  session.stateSnapshot.circuits[1] = {
    circuit_designation: 'kitchen sockets',
    measured_zs_ohm: 0.35,
  };
  session.recentCircuitOrder = [1];
}

describe('Follow-up 1 (#49) — cert-type snapshot prefix line', () => {
  test('EIC session: snapshot prefix carries the cert-type line, after the preamble and before CIRCUIT SCHEDULE', () => {
    const session = new EICRExtractionSession('k', 'eic-1', 'eic', { toolCallsMode: 'shadow' });
    seedContent(session);
    const snapshot = session.buildStateSnapshotMessage();

    expect(snapshot).toContain(CERT_TYPE_LINE);
    // Ordering: preamble → cert-type line → CIRCUIT SCHEDULE.
    const preambleIdx = snapshot.indexOf('SNAPSHOT TRUST BOUNDARY');
    const certIdx = snapshot.indexOf('CERTIFICATE TYPE: EIC');
    const scheduleIdx = snapshot.indexOf('CIRCUIT SCHEDULE');
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(certIdx).toBeGreaterThan(preambleIdx);
    expect(scheduleIdx).toBeGreaterThan(certIdx);
  });

  test('EICR session: cert-type line ABSENT (default path byte-unchanged)', () => {
    const session = new EICRExtractionSession('k', 'eicr-1', 'eicr', { toolCallsMode: 'shadow' });
    seedContent(session);
    const snapshot = session.buildStateSnapshotMessage();
    expect(snapshot).not.toContain('CERTIFICATE TYPE');
  });

  test('EIC EMPTY session: snapshot is NON-NULL and contains ONLY preamble + cert-type line (no orphaned sections)', () => {
    const session = new EICRExtractionSession('k', 'eic-empty', 'eic', { toolCallsMode: 'shadow' });
    // No content seeded — every surface empty.
    const snapshot = session.buildStateSnapshotMessage();

    expect(snapshot).not.toBeNull();
    expect(snapshot).toContain('SNAPSHOT TRUST BOUNDARY');
    expect(snapshot).toContain(CERT_TYPE_LINE);
    // No orphaned content sections — the proactive steer rides alone.
    expect(snapshot).not.toContain('CIRCUIT SCHEDULE');
    expect(snapshot).not.toContain('EXTRACTED (');
    expect(snapshot).not.toContain('OBSERVATIONS ALREADY RECORDED');
    expect(snapshot).not.toContain('BOARDS');
    expect(snapshot).not.toContain('pending:');
  });

  test('EICR EMPTY session: snapshot still NULL (legacy null-gate contract untouched)', () => {
    const session = new EICRExtractionSession('k', 'eicr-empty', 'eicr', {
      toolCallsMode: 'shadow',
    });
    expect(session.buildStateSnapshotMessage()).toBeNull();
  });

  test('cert-type line is authoritative SYSTEM context — NOT wrapped in <<<USER_TEXT>>> markers', () => {
    const session = new EICRExtractionSession('k', 'eic-marker', 'eic', {
      toolCallsMode: 'shadow',
    });
    const snapshot = session.buildStateSnapshotMessage();
    // The line appears verbatim, never directly preceded by an opening marker.
    expect(snapshot).toContain(CERT_TYPE_LINE);
    expect(snapshot).not.toContain('<<<USER_TEXT>>>CERTIFICATE TYPE');
    expect(snapshot).not.toContain('CERTIFICATE TYPE: EIC (Electrical Installation Certificate — NEW installation, NO observations section).<<<END_USER_TEXT>>>');
  });

  test('null-gate contract change: empty EIC off-mode session now emits a snapshot pair from buildMessageWindow', () => {
    const session = new EICRExtractionSession('k', 'eic-window', 'eic', { toolCallsMode: 'off' });
    // No content — previously isEmpty:true → null → NO snapshot pair. Now the
    // EIC steer makes the snapshot non-null, so the window emits the pair.
    const window = session.buildMessageWindow();
    const snapshotUserMsg = window.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((c) => typeof c.text === 'string' && c.text.includes('CERTIFICATE TYPE: EIC'))
    );
    expect(snapshotUserMsg).toBeDefined();
    // Paired assistant acknowledgement follows.
    const ackIdx = window.indexOf(snapshotUserMsg) + 1;
    expect(window[ackIdx].role).toBe('assistant');
  });

  test('empty EICR off-mode session emits NO snapshot pair (contrast — null-gate intact for EICR)', () => {
    const session = new EICRExtractionSession('k', 'eicr-window', 'eicr', { toolCallsMode: 'off' });
    const window = session.buildMessageWindow();
    const anySnapshot = window.some(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((c) => typeof c.text === 'string' && c.text.includes('SNAPSHOT TRUST BOUNDARY'))
    );
    expect(anySnapshot).toBe(false);
  });
});
