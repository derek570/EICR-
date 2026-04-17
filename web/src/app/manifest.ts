import type { MetadataRoute } from 'next';

/**
 * PWA web-app manifest — served at `/manifest.webmanifest` by Next's
 * Metadata Files convention.
 *
 * Why a typed `manifest.ts` instead of a static `public/manifest.webmanifest`:
 *  - Colours, names, and start_url live in TypeScript so they can't drift
 *    from the rest of the app (e.g. the surface-0 token `#0a0a0a` is used
 *    by the root layout's `themeColor`; keeping both in TS makes mismatch
 *    impossible at review time).
 *  - Next emits the manifest with `Content-Type: application/manifest+json`
 *    and the correct hashed URL; the static-file path does not.
 *
 * `start_url: '/dashboard'` — installed users are already signed in (we don't
 * prompt for install on `/login`), so the home screen launches straight into
 * the job list. Middleware still gates this on a valid JWT; if the token has
 * expired, the install-launch falls through to `/login` as normal.
 *
 * `theme_color` and `background_color` both use surface-0 `#0a0a0a`. The
 * background colour is painted behind the app while the first JS chunk
 * hydrates; matching it to surface-0 eliminates the flash-of-black-then-
 * slightly-different-black users would otherwise see on cold launch.
 *
 * Icons: the `any` set is rounded in-source (22% radius); the `maskable`
 * set is full-bleed with the glyph inside a 70%-safe-zone so Android's
 * adaptive-icon mask doesn't clip the "CM". See `scripts/generate-pwa-icons.mjs`.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'CertMate — EICR-oMatic',
    short_name: 'CertMate',
    description: 'Voice-driven EICR and EIC certificate authoring for electrical inspectors.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    theme_color: '#0a0a0a',
    background_color: '#0a0a0a',
    categories: ['productivity', 'business'],
    lang: 'en-GB',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-384.png',
        sizes: '384x384',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
