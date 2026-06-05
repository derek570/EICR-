import type { VoiceCommand, VoiceCommandScope } from '@certmate/shared-utils';

/** Server-side `voice_command_response.action` shape (iOS canon).
 *  Emitted from `src/extraction/sonnet-stream.js:2322` / `:3883` with
 *  `params` matching iOS `VoiceCommandParams`
 *  (`CertMateUnified/Sources/Models/VoiceCommand.swift:35`). */
export interface ServerVoiceCommandAction {
  type?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Map a server-side `voice_command_response.action` (iOS-canon shape)
 *  onto the web's flat `VoiceCommand` discriminated union so the same
 *  `applyVoiceCommand` the local Calculate/Apply intents run through
 *  can execute it. Returns null when the action type is unrecognised
 *  or the params are incomplete — the caller still speaks the server's
 *  `spoken_response`, so an unmapped action still gives the inspector
 *  verbal feedback even if the state mutation is dropped.
 *
 *  Params keys mirror iOS `VoiceCommandParams` Codable: snake_case
 *  `circuit_moves`, `circuit_from`, `circuit_to`, and bare
 *  `field`/`circuit`/`value`/`calculate`/`circuits`. */
export function mapServerActionToVoiceCommand(
  action: ServerVoiceCommandAction
): VoiceCommand | null {
  const params = action.params ?? {};
  const asNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const asString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

  const scopeFromParams = (): VoiceCommandScope | null => {
    const circuitsToken = asString(params.circuits);
    const single = asNumber(params.circuit);
    const from = asNumber(params.circuit_from);
    const to = asNumber(params.circuit_to);
    if (circuitsToken === 'all') return { kind: 'all' };
    if (from != null && to != null) return { kind: 'range', from, to };
    if (single != null) return { kind: 'single', circuit: single };
    return null;
  };

  switch (action.type) {
    case 'update_field': {
      const field = asString(params.field);
      const value = asString(params.value);
      if (!field || !value) return null;
      const circuit = asNumber(params.circuit);
      return { type: 'update_field', field, value, circuit };
    }
    case 'query_field': {
      const field = asString(params.field);
      if (!field) return null;
      const circuit = asNumber(params.circuit);
      return { type: 'query_field', field, circuit };
    }
    case 'reorder_circuits': {
      const moves = Array.isArray(params.circuit_moves)
        ? (params.circuit_moves as Array<Record<string, unknown>>)
        : [];
      const first = moves[0];
      const from = first ? asNumber(first.from) : undefined;
      const to = first ? asNumber(first.to) : undefined;
      if (from == null || to == null) return null;
      return { type: 'reorder_circuits', from, to };
    }
    case 'calculate_impedance': {
      const kindRaw = asString(params.calculate)?.toLowerCase();
      if (kindRaw !== 'zs' && kindRaw !== 'r1_r2') return null;
      const scope = scopeFromParams();
      if (!scope) return null;
      return { type: 'calculate_impedance', kind: kindRaw, scope };
    }
    case 'apply_field': {
      const field = asString(params.field);
      const value = asString(params.value);
      if (!field || !value) return null;
      const scope = scopeFromParams();
      if (!scope) return null;
      return { type: 'apply_field', field, value, scope };
    }
    default:
      return null;
  }
}
