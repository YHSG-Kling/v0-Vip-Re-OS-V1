'use client';

import React from 'react';
import { SettingsCard } from '@/app/components/settings/SettingsCard';
import Link from 'next/link';

export default function SettingsDashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600 mt-2">Manage your brokerage configuration</p>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Link href="/settings/general">
          <SettingsCard title="General" description="App name, timezone, formats">
            <p className="text-gray-600">Configure basic application settings</p>
          </SettingsCard>
        </Link>
        <Link href="/settings/branding">
          <SettingsCard title="Branding" description="Colors, fonts, logos">
            <p className="text-gray-600">Customize the app appearance</p>
          </SettingsCard>
        </Link>
        <Link href="/settings/commission">
          <SettingsCard title="Commissions" description="Commission structures">
            <p className="text-gray-600">Define commission calculation rules</p>
          </SettingsCard>
        </Link>
        <Link href="/settings/email-templates">
          <SettingsCard title="Email Templates" description="Email content">
            <p className="text-gray-600">Create and edit email templates</p>
          </SettingsCard>
        </Link>
        <Link href="/settings/notifications">
          <SettingsCard title="Notifications" description="Trigger rules">
            <p className="text-gray-600">Configure notification settings</p>
          </SettingsCard>
        </Link>
        <Link href="/settings/integrations">
          <SettingsCard title="Integrations" description="Third-party APIs">
            <p className="text-gray-600">Manage API credentials</p>
          </SettingsCard>
        </Link>
        <Link href="/settings/campaign-bundles">
          <SettingsCard title="Campaign Bundles" description="Multi-channel campaigns">
            <p className="text-gray-600">Compose presets across channels into coordinated dispatches</p>
          </SettingsCard>
        </Link>
        <Link href="/settings/channel-presets">
          <SettingsCard title="Channel Presets" description="Email / SMS / social / voicedrop / ad / portal">
            <p className="text-gray-600">Locked creative for every bundle channel</p>
          </SettingsCard>
        </Link>
      </div>
    </div>
  );
}
