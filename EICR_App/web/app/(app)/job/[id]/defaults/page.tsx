'use client';

import { useState, useEffect } from 'react';
import { useJobContext } from '../layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import type { UserDefaults } from '@/lib/types';
import { toast } from 'sonner';
import { Loader2, Check } from 'lucide-react';

export default function DefaultsPage() {
  const { job, updateJob, user } = useJobContext();
  const [defaults, setDefaults] = useState<UserDefaults>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    async function loadDefaults() {
      if (!user) return;
      try {
        const data = await api.getUserDefaults(user.id);
        setDefaults(data);
      } catch {
        // Not critical
      } finally {
        setLoading(false);
      }
    }
    loadDefaults();
  }, [user]);

  const applyDefaultsToEmpty = () => {
    if (Object.keys(defaults).length === 0) {
      toast.error('No defaults configured. Set defaults in Settings.');
      return;
    }

    setApplying(true);
    let fieldsUpdated = 0;

    const updatedCircuits = job.circuits.map((circuit) => {
      const updated = { ...circuit };
      for (const [key, value] of Object.entries(defaults)) {
        if (value && (!updated[key] || updated[key] === '')) {
          updated[key] = value;
          fieldsUpdated++;
        }
      }
      return updated;
    });

    updateJob({ circuits: updatedCircuits });
    setTimeout(() => {
      setApplying(false);
      toast.success(`Applied ${fieldsUpdated} default values to empty fields`);
    }, 300);
  };

  const applyDefaultsToAll = () => {
    if (Object.keys(defaults).length === 0) {
      toast.error('No defaults configured. Set defaults in Settings.');
      return;
    }

    setApplying(true);
    const updatedCircuits = job.circuits.map((circuit) => {
      const updated = { ...circuit };
      for (const [key, value] of Object.entries(defaults)) {
        if (value) {
          updated[key] = value;
        }
      }
      return updated;
    });

    updateJob({ circuits: updatedCircuits });
    setTimeout(() => {
      setApplying(false);
      toast.success(`Applied defaults to ${job.circuits.length} circuits`);
    }, 300);
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const defaultCount = Object.keys(defaults).length;

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <h2 className="text-lg font-semibold">Apply Defaults to Circuits</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current Defaults</CardTitle>
        </CardHeader>
        <CardContent>
          {defaultCount === 0 ? (
            <p className="text-sm text-gray-500">
              No defaults configured. Go to the{' '}
              <a href="/defaults" className="text-blue-500 underline">
                Circuit Defaults
              </a>{' '}
              page to set up default values.
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                You have {defaultCount} default value{defaultCount !== 1 ? 's' : ''} configured.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-sm">
                {Object.entries(defaults)
                  .slice(0, 12)
                  .map(([key, value]) => (
                    <div key={key} className="bg-gray-50 rounded px-2 py-1">
                      <span className="text-gray-500">{key}:</span>{' '}
                      <span className="font-medium">{value}</span>
                    </div>
                  ))}
                {defaultCount > 12 && (
                  <div className="text-gray-500">+{defaultCount - 12} more...</div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Apply to This Job</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-500">
            Apply your saved defaults to the {job.circuits.length} circuit
            {job.circuits.length !== 1 ? 's' : ''} in this job.
          </p>
          <div className="flex gap-3">
            <Button onClick={applyDefaultsToEmpty} disabled={applying || defaultCount === 0}>
              {applying ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Applying...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  Apply to Empty Fields
                </>
              )}
            </Button>
            <Button
              onClick={applyDefaultsToAll}
              disabled={applying || defaultCount === 0}
              variant="outline"
            >
              Overwrite All Fields
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            &quot;Apply to Empty Fields&quot; only fills in blank values. &quot;Overwrite All&quot;
            replaces all values.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
