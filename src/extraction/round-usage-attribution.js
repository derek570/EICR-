import { providerForModel } from './model-provider.js';

const OPENAI_TIERS = new Set(['standard', 'default', 'fast', 'priority']);

function normalizeTier(value) {
  const tier = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!tier || tier === 'default') return 'standard';
  return tier;
}

function modelFamily(provider, model) {
  const id = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (provider === 'openai') {
    if (id === 'gpt-5.6' || id.startsWith('gpt-5.6-sol')) return 'sol';
    if (id.startsWith('gpt-5.6-luna')) return 'luna';
    if (id.startsWith('gpt-5.6-terra')) return 'terra';
    return null;
  }
  if (provider === 'anthropic') {
    if (id.startsWith('claude-haiku-')) return 'haiku';
    if (id.startsWith('claude-sonnet-')) return 'sonnet';
    if (id.startsWith('claude-opus-')) return 'opus';
  }
  return null;
}

function classifyReturnedModel(transportProvider, requestedModel, responseModel) {
  if (!responseModel) {
    return {
      billingModel: requestedModel,
      modelProvenance: 'request_implied_model',
      attributionStatus: 'attributed',
      validationError: null,
    };
  }

  let returnedProvider;
  try {
    returnedProvider = providerForModel(responseModel);
  } catch {
    return {
      billingModel: requestedModel,
      modelProvenance: 'request_implied_model',
      attributionStatus: 'unattributed_provider_usage',
      validationError: 'unknown_response_model',
    };
  }
  if (returnedProvider !== transportProvider) {
    return {
      billingModel: requestedModel,
      modelProvenance: 'request_implied_model',
      attributionStatus: 'unattributed_provider_usage',
      validationError: 'cross_provider_response_model',
    };
  }

  // An exact requested==response echo is never a metadata contradiction,
  // whatever the family tables enumerate. Without this short-circuit a model
  // id outside the known families (legacy dated ids, a future family pin)
  // stamps every round `response_model_family_mismatch` on a self-consistent
  // config — saturating usageValidationErrors and failing the evaluation
  // verdict lane that consumes attribution_status.
  const requestedId = typeof requestedModel === 'string' ? requestedModel.trim().toLowerCase() : '';
  const returnedId = typeof responseModel === 'string' ? responseModel.trim().toLowerCase() : '';
  if (requestedId && requestedId === returnedId) {
    return {
      billingModel: responseModel,
      modelProvenance: 'returned',
      attributionStatus: 'attributed',
      validationError: null,
    };
  }

  const requestedFamily = modelFamily(transportProvider, requestedModel);
  const returnedFamily = modelFamily(transportProvider, responseModel);
  if (!requestedFamily || returnedFamily !== requestedFamily) {
    return {
      billingModel: requestedModel,
      modelProvenance: 'request_implied_model',
      attributionStatus: 'validation_error',
      validationError: 'response_model_family_mismatch',
    };
  }

  return {
    billingModel: responseModel,
    modelProvenance: 'returned',
    attributionStatus: 'attributed',
    validationError: null,
  };
}

/**
 * Convert one completed SDK round into PII-free billing evidence. The
 * transport provider is authoritative: contradictory response metadata is
 * telemetry, never permission to move usage into another provider's bucket.
 */
export function attributeRoundUsage({
  provider,
  requestedModel,
  requestedTier,
  responseModel,
  responseTier,
  usage,
  roundIdx,
  timing = null,
  promptCache = null,
  // Plan 00B-2 C3 — the effective reasoning effort ACTUALLY placed in the
  // adapter request payload (the dispatch resolver's value; equals the
  // adapter's own computation by construction). Null/unavailable for
  // providers without the field and for callers that thread nothing —
  // 00C's Terra gate rejects configuration-only evidence, so this field is
  // what proves an executed low/none round.
  reasoningEffort = null,
  // Plan 00B-3 C5 — WHICH API served the round (adapter-stamped actual
  // transport: anthropic_messages | chat_completions | responses). Callers
  // that thread nothing attribute null — never a configuration guess.
  apiTransport = null,
  // Plan 00B live-lane C5 — WHICH KIND of loop the round belongs to. The
  // authoritative producer is `routeToObservationTier` in the shadow harness,
  // which is a BOOLEAN: it can prove a loop WAS an observation loop, and
  // nothing else. So the closed vocabulary is exactly {observation, reading}
  // and every non-observation loop — reading, keepalive, shadow and legacy
  // alike — normalises to 'reading'. Anything malformed or absent normalises
  // there too, which is what makes the 00C Terra gate fail closed: Terra
  // credit requires an explicit 'observation', never an inferred one.
  turnKind = null,
  // Plan 00B-4 §C1c — the provider's OWN opaque call id for this round
  // (`msg_…` / `chatcmpl-…` / `resp_…`), adapter-stamped on the finalMessage
  // carrier. It is the evidence lane's proof that a sample consumed a real
  // vendor call, and 00C hashes the ordered ids into the sample identity, so
  // it must be carried verbatim — never derived, never fabricated. It is an
  // opaque vendor handle only: no prompt, transcript or inspector content.
  providerCallId = null,
}) {
  const transportProvider = provider;
  const requestedTierNormalized =
    transportProvider === 'openai' ? normalizeTier(requestedTier) : null;
  const model = classifyReturnedModel(transportProvider, requestedModel, responseModel);
  let billingTier = null;
  let tierProvenance = 'unavailable_for_provider';
  let tierError = null;

  if (transportProvider === 'openai') {
    const rawTier = typeof responseTier === 'string' ? responseTier.trim().toLowerCase() : '';
    if (rawTier) {
      if (!OPENAI_TIERS.has(rawTier)) {
        billingTier = requestedTierNormalized;
        tierProvenance = 'returned';
        tierError = 'unknown_response_tier';
      } else {
        billingTier = rawTier;
        tierProvenance = 'returned';
        const returnedTierNormalized = normalizeTier(rawTier);
        const requestedFast = ['fast', 'priority'].includes(requestedTierNormalized);
        const returnedFast = ['fast', 'priority'].includes(returnedTierNormalized);
        if (requestedFast !== returnedFast) tierError = 'response_tier_mismatch';
      }
    } else {
      billingTier = requestedTierNormalized;
      tierProvenance = 'request_implied_standard';
      if (requestedTierNormalized === 'fast' || requestedTierNormalized === 'priority') {
        tierError = 'fast_response_tier_missing';
      }
    }
  }

  const attributionStatus =
    model.attributionStatus === 'unattributed_provider_usage'
      ? model.attributionStatus
      : model.attributionStatus === 'validation_error' || tierError
        ? 'validation_error'
        : 'attributed';
  const validationErrors = [model.validationError, tierError].filter(Boolean);

  return {
    round_idx: roundIdx,
    provider: transportProvider,
    api_transport: apiTransport ?? null,
    turn_kind: turnKind === 'observation' ? 'observation' : 'reading',
    provider_call_id:
      typeof providerCallId === 'string' && providerCallId.trim().length > 0
        ? providerCallId.trim()
        : null,
    requested_model: requestedModel,
    requested_tier: transportProvider === 'openai' ? (requestedTier ?? null) : null,
    response_model: responseModel ?? null,
    response_tier: responseTier ?? null,
    billing_model: model.billingModel,
    billing_tier: billingTier,
    model_provenance: model.modelProvenance,
    tier_provenance: tierProvenance,
    attribution_status: attributionStatus,
    validation_error: validationErrors.length > 0 ? validationErrors.join(',') : null,
    reasoning_effort: transportProvider === 'openai' ? (reasoningEffort ?? null) : null,
    fresh_input_tokens: usage?.input_tokens || 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens || 0,
    cache_write_input_tokens: usage?.cache_creation_input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    // Plan 08A — this function returns an explicit ALLOWLIST: every field is
    // copied by name and anything unnamed is dropped, so surfacing
    // reasoning_tokens in the adapter alone would have been a silent no-op.
    // `?? null` preserves a provider-reported 0 and makes an unreported value
    // an explicit JSON null (an `undefined` property vanishes from the
    // CloudWatch row entirely). Transports that do not report reasoning —
    // Anthropic, and OpenAI chat-completions — attribute null, which is the
    // honest answer for them rather than a fabricated 0.
    reasoning_tokens: usage?.reasoning_tokens ?? null,
    // Legacy aliases retained for existing cache telemetry consumers.
    input_tokens: usage?.input_tokens || 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens || 0,
    prompt_cache_mode: promptCache?.mode ?? null,
    prompt_cache_breakpoint_enabled: promptCache?.breakpoint_enabled ?? false,
    prompt_cache_key_id: promptCache?.key_id ?? null,
    timing,
    prompt_cache: promptCache,
  };
}

/** Evaluation lanes fail their verdict on metadata contradictions; live never calls this. */
export function assertUsageAttributionValid(roundUsage) {
  const errors = (Array.isArray(roundUsage) ? roundUsage : []).filter(
    (row) => row?.attribution_status !== 'attributed'
  );
  if (errors.length > 0) {
    const error = new Error(`Usage attribution verdict failed for ${errors.length} round(s)`);
    error.code = 'USAGE_ATTRIBUTION_VERDICT_FAILED';
    error.rounds = errors.map((row) => ({
      round_idx: row.round_idx,
      attribution_status: row.attribution_status,
      validation_error: row.validation_error,
    }));
    throw error;
  }
  return true;
}

export const _internals = { modelFamily, normalizeTier };
