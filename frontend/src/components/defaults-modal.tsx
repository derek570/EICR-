'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Loader2, X, Save, FileText } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  EARTHING_ARRANGEMENTS,
  VOLTAGES,
  FREQUENCIES,
  PREMISES_DESCRIPTIONS,
} from '@/lib/constants';

interface DefaultsModalProps {
  userId: string;
  isOpen: boolean;
  onClose: () => void;
}

// Full certificate defaults structure
interface CertificateDefaults {
  // Installation Details
  installation?: {
    premises_description?: string;
    next_inspection_years?: number;
    extent?: string;
    agreed_limitations?: string;
  };
  // Supply Characteristics
  supply?: {
    earthing_arrangement?: string;
    nominal_voltage_u?: string;
    nominal_frequency?: string;
    live_conductors?: string;
  };
  // Board Info
  board?: {
    location?: string;
    manufacturer?: string;
    phases?: string;
  };
  // Circuit Defaults (all 29 fields)
  circuits?: Record<string, string>;
  // Standard Observations
  observations?: Array<{ code: string; item: string; observation: string }>;
}

const CIRCUIT_FIELDS = [
  { key: 'wiring_type', label: 'Wiring Type' },
  { key: 'ref_method', label: 'Ref Method' },
  { key: 'live_csa_mm2', label: 'Live CSA mm2' },
  { key: 'cpc_csa_mm2', label: 'CPC CSA mm2' },
  { key: 'max_disconnect_time_s', label: 'Max Disc Time' },
  { key: 'ocpd_bs_en', label: 'OCPD BS/EN' },
  { key: 'ocpd_type', label: 'OCPD Type' },
  { key: 'ocpd_rating_a', label: 'OCPD Rating A' },
  { key: 'ocpd_breaking_capacity_ka', label: 'OCPD Breaking kA' },
  { key: 'rcd_bs_en', label: 'RCD BS/EN' },
  { key: 'rcd_type', label: 'RCD Type' },
  { key: 'rcd_operating_current_ma', label: 'RCD mA' },
  { key: 'ir_test_voltage_v', label: 'IR Test Voltage' },
  { key: 'polarity_confirmed', label: 'Polarity' },
];

const LIVE_CONDUCTOR_OPTIONS = ['Single-phase', 'Three-phase'];
const PHASES_OPTIONS = ['1', '3'];
const NEXT_INSPECTION_OPTIONS = [1, 2, 3, 4, 5, 10];

export function DefaultsModal({ userId, isOpen, onClose }: DefaultsModalProps) {
  const [defaults, setDefaults] = useState<CertificateDefaults>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<string>('installation');

  useEffect(() => {
    if (isOpen) {
      loadDefaults();
    }
  }, [isOpen, userId]);

  const loadDefaults = async () => {
    setLoading(true);
    try {
      // Load both circuit defaults and full certificate defaults
      const circuitDefaults = await api.getUserDefaults(userId);

      // Try to load full certificate defaults (stored separately)
      let fullDefaults: CertificateDefaults = { circuits: circuitDefaults };
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || ''}/api/settings/${userId}/certificate-defaults`,
          {
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          }
        );
        if (response.ok) {
          fullDefaults = await response.json();
          fullDefaults.circuits = { ...circuitDefaults, ...fullDefaults.circuits };
        }
      } catch {
        // Certificate defaults endpoint may not exist yet, use circuit defaults only
      }

      setDefaults(fullDefaults);
    } catch (error) {
      console.error('Failed to load defaults:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Save circuit defaults
      if (defaults.circuits) {
        await api.saveUserDefaults(userId, defaults.circuits);
      }

      // Try to save full certificate defaults (may fail if endpoint doesn't exist)
      try {
        await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || ''}/api/settings/${userId}/certificate-defaults`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${localStorage.getItem('token')}`,
            },
            body: JSON.stringify(defaults),
          }
        );
      } catch {
        // Endpoint may not exist - circuit defaults will still be saved
      }

      toast.success('Defaults saved');
    } catch (error) {
      console.error('Failed to save defaults:', error);
      toast.error('Failed to save defaults');
    } finally {
      setSaving(false);
    }
  };

  const updateInstallation = (key: string, value: string | number) => {
    setDefaults((prev) => ({
      ...prev,
      installation: { ...prev.installation, [key]: value },
    }));
  };

  const updateSupply = (key: string, value: string) => {
    setDefaults((prev) => ({
      ...prev,
      supply: { ...prev.supply, [key]: value },
    }));
  };

  const updateBoard = (key: string, value: string) => {
    setDefaults((prev) => ({
      ...prev,
      board: { ...prev.board, [key]: value },
    }));
  };

  const updateCircuit = (key: string, value: string) => {
    setDefaults((prev) => ({
      ...prev,
      circuits: { ...prev.circuits, [key]: value },
    }));
  };

  if (!isOpen) return null;

  const sections = [
    { id: 'installation', label: 'Installation' },
    { id: 'supply', label: 'Supply' },
    { id: 'board', label: 'Board' },
    { id: 'circuits', label: 'Circuit Defaults' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Certificate Defaults
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex h-[calc(90vh-140px)]">
            {/* Section Navigation */}
            <div className="w-48 border-r bg-slate-50 p-4">
              <nav className="space-y-1">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      activeSection === section.id
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-slate-200'
                    }`}
                  >
                    {section.label}
                  </button>
                ))}
              </nav>
              <p className="mt-4 text-xs text-muted-foreground">
                Set default values that will be applied to new jobs unless transcript data is
                available.
              </p>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {activeSection === 'installation' && (
                <Card>
                  <CardHeader>
                    <CardTitle>Installation Details Defaults</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Premises Description</Label>
                        <Select
                          value={defaults.installation?.premises_description || ''}
                          onValueChange={(v) => updateInstallation('premises_description', v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            {PREMISES_DESCRIPTIONS.map((p) => (
                              <SelectItem key={p} value={p}>
                                {p}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Next Inspection (Years)</Label>
                        <Select
                          value={String(defaults.installation?.next_inspection_years || '')}
                          onValueChange={(v) =>
                            updateInstallation('next_inspection_years', parseInt(v))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            {NEXT_INSPECTION_OPTIONS.map((n) => (
                              <SelectItem key={n} value={String(n)}>
                                {n} year{n !== 1 ? 's' : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div>
                      <Label>Standard Extent of Installation</Label>
                      <Input
                        value={defaults.installation?.extent || ''}
                        onChange={(e) => updateInstallation('extent', e.target.value)}
                        placeholder="e.g., Full installation"
                      />
                    </div>
                    <div>
                      <Label>Standard Agreed Limitations</Label>
                      <Input
                        value={defaults.installation?.agreed_limitations || ''}
                        onChange={(e) => updateInstallation('agreed_limitations', e.target.value)}
                        placeholder="e.g., None"
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              {activeSection === 'supply' && (
                <Card>
                  <CardHeader>
                    <CardTitle>Supply Characteristics Defaults</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Earthing Arrangement</Label>
                        <Select
                          value={defaults.supply?.earthing_arrangement || ''}
                          onValueChange={(v) => updateSupply('earthing_arrangement', v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            {EARTHING_ARRANGEMENTS.map((e) => (
                              <SelectItem key={e} value={e}>
                                {e}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Live Conductors</Label>
                        <Select
                          value={defaults.supply?.live_conductors || ''}
                          onValueChange={(v) => updateSupply('live_conductors', v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            {LIVE_CONDUCTOR_OPTIONS.map((l) => (
                              <SelectItem key={l} value={l}>
                                {l}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Nominal Voltage</Label>
                        <Select
                          value={defaults.supply?.nominal_voltage_u || ''}
                          onValueChange={(v) => updateSupply('nominal_voltage_u', v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            {VOLTAGES.map((v) => (
                              <SelectItem key={v} value={v}>
                                {v}V
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Nominal Frequency</Label>
                        <Select
                          value={defaults.supply?.nominal_frequency || ''}
                          onValueChange={(v) => updateSupply('nominal_frequency', v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            {FREQUENCIES.map((f) => (
                              <SelectItem key={f} value={f}>
                                {f}Hz
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {activeSection === 'board' && (
                <Card>
                  <CardHeader>
                    <CardTitle>Board Information Defaults</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Default Location</Label>
                        <Input
                          value={defaults.board?.location || ''}
                          onChange={(e) => updateBoard('location', e.target.value)}
                          placeholder="e.g., Under stairs"
                        />
                      </div>
                      <div>
                        <Label>Default Manufacturer</Label>
                        <Input
                          value={defaults.board?.manufacturer || ''}
                          onChange={(e) => updateBoard('manufacturer', e.target.value)}
                          placeholder="e.g., Hager"
                        />
                      </div>
                      <div>
                        <Label>Phases</Label>
                        <Select
                          value={defaults.board?.phases || ''}
                          onValueChange={(v) => updateBoard('phases', v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                          <SelectContent>
                            {PHASES_OPTIONS.map((p) => (
                              <SelectItem key={p} value={p}>
                                {p}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {activeSection === 'circuits' && (
                <Card>
                  <CardHeader>
                    <CardTitle>Circuit Field Defaults</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground mb-4">
                      These values will be applied to all circuits when creating new jobs.
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                      {CIRCUIT_FIELDS.map((field) => (
                        <div key={field.key}>
                          <Label className="text-xs">{field.label}</Label>
                          <Input
                            value={defaults.circuits?.[field.key] || ''}
                            onChange={(e) => updateCircuit(field.key, e.target.value)}
                            placeholder={`Default ${field.label.toLowerCase()}`}
                            className="h-9 text-sm"
                          />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 p-4 border-t">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
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
    </div>
  );
}
