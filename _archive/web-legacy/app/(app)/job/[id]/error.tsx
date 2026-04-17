'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, RefreshCw, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function JobError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error('Job error:', error);

    // Stale server action ID after redeploy — reload to get the fresh build.
    if (
      error.message?.includes('Failed to find Server Action') ||
      error.message?.includes('Server Actions must be defined') ||
      error.message?.includes('An unexpected response was received')
    ) {
      window.location.reload();
    }
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center">
      <AlertTriangle className="h-12 w-12 text-amber-500 mb-4" />
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
        Failed to load job
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mb-6">
        {error.message ||
          'Could not load the certificate data. The job may not exist or there was a network error.'}
      </p>
      <div className="flex gap-3">
        <Button onClick={() => router.push('/dashboard')} variant="outline">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Button>
        <Button onClick={reset}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    </div>
  );
}
