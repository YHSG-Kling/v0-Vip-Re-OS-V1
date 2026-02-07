'use client';

import React, { useEffect, useState } from 'react';
import { listEmailTemplates } from '@/app/actions/settings/list-email-templates';
import { EmailTemplateEditor } from '@/app/components/settings/EmailTemplateEditor';
import { SettingsCard } from '@/app/components/settings/SettingsCard';

export default function EmailTemplatesPage() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadTemplates = async () => {
    try {
      setLoading(true);
      const data = await listEmailTemplates();
      setTemplates(data);
    } catch (err) {
      setError('Failed to load email templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTemplates();
  }, []);

  if (error) {
    return <div className="text-red-600">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Email Templates</h1>
        <p className="text-gray-600 mt-2">Create and manage email templates</p>
      </div>

      <EmailTemplateEditor onSuccess={loadTemplates} />

      {!loading && templates.length > 0 && (
        <SettingsCard title="Existing Templates">
          <div className="space-y-2">
            {templates.map((template) => (
              <div key={template.id} className="flex justify-between items-center p-2 border-b">
                <div>
                  <p className="font-medium text-gray-900">{template.name}</p>
                  <p className="text-sm text-gray-600">{template.template_type}</p>
                </div>
                <span className={`text-xs px-2 py-1 rounded ${
                  template.is_active
                    ? 'bg-green-100 text-green-800'
                    : 'bg-gray-100 text-gray-800'
                }`}>
                  {template.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </div>
  );
}
