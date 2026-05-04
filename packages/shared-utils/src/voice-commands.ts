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
/** Scope of a calculate / apply-field command. Mirrors iOS's
 *  CalculateImpedanceIntent.Scope (VoiceCommandExecutor.swift:581–588)
 *  and the same shape applies to ApplyFieldIntent. */
export type VoiceCommandScope =
  | { kind: 'all' }
  | { kind: 'single'; circuit: number }
  | { kind: 'range'; from: number; to: number };

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
    }
  | {
      /** Calculate Zs (Ze + R1+R2) or R1+R2 (Zs - Ze) across the scope.
       *  Mirrors iOS executeCalculateImpedance (VoiceCommandExecutor.swift:314).
       *  `kind` matches iOS's params.calculate strings exactly. */
      type: 'calculate_impedance';
      kind: 'zs' | 'r1_r2';
      scope: VoiceCommandScope;
    }
  | {
      /** Apply a single (field, value) to every circuit in the scope.
       *  Mirrors iOS executeApplyField. Direct-mutation semantics —
       *  the inspector's deliberate command overrides any pre-existing
       *  value, unlike the auto-extraction priority gate. */
      type: 'apply_field';
      field: string;
      value: string;
      scope: VoiceCommandScope;
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

// Mirrors iOS `VoiceCommandExecutor.setCircuitField` switch (lines 207–256).
// Key = lowercased phrase the inspector might dictate; value = canonical
// snake_case field name on CircuitRow.
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
  'live csa': 'live_csa_mm2',
  'cpc size': 'cpc_csa_mm2',
  'cpc csa': 'cpc_csa_mm2',
  cpc: 'cpc_csa_mm2',
  // Impedance
  zs: 'measured_zs_ohm',
  'measured zs': 'measured_zs_ohm',
  'zed s': 'measured_zs_ohm',
  r1r2: 'r1_r2_ohm',
  'r1 r2': 'r1_r2_ohm',
  'r1 plus r2': 'r1_r2_ohm',
  'r one plus r two': 'r1_r2_ohm',
  'r 1 plus r 2': 'r1_r2_ohm',
  r2: 'r2_ohm',
  // Insulation
  'ir live earth': 'ir_live_earth_mohm',
  'ir live-earth': 'ir_live_earth_mohm',
  'insulation resistance live earth': 'ir_live_earth_mohm',
  'insulation resistance live-earth': 'ir_live_earth_mohm',
  'insulation resistance l e': 'ir_live_earth_mohm',
  'ir live live': 'ir_live_live_mohm',
  'ir live-live': 'ir_live_live_mohm',
  'insulation resistance live live': 'ir_live_live_mohm',
  'insulation resistance live-live': 'ir_live_live_mohm',
  'insulation resistance l l': 'ir_live_live_mohm',
  'insulation test voltage': 'ir_test_voltage_v',
  'ir test voltage': 'ir_test_voltage_v',
  'test voltage': 'ir_test_voltage_v',
  // RCD
  'rcd trip': 'rcd_time_ms',
  'rcd trip time': 'rcd_time_ms',
  'rcd time': 'rcd_time_ms',
  'rcd rating': 'rcd_rating_a',
  'rcd amps': 'rcd_rating_a',
  'rcd type': 'rcd_type',
  'rcd operating current': 'rcd_operating_current_ma',
  'rcd button': 'rcd_button_confirmed',
  'rcd test button': 'rcd_button_confirmed',
  // AFDD
  'afdd button': 'afdd_button_confirmed',
  'afdd test button': 'afdd_button_confirmed',
  // Polarity
  polarity: 'polarity_confirmed',
  // Wiring + reference method + disconnect time + points (iOS lines 231–242)
  'wiring type': 'wiring_type',
  wiring: 'wiring_type',
  'ref method': 'ref_method',
  'reference method': 'ref_method',
  'disconnect time': 'max_disconnect_time_s',
  'maximum disconnect time': 'max_disconnect_time_s',
  'max disconnect time': 'max_disconnect_time_s',
  'number of points': 'number_of_points',
  points: 'number_of_points',
};

// Mirrors iOS `setJobField` switch + bonding fields (lines ~270–305).
const SUPPLY_FIELD_ALIASES: Record<string, { section: 'supply' | 'installation'; field: string }> =
  {
    // Supply
    ze: { section: 'supply', field: 'ze' },
    'zed e': { section: 'supply', field: 'ze' },
    pfc: { section: 'supply', field: 'pfc' },
    'prospective fault current': { section: 'supply', field: 'pfc' },
    'earthing arrangement': { section: 'supply', field: 'earthing_arrangement' },
    earthing: { section: 'supply', field: 'earthing_arrangement' },
    // Bonding (BS 7671 main protective bonding — iOS supplyCharacteristics)
    'water bonding': { section: 'supply', field: 'bonding_water' },
    'bonding water': { section: 'supply', field: 'bonding_water' },
    'gas bonding': { section: 'supply', field: 'bonding_gas' },
    'bonding gas': { section: 'supply', field: 'bonding_gas' },
    'oil bonding': { section: 'supply', field: 'bonding_oil' },
    'bonding oil': { section: 'supply', field: 'bonding_oil' },
    'structural steel bonding': { section: 'supply', field: 'bonding_structural_steel' },
    'lightning protection bonding': { section: 'supply', field: 'bonding_lightning' },
    'main bonding continuity': { section: 'supply', field: 'main_bonding_continuity' },
    // Installation
    address: { section: 'installation', field: 'address' },
    postcode: { section: 'installation', field: 'postcode' },
    'client name': { section: 'installation', field: 'client_name' },
    client: { section: 'installation', field: 'client_name' },
    'client address': { section: 'installation', field: 'client_address' },
    'client postcode': { section: 'installation', field: 'client_postcode' },
    'client town': { section: 'installation', field: 'client_town' },
    'client county': { section: 'installation', field: 'client_county' },
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

/** "calculate Zs|R1+R2 [for] [circuit N | circuits N to M | all]"
 *  Mirrors iOS CalculateImpedanceIntent.parse (VoiceCommandExecutor.swift:610).
 *  Captures: [1] = the kind phrase, [2] = the rest (scope). */
const CALCULATE_RE = /^calculate\s+(.+?)$/i;

/** "<field> <value> for [all|circuits N to M|circuit N]" — apply-field
 *  batch. Mirrors iOS ApplyFieldIntent.parse. The complementary
 *  "<field> for all|... is <value>" shape is handled in a second
 *  matcher inside parseApplyField so we can support the dictation
 *  garble Deepgram produces from "RCD trip time for all circuits is
 *  25 ms" etc. */
const APPLY_FIELD_FOR_RE =
  /^(?:set\s+)?([a-z][a-z0-9 +-]*?)\s+(.+?)\s+for\s+(all(?:\s+circuits)?|circuits?\s+\d+\s+to\s+\d+|circuits?\s+\d+)\s*\.?$/i;

const APPLY_FIELD_IS_RE =
  /^([a-z][a-z0-9 +-]*?)\s+for\s+(all(?:\s+circuits)?|circuits?\s+\d+\s+to\s+\d+|circuits?\s+\d+)\s+is\s+(.+?)\s*\.?$/i;

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

  // Calculate impedance — tested before "set" because "calculate"
  // can't conflict with any other prefix. Mirrors iOS
  // CalculateImpedanceIntent.parse — same scope shapes (all / single /
  // range), same kind tokens ("zs" / "r1_r2"), same permissive trailing
  // punctuation handling.
  const calculateCmd = parseCalculate(trimmed);
  if (calculateCmd) return calculateCmd;

  // Apply field (batch) — "<field> <value> for all circuits" /
  // "<field> for circuits N to M is <value>". Mirrors iOS
  // ApplyFieldIntent.parse. Tested before update_field so "polarity
  // correct for all circuits" doesn't match the un-scoped "set X to Y"
  // grammar.
  const applyCmd = parseApplyField(trimmed);
  if (applyCmd) return applyCmd;

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
// Calculate-impedance + apply-field parsers. Mirror iOS
// CalculateImpedanceIntent / ApplyFieldIntent (VoiceCommandExecutor.swift:
// 578–890+). The shapes the regexes above capture are routed here for
// scope resolution.
// ─────────────────────────────────────────────────────────────────────────

const ZS_PREFIXES = ['zs', 'z s', 'zed s', 'impedance'] as const;
const R1R2_PREFIXES = [
  'r1 plus r2',
  'r 1 plus r 2',
  'r1+r2',
  'r1 + r2',
  'r1 r2',
  'r 1 r 2',
] as const;

function stripPrefix(text: string, prefixes: readonly string[]): string | null {
  for (const p of prefixes) {
    if (text.startsWith(p)) return text.slice(p.length);
  }
  return null;
}

function parseScopeText(text: string): VoiceCommandScope | null {
  let rest = text.trim();
  if (rest.startsWith('for ')) rest = rest.slice(4).trim();
  if (rest === 'all' || rest === 'all circuits') return { kind: 'all' };
  // "circuits N to M" (range) — plural before singular.
  const rangeMatch = /^(?:circuits?)\s+(\d+)\s+to\s+(\d+)/.exec(rest);
  if (rangeMatch) {
    const from = Number(rangeMatch[1]);
    const to = Number(rangeMatch[2]);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      return { kind: 'range', from, to };
    }
  }
  // "circuit N" (single) — accept plural form too as iOS does.
  const singleMatch = /^(?:circuits?)\s+(\d+)/.exec(rest);
  if (singleMatch) {
    const ref = Number(singleMatch[1]);
    if (Number.isFinite(ref) && ref >= 1) return { kind: 'single', circuit: ref };
  }
  return null;
}

function parseCalculate(transcript: string): VoiceCommand | null {
  const m = CALCULATE_RE.exec(transcript);
  if (!m) return null;
  const restRaw = (m[1] ?? '').toLowerCase();
  // Identify the kind. Try longest first so "r1 plus r2" doesn't get
  // prefix-eaten by a shorter "r1" candidate.
  let kind: 'zs' | 'r1_r2' | null = null;
  let rest = '';
  const r1r2Stripped = stripPrefix(restRaw, R1R2_PREFIXES);
  if (r1r2Stripped !== null) {
    kind = 'r1_r2';
    rest = r1r2Stripped.trim();
  } else {
    const zsStripped = stripPrefix(restRaw, ZS_PREFIXES);
    if (zsStripped !== null) {
      kind = 'zs';
      rest = zsStripped.trim();
    }
  }
  if (!kind) return null;
  // Bare "calculate Zs" with no scope is ambiguous — refuse rather than
  // guess. Mirrors iOS line 666–667. The inspector should re-issue with
  // a scope. parseScopeText returns null for empty input so we naturally
  // bail.
  const scope = parseScopeText(rest);
  if (!scope) return null;
  return { type: 'calculate_impedance', kind, scope };
}

/** All known field-alias phrases, sorted longest-first so prefix
 *  matching picks "rcd test button" before falling back to "rcd". */
const APPLY_FIELD_PHRASES = (() => {
  const phrases = [...Object.keys(CIRCUIT_FIELD_ALIASES)];
  // Length-desc; ties resolve by lexical order for determinism.
  phrases.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return phrases;
})();

/** Match the longest known field-alias prefix in `text` (lowercased
 *  + whitespace-collapsed). Returns the phrase + remaining text, or
 *  null if no alias matches. Word-boundary-aware so "rcd" doesn't
 *  swallow "rcd type" wholesale (the alias dictionary has both keys
 *  and the longest-first sort puts "rcd type" ahead). */
function matchFieldPrefix(text: string): { phrase: string; rest: string } | null {
  const lower = text.toLowerCase();
  for (const phrase of APPLY_FIELD_PHRASES) {
    if (lower.startsWith(phrase + ' ') || lower === phrase) {
      const rest = lower.slice(phrase.length).trimStart();
      return { phrase, rest };
    }
  }
  return null;
}

/** Match a scope phrase at the END of `text`. Returns the parsed
 *  scope + the text BEFORE the scope clause, or null if no scope is
 *  found. Handles the canonical iOS-supported scopes — all / single /
 *  range — and tolerates trailing punctuation. */
function matchTrailingScope(text: string): { scope: VoiceCommandScope; before: string } | null {
  const trimmed = text
    .trim()
    .replace(/[.,!?]+$/, '')
    .trimEnd();
  // Try longest scopes first so "for circuits N to M" doesn't get
  // prefix-eaten by "for circuit N".
  const patterns: Array<{ re: RegExp; scope: (m: RegExpExecArray) => VoiceCommandScope }> = [
    {
      re: /^(.*?)\s+for\s+circuits?\s+(\d+)\s+to\s+(\d+)$/i,
      scope: (m) => ({ kind: 'range', from: Number(m[2]), to: Number(m[3]) }),
    },
    {
      re: /^(.*?)\s+for\s+all(?:\s+circuits)?$/i,
      scope: () => ({ kind: 'all' }),
    },
    {
      re: /^(.*?)\s+for\s+circuits?\s+(\d+)$/i,
      scope: (m) => ({ kind: 'single', circuit: Number(m[2]) }),
    },
  ];
  for (const { re, scope: scopeOf } of patterns) {
    const m = re.exec(trimmed);
    if (m) {
      const before = (m[1] ?? '').trim();
      return { scope: scopeOf(m), before };
    }
  }
  return null;
}

/**
 * Parse an apply-field intent. Two grammars, both iOS-canon:
 *   1. "<field> <value> for <scope>" — value comes BEFORE the scope.
 *   2. "<field> for <scope> is <value>" — the Deepgram-garble shape
 *      iOS observed at 14 The Farm Close Road
 *      (VoiceCommandExecutor.swift:749).
 *
 * Field detection uses longest-prefix-match against the alias
 * dictionary — that's the only reliable way to disambiguate
 * "RCD test button" from "RCD" without hardcoding a regex per phrase.
 * Field-write-only commands (the supply/installation aliases) are
 * rejected here so the inspector hears a clear error rather than a
 * silent no-op; supply fields take a different command shape.
 */
function parseApplyField(transcript: string): VoiceCommand | null {
  const lower = transcript.trim().toLowerCase();
  // Strip an optional leading "set " — iOS-style "set polarity correct
  // for all circuits" should land here, not in UPDATE_FIELD_RE.
  const stripped = lower.startsWith('set ') ? lower.slice(4) : lower;

  // Shape 2: "<field> for <scope> is <value>".
  // Search for " for ... is ..." inside the input, then split at " is ".
  const isPattern =
    /^(.+?)\s+for\s+((?:all(?:\s+circuits)?|circuits?\s+\d+(?:\s+to\s+\d+)?))\s+is\s+(.+?)\s*\.?$/i;
  const isMatch = isPattern.exec(stripped);
  if (isMatch) {
    const fieldPhrase = (isMatch[1] ?? '').trim();
    const scopeText = (isMatch[2] ?? '').trim();
    const value = cleanValue((isMatch[3] ?? '').trim());
    const fieldHit = matchFieldPrefix(fieldPhrase);
    const scope = parseScopeText(scopeText);
    if (fieldHit && fieldHit.rest === '' && value && scope) {
      return { type: 'apply_field', field: fieldHit.phrase, value, scope };
    }
  }

  // Shape 1: "<field> <value> for <scope>".
  // Step 1: peel off the trailing scope. Step 2: longest-alias-match
  // on the prefix; whatever's left between the alias and the scope
  // clause is the value.
  const trail = matchTrailingScope(stripped);
  if (trail) {
    const fieldHit = matchFieldPrefix(trail.before);
    if (fieldHit && fieldHit.rest.length > 0) {
      const value = cleanValue(fieldHit.rest);
      if (value) {
        return {
          type: 'apply_field',
          field: fieldHit.phrase,
          value,
          scope: trail.scope,
        };
      }
    }
  }
  return null;
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
    ir_test_voltage_v: 'insulation test voltage',
    rcd_time_ms: 'RCD trip time',
    rcd_rating_a: 'RCD rating',
    rcd_type: 'RCD type',
    rcd_operating_current_ma: 'RCD operating current',
    rcd_button_confirmed: 'RCD test button',
    afdd_button_confirmed: 'AFDD test button',
    ocpd_rating_a: 'OCPD rating',
    ocpd_type: 'OCPD type',
    polarity_confirmed: 'polarity',
    live_csa_mm2: 'cable size',
    cpc_csa_mm2: 'CPC size',
    circuit_designation: 'designation',
    wiring_type: 'wiring type',
    ref_method: 'reference method',
    max_disconnect_time_s: 'maximum disconnect time',
    number_of_points: 'number of points',
    ze: 'Ze',
    pfc: 'PFC',
    earthing_arrangement: 'earthing arrangement',
    bonding_water: 'water bonding',
    bonding_gas: 'gas bonding',
    bonding_oil: 'oil bonding',
    bonding_structural_steel: 'structural steel bonding',
    bonding_lightning: 'lightning protection bonding',
    main_bonding_continuity: 'main bonding continuity',
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
    case 'calculate_impedance':
      return applyCalculateImpedance(command, job);
    case 'apply_field':
      return applyApplyField(command, job);
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
    // iOS canon: "Moved to circuit N" (AlertManager.swift:581) — the
    // shorter phrasing reads more naturally over TTS than the verbose
    // "Moved circuit X to position Y." Pre-fix the PWA used the
    // verbose form; aligned here so both clients speak the same line.
    response: `Moved to circuit ${command.to}.`,
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

// ─────────────────────────────────────────────────────────────────────────
// Calculate impedance + apply-field (batch). Mirrors iOS
// VoiceCommandExecutor.executeCalculateImpedance / executeApplyField
// (lines 314 + 399). Both use resolveCircuitScope semantics: read Ze
// from supply, fan a single (field, value) across the resolved set,
// report the count via the spoken response.
// ─────────────────────────────────────────────────────────────────────────

function indicesForScope(scope: VoiceCommandScope, circuits: VoiceCommandCircuit[]): number[] {
  if (circuits.length === 0) return [];
  if (scope.kind === 'all') {
    // All circuits, in order. iOS skips spare rows here; the PWA's
    // CircuitRow doesn't carry an explicit `is_spare` flag yet, so we
    // include all and let the field-write decide whether the row is
    // applicable (e.g. calculate_zs skips rows without R1+R2).
    return circuits.map((_, i) => i);
  }
  if (scope.kind === 'single') {
    const ref = String(scope.circuit);
    const idx = circuits.findIndex((c) => c.circuit_ref === ref || c.number === ref);
    return idx >= 0 ? [idx] : [];
  }
  // range
  const fromRef = String(scope.from);
  const toRef = String(scope.to);
  const fromIdx = circuits.findIndex((c) => c.circuit_ref === fromRef || c.number === fromRef);
  const toIdx = circuits.findIndex((c) => c.circuit_ref === toRef || c.number === toRef);
  if (fromIdx < 0 || toIdx < 0) return [];
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/**
 * Format an impedance value (ohms) the same way iOS's
 * `formatImpedance` does in VoiceCommandExecutor — 2 decimal places,
 * no trailing-zero stripping (Sonnet's CCU pipeline reads raw strings).
 */
function formatImpedance(value: number): string {
  return value.toFixed(2);
}

function applyCalculateImpedance(
  command: Extract<VoiceCommand, { type: 'calculate_impedance' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  const circuits = [...(job.circuits ?? [])];
  const indices = indicesForScope(command.scope, circuits);
  if (indices.length === 0) {
    return respondUnknown('No circuits found in the specified range.');
  }
  // Read Ze from supply.ze. iOS also tries the active board's Ze
  // first — the PWA doesn't yet carry a board-level Ze override, so
  // supply Ze is the only source. If that's absent, refuse cleanly.
  // Note `Number('')` returns 0 (finite) — so an empty/whitespace
  // string must short-circuit BEFORE the numeric coercion.
  const supply = (job.supply ?? {}) as Record<string, unknown>;
  const zeRaw = supply.ze;
  const zeStr = typeof zeRaw === 'number' ? String(zeRaw) : String(zeRaw ?? '');
  if (zeStr.trim() === '') {
    return respondUnknown("I can't calculate that — no zed E value has been set yet.");
  }
  const zeNum = Number(zeStr);
  if (!Number.isFinite(zeNum)) {
    return respondUnknown("I can't calculate that — no zed E value has been set yet.");
  }
  let updated = 0;
  const next = circuits.map((row, idx) => {
    if (!indices.includes(idx)) return row;
    if (command.kind === 'zs') {
      // Zs = Ze + R1+R2
      const r1r2Str = row.r1_r2_ohm;
      const r1r2 = typeof r1r2Str === 'string' ? Number(r1r2Str) : Number(r1r2Str);
      if (!Number.isFinite(r1r2)) return row;
      const zs = zeNum + (r1r2 as number);
      updated += 1;
      return { ...row, measured_zs_ohm: formatImpedance(zs) };
    }
    // r1_r2 = Zs - Ze
    const zsStr = row.measured_zs_ohm;
    const zs = typeof zsStr === 'string' ? Number(zsStr) : Number(zsStr);
    if (!Number.isFinite(zs)) return row;
    const r1r2 = (zs as number) - zeNum;
    if (r1r2 < 0) return row;
    updated += 1;
    return { ...row, r1_r2_ohm: formatImpedance(r1r2) };
  });
  const label = command.kind === 'zs' ? 'Zs' : 'R1 plus R2';
  if (updated === 0) {
    return {
      response: `No circuits had the values needed to calculate ${label}.`,
    };
  }
  // iOS phrasing — verbatim from VoiceCommandExecutor.swift:374–376.
  const response =
    updated === 1
      ? `Done. Calculated ${label} for 1 circuit.`
      : `Done. Calculated ${label} for ${updated} circuits.`;
  return {
    patch: { circuits: next },
    response,
    changedKeys: command.kind === 'zs' ? ['measured_zs_ohm'] : ['r1_r2_ohm'],
  };
}

function applyApplyField(
  command: Extract<VoiceCommand, { type: 'apply_field' }>,
  job: VoiceCommandJob
): VoiceCommandOutcome {
  // Apply-field always targets per-circuit fields (iOS's executeApplyField
  // never writes supply/installation — those have a different command
  // shape). Reject supply-only fields up front so the inspector hears a
  // clear error rather than a silent no-op.
  const resolved = resolveField(command.field, /* hasCircuit */ true);
  if (!resolved || !resolved.circuitField) {
    return respondUnknown(`I don't know the field "${command.field}".`);
  }
  const circuits = [...(job.circuits ?? [])];
  const indices = indicesForScope(command.scope, circuits);
  if (indices.length === 0) {
    return respondUnknown('No circuits found in the specified range.');
  }
  // Polarity normalisation — same sigil mapping as applyUpdateField.
  let value: string = command.value;
  if (resolved.circuitField === 'polarity_confirmed') {
    if (value === 'PASS') value = '✓';
    else if (value === 'FAIL') value = '✗';
  }
  let updated = 0;
  const next: VoiceCommandCircuit[] = circuits.map((row, idx) => {
    if (!indices.includes(idx)) return row;
    updated += 1;
    return { ...row, [resolved.circuitField as string]: value };
  });
  const label = labelForField(resolved.circuitField);
  if (updated === 0) {
    return { response: `No circuits found in the specified range.` };
  }
  // iOS phrasing — VoiceCommandExecutor.swift around line 472. "Set X
  // for N circuits" / "for 1 circuit". Same direct-mutation semantics
  // (overrides any pre-existing value because the inspector explicitly
  // asked for it).
  const response =
    updated === 1
      ? `Set ${label} to ${command.value} for 1 circuit.`
      : `Set ${label} to ${command.value} for ${updated} circuits.`;
  return {
    patch: { circuits: next },
    response,
    changedKeys: [resolved.circuitField as string],
  };
}
