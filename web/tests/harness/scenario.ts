/**
 * B4 — scenario format for the PWA replay harness (pwa-replay-harness
 * Wave 3). Reuses the voice-latency YAML schema (name / suite /
 * capabilities / job_state / transcript timeline with at_ms / expect)
 * with ADDITIVE keys:
 *
 *   - `flux_frames`: explicit Flux frame timeline. When absent (the
 *     normal case) frames are synthesised from `transcript` entries —
 *     interims as progressive prefixes at ~300ms cadence, flagged
 *     `synthetic_interims: true` in metadata.
 *   - `mock_frames`: scripted backend outputs for mock mode (B3),
 *     keyed by the utterance text whose send triggers them.
 *   - `expect.web`: web-pipeline assertions (gate/tts/ask/invariants).
 *
 * Existing backend scenarios remain valid for the backend harness
 * untouched — this module only reads the additive keys.
 */

import fs from 'node:fs';
import yaml from 'js-yaml';
import { normalise } from '@/lib/recording/number-normaliser';
import type { JobDetail } from '@/lib/types';

export interface ScenarioTranscriptEntry {
  at_ms: number;
  text: string;
  isFinal?: boolean;
}

export interface MockFrame {
  type: 'extraction' | 'question' | 'field_corrected';
  readings?: Array<{ field: string; value: unknown; circuit: number | null }>;
  confirmations?: Array<{ field: string; circuit: number | null; text: string }>;
  question?: string;
  question_type?: string;
  tool_call_id?: string;
  /** field_corrected (Stage 6 STI-05 clear_reading wire) — the WIRE field
   *  key + circuit scope. A2 field-feedback-2026-07-14: the backend now
   *  canonicalises the outbound key (r1_r2_ohm → r1_plus_r2) except for
   *  the CLEAR_WIRE_EXEMPT set (r2_ohm stays raw); the mock lane pins
   *  that web's apply path maps both onto the right PWA column. */
  circuit?: number;
  field?: string;
}

export interface MockFrameEntry {
  on_transcript: string;
  frames: MockFrame[];
}

export interface WebExpectations {
  gate_blocked?: string[];
  gate_passed?: string[];
  chime_count?: number;
  sonnet_send_count?: number;
  pending_readings_ask_count?: number;
  rescued_from_buffer?: Array<{ field: string }>;
  confirmations_played?: Array<{ contains: string }>;
  confirmation_played_exactly_once?: boolean;
  no_confirmation_permanently_deferred?: boolean;
  no_confirmation_discarded_without_replay?: boolean;
  applied_fields?: Array<{ key: string; value: unknown }>;
  xfail_until_wave6?: {
    feedback_capture_started?: string[];
    feedback_utterances_not_sent_to_sonnet?: boolean;
  };
}

export interface ReplayScenario {
  file: string;
  name: string;
  description?: string;
  suite?: string;
  metadata?: Record<string, unknown>;
  env?: { regex_hints?: string };
  job_state?: {
    boards?: Array<{
      id: string;
      designation?: string;
      circuits?: Array<{ number: number | string; designation?: string } & Record<string, unknown>>;
    }>;
  };
  transcript: ScenarioTranscriptEntry[];
  mock_frames?: MockFrameEntry[];
  expect?: { web?: WebExpectations };
}

export function loadScenario(file: string): ReplayScenario {
  const doc = yaml.load(fs.readFileSync(file, 'utf8')) as Omit<ReplayScenario, 'file'>;
  if (!doc || !Array.isArray(doc.transcript)) {
    throw new Error(`Scenario ${file} has no transcript timeline`);
  }
  return { file, ...doc };
}

/** Build a JobDetail from the scenario's backend-shaped job_state. */
export function scenarioJob(scenario: ReplayScenario): JobDetail {
  const boards = scenario.job_state?.boards ?? [];
  const circuits = boards.flatMap((b, bi) =>
    (b.circuits ?? []).map((c, ci) => ({
      id: `row-${bi}-${ci}`,
      circuit_ref: String(c.number),
      designation: c.designation ?? '',
      ...Object.fromEntries(
        Object.entries(c).filter(([k]) => k !== 'number' && k !== 'designation')
      ),
    }))
  );
  return {
    id: `job_replay_${scenario.name}`,
    job_id: `job_replay_${scenario.name}`,
    user_id: 'harness',
    folder_name: 'harness',
    certificate_type: 'EICR',
    job_address: '1 Harness Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits,
    boards: boards.map((b) => ({ id: b.id, designation: b.designation ?? '' })),
  } as unknown as JobDetail;
}

/** Progressive-prefix interim synthesis (~300ms cadence). The iOS log
 *  truncates interim payloads, so replays are ALWAYS synthetic here —
 *  interim-dependent behaviours are asserted via invariants/tolerances,
 *  never exact-match (plan §1). */
export function synthesiseInterims(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [text];
  const steps = Math.min(3, words.length - 1);
  const out: string[] = [];
  for (let i = 1; i <= steps; i++) {
    out.push(words.slice(0, Math.ceil((words.length * i) / (steps + 1))).join(' '));
  }
  return out;
}

/**
 * Find the mock frames for a SENT transcript. The pipeline normalises the
 * utterance before sending (NumberNormaliser), so match against both the
 * raw YAML text and its normalised form.
 */
export function mockFramesForSentText(
  scenario: ReplayScenario,
  sentText: string
): MockFrame[] | null {
  for (const entry of scenario.mock_frames ?? []) {
    if (entry.on_transcript === sentText || normalise(entry.on_transcript) === sentText) {
      return entry.frames;
    }
  }
  return null;
}
