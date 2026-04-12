'use client';

import { useEffect, useState, useCallback } from 'react';
import { useJob } from '../layout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InstallationDetails, Client, api } from '@/lib/api';
import { PREMISES_DESCRIPTIONS, INSPECTION_INTERVALS } from '@/lib/constants';
import { toast } from 'sonner';
import { UserPlus, Search, Users } from 'lucide-react';

// Calculate next inspection due date from inspection date + years
function calcNextInspectionDue(
  dateOfInspection: string | undefined,
  years: number | undefined
): string {
  if (!dateOfInspection || !years) return '';
  try {
    const d = new Date(dateOfInspection);
    if (isNaN(d.getTime())) return '';
    d.setFullYear(d.getFullYear() + years);
    return d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

export default function InstallationPage() {
  const { job, updateJob, user, certificateType } = useJob();
  const isEIC = certificateType === 'EIC';
  const details = job.installation_details || {
    client_name: '',
    address: job.address || '',
    premises_description: 'Residential',
    installation_records_available: false,
    evidence_of_additions_alterations: false,
    next_inspection_years: 5,
  };

  const [clients, setClients] = useState<Client[]>([]);
  const [clientSearch, setClientSearch] = useState('');
  const [showClientPicker, setShowClientPicker] = useState(false);
  const [savingAsClient, setSavingAsClient] = useState(false);

  // Load clients list
  useEffect(() => {
    if (!user) return;
    api
      .getClients(user.id)
      .then(setClients)
      .catch(() => {});
  }, [user]);

  const filteredClients = clientSearch.trim()
    ? clients.filter(
        (c) =>
          c.name.toLowerCase().includes(clientSearch.toLowerCase()) ||
          (c.company && c.company.toLowerCase().includes(clientSearch.toLowerCase()))
      )
    : clients;

  const handleSelectClient = useCallback(
    (client: Client) => {
      updateJob({
        installation_details: {
          ...details,
          client_name: client.name,
        },
      });
      setShowClientPicker(false);
      setClientSearch('');
      toast.success(`Client "${client.name}" selected`);
    },
    [details, updateJob]
  );

  const handleSaveAsNewClient = async () => {
    if (!user) return;
    const clientName = details.client_name;
    if (!clientName || !clientName.trim()) {
      toast.error('Enter a client name first');
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
          property_type: details.premises_description || 'Residential',
        });
      }

      toast.success(`Client "${created.name}" saved to CRM`);
    } catch (error) {
      console.error('Failed to save client:', error);
      toast.error('Failed to save client');
    } finally {
      setSavingAsClient(false);
    }
  };

  const updateField = <K extends keyof InstallationDetails>(
    field: K,
    value: InstallationDetails[K]
  ) => {
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
                variant={showClientPicker ? 'default' : 'outline'}
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
                  {savingAsClient ? 'Saving...' : 'Save as New Client'}
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
                    className="pl-10 bg-card"
                    autoFocus
                  />
                </div>
                <div className="max-h-48 overflow-y-auto rounded border bg-card divide-y">
                  {filteredClients.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground text-center">
                      No clients found
                    </div>
                  ) : (
                    filteredClients.map((client) => (
                      <button
                        key={client.id}
                        className="w-full text-left px-3 py-2 hover:bg-accent transition-colors"
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

      {/* Client Details — mirrors iOS "Client Details" section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Client Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="client_name">Client Name</Label>
              <Input
                id="client_name"
                value={details.client_name || ''}
                onChange={(e) => updateField('client_name', e.target.value)}
                placeholder="Property owner / client name"
              />
            </div>
            <div>
              <Label htmlFor="client_phone">Phone</Label>
              <Input
                id="client_phone"
                type="tel"
                value={details.client_phone || ''}
                onChange={(e) => updateField('client_phone', e.target.value)}
                placeholder="Client phone number"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="client_email">Email</Label>
            <Input
              id="client_email"
              type="email"
              value={details.client_email || ''}
              onChange={(e) => updateField('client_email', e.target.value)}
              placeholder="Client email address"
            />
          </div>
          {/* Client address — mirrors iOS ClientDetails address fields */}
          <div>
            <Label htmlFor="client_address">Client Address</Label>
            <Input
              id="client_address"
              value={details.client_address || ''}
              onChange={(e) => updateField('client_address', e.target.value)}
              placeholder="Client billing / correspondence address"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="client_town">Client Town/City</Label>
              <Input
                id="client_town"
                value={details.client_town || ''}
                onChange={(e) => updateField('client_town', e.target.value)}
                placeholder="Town or city"
              />
            </div>
            <div>
              <Label htmlFor="client_county">Client County</Label>
              <Input
                id="client_county"
                value={details.client_county || ''}
                onChange={(e) => updateField('client_county', e.target.value)}
                placeholder="County"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="client_postcode">Client Postcode</Label>
            <Input
              id="client_postcode"
              value={details.client_postcode || ''}
              onChange={(e) => updateField('client_postcode', e.target.value)}
              placeholder="e.g., SW1A 1AA"
            />
          </div>
        </CardContent>
      </Card>

      {/* Installation Address — mirrors iOS "Installation Address" section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Installation Address</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="address">Address</Label>
            <Textarea
              id="address"
              value={details.address || ''}
              onChange={(e) => updateField('address', e.target.value)}
              placeholder="Full address of the installation"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="town">Town/City</Label>
              <Input
                id="town"
                value={details.town || ''}
                onChange={(e) => updateField('town', e.target.value)}
                placeholder="Town or city"
              />
            </div>
            <div>
              <Label htmlFor="county">County</Label>
              <Input
                id="county"
                value={details.county || ''}
                onChange={(e) => updateField('county', e.target.value)}
                placeholder="County"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="postcode">Postcode</Label>
              <Input
                id="postcode"
                value={details.postcode || ''}
                onChange={(e) => updateField('postcode', e.target.value)}
                placeholder="e.g., SW1A 1AA"
              />
            </div>
            <div>
              <Label htmlFor="occupier_name">Occupier Name</Label>
              <Input
                id="occupier_name"
                value={details.occupier_name || ''}
                onChange={(e) => updateField('occupier_name', e.target.value)}
                placeholder="Name of occupier (if different)"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Inspection Dates — mirrors iOS "Inspection Dates" section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inspection Dates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="date_of_inspection">Date of Inspection</Label>
              <Input
                id="date_of_inspection"
                type="date"
                value={details.date_of_inspection || ''}
                onChange={(e) => {
                  const newDate = e.target.value;
                  const nextDue = calcNextInspectionDue(newDate, details.next_inspection_years);
                  updateJob({
                    installation_details: {
                      ...details,
                      date_of_inspection: newDate,
                      next_inspection_due: nextDue,
                    },
                  });
                }}
              />
            </div>
            {!isEIC && (
              <div>
                <Label htmlFor="date_of_previous_inspection">Date of Previous Inspection</Label>
                <Input
                  id="date_of_previous_inspection"
                  type="date"
                  value={details.date_of_previous_inspection || ''}
                  onChange={(e) => updateField('date_of_previous_inspection', e.target.value)}
                  placeholder="N/A if none"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="next_inspection">Next Inspection (Years)</Label>
              <select
                id="next_inspection"
                value={details.next_inspection_years || 5}
                onChange={(e) => {
                  const years = parseInt(e.target.value);
                  const nextDue = calcNextInspectionDue(details.date_of_inspection, years);
                  updateJob({
                    installation_details: {
                      ...details,
                      next_inspection_years: years,
                      next_inspection_due: nextDue,
                    },
                  });
                }}
                className="w-full h-10 rounded-md border border-input px-3"
              >
                {INSPECTION_INTERVALS.map((years) => (
                  <option key={years} value={years}>
                    {years} year{years > 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="next_inspection_due">Next Inspection Due</Label>
              <Input
                id="next_inspection_due"
                type="date"
                value={details.next_inspection_due || ''}
                onChange={(e) => updateField('next_inspection_due', e.target.value)}
                placeholder="Calculated automatically"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Premises — mirrors iOS "Premises" section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Premises</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="premises_description">Description of Premises</Label>
            <select
              id="premises_description"
              value={details.premises_description || 'Residential'}
              onChange={(e) => updateField('premises_description', e.target.value)}
              className="w-full h-10 rounded-md border border-input px-3"
            >
              {PREMISES_DESCRIPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          {/* Installation records — EICR only, mirrors iOS toggle visibility */}
          {!isEIC && (
            <>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={details.installation_records_available || false}
                    onChange={(e) =>
                      updateField('installation_records_available', e.target.checked)
                    }
                    className="h-4 w-4 rounded border-border"
                  />
                  <span className="text-sm">Installation records available</span>
                </label>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={details.evidence_of_additions_alterations || false}
                    onChange={(e) =>
                      updateField('evidence_of_additions_alterations', e.target.checked)
                    }
                    className="h-4 w-4 rounded border-border"
                  />
                  <span className="text-sm">Evidence of additions/alterations</span>
                </label>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Report Details — EICR only, mirrors iOS Previous Inspection + Report Details + General Condition sections */}
      {!isEIC && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Report Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="reason_for_report">Reason for Report</Label>
                <select
                  id="reason_for_report"
                  value={details.reason_for_report || ''}
                  onChange={(e) => updateField('reason_for_report', e.target.value)}
                  className="w-full h-10 rounded-md border border-input px-3"
                >
                  <option value="">Select reason...</option>
                  <option>Periodic Inspection</option>
                  <option>Change of Occupancy</option>
                  <option>Installation Alteration</option>
                  <option>Remedial Work</option>
                  <option>Sale of Property</option>
                  <option>Insurance</option>
                  <option>New Installation</option>
                </select>
              </div>
              <div>
                <Label htmlFor="general_condition">General Condition</Label>
                <select
                  id="general_condition"
                  value={details.general_condition || ''}
                  onChange={(e) => updateField('general_condition', e.target.value)}
                  className="w-full h-10 rounded-md border border-input px-3"
                >
                  <option value="">Select condition...</option>
                  <option>Satisfactory</option>
                  <option>Unsatisfactory</option>
                  <option>N/A</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="previous_certificate_number">Previous Certificate Number</Label>
                <Input
                  id="previous_certificate_number"
                  value={details.previous_certificate_number || ''}
                  onChange={(e) => updateField('previous_certificate_number', e.target.value)}
                  placeholder="Previous cert. reference"
                />
              </div>
              <div>
                <Label htmlFor="estimated_age_of_installation">Estimated Age (years)</Label>
                <Input
                  id="estimated_age_of_installation"
                  value={details.estimated_age_of_installation || ''}
                  onChange={(e) => updateField('estimated_age_of_installation', e.target.value)}
                  placeholder="e.g., 20"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Extent & Limitations — EICR only, mirrors iOS "Extent & Limitations" section */}
      {!isEIC && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extent &amp; Limitations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="extent">Extent of Installation Covered</Label>
              <Textarea
                id="extent"
                value={details.extent || ''}
                onChange={(e) => updateField('extent', e.target.value)}
                placeholder="Describe the extent of the installation covered by this report"
                rows={3}
              />
            </div>
            <div>
              <Label htmlFor="agreed_limitations">Agreed Limitations</Label>
              <Textarea
                id="agreed_limitations"
                value={details.agreed_limitations || ''}
                onChange={(e) => updateField('agreed_limitations', e.target.value)}
                placeholder="Any agreed limitations to the inspection"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="agreed_with">Limitations Agreed With</Label>
                <Input
                  id="agreed_with"
                  value={details.agreed_with || ''}
                  onChange={(e) => updateField('agreed_with', e.target.value)}
                  placeholder="Name of person"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="operational_limitations">Operational Limitations</Label>
              <Textarea
                id="operational_limitations"
                value={details.operational_limitations || ''}
                onChange={(e) => updateField('operational_limitations', e.target.value)}
                placeholder="Any operational limitations encountered during inspection"
                rows={2}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
