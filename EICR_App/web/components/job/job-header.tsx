'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface JobHeaderProps {
  address: string;
  createdAt: string;
  isDirty: boolean;
  isSyncing: boolean;
  onSave: () => void;
}

export function JobHeader({ address, createdAt, isDirty, isSyncing, onSave }: JobHeaderProps) {
  const router = useRouter();

  const handleBack = () => {
    if (isDirty) {
      if (!confirm('You have unsaved changes. Leave anyway?')) return;
    }
    router.push('/dashboard');
  };

  const date = new Date(createdAt);

  return (
    <header className="h-14 border-b border-white/5 bg-[#0F172A] flex items-center justify-between px-4 flex-shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleBack}
          className="flex-shrink-0 text-gray-400 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="font-semibold text-white truncate">{address || 'Untitled Job'}</h1>
          <p className="text-xs text-gray-500">
            {date.toLocaleDateString()} at{' '}
            {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {isDirty && <span className="text-xs text-amber-600 font-medium">Unsaved changes</span>}
        <Button onClick={onSave} disabled={isSyncing || !isDirty} size="sm">
          {isSyncing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Save
            </>
          )}
        </Button>
      </div>
    </header>
  );
}
