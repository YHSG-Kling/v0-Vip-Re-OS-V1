'use client';

import React, { useState } from 'react';
import { createEmailTemplate } from '@/app/actions/settings/create-email-template';
import { updateEmailTemplate } from '@/app/actions/settings/update-email-template';
import { SettingsCard } from './SettingsCard';

interface EmailTemplateEditorProps {
  template?: any;
  onSuccess: () => void;
}

export function EmailTemplateEditor({ template, onSuccess }: EmailTemplateEditorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    name: template?.name || '',
    subject: template?.subject || '',
    body: template?.body || '',
    template_type: template?.template_type || 'welcome',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
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

    try {
      const result = template
        ? await updateEmailTemplate(template.id, formData)
        : await createEmailTemplate(formData);

      if (result.error) {
        setError(result.error);
      } else {
        onSuccess();
        setFormData({ name: '', subject: '', body: '', template_type: 'welcome' });
      }
    } catch (err) {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsCard title={template ? 'Edit Email Template' : 'Create Email Template'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Template Name</label>
          <input
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="e.g., Welcome Email"
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Type</label>
          <select
            name="template_type"
            value={formData.template_type}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            <option value="welcome">Welcome</option>
            <option value="offer">Offer</option>
            <option value="closing">Closing</option>
            <option value="followup">Follow-up</option>
            <option value="reminder">Reminder</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Subject Line</label>
          <input
            type="text"
            name="subject"
            value={formData.subject}
            onChange={handleChange}
            placeholder="Email subject"
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Template Body (use {'{'}{'{'} variable {'}'}{'}'}  for dynamic content)
          </label>
          <textarea
            name="body"
            value={formData.body}
            onChange={handleChange}
            placeholder="Email template content"
            required
            rows={10}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none font-mono text-sm"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium py-2 px-6 rounded-lg transition-colors"
        >
          {loading ? 'Saving...' : template ? 'Update Template' : 'Create Template'}
        </button>
      </form>
    </SettingsCard>
  );
}
