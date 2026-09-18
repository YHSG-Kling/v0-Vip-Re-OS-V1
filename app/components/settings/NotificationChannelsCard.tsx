'use client';

// The brokerage-wide master switches for each notification channel.
//
// These lived on /settings/global — an orphaned superset page (no nav entry, no
// inbound link) that also duplicated the General and Branding forms field-for-field.
// The switches themselves were NOT duplicated anywhere, so they moved here rather
// than being dropped with the page: this is where a broker already comes to decide
// when notifications are sent, and these decide whether a channel can send at all.
//
// Per-event rules live below this card in NotificationRulesForm; this is the gate
// those rules run through.

import { useEffect, useState } from 'react';
import { getGlobalSettings } from '@/app/actions/settings/get-global-settings';
import { updateGlobalSettings } from '@/app/actions/settings/update-global-settings';
import { SettingsCard } from './SettingsCard';

const CHANNELS = [
  {
    key: 'email_notifications_enabled' as const,
    label: 'Email notifications',
    hint: 'Alerts, digests and rule-driven email to your agents and clients.',
  },
  {
    key: 'sms_notifications_enabled' as const,
    label: 'SMS notifications',
    hint: 'Text alerts. Consent and quiet-hours rules still apply on top of this.',
  },
  {
    key: 'push_notifications_enabled' as const,
    label: 'Push notifications',
    hint: 'Browser and mobile push for agents signed in to the workspace.',
  },
];

type State = Record<(typeof CHANNELS)[number]['key'], boolean>;

export function NotificationChannelsCard() {
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [state, setState] = useState<State>({
    email_notifications_enabled: true,
    sms_notifications_enabled: true,
    push_notifications_enabled: true,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getGlobalSettings()
      .then((data: any) => {
        if (cancelled || !data) return;
        setSettingsId(data.id ?? null);
        setState({
          email_notifications_enabled: data.email_notifications_enabled ?? true,
          sms_notifications_enabled: data.sms_notifications_enabled ?? true,
          push_notifications_enabled: data.push_notifications_enabled ?? true,
        });
      })
      .catch(() => { if (!cancelled) setError('Could not load channel settings'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function toggle(key: (typeof CHANNELS)[number]['key'], value: boolean) {
    const next = { ...state, [key]: value };
    setState(next);
    setSaving(true);
    setError('');
    setSuccess(false);
    try {
      const result: any = await updateGlobalSettings({ ...(settingsId ? { id: settingsId } : {}), ...next });
      if (result?.error) {
        setError(result.error);
        setState(state); // put the switch back — it did not take
        return;
      }
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch {
      setError('Could not save that change');
      setState(state);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard
      title="Notification Channels"
      description="Master switches — turning a channel off stops every rule below from using it"
    >
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-3">
          {CHANNELS.map((c) => (
            <label key={c.key} className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={state[c.key]}
                disabled={saving}
                onChange={(e) => void toggle(c.key, e.target.checked)}
                className="w-4 h-4 mt-0.5"
              />
              <span>
                <span className="text-sm text-gray-800">{c.label}</span>
                <span className="block text-xs text-gray-500">{c.hint}</span>
              </span>
            </label>
          ))}
          {error && <p className="text-xs text-red-600">{error}</p>}
          {success && <p className="text-xs text-green-700">Saved.</p>}
        </div>
      )}
    </SettingsCard>
  );
}
