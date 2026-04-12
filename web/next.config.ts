import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',

  async headers() {
    return [
      {
        // Prevent browser/CDN from caching HTML page responses.
        // Next.js App Router embeds server action IDs into pages at build time.
        // After a redeploy those IDs change, so stale cached pages cause
        // "Failed to find Server Action" errors.  Static assets (_next/static)
        // are content-hashed and safe to cache long-term; everything else must
        // revalidate on every request.
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
      {
        // Re-allow long-term caching for immutable hashed static assets.
        // These already have unique filenames per build so they are safe.
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
