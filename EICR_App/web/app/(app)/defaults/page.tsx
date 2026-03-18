'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Save,
  RotateCcw,
  SlidersHorizontal,
  Zap,
  Shield,
  Cable,
  Gauge,
  TestTube,
  CircleDot,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import type { User, UserDefaults } from '@/lib/types';

/**
 * Top-level Defaults management page — mirrors the iOS DefaultsModal.
 *
 * Lets users configure circuit field default values that are automatically
 * applied when new circuits are created or after extraction merges results.
 * The "only-fill-empty" strategy means defaults only fill blank fields,
 * never overwriting values from voice transcription or CCU photo analysis.
 *
 * Field groups mirror iOS Constants.circuitFieldOrder and DefaultsService.applyDefaults.
 * Only the fields that DefaultsService actually applies are editable here —
 * test-result fields (measured values) are intentionally excluded since those
 * must come from actual on-site measurements.
 */

/* ------------------------------------------------------------------ */
/*  Circuit field definitions grouped by category                      */
/* ------------------------------------------------------------------ */

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
}

interface FieldGroup {
  title: string;
  icon: typeof Zap;
  description: string;
  fields: FieldDef[];
}

const fieldGroups: FieldGroup[] = [
  {
    title: 'Conductors',
    icon: Cable,
    description: 'Wiring type and reference method defaults',
    fields: [
      { key: 'wiring_type', label: 'Wiring Type', placeholder: 'e.g. A' },
      { key: 'ref_method', label: 'Reference Method', placeholder: 'e.g. C' },
    ],
  },
  {
    title: 'Disconnection',
    icon: Zap,
    description: 'Maximum disconnection time',
    fields: [
      {
        key: 'max_disconnect_time_s',
        label: 'Max Disconnect Time (s)',
        placeholder: 'e.g. 0.4',
      },
    ],
  },
  {
    title: 'Overcurrent Devices',
    icon: Shield,
    description: 'OCPD standard, type, and breaking capacity',
    fields: [
      { key: 'ocpd_bs_en', label: 'OCPD BS EN', placeholder: 'e.g. BS EN 60898' },
      { key: 'ocpd_type', label: 'OCPD Type', placeholder: 'e.g. B' },
      {
        key: 'ocpd_breaking_capacity_ka',
        label: 'Breaking Capacity (kA)',
        placeholder: 'e.g. 6',
      },
    ],
  },
  {
    title: 'RCD',
    icon: CircleDot,
    description: 'RCD standard, type, and operating current',
    fields: [
      { key: 'rcd_bs_en', label: 'RCD BS EN', placeholder: 'e.g. BS EN 61008' },
      { key: 'rcd_type', label: 'RCD Type', placeholder: 'e.g. A' },
      {
        key: 'rcd_operating_current_ma',
        label: 'Operating Current (mA)',
        placeholder: 'e.g. 30',
      },
    ],
  },
  {
    title: 'Insulation Resistance',
    icon: Gauge,
    description: 'Test voltage default',
    fields: [
      {
        key: 'ir_test_voltage_v',
        label: 'IR Test Voltage (V)',
        placeholder: 'e.g. 500',
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function DefaultsManagementPage() {
  const [user, setUser] = useState<User | null>(null);
  const [defaults, setDefaults] = useState<UserDefaults>({});
  const [original, setOriginal] = useState<UserDefaults>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /* Load user + saved defaults on mount */
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) return;

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);

    async function loadDefaults() {
      try {
        const data = await api.getUserDefaults(userData.id);
        setDefaults(data);
        setOriginal(data);
      } catch {
        // First time — no defaults yet, start empty
      } finally {
        setLoading(false);
      }
    }
    loadDefaults();
  }, []);

  /* Track whether anything changed */
  const hasChanges = JSON.stringify(defaults) !== JSON.stringify(original);

  /* Count non-empty defaults */
  const configuredCount = Object.values(defaults).filter((v) => v && v.trim() !== '').length;

  /* Update a single field */
  const updateField = (key: string, value: string) => {
    setDefaults((prev) => {
      const next = { ...prev };
      if (value.trim() === '') {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  /* Save to backend */
  const handleSave = async () => {
    if (!user) return;

    setSaving(true);
    try {
      await api.saveUserDefaults(user.id, defaults);
      setOriginal(defaults);
      toast.success('Defaults saved');
    } catch (error) {
      console.error('Failed to save defaults:', error);
      toast.error('Failed to save defaults');
    } finally {
      setSaving(false);
    }
  };

  /* Reset to last saved */
  const handleReset = () => {
    setDefaults(original);
    toast.info('Reset to last saved values');
  };

  /* Clear all */
  const handleClearAll = () => {
    if (!window.confirm('Clear all default values?')) return;
    setDefaults({});
    toast.info('All defaults cleared — save to apply');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/15 to-green-500/15 flex items-center justify-center">
            <SlidersHorizontal className="h-5 w-5 text-blue-500" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Circuit Defaults</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {configuredCount > 0
                ? `${configuredCount} default${configuredCount !== 1 ? 's' : ''} configured`
                : 'No defaults set yet'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <Button variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              Reset
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white shadow-lg shadow-blue-500/25"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Save Defaults
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Info card */}
      <Card className="border-blue-500/20 bg-blue-50/50 dark:bg-blue-500/5">
        <CardContent className="py-4">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            These defaults are automatically applied to new circuits during recording and
            extraction. They only fill in <strong>empty fields</strong> — values from voice
            transcription and CCU photo analysis always take priority.
          </p>
        </CardContent>
      </Card>

      {/* Field groups */}
      {fieldGroups.map((group) => {
        const GroupIcon = group.icon;
        return (
          <Card key={group.title}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <GroupIcon className="h-4 w-4 text-gray-400" />
                <CardTitle className="text-base">{group.title}</CardTitle>
              </div>
              <CardDescription className="text-xs">{group.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {group.fields.map((field) => (
                  <div key={field.key} className="space-y-1.5">
                    <Label htmlFor={`default-${field.key}`} className="text-xs text-gray-500">
                      {field.label}
                    </Label>
                    <Input
                      id={`default-${field.key}`}
                      value={defaults[field.key] || ''}
                      onChange={(e) => updateField(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      className="text-sm"
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Actions footer */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-100 dark:border-gray-800">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearAll}
          className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
        >
          Clear All Defaults
        </Button>
        {hasChanges && (
          <p className="text-xs text-amber-600 dark:text-amber-400">You have unsaved changes</p>
        )}
      </div>
    </div>
  );
}
