/**
 * Server-owned site/client address mirroring.
 *
 * Voice address values are authoritative model writes. This controller owns
 * only the one-shot convenience question, its durable answer, and explicit
 * whole-utterance "same address" commands. Mirror copies are derived and
 * therefore travel to clients without read-back confirmations.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  claimAddressMirrorAsk,
  getAddressMirrorIntent,
  rebindAddressMirrorAsk,
  resolveAddressMirrorIntent,
} from '../db.js';
import { applyBoardReadingFlagAware } from './stage6-snapshot-mutators.js';
import {
  attachEffectiveBoardSlot,
  attachSectionDedupeOperation,
  CONFIRMATION_REPLAY_TOKEN,
  decodeBoardReadingKey,
  encodeBoardReadingKey,
  projectBoardReadingWinners,
  recordBoardReadingWrite,
} from './stage6-per-turn-writes.js';

export const ADDRESS_MIRROR_PURPOSE = 'address_mirror';
export const ADDRESS_MIRROR_QUESTION_TYPE = 'address_mirror';
export const ADDRESS_MIRROR_DIRECT_QUESTION_TYPE = 'address_mirror_direct';
export const ADDRESS_MIRROR_SOURCE_WRITES = Symbol('addressMirror.sourceWrites');

const FAMILIES = Object.freeze({
  site: Object.freeze({
    address: 'address',
    postcode: 'postcode',
    town: 'town',
    county: 'county',
  }),
  client: Object.freeze({
    address: 'client_address',
    postcode: 'client_postcode',
    town: 'client_town',
    county: 'client_county',
  }),
});

const FIELD_TO_FAMILY = new Map(
  Object.entries(FAMILIES).flatMap(([family, fields]) =>
    Object.values(fields).map((field) => [field, family])
  )
);

const SITE_TO_CLIENT =
  /^(?:same address for (?:the )?(?:client|customer)|use (?:the )?(?:same|site|installation) address for (?:the )?(?:client|customer))$/i;
const CLIENT_TO_SITE =
  /^(?:same address for (?:the )?(?:site|installation|property)|use (?:the )?(?:same|client|customer) address for (?:the )?(?:site|installation|property))$/i;
const YES =
  /^(?:y|yes|yeah|yep|same|use (?:the )?same|same as (?:the )?(?:site|installation|client|customer))(?:[.!])?$/i;
const NO =
  /^(?:n|no|nope|different|separate|keep (?:them|the addresses) (?:different|separate))(?:[.!])?$/i;

function meaningful(value) {
  return value != null && (typeof value !== 'string' || value.trim().length > 0);
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableSnapshot(snapshot, family) {
  const bucket = snapshot?.circuits?.[0] ?? {};
  const fields = FAMILIES[family];
  return {
    address: meaningful(bucket[fields.address]) ? String(bucket[fields.address]) : null,
    postcode: meaningful(bucket[fields.postcode]) ? String(bucket[fields.postcode]) : null,
    town: meaningful(bucket[fields.town]) ? String(bucket[fields.town]) : null,
    county: meaningful(bucket[fields.county]) ? String(bucket[fields.county]) : null,
  };
}

function complete(source) {
  return meaningful(source?.address) && meaningful(source?.postcode);
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function targetFamily(sourceFamily) {
  return sourceFamily === 'site' ? 'client' : 'site';
}

function sourceFamilyFromWrites(perTurnWrites) {
  const touched = new Set();
  for (const winner of projectBoardReadingWinners(perTurnWrites)) {
    const field = decodeBoardReadingKey(winner.rawKey).field;
    const family = FIELD_TO_FAMILY.get(field);
    if (family && winner.value?.derived !== true) touched.add(family);
  }
  return touched.size === 1 ? [...touched][0] : null;
}

function sourceWriteLedger(perTurnWrites, sourceFamily, askId) {
  const ledger = [];
  for (const winner of projectBoardReadingWinners(perTurnWrites)) {
    const field = decodeBoardReadingKey(winner.rawKey).field;
    if (FIELD_TO_FAMILY.get(field) !== sourceFamily || winner.value?.derived === true) continue;
    ledger.push({
      field,
      value: winner.value?.value,
      confidence: winner.value?.confidence ?? 1,
      source_turn_id: winner.value?.source_turn_id ?? null,
      operation_token: `${askId}:${field}`,
    });
  }
  return ledger;
}

function stageBoardWrite(session, perTurnWrites, field, value, metadata = {}) {
  applyBoardReadingFlagAware(session.stateSnapshot, { field, value, boardId: null });
  const entry = {
    value,
    confidence: metadata.confidence ?? 1,
    source_turn_id: metadata.source_turn_id ?? null,
    ...(metadata.derived === true ? { derived: true, auto_resolved: true } : {}),
  };
  attachEffectiveBoardSlot(entry, field, null);
  if (field === 'postcode' && metadata.replayed === true) {
    attachSectionDedupeOperation(entry, field, 'global', metadata.ordinal ?? 0);
  }
  recordBoardReadingWrite(perTurnWrites, encodeBoardReadingKey(field, undefined), entry);
}

function hasAudibleSourceWrite(perTurnWrites, sourceFamily) {
  return projectBoardReadingWinners(perTurnWrites).some((winner) => {
    const field = decodeBoardReadingKey(winner.rawKey).field;
    return FIELD_TO_FAMILY.get(field) === sourceFamily && winner.value?.derived !== true;
  });
}

function stageAcknowledgement(perTurnWrites, text) {
  if (!perTurnWrites?.answer || perTurnWrites.answer.stagedText != null) return;
  perTurnWrites.answer.featureTouched = true;
  perTurnWrites.answer.stagedText = text;
  perTurnWrites.answer.stagedMeta = { truncated: false, chars: text.length };
  perTurnWrites.answer.outcomes.push({ tool: 'address_mirror', code: 'ok' });
}

function buildCandidate({ session, perTurnWrites, askId, question, sourceFamily }) {
  const family = sourceFamily ?? sourceFamilyFromWrites(perTurnWrites);
  if (!family) return { ok: false, reason: 'source_family_ambiguous' };
  const source = stableSnapshot(session.stateSnapshot, family);
  if (!complete(source)) return { ok: false, reason: 'source_incomplete' };
  const target = stableSnapshot(session.stateSnapshot, targetFamily(family));
  if (complete(target)) return { ok: false, reason: 'target_already_complete' };
  const resolutionToken = randomUUID();
  return {
    ok: true,
    intent: {
      askId,
      questionHash: hash(question),
      sourceFamily: family,
      sourceSnapshot: source,
      sourceVersionHash: hash(JSON.stringify(source)),
      sourceWrites: sourceWriteLedger(perTurnWrites, family, askId),
      resolutionToken,
    },
  };
}

function normaliseRow(row) {
  if (!row) return null;
  return {
    ...row,
    ask_id: row.ask_id ?? row.askId,
    source_family: row.source_family ?? row.sourceFamily,
    source_snapshot: parseJsonObject(row.source_snapshot ?? row.sourceSnapshot),
    source_writes: Array.isArray(row.source_writes ?? row.sourceWrites)
      ? (row.source_writes ?? row.sourceWrites)
      : [],
    resolution_token: row.resolution_token ?? row.resolutionToken,
  };
}

export function parseAddressMirrorAnswer(text) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (YES.test(clean)) return 'yes';
  if (NO.test(clean)) return 'no';
  return null;
}

export function parseDirectAddressMirrorCommand(text) {
  const clean = typeof text === 'string' ? text.trim().replace(/[.!?]+$/, '') : '';
  if (SITE_TO_CLIENT.test(clean)) return { sourceFamily: 'site', targetFamily: 'client' };
  if (CLIENT_TO_SITE.test(clean)) return { sourceFamily: 'client', targetFamily: 'site' };
  return null;
}

/**
 * One controller lives on each authenticated active-session entry. Production
 * uses owner+job DB state; no-DB test/dev sessions use the same API with a
 * session-local at-most-once latch.
 */
export function createAddressMirrorController({ userId, jobId, session, logger, store = {} } = {}) {
  const db = {
    claim: store.claim ?? claimAddressMirrorAsk,
    load: store.load ?? getAddressMirrorIntent,
    rebind: store.rebind ?? rebindAddressMirrorAsk,
    resolve: store.resolve ?? resolveAddressMirrorIntent,
  };
  let localIntent = null;
  let durableIntent = null;
  let locallyAsked = false;
  let allowClarificationReask = false;
  let pendingDirectConflict = null;

  const useDurableStore = Boolean(userId && jobId);

  async function rehydrate() {
    if (!useDurableStore) return localIntent;
    durableIntent = normaliseRow(await db.load(userId, jobId));
    return durableIntent;
  }

  async function claim(input, perTurnWrites, explicitSourceFamily = null) {
    const existing =
      localIntent?.status === 'pending'
        ? localIntent
        : durableIntent?.status === 'pending'
          ? durableIntent
          : null;
    if (allowClarificationReask && existing) {
      allowClarificationReask = false;
      if (!useDurableStore) {
        localIntent = { ...existing, ask_id: input.askId, question_hash: hash(input.question) };
        return { ok: true, intent: localIntent, resumed: true };
      }
      const rebound = await db.rebind(
        userId,
        jobId,
        existing.resolution_token,
        input.askId,
        hash(input.question)
      );
      durableIntent = normaliseRow(rebound);
      return durableIntent?.status === 'pending'
        ? { ok: true, intent: durableIntent, resumed: true }
        : { ok: false, reason: 'clarification_rebind_failed' };
    }

    const candidate = buildCandidate({
      session,
      perTurnWrites,
      askId: input.askId,
      question: input.question,
      sourceFamily: explicitSourceFamily,
    });
    if (!candidate.ok) return candidate;

    if (!useDurableStore) {
      if (locallyAsked) return { ok: false, reason: 'already_asked' };
      locallyAsked = true;
      localIntent = normaliseRow({
        ...candidate.intent,
        status: 'pending',
        ask_id: candidate.intent.askId,
        source_family: candidate.intent.sourceFamily,
        source_snapshot: candidate.intent.sourceSnapshot,
        source_writes: candidate.intent.sourceWrites,
        resolution_token: candidate.intent.resolutionToken,
      });
      return { ok: true, intent: localIntent };
    }

    const out = await db.claim(userId, jobId, candidate.intent);
    if (!out?.claimed) return { ok: false, reason: out?.reason ?? 'already_asked' };
    durableIntent = normaliseRow(out.intent ?? candidate.intent);
    return { ok: true, intent: durableIntent };
  }

  async function claimLiveAsk({ input, askId, perTurnWrites }) {
    if (input?.purpose !== ADDRESS_MIRROR_PURPOSE) return { ok: true, skipped: true };
    return claim({ askId, question: input.question }, perTurnWrites);
  }

  async function claimLegacyQuestion(question, perTurnWrites) {
    if (question?.purpose !== ADDRESS_MIRROR_PURPOSE) return true;
    const capturedWrites = question[ADDRESS_MIRROR_SOURCE_WRITES] ?? perTurnWrites;
    const contextField = question.field ?? question.context_field ?? null;
    const sourceFamily = contextField?.startsWith('client_')
      ? 'site'
      : contextField === 'address'
        ? 'client'
        : null;
    const out = await claim(
      {
        askId: question.id ?? `legacy-address-mirror-${randomUUID()}`,
        question: question.question,
      },
      capturedWrites,
      sourceFamily
    );
    return out.ok;
  }

  async function currentPending() {
    if (localIntent?.status === 'pending') return localIntent;
    if (durableIntent?.status === 'pending') return durableIntent;
    const intent = await rehydrate();
    return intent?.status === 'pending' ? intent : null;
  }

  async function currentIntent() {
    if (localIntent) return localIntent;
    if (durableIntent) return durableIntent;
    return rehydrate();
  }

  async function terminalise(intent, status) {
    if (!useDurableStore) {
      localIntent = { ...intent, status };
      return localIntent;
    }
    const row = await db.resolve(userId, jobId, status, intent.resolution_token);
    durableIntent = normaliseRow(row);
    return durableIntent;
  }

  async function resolveIntentAnswer({ text, perTurnWrites, askId = null }) {
    const answer = parseAddressMirrorAnswer(text);
    if (!answer) {
      allowClarificationReask = true;
      return { handled: false, reason: 'unclear' };
    }
    const intent = await currentIntent();
    if (!intent || (askId && intent.ask_id && askId !== intent.ask_id)) {
      return { handled: false, reason: 'no_matching_pending_intent' };
    }
    const terminalAnswer =
      intent.status === 'resolved_yes' ? 'yes' : intent.status === 'resolved_no' ? 'no' : null;
    if (intent.status === 'conflict' || (terminalAnswer && terminalAnswer !== answer)) {
      return { handled: true, outcome: 'conflict', changed: [], replayedSource: 0 };
    }
    const source = intent.source_snapshot;
    if (!complete(source)) return { handled: false, reason: 'source_incomplete' };

    const sourceFamily = intent.source_family;
    const sourceFields = FAMILIES[sourceFamily];
    const targetFields = FAMILIES[targetFamily(sourceFamily)];
    const currentSource = stableSnapshot(session.stateSnapshot, sourceFamily);
    const replay = [];
    for (const key of Object.keys(sourceFields)) {
      const captured = source[key];
      if (!meaningful(captured)) continue;
      const current = currentSource[key];
      if (meaningful(current) && String(current) !== String(captured)) {
        if (intent.status === 'pending') await terminalise(intent, 'conflict');
        return { handled: true, outcome: 'conflict', changed: [] };
      }
      if (!meaningful(current)) replay.push({ key, field: sourceFields[key], value: captured });
    }

    if (answer === 'yes') {
      const currentTarget = stableSnapshot(session.stateSnapshot, targetFamily(sourceFamily));
      for (const key of Object.keys(targetFields)) {
        const captured = source[key];
        if (!meaningful(captured) || !meaningful(currentTarget[key])) continue;
        if (String(currentTarget[key]) !== String(captured)) {
          if (intent.status === 'pending') await terminalise(intent, 'conflict');
          return { handled: true, outcome: 'conflict', changed: [] };
        }
      }
    }

    if (intent.status === 'pending') {
      const terminal = await terminalise(intent, answer === 'yes' ? 'resolved_yes' : 'resolved_no');
      const expectedStatus = answer === 'yes' ? 'resolved_yes' : 'resolved_no';
      if (!terminal || terminal.status !== expectedStatus) {
        return { handled: true, outcome: 'conflict', changed: [], replayedSource: 0 };
      }
    }

    Object.defineProperty(perTurnWrites, CONFIRMATION_REPLAY_TOKEN, {
      value: intent.resolution_token,
      enumerable: false,
      configurable: true,
    });

    for (const [ordinal, write] of replay.entries()) {
      const ledgerEntry = intent.source_writes.find((item) => item?.field === write.field);
      stageBoardWrite(session, perTurnWrites, write.field, write.value, {
        confidence: ledgerEntry?.confidence ?? 1,
        source_turn_id:
          ledgerEntry?.source_turn_id ??
          ledgerEntry?.operation_token ??
          `::address_mirror_source::${intent.resolution_token}`,
        replayed: true,
        ordinal,
      });
    }

    const changed = [];
    if (answer === 'yes') {
      for (const key of Object.keys(targetFields)) {
        const value = source[key];
        if (!meaningful(value)) continue;
        const field = targetFields[key];
        const current = session.stateSnapshot?.circuits?.[0]?.[field];
        if (meaningful(current) && String(current) === String(value)) continue;
        stageBoardWrite(session, perTurnWrites, field, value, {
          derived: true,
          source_turn_id: `::address_mirror::${intent.resolution_token}`,
        });
        changed.push(field);
      }
      if (!hasAudibleSourceWrite(perTurnWrites, sourceFamily)) {
        stageAcknowledgement(
          perTurnWrites,
          sourceFamily === 'site'
            ? "Okay, I'll use the same address for the client."
            : "Okay, I'll use the same address for the site."
        );
      }
    } else if (!hasAudibleSourceWrite(perTurnWrites, sourceFamily)) {
      stageAcknowledgement(perTurnWrites, "Okay, I'll keep the addresses separate.");
    }
    return { handled: true, outcome: answer, changed, replayedSource: replay.length };
  }

  async function resolveLiveAnswer({ input, outcome, askId, perTurnWrites }) {
    if (input?.purpose !== ADDRESS_MIRROR_PURPOSE || outcome?.answered !== true) {
      return { handled: false };
    }
    return resolveIntentAnswer({ text: outcome.user_text, askId: null, perTurnWrites });
  }

  async function resolveRecoveredAnswer({ context, text, askId, perTurnWrites }) {
    const pending = await currentPending();
    if (!pending) return { handled: false };
    const hasExactPurpose = context?.purpose === ADDRESS_MIRROR_PURPOSE;
    const hasLegacyType = context?.type === ADDRESS_MIRROR_QUESTION_TYPE;
    const hasAskId = typeof askId === 'string' && askId === pending.ask_id;
    if (!hasExactPurpose && !hasLegacyType && !hasAskId) return { handled: false };
    return resolveIntentAnswer({ text, askId: hasAskId ? askId : null, perTurnWrites });
  }

  async function resolvePendingDirectCommand({ text, perTurnWrites }) {
    const command = parseDirectAddressMirrorCommand(text);
    if (!command) return { handled: false };
    const pending = await currentPending();
    if (!pending) return { handled: false };
    if (pending.source_family !== command.sourceFamily) {
      return { handled: true, outcome: 'conflict', changed: [] };
    }
    return resolveIntentAnswer({ text: 'yes', perTurnWrites });
  }

  function applyDirectCommand(text, perTurnWrites, operationToken = randomUUID()) {
    const command = parseDirectAddressMirrorCommand(text);
    if (!command) return { handled: false };
    const source = stableSnapshot(session.stateSnapshot, command.sourceFamily);
    if (!complete(source)) {
      return {
        handled: true,
        outcome: 'source_incomplete',
        question: `What is the ${command.sourceFamily === 'site' ? 'site' : 'client'} address and postcode?`,
      };
    }
    const target = stableSnapshot(session.stateSnapshot, command.targetFamily);
    for (const key of Object.keys(FAMILIES[command.targetFamily])) {
      if (
        meaningful(source[key]) &&
        meaningful(target[key]) &&
        String(source[key]) !== String(target[key])
      ) {
        pendingDirectConflict = { ...command, operationToken };
        return {
          handled: true,
          outcome: 'conflict',
          question: `The ${command.targetFamily} address is already different. Should I replace it?`,
        };
      }
    }
    const changed = [];
    for (const key of Object.keys(FAMILIES[command.targetFamily])) {
      const value = source[key];
      if (!meaningful(value) || String(target[key] ?? '') === String(value)) continue;
      const field = FAMILIES[command.targetFamily][key];
      stageBoardWrite(session, perTurnWrites, field, value, {
        derived: true,
        source_turn_id: `::address_mirror_direct::${operationToken}`,
      });
      changed.push(field);
    }
    stageAcknowledgement(
      perTurnWrites,
      command.targetFamily === 'client'
        ? "Okay, I'll use the site address for the client."
        : "Okay, I'll use the client address for the site."
    );
    return { handled: true, outcome: 'copied', changed };
  }

  function resolveDirectClarification({ context, text, perTurnWrites }) {
    if (context?.type !== ADDRESS_MIRROR_DIRECT_QUESTION_TYPE || !pendingDirectConflict) {
      return { handled: false };
    }
    const answer = parseAddressMirrorAnswer(text);
    if (!answer) return { handled: false, reason: 'unclear' };
    const pending = pendingDirectConflict;
    pendingDirectConflict = null;
    if (answer === 'no') {
      stageAcknowledgement(perTurnWrites, "Okay, I'll leave the addresses unchanged.");
      return { handled: true, outcome: 'no', changed: [] };
    }

    const source = stableSnapshot(session.stateSnapshot, pending.sourceFamily);
    if (!complete(source)) {
      return {
        handled: true,
        outcome: 'source_incomplete',
        question: `What is the ${pending.sourceFamily} address and postcode?`,
      };
    }
    const changed = [];
    for (const key of Object.keys(FAMILIES[pending.targetFamily])) {
      const value = source[key];
      if (!meaningful(value)) continue;
      const field = FAMILIES[pending.targetFamily][key];
      const current = session.stateSnapshot?.circuits?.[0]?.[field];
      if (meaningful(current) && String(current) === String(value)) continue;
      stageBoardWrite(session, perTurnWrites, field, value, {
        derived: true,
        source_turn_id: `::address_mirror_direct::${pending.operationToken}`,
      });
      changed.push(field);
    }
    stageAcknowledgement(
      perTurnWrites,
      pending.targetFamily === 'client'
        ? "Okay, I've replaced the client address with the site address."
        : "Okay, I've replaced the site address with the client address."
    );
    return { handled: true, outcome: 'copied', changed };
  }

  return {
    rehydrate,
    claimLiveAsk,
    claimLegacyQuestion,
    resolveLiveAnswer,
    resolveRecoveredAnswer,
    resolvePendingDirectCommand,
    resolveDirectClarification,
    applyDirectCommand,
    currentPending,
    currentIntent,
  };
}
