import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

/**
 * Phase 7a: wrap the Next config with Serwist so every production build
 * emits `public/sw.js` from `src/app/sw.ts`. Serwist auto-registers the SW
 * on the client (no manual registration component needed).
 *
 * - `cacheOnNavigation: false` is the default, but set explicitly so a
 *   future reader doesn't flip it without noticing. We never want Serwist
 *   stashing authenticated HTML in a runtime cache — every auth-gated
 *   navigation falls through to the network-only default in `sw.ts`.
 * - `reloadOnOnline: true` (default) means the SPA reloads when the browser
 *   reports `online` after being offline. That's the right thing for 7a —
 *   we don't have an outbox yet, so a reload is the cleanest way to get
 *   fresh data once the network is back.
 * - `disable: process.env.NODE_ENV === 'development'` keeps the dev server
 *   clean; HMR and the SW don't mix, and we don't want a stale dev SW
 *   serving cached assets after `npm start`.
 */
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  cacheOnNavigation: false,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === 'development',
});

const nextConfig: NextConfig = {
  /* config options here */
};

export default withSerwist(nextConfig);
