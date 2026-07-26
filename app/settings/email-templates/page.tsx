'use client';

import React, { useEffect, useState } from 'react';
import { listEmailTemplates } from '@/app/actions/settings/list-email-templates';
import { EmailTemplateEditor } from '@/app/components/settings/EmailTemplateEditor';
import { SettingsCard } from '@/app/components/settings/SettingsCard';

export default function EmailTemplatesPage() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The template currently open in the editor. null = "new template" mode.
  const [selected, setSelected] = useState<any | null>(null);

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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Email Templates</h1>
          <p className="text-gray-600 mt-2">Create and manage email templates</p>
        </div>
        {selected && (
          <button
            onClick={() => setSelected(null)}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
          >
            + New template
          </button>
        )}
      </div>

      {/* Editor: create mode when nothing selected, edit mode when a row is
          clicked. key forces a fresh init from the selected template's fields.
          Clears the selection on save so the list re-shows the create form. */}
      <EmailTemplateEditor
        key={selected?.id ?? 'new'}
        template={selected ?? undefined}
        onSuccess={() => { setSelected(null); loadTemplates(); }}
      />

      {!loading && templates.length > 0 && (
        <SettingsCard title="Existing Templates">
          <div className="space-y-1">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => setSelected(template)}
                className={`w-full flex justify-between items-center p-2 border-b text-left rounded hover:bg-gray-50 transition-colors ${
                  selected?.id === template.id ? 'bg-blue-50' : ''
                }`}
              >
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
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">Click a template to view and edit it.</p>
        </SettingsCard>
      )}
    </div>
  );
}
