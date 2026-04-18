'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useJobContext } from '../layout';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import type { InspectorProfile } from '@/lib/types';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, X, Upload, User, PenLine } from 'lucide-react';
import { cn } from '@/lib/utils';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function InspectorPage() {
  const { job, updateJob, user } = useJobContext();
  const [profiles, setProfiles] = useState<InspectorProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(job.inspector_id || '');

  // Inline form state
  const [showForm, setShowForm] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [formName, setFormName] = useState('');
  const [formPosition, setFormPosition] = useState('');
  const [formOrganisation, setFormOrganisation] = useState('');
  const [formEnrolment, setFormEnrolment] = useState('');

  // Signature upload
  const [uploadingSignature, setUploadingSignature] = useState(false);
  const signatureInputRef = useRef<HTMLInputElement>(null);

  // Signature drawing pad
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    async function loadProfiles() {
      if (!user) return;
      try {
        const data = await api.getInspectorProfiles(user.id);
        setProfiles(data);
        if (job.inspector_id && data.some((p) => p.id === job.inspector_id)) {
          setSelectedId(job.inspector_id);
        } else if (data.length > 0) {
          const defaultProfile = data.find((p) => p.id === 'default') || data[0];
          setSelectedId(defaultProfile.id);
        }
      } catch (error) {
        console.error('Failed to load inspector profiles:', error);
        toast.error('Failed to load inspector profiles');
      } finally {
        setLoading(false);
      }
    }
    loadProfiles();
  }, [user, job.inspector_id]);

  const handleSelectInspector = (inspectorId: string) => {
    setSelectedId(inspectorId);
    updateJob({ inspector_id: inspectorId });
    toast.success('Inspector selected');
  };

  const selectedProfile = profiles.find((p) => p.id === selectedId);

  const openAddForm = () => {
    setFormName('');
    setFormPosition('');
    setFormOrganisation('');
    setFormEnrolment('');
    setEditingIndex(null);
    setShowForm(true);
  };

  const openEditForm = (index: number) => {
    const p = profiles[index];
    setFormName(p.name || '');
    setFormPosition(p.position || '');
    setFormOrganisation(p.organisation || '');
    setFormEnrolment(p.enrolment_number || '');
    setEditingIndex(index);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingIndex(null);
  };

  const handleSave = async () => {
    if (!user || !formName.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      const updated = [...profiles];
      const profile: InspectorProfile = {
        id: editingIndex !== null ? profiles[editingIndex].id : crypto.randomUUID(),
        name: formName.trim(),
        position: formPosition.trim() || undefined,
        organisation: formOrganisation.trim() || undefined,
        enrolment_number: formEnrolment.trim() || undefined,
        signature_file: editingIndex !== null ? profiles[editingIndex].signature_file : undefined,
      };

      if (editingIndex !== null) {
        updated[editingIndex] = profile;
      } else {
        updated.push(profile);
      }

      await api.saveInspectorProfiles(user.id, updated);
      setProfiles(updated);

      // Auto-select if this is the first profile or if we just added a new one
      if (updated.length === 1 || editingIndex === null) {
        setSelectedId(profile.id);
        updateJob({ inspector_id: profile.id });
      }

      closeForm();
      toast.success(editingIndex !== null ? 'Inspector updated' : 'Inspector added');
    } catch (error) {
      console.error('Failed to save inspector:', error);
      toast.error('Failed to save inspector');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (index: number) => {
    if (!user) return;
    const name = profiles[index].name;
    if (!window.confirm(`Delete inspector "${name}"?`)) return;
    setSaving(true);
    try {
      const updated = profiles.filter((_, i) => i !== index);
      await api.saveInspectorProfiles(user.id, updated);
      setProfiles(updated);
      if (profiles[index].id === selectedId && updated.length > 0) {
        setSelectedId(updated[0].id);
        updateJob({ inspector_id: updated[0].id });
      } else if (updated.length === 0) {
        setSelectedId('');
        updateJob({ inspector_id: '' });
      }
      toast.success(`"${name}" deleted`);
    } catch (error) {
      console.error('Failed to delete inspector:', error);
      toast.error('Failed to delete inspector');
    } finally {
      setSaving(false);
    }
  };

  // Signature file upload
  const handleSignatureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !selectedProfile) return;
    setUploadingSignature(true);
    try {
      const result = await api.uploadSignature(user.id, file);
      // Update the selected profile's signature_file
      const updated = profiles.map((p) =>
        p.id === selectedProfile.id ? { ...p, signature_file: result.signature_file } : p
      );
      setProfiles(updated);
      await api.saveInspectorProfiles(user.id, updated);
      toast.success('Signature uploaded');
    } catch (error) {
      console.error('Signature upload failed:', error);
      toast.error('Failed to upload signature');
    } finally {
      setUploadingSignature(false);
      e.target.value = '';
    }
  };

  // Signature drawing pad handlers
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Set canvas size to match display size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Fill white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
  }, []);

  useEffect(() => {
    if (showSignaturePad) {
      // Small delay so canvas is mounted
      setTimeout(initCanvas, 50);
    }
  }, [showSignaturePad, initCanvas]);

  const getCanvasPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDraw = (e: React.MouseEvent | React.TouchEvent) => {
    isDrawingRef.current = true;
    lastPosRef.current = getCanvasPos(e);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const pos = getCanvasPos(e);
    ctx.beginPath();
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPosRef.current = pos;
  };

  const endDraw = () => {
    isDrawingRef.current = false;
  };

  const clearCanvas = () => {
    initCanvas();
  };

  const saveSignaturePad = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !user || !selectedProfile) return;
    setUploadingSignature(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Failed to capture signature');
      const file = new File([blob], 'signature.png', { type: 'image/png' });
      const result = await api.uploadSignature(user.id, file);
      const updated = profiles.map((p) =>
        p.id === selectedProfile.id ? { ...p, signature_file: result.signature_file } : p
      );
      setProfiles(updated);
      await api.saveInspectorProfiles(user.id, updated);
      setShowSignaturePad(false);
      toast.success('Signature saved');
    } catch (error) {
      console.error('Signature save failed:', error);
      toast.error('Failed to save signature');
    } finally {
      setUploadingSignature(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Inspector Profile</h2>
        <Button size="sm" onClick={openAddForm}>
          <Plus className="h-4 w-4 mr-1" />
          Add Inspector
        </Button>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <Card className="border-blue-500/30">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {editingIndex !== null ? 'Edit Inspector' : 'Add Inspector'}
              </CardTitle>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={closeForm}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="insp-name">Full Name *</Label>
                <Input
                  id="insp-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. John Smith"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="insp-position">Position</Label>
                <Input
                  id="insp-position"
                  value={formPosition}
                  onChange={(e) => setFormPosition(e.target.value)}
                  placeholder="e.g. Senior Electrician"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="insp-org">Organisation</Label>
                <Input
                  id="insp-org"
                  value={formOrganisation}
                  onChange={(e) => setFormOrganisation(e.target.value)}
                  placeholder="e.g. Beckley Electrical"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="insp-enrolment">Enrolment Number</Label>
                <Input
                  id="insp-enrolment"
                  value={formEnrolment}
                  onChange={(e) => setFormEnrolment(e.target.value)}
                  placeholder="e.g. ECS123456"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <Button variant="outline" onClick={closeForm}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving || !formName.trim()}>
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

      {/* Inspector Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Select Inspector</CardTitle>
        </CardHeader>
        <CardContent>
          {profiles.length === 0 ? (
            <p className="text-sm text-gray-500">
              No inspector profiles yet. Click &quot;Add Inspector&quot; above to create one.
            </p>
          ) : (
            <div className="space-y-2">
              {profiles.map((profile, index) => (
                <div
                  key={profile.id}
                  onClick={() => handleSelectInspector(profile.id)}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors group',
                    profile.id === selectedId
                      ? 'border-blue-500/50 bg-blue-500/10'
                      : 'border-white/[0.08] hover:border-white/20 hover:bg-white/[0.04]'
                  )}
                >
                  {/* Avatar */}
                  <div
                    className={cn(
                      'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0',
                      profile.id === selectedId
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-white/[0.06] text-gray-400'
                    )}
                  >
                    <User className="h-4 w-4" />
                  </div>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{profile.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[profile.position, profile.organisation, profile.enrolment_number]
                        .filter(Boolean)
                        .join(' · ') || 'No details'}
                    </div>
                  </div>
                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
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
                      className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(index);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {/* Selected indicator */}
                  {profile.id === selectedId && (
                    <div className="h-2 w-2 rounded-full bg-blue-500 flex-shrink-0" />
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Selected Inspector Details + Signature */}
      {selectedProfile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inspector Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="font-medium text-muted-foreground">Name</dt>
                <dd>{selectedProfile.name}</dd>
              </div>
              {selectedProfile.organisation && (
                <div>
                  <dt className="font-medium text-muted-foreground">Organisation</dt>
                  <dd>{selectedProfile.organisation}</dd>
                </div>
              )}
              {selectedProfile.position && (
                <div>
                  <dt className="font-medium text-muted-foreground">Position</dt>
                  <dd>{selectedProfile.position}</dd>
                </div>
              )}
              {selectedProfile.enrolment_number && (
                <div>
                  <dt className="font-medium text-muted-foreground">Enrolment Number</dt>
                  <dd>{selectedProfile.enrolment_number}</dd>
                </div>
              )}
            </dl>

            {/* Signature Section */}
            <div className="border-t border-white/[0.08] pt-4">
              <Label className="text-sm font-medium">Signature</Label>
              {selectedProfile.signature_file ? (
                <div className="mt-2 space-y-3">
                  <div className="border border-white/[0.08] rounded-lg p-3 bg-white inline-block">
                    <img
                      src={`${API_BASE_URL}/api/inspector-profiles/signature/${selectedProfile.signature_file}`}
                      alt="Inspector signature"
                      className="max-h-20 max-w-[300px] object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => signatureInputRef.current?.click()}
                      disabled={uploadingSignature}
                    >
                      <Upload className="h-3.5 w-3.5 mr-1" />
                      Replace
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowSignaturePad(true)}
                      disabled={uploadingSignature}
                    >
                      <PenLine className="h-3.5 w-3.5 mr-1" />
                      Draw New
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => signatureInputRef.current?.click()}
                    disabled={uploadingSignature}
                  >
                    {uploadingSignature ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5 mr-1" />
                    )}
                    Upload Signature
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowSignaturePad(true)}>
                    <PenLine className="h-3.5 w-3.5 mr-1" />
                    Draw Signature
                  </Button>
                </div>
              )}
              <input
                ref={signatureInputRef}
                type="file"
                accept="image/*"
                onChange={handleSignatureUpload}
                className="hidden"
              />
            </div>

            {/* Signature Drawing Pad */}
            {showSignaturePad && (
              <div className="border border-white/[0.08] rounded-lg p-4 space-y-3">
                <Label className="text-sm font-medium">Draw Your Signature</Label>
                <div className="border border-white/20 rounded-lg overflow-hidden bg-white">
                  <canvas
                    ref={canvasRef}
                    className="w-full h-32 cursor-crosshair touch-none"
                    onMouseDown={startDraw}
                    onMouseMove={draw}
                    onMouseUp={endDraw}
                    onMouseLeave={endDraw}
                    onTouchStart={startDraw}
                    onTouchMove={draw}
                    onTouchEnd={endDraw}
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setShowSignaturePad(false)}>
                    Cancel
                  </Button>
                  <Button variant="outline" size="sm" onClick={clearCanvas}>
                    Clear
                  </Button>
                  <Button size="sm" onClick={saveSignaturePad} disabled={uploadingSignature}>
                    {uploadingSignature ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : null}
                    Save Signature
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
