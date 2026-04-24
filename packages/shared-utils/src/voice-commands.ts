/**
 * Voice command parser + dispatcher.
 *
 * Ported from iOS `CertMateUnified/Sources/Recording/VoiceCommandExecutor.swift`.
 * On iOS, the command object arrives pre-parsed from Sonnet's structured
 * response; on web, Sonnet's `voice_command_response` path is not yet
 * wired end-to-end, so this module also ships a MVP regex parser so a
 * transcript like "set OCPD to 32A on circuit 4" can still dispatch
 * client-side. When the server-side path ships, `applyVoiceCommand`
 * stays untouched and `parseVoiceCommand` becomes a fallback.
 *
 * Scope (Phase 8 MVP):
 *   - `update_field`      — "set {field} to {value} on circuit {N}"
 *   - `reorder_circuits`  — "move circuit {N} to position {M}"  (single move)
 *   - `query_field`       — "what is {field} on circuit {N}"  /  "read {field} circuit {N}"
 *
 * Punted to follow-up (marked `partial` in the parity ledger):
 *   - add_circuit / delete_circuit — need a settled local-only circuit
 *     creation flow (Circuit shape has no `localId`, just `id`; the iOS
 *     renumber algorithm is circuit-ref based, which would conflict with
 *     the explicit drag-reorder UX in Phase 5).
 *   - calculate_impedance — already accessible via the Circuits tab
 *     "Calculate" menu (Phase 5), so a voice hook is convenient but not
 *     essential for the recording-pipeline parity goal.
 *   - query_summary — depends on a job-wide summariser that iOS builds
 *     from a non-trivial traversal.
 *
 * The module is PURE. It reads the JobDetail snapshot, returns a partial
 * JobDetail patch + a spoken response string. The caller (recording
 * context) wires the patch into `updateJob()` and the response into the
 * TTS helper.
 */

// We use local structural types rather than pulling from @certmate/shared-types
// because the iOS-oriented shared-types `JobDetail` uses nested sections
// (`installation_details`, `supply_characteristics`) while the web client
// stores them flat on the JobDetail (`installation`, `supply`). The voice
// command executor is consumed by the web recording context, so the flat
// shape is the right abstraction here.

/** Structural subset of the web's CircuitRow — only the keys the voice
 *  command executor touches. Accepts `unknown` values so callers can pass
 *  their wider CircuitRow in without a cast. */
export interface VoiceCommandCircuit {
  id?: string;
  circuit_ref?: string;
  number?: string;
  circuit_designation?: string;
  [key: string]: unknown;
}

/** Structural subset of the web's JobDetail — section bags are
 *  permissive so any app-specific extensions pass through unchanged. */
export interface VoiceCommandJob {
  circuits?: VoiceCommandCircuit[];
  supply?: Record<string, unknown>;
  installation?: Record<string, unknown>;
  board?: Record<string, unknown>;
  extent?: Record<string, unknown>;
  design?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Discriminated union over the commands we recognise. Keep this flat
 *  (no nested shapes) so parseVoiceCommand stays trivially testable. */
export type VoiceCommand =
  | {
      type: 'update_field';
      /** Field key; normalised to the shared-types canonical name. */
      field: string;
      value: string;
      /** 1-based circuit ref. When absent, the field is interpreted as
       *  a supply/installation field (circuit 0 in the iOS executor). */
      circuit?: number;
    }
  | {
      type: 'reorder_circuits';
      from: number;
      to: number;
    }
  | {
      type: 'query_field';
      field: string;
      circuit?: number;
    };

export interface VoiceCommandOutcome {
  /** Partial JobDetail patch; undefined for pure query commands.
   *  Callers cast to their richer JobDetail shape — the structural
   *  typing here only requires the keys the applier might touch. */
  patch?: Record<string, unknown>;
  /** Natural-language response to speak back to the inspector. */
  response: string;
  /** Snake-case keys the patch actually changed. Callers feed these
   *  into the live-fill flash registry so voice-driven edits animate
   *  the same as Sonnet-driven ones. Empty / omitted for queries. */
  changedKeys?: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Field vocabulary — maps spoken phrases onto the canonical circuit or
// job-level field name. Mirrors the iOS executor's switch statements so
// voice commands produce byte-identical field writes across platforms.
// ─────────────────────────────────────────────────────────────────────────

const CIRCUIT_FIELD_ALIASES: Record<string, string> = {
  // Designation
  designation: 'circuit_designation',
  description: 'circuit_designation',
  // OCPD
  ocpd: 'ocpd_rating_a',
  'ocpd rating': 'ocpd_rating_a',
  'ocpd amps': 'ocpd_rating_a',
  rating: 'ocpd_rating_a',
  'ocpd type': 'ocpd_type',
  type: 'ocpd_type',
  // Cable
  'cable size': 'live_csa_mm2',
  cable: 'live_csa_mm2',
  // Impedance
  zs: 'measured_zs_ohm',
  'measured zs': 'measured_zs_ohm',
  r1r2: 'r1_r2_ohm',
  'r1 r2': 'r1_r2_ohm',
  'r1 plus r2': 'r1_r2_ohm',
  'r one plus r two': 'r1_r2_ohm',
  r2: 'r2_ohm',
  // Insulation
  'ir live earth': 'ir_live_earth_mohm',
  'ir live-earth': 'ir_live_earth_mohm',
  'insulation resistance live earth': 'ir_live_earth_mohm',
  'ir live live': 'ir_live_live_mohm',
  'ir live-live': 'ir_live_live_mohm',
  // RCD
  'rcd trip': 'rcd_time_ms',
  'rcd trip time': 'rcd_time_ms',
  'rcd time': 'rcd_time_ms',
  // Polarity
  polarity: 'polarity_confirmed',
};

const SUPPLY_FIELD_ALIASES: Record<string, { section: 'supply' | 'installation'; field: string }> =
  {
    // Supply
    ze: { section: 'supply', field: 'ze' },
    pfc: { section: 'supply', field: 'pfc' },
    'prospective fault current': { section: 'supply', field: 'pfc' },
    'earthing arrangement': { section: 'supply', field: 'earthing_arrangement' },
    earthing: { section: 'supply', field: 'earthing_arrangement' },
    // Installation
    address: { section: 'installation', field: 'address' },
    postcode: { section: 'installation', field: 'postcode' },
    'client name': { section: 'installation', field: 'client_name' },
    client: { section: 'installation', field: 'client_name' },
    'client address': { section: 'installation', field: 'client_address' },
    'client postcode': { section: 'installation', field: 'client_postcode' },
  };

/** Resolve a spoken field phrase against both vocabularies, preferring
 *  the circuit field when the command has an explicit circuit number.
 *  Returns the canonical field + routing section, or null if unknown. */
function resolveField(
  phrase: string,
  hasCircuit: boolean
): {
  circuitField?: string;
  supplyRoute?: { section: 'supply' | 'installation'; field: string };
} | null {
  const normalised = phrase.trim().toLowerCase();
  if (hasCircuit) {
    const circuitField = CIRCUIT_FIELD_ALIASES[normalised];
    if (circuitField) return { circuitField };
  } else {
    const supplyRoute = SUPPLY_FIELD_ALIASES[normalised];
    if (supplyRoute) return { supplyRoute };
  }
  // Either direction — inspectors sometimes elide the "circuit N" suffix.
  const circuitField = CIRCUIT_FIELD_ALIASES[normalised];
  if (circuitField) return { circuitField };
  const supplyRoute = SUPPLY_FIELD_ALIASES[normalised];
  if (supplyRoute) return { supplyRoute };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Parser — trivially small regex set. We deliberately keep the grammar
// narrow: inspectors use a handful of structured phrasings live, and
// false-positive matches on noise transcripts would be worse than
// "unrecognised" (Sonnet handles the freeform case already).
// ─────────────────────────────────────────────────────────────────────────

// Numbered capture groups (not named) — named groups require ES2018+
// and the shared-utils package targets ES2017 for broader consumer
// compatibility. Group indices are documented inline at each use site.
const UPDATE_FIELD_RE =
  /^set\s+([a-z][a-z0-9 ]*?)\s+to\s+([^\s]+(?:\s*[^\s]+)*?)(?:\s+on\s+circuit\s+(\d+))?\s*\.?$/i;

const UPDATE_FIELD_CIRCUIT_LEADING_RE =
  /^circuit\s+(\d+)\s+([a-z][a-z0-9 ]*?)\s+([^\s]+(?:\s*[^\s]+)*?)\s*\.?$/i;

const REORDER_RE = /^move\s+circuit\s+(\d+)\s+to\s+(?:position\s+)?(\d+)\s*\.?$/i;

const QUERY_RE =
  /^(?:what\s+(?:is|was)|read(?:\s+me)?|say|tell\s+me)\s+(?:the\s+)?([a-z][a-z0-9 ]*?)(?:\s+(?:on|of|for)\s+circuit\s+(\d+))?\s*\??$/i;

/**
 * Parse a raw transcript into a structured voice command. Returns null
 * when the transcript doesn't match any known grammar.
 *
 * Transcripts arrive from Deepgram already lowercased-ish but with
 * punctuation intact. We trim + drop trailing full-stops / question
 * marks before matching.
 */
export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  if (!transcript) return null;
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return null;

  // Reorder — tested first because "move" is unambiguous.
  // Groups: [1]=from, [2]=to.
  const reorderMatch = REORDER_RE.exec(trimmed);
  if (reorderMatch) {
    const from = Number(reorderMatch[1]);
    const to = Number(reorderMatch[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && from >= 1 && to >= 1) {
      return { type: 'reorder_circuits', from, to };
    }
  }

  // Query — must precede update_field because "what is Zs on circuit 3"
  // doesn't contain the word "set" so UPDATE_FIELD_RE won't match, but
  // the test above guards against accidental overlap if the regex loosens.
  // Groups: [1]=field, [2]=optional circuit.
  // Field is lower-cased for canonical form — the alias maps in
  // resolveField are keyed on lowercase, and returning the original
  // casing would break quoted field names in assertions / logs.
  const queryMatch = QUERY_RE.exec(trimmed);
  if (queryMatch) {
    const field = (queryMatch[1] ?? '').trim().toLowerCase();
    const circuit = queryMatch[2] ? Number(queryMatch[2]) : undefined;
    if (field.length > 0) {
      return {
        type: 'query_field',
        field,
        circuit: circuit != null && Number.isFinite(circuit) && circuit >= 1 ? circuit : undefined,
      };
    }
  }

  // Update field — "set <field> to <value> [on circuit N]"
  // Groups: [1]=field, [2]=value, [3]=optional circuit.
  const updateMatch = UPDATE_FIELD_RE.exec(trimmed);
  if (updateMatch) {
    const field = (updateMatch[1] ?? '').trim().toLowerCase();
    const rawValue = (updateMatch[2] ?? '').trim();
    const value = cleanValue(rawValue);
    const circuit = updateMatch[3] ? Number(updateMatch[3]) : undefined;
    if (field && value) {
      return {
        type: 'update_field',
        field,
        value,
        circuit: circuit != null && Number.isFinite(circuit) && circuit >= 1 ? circuit : undefined,
      };
    }
  }

  // "circuit 3 zs 0.44" — terse form inspectors sometimes use.
  // Groups: [1]=circuit, [2]=field, [3]=value.
  const leadingMatch = UPDATE_FIELD_CIRCUIT_LEADING_RE.exec(trimmed);
  if (leadingMatch) {
    const circuit = Number(leadingMatch[1]);
    const field = (leadingMatch[2] ?? '').trim().toLowerCase();
    const value = cleanValue((leadingMatch[3] ?? '').trim());
    if (field && value && Number.isFinite(circuit) && circuit >= 1) {
      return { type: 'update_field', field, value, circuit };
    }
  }

  return null;
}

/** Strip trailing "amps"/"amp"/"A"/"ohms"/"ohm" units from numeric values
 *  so a field like `ocpd_rating_a` receives `"32"` not `"32A"` — matches
 *  the circuit defaults schema which stores raw numbers. */
function cleanValue(raw: string): string {
  const noTrailingPunct = raw.replace(/[.,!?]+$/, '').trim();
  // Strip common electrical units inspectors dictate alongside numbers.
  const unitStripped = noTrailingPunct
    .replace(/\s*(?:amps?|amperes?|a)$/i, '')
    .replace(/\s*(?:ohms?|Ω)$/i, '')
    .replace(/\s*(?:volts?|v)$/i, '')
    .replace(/\s*milliseconds?$/i, '')
    .replace(/\s*ms$/i, '')
    .trim();
  // Normalise spoken "pass" / "fail" so polarity_confirmed gets "✓" /
  // "✗" via the update branch.
  const lower = unitStripped.toLowerCase();
  if (lower === 'pass' || lower === 'passed' || lower === 'okay' || lower === 'ok') return 'PASS';
  if (lower === 'fail' || lower === 'failed') return 'FAIL';
  return unitStripped;
}

// ─────────────────────────────────────────────────────────────────────────
// Applier — takes a parsed command + current job, produces a patch.
// Pure; never mutates the input.
// ─────────────────────────────────────────────────────────────────────────

/** Human-readable field phrase → canonical form for response strings. */
function labelForField(field: string): string {
  const map: Record<string, string> = {
    measured_zs_ohm: 'Zs',
    r1_r2_ohm: 'R1 plus R2',
    r2_ohm: 'R2',
    ir_live_earth_mohm: 'insulation resistance live-earth',
    ir_live_live_mohm: 'insulation resistance live-live',
    rcd_time_ms: 'RCD trip time',
    ocpd_rating_a: 'OCPD rating',
    ocpd_type: 'OCPD type',
    polarity_confirmed: 'polarity',
    live_csa_mm2: 'cable size',
    circuit_designation: 'designation',
    ze: 'Ze',
    pfc: 'PFC',
  };
  return map[field] ?? field.replace(/_/g, ' ');
}

function respondUnknown(reason: string): VoiceCommandOutcome {
  return { response: reason };
}

export function applyVoiceCommand(
  command: VoiceCommand,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  switch (command.type) {
    case 'update_field':
      return applyUpdateField(command, job);
    case 'reorder_circuits':
      return applyReorderCircuits(command, job);
    case 'query_field':
      return applyQueryField(command, job);
    default: {
      // Exhaustiveness — TypeScript will flag a missing branch at compile
      // time; the runtime guard is belt-and-braces for hand-edited JSON.
      const never: never = command;
      void never;
      return respondUnknown("I didn't understand that command.");
    }
  }
}

function applyUpdateField(
  command: Extract<VoiceCommand, { type: 'update_field' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const hasCircuit = command.circuit != null;
  const resolved = resolveField(command.field, hasCircuit);
  if (!resolved) {
    return respondUnknown(`I don't know the field "${command.field}".`);
  }

  // Per-circuit update
  if (hasCircuit && resolved.circuitField) {
    const ref = String(command.circuit);
    const circuits = job.circuits ?? [];
    const idx = circuits.findIndex(
      (c) => c.circuit_ref === ref || c.number === ref || c.id === ref
    );
    if (idx === -1) {
      return respondUnknown(`Circuit ${command.circuit} doesn't exist.`);
    }
    // Normalise polarity_confirmed — inspectors dictate "pass"/"fail";
    // iOS converts to the ✓/✗ sigils used everywhere else in the app.
    let value: string = command.value;
    if (resolved.circuitField === 'polarity_confirmed') {
      if (value === 'PASS') value = '✓';
      else if (value === 'FAIL') value = '✗';
    }
    const next: VoiceCommandCircuit[] = circuits.map((row, i) =>
      i === idx ? { ...row, [resolved.circuitField as string]: value } : row
    );
    const label = labelForField(resolved.circuitField);
    return {
      patch: { circuits: next },
      response: `Set ${label} to ${command.value} on circuit ${command.circuit}.`,
      changedKeys: [resolved.circuitField as string],
    };
  }

  // Supply / installation update
  if (resolved.supplyRoute) {
    const { section, field } = resolved.supplyRoute;
    const existing = (job[section] as Record<string, unknown> | undefined) ?? {};
    const patch: Record<string, unknown> = {
      [section]: { ...existing, [field]: command.value },
    };
    const label = labelForField(field);
    return {
      patch,
      response: `Set ${label} to ${command.value}.`,
      changedKeys: [field],
    };
  }

  return respondUnknown(`I don't know where "${command.field}" belongs.`);
}

function applyReorderCircuits(
  command: Extract<VoiceCommand, { type: 'reorder_circuits' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const circuits = [...(job.circuits ?? [])];
  const fromRef = String(command.from);
  const fromIdx = circuits.findIndex((c) => c.circuit_ref === fromRef || c.number === fromRef);
  if (fromIdx === -1) {
    return respondUnknown(`Circuit ${command.from} doesn't exist.`);
  }
  const target = Math.min(Math.max(command.to - 1, 0), circuits.length - 1);
  if (target === fromIdx) {
    return { response: `Circuit ${command.from} is already at position ${command.to}.` };
  }
  const [moved] = circuits.splice(fromIdx, 1);
  circuits.splice(target, 0, moved);
  // Renumber sequentially — mirrors iOS `renumberCircuitRefs`.
  const renumbered: VoiceCommandCircuit[] = circuits.map((row, i) => ({
    ...row,
    circuit_ref: String(i + 1),
    number: String(i + 1),
  }));
  return {
    patch: { circuits: renumbered },
    response: `Moved circuit ${command.from} to position ${command.to}.`,
    changedKeys: ['circuits'],
  };
}

function applyQueryField(
  command: Extract<VoiceCommand, { type: 'query_field' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const hasCircuit = command.circuit != null;
  const resolved = resolveField(command.field, hasCircuit);
  if (!resolved) {
    return respondUnknown(`I don't know the field "${command.field}".`);
  }
  if (hasCircuit && resolved.circuitField) {
    const ref = String(command.circuit);
    const row = (job.circuits ?? []).find((c) => c.circuit_ref === ref || c.number === ref);
    if (!row) {
      return respondUnknown(`Circuit ${command.circuit} doesn't exist.`);
    }
    const value = row[resolved.circuitField as string];
    const label = labelForField(resolved.circuitField);
    if (value == null || value === '') {
      return { response: `${label} on circuit ${command.circuit} is not set.` };
    }
    return { response: `${label} on circuit ${command.circuit} is ${String(value)}.` };
  }
  if (resolved.supplyRoute) {
    const { section, field } = resolved.supplyRoute;
    const value = (job[section] as Record<string, unknown> | undefined)?.[field];
    const label = labelForField(field);
    if (value == null || value === '') return { response: `${label} is not set.` };
    return { response: `${label} is ${String(value)}.` };
  }
  return respondUnknown(`I couldn't find ${command.field}.`);
}
