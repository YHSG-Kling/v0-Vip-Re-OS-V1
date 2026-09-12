'use client';

import { useEffect, useState } from 'react';
import { getGlobalSettings } from '@/app/actions/settings/get-global-settings';
import { BrandingForm } from '@/app/components/settings/BrandingForm';
import { YourWebsiteCard } from '@/app/components/settings/YourWebsiteCard';

export default function BrandingPage() {
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await getGlobalSettings();
        setSettings(data);
      } catch (err) {
        setError('Failed to load settings');
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, []);

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  if (error) {
    return <div className="text-red-600">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Branding Settings</h1>
        <p className="text-gray-600 mt-2">Customize your app appearance</p>
      </div>
      {/* The zero-hosting sites this branding feeds — live URLs, finally discoverable. */}
      <YourWebsiteCard />
      <BrandingForm initialData={settings} />
    </div>
  );
}
