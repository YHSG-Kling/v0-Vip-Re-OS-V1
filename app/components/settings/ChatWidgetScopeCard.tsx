'use client';

// WHO the embedded website chat represents, and the embed code for it.
//
// Moved here from /settings/global, an orphaned superset page that duplicated the
// General and Branding forms field-for-field. This section was the opposite — the
// ONLY editor of widget scope anywhere in the app (updateWidgetScope has no other
// caller), so deleting the page with it would have removed working functionality.
//
// It belongs on the Widget page: that page already owns the launcher's appearance
// and placement for an agent; this owns whose identity the conversation carries.

import React, { useEffect, useState } from 'react';
import {
  fetchGlobalSettings,
  fetchWidgetScope,
  updateWidgetScope,
  fetchWidgetAgentsAndTeams,
  type WidgetScope,
} from '@/app/actions/settings/global-settings-actions';

const OWNER_TYPES = ['brokerage', 'team', 'agent'] as const;
const OWNER_LABEL: Record<(typeof OWNER_TYPES)[number], string> = {
  brokerage: 'Our brokerage',
  team: 'A team',
  agent: 'A specific agent',
};

export function ChatWidgetScopeCard() {
  const [brokerageId, setBrokerageId] = useState('');
  const [scope, setScope] = useState<WidgetScope>({ owner_type: 'brokerage', owner_id: '', display_name: '' });
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, saved, { agents: a, teams: t }] = await Promise.all([
          fetchGlobalSettings(),
          fetchWidgetScope(),
          fetchWidgetAgentsAndTeams(),
        ]);
        if (cancelled) return;
        const bId = (settings as any)?.brokerage_id ?? '';
        setBrokerageId(bId);
        setAgents(a);
        setTeams(t);
        // No saved scope yet → default to the brokerage itself, which is the only
        // owner we can name without the broker choosing one.
        setScope(saved ?? { owner_type: 'brokerage', owner_id: bId, display_name: '' });
      } catch {
        if (!cancelled) setError('Could not load widget settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function save() {
    if (!scope.owner_id || !scope.display_name) {
      setError('Pick who the chat represents and give it a display name.');
      return;
    }
    setSaving(true); setError(''); setSuccess('');
    try {
      await updateWidgetScope(scope);
      setSuccess('Widget settings saved.');
    } catch {
      setError('Failed to save widget settings.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading widget settings…</p>;

  const embed = scope.owner_id && scope.display_name
    ? `<script>
  (function(w,d,s,o){
    var j=d.createElement(s);j.async=true;
    j.src='${typeof window !== 'undefined' ? window.location.origin : ''}/widget/loader.js';
    j.setAttribute('data-scope','${scope.owner_type}');
    j.setAttribute('data-id','${scope.owner_id}');
    j.setAttribute('data-brokerage','${brokerageId}');
    d.head.appendChild(j);
  })(window,document,'script');
</script>`
    : null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-800">Who does this chat represent?</h2>
        <p className="text-xs text-gray-500">
          Sets the identity on the conversation and routes what the assistant knows.
        </p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-xs">{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded-lg text-xs">{success}</div>}

      <div className="space-y-1">
        {OWNER_TYPES.map((t) => (
          <label key={t} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="widget_owner_type"
              value={t}
              checked={scope.owner_type === t}
              onChange={() => {
                const first = t === 'agent' ? agents[0]?.id ?? ''
                  : t === 'team' ? teams[0]?.id ?? ''
                  : brokerageId;
                setScope((prev) => ({ ...prev, owner_type: t, owner_id: first }));
              }}
              className="w-4 h-4"
            />
            <span className="text-sm text-gray-700">{OWNER_LABEL[t]}</span>
          </label>
        ))}
      </div>

      {scope.owner_type === 'agent' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Agent</label>
          <select
            value={scope.owner_id}
            onChange={(e) => {
              const agent = agents.find((a) => a.id === e.target.value);
              setScope((prev) => ({ ...prev, owner_id: e.target.value, display_name: agent?.name ?? prev.display_name }));
            }}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          >
            <option value="">Select an agent…</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}

      {scope.owner_type === 'team' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Team</label>
          <select
            value={scope.owner_id}
            onChange={(e) => {
              const team = teams.find((t) => t.id === e.target.value);
              setScope((prev) => ({ ...prev, owner_id: e.target.value, display_name: team?.name ?? prev.display_name }));
            }}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          >
            <option value="">Select a team…</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Display name</label>
        <input
          type="text"
          value={scope.display_name}
          onChange={(e) => setScope((prev) => ({ ...prev, display_name: e.target.value }))}
          placeholder="e.g. VIP Premier Realty or Sarah Miller"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
        />
      </div>

      <button
        onClick={() => void save()}
        disabled={saving}
        className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded-lg"
      >
        {saving ? 'Saving…' : 'Save widget settings'}
      </button>

      {embed && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Embed code</label>
          <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-all">
            {embed}
          </pre>
        </div>
      )}
    </div>
  );
}
