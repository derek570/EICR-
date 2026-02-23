"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, InspectorProfile } from "@/lib/api";
import { toast } from "sonner";
import { Loader2, X, Plus, Trash2, Upload, User } from "lucide-react";

interface InspectorModalProps {
  userId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function InspectorModal({ userId, isOpen, onClose }: InspectorModalProps) {
  const [profiles, setProfiles] = useState<InspectorProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingProfile, setEditingProfile] = useState<InspectorProfile | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // New profile form state
  const [formData, setFormData] = useState({
    name: "",
    position: "",
    organisation: "",
    enrolment_number: "",
  });

  useEffect(() => {
    if (isOpen) {
      loadProfiles();
    }
  }, [isOpen, userId]);

  const loadProfiles = async () => {
    setLoading(true);
    try {
      const data = await api.getInspectorProfiles(userId);
      setProfiles(data);
    } catch (error) {
      console.error("Failed to load profiles:", error);
      toast.error("Failed to load inspector profiles");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfiles = async (updatedProfiles: InspectorProfile[]) => {
    setSaving(true);
    try {
      await api.saveInspectorProfiles(userId, updatedProfiles);
      setProfiles(updatedProfiles);
      toast.success("Inspector profiles saved");
    } catch (error) {
      console.error("Failed to save profiles:", error);
      toast.error("Failed to save profiles");
    } finally {
      setSaving(false);
    }
  };

  const handleAddProfile = () => {
    if (!formData.name.trim()) {
      toast.error("Name is required");
      return;
    }

    const newProfile: InspectorProfile = {
      id: `inspector_${Date.now()}`,
      name: formData.name.trim(),
      position: formData.position.trim() || undefined,
      organisation: formData.organisation.trim() || undefined,
      enrolment_number: formData.enrolment_number.trim() || undefined,
    };

    const updatedProfiles = [...profiles, newProfile];
    handleSaveProfiles(updatedProfiles);

    // Reset form
    setFormData({ name: "", position: "", organisation: "", enrolment_number: "" });
    setIsAddingNew(false);
  };

  const handleUpdateProfile = () => {
    if (!editingProfile || !formData.name.trim()) {
      toast.error("Name is required");
      return;
    }

    const updatedProfiles = profiles.map(p =>
      p.id === editingProfile.id
        ? {
            ...p,
            name: formData.name.trim(),
            position: formData.position.trim() || undefined,
            organisation: formData.organisation.trim() || undefined,
            enrolment_number: formData.enrolment_number.trim() || undefined,
          }
        : p
    );

    handleSaveProfiles(updatedProfiles);
    setEditingProfile(null);
    setFormData({ name: "", position: "", organisation: "", enrolment_number: "" });
  };

  const handleDeleteProfile = (profileId: string) => {
    const updatedProfiles = profiles.filter(p => p.id !== profileId);
    handleSaveProfiles(updatedProfiles);
  };

  const startEditing = (profile: InspectorProfile) => {
    setEditingProfile(profile);
    setFormData({
      name: profile.name,
      position: profile.position || "",
      organisation: profile.organisation || "",
      enrolment_number: profile.enrolment_number || "",
    });
    setIsAddingNew(false);
  };

  const startAddingNew = () => {
    setIsAddingNew(true);
    setEditingProfile(null);
    setFormData({ name: "", position: "", organisation: "", enrolment_number: "" });
  };

  const handleSignatureUpload = async (profileId: string, file: File) => {
    try {
      const result = await api.uploadSignature(userId, file);
      if (result.success) {
        const updatedProfiles = profiles.map(p =>
          p.id === profileId ? { ...p, signature_file: result.signature_file } : p
        );
        handleSaveProfiles(updatedProfiles);
        toast.success("Signature uploaded");
      }
    } catch (error) {
      console.error("Failed to upload signature:", error);
      toast.error("Failed to upload signature");
    }
  };

  const triggerSignatureUpload = (profileId: string) => {
    if (fileInputRef.current) {
      fileInputRef.current.dataset.profileId = profileId;
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const profileId = e.target.dataset.profileId;
    if (file && profileId) {
      handleSignatureUpload(profileId, file);
    }
    e.target.value = "";
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <User className="h-5 w-5" />
            Inspector Profiles
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 overflow-y-auto max-h-[calc(90vh-120px)]">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Existing Profiles */}
              {profiles.map((profile) => (
                <Card key={profile.id} className={editingProfile?.id === profile.id ? "ring-2 ring-primary" : ""}>
                  <CardHeader className="py-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{profile.name}</CardTitle>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => startEditing(profile)}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => triggerSignatureUpload(profile.id)}
                        >
                          <Upload className="h-4 w-4 mr-1" />
                          Signature
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteProfile(profile.id)}
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="py-2">
                    <dl className="grid grid-cols-2 gap-2 text-sm">
                      {profile.position && (
                        <div>
                          <dt className="text-muted-foreground">Position</dt>
                          <dd>{profile.position}</dd>
                        </div>
                      )}
                      {profile.organisation && (
                        <div>
                          <dt className="text-muted-foreground">Organisation</dt>
                          <dd>{profile.organisation}</dd>
                        </div>
                      )}
                      {profile.enrolment_number && (
                        <div>
                          <dt className="text-muted-foreground">Enrolment No.</dt>
                          <dd>{profile.enrolment_number}</dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-muted-foreground">Signature</dt>
                        <dd>{profile.signature_file ? "Uploaded" : "Not uploaded"}</dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>
              ))}

              {/* Add/Edit Form */}
              {(isAddingNew || editingProfile) && (
                <Card className="border-dashed">
                  <CardHeader className="py-3">
                    <CardTitle className="text-base">
                      {editingProfile ? "Edit Inspector" : "Add New Inspector"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="name">Name *</Label>
                        <Input
                          id="name"
                          value={formData.name}
                          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                          placeholder="Inspector name"
                        />
                      </div>
                      <div>
                        <Label htmlFor="position">Position</Label>
                        <Input
                          id="position"
                          value={formData.position}
                          onChange={(e) => setFormData({ ...formData, position: e.target.value })}
                          placeholder="e.g., Qualified Supervisor"
                        />
                      </div>
                      <div>
                        <Label htmlFor="organisation">Organisation</Label>
                        <Input
                          id="organisation"
                          value={formData.organisation}
                          onChange={(e) => setFormData({ ...formData, organisation: e.target.value })}
                          placeholder="Company name"
                        />
                      </div>
                      <div>
                        <Label htmlFor="enrolment_number">Enrolment Number</Label>
                        <Input
                          id="enrolment_number"
                          value={formData.enrolment_number}
                          onChange={(e) => setFormData({ ...formData, enrolment_number: e.target.value })}
                          placeholder="e.g., NICEIC/123456"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={editingProfile ? handleUpdateProfile : handleAddProfile}
                        disabled={saving}
                      >
                        {saving ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
                        ) : editingProfile ? (
                          "Update"
                        ) : (
                          "Add Inspector"
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setEditingProfile(null);
                          setIsAddingNew(false);
                          setFormData({ name: "", position: "", organisation: "", enrolment_number: "" });
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Add New Button */}
              {!isAddingNew && !editingProfile && (
                <Button variant="outline" className="w-full" onClick={startAddingNew}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add New Inspector
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Hidden file input for signature upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />

        <div className="flex justify-end p-4 border-t">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}
