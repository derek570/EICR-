/**
 * Design tokens — mirror of iOS CertMateDesign.swift.
 * Use these in TS when you need named access (e.g. Playwright assertions,
 * chart colours). For styling, prefer the CSS vars via Tailwind classes.
 */

export const cmColors = {
  brand: {
    blue: '#0066FF',
    blueSoft: '#3B82F6',
    green: '#00CC66',
    greenSoft: '#22C55E',
  },
  surface: {
    0: '#0A0A0F',
    1: '#141419',
    2: '#1C1C24',
    3: '#24242E',
    4: '#2D2D38',
  },
  text: {
    primary: '#F5F5F7',
    secondary: '#A0A0AA',
    tertiary: '#6E6E78',
    disabled: '#48484F',
  },
  status: {
    pending: '#6E6E78',
    processing: '#FF9F0A',
    done: '#30D158',
    failed: '#FF453A',
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
} as const;

export const cmHeights = {
  input: 44,
  button: 44,
  touchTarget: 44,
  topNav: 56,
  tabBar: 48,
  transcriptStrip: 56,
} as const;

/** Recording lifecycle state used by SleepManager-equivalent. */
export type RecordingState = 'idle' | 'listening' | 'speaking' | 'trailing';

/** Session power state. */
export type PowerState = 'active' | 'dozing' | 'sleeping';
