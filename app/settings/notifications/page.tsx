'use client';

import { useEffect, useState } from 'react';
import { listNotificationRules } from '@/app/actions/settings/list-notification-rules';
import { NotificationRulesForm } from '@/app/components/settings/NotificationRulesForm';
import { SettingsCard } from '@/app/components/settings/SettingsCard';
import { NotificationChannelsCard } from '@/app/components/settings/NotificationChannelsCard';
import { PushPermissionToggle } from '@/app/components/shared/push-permission-toggle';
import type { NotificationRuleRow } from "@/lib/kernel"

export default function NotificationsPage() {
  const [rules, setRules] = useState<NotificationRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadRules = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await listNotificationRules();
      setRules(data);
    } catch (err) {
      console.error('[v0] Error loading notification rules:', err);
      const message = err instanceof Error ? err.message : 'Failed to load notification rules';
      setError(message);
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

      {/* Channel master switches, moved off the orphaned /settings/global page. */}
      <NotificationChannelsCard />

      <SettingsCard
        title="Push Notifications"
        description="Deliver alerts to this browser even when the app is closed"
      >
        <PushPermissionToggle />
      </SettingsCard>

      {!loading && <NotificationRulesForm rules={rules} onRefresh={loadRules} />}
    </div>
  );
}
