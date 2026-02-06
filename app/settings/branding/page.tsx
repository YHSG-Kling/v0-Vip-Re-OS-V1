'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getGlobalSettings } from '@/app/actions/settings/get-global-settings';
import { updateGlobalSettings } from '@/app/actions/settings/update-global-settings';
import { DEFAULT_GLOBAL_SETTINGS } from '@/app/lib/settings/default-settings';
import { Loader2 } from 'lucide-react';

export default function BrandingPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [settings, setSettings] = useState({
    app_logo_url: '',
    primary_color: DEFAULT_GLOBAL_SETTINGS.primary_color,
    secondary_color: DEFAULT_GLOBAL_SETTINGS.secondary_color,
    font_family: DEFAULT_GLOBAL_SETTINGS.font_family,
  });

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const data = await getGlobalSettings();
      if (data) {
        setSettings({
          app_logo_url: data.app_logo_url || '',
          primary_color: data.primary_color || DEFAULT_GLOBAL_SETTINGS.primary_color,
          secondary_color: data.secondary_color || DEFAULT_GLOBAL_SETTINGS.secondary_color,
          font_family: data.font_family || DEFAULT_GLOBAL_SETTINGS.font_family,
        });
      }
    } catch (err) {
      setError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    const result = await updateGlobalSettings(settings);

    if (result.error) {
      setError(result.error);
    } else {
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    }

    setSaving(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Branding</h1>
        <p className="text-gray-600 mt-2">Customize your app appearance</p>
      </div>

      <form onSubmit={handleSubmit}>
        <Card className="p-6 max-w-2xl">
          <div className="space-y-6">
            <div>
              <Label htmlFor="app_logo_url">App Logo URL</Label>
              <Input
                id="app_logo_url"
                value={settings.app_logo_url}
                onChange={(e) => setSettings({ ...settings, app_logo_url: e.target.value })}
                placeholder="https://example.com/logo.png"
              />
            </div>

            <div>
              <Label htmlFor="primary_color">Primary Color</Label>
              <div className="flex gap-3 items-center">
                <Input
                  id="primary_color"
                  type="color"
                  value={settings.primary_color}
                  onChange={(e) => setSettings({ ...settings, primary_color: e.target.value })}
                  className="w-20 h-10"
                />
                <Input
                  value={settings.primary_color}
                  onChange={(e) => setSettings({ ...settings, primary_color: e.target.value })}
                  placeholder="#2563eb"
                  className="flex-1"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="secondary_color">Secondary Color</Label>
              <div className="flex gap-3 items-center">
                <Input
                  id="secondary_color"
                  type="color"
                  value={settings.secondary_color}
                  onChange={(e) => setSettings({ ...settings, secondary_color: e.target.value })}
                  className="w-20 h-10"
                />
                <Input
                  value={settings.secondary_color}
                  onChange={(e) => setSettings({ ...settings, secondary_color: e.target.value })}
                  placeholder="#1e40af"
                  className="flex-1"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="font_family">Font Family</Label>
              <Input
                id="font_family"
                value={settings.font_family}
                onChange={(e) => setSettings({ ...settings, font_family: e.target.value })}
                placeholder="system-ui"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-600">
                {error}
              </div>
            )}

            {success && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-md text-sm text-green-600">
                Branding settings saved successfully
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </div>
        </Card>
      </form>
    </div>
  );
}
