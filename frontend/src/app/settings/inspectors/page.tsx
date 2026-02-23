"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Save, Loader2, Plus, Trash2, Upload, User as UserIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, User, InspectorProfile } from "@/lib/api";

function createEmptyProfile(): InspectorProfile {
  return {
    id: `inspector_${Date.now()}`,
    name: "",
    organisation: "",
    enrolment_number: "",
    position: "",
    signature_file: "",
  };
}

export default function InspectorsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [profiles, setProfiles] = useState<InspectorProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingSignature, setUploadingSignature] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeUploadId, setActiveUploadId] = useState<string | null>(null);

  useEffect(() => {
    const storedUser = localStorage.getItem("user");
    if (!storedUser) {
      router.push("/login");
      return;
    }

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);

    async function load() {
      try {
        const data = await api.getInspectorProfiles(userData.id);
        setProfiles(data.length > 0 ? data : [createEmptyProfile()]);
      } catch {
        // No profiles yet — start with empty
        setProfiles([createEmptyProfile()]);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [router]);

  const handleSave = async () => {
    if (!user) return;

    // Validate: at least one profile with a name
    const validProfiles = profiles.filter((p) => p.name.trim());
    if (validProfiles.length === 0) {
      toast.error("At least one inspector must have a name");
      return;
    }

    setSaving(true);
    try {
      await api.saveInspectorProfiles(user.id, validProfiles);
      toast.success("Inspector profiles saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save profiles"
      );
    } finally {
      setSaving(false);
    }
  };

  const updateProfile = (id: string, field: keyof InspectorProfile, value: string) => {
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  };

  const addProfile = () => {
    setProfiles((prev) => [...prev, createEmptyProfile()]);
  };

  const removeProfile = (id: string) => {
    if (profiles.length <= 1) {
      toast.error("You need at least one inspector profile");
      return;
    }
    setProfiles((prev) => prev.filter((p) => p.id !== id));
  };

  const handleSignatureUpload = async (profileId: string, file: File) => {
    if (!user) return;

    setUploadingSignature(profileId);
    try {
      const result = await api.uploadSignature(user.id, file);
      updateProfile(profileId, "signature_file", result.signature_file);
      toast.success("Signature uploaded");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to upload signature"
      );
    } finally {
      setUploadingSignature(null);
    }
  };

  const triggerFileInput = (profileId: string) => {
    setActiveUploadId(profileId);
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && activeUploadId) {
      handleSignatureUpload(activeUploadId, file);
    }
    // Reset input so the same file can be selected again
    e.target.value = "";
    setActiveUploadId(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inspector Profiles</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage inspector details that appear on certificates
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
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

      {/* Hidden file input for signature uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {profiles.map((profile, index) => (
        <Card key={profile.id}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <UserIcon className="h-4 w-4" />
                Inspector {index + 1}
              </CardTitle>
              {profiles.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeProfile(profile.id)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor={`name-${profile.id}`}>
                  Full Name <span className="text-red-500">*</span>
                </Label>
                <Input
                  id={`name-${profile.id}`}
                  value={profile.name}
                  onChange={(e) => updateProfile(profile.id, "name", e.target.value)}
                  placeholder="e.g., John Smith"
                />
              </div>
              <div>
                <Label htmlFor={`position-${profile.id}`}>Position / Title</Label>
                <Input
                  id={`position-${profile.id}`}
                  value={profile.position || ""}
                  onChange={(e) => updateProfile(profile.id, "position", e.target.value)}
                  placeholder="e.g., Qualified Supervisor"
                />
              </div>
              <div>
                <Label htmlFor={`org-${profile.id}`}>Organisation</Label>
                <Input
                  id={`org-${profile.id}`}
                  value={profile.organisation || ""}
                  onChange={(e) => updateProfile(profile.id, "organisation", e.target.value)}
                  placeholder="e.g., NICEIC, NAPIT"
                />
              </div>
              <div>
                <Label htmlFor={`enrolment-${profile.id}`}>Enrolment Number</Label>
                <Input
                  id={`enrolment-${profile.id}`}
                  value={profile.enrolment_number || ""}
                  onChange={(e) => updateProfile(profile.id, "enrolment_number", e.target.value)}
                  placeholder="e.g., 12345"
                />
              </div>
            </div>

            {/* Signature upload */}
            <div>
              <Label>Signature</Label>
              <div className="flex items-center gap-3 mt-1">
                {profile.signature_file ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-green-700 bg-green-50 px-2 py-1 rounded">
                      Uploaded
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => triggerFileInput(profile.id)}
                      disabled={uploadingSignature === profile.id}
                    >
                      Replace
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => triggerFileInput(profile.id)}
                    disabled={uploadingSignature === profile.id}
                  >
                    {uploadingSignature === profile.id ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        Upload Signature
                      </>
                    )}
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">
                  PNG or JPG, transparent background recommended
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      <Button variant="outline" onClick={addProfile} className="w-full">
        <Plus className="h-4 w-4 mr-2" />
        Add Another Inspector
      </Button>
    </div>
  );
}
