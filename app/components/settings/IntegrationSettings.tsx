'use client';

import React, { useState } from 'react';
import { updateIntegrationCredentials } from '@/app/actions/settings/update-integration-credentials';
import { SettingsCard } from './SettingsCard';

interface IntegrationSettingsProps {
  credentials: any[];
  onRefresh: () => void;
}

export function IntegrationSettings({ credentials, onRefresh }: IntegrationSettingsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState<any>({});

  const handleEdit = (credential: any) => {
    setEditingId(credential.id);
    setFormData({
      [credential.id]: {
        api_key: '',
        api_secret: '',
        webhook_url: credential.webhook_url || '',
        is_active: credential.is_active,
      },
    });
  };

  const handleChange = (id: string, field: string, value: string | boolean) => {
    setFormData((prev: any) => ({
      ...prev,
      [id]: {
        ...prev[id],
        [field]: value,
      },
    }));
  };

  const handleSave = async (id: string) => {
    setLoading(true);
    setError('');

    try {
      const result = await updateIntegrationCredentials(id, formData[id]);
      if (result.error) {
        setError(result.error);
      } else {
        onRefresh();
        setEditingId(null);
      }
    } catch (err) {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsCard title="Integration Credentials">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {credentials.map((credential) => (
          <div key={credential.id} className="border border-gray-200 rounded-lg p-4">
            <div className="flex justify-between items-center">
              <div>
                <h4 className="font-medium text-gray-900">{credential.provider_name.toUpperCase()}</h4>
                <p className="text-sm text-gray-600">
                  Status: {credential.is_active ? '✓ Active' : '✗ Inactive'}
                </p>
              </div>
              {editingId !== credential.id && (
                <button
                  onClick={() => handleEdit(credential)}
                  className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                >
                  Edit
                </button>
              )}
            </div>

            {editingId === credential.id && (
              <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
                <input
                  type="password"
                  placeholder="API Key"
                  value={formData[credential.id]?.api_key || ''}
                  onChange={(e) => handleChange(credential.id, 'api_key', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm"
                />
                <input
                  type="password"
                  placeholder="API Secret (optional)"
                  value={formData[credential.id]?.api_secret || ''}
                  onChange={(e) => handleChange(credential.id, 'api_secret', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm"
                />
                <button
                  onClick={() => handleSave(credential.id)}
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  {loading ? 'Saving...' : 'Save Credentials'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}
