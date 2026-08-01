/**
 * Render Anthropic-style system text blocks for providers that accept one
 * instruction string. The separator is deliberately explicit: joining blocks
 * with an empty string can fuse the end of the stable snapshot prefix to an
 * EXTRACTED/PENDING heading in the volatile tail.
 */
export const SYSTEM_BLOCK_SEPARATOR = '\n\n';

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
