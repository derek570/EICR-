'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Copy, X, Loader2 } from 'lucide-react';

interface CloneDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (newAddress: string, clearTestResults: boolean) => Promise<void>;
  sourceAddress: string;
}

export function CloneDialog({ isOpen, onClose, onConfirm, sourceAddress }: CloneDialogProps) {
  const [newAddress, setNewAddress] = useState('');
  const [clearTestResults, setClearTestResults] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (!newAddress.trim()) return;
    setSubmitting(true);
    try {
      await onConfirm(newAddress.trim(), clearTestResults);
      // Reset form on success
      setNewAddress('');
      setClearTestResults(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open && !submitting) {
      setNewAddress('');
      setClearTestResults(false);
      onClose();
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-lg font-semibold flex items-center gap-2">
              <Copy className="h-5 w-5" />
              Clone Job
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="rounded-full p-1 hover:bg-gray-100" disabled={submitting}>
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <Dialog.Description className="text-sm text-muted-foreground mb-4">
            Create a copy of <span className="font-medium text-foreground">{sourceAddress}</span>{' '}
            with board setup, supply characteristics, and circuit configuration carried over.
            Observations and inspection schedule will be cleared.
          </Dialog.Description>

          <div className="space-y-4">
            <div>
              <Label htmlFor="clone-address">New property address</Label>
              <Input
                id="clone-address"
                placeholder="e.g. 42 Oak Lane, Bristol"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                disabled={submitting}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newAddress.trim()) {
                    handleConfirm();
                  }
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="clear-test-results"
                checked={clearTestResults}
                onChange={(e) => setClearTestResults(e.target.checked)}
                disabled={submitting}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              />
              <Label htmlFor="clear-test-results" className="text-sm font-normal cursor-pointer">
                Clear test results (R1+R2, IR, Zs, RCD times, ring readings)
              </Label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleConfirm} disabled={submitting || !newAddress.trim()}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Cloning...
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-2" />
                    Clone
                  </>
                )}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
