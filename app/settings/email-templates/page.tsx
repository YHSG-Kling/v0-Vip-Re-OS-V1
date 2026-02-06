'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listEmailTemplates } from '@/app/actions/settings/list-email-templates';
import { createEmailTemplate } from '@/app/actions/settings/create-email-template';
import { deleteEmailTemplate } from '@/app/actions/settings/delete-email-template';
import { TEMPLATE_TYPES } from '@/app/lib/settings/default-settings';
import { Loader2, Plus, Trash2 } from 'lucide-react';

export default function EmailTemplatesPage() {
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    subject: '',
    body: '',
    template_type: 'welcome',
  });

  useEffect(() => {
    loadTemplates();
  }, []);

  async function loadTemplates() {
    try {
      const data = await listEmailTemplates();
      setTemplates(data);
    } catch (err) {
      setError('Failed to load email templates');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const result = await createEmailTemplate(formData);

    if (result.error) {
      setError(result.error);
    } else {
      setShowForm(false);
      setFormData({
        name: '',
        slug: '',
        subject: '',
        body: '',
        template_type: 'welcome',
      });
      await loadTemplates();
    }

    setSaving(false);
  }

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this template?')) {
      return;
    }

    const result = await deleteEmailTemplate(id);
    if (result.error) {
      setError(result.error);
    } else {
      await loadTemplates();
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Email Templates</h1>
          <p className="text-gray-600 mt-2">Create and manage email templates</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Template
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-600">
          {error}
        </div>
      )}

      {showForm && (
        <Card className="p-6 mb-6">
          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Template Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div>
                <Label htmlFor="slug">Slug</Label>
                <Input
                  id="slug"
                  value={formData.slug}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                  placeholder="welcome-email"
                  required
                />
              </div>

              <div>
                <Label htmlFor="template_type">Type</Label>
                <Select
                  value={formData.template_type}
                  onValueChange={(value) => setFormData({ ...formData, template_type: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="subject">Email Subject</Label>
                <Input
                  id="subject"
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  placeholder="Welcome to {{app_name}}"
                  required
                />
              </div>

              <div>
                <Label htmlFor="body">Email Body</Label>
                <Textarea
                  id="body"
                  value={formData.body}
                  onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                  placeholder="Use {{variable_name}} for dynamic content"
                  rows={10}
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  Use double curly braces for variables: {`{{first_name}}`}, {`{{app_name}}`}, etc.
                </p>
              </div>

              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Template
                </Button>
              </div>
            </div>
          </form>
        </Card>
      )}

      <div className="grid gap-4">
        {templates.map((template) => (
          <Card key={template.id} className="p-6">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">{template.name}</h3>
                <p className="text-sm text-gray-600 mt-1">Subject: {template.subject}</p>
                <div className="mt-3 flex gap-4 text-sm">
                  <span className="text-gray-700">
                    Type: <span className="font-medium">{template.template_type}</span>
                  </span>
                  <span className="text-gray-700">
                    Slug: <span className="font-medium">{template.slug}</span>
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(template.id)}
              >
                <Trash2 className="h-4 w-4 text-red-600" />
              </Button>
            </div>
          </Card>
        ))}

        {templates.length === 0 && !showForm && (
          <div className="text-center py-12">
            <p className="text-gray-600">No email templates yet. Create one to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
