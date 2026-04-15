'use client';

import { WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <WifiOff className="h-16 w-16 text-muted-foreground" />
      <h1 className="text-2xl font-bold">You&apos;re Offline</h1>
      <p className="max-w-md text-muted-foreground">
        CertMate needs an internet connection to sync your data. Please check your connection and
        try again.
      </p>
      <div className="flex gap-3">
        <Button onClick={() => window.location.reload()}>Try Again</Button>
        <Button variant="outline" asChild>
          <a href="/dashboard">Go to Dashboard</a>
        </Button>
      </div>
    </div>
  );
}
