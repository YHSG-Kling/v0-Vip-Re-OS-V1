'use client';

import React, { useEffect, useState } from 'react';
import { getGlobalSettings } from '@/app/actions/settings/get-global-settings';
import { GeneralSettingsForm } from '@/app/components/settings/GeneralSettingsForm';

export default function GeneralSettingsPage() {
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
        <h1 className="text-3xl font-bold text-gray-900">General</h1>
        <p className="text-gray-600 mt-2">
          Your brokerage&rsquo;s name, time zone, and date format — used across your workspace and
          every client-facing surface (portal, emails, documents).
        </p>
      </div>
      <GeneralSettingsForm initialData={settings} />
    </div>
  );
}
