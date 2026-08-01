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
  claimAddressMirrorDirectIntent,
  getAddressMirrorIntent,
  getPendingAddressMirrorDirectIntent,
  getRecoverableAddressMirrorDirectIntents,
  markAddressMirrorDirectIntentDelivered,
  markAddressMirrorIntentDelivered,
  rebindAddressMirrorAsk,
  rebindAddressMirrorDirectIntent,
  resolveAddressMirrorDirectIntent,
  resolveAddressMirrorIntent,
} from '../db.js';
import { applyBoardReadingFlagAware } from './stage6-snapshot-mutators.js';
import {
  attachEffectiveBoardSlot,
  attachSectionDedupeOperation,
  CONFIRMATION_REPLAY_TOKEN,
  decodeBoardReadingKey,
  encodeBoardReadingKey,
  FORCE_CONFIRMATIONS,
  projectBoardReadingWinners,
  recordBoardReadingWrite,
} from './stage6-per-turn-writes.js';

export const ADDRESS_MIRROR_PURPOSE = 'address_mirror';
export const ADDRESS_MIRROR_QUESTION_TYPE = 'address_mirror';
export const ADDRESS_MIRROR_DIRECT_QUESTION_TYPE = 'address_mirror_direct';
export const ADDRESS_MIRROR_SOURCE_WRITES = Symbol('addressMirror.sourceWrites');
export const ADDRESS_MIRROR_DIRECT_FOLLOWUP = Symbol('addressMirror.directFollowup');
export const ADDRESS_MIRROR_DELIVERY = Symbol('addressMirror.delivery');

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
    source_version_hash: row.source_version_hash ?? row.sourceVersionHash,
    source_writes: Array.isArray(row.source_writes ?? row.sourceWrites)
      ? (row.source_writes ?? row.sourceWrites)
      : [],
    resolution_token: row.resolution_token ?? row.resolutionToken,
    terminal_outcome: parseJsonObject(row.terminal_outcome ?? row.terminalOutcome),
    delivered_at: row.delivered_at ?? row.deliveredAt ?? null,
  };
}

function normaliseDirectRow(row) {
  if (!row) return null;
  return {
    ...row,
    clarification_kind: row.clarification_kind ?? row.clarificationKind,
    source_family: row.source_family ?? row.sourceFamily,
    target_family: row.target_family ?? row.targetFamily,
    operation_token: row.operation_token ?? row.operationToken,
    question_id: row.question_id ?? row.questionId,
    source_snapshot: parseJsonObject(row.source_snapshot ?? row.sourceSnapshot) ?? {},
    source_writes: Array.isArray(row.source_writes ?? row.sourceWrites)
      ? (row.source_writes ?? row.sourceWrites)
      : [],
    terminal_outcome: parseJsonObject(row.terminal_outcome ?? row.terminalOutcome),
    delivered_at: row.delivered_at ?? row.deliveredAt ?? null,
  };
}

function stageDelivery(perTurnWrites, kind, token) {
  if (!perTurnWrites || typeof token !== 'string' || !token) return;
  Object.defineProperty(perTurnWrites, ADDRESS_MIRROR_DELIVERY, {
    value: { kind, token },
    enumerable: false,
    configurable: true,
  });
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
    markDelivered: store.markDelivered ?? markAddressMirrorIntentDelivered,
    claimDirect: store.claimDirect ?? claimAddressMirrorDirectIntent,
    loadDirect: store.loadDirect ?? getPendingAddressMirrorDirectIntent,
    loadRecoverableDirect:
      store.loadRecoverableDirect ??
      (store.loadDirect ? null : getRecoverableAddressMirrorDirectIntents),
    rebindDirect: store.rebindDirect ?? rebindAddressMirrorDirectIntent,
    resolveDirect: store.resolveDirect ?? resolveAddressMirrorDirectIntent,
    markDirectDelivered: store.markDirectDelivered ?? markAddressMirrorDirectIntentDelivered,
  };
  let localIntent = null;
  let durableIntent = null;
  let locallyAsked = false;
  let allowClarificationReask = false;
  let directIntent = null;
  let recoverableDirectIntents = [];
  let terminalRecoveryArmed = false;

  const useDurableStore = Boolean(userId && jobId);

  async function rehydrate() {
    if (!useDurableStore) return localIntent;
    const [mirrorRow, directRows] = await Promise.all([
      db.load(userId, jobId),
      db.loadRecoverableDirect
        ? db.loadRecoverableDirect(userId, jobId)
        : Promise.resolve(db.loadDirect(userId, jobId)).then((row) => (row ? [row] : [])),
    ]);
    durableIntent = normaliseRow(mirrorRow);
    recoverableDirectIntents = (Array.isArray(directRows) ? directRows : [directRows])
      .filter(Boolean)
      .map(normaliseDirectRow);
    directIntent =
      recoverableDirectIntents.find((row) => row.status === 'pending') ??
      recoverableDirectIntents[0] ??
      null;
    terminalRecoveryArmed =
      !durableIntent?.delivered_at &&
      (durableIntent?.status === 'resolved_yes' ||
        durableIntent?.status === 'resolved_no' ||
        durableIntent?.status === 'conflict');
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
    const expectedSourceFamily = contextField?.startsWith('client_')
      ? 'site'
      : contextField === 'address'
        ? 'client'
        : null;
    const sourceFamily = sourceFamilyFromWrites(capturedWrites);
    if (!sourceFamily || !expectedSourceFamily || sourceFamily !== expectedSourceFamily) {
      return false;
    }
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

  async function terminalise(intent, status, terminalOutcome) {
    if (!useDurableStore) {
      localIntent = { ...intent, status, terminal_outcome: terminalOutcome, delivered_at: null };
      return localIntent;
    }
    const row = await db.resolve(userId, jobId, status, intent.resolution_token, terminalOutcome);
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
    if (intent.status !== 'pending' && intent.delivered_at) {
      return {
        handled: true,
        outcome: 'duplicate',
        changed: [],
        replayedSource: 0,
        resolutionToken: intent.resolution_token,
      };
    }
    const terminalAnswer =
      intent.status === 'resolved_yes' ? 'yes' : intent.status === 'resolved_no' ? 'no' : null;
    const conflict = async (reason) => {
      if (intent.status === 'pending') {
        await terminalise(intent, 'conflict', { outcome: 'conflict', reason });
      }
      const question =
        reason === 'answer_changed'
          ? "That answer conflicts with the one already recorded, so I haven't changed the addresses."
          : "The address changed after I asked, so I haven't copied it. Please tell me which address to use.";
      stageAcknowledgement(perTurnWrites, question);
      stageDelivery(perTurnWrites, 'convenience', intent.resolution_token);
      return {
        handled: true,
        outcome: 'conflict',
        changed: [],
        replayedSource: 0,
        clearAskId: intent.ask_id ?? null,
        resolutionToken: intent.resolution_token,
        delivery: { kind: 'convenience', token: intent.resolution_token },
      };
    };
    if (intent.status === 'conflict') return conflict('source_drift');
    if (terminalAnswer && terminalAnswer !== answer) {
      return conflict('answer_changed');
    }
    const source = intent.source_snapshot;
    if (!complete(source)) return { handled: false, reason: 'source_incomplete' };

    const sourceFamily = intent.source_family;
    const sourceFields = FAMILIES[sourceFamily];
    const targetFields = FAMILIES[targetFamily(sourceFamily)];
    const currentSource = stableSnapshot(session.stateSnapshot, sourceFamily);
    const replay = [];
    const currentHash = hash(JSON.stringify(currentSource));
    for (const key of Object.keys(sourceFields)) {
      const captured = source[key];
      const current = currentSource[key];
      if (!meaningful(captured)) {
        if (meaningful(current)) return conflict('source_drift');
        continue;
      }
      if (meaningful(current) && String(current) !== String(captured)) {
        return conflict('source_drift');
      }
      if (!meaningful(current)) replay.push({ key, field: sourceFields[key], value: captured });
    }
    if (
      replay.length === 0 &&
      intent.source_version_hash &&
      currentHash !== intent.source_version_hash
    ) {
      return conflict('source_drift');
    }

    if (answer === 'yes') {
      const currentTarget = stableSnapshot(session.stateSnapshot, targetFamily(sourceFamily));
      for (const key of Object.keys(targetFields)) {
        const captured = source[key];
        if (!meaningful(captured) || !meaningful(currentTarget[key])) continue;
        if (String(currentTarget[key]) !== String(captured)) {
          return conflict('target_drift');
        }
      }
    }

    if (intent.status === 'pending') {
      const terminal = await terminalise(
        intent,
        answer === 'yes' ? 'resolved_yes' : 'resolved_no',
        { outcome: answer }
      );
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
    stageDelivery(perTurnWrites, 'convenience', intent.resolution_token);
    if (replay.length > 0) {
      Object.defineProperty(perTurnWrites, FORCE_CONFIRMATIONS, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }

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
    return {
      handled: true,
      outcome: answer,
      changed,
      replayedSource: replay.length,
      resolutionToken: intent.resolution_token,
      clearAskId: intent.ask_id ?? null,
      delivery: { kind: 'convenience', token: intent.resolution_token },
    };
  }

  async function resolveLiveAnswer({ input, outcome, askId, perTurnWrites }) {
    if (input?.purpose !== ADDRESS_MIRROR_PURPOSE || outcome?.answered !== true) {
      return { handled: false };
    }
    return resolveIntentAnswer({ text: outcome.user_text, askId: null, perTurnWrites });
  }

  async function resolveRecoveredAnswer({ context, text, askId, perTurnWrites }) {
    const intent = await currentIntent();
    if (!intent) return { handled: false };
    const hasExactPurpose = context?.purpose === ADDRESS_MIRROR_PURPOSE;
    const hasLegacyType = context?.type === ADDRESS_MIRROR_QUESTION_TYPE;
    const hasAskId = typeof askId === 'string' && askId === intent.ask_id;
    if (!hasExactPurpose && !hasLegacyType && !hasAskId) return { handled: false };
    const out = await resolveIntentAnswer({ text, askId: hasAskId ? askId : null, perTurnWrites });
    if (out?.handled) terminalRecoveryArmed = false;
    return out;
  }

  async function recoverConvenienceDelivery(perTurnWrites) {
    const intent = await currentIntent();
    if (!intent || intent.status === 'pending' || intent.delivered_at) {
      return { handled: false };
    }
    const answer =
      intent.terminal_outcome?.outcome ??
      (intent.status === 'resolved_yes'
        ? 'yes'
        : intent.status === 'resolved_no'
          ? 'no'
          : 'conflict');
    const out =
      answer === 'conflict'
        ? await resolveIntentAnswer({ text: 'yes', perTurnWrites })
        : await resolveIntentAnswer({ text: answer, perTurnWrites });
    if (out?.handled) terminalRecoveryArmed = false;
    return out;
  }

  async function markDelivered(delivery) {
    if (!delivery || typeof delivery.token !== 'string') return false;
    if (!useDurableStore) {
      if (delivery.kind === 'convenience' && localIntent?.resolution_token === delivery.token) {
        localIntent = { ...localIntent, delivered_at: new Date().toISOString() };
      }
      if (delivery.kind === 'direct') {
        recoverableDirectIntents = recoverableDirectIntents.map((row) =>
          row.operation_token === delivery.token
            ? { ...row, delivered_at: new Date().toISOString() }
            : row
        );
        if (directIntent?.operation_token === delivery.token) {
          directIntent = { ...directIntent, delivered_at: new Date().toISOString() };
        }
      }
      return true;
    }
    if (delivery.kind === 'convenience') {
      const row = await db.markDelivered(userId, jobId, delivery.token);
      if (row) durableIntent = normaliseRow(row);
      return Boolean(row);
    }
    if (delivery.kind === 'direct') {
      const row = await db.markDirectDelivered(userId, jobId, delivery.token);
      if (!row) return false;
      const normalised = normaliseDirectRow(row);
      recoverableDirectIntents = recoverableDirectIntents.filter(
        (item) => item.operation_token !== delivery.token
      );
      if (directIntent?.operation_token === delivery.token) directIntent = null;
      return Boolean(normalised);
    }
    return false;
  }

  async function shouldHoldReplyTranscript() {
    if (terminalRecoveryArmed) return true;
    return Boolean(await currentPending());
  }

  function noteReplyHoldReleased() {
    terminalRecoveryArmed = false;
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

  function directQuestion(intent) {
    if (!intent) return null;
    return intent.clarification_kind === 'conflict'
      ? `The ${intent.target_family} address is already different. Should I replace it?`
      : intent.clarification_kind === 'incomplete'
        ? `What is the ${intent.source_family} address and postcode?`
        : null;
  }

  async function saveDirectIntent(
    command,
    clarificationKind,
    operationToken,
    sourceSnapshot = {},
    sourceWrites = []
  ) {
    const questionId = `address-mirror-direct-${operationToken}`;
    const candidate = normaliseDirectRow({
      status: 'pending',
      clarification_kind: clarificationKind,
      source_family: command.sourceFamily,
      target_family: command.targetFamily,
      operation_token: operationToken,
      question_id: questionId,
      source_snapshot: sourceSnapshot,
      source_writes: sourceWrites,
    });
    if (!useDurableStore) {
      if (directIntent?.operation_token === operationToken) {
        return { claimed: false, reason: 'duplicate_operation', intent: directIntent };
      }
      if (directIntent?.status === 'pending') {
        return {
          claimed: false,
          reason: 'clarification_already_pending',
          intent: directIntent,
        };
      }
      directIntent = candidate;
      recoverableDirectIntents.push(candidate);
      return { claimed: true, intent: directIntent };
    }
    const out = await db.claimDirect(userId, jobId, {
      clarificationKind,
      sourceFamily: command.sourceFamily,
      targetFamily: command.targetFamily,
      operationToken,
      questionId,
      sourceSnapshot,
      sourceWrites,
    });
    if (out?.intent) {
      const row = normaliseDirectRow(out.intent);
      if (row.status === 'pending') directIntent = row;
      if (!recoverableDirectIntents.some((item) => item.operation_token === row.operation_token)) {
        recoverableDirectIntents.push(row);
      }
    } else if (out?.claimed) {
      directIntent = candidate;
      recoverableDirectIntents.push(candidate);
    }
    return out;
  }

  async function terminaliseDirect(
    status,
    terminalOutcome,
    sourceSnapshot = null,
    sourceWrites = null,
    intent = directIntent
  ) {
    if (!intent) return null;
    if (!useDurableStore) {
      directIntent = normaliseDirectRow({
        ...intent,
        status,
        terminal_outcome: terminalOutcome,
        source_snapshot: sourceSnapshot ?? intent.source_snapshot,
        source_writes: sourceWrites ?? intent.source_writes,
        delivered_at: null,
      });
      recoverableDirectIntents = recoverableDirectIntents.map((row) =>
        row.operation_token === intent.operation_token ? directIntent : row
      );
      return directIntent;
    }
    const row = await db.resolveDirect(
      userId,
      jobId,
      intent.operation_token,
      status,
      terminalOutcome,
      sourceSnapshot,
      sourceWrites
    );
    directIntent = normaliseDirectRow(row);
    if (directIntent) {
      recoverableDirectIntents = recoverableDirectIntents.map((item) =>
        item.operation_token === directIntent.operation_token ? directIntent : item
      );
    }
    return directIntent;
  }

  async function rebindDirectConflict(sourceSnapshot, sourceWrites) {
    if (!directIntent) return null;
    const questionId = `address-mirror-direct-conflict-${directIntent.operation_token}`;
    if (!useDurableStore) {
      directIntent = {
        ...directIntent,
        clarification_kind: 'conflict',
        question_id: questionId,
        source_snapshot: sourceSnapshot ?? directIntent.source_snapshot,
        source_writes: sourceWrites ?? directIntent.source_writes,
      };
      return directIntent;
    }
    directIntent = normaliseDirectRow(
      await db.rebindDirect(
        userId,
        jobId,
        directIntent.operation_token,
        'conflict',
        questionId,
        sourceSnapshot,
        sourceWrites
      )
    );
    return directIntent;
  }

  function materializeDirectTerminal(intent, perTurnWrites, sourceAudible = false) {
    if (!intent || intent.delivered_at) {
      return { handled: true, outcome: 'duplicate', changed: [] };
    }
    const terminalOutcome = intent.terminal_outcome?.outcome;
    stageDelivery(perTurnWrites, 'direct', intent.operation_token);
    if (terminalOutcome === 'no') {
      stageAcknowledgement(
        perTurnWrites,
        intent.clarification_kind === 'conflict'
          ? "Okay, I'll leave the addresses unchanged."
          : "Okay, I haven't copied the address."
      );
      return {
        handled: true,
        outcome: 'no',
        changed: [],
        resolutionToken: intent.operation_token,
        delivery: { kind: 'direct', token: intent.operation_token },
      };
    }
    const source = intent.source_snapshot;
    if (!complete(source)) return { handled: false, reason: 'source_incomplete' };
    const sourceFields = FAMILIES[intent.source_family];
    const currentSource = stableSnapshot(session.stateSnapshot, intent.source_family);
    let replayedSource = 0;
    for (const [ordinal, key] of Object.keys(sourceFields).entries()) {
      const value = source[key];
      if (!meaningful(value)) continue;
      if (meaningful(currentSource[key]) && String(currentSource[key]) !== String(value)) {
        stageAcknowledgement(
          perTurnWrites,
          "The address changed before I could finish, so I haven't copied it."
        );
        return {
          handled: true,
          outcome: 'conflict',
          changed: [],
          replayedSource: 0,
          resolutionToken: intent.operation_token,
          delivery: { kind: 'direct', token: intent.operation_token },
        };
      }
      if (!meaningful(currentSource[key])) {
        const field = sourceFields[key];
        const ledgerEntry = intent.source_writes.find((item) => item?.field === field);
        stageBoardWrite(session, perTurnWrites, field, value, {
          confidence: ledgerEntry?.confidence ?? 1,
          source_turn_id:
            ledgerEntry?.source_turn_id ??
            ledgerEntry?.operation_token ??
            `::address_mirror_direct_source::${intent.operation_token}`,
          replayed: true,
          ordinal,
        });
        replayedSource += 1;
      }
    }
    if (replayedSource > 0) {
      Object.defineProperty(perTurnWrites, FORCE_CONFIRMATIONS, {
        value: true,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(perTurnWrites, CONFIRMATION_REPLAY_TOKEN, {
        value: intent.operation_token,
        enumerable: false,
        configurable: true,
      });
    }
    const target = stableSnapshot(session.stateSnapshot, intent.target_family);
    const changed = [];
    for (const key of Object.keys(FAMILIES[intent.target_family])) {
      const value = source[key];
      if (!meaningful(value) || String(target[key] ?? '') === String(value)) continue;
      const field = FAMILIES[intent.target_family][key];
      stageBoardWrite(session, perTurnWrites, field, value, {
        derived: true,
        source_turn_id: `::address_mirror_direct::${intent.operation_token}`,
      });
      changed.push(field);
    }
    if (!sourceAudible && !hasAudibleSourceWrite(perTurnWrites, intent.source_family)) {
      stageAcknowledgement(
        perTurnWrites,
        intent.terminal_outcome?.replacement === true
          ? intent.target_family === 'client'
            ? "Okay, I've replaced the client address with the site address."
            : "Okay, I've replaced the site address with the client address."
          : intent.target_family === 'client'
            ? "Okay, I'll use the site address for the client."
            : "Okay, I'll use the client address for the site."
      );
    }
    return {
      handled: true,
      outcome: 'copied',
      changed,
      replayedSource,
      resolutionToken: intent.operation_token,
      delivery: { kind: 'direct', token: intent.operation_token },
    };
  }

  async function applyDirectCommand(text, perTurnWrites, operationToken = randomUUID()) {
    const command = parseDirectAddressMirrorCommand(text);
    if (!command) return { handled: false };
    const source = stableSnapshot(session.stateSnapshot, command.sourceFamily);
    const target = stableSnapshot(session.stateSnapshot, command.targetFamily);
    const hasConflict = complete(source)
      ? Object.keys(FAMILIES[command.targetFamily]).some(
          (key) =>
            meaningful(source[key]) &&
            meaningful(target[key]) &&
            String(source[key]) !== String(target[key])
        )
      : false;
    const clarificationKind = !complete(source)
      ? 'incomplete'
      : hasConflict
        ? 'conflict'
        : 'direct';
    const claimed = await saveDirectIntent(command, clarificationKind, operationToken, source);
    if (!claimed?.claimed) {
      if (claimed?.reason === 'duplicate_operation') {
        const existing = normaliseDirectRow(claimed.intent);
        if (existing?.delivered_at) {
          return { handled: true, outcome: 'duplicate', changed: [] };
        }
        if (existing?.status !== 'pending') {
          return materializeDirectTerminal(existing, perTurnWrites);
        }
        if (existing?.clarification_kind === 'direct') {
          const terminal = await terminaliseDirect(
            'resolved_yes',
            { outcome: 'copied', replacement: false },
            existing.source_snapshot,
            existing.source_writes,
            existing
          );
          return materializeDirectTerminal(terminal, perTurnWrites);
        }
        return {
          handled: true,
          outcome: existing?.clarification_kind === 'conflict' ? 'conflict' : 'source_incomplete',
          question: directQuestion(existing),
          questionId: existing?.question_id,
        };
      }
      return { handled: true, outcome: 'already_pending', changed: [] };
    }
    if (!complete(source)) {
      return {
        handled: true,
        outcome: 'source_incomplete',
        question: `What is the ${command.sourceFamily === 'site' ? 'site' : 'client'} address and postcode?`,
        questionId: directIntent.question_id,
      };
    }
    if (hasConflict) {
      return {
        handled: true,
        outcome: 'conflict',
        question: directQuestion(directIntent),
        questionId: directIntent.question_id,
      };
    }
    const terminal = await terminaliseDirect(
      'resolved_yes',
      { outcome: 'copied', replacement: false },
      source,
      []
    );
    return materializeDirectTerminal(terminal, perTurnWrites);
  }

  async function resolveDirectClarification({ context, text, perTurnWrites }) {
    if (context?.type !== ADDRESS_MIRROR_DIRECT_QUESTION_TYPE) {
      return { handled: false };
    }
    if (directIntent?.status !== 'pending') {
      return { handled: false, reason: 'stale_direct_question' };
    }
    const suppliedQuestionId = context?.tool_call_id ?? context?.toolCallId ?? null;
    const hasExactQuestionId =
      typeof suppliedQuestionId === 'string' && suppliedQuestionId === directIntent.question_id;
    const hasLegacyExactQuestion =
      suppliedQuestionId == null && context?.question === directQuestion(directIntent);
    if (!hasExactQuestionId && !hasLegacyExactQuestion) {
      return { handled: false, reason: 'stale_direct_question' };
    }
    if (directIntent.clarification_kind === 'incomplete') {
      const answer = parseAddressMirrorAnswer(text);
      if (answer === 'no') {
        const terminal = await terminaliseDirect('resolved_no', { outcome: 'no' });
        return materializeDirectTerminal(terminal, perTurnWrites);
      }
      // The deciding address/postcode reply must be extracted normally. The
      // post-write finalizer below observes the authoritative source writes,
      // then performs the derived copy without re-exposing the command.
      return { handled: false, reason: 'awaiting_source_writes' };
    }
    const answer = parseAddressMirrorAnswer(text);
    if (!answer) return { handled: false, reason: 'unclear' };
    if (answer === 'no') {
      const terminal = await terminaliseDirect('resolved_no', { outcome: 'no' });
      return materializeDirectTerminal(terminal, perTurnWrites);
    }
    const source = complete(directIntent.source_snapshot)
      ? directIntent.source_snapshot
      : stableSnapshot(session.stateSnapshot, directIntent.source_family);
    const terminal = await terminaliseDirect(
      'resolved_yes',
      { outcome: 'copied', replacement: true },
      source,
      directIntent.source_writes
    );
    return materializeDirectTerminal(terminal, perTurnWrites);
  }

  async function finalizeDirectAfterWrites({
    successfulFields,
    perTurnWrites,
    sourceAudible = false,
    sourceWrites = null,
  }) {
    if (directIntent?.status !== 'pending' || directIntent.clarification_kind !== 'incomplete') {
      return { handled: false };
    }
    const fields =
      successfulFields instanceof Set ? successfulFields : new Set(successfulFields ?? []);
    const touchedFamilies = new Set(
      [...fields].map((field) => FIELD_TO_FAMILY.get(field)).filter(Boolean)
    );
    if (touchedFamilies.size !== 1 || !touchedFamilies.has(directIntent.source_family)) {
      return { handled: false };
    }
    const source = stableSnapshot(session.stateSnapshot, directIntent.source_family);
    if (!complete(source)) return { handled: false };
    const target = stableSnapshot(session.stateSnapshot, directIntent.target_family);
    for (const key of Object.keys(FAMILIES[directIntent.target_family])) {
      if (
        meaningful(source[key]) &&
        meaningful(target[key]) &&
        String(source[key]) !== String(target[key])
      ) {
        const capturedWrites = Array.isArray(sourceWrites)
          ? sourceWrites
          : sourceWriteLedger(
              perTurnWrites,
              directIntent.source_family,
              directIntent.operation_token
            );
        await rebindDirectConflict(source, capturedWrites);
        return {
          handled: true,
          outcome: 'conflict',
          question: directQuestion(directIntent),
          questionId: directIntent.question_id,
        };
      }
    }
    const writes = Array.isArray(sourceWrites)
      ? sourceWrites
      : sourceWriteLedger(perTurnWrites, directIntent.source_family, directIntent.operation_token);
    const terminal = await terminaliseDirect(
      'resolved_yes',
      { outcome: 'copied', replacement: false },
      source,
      writes
    );
    return materializeDirectTerminal(terminal, perTurnWrites, sourceAudible);
  }

  async function currentDirectQuestion() {
    if (directIntent?.status !== 'pending' && useDurableStore) {
      directIntent = normaliseDirectRow(await db.loadDirect(userId, jobId));
    }
    if (directIntent?.status !== 'pending' || directIntent.clarification_kind === 'direct') {
      return null;
    }
    return {
      handled: true,
      outcome: directIntent.clarification_kind === 'conflict' ? 'conflict' : 'source_incomplete',
      question: directQuestion(directIntent),
      questionId: directIntent.question_id,
    };
  }

  async function recoverDirectDelivery(perTurnWrites) {
    let intent = recoverableDirectIntents.find(
      (row) => row.status !== 'pending' && !row.delivered_at
    );
    if (!intent) {
      intent = recoverableDirectIntents.find(
        (row) => row.status === 'pending' && row.clarification_kind === 'direct'
      );
    }
    if (!intent) return { handled: false };
    if (intent.status === 'pending') {
      intent = await terminaliseDirect(
        'resolved_yes',
        { outcome: 'copied', replacement: false },
        intent.source_snapshot,
        intent.source_writes,
        intent
      );
    }
    return materializeDirectTerminal(intent, perTurnWrites);
  }

  async function recoverUndelivered(perTurnWrites) {
    const convenience = await recoverConvenienceDelivery(perTurnWrites);
    if (convenience.handled) return convenience;
    return recoverDirectDelivery(perTurnWrites);
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
    finalizeDirectAfterWrites,
    currentDirectQuestion,
    recoverUndelivered,
    markDelivered,
    currentPending,
    currentIntent,
    shouldHoldReplyTranscript,
    noteReplyHoldReleased,
  };
}
