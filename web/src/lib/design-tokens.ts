/**
 * Design tokens — mirror of iOS CertMateDesign.swift.
 * Use these in TS when you need named access (e.g. Playwright assertions,
 * chart colours). For styling, prefer the CSS vars via Tailwind classes.
 */

export const cmColors = {
  brand: {
    blue: '#0066FF',
    blueSoft: '#3385FF', // CMDesign brandBlueSoft
    green: '#00CC66',
    greenSoft: '#33DD88', // CMDesign brandGreenSoft
  },
  /** CMDesign Colors.Green / Colors.Blue accent scales. */
  green: {
    vibrant: '#00E676',
    standard: '#00C853',
    muted: '#00A844',
  },
  blue: {
    vibrant: '#2979FF',
    standard: '#448AFF',
    muted: '#1565C0',
  },
  surface: {
    0: '#0A0A0F',
    1: '#141419',
    2: '#1C1C24',
    3: '#24242E',
    4: '#2D2D38',
  },
  text: {
    primary: '#FFFFFF',
    secondary: '#B0B0C0',
    tertiary: '#6B6B80',
    disabled: '#48484F',
    inverse: '#0A0A0F',
  },
  status: {
    pending: '#6B6B80',
    processing: '#FFB300',
    done: '#00E676',
    failed: '#FF5252',
    limitation: '#BF5AF2',
  },
  rec: {
    idle: '#6E6E78',
    listening: '#FFD60A',
    speaking: '#30D158',
    trailing: '#FF9F0A',
    active: '#FF453A',
    paused: '#FF9F0A',
    confirmed: '#30D158',
  },
  severity: {
    c1: '#FF453A',
    c2: '#FF9F0A',
    c3: '#0A84FF',
    fi: '#BF5AF2',
    ok: '#30D158',
  },
} as const;

export const cmSpacing = {
  xs: 2,
  sm: 4,
  md: 8,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const cmRadius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  // Semantic iOS component radii (CMDesign live-call-site winners — see
  // web/audit/cmdesign-token-map-2026-07.md).
  input: 12,
  button: 14,
  card: 18,
  sectionCard: 16,
  hero: 22,
  ctaPill: 26,
} as const;

export const cmHeights = {
  input: 52, // CMDesign Heights.inputField
  button: 44, // Heights.buttonMedium
  buttonLg: 52, // Heights.buttonLarge
  listRow: 72, // Heights.listRow
  touchTarget: 44,
  topNav: 56,
  tabBar: 49, // Heights.tabBar
  transcriptStrip: 56,
} as const;

/** Recording lifecycle state used by SleepManager-equivalent. */
export type RecordingState = 'idle' | 'listening' | 'speaking' | 'trailing';

/** Session power state — Stage 4c collapsed model (Doze tier removed
 *  2026-04-27, mirroring iOS SleepManager.swift). */
export type PowerState = 'active' | 'sleeping';
