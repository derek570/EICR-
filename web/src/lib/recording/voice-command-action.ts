import { isGuardedClosedEnumField } from '@certmate/shared-utils';
import type { VoiceCommand, VoiceCommandScope } from '@certmate/shared-utils';

/** Server-side `voice_command_response.action` shape (iOS canon).
 *  Built in `src/extraction/sonnet-stream.js` (`kind:
 *  'voice_command_response'`, ~`:1537`, re-emitted ~`:1900`) with
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
 *  PLAN-C (feedback id 129) EXCEPTION: a RECOGNISED action naming one of
 *  the six closed-enum circuit fields is never dropped for a bad value
 *  or a missing scope. "Mutation dropped, success line spoken" is exactly
 *  the failure this plan closes, so those actions are forwarded and the
 *  applier's guard renders one complete-restatement re-ask instead.
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

  /** PLAN-C (feedback id 129) — TOLERANT scalar decode for the value of a
   *  CLOSED-ENUM field. `asString` above drops an empty string and any
   *  wrong-typed scalar, and both `update_field` and `apply_field` then
   *  `return null` — which means the mutation is dropped while the caller
   *  goes on to speak the server's own `spoken_response` ("Set OCPD type
   *  to MCB for all circuits"). The inspector hears a success line for a
   *  write that never happened; on a guarded field that is precisely the
   *  silent-bad-value failure this plan exists to close.
   *
   *  So on guarded fields the mapper decodes tolerantly and forwards, and
   *  the APPLIER owns the rejection — it is the only layer that can
   *  render the complete-restatement re-ask. A finite number stringifies
   *  (an honest "I heard OCPD type '1'"); every other non-string becomes
   *  '' and the guard asks for a value. */
  const asGuardedValue = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '';
  };

  /** PLAN-F item 1 — the orthogonal spare filter, decoded defensively:
   *  only the three known tokens survive, anything else is dropped to
   *  `undefined` (= 'automatic', the per-field-family default). Web
   *  previously ignored the parameter entirely on server-originated
   *  applies, so a spoken "excluding spares" was honoured locally but
   *  silently lost when Sonnet routed the same instruction. */
  const asSparePolicy = (v: unknown): 'automatic' | 'include' | 'exclude' | undefined =>
    v === 'automatic' || v === 'include' || v === 'exclude' ? v : undefined;

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
      if (!field) return null;
      const circuit = asNumber(params.circuit);
      // PLAN-C — on a GUARDED field forward whatever arrived; the applier
      // re-asks. On every other field keep the historical `!value → null`:
      // forwarding '' there would be a BLANKING write, which is a
      // behaviour change well outside this plan's scope.
      if (isGuardedClosedEnumField(field)) {
        return { type: 'update_field', field, value: asGuardedValue(params.value), circuit };
      }
      const value = asString(params.value);
      if (!value) return null;
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
      if (!field) return null;
      const scope = scopeFromParams();
      const sparePolicy = asSparePolicy(params.spare_policy);
      if (isGuardedClosedEnumField(field)) {
        const value = asGuardedValue(params.value);
        // PLAN-C — a guarded action is never dropped. With no resolvable
        // scope, route it through `update_field` with no circuit so the
        // applier renders the missing-target re-ask; returning null here
        // would drop the mutation while the caller speaks the server's
        // "Set … for all circuits" success line.
        if (!scope) return { type: 'update_field', field, value };
        return {
          type: 'apply_field',
          field,
          value,
          scope,
          ...(sparePolicy ? { sparePolicy } : {}),
        };
      }
      const value = asString(params.value);
      if (!value || !scope) return null;
      return { type: 'apply_field', field, value, scope, ...(sparePolicy ? { sparePolicy } : {}) };
    }
    case 'add_circuit': {
      // PLAN-B2 — the SONNET_TOOL_CALLS=off rollback prompt emits
      // `{type:"add_circuit",params:{description}}`. iOS has owned this
      // action since the legacy era; web previously had no case here,
      // so it spoke the server's success line while dropping the
      // mutation. Description is optional on iOS (`params.description
      // ?? ""`), mirrored here — a missing description still adds the
      // circuit.
      const description = typeof params.description === 'string' ? params.description : '';
      return { type: 'add_circuit', description };
    }
    default:
      return null;
  }
}
