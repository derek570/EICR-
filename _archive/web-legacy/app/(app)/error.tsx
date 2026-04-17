'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App error:', error);

    // After a redeploy the browser may have a cached page whose embedded
    // server action IDs no longer exist on the new server.  Auto-reload so the
    // user transparently gets the fresh build instead of a broken error screen.
    if (
      error.message?.includes('Failed to find Server Action') ||
      error.message?.includes('Server Actions must be defined') ||
      error.digest?.includes('DYNAMIC_SERVER_USAGE') ||
      error.message?.includes('An unexpected response was received')
    ) {
      window.location.reload();
    }
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center">
      <AlertTriangle className="h-12 w-12 text-amber-500 mb-4" />
      <h2 className="text-lg font-semibold text-gray-100 mb-2">Something went wrong</h2>
      <p className="text-sm text-gray-400 max-w-md mb-6">
        {error.message || 'An unexpected error occurred. Please try again.'}
      </p>
      <Button onClick={reset} variant="outline">
        <RefreshCw className="h-4 w-4 mr-2" />
        Try again
      </Button>
    </div>
  );
}
