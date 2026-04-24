/**
 * SECTION_ACCENTS — iOS-parity section-category token map.
 *
 * Port of `CMDesign.Colors.SectionAccent` from
 * `CertMateUnified/Sources/Views/Components/CertMateDesign.swift` (lines
 * 210-225) and the category enum in `CMSectionCard.swift`.
 *
 * Each accent produces four Tailwind / CSS fragments:
 *   - `text`   — for icons and accent typography (strong accent colour)
 *   - `bg`     — a very subtle tinted background (≈ 6% opacity) so cards
 *                hint at their category without drowning the content
 *   - `border` — a soft accent-tinted border (≈ 18% opacity)
 *   - `stripe` — the 3pt left stripe colour (full strength) used by
 *                `SectionCard` and any other "status conduit" surface
 *
 * Hex values are taken verbatim from the iOS enum (they already live in
 * `globals.css` as CSS vars so we re-use the vars where possible; the
 * hex fallback exists for inline styles where a CSS var would be awkward
 * — e.g. `color-mix()` with an alpha channel).
 */

export type SectionAccent =
  | 'client'
  | 'electrical'
  | 'board'
  | 'test-results'
  | 'schedule'
  | 'notes'
  | 'protection';

export interface SectionAccentTokens {
  text: string;
  bg: string;
  border: string;
  stripe: string;
}

export const SECTION_ACCENTS: Record<SectionAccent, SectionAccentTokens> = {
  client: {
    text: '#2979FF',
    bg: 'color-mix(in srgb, #2979FF 6%, transparent)',
    border: 'color-mix(in srgb, #2979FF 18%, transparent)',
    stripe: '#2979FF',
  },
  electrical: {
    text: '#FFB300',
    bg: 'color-mix(in srgb, #FFB300 6%, transparent)',
    border: 'color-mix(in srgb, #FFB300 18%, transparent)',
    stripe: '#FFB300',
  },
  board: {
    text: '#00E676',
    bg: 'color-mix(in srgb, #00E676 6%, transparent)',
    border: 'color-mix(in srgb, #00E676 18%, transparent)',
    stripe: '#00E676',
  },
  'test-results': {
    text: '#FF5252',
    bg: 'color-mix(in srgb, #FF5252 6%, transparent)',
    border: 'color-mix(in srgb, #FF5252 18%, transparent)',
    stripe: '#FF5252',
  },
  schedule: {
    text: '#448AFF',
    bg: 'color-mix(in srgb, #448AFF 6%, transparent)',
    border: 'color-mix(in srgb, #448AFF 18%, transparent)',
    stripe: '#448AFF',
  },
  notes: {
    text: '#6B6B80',
    bg: 'color-mix(in srgb, #6B6B80 6%, transparent)',
    border: 'color-mix(in srgb, #6B6B80 18%, transparent)',
    stripe: '#6B6B80',
  },
  protection: {
    text: '#00E676',
    bg: 'color-mix(in srgb, #00E676 6%, transparent)',
    border: 'color-mix(in srgb, #00E676 18%, transparent)',
    stripe: '#00E676',
  },
};
