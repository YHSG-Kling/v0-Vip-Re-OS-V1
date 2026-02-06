'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { listNotificationRules } from '@/app/actions/settings/list-notification-rules';
import { Loader2 } from 'lucide-react';

export default function NotificationsPage() {
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRules();
  }, []);

  async function loadRules() {
    try {
      const data = await listNotificationRules();
      setRules(data);
    } catch (err) {
      setError('Failed to load notification rules');
    } finally {
      setLoading(false);
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
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Notification Settings</h1>
        <p className="text-gray-600 mt-2">Configure notification rules and preferences</p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-600">
          {error}
        </div>
      )}

      <Card className="p-6">
        <p className="text-gray-600">Notification rules configuration will be available here.</p>
      </Card>
    </div>
  );
}
