/**
 * Server trust boundary for the optional client postcode lookup hint.
 *
 * The hint is evidence for postcodes.io only. It is deliberately separate
 * from regexResults so it can never become a client pre-write, tracker entry,
 * or "already written" instruction to the extraction model.
 */

import { lookupPostcode } from '../postcode_lookup.js';

export const POSTCODE_HINT_STATE = Symbol('postcodeHintState');
export const POSTCODE_HINT_MAX_INPUT_LENGTH = 32;

const UK_POSTCODE_COMPACT = /^(?:GIR0AA|[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2})$/;

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

export function canonicalisePostcodeHint(value) {
  if (typeof value !== 'string' || value.length > POSTCODE_HINT_MAX_INPUT_LENGTH) return null;
  if (containsControlCharacter(value) || /[^A-Za-z0-9 ]/.test(value)) return null;
  const compact = value.trim().replace(/ +/g, '').toUpperCase();
  if (!UK_POSTCODE_COMPACT.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function legacyPostcodeFromCurrentMessage(regexResults) {
  if (!Array.isArray(regexResults)) return null;
  let lastValid = null;
  for (const entry of regexResults) {
    if (!entry || entry.field !== 'install.postcode') continue;
    const canonical = canonicalisePostcodeHint(entry.value);
    if (canonical) lastValid = canonical;
  }
  return lastValid;
}

/**
 * Resolve one inbound transcript envelope exactly once.
 * Dedicated property presence is authoritative even when malformed; that
 * prevents an explicit correction from reviving a legacy value.
 */
export function resolvePostcodeHintState(message) {
  if (!message || typeof message !== 'object') return { state: 'absent', source: 'none' };
  if (POSTCODE_HINT_STATE in message) return message[POSTCODE_HINT_STATE];

  let resolved;
  if (Object.prototype.hasOwnProperty.call(message, 'postcode_hint')) {
    const postcode = canonicalisePostcodeHint(message.postcode_hint);
    resolved = postcode
      ? { state: 'present_valid', source: 'dedicated', postcode }
      : { state: 'present_invalid', source: 'dedicated' };
  } else {
    const postcode = legacyPostcodeFromCurrentMessage(message.regexResults);
    resolved = postcode
      ? { state: 'present_valid', source: 'legacy_regex', postcode }
      : { state: 'absent', source: 'none' };
  }

  Object.defineProperty(message, POSTCODE_HINT_STATE, {
    value: Object.freeze(resolved),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return resolved;
}

/** Last property-present state wins; legacy fallback is considered only when
 * no batch member supplied the dedicated property. */
export function combinePostcodeHintStates(batch) {
  const items = Array.isArray(batch) ? batch : [];
  let lastDedicated = null;
  let lastLegacyValid = null;
  for (const item of items) {
    const state = item?.postcodeHintState ?? item?.options?.postcodeHintState ?? null;
    if (!state) continue;
    if (state.source === 'dedicated') lastDedicated = state;
    else if (state.state === 'present_valid') lastLegacyValid = state;
  }
  return lastDedicated ?? lastLegacyValid ?? { state: 'absent', source: 'none' };
}

export async function lookupResolvedPostcodeHint(state, { logger, sessionId, lane } = {}) {
  if (!state || state.state !== 'present_valid') {
    logger?.info?.('postcode_hint.lookup_skipped', {
      sessionId,
      lane: lane ?? null,
      source: state?.source ?? 'none',
      state: state?.state ?? 'absent',
    });
    return null;
  }

  try {
    const result = await lookupPostcode(state.postcode);
    logger?.info?.('postcode_hint.lookup_complete', {
      sessionId,
      lane: lane ?? null,
      source: state.source,
      outcome: result ? 'hit' : 'miss',
    });
    return result
      ? {
          postcode: canonicalisePostcodeHint(result.postcode) ?? state.postcode,
          town: result.town ?? '',
          county: result.county ?? '',
          valid: true,
        }
      : { postcode: state.postcode, valid: false };
  } catch (error) {
    logger?.warn?.('postcode_hint.lookup_failed', {
      sessionId,
      lane: lane ?? null,
      source: state.source,
      error: error?.message ?? String(error),
    });
    return null;
  }
}

export function buildPostcodeLookupNote(lookup) {
  if (!lookup) return null;
  if (lookup.valid !== true) {
    return "SERVER POSTCODE LOOKUP: no locality match. This is enrichment only; still interpret and record the inspector's postcode in the address family they named.";
  }
  return `SERVER POSTCODE LOOKUP (enrichment only, not a write): canonical postcode ${lookup.postcode}; town ${lookup.town || 'unknown'}; county ${lookup.county || 'unknown'}. You must still emit the dictated postcode/client_postcode write and choose the site or client family from the inspector's words. Do not emit town/county/client_town/client_county solely from this lookup; the backend applies that locality as derived data after the authoritative postcode write.`;
}
