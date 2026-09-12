'use client';

import { useEffect, useState } from 'react';
import { getGlobalSettings } from '@/app/actions/settings/get-global-settings';
import {
  getBrokerageIdentity,
  type BrokerageIdentity,
} from '@/app/actions/settings/brokerage-identity';
import { GeneralSettingsForm } from '@/app/components/settings/GeneralSettingsForm';

export default function GeneralSettingsPage() {
  const [settings, setSettings] = useState<any>(null);
  // The brokerage's own row. Loaded separately from global_settings because it
  // IS a separate row on a separate table with its own RLS policy — identity
  // (name, DBA, licence, address) lives on `brokerages`; workspace formatting
  // lives on `global_settings`. A failure to read one must not blank the other,
  // so the error is carried alongside rather than replacing the page.
  const [identity, setIdentity] = useState<BrokerageIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const [data, identityResult] = await Promise.all([
          getGlobalSettings(),
          getBrokerageIdentity(),
        ]);
        setSettings(data);
        // Destructured, not assumed: "could not read" and "nothing set" are
        // different answers and the card says which one it got.
        setIdentity(identityResult.data);
        setIdentityError(identityResult.error);
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
          Your brokerage&rsquo;s legal name, DBA, licence and full office address, plus the time
          zone and date format used across your workspace and every client-facing surface (portal,
          emails, documents, disclosures).
        </p>
      </div>
      <GeneralSettingsForm
        initialData={settings}
        initialIdentity={identity}
        identityError={identityError}
      />
    </div>
  );
}
