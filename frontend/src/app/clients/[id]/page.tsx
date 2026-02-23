"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Loader2, Plus, MapPin, FileText,
  Phone, Mail, Building2, Calendar, Home,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  api, User, ClientDetail, CreatePropertyData, PropertyWithJobs,
} from "@/lib/api";

export default function ClientDetailPage() {
  const params = useParams();
  const router = useRouter();
  const clientId = params.id as string;

  const [user, setUser] = useState<User | null>(null);
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Editable fields
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [notes, setNotes] = useState("");

  // Add property form
  const [showAddProperty, setShowAddProperty] = useState(false);
  const [newProperty, setNewProperty] = useState<CreatePropertyData>({
    address: "",
    postcode: "",
    property_type: "Residential",
    notes: "",
  });
  const [savingProperty, setSavingProperty] = useState(false);

  useEffect(() => {
    const storedUser = localStorage.getItem("user");
    if (!storedUser) {
      router.push("/login");
      return;
    }

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);

    async function loadClient() {
      try {
        const data = await api.getClient(userData.id, clientId);
        setClient(data);
        setName(data.name);
        setEmail(data.email || "");
        setPhone(data.phone || "");
        setCompany(data.company || "");
        setNotes(data.notes || "");
      } catch (error) {
        console.error("Failed to load client:", error);
        toast.error("Failed to load client");
        router.push("/clients");
      } finally {
        setLoading(false);
      }
    }

    loadClient();
  }, [clientId, router]);

  const handleSave = async () => {
    if (!user || !name.trim()) {
      toast.error("Client name is required");
      return;
    }

    setSaving(true);
    try {
      await api.updateClient(user.id, clientId, {
        name: name.trim(),
        email: email || undefined,
        phone: phone || undefined,
        company: company || undefined,
        notes: notes || undefined,
      });
      setIsDirty(false);
      toast.success("Client updated");
    } catch (error) {
      console.error("Failed to update client:", error);
      toast.error("Failed to update client");
    } finally {
      setSaving(false);
    }
  };

  const handleAddProperty = async () => {
    if (!user || !newProperty.address.trim()) {
      toast.error("Property address is required");
      return;
    }

    setSavingProperty(true);
    try {
      const created = await api.createProperty(user.id, {
        ...newProperty,
        client_id: clientId,
      });
      // Add to local state
      if (client) {
        const propWithJobs: PropertyWithJobs = { ...created, jobs: [] };
        setClient({
          ...client,
          properties: [...client.properties, propWithJobs],
        });
      }
      setNewProperty({ address: "", postcode: "", property_type: "Residential", notes: "" });
      setShowAddProperty(false);
      toast.success(`Property added: ${created.address}`);
    } catch (error) {
      console.error("Failed to create property:", error);
      toast.error("Failed to create property");
    } finally {
      setSavingProperty(false);
    }
  };

  const markDirty = () => {
    if (!isDirty) setIsDirty(true);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!client) return null;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/clients">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="font-semibold truncate max-w-[200px] sm:max-w-none">
                {client.name}
              </h1>
              {client.company && (
                <p className="text-xs text-muted-foreground">{client.company}</p>
              )}
            </div>
          </div>
          <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
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
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Client Details Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Client Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="client-name">Name *</Label>
                <Input
                  id="client-name"
                  value={name}
                  onChange={(e) => { setName(e.target.value); markDirty(); }}
                  placeholder="Client full name"
                />
              </div>
              <div>
                <Label htmlFor="client-company">Company</Label>
                <Input
                  id="client-company"
                  value={company}
                  onChange={(e) => { setCompany(e.target.value); markDirty(); }}
                  placeholder="Company name"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="client-email">Email</Label>
                <Input
                  id="client-email"
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); markDirty(); }}
                  placeholder="client@example.com"
                />
              </div>
              <div>
                <Label htmlFor="client-phone">Phone</Label>
                <Input
                  id="client-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); markDirty(); }}
                  placeholder="07700 900000"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="client-notes">Notes</Label>
              <Textarea
                id="client-notes"
                value={notes}
                onChange={(e) => { setNotes(e.target.value); markDirty(); }}
                placeholder="Any notes about this client..."
                rows={3}
              />
            </div>
          </CardContent>
        </Card>

        {/* Properties Section */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Home className="h-5 w-5" />
              Properties ({client.properties.length})
            </h2>
            <Button size="sm" variant="outline" onClick={() => setShowAddProperty(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Property
            </Button>
          </div>

          {/* Add Property Form */}
          {showAddProperty && (
            <Card className="mb-4 border-primary/30 shadow-md">
              <CardHeader>
                <CardTitle className="text-base">Add Property</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="prop-address">Address *</Label>
                    <Input
                      id="prop-address"
                      value={newProperty.address}
                      onChange={(e) => setNewProperty((p) => ({ ...p, address: e.target.value }))}
                      placeholder="Full property address"
                      autoFocus
                    />
                  </div>
                  <div>
                    <Label htmlFor="prop-postcode">Postcode</Label>
                    <Input
                      id="prop-postcode"
                      value={newProperty.postcode || ""}
                      onChange={(e) => setNewProperty((p) => ({ ...p, postcode: e.target.value }))}
                      placeholder="e.g., SW1A 1AA"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="prop-type">Property Type</Label>
                    <select
                      id="prop-type"
                      value={newProperty.property_type || "Residential"}
                      onChange={(e) => setNewProperty((p) => ({ ...p, property_type: e.target.value }))}
                      className="w-full h-10 rounded-md border border-input px-3"
                    >
                      <option value="Residential">Residential</option>
                      <option value="Commercial">Commercial</option>
                      <option value="Industrial">Industrial</option>
                      <option value="Agricultural">Agricultural</option>
                      <option value="HMO">HMO</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </div>
                <div>
                  <Label htmlFor="prop-notes">Notes</Label>
                  <Textarea
                    id="prop-notes"
                    value={newProperty.notes || ""}
                    onChange={(e) => setNewProperty((p) => ({ ...p, notes: e.target.value }))}
                    placeholder="Access instructions, key holder info, etc."
                    rows={2}
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" onClick={() => setShowAddProperty(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleAddProperty}
                    disabled={savingProperty || !newProperty.address.trim()}
                  >
                    {savingProperty ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4 mr-2" />
                        Add Property
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Properties List */}
          {client.properties.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No properties linked to this client yet.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {client.properties.map((property) => (
                <Card key={property.id}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="font-medium">{property.address}</span>
                        </div>
                        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                          {property.postcode && (
                            <span>{property.postcode}</span>
                          )}
                          {property.property_type && (
                            <span className="px-2 py-0.5 rounded bg-slate-100 text-xs">
                              {property.property_type}
                            </span>
                          )}
                        </div>
                        {property.notes && (
                          <p className="text-sm text-muted-foreground mt-1">{property.notes}</p>
                        )}
                      </div>
                    </div>

                    {/* Certificate History for this property */}
                    {property.jobs && property.jobs.length > 0 && (
                      <div className="mt-3 pt-3 border-t">
                        <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2 flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          Certificate History
                        </h4>
                        <div className="space-y-1">
                          {property.jobs.map((job) => (
                            <Link
                              key={job.id}
                              href={`/job/${job.id}`}
                              className="flex items-center justify-between p-2 rounded hover:bg-slate-50 transition-colors text-sm"
                            >
                              <div className="flex items-center gap-2">
                                <Calendar className="h-3 w-3 text-muted-foreground" />
                                <span>
                                  {new Date(job.created_at).toLocaleDateString()} at{" "}
                                  {new Date(job.created_at).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                {job.certificate_type && (
                                  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                                    {job.certificate_type}
                                  </span>
                                )}
                                <span
                                  className={`text-xs px-1.5 py-0.5 rounded ${
                                    job.status === "done"
                                      ? "bg-green-50 text-green-700"
                                      : job.status === "failed"
                                      ? "bg-red-50 text-red-700"
                                      : "bg-yellow-50 text-yellow-700"
                                  }`}
                                >
                                  {job.status}
                                </span>
                              </div>
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
