'use client';

import { useEffect, useState } from 'react';
import { Save, Loader2, Building2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import type { CompanySettings } from '@/lib/types';

const defaultCompanySettings: CompanySettings = {
  company_name: '',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_website: '',
  company_registration: '',
  logo_file: null,
};

export default function CompanyPage() {
  const [settings, setSettings] = useState<CompanySettings>(defaultCompanySettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      try {
        const me = await api.getMe();
        const companySettings = await api.getCompanySettings(me.id);
        setSettings(companySettings);
      } catch (error) {
        console.error('Failed to load company settings:', error);
        toast.error('Failed to load settings');
      } finally {
        setLoading(false);
      }
    }

    loadSettings();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const me = await api.getMe();
      await api.saveCompanySettings(me.id, settings);
      toast.success('Company settings saved');
    } catch (error) {
      console.error('Failed to save company settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (field: keyof CompanySettings, value: string) => {
    setSettings((prev) => ({
      ...prev,
      [field]: value,
    }));
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
          <h1 className="text-2xl font-bold">Company Information</h1>
          <p className="text-sm text-muted-foreground">
            Your company details appear on generated EICR certificates.
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          Save
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Company Details
          </CardTitle>
          <CardDescription>
            This information is used on certificate headers and footers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company_name">Company Name</Label>
              <Input
                id="company_name"
                value={settings.company_name}
                onChange={(e) => handleChange('company_name', e.target.value)}
                placeholder="ABC Electrical Ltd"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company_registration">Registration Number</Label>
              <Input
                id="company_registration"
                value={settings.company_registration}
                onChange={(e) => handleChange('company_registration', e.target.value)}
                placeholder="12345678"
              />
              <p className="text-xs text-muted-foreground">
                Company registration or NICEIC/NAPIT number
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="company_address">Company Address</Label>
            <Textarea
              id="company_address"
              value={settings.company_address}
              onChange={(e) => handleChange('company_address', e.target.value)}
              placeholder={'123 High Street\nManchester\nM1 2AB'}
              rows={3}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company_phone">Phone Number</Label>
              <Input
                id="company_phone"
                type="tel"
                value={settings.company_phone}
                onChange={(e) => handleChange('company_phone', e.target.value)}
                placeholder="0161 123 4567"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company_email">Email Address</Label>
              <Input
                id="company_email"
                type="email"
                value={settings.company_email}
                onChange={(e) => handleChange('company_email', e.target.value)}
                placeholder="info@example.com"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="company_website">Website</Label>
            <Input
              id="company_website"
              type="url"
              value={settings.company_website}
              onChange={(e) => handleChange('company_website', e.target.value)}
              placeholder="https://www.example.com"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
