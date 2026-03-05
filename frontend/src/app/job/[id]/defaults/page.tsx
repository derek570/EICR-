'use client';

import { useState, useEffect } from 'react';
import { useJob } from '../layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, UserDefaults } from '@/lib/api';
import { toast } from 'sonner';
import { Loader2, Check } from 'lucide-react';

export default function DefaultsPage() {
  const { job, updateJob, user } = useJob();
  const [defaults, setDefaults] = useState<UserDefaults>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    async function loadDefaults() {
      if (!user) return;
      try {
        const data = await api.getUserDefaults(user.id);
        setDefaults(data);
      } catch (error) {
        console.error('Failed to load defaults:', error);
        // Not critical - just means no defaults set
      } finally {
        setLoading(false);
      }
    }
    loadDefaults();
  }, [user]);

  const applyDefaultsToAll = () => {
    if (Object.keys(defaults).length === 0) {
      toast.error('No defaults configured. Set defaults in Settings.');
      return;
    }

    setApplying(true);

    // Apply defaults to all circuits
    const updatedCircuits = job.circuits.map((circuit) => {
      const updated = { ...circuit };
      for (const [key, value] of Object.entries(defaults)) {
        // Only apply if the circuit field is empty
        if (!updated[key] || updated[key] === '') {
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

  const applyDefaultsToEmpty = () => {
    if (Object.keys(defaults).length === 0) {
      toast.error('No defaults configured. Set defaults in Settings.');
      return;
    }

    setApplying(true);

    // Count how many fields will be updated
    let fieldsUpdated = 0;

    const updatedCircuits = job.circuits.map((circuit) => {
      const updated = { ...circuit };
      for (const [key, value] of Object.entries(defaults)) {
        if (!updated[key] || updated[key] === '') {
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

  if (loading) {
    return (
      <div className="p-4 flex items-center justify-center min-h-[200px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const defaultCount = Object.keys(defaults).length;

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">Apply Defaults to Circuits</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current Defaults</CardTitle>
        </CardHeader>
        <CardContent>
          {defaultCount === 0 ? (
            <p className="text-sm text-muted-foreground">
              No defaults configured. Go to Settings &gt; Circuit Defaults to set up default values.
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                You have {defaultCount} default value{defaultCount !== 1 ? 's' : ''} configured.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-sm">
                {Object.entries(defaults)
                  .slice(0, 12)
                  .map(([key, value]) => (
                    <div key={key} className="bg-muted rounded px-2 py-1">
                      <span className="text-muted-foreground">{key}:</span>{' '}
                      <span className="font-medium">{value}</span>
                    </div>
                  ))}
                {defaultCount > 12 && (
                  <div className="text-muted-foreground">+{defaultCount - 12} more...</div>
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
          <p className="text-sm text-muted-foreground">
            Apply your saved defaults to the {job.circuits.length} circuit
            {job.circuits.length !== 1 ? 's' : ''} in this job.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              onClick={applyDefaultsToEmpty}
              disabled={applying || defaultCount === 0}
              variant="default"
            >
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
          <p className="text-xs text-muted-foreground">
            "Apply to Empty Fields" only fills in blank values. "Overwrite All" replaces all values.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
