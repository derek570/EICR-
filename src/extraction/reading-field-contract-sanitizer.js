/**
 * PLAN-2D legacy/synthetic reading-field contract boundary.
 *
 * The live Stage 6 dispatcher rejects off-enum write calls before mutation.
 * Legacy `record_extraction` results and synthetic callers do not pass through
 * that dispatcher, so this dependency-neutral leaf applies the same committed
 * client-routing contract before any legacy snapshot update or outward frame.
 *
 * A malformed result may repeat the rejected field/value in confirmations,
 * questions, spoken prose or actions. When any reading is rejected, every
 * audible model-authored surface is therefore replaced by server-owned output:
 * accepted readings get one deterministic read-back per final slot (when
 * confirmations are enabled), questions/alerts are dropped, and the spoken
 * response becomes a generic refusal that cannot expose model text.
 */

import { buildConfirmationText } from './confirmation-text.js';
import { FIELD_CORRECTIONS, applyFieldNameCorrection } from './field-name-corrections.js';
import { KNOWN_FIELDS } from './known-fields.js';

export const OFFSCHEMA_READING_RESPONSE = `I couldn't save a reading because it didn't match a field I recognise — it's logged.`;

function slotKey(reading) {
  const circuit = reading?.circuit == null ? '' : String(reading.circuit);
  const boardId = reading?.board_id == null ? '' : String(reading.board_id);
  return `${reading.field}\u0000${circuit}\u0000${boardId}`;
}

function buildServerOwnedConfirmations(readings) {
  const winners = new Map();
  for (const reading of readings) winners.set(slotKey(reading), reading);

  const confirmations = [];
  for (const reading of winners.values()) {
    const text = buildConfirmationText(reading.field, reading.value, reading.circuit);
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    confirmations.push({
      text,
      field: reading.field,
      circuit: reading.circuit ?? null,
      value: reading.value,
      ...(reading.board_id == null ? {} : { board_id: reading.board_id }),
    });
  }
  return confirmations;
}

/**
 * Mutates `result` and returns it with the number of rejected readings.
 *
 * Idempotence is structural: after the first call the rejected readings are
 * absent, so a later egress call sees zero rejections and leaves the
 * server-owned confirmations untouched.
 */
export function sanitizeReadingFieldContractWithReport(
  result,
  { sessionId = null, logger = null, confirmationsEnabled = true } = {}
) {
  if (!result || !Array.isArray(result.extracted_readings)) {
    return { result, rejectedReadingCount: 0 };
  }

  const acceptedReadings = [];
  let rejectedReadingCount = 0;

  for (const reading of result.extracted_readings) {
    const rawField = reading?.field;
    if (typeof rawField !== 'string' || rawField.length === 0) {
      rejectedReadingCount += 1;
      logger?.warn?.('Reading without a field dropped at the field-contract boundary', {
        sessionId,
        field: rawField,
        circuit: reading?.circuit,
      });
      continue;
    }

    if (!KNOWN_FIELDS.has(rawField)) {
      applyFieldNameCorrection(reading, sessionId, logger);
    }

    if (KNOWN_FIELDS.has(reading.field)) {
      acceptedReadings.push(reading);
      continue;
    }

    rejectedReadingCount += 1;
    logger?.warn?.('Unknown field name from Sonnet', {
      sessionId,
      field: reading.field,
      circuit: reading.circuit,
      value: reading.value,
      correction_available: FIELD_CORRECTIONS[rawField] !== undefined,
    });
  }

  result.extracted_readings = acceptedReadings;
  if (rejectedReadingCount === 0) return { result, rejectedReadingCount };

  result.confirmations =
    confirmationsEnabled === true ? buildServerOwnedConfirmations(acceptedReadings) : [];
  result.questions_for_user = [];
  result.validation_alerts = [];
  result.spoken_response = OFFSCHEMA_READING_RESPONSE;
  result.action = null;
  return { result, rejectedReadingCount };
}

/**
 * Back-compatible mutation helper used at the final egress boundary.
 * Callers that must also repair already-captured model history use the
 * reporting variant above.
 */
export function sanitizeReadingFieldContract(result, options = {}) {
  return sanitizeReadingFieldContractWithReport(result, options).result;
}
