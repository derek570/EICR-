'use client';

import { useJobContext } from '../layout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { InstallationDetails } from '@/lib/types';
import { PREMISES_DESCRIPTIONS, INSPECTION_INTERVALS } from '@/lib/constants';

export default function InstallationPage() {
  const { job, updateJob } = useJobContext();
  const details: InstallationDetails = job.installation_details || {
    client_name: '',
    address: job.address || '',
    premises_description: 'Residential',
    installation_records_available: false,
    evidence_of_additions_alterations: false,
    next_inspection_years: 5,
  };

  const updateField = <K extends keyof InstallationDetails>(
    field: K,
    value: InstallationDetails[K]
  ) => {
    updateJob({ installation_details: { ...details, [field]: value } });
  };

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <h2 className="text-lg font-semibold">Installation Details</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Client Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="client_name">Client Name</Label>
              <Input
                id="client_name"
                value={details.client_name || ''}
                onChange={(e) => updateField('client_name', e.target.value)}
                placeholder="Property owner / client name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="postcode">Postcode</Label>
              <Input
                id="postcode"
                value={details.postcode || ''}
                onChange={(e) => updateField('postcode', e.target.value)}
                placeholder="e.g., SW1A 1AA"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="client_phone">Phone</Label>
              <Input
                id="client_phone"
                type="tel"
                value={details.client_phone || ''}
                onChange={(e) => updateField('client_phone', e.target.value)}
                placeholder="e.g., 07700 900123"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="client_email">Email</Label>
              <Input
                id="client_email"
                type="email"
                value={details.client_email || ''}
                onChange={(e) => updateField('client_email', e.target.value)}
                placeholder="e.g., client@example.com"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="address">Installation Address</Label>
            <Textarea
              id="address"
              value={details.address || ''}
              onChange={(e) => updateField('address', e.target.value)}
              placeholder="Full address of the installation"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="town">Town/City</Label>
              <Input
                id="town"
                value={details.town || ''}
                onChange={(e) => updateField('town', e.target.value)}
                placeholder="Town or city"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="county">County</Label>
              <Input
                id="county"
                value={details.county || ''}
                onChange={(e) => updateField('county', e.target.value)}
                placeholder="County"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="occupier_name">Occupier Name</Label>
              <Input
                id="occupier_name"
                value={details.occupier_name || ''}
                onChange={(e) => updateField('occupier_name', e.target.value)}
                placeholder="Name of occupier (if different from client)"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="premises_description">Description of Premises</Label>
              <select
                id="premises_description"
                value={details.premises_description || 'Residential'}
                onChange={(e) => updateField('premises_description', e.target.value)}
                className="w-full h-10 rounded-md border border-gray-300 px-3 bg-white text-sm"
              >
                {PREMISES_DESCRIPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="next_inspection">Recommended Interval (Years)</Label>
              <select
                id="next_inspection"
                value={details.next_inspection_years || 5}
                onChange={(e) => updateField('next_inspection_years', parseInt(e.target.value))}
                className="w-full h-10 rounded-md border border-gray-300 px-3 bg-white text-sm"
              >
                {INSPECTION_INTERVALS.map((y) => (
                  <option key={y} value={y}>
                    {y} year{y > 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Installation Records</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={details.installation_records_available || false}
              onChange={(e) => updateField('installation_records_available', e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm">Installation records available</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={details.evidence_of_additions_alterations || false}
              onChange={(e) => updateField('evidence_of_additions_alterations', e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm">Evidence of additions or alterations not recorded</span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Extent & Limitations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="extent">Extent of Installation Covered</Label>
            <Textarea
              id="extent"
              value={details.extent || ''}
              onChange={(e) => updateField('extent', e.target.value)}
              placeholder="Describe the extent of the installation covered by this report"
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agreed_limitations">Agreed Limitations</Label>
            <Textarea
              id="agreed_limitations"
              value={details.agreed_limitations || ''}
              onChange={(e) => updateField('agreed_limitations', e.target.value)}
              placeholder="Any agreed limitations to the inspection"
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="agreed_with">Limitations Agreed With</Label>
              <Input
                id="agreed_with"
                value={details.agreed_with || ''}
                onChange={(e) => updateField('agreed_with', e.target.value)}
                placeholder="Name of person"
              />
            </div>
          </div>
          <div className="space-y-1.5">
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
    </div>
  );
}
