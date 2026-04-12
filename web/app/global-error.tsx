'use client';

import { useEffect } from 'react';

// Root-level error boundary — catches errors that escape all nested boundaries,
// including root layout failures.  Must supply its own <html>/<body>.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);

    // A stale server action ID (from a cached page surviving a redeploy) will
    // surface here if it isn't caught by a nested boundary.  Reload to pull
    // the fresh build and clear the stale reference.
    if (
      error.message?.includes('Failed to find Server Action') ||
      error.message?.includes('Server Actions must be defined') ||
      error.message?.includes('An unexpected response was received')
    ) {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0F172A',
          color: '#F1F5F9',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <h2 style={{ marginBottom: '0.5rem' }}>Something went wrong</h2>
          <p style={{ color: '#94A3B8', marginBottom: '1.5rem' }}>
            {error.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={reset}
            style={{
              padding: '0.5rem 1.25rem',
              border: '1px solid #475569',
              borderRadius: '6px',
              background: 'transparent',
              color: '#F1F5F9',
              cursor: 'pointer',
              marginRight: '0.75rem',
            }}
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1.25rem',
              border: 'none',
              borderRadius: '6px',
              background: '#3B82F6',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload page
          </button>
        </div>
      </body>
    </html>
  );
}
