'use client';

import React from 'react';
import { SettingsCard } from '@/app/components/settings/SettingsCard';

export default function UsersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">User Management</h1>
        <p className="text-gray-600 mt-2">Manage brokerage users and roles</p>
      </div>

      <SettingsCard title="Users">
        <p className="text-gray-600">User management coming soon</p>
      </SettingsCard>
    </div>
  );
}
