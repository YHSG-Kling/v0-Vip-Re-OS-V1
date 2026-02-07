'use client';

import React, { useState } from 'react';
import { updateNotificationRules } from '@/app/actions/settings/update-notification-rules';
import { SettingsCard } from './SettingsCard';

interface NotificationRulesFormProps {
  rules: any[];
  onRefresh: () => void;
}

export function NotificationRulesForm({ rules, onRefresh }: NotificationRulesFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const [formData, setFormData] = useState<any>({});

  const handleChange = (ruleId: string, field: string, value: any) => {
    setFormData((prev: any) => ({
      ...prev,
      [ruleId]: {
        ...prev[ruleId],
        [field]: value,
      },
    }));
    setSelectedRule(ruleId);
  };

  const handleSave = async (ruleId: string) => {
    setLoading(true);
    setError('');

    try {
      const result = await updateNotificationRules(ruleId, formData[ruleId]);
      if (result.error) {
        setError(result.error);
      } else {
        onRefresh();
        setSelectedRule(null);
      }
    } catch (err) {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsCard title="Notification Rules">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {rules.map((rule) => (
          <div key={rule.id} className="border border-gray-200 rounded-lg p-4">
            <div className="flex justify-between items-start">
              <div>
                <h4 className="font-medium text-gray-900">{rule.rule_name}</h4>
                <p className="text-sm text-gray-600">Trigger: {rule.trigger_event}</p>
                <p className="text-sm text-gray-600">Type: {rule.notification_type}</p>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData[rule.id]?.is_active ?? rule.is_active}
                  onChange={(e) => handleChange(rule.id, 'is_active', e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-700">Active</span>
              </label>
            </div>

            {selectedRule === rule.id && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <button
                  onClick={() => handleSave(rule.id)}
                  disabled={loading}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  {loading ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}
