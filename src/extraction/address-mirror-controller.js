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
  claimAddressMirrorDirectIntentDelivery,
  claimAddressMirrorDirectIntent,
  claimAddressMirrorIntentDelivery,
  conflictAddressMirrorIntent,
  conflictAddressMirrorDirectIntent,
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

/**
 * Family completeness (feedback id 126, 2026-08-23): a meaningful street
 * address plus AT LEAST ONE corroborating component (postcode, town, or
 * county). Inspectors frequently dictate street + town/county and never a
 * postcode; requiring the postcode specifically deleted the mirror ask in
 * practice. Address alone stays incomplete — a lone street line is often a
 * garbled fragment (evidence session 17821FFA produced "13710" as an address
 * candidate). ONE shared predicate on purpose: the convenience-ask gate, the
 * answer-time revalidation, and the direct-command path must all agree, or a
 * relaxed ask would be followed by a strict refusal to copy.
 */
function complete(source) {
  return (
    meaningful(source?.address) &&
    (meaningful(source?.postcode) || meaningful(source?.town) || meaningful(source?.county))
  );
}

const SNAPSHOT_KEY_ORDER = Object.freeze(['address', 'postcode', 'town', 'county']);

/**
 * Hybrid-address guard (id 126 round-2 finding). With a relaxed source (e.g.
 * address+county, no postcode) a partially-populated TARGET can hold
 * components the source lacks; the copy loops only compare POPULATED source
 * keys, so a copy would silently merge the source onto the target's unrelated
 * component — a fabricated hybrid address on a certificate. Any populated
 * target component absent from the source blocks the copy fail-closed.
 * Returned in stable SNAPSHOT_KEY_ORDER so persisted payloads and spoken
 * wording are deterministic across restart and replay.
 */
function missingSourceKeys(source, target) {
  return SNAPSHOT_KEY_ORDER.filter(
    (key) => meaningful(target?.[key]) && !meaningful(source?.[key])
  );
}

function blockedTerminalOutcome(sourceFamily, targetFam, missingKeys) {
  return {
    outcome: 'blocked',
    reason: 'source_missing_target_components',
    missing_source_keys: [...missingKeys],
    source_family: sourceFamily,
    target_family: targetFam,
  };
}

/**
 * Spoken explanation for a hybrid-blocked terminal, generated SOLELY from the
 * persisted terminal payload (never a live snapshot — the wording must be
 * byte-stable across emission, restart, and recovery replay). Names every
 * missing SOURCE component; never offers "the full <target> address", which
 * only adds target fields and cannot recover. The convenience variant states
 * that recovery is a fresh DIRECT command because the one-shot ask is consumed.
 */
function hybridBlockerSpeech(payload, { convenience = false } = {}) {
  const sourceLabel = payload?.source_family === 'client' ? 'client' : 'site';
  const targetLabel = payload?.target_family === 'site' ? 'site' : 'client';
  const keys = Array.isArray(payload?.missing_source_keys)
    ? payload.missing_source_keys.filter((key) => SNAPSHOT_KEY_ORDER.includes(key))
    : [];
  if (keys.length === 0) return null;
  const list = keys.join(' and ');
  if (convenience) {
    return `The ${targetLabel} address already has a ${list}, so I haven't copied the ${sourceLabel} address. Dictate the ${sourceLabel} ${list}, then say "use the same address for the ${targetLabel}".`;
  }
  return `The ${targetLabel} address already has a ${list} — dictate the ${sourceLabel} ${list} and ask me again.`;
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

/**
 * The hybrid-blocked terminal OWNS the turn's spoken response. Unlike the
 * first-wins stageAcknowledgement (correct for ordinary terminals, where an
 * audible source read-back already covers the turn), the blocked terminal is
 * mandatory: its delivery token will be attached and ACKed on playback, so if
 * model prose (e.g. an answer_user call in the deciding-write turn) were
 * allowed to keep the slot, the token would be marked delivered while the
 * required persisted blocker was never spoken — permanently, since delivery
 * is exactly-once. Replacing is safe: the blocker turn performs no copy, so
 * the only competing prose is model chatter about the very command that was
 * just refused.
 */
function stageBlockedTerminal(perTurnWrites, text) {
  if (!perTurnWrites?.answer || typeof text !== 'string' || !text) {
    return stageAcknowledgement(perTurnWrites, text);
  }
  perTurnWrites.answer.featureTouched = true;
  perTurnWrites.answer.stagedText = text;
  perTurnWrites.answer.stagedMeta = { truncated: false, chars: text.length };
  perTurnWrites.answer.outcomes.push({ tool: 'address_mirror', code: 'blocked' });
}

function buildCandidate({ session, perTurnWrites, askId, question, sourceFamily }) {
  const family = sourceFamily ?? sourceFamilyFromWrites(perTurnWrites);
  if (!family) return { ok: false, reason: 'source_family_ambiguous' };
  const source = stableSnapshot(session.stateSnapshot, family);
  if (!complete(source)) return { ok: false, reason: 'source_incomplete' };
  const target = stableSnapshot(session.stateSnapshot, targetFamily(family));
  if (complete(target)) return { ok: false, reason: 'target_already_complete' };
  // Hybrid guard, candidate-build time: a populated target component the
  // source lacks means a "yes" would fabricate a merged address. Refuse the
  // ask WITHOUT burning the one-shot; the dispatcher surfaces this closed
  // reason as the tool-result disposition (terminal for the current snapshot).
  if (missingSourceKeys(source, target).length > 0) {
    return { ok: false, reason: 'source_missing_target_components' };
  }
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
    delivery_claim_token: row.delivery_claim_token ?? row.deliveryClaimToken ?? null,
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
    delivery_claim_token: row.delivery_claim_token ?? row.deliveryClaimToken ?? null,
  };
}

function normaliseTransition(value) {
  if (!value) return { won: false, row: null };
  if (Object.hasOwn(value, 'won') && Object.hasOwn(value, 'row')) {
    return { won: value.won === true, row: value.row };
  }
  // Store doubles written before the CAS contract returned a bare row. Treat
  // them as winners so focused tests/dev adapters remain source-compatible.
  return { won: true, row: value };
}

function stageDelivery(perTurnWrites, kind, token, claimToken = null) {
  if (!perTurnWrites || typeof token !== 'string' || !token) return;
  Object.defineProperty(perTurnWrites, ADDRESS_MIRROR_DELIVERY, {
    value: { kind, token, claimToken },
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
    claimDelivery: store.claimDelivery ?? claimAddressMirrorIntentDelivery,
    conflict: store.conflict ?? conflictAddressMirrorIntent,
    markDelivered: store.markDelivered ?? markAddressMirrorIntentDelivered,
    claimDirect: store.claimDirect ?? claimAddressMirrorDirectIntent,
    loadDirect: store.loadDirect ?? getPendingAddressMirrorDirectIntent,
    loadRecoverableDirect:
      store.loadRecoverableDirect ??
      (store.loadDirect ? null : getRecoverableAddressMirrorDirectIntents),
    rebindDirect: store.rebindDirect ?? rebindAddressMirrorDirectIntent,
    resolveDirect: store.resolveDirect ?? resolveAddressMirrorDirectIntent,
    claimDirectDelivery: store.claimDirectDelivery ?? claimAddressMirrorDirectIntentDelivery,
    conflictDirect: store.conflictDirect ?? conflictAddressMirrorDirectIntent,
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
  const customConvenienceStoreWithoutLease = Boolean(store.resolve && !store.claimDelivery);
  const customDirectStoreWithoutLease = Boolean(store.resolveDirect && !store.claimDirectDelivery);

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
    const hasMirrorPurpose = question?.purpose === ADDRESS_MIRROR_PURPOSE;
    const hasMirrorType = question?.type === ADDRESS_MIRROR_PURPOSE;
    if (!hasMirrorPurpose && !hasMirrorType) return true;
    if (!hasMirrorPurpose || !hasMirrorType) return false;
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
    const askId = question.id ?? `legacy-address-mirror-${randomUUID()}`;
    const out = await claim(
      {
        askId,
        question: question.question,
      },
      capturedWrites,
      sourceFamily
    );
    // Stamp the claimed generation onto the exact object QuestionGate will
    // emit. Legacy/build-428 already decodes tool_call_id even when it drops
    // the newer purpose field; the terminal cancel can therefore dismiss the
    // real alert before its audible result instead of targeting an internal id
    // the client never saw.
    if (out.ok) {
      question.tool_call_id = out.intent?.ask_id ?? askId;
      question.expected_answer_shape = 'yes_no';
    }
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
      return { won: true, row: localIntent };
    }
    const transition = normaliseTransition(
      await db.resolve(userId, jobId, status, intent.resolution_token, terminalOutcome)
    );
    durableIntent = normaliseRow(transition.row);
    return { won: transition.won, row: durableIntent };
  }

  async function acquireConvenienceDelivery(intent) {
    if (!intent || intent.delivered_at) return null;
    const claimToken = randomUUID();
    if (!useDurableStore || customConvenienceStoreWithoutLease) {
      localIntent = { ...intent, delivery_claim_token: claimToken };
      durableIntent = localIntent;
      return localIntent;
    }
    const row = await db.claimDelivery(userId, jobId, intent.resolution_token, claimToken);
    durableIntent = normaliseRow(row) ?? durableIntent;
    return row ? durableIntent : null;
  }

  async function acquireDirectDelivery(intent) {
    if (!intent || intent.delivered_at) return null;
    const claimToken = randomUUID();
    if (!useDurableStore || customDirectStoreWithoutLease) {
      const claimed = { ...intent, delivery_claim_token: claimToken };
      directIntent = claimed;
      recoverableDirectIntents = recoverableDirectIntents.map((row) =>
        row.operation_token === claimed.operation_token ? claimed : row
      );
      return claimed;
    }
    const row = await db.claimDirectDelivery(userId, jobId, intent.operation_token, claimToken);
    const claimed = normaliseDirectRow(row);
    if (claimed) {
      directIntent = claimed;
      recoverableDirectIntents = recoverableDirectIntents.map((item) =>
        item.operation_token === claimed.operation_token ? claimed : item
      );
    }
    return claimed;
  }

  async function persistConvenienceDeliveryConflict(
    intent,
    reason,
    terminalPayload = null,
    fenceToLease = false
  ) {
    // terminalPayload lets the hybrid-blocked terminal persist its FULL
    // restart-stable payload (ordered missing_source_keys + families) on the
    // crash-recovery path too — without it, a resolved_yes crash followed by
    // a target-only component would persist a bare {outcome:'conflict'} and
    // every later recovery would speak the generic drift wording instead of
    // the blocker.
    const terminalOutcome = terminalPayload ?? { outcome: 'conflict', reason };
    if (!useDurableStore || customConvenienceStoreWithoutLease) {
      const conflicted = { ...intent, status: 'conflict', terminal_outcome: terminalOutcome };
      localIntent = conflicted;
      durableIntent = conflicted;
      return conflicted;
    }
    const row = normaliseRow(
      await db.conflict(
        userId,
        jobId,
        intent.resolution_token,
        terminalOutcome,
        fenceToLease ? (intent.delivery_claim_token ?? null) : null
      )
    );
    if (row) durableIntent = row;
    // Fenced (blocked-terminal) callers treat a missed UPDATE as a lost
    // delivery lease — stage nothing, the new owner speaks.
    if (fenceToLease && !row) return null;
    return row ?? intent;
  }

  async function resolveIntentAnswer({
    text,
    perTurnWrites,
    askId = null,
    claimedRecoveryIntent = null,
  }) {
    const answer = parseAddressMirrorAnswer(text);
    if (!answer) {
      allowClarificationReask = true;
      return { handled: false, reason: 'unclear' };
    }
    let intent = claimedRecoveryIntent ?? (await currentIntent());
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
        clearAskId: intent.ask_id ?? null,
      };
    }
    if (intent.status !== 'pending' && !claimedRecoveryIntent) {
      return {
        handled: true,
        outcome: 'duplicate',
        changed: [],
        replayedSource: 0,
        resolutionToken: intent.resolution_token,
        clearAskId: intent.ask_id ?? null,
      };
    }
    const terminalAnswer =
      intent.status === 'resolved_yes' ? 'yes' : intent.status === 'resolved_no' ? 'no' : null;
    const stageSourceReplay = (sourceReplay) => {
      const replayWithProvenance = sourceReplay.map((write) => ({
        ...write,
        ledgerEntry: intent.source_writes.find((item) => item?.field === write.field) ?? null,
      }));
      if (replayWithProvenance.some((write) => write.ledgerEntry != null)) {
        Object.defineProperty(perTurnWrites, CONFIRMATION_REPLAY_TOKEN, {
          value: intent.resolution_token,
          enumerable: false,
          configurable: true,
        });
      }
      for (const [ordinal, write] of replayWithProvenance.entries()) {
        const { ledgerEntry } = write;
        stageBoardWrite(session, perTurnWrites, write.field, write.value, {
          confidence: ledgerEntry?.confidence ?? 1,
          source_turn_id:
            ledgerEntry?.source_turn_id ??
            ledgerEntry?.operation_token ??
            `::address_mirror_source::${intent.resolution_token}`,
          derived: ledgerEntry == null,
          replayed: ledgerEntry != null,
          ordinal,
        });
      }
      return replayWithProvenance.length;
    };
    const conflict = async (reason, sourceReplay = [], blockedPayload = null) => {
      if (intent.status === 'pending') {
        const transition = await terminalise(
          intent,
          'conflict',
          blockedPayload ?? { outcome: 'conflict', reason }
        );
        if (!transition.won) {
          return {
            handled: true,
            outcome: 'duplicate',
            changed: [],
            replayedSource: 0,
            resolutionToken: intent.resolution_token,
            clearAskId: intent.ask_id ?? transition.row?.ask_id ?? null,
          };
        }
        intent = await acquireConvenienceDelivery(transition.row);
        if (!intent) {
          return {
            handled: true,
            outcome: 'duplicate',
            changed: [],
            replayedSource: 0,
            resolutionToken: transition.row?.resolution_token,
            clearAskId: transition.row?.ask_id ?? intent?.ask_id ?? null,
          };
        }
      } else if (claimedRecoveryIntent && intent.status !== 'conflict') {
        // Every post-claim conflict persistence is fenced to the caller's
        // delivery lease (mini-review widening: not only the hybrid-blocked
        // shape — an answer_changed/source_drift recovery under an expired
        // lease must not overwrite the new owner's terminal or double-speak).
        const persisted = await persistConvenienceDeliveryConflict(
          intent,
          reason,
          blockedPayload,
          true
        );
        if (!persisted) {
          return {
            handled: true,
            outcome: 'duplicate',
            changed: [],
            replayedSource: 0,
            resolutionToken: intent.resolution_token,
            clearAskId: intent.ask_id ?? null,
          };
        }
        intent = persisted;
      }
      // Prefer the payload persisted at the winning CAS (restart-stable);
      // fall back to the freshly-built one for store doubles that echo the
      // status without round-tripping terminal_outcome.
      const persistedBlocked =
        (intent?.terminal_outcome?.reason === 'source_missing_target_components'
          ? intent.terminal_outcome
          : null) ?? blockedPayload;
      const blockedSpeech = persistedBlocked
        ? hybridBlockerSpeech(persistedBlocked, { convenience: true })
        : null;
      const question =
        reason === 'answer_changed'
          ? "That answer conflicts with the one already recorded, so I haven't changed the addresses."
          : (blockedSpeech ??
            "The address changed after I asked, so I haven't copied it. Please tell me which address to use.");
      if (blockedSpeech) {
        stageBlockedTerminal(perTurnWrites, question);
      } else {
        stageAcknowledgement(perTurnWrites, question);
      }
      stageDelivery(
        perTurnWrites,
        'convenience',
        intent.resolution_token,
        intent.delivery_claim_token
      );
      const replayedSource = stageSourceReplay(sourceReplay);
      return {
        handled: true,
        outcome: blockedSpeech ? 'blocked' : 'conflict',
        changed: [],
        replayedSource,
        clearAskId: intent.ask_id ?? null,
        resolutionToken: intent.resolution_token,
        delivery: { kind: 'convenience', token: intent.resolution_token },
      };
    };
    if (terminalAnswer && terminalAnswer !== answer) {
      return conflict('answer_changed');
    }
    // Hybrid-blocked replay short-circuits BEFORE any live-snapshot drift
    // checks: the spoken terminal must be materialised solely from the
    // persisted payload, and a post-block source dictation (the organic
    // recovery) must not reroute the replay into a generic drift conflict
    // that would overwrite the blocked terminal_outcome.
    if (
      intent.status === 'conflict' &&
      intent.terminal_outcome?.reason === 'source_missing_target_components'
    ) {
      return conflict('source_missing_target_components', [], intent.terminal_outcome);
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

    if (intent.status === 'conflict') {
      const reason = intent.terminal_outcome?.reason ?? 'source_drift';
      return conflict(reason, reason === 'target_drift' ? replay : []);
    }

    if (answer === 'yes') {
      const currentTarget = stableSnapshot(session.stateSnapshot, targetFamily(sourceFamily));
      // Hybrid guard, answer time (late race): a target-only component that
      // appeared after the ask was claimed would survive the populated-keys
      // copy loop below and fabricate a merged address. Fail closed and
      // consume the one-shot; recovery is a fresh DIRECT command after the
      // named source component is dictated. Checked BEFORE target_drift —
      // the generic conflict's recovery replays "yes", which would authorise
      // the hybrid.
      const blockers = missingSourceKeys(source, currentTarget);
      if (blockers.length > 0) {
        return conflict(
          'source_missing_target_components',
          [],
          blockedTerminalOutcome(sourceFamily, targetFamily(sourceFamily), blockers)
        );
      }
      for (const key of Object.keys(targetFields)) {
        const captured = source[key];
        if (!meaningful(captured) || !meaningful(currentTarget[key])) continue;
        if (String(currentTarget[key]) !== String(captured)) {
          return conflict('target_drift', replay);
        }
      }
    }

    if (intent.status === 'pending') {
      const transition = await terminalise(
        intent,
        answer === 'yes' ? 'resolved_yes' : 'resolved_no',
        { outcome: answer }
      );
      const expectedStatus = answer === 'yes' ? 'resolved_yes' : 'resolved_no';
      if (!transition.won || transition.row?.status !== expectedStatus) {
        return {
          handled: true,
          outcome: 'duplicate',
          changed: [],
          replayedSource: 0,
          resolutionToken: intent.resolution_token,
          clearAskId: intent.ask_id ?? transition.row?.ask_id ?? null,
        };
      }
      intent = await acquireConvenienceDelivery(transition.row);
      if (!intent) {
        return {
          handled: true,
          outcome: 'duplicate',
          changed: [],
          replayedSource: 0,
          resolutionToken: transition.row?.resolution_token,
          clearAskId: transition.row?.ask_id ?? intent?.ask_id ?? null,
        };
      }
    }

    stageDelivery(
      perTurnWrites,
      'convenience',
      intent.resolution_token,
      intent.delivery_claim_token
    );
    stageSourceReplay(replay);

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
    const suppliedAskId = typeof askId === 'string' && askId.length > 0;
    // Purpose/type is a compatibility anchor only when the client has no id.
    // Once an explicit id is present it must match the durable generation;
    // otherwise stale UI can resolve a newer opposite answer.
    if (suppliedAskId && askId !== intent.ask_id) {
      return { handled: false, reason: 'stale_address_mirror_ask_id' };
    }
    const hasExactPurpose = context?.purpose === ADDRESS_MIRROR_PURPOSE;
    const hasLegacyType = context?.type === ADDRESS_MIRROR_QUESTION_TYPE;
    const hasAskId = suppliedAskId && askId === intent.ask_id;
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
    const claimed = await acquireConvenienceDelivery(intent);
    if (!claimed) return { handled: false, reason: 'delivery_claimed' };
    const out =
      answer === 'conflict' || answer === 'blocked'
        ? await resolveIntentAnswer({
            text: 'yes',
            perTurnWrites,
            claimedRecoveryIntent: claimed,
          })
        : await resolveIntentAnswer({
            text: answer,
            perTurnWrites,
            claimedRecoveryIntent: claimed,
          });
    if (out?.handled) terminalRecoveryArmed = false;
    return out;
  }

  async function markDelivered(delivery) {
    if (!delivery || typeof delivery.token !== 'string') return false;
    if (
      !useDurableStore ||
      (delivery.kind === 'convenience' && customConvenienceStoreWithoutLease) ||
      (delivery.kind === 'direct' && customDirectStoreWithoutLease)
    ) {
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
      const row = await db.markDelivered(
        userId,
        jobId,
        delivery.token,
        delivery.claimToken ?? null
      );
      if (row) durableIntent = normaliseRow(row);
      return Boolean(row);
    }
    if (delivery.kind === 'direct') {
      const row = await db.markDirectDelivered(
        userId,
        jobId,
        delivery.token,
        delivery.claimToken ?? null
      );
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
      stageAcknowledgement(
        perTurnWrites,
        'That conflicts with the address question I just asked. Please answer that question first.'
      );
      return { handled: true, outcome: 'conflict', changed: [] };
    }
    return resolveIntentAnswer({ text: 'yes', perTurnWrites });
  }

  /**
   * PURE function of the intent's PERSISTED source_snapshot — never the live
   * session snapshot. The same helper renders the initial emission, durable
   * replay/re-ask, and the legacy answer-equality check, so the text must be
   * byte-deterministic across emission, restart, and answer resolution; a
   * live-snapshot derivation would drift between ask and answer and reject
   * every legacy/replay answer as stale_direct_question. It asks for what is
   * actually MISSING: a static "What is the address?" would solicit the
   * component the inspector already gave and loop forever on the
   * address-alone shape.
   */
  // id 126 — the answer shape is a property of the persisted clarification
  // kind, stated by the controller so every emitter (initial send, durable
  // replay, already_pending re-send, frame ledger, evidence key) agrees.
  function directAnswerShape(intent) {
    return intent?.clarification_kind === 'conflict' ? 'yes_no' : 'free_text';
  }

  function directQuestion(intent) {
    if (!intent) return null;
    if (intent.clarification_kind === 'conflict') {
      return `The ${intent.target_family} address is already different. Should I replace it?`;
    }
    if (intent.clarification_kind !== 'incomplete') return null;
    const source = intent.source_snapshot ?? {};
    if (!meaningful(source.address)) {
      return `What is the ${intent.source_family} address, including a town, county, or postcode?`;
    }
    return `What is the ${intent.source_family} postcode, town, or county?`;
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
      return { won: true, row: directIntent };
    }
    const transition = normaliseTransition(
      await db.resolveDirect(
        userId,
        jobId,
        intent.operation_token,
        status,
        terminalOutcome,
        sourceSnapshot,
        sourceWrites
      )
    );
    directIntent = normaliseDirectRow(transition.row);
    if (directIntent) {
      recoverableDirectIntents = recoverableDirectIntents.map((item) =>
        item.operation_token === directIntent.operation_token ? directIntent : item
      );
    }
    return { won: transition.won, row: directIntent };
  }

  /**
   * Refresh an INCOMPLETE clarification's persisted source snapshot after a
   * partial-progress write (id 126 — e.g. the street address arrives on a
   * no-address ask but no corroborator yet). The kind and question_id are
   * PRESERVED — this is the same ask generation; only its derived wording
   * progresses, so a later replay (reconnect, duplicate command) asks for
   * what is NOW missing instead of re-soliciting the component the inspector
   * already gave.
   */
  async function rebindDirectIncomplete(sourceSnapshot, sourceWrites) {
    if (!directIntent) return null;
    if (!useDurableStore) {
      directIntent = {
        ...directIntent,
        source_snapshot: sourceSnapshot ?? directIntent.source_snapshot,
        source_writes: sourceWrites ?? directIntent.source_writes,
      };
      recoverableDirectIntents = recoverableDirectIntents.map((row) =>
        row.operation_token === directIntent.operation_token ? directIntent : row
      );
      return directIntent;
    }
    const rebound = normaliseDirectRow(
      await db.rebindDirect(
        userId,
        jobId,
        directIntent.operation_token,
        'incomplete',
        directIntent.question_id,
        sourceSnapshot,
        sourceWrites
      )
    );
    // A null row means the pending intent was concurrently resolved or
    // replaced (lost CAS) — keep the prior in-memory intent rather than
    // nulling it out from under callers, and report the loss so they can
    // decline to re-ask instead of dereferencing a missing generation.
    if (!rebound) return null;
    directIntent = rebound;
    recoverableDirectIntents = recoverableDirectIntents.map((row) =>
      row.operation_token === rebound.operation_token ? rebound : row
    );
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

  async function persistDirectDeliveryConflict(
    intent,
    reason,
    terminalPayload = null,
    fenceToLease = false
  ) {
    const terminalOutcome = terminalPayload ?? { outcome: 'conflict', reason };
    if (!useDurableStore) {
      const conflicted = { ...intent, status: 'conflict', terminal_outcome: terminalOutcome };
      directIntent = conflicted;
      recoverableDirectIntents = recoverableDirectIntents.map((row) =>
        row.operation_token === conflicted.operation_token ? conflicted : row
      );
      return conflicted;
    }
    const row = normaliseDirectRow(
      await db.conflictDirect(
        userId,
        jobId,
        intent.operation_token,
        terminalOutcome,
        fenceToLease ? (intent.delivery_claim_token ?? null) : null
      )
    );
    if (row) {
      directIntent = row;
      recoverableDirectIntents = recoverableDirectIntents.map((item) =>
        item.operation_token === row.operation_token ? row : item
      );
    }
    // Fenced callers (the hybrid-blocked terminal) treat a missed UPDATE as a
    // LOST delivery lease — another emitter owns the row now, so this one
    // must stage neither writes nor speech. Legacy callers keep the old
    // best-effort fallback.
    if (fenceToLease && !row) return null;
    return row ?? intent;
  }

  async function materializeDirectTerminal(intent, perTurnWrites, sourceAudible = false) {
    if (!intent || intent.delivered_at) {
      const duplicateClearAskId =
        intent?.clarification_kind === 'direct' ? null : (intent?.question_id ?? null);
      return {
        handled: true,
        outcome: 'duplicate',
        changed: [],
        ...(duplicateClearAskId ? { clearAskId: duplicateClearAskId } : {}),
      };
    }
    const terminalOutcome = intent.terminal_outcome?.outcome;
    const replayPersistedTargetConflict =
      terminalOutcome === 'conflict' && intent.terminal_outcome?.reason === 'target_drift';
    const clearAskId = intent.clarification_kind === 'direct' ? null : (intent.question_id ?? null);
    const stageOwnedDelivery = () =>
      stageDelivery(perTurnWrites, 'direct', intent.operation_token, intent.delivery_claim_token);
    // Hybrid-blocked terminal: speech comes SOLELY from the persisted payload
    // (restart-stable), the copy never runs, and the ask — when one existed —
    // is still cleared via clearAskId. Checked before the generic conflict
    // branch because blocked terminals persist under status 'conflict' (the
    // status CHECK constraint's closed set).
    const persistedBlocked =
      intent.terminal_outcome?.reason === 'source_missing_target_components'
        ? intent.terminal_outcome
        : null;
    if (persistedBlocked) {
      stageOwnedDelivery();
      stageBlockedTerminal(
        perTurnWrites,
        hybridBlockerSpeech(persistedBlocked) ??
          "The address changed before I could finish, so I haven't copied it."
      );
      return {
        handled: true,
        outcome: 'blocked',
        changed: [],
        replayedSource: 0,
        resolutionToken: intent.operation_token,
        clearAskId,
        delivery: { kind: 'direct', token: intent.operation_token },
      };
    }
    if (terminalOutcome === 'no') {
      stageOwnedDelivery();
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
        clearAskId,
        delivery: { kind: 'direct', token: intent.operation_token },
      };
    }
    if (
      (terminalOutcome === 'conflict' || intent.status === 'conflict') &&
      !replayPersistedTargetConflict
    ) {
      stageOwnedDelivery();
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
        clearAskId,
        delivery: { kind: 'direct', token: intent.operation_token },
      };
    }
    const source = intent.source_snapshot;
    if (!complete(source)) return { handled: false, reason: 'source_incomplete' };
    const sourceFields = FAMILIES[intent.source_family];
    const currentSource = stableSnapshot(session.stateSnapshot, intent.source_family);
    const sourceReplay = [];
    for (const [ordinal, key] of Object.keys(sourceFields).entries()) {
      const value = source[key];
      if (!meaningful(value)) continue;
      if (meaningful(currentSource[key]) && String(currentSource[key]) !== String(value)) {
        const persisted = await persistDirectDeliveryConflict(intent, 'source_drift', null, true);
        if (!persisted) {
          return {
            handled: true,
            outcome: 'duplicate',
            changed: [],
            ...(clearAskId ? { clearAskId } : {}),
          };
        }
        intent = persisted;
        stageOwnedDelivery();
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
          clearAskId,
          delivery: { kind: 'direct', token: intent.operation_token },
        };
      }
      if (!meaningful(currentSource[key])) {
        const field = sourceFields[key];
        const ledgerEntry = intent.source_writes.find((item) => item?.field === field);
        sourceReplay.push({ ordinal, field, value, ledgerEntry });
      }
    }
    const replayedSource = sourceReplay.length;
    // Collection above is PURE; staging is deferred until this materialiser
    // has confirmed it still owns the delivery lease (mini-review finding:
    // a fenced persist that loses the lease must leave the per-turn ledger
    // AND the session snapshot untouched — a loser that had already staged
    // replays would still get them bundled onto the wire).
    const stageCollectedReplays = () => {
      const replayedAudibleSource = sourceReplay.filter((write) => write.ledgerEntry).length;
      if (replayedAudibleSource > 0) {
        Object.defineProperty(perTurnWrites, CONFIRMATION_REPLAY_TOKEN, {
          value: intent.operation_token,
          enumerable: false,
          configurable: true,
        });
      }
      for (const write of sourceReplay) {
        const { ledgerEntry } = write;
        stageBoardWrite(session, perTurnWrites, write.field, write.value, {
          confidence: ledgerEntry?.confidence ?? 1,
          source_turn_id:
            ledgerEntry?.source_turn_id ??
            ledgerEntry?.operation_token ??
            `::address_mirror_direct_source::${intent.operation_token}`,
          derived: ledgerEntry == null,
          replayed: ledgerEntry != null,
          ordinal: write.ordinal,
        });
      }
    };
    if (replayPersistedTargetConflict) {
      // Terminal already persisted; delivery already leased by the caller —
      // ownership is settled, so the owed source restoration stages now.
      stageCollectedReplays();
      stageOwnedDelivery();
      stageAcknowledgement(
        perTurnWrites,
        "The address changed before I could finish, so I haven't copied it."
      );
      return {
        handled: true,
        outcome: 'conflict',
        changed: [],
        replayedSource,
        resolutionToken: intent.operation_token,
        clearAskId,
        delivery: { kind: 'direct', token: intent.operation_token },
      };
    }
    const target = stableSnapshot(session.stateSnapshot, intent.target_family);
    // Hybrid guard, materialisation time (late race): a target-only component
    // can appear after a direct terminal is authorised but before recovery
    // materialises it — the authorised target_snapshot would then bless the
    // component and the copy below would merge around it. Fail closed BEFORE
    // the authorised-drift loop; recovery is a fresh direct command once the
    // named source component is dictated.
    const lateBlockers = missingSourceKeys(source, target);
    if (lateBlockers.length > 0) {
      const payload = blockedTerminalOutcome(
        intent.source_family,
        intent.target_family,
        lateBlockers
      );
      const persisted = await persistDirectDeliveryConflict(
        intent,
        'source_missing_target_components',
        payload,
        true
      );
      if (!persisted) {
        // Lost the delivery lease mid-materialisation (10s expiry, another
        // emitter reclaimed the row). Nothing was staged — the new owner
        // speaks.
        return {
          handled: true,
          outcome: 'duplicate',
          changed: [],
          ...(clearAskId ? { clearAskId } : {}),
        };
      }
      intent = persisted;
      const spokenPayload =
        intent.terminal_outcome?.reason === 'source_missing_target_components'
          ? intent.terminal_outcome
          : payload;
      stageOwnedDelivery();
      stageBlockedTerminal(
        perTurnWrites,
        hybridBlockerSpeech(spokenPayload) ??
          "The address changed before I could finish, so I haven't copied it."
      );
      // Deliberately NO source replay on a blocked terminal: exactly one
      // spoken blocker, zero writes — the named missing component is the
      // recovery instruction, and owed source restoration recurs on the
      // fresh command that follows it.
      return {
        handled: true,
        outcome: 'blocked',
        changed: [],
        replayedSource: 0,
        resolutionToken: intent.operation_token,
        clearAskId,
        delivery: { kind: 'direct', token: intent.operation_token },
      };
    }
    const authorisedTarget = parseJsonObject(intent.terminal_outcome?.target_snapshot) ?? {};
    for (const key of Object.keys(FAMILIES[intent.target_family])) {
      const current = target[key];
      const sourceValue = source[key];
      if (!meaningful(current) || String(current) === String(sourceValue ?? '')) continue;
      const authorised = authorisedTarget[key];
      if (meaningful(authorised) && String(current) === String(authorised)) continue;
      const persisted = await persistDirectDeliveryConflict(intent, 'target_drift', null, true);
      if (!persisted) {
        return {
          handled: true,
          outcome: 'duplicate',
          changed: [],
          ...(clearAskId ? { clearAskId } : {}),
        };
      }
      intent = persisted;
      stageCollectedReplays();
      stageOwnedDelivery();
      stageAcknowledgement(
        perTurnWrites,
        "The address changed before I could finish, so I haven't copied it."
      );
      return {
        handled: true,
        outcome: 'conflict',
        changed: [],
        replayedSource,
        resolutionToken: intent.operation_token,
        clearAskId,
        delivery: { kind: 'direct', token: intent.operation_token },
      };
    }
    stageCollectedReplays();
    stageOwnedDelivery();
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
    const sourceCovered =
      sourceAudible || hasAudibleSourceWrite(perTurnWrites, intent.source_family);
    if (!sourceCovered) {
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
      clearAskId,
      delivery: { kind: 'direct', token: intent.operation_token },
    };
  }

  async function materializeWonDirectTransition(transition, perTurnWrites, sourceAudible = false) {
    if (!transition?.won || !transition.row) {
      const duplicateClearAskId =
        transition?.row?.clarification_kind === 'direct'
          ? null
          : (transition?.row?.question_id ?? null);
      return {
        handled: true,
        outcome: 'duplicate',
        changed: [],
        ...(duplicateClearAskId ? { clearAskId: duplicateClearAskId } : {}),
      };
    }
    const claimed = await acquireDirectDelivery(transition.row);
    if (!claimed) {
      const duplicateClearAskId =
        transition.row.clarification_kind === 'direct'
          ? null
          : (transition.row.question_id ?? null);
      return {
        handled: true,
        outcome: 'duplicate',
        changed: [],
        ...(duplicateClearAskId ? { clearAskId: duplicateClearAskId } : {}),
      };
    }
    return materializeDirectTerminal(claimed, perTurnWrites, sourceAudible);
  }

  async function applyDirectCommand(text, perTurnWrites, operationToken = randomUUID()) {
    const command = parseDirectAddressMirrorCommand(text);
    if (!command) return { handled: false };
    const source = stableSnapshot(session.stateSnapshot, command.sourceFamily);
    const target = stableSnapshot(session.stateSnapshot, command.targetFamily);
    // Hybrid guard dominates the conflict clarification: a conflict-question
    // "yes" authorises the current target snapshot wholesale, which would
    // preserve the source-absent component and ship the hybrid. Blocked
    // commands terminate with a spoken explanation instead of any question.
    const hybridBlockers = complete(source) ? missingSourceKeys(source, target) : [];
    const hasConflict =
      complete(source) && hybridBlockers.length === 0
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
          const duplicateClearAskId =
            existing.clarification_kind === 'direct' ? null : (existing.question_id ?? null);
          return {
            handled: true,
            outcome: 'duplicate',
            changed: [],
            ...(duplicateClearAskId ? { clearAskId: duplicateClearAskId } : {}),
          };
        }
        if (existing?.status !== 'pending') {
          const duplicateClearAskId =
            existing?.clarification_kind === 'direct' ? null : (existing?.question_id ?? null);
          return {
            handled: true,
            outcome: 'duplicate',
            changed: [],
            ...(duplicateClearAskId ? { clearAskId: duplicateClearAskId } : {}),
          };
        }
        if (existing?.clarification_kind === 'direct') {
          const terminal = await terminaliseDirect(
            'resolved_yes',
            {
              outcome: 'copied',
              replacement: false,
              target_snapshot: stableSnapshot(session.stateSnapshot, existing.target_family),
            },
            existing.source_snapshot,
            existing.source_writes,
            existing
          );
          return materializeWonDirectTransition(terminal, perTurnWrites);
        }
        return {
          handled: true,
          outcome: existing?.clarification_kind === 'conflict' ? 'conflict' : 'source_incomplete',
          question: directQuestion(existing),
          questionId: existing?.question_id,
          expectedAnswerShape: directAnswerShape(existing),
        };
      }
      // A NEW command colliding with a still-pending clarification (id 126):
      // replay the pending question instead of consuming the utterance
      // silently — the hands-free inspector otherwise hears nothing at all.
      const pendingClarification =
        claimed?.reason === 'clarification_already_pending'
          ? normaliseDirectRow(claimed.intent)
          : null;
      if (
        pendingClarification?.status === 'pending' &&
        pendingClarification.clarification_kind !== 'direct'
      ) {
        return {
          handled: true,
          outcome: 'already_pending',
          changed: [],
          question: directQuestion(pendingClarification),
          questionId: pendingClarification.question_id,
          expectedAnswerShape: directAnswerShape(pendingClarification),
        };
      }
      return { handled: true, outcome: 'already_pending', changed: [] };
    }
    if (!complete(source)) {
      return {
        handled: true,
        outcome: 'source_incomplete',
        // Same helper as durable replay/re-ask — byte-identical text at
        // emission and every later derivation from the persisted snapshot.
        question: directQuestion(directIntent),
        questionId: directIntent.question_id,
        expectedAnswerShape: directAnswerShape(directIntent),
      };
    }
    if (hybridBlockers.length > 0) {
      const terminal = await terminaliseDirect(
        'conflict',
        blockedTerminalOutcome(command.sourceFamily, command.targetFamily, hybridBlockers),
        source,
        []
      );
      return materializeWonDirectTransition(terminal, perTurnWrites);
    }
    if (hasConflict) {
      return {
        handled: true,
        outcome: 'conflict',
        question: directQuestion(directIntent),
        questionId: directIntent.question_id,
        expectedAnswerShape: directAnswerShape(directIntent),
      };
    }
    const terminal = await terminaliseDirect(
      'resolved_yes',
      { outcome: 'copied', replacement: false, target_snapshot: target },
      source,
      []
    );
    return materializeWonDirectTransition(terminal, perTurnWrites);
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
        return materializeWonDirectTransition(terminal, perTurnWrites);
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
      return materializeWonDirectTransition(terminal, perTurnWrites);
    }
    const source = complete(directIntent.source_snapshot)
      ? directIntent.source_snapshot
      : stableSnapshot(session.stateSnapshot, directIntent.source_family);
    const terminal = await terminaliseDirect(
      'resolved_yes',
      {
        outcome: 'copied',
        replacement: true,
        target_snapshot: stableSnapshot(session.stateSnapshot, directIntent.target_family),
      },
      source,
      directIntent.source_writes
    );
    return materializeWonDirectTransition(terminal, perTurnWrites);
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
    // Effective source (cycle-2 finding): the LIVE snapshot wins where it
    // holds a value (mid-session address authority), but a component the
    // process persisted onto the intent before a crash — and which a
    // blank-restart snapshot no longer carries — is PRESERVED, never
    // regressed to null. Same for the dictated-write provenance ledger:
    // prior persisted entries survive unless this turn superseded the field.
    const liveSource = stableSnapshot(session.stateSnapshot, directIntent.source_family);
    const persistedSource = directIntent.source_snapshot ?? {};
    const source = Object.fromEntries(
      SNAPSHOT_KEY_ORDER.map((key) => [
        key,
        meaningful(liveSource[key])
          ? liveSource[key]
          : meaningful(persistedSource[key])
            ? persistedSource[key]
            : null,
      ])
    );
    const currentTurnWrites = Array.isArray(sourceWrites)
      ? sourceWrites
      : sourceWriteLedger(perTurnWrites, directIntent.source_family, directIntent.operation_token);
    const mergedSourceWrites = [
      ...(Array.isArray(directIntent.source_writes) ? directIntent.source_writes : []).filter(
        (prior) => !currentTurnWrites.some((write) => write?.field === prior?.field)
      ),
      ...currentTurnWrites,
    ];
    if (!complete(source)) {
      // Partial progress (id 126): the write advanced the source family but
      // it is still incomplete under the relaxed rule (e.g. the street
      // address arrived on a no-address ask, corroborator still missing).
      // Refresh the intent's persisted snapshot so every later derivation of
      // the clarification asks for what is NOW missing, and re-emit the
      // progressed question this turn — otherwise a replay would re-solicit
      // the component the inspector just gave.
      const progressed = SNAPSHOT_KEY_ORDER.some(
        (key) => meaningful(source[key]) && !meaningful(directIntent.source_snapshot?.[key])
      );
      if (!progressed) return { handled: false };
      const rebound = await rebindDirectIncomplete(source, mergedSourceWrites);
      // Lost CAS: the clarification was concurrently resolved or replaced —
      // don't re-ask against a generation that no longer exists.
      if (!rebound) return { handled: false };
      return {
        handled: true,
        outcome: 'source_incomplete',
        question: directQuestion(rebound),
        questionId: rebound.question_id,
        expectedAnswerShape: directAnswerShape(rebound),
      };
    }
    const target = stableSnapshot(session.stateSnapshot, directIntent.target_family);
    // Hybrid guard on the deciding-write path: the source just became
    // complete, but the target holds a component the source still lacks —
    // terminate fail-closed (spoken blocker, ask cleared via clearAskId,
    // zero copy) rather than asking the generic conflict question whose
    // "yes" would authorise the merged hybrid.
    const hybridBlockers = missingSourceKeys(source, target);
    if (hybridBlockers.length > 0) {
      const terminal = await terminaliseDirect(
        'conflict',
        blockedTerminalOutcome(
          directIntent.source_family,
          directIntent.target_family,
          hybridBlockers
        ),
        source,
        mergedSourceWrites
      );
      return materializeWonDirectTransition(terminal, perTurnWrites, sourceAudible);
    }
    for (const key of Object.keys(FAMILIES[directIntent.target_family])) {
      if (
        meaningful(source[key]) &&
        meaningful(target[key]) &&
        String(source[key]) !== String(target[key])
      ) {
        const reboundConflict = await rebindDirectConflict(source, mergedSourceWrites);
        // Same lost-CAS guard as the incomplete rebind: a null row means the
        // clarification generation no longer exists — never dereference it.
        if (!reboundConflict) return { handled: false };
        return {
          handled: true,
          outcome: 'conflict',
          question: directQuestion(reboundConflict),
          questionId: reboundConflict.question_id,
          expectedAnswerShape: directAnswerShape(reboundConflict),
        };
      }
    }
    const terminal = await terminaliseDirect(
      'resolved_yes',
      { outcome: 'copied', replacement: false, target_snapshot: target },
      source,
      mergedSourceWrites
    );
    return materializeWonDirectTransition(terminal, perTurnWrites, sourceAudible);
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
      expectedAnswerShape: directAnswerShape(directIntent),
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
      const transition = await terminaliseDirect(
        'resolved_yes',
        {
          outcome: 'copied',
          replacement: false,
          target_snapshot: stableSnapshot(session.stateSnapshot, intent.target_family),
        },
        intent.source_snapshot,
        intent.source_writes,
        intent
      );
      if (!transition.won) return { handled: false, reason: 'delivery_claimed' };
      intent = transition.row;
    }
    const claimed = await acquireDirectDelivery(intent);
    if (!claimed) return { handled: false, reason: 'delivery_claimed' };
    return materializeDirectTerminal(claimed, perTurnWrites);
  }

  async function recoverUndelivered(perTurnWrites) {
    const convenience = await recoverConvenienceDelivery(perTurnWrites);
    if (convenience.handled || convenience.reason === 'delivery_claimed') return convenience;
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
