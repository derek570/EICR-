/**
 * Render Anthropic-style system text blocks for providers that accept one
 * instruction string. The separator is deliberately explicit: joining blocks
 * with an empty string can fuse the end of the stable snapshot prefix to an
 * EXTRACTED/PENDING heading in the volatile tail.
 */
export const SYSTEM_BLOCK_SEPARATOR = '\n\n';

// Provider-private cache metadata must never ride on the Anthropic-shaped
// block objects themselves: the Anthropic SDK serialises those objects and
// would reject an OpenAI-only property. A WeakMap keeps the boundary attached
// to the array by identity while remaining invisible to JSON serialisation,
// deep-equality tests, and the Anthropic request path.
const openAIStablePrefixBlockCounts = new WeakMap();

/**
 * Mark how many leading system blocks form the stable OpenAI cache prefix.
 * Returns the same array so callers can annotate at construction time.
 */
export function markOpenAIStableSystemPrefix(blocks, stableBlockCount) {
  if (!Array.isArray(blocks)) return blocks;
  const count = Number.isInteger(stableBlockCount)
    ? Math.max(0, Math.min(stableBlockCount, blocks.length))
    : 0;
  openAIStablePrefixBlockCounts.set(blocks, count);
  return blocks;
}

/**
 * Read the stable-prefix boundary. Unannotated arrays conservatively cache
 * only their first block; string prompts are wholly stable.
 */
export function getOpenAIStableSystemBlockCount(system) {
  if (typeof system === 'string') return system.length > 0 ? 1 : 0;
  if (!Array.isArray(system) || system.length === 0) return 0;
  return openAIStablePrefixBlockCounts.get(system) ?? 1;
}

export function renderSystemPrompt(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';

  return system
    .map((block) =>
      typeof block === 'string' ? block : block?.type === 'text' ? block.text || '' : ''
    )
    .filter((text) => text.length > 0)
    .join(SYSTEM_BLOCK_SEPARATOR);
}
