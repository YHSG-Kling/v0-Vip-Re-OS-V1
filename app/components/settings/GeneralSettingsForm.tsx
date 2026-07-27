'use client';

import React, { useState } from 'react';
import { updateGlobalSettings } from '@/app/actions/settings/update-global-settings';
import { SettingsCard } from './SettingsCard';

interface GeneralSettingsFormProps {
  initialData: any;
}

export function GeneralSettingsForm({ initialData }: GeneralSettingsFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState({
    app_name: initialData?.app_name || '',
    timezone: initialData?.timezone || 'America/New_York',
    date_format: initialData?.date_format || 'MM/DD/YYYY',
    // Moved here from the orphaned /settings/global page, which was a superset
    // duplicating this form and the Branding form. Currency belongs with the other
    // workspace-formatting choices, not on a second page editing the same row.
    currency_symbol: initialData?.currency_symbol || '$',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess(false);

    try {
      const result = await updateGlobalSettings({
        id: initialData.id,
        ...formData,
      });

      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch (err) {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsCard title="Brokerage Info">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Company / Brokerage Name</label>
          <p className="text-xs text-gray-500 mb-2">
            The name your clients and agents see across the workspace, client portal, and outgoing
            emails and documents.
          </p>
          <input
            type="text"
            name="app_name"
            value={formData.app_name}
            onChange={handleChange}
            placeholder="e.g., VIP Premier Realty"
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Time Zone</label>
          <select
            name="timezone"
            value={formData.timezone}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            <option value="America/New_York">Eastern Time</option>
            <option value="America/Chicago">Central Time</option>
            <option value="America/Denver">Mountain Time</option>
            <option value="America/Los_Angeles">Pacific Time</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Date Format</label>
          <select
            name="date_format"
            value={formData.date_format}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="YYYY-MM-DD">YYYY-MM-DD</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Currency Symbol</label>
          <p className="text-xs text-gray-500 mb-2">
            Shown on prices, commissions and financial reports across the workspace.
          </p>
          <input
            type="text"
            name="currency_symbol"
            value={formData.currency_symbol}
            onChange={handleChange}
            maxLength={3}
            placeholder="$"
            className="w-24 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
            Settings updated successfully!
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-6 rounded-lg transition-colors"
        >
          {loading ? 'Saving...' : 'Save Settings'}
        </button>
      </form>
    </SettingsCard>
  );
}
