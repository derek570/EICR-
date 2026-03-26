/**
 * CertMate iOS Dark Glassmorphic Design Tokens
 * All values mirror the CSS custom properties in globals.css
 */

// ── Surface Layers ──
export const surface = {
  L0: '#0A0A0F',
  L1: '#141419',
  L2: '#1C1C24',
  L3: '#24242E',
} as const;

// ── Brand Colors ──
export const brand = {
  blue: 'rgb(0, 102, 255)',
  green: 'rgb(0, 204, 102)',
} as const;

// ── Status Colors ──
export const status = {
  green: '#00E676',
  amber: '#FFB300',
  red: '#FF5252',
  blue: '#2979FF',
} as const;

// ── Typography ──
export const typography = {
  fontFamily: {
    sans: '"Inter", system-ui, -apple-system, sans-serif',
    mono: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
  },
  display: { size: '52px', weight: '800', lineHeight: '1.1' },
  h1: { size: '38px', weight: '800', lineHeight: '1.15' },
  section: { size: '19px', weight: '700', lineHeight: '1.3' },
  body: { size: '16px', weight: '400', lineHeight: '1.5' },
  caption: { size: '14px', weight: '400', lineHeight: '1.4' },
  badge: { size: '10px', weight: '800', lineHeight: '1.2' },
} as const;

// ── Spacing (4px grid) ──
export const spacing = {
  unit: 4,
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  '2xl': '48px',
  '3xl': '64px',
} as const;

// ── Border Radii ──
export const radii = {
  card: '18px',
  input: '12px',
  pill: '9999px',
} as const;

// ── Shadows ──
export const shadows = {
  soft: '0 3px 10px rgba(0, 0, 0, 0.10)',
  medium: '0 6px 20px rgba(0, 0, 0, 0.14)',
  elevated: '0 10px 30px rgba(0, 0, 0, 0.22)',
  blueGlow: '0 4px 16px rgba(0, 102, 255, 0.30)',
} as const;

// ── Glass ──
export const glass = {
  background: 'rgba(255, 255, 255, 0.06)',
  backgroundHover: 'rgba(255, 255, 255, 0.08)',
  border: 'rgba(255, 255, 255, 0.08)',
  borderGradient: {
    from: 'rgba(0, 102, 255, 0.12)',
    to: 'rgba(0, 204, 102, 0.08)',
  },
  blur: '20px',
} as const;

// ── Animation Durations ──
export const animation = {
  breatheGlow: '2s ease-in-out infinite',
  staggerIn: '0.4s ease-out both',
  staggerDelay: 60, // ms between children
  springPress: '0.15s ease-out',
} as const;

// ── Aggregate export ──
const tokens = {
  surface,
  brand,
  status,
  typography,
  spacing,
  radii,
  shadows,
  glass,
  animation,
} as const;

export default tokens;
