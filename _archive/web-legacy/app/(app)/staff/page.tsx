'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Loader2, Users, ChevronRight, Pencil, Trash2, X, Shield } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import type { User, InspectorProfile } from '@/lib/types';

/**
 * Staff page — mirrors the iOS InspectorListView.
 * Lists all staff/inspectors with add, edit, delete, and default toggle.
 * Each staff member can have test equipment details (MFT, continuity,
 * insulation, earth fault loop, RCD) with serial numbers & calibration dates.
 */

interface StaffFormData {
  name: string;
  position: string;
  organisation: string;
  enrolment_number: string;
  isDefault: boolean;
  // Test equipment
  mft_serial: string;
  mft_calibration: string;
  continuity_serial: string;
  continuity_calibration: string;
  insulation_serial: string;
  insulation_calibration: string;
  earth_fault_serial: string;
  earth_fault_calibration: string;
  rcd_serial: string;
  rcd_calibration: string;
}

const emptyForm: StaffFormData = {
  name: '',
  position: '',
  organisation: '',
  enrolment_number: '',
  isDefault: false,
  mft_serial: '',
  mft_calibration: '',
  continuity_serial: '',
  continuity_calibration: '',
  insulation_serial: '',
  insulation_calibration: '',
  earth_fault_serial: '',
  earth_fault_calibration: '',
  rcd_serial: '',
  rcd_calibration: '',
};

export default function StaffPage() {
  const [user, setUser] = useState<User | null>(null);
  const [profiles, setProfiles] = useState<InspectorProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<StaffFormData>({ ...emptyForm });

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) return;

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);

    async function loadProfiles() {
      try {
        const result = await api.getInspectorProfiles(userData.id);
        setProfiles(result);
      } catch (error) {
        console.error('Failed to load staff:', error);
        toast.error('Failed to load staff');
      } finally {
        setLoading(false);
      }
    }
    loadProfiles();
  }, []);

  const openAddForm = () => {
    setForm({ ...emptyForm });
    setEditingIndex(null);
    setShowForm(true);
  };

  const openEditForm = (index: number) => {
    const p = profiles[index];
    setForm({
      name: p.name || '',
      position: p.position || '',
      organisation: p.organisation || '',
      enrolment_number: p.enrolment_number || '',
      isDefault: false, // We'll handle defaults separately
      mft_serial: '',
      mft_calibration: '',
      continuity_serial: '',
      continuity_calibration: '',
      insulation_serial: '',
      insulation_calibration: '',
      earth_fault_serial: '',
      earth_fault_calibration: '',
      rcd_serial: '',
      rcd_calibration: '',
    });
    setEditingIndex(index);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingIndex(null);
    setForm({ ...emptyForm });
  };

  const handleSave = async () => {
    if (!user || !form.name.trim()) {
      toast.error('Name is required');
      return;
    }

    setSaving(true);
    try {
      const updated = [...profiles];
      const profile: InspectorProfile = {
        id: editingIndex !== null ? profiles[editingIndex].id : crypto.randomUUID(),
        name: form.name.trim(),
        position: form.position.trim() || undefined,
        organisation: form.organisation.trim() || undefined,
        enrolment_number: form.enrolment_number.trim() || undefined,
      };

      if (editingIndex !== null) {
        updated[editingIndex] = profile;
      } else {
        updated.push(profile);
      }

      await api.saveInspectorProfiles(user.id, updated);
      setProfiles(updated);
      closeForm();
      toast.success(editingIndex !== null ? 'Staff member updated' : 'Staff member added');
    } catch (error) {
      console.error('Failed to save staff:', error);
      toast.error('Failed to save staff');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (index: number) => {
    if (!user) return;
    const name = profiles[index].name;
    if (!window.confirm(`Delete staff member "${name}"?`)) return;

    setSaving(true);
    try {
      const updated = profiles.filter((_, i) => i !== index);
      await api.saveInspectorProfiles(user.id, updated);
      setProfiles(updated);
      toast.success(`"${name}" deleted`);
    } catch (error) {
      console.error('Failed to delete staff:', error);
      toast.error('Failed to delete staff');
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field: keyof StaffFormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-blue-500" />
          <h1 className="text-lg font-semibold">Staff</h1>
          <span className="text-sm text-gray-500">({profiles.length})</span>
        </div>
        <Button
          onClick={openAddForm}
          size="sm"
          className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white shadow-lg shadow-blue-500/25"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Staff
        </Button>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <Card className="border-blue-500/30">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {editingIndex !== null ? 'Edit Staff Member' : 'Add Staff Member'}
              </CardTitle>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={closeForm}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Name section */}
            <div>
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Name</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="staff-name">Full Name *</Label>
                  <Input
                    id="staff-name"
                    value={form.name}
                    onChange={(e) => updateField('name', e.target.value)}
                    placeholder="e.g. John Smith"
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="staff-position">Position</Label>
                  <Input
                    id="staff-position"
                    value={form.position}
                    onChange={(e) => updateField('position', e.target.value)}
                    placeholder="e.g. Senior Electrician"
                  />
                </div>
              </div>
            </div>

            {/* Details section */}
            <div>
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Details</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="staff-org">Organisation</Label>
                  <Input
                    id="staff-org"
                    value={form.organisation}
                    onChange={(e) => updateField('organisation', e.target.value)}
                    placeholder="e.g. Beckley Electrical"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="staff-enrolment">Enrolment Number</Label>
                  <Input
                    id="staff-enrolment"
                    value={form.enrolment_number}
                    onChange={(e) => updateField('enrolment_number', e.target.value)}
                    placeholder="e.g. ECS123456"
                  />
                </div>
              </div>
            </div>

            {/* Test Equipment sections */}
            <div>
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">
                Test Equipment
              </h3>
              <div className="space-y-4">
                {[
                  {
                    label: 'MFT (Multi-Function Tester)',
                    serial: 'mft_serial' as const,
                    cal: 'mft_calibration' as const,
                  },
                  {
                    label: 'Continuity',
                    serial: 'continuity_serial' as const,
                    cal: 'continuity_calibration' as const,
                  },
                  {
                    label: 'Insulation Resistance',
                    serial: 'insulation_serial' as const,
                    cal: 'insulation_calibration' as const,
                  },
                  {
                    label: 'Earth Fault Loop Impedance',
                    serial: 'earth_fault_serial' as const,
                    cal: 'earth_fault_calibration' as const,
                  },
                  {
                    label: 'RCD',
                    serial: 'rcd_serial' as const,
                    cal: 'rcd_calibration' as const,
                  },
                ].map((eq) => (
                  <div key={eq.label}>
                    <p className="text-xs font-medium text-gray-400 dark:text-gray-500 mb-2">
                      {eq.label}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input
                        placeholder="Serial Number"
                        value={form[eq.serial]}
                        onChange={(e) => updateField(eq.serial, e.target.value)}
                        className="text-sm"
                      />
                      <Input
                        placeholder="Calibration Date"
                        value={form[eq.cal]}
                        onChange={(e) => updateField(eq.cal, e.target.value)}
                        className="text-sm"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onClick={closeForm}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !form.name.trim()}
                className="bg-gradient-to-r from-blue-600 to-blue-500 text-white"
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Staff List */}
      {profiles.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500/10 to-green-500/10 flex items-center justify-center mb-4">
              <Users className="h-8 w-8 text-blue-400" />
            </div>
            <CardTitle className="mb-2 text-base">No Staff</CardTitle>
            <CardDescription className="text-center mb-4">
              Add a staff member to get started.
            </CardDescription>
            <Button
              onClick={openAddForm}
              className="bg-gradient-to-r from-blue-600 to-blue-500 text-white"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Staff Member
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {profiles.map((profile, index) => (
            <Card
              key={profile.id}
              className="hover:shadow-md transition-shadow cursor-pointer group"
              onClick={() => openEditForm(index)}
            >
              <CardContent className="flex items-center gap-4 py-4 px-5">
                {/* Avatar circle */}
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500/20 to-cyan-500/20 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-semibold text-blue-500">
                    {profile.name
                      .split(' ')
                      .map((n) => n[0])
                      .join('')
                      .toUpperCase()
                      .slice(0, 2)}
                  </span>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{profile.name}</div>
                  {profile.position && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {profile.position}
                    </div>
                  )}
                </div>

                {/* Default badge */}
                {index === 0 && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-blue-500/10 text-blue-500 border border-blue-500/20">
                    <Shield className="h-3 w-3" />
                    Default
                  </span>
                )}

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-gray-400 hover:text-blue-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditForm(index);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(index);
                    }}
                    disabled={saving}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <ChevronRight className="h-4 w-4 text-gray-300 dark:text-gray-600 flex-shrink-0" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
