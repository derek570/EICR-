'use client';

import { useJob } from '../layout';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ExtentAndType } from '@/lib/api';
import { INSTALLATION_TYPE_LABELS } from '@/lib/constants';

export default function ExtentPage() {
  const { job, updateJob, certificateType } = useJob();

  // This page is only for EIC certificates
  if (certificateType !== 'EIC') {
    return (
      <div className="p-4">
        <p className="text-muted-foreground">This page is only available for EIC certificates.</p>
      </div>
    );
  }

  const extent = job.extent_and_type || {
    extent: '',
    installation_type: 'new_installation',
  };

  const updateField = <K extends keyof ExtentAndType>(field: K, value: ExtentAndType[K]) => {
    updateJob({ extent_and_type: { ...extent, [field]: value } });
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">Extent and Type of Installation</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Type of Work</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            {(
              Object.entries(INSTALLATION_TYPE_LABELS) as [
                ExtentAndType['installation_type'],
                string,
              ][]
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex items-center gap-3 cursor-pointer p-2 rounded hover:bg-accent"
              >
                <input
                  type="radio"
                  name="installation_type"
                  value={value}
                  checked={extent.installation_type === value}
                  onChange={() => updateField('installation_type', value)}
                  className="h-4 w-4"
                />
                <span className="text-sm">{label}</span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Extent of Installation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="extent">Extent of the installation covered by this certificate</Label>
            <Textarea
              id="extent"
              value={extent.extent || ''}
              onChange={(e) => updateField('extent', e.target.value)}
              placeholder="Describe the extent of the installation covered..."
              rows={4}
            />
          </div>
        </CardContent>
      </Card>

      {extent.installation_type !== 'new_installation' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Comments on Existing Installation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="comments">Comments on the existing installation</Label>
              <Textarea
                id="comments"
                value={extent.comments || ''}
                onChange={(e) => updateField('comments', e.target.value)}
                placeholder="Any relevant comments on the existing installation..."
                rows={3}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
