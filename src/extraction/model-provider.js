/**
 * Canonical provider classification for live extraction models.
 *
 * A model identifier and SDK client are one routing decision. Unknown model
 * families must fail before dispatch; silently pairing a GPT model with the
 * Anthropic SDK (or the reverse) produces a misleading provider fallback and
 * an inevitable API error.
 */
export class ProviderResolutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderResolutionError';
    this.code = 'PROVIDER_RESOLUTION_ERROR';
    this.details = details;
  }
}

export function providerForModel(model) {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  const lowerModel = normalizedModel.toLowerCase();

  if (lowerModel.startsWith('gpt-')) return 'openai';
  if (lowerModel.startsWith('claude-')) return 'anthropic';

  throw new ProviderResolutionError(`Unsupported extraction model provider: ${model || '<empty>'}`, {
    model: normalizedModel,
  });
}

export function assertSameProvider(baseModel, overrideModel) {
  const baseProvider = providerForModel(baseModel);
  const overrideProvider = providerForModel(overrideModel);
  if (baseProvider !== overrideProvider) {
    throw new ProviderResolutionError(
      `Cross-provider round-one override is unsupported: ${baseModel} -> ${overrideModel}`,
      {
        baseModel,
        baseProvider,
        overrideModel,
        overrideProvider,
      }
    );
  }
  return baseProvider;
}
