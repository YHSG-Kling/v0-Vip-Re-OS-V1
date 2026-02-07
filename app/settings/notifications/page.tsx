'use client';

import React, { useEffect, useState } from 'react';
import { listNotificationRules } from '@/app/actions/settings/list-notification-rules';
import { NotificationRulesForm } from '@/app/components/settings/NotificationRulesForm';

export default function NotificationsPage() {
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadRules = async () => {
    try {
      setLoading(true);
      const data = await listNotificationRules();
      setRules(data);
    } catch (err) {
      setError('Failed to load notification rules');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRules();
  }, []);

  if (error) {
    return <div className="text-red-600">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Notification Rules</h1>
        <p className="text-gray-600 mt-2">Configure when notifications are sent</p>
      </div>

      {!loading && <NotificationRulesForm rules={rules} onRefresh={loadRules} />}
    </div>
  );
}
