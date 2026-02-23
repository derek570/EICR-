"use client";

import { useEffect, useState, useCallback } from "react";
import { useJob } from "../layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InstallationDetails, Client, api } from "@/lib/api";
import { PREMISES_DESCRIPTIONS, INSPECTION_INTERVALS } from "@/lib/constants";
import { toast } from "sonner";
import { UserPlus, Search, Users } from "lucide-react";

export default function InstallationPage() {
  const { job, updateJob, user } = useJob();
  const details = job.installation_details || {
    client_name: "",
    address: job.address || "",
    premises_description: "Residential",
    installation_records_available: false,
    evidence_of_additions_alterations: false,
    next_inspection_years: 5,
  };

  const [clients, setClients] = useState<Client[]>([]);
  const [clientSearch, setClientSearch] = useState("");
  const [showClientPicker, setShowClientPicker] = useState(false);
  const [savingAsClient, setSavingAsClient] = useState(false);

  // Load clients list
  useEffect(() => {
    if (!user) return;
    api.getClients(user.id).then(setClients).catch(() => {});
  }, [user]);

  const filteredClients = clientSearch.trim()
    ? clients.filter((c) =>
        c.name.toLowerCase().includes(clientSearch.toLowerCase()) ||
        (c.company && c.company.toLowerCase().includes(clientSearch.toLowerCase()))
      )
    : clients;

  const handleSelectClient = useCallback((client: Client) => {
    updateJob({
      installation_details: {
        ...details,
        client_name: client.name,
      },
    });
    setShowClientPicker(false);
    setClientSearch("");
    toast.success(`Client "${client.name}" selected`);
  }, [details, updateJob]);

  const handleSaveAsNewClient = async () => {
    if (!user) return;
    const clientName = details.client_name;
    if (!clientName || !clientName.trim()) {
      toast.error("Enter a client name first");
      return;
    }

    setSavingAsClient(true);
    try {
      const created = await api.createClient(user.id, {
        name: clientName.trim(),
      });
      setClients((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));

      // Also create a property record for this address
      const address = details.address || job.address;
      if (address && address.trim()) {
        await api.createProperty(user.id, {
          address: address.trim(),
          postcode: details.postcode || undefined,
          client_id: created.id,
          property_type: details.premises_description || "Residential",
        });
      }

      toast.success(`Client "${created.name}" saved to CRM`);
    } catch (error) {
      console.error("Failed to save client:", error);
      toast.error("Failed to save client");
    } finally {
      setSavingAsClient(false);
    }
  };

  const updateField = <K extends keyof InstallationDetails>(field: K, value: InstallationDetails[K]) => {
    updateJob({ installation_details: { ...details, [field]: value } });
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">Installation Details</h2>

      {/* Client Picker */}
      {clients.length > 0 && (
        <Card className="border-blue-100 bg-blue-50/30">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant={showClientPicker ? "default" : "outline"}
                size="sm"
                onClick={() => setShowClientPicker(!showClientPicker)}
              >
                <Users className="h-4 w-4 mr-2" />
                Select Client
              </Button>
              {details.client_name && details.client_name.trim() && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveAsNewClient}
                  disabled={savingAsClient}
                >
                  <UserPlus className="h-4 w-4 mr-2" />
                  {savingAsClient ? "Saving..." : "Save as New Client"}
                </Button>
              )}
            </div>

            {showClientPicker && (
              <div className="mt-3 space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search clients..."
                    value={clientSearch}
                    onChange={(e) => setClientSearch(e.target.value)}
                    className="pl-10 bg-white"
                    autoFocus
                  />
                </div>
                <div className="max-h-48 overflow-y-auto rounded border bg-white divide-y">
                  {filteredClients.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground text-center">
                      No clients found
                    </div>
                  ) : (
                    filteredClients.map((client) => (
                      <button
                        key={client.id}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors"
                        onClick={() => handleSelectClient(client)}
                      >
                        <div className="font-medium text-sm">{client.name}</div>
                        {client.company && (
                          <div className="text-xs text-muted-foreground">{client.company}</div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Client Information</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="client_name">Client Name</Label>
              <Input
                id="client_name"
                value={details.client_name || ""}
                onChange={(e) => updateField("client_name", e.target.value)}
                placeholder="Property owner / client name"
              />
            </div>
            <div>
              <Label htmlFor="postcode">Postcode</Label>
              <Input
                id="postcode"
                value={details.postcode || ""}
                onChange={(e) => updateField("postcode", e.target.value)}
                placeholder="e.g., SW1A 1AA"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="address">Installation Address</Label>
            <Textarea
              id="address"
              value={details.address || ""}
              onChange={(e) => updateField("address", e.target.value)}
              placeholder="Full address of the installation"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="town">Town/City</Label>
              <Input
                id="town"
                value={details.town || ""}
                onChange={(e) => updateField("town", e.target.value)}
                placeholder="Town or city"
              />
            </div>
            <div>
              <Label htmlFor="county">County</Label>
              <Input
                id="county"
                value={details.county || ""}
                onChange={(e) => updateField("county", e.target.value)}
                placeholder="County"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="premises_description">Description of Premises</Label>
              <select
                id="premises_description"
                value={details.premises_description || "Residential"}
                onChange={(e) => updateField("premises_description", e.target.value)}
                className="w-full h-10 rounded-md border border-input px-3"
              >
                {PREMISES_DESCRIPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="next_inspection">Recommended Interval (Years)</Label>
              <select
                id="next_inspection"
                value={details.next_inspection_years || 5}
                onChange={(e) => updateField("next_inspection_years", parseInt(e.target.value))}
                className="w-full h-10 rounded-md border border-input px-3"
              >
                {INSPECTION_INTERVALS.map((years) => (
                  <option key={years} value={years}>{years} year{years > 1 ? "s" : ""}</option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Installation Records</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={details.installation_records_available || false}
                onChange={(e) => updateField("installation_records_available", e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm">Installation records available</span>
            </label>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={details.evidence_of_additions_alterations || false}
                onChange={(e) => updateField("evidence_of_additions_alterations", e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm">Evidence of additions or alterations not recorded</span>
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Extent & Limitations</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="extent">Extent of Installation Covered</Label>
            <Textarea
              id="extent"
              value={details.extent || ""}
              onChange={(e) => updateField("extent", e.target.value)}
              placeholder="Describe the extent of the installation covered by this report"
              rows={3}
            />
          </div>
          <div>
            <Label htmlFor="agreed_limitations">Agreed Limitations</Label>
            <Textarea
              id="agreed_limitations"
              value={details.agreed_limitations || ""}
              onChange={(e) => updateField("agreed_limitations", e.target.value)}
              placeholder="Any agreed limitations to the inspection"
              rows={2}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="agreed_with">Limitations Agreed With</Label>
              <Input
                id="agreed_with"
                value={details.agreed_with || ""}
                onChange={(e) => updateField("agreed_with", e.target.value)}
                placeholder="Name of person"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="operational_limitations">Operational Limitations</Label>
            <Textarea
              id="operational_limitations"
              value={details.operational_limitations || ""}
              onChange={(e) => updateField("operational_limitations", e.target.value)}
              placeholder="Any operational limitations encountered during inspection"
              rows={2}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
