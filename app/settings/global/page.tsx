"use client"

import React, { useEffect, useState } from "react"
import {
  fetchGlobalSettings,
  updateSettings,
  fetchWidgetScope,
  updateWidgetScope,
  fetchWidgetAgentsAndTeams,
  type WidgetScope,
} from "@/app/actions/settings/global-settings-actions"
import type { GlobalSettingsRow } from "@/lib/kernel"
import { SettingsCard } from "@/app/components/settings/SettingsCard"

type EditableSettings = Omit<
  GlobalSettingsRow,
  | "id"
  | "brokerage_id"
  | "created_by_user_id"
  | "created_at"
  | "updated_at"
  | "additional_settings"
  | "smtp_host"
  | "smtp_port"
  | "smtp_username"
  | "smtp_password"
  | "from_email"
  | "from_name"
  | "ghl_api_key"
  | "zapier_api_key"
  | "airtable_api_key"
>

export default function GlobalSettingsPage() {
  const [settings, setSettings] = useState<GlobalSettingsRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  // Widget scope config
  const [widgetScope, setWidgetScope] = useState<WidgetScope>({
    owner_type: "brokerage",
    owner_id: "",
    display_name: "",
  })
  const [widgetAgents, setWidgetAgents] = useState<Array<{ id: string; name: string }>>([])
  const [widgetTeams, setWidgetTeams] = useState<Array<{ id: string; name: string }>>([])
  const [widgetSaving, setWidgetSaving] = useState(false)
  const [widgetSuccess, setWidgetSuccess] = useState("")
  const [widgetError, setWidgetError] = useState("")

  useEffect(() => {
    const load = async () => {
      try {
        const [data, scope, { agents, teams }] = await Promise.all([
          fetchGlobalSettings(),
          fetchWidgetScope(),
          fetchWidgetAgentsAndTeams(),
        ])
        setSettings(data)
        if (scope) setWidgetScope(scope)
        else {
          // Default owner_id to brokerage_id once available
          setWidgetScope((prev) => ({ ...prev, owner_id: (data as any).brokerage_id ?? "" }))
        }
        setWidgetAgents(agents)
        setWidgetTeams(teams)
      } catch {
        setError("Failed to load settings")
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  const handleChange = (field: keyof EditableSettings, value: string | boolean | number) => {
    if (settings) {
      setSettings({ ...settings, [field]: value })
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError("")
    setSuccess("")
    try {
      await updateSettings({
        app_name: settings?.app_name,
        app_logo_url: settings?.app_logo_url,
        primary_color: settings?.primary_color,
        secondary_color: settings?.secondary_color,
        font_family: settings?.font_family,
        fiscal_year_start: settings?.fiscal_year_start,
        timezone: settings?.timezone,
        date_format: settings?.date_format,
        currency_symbol: settings?.currency_symbol,
        email_notifications_enabled: settings?.email_notifications_enabled,
        sms_notifications_enabled: settings?.sms_notifications_enabled,
        push_notifications_enabled: settings?.push_notifications_enabled,
      })
      setSuccess("Settings saved successfully")
    } catch {
      setError("Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  const handleWidgetSave = async () => {
    if (!widgetScope.owner_id || !widgetScope.display_name) {
      setWidgetError("Owner ID and Display Name are required.")
      return
    }
    setWidgetSaving(true)
    setWidgetError("")
    setWidgetSuccess("")
    try {
      await updateWidgetScope(widgetScope)
      setWidgetSuccess("Widget settings saved.")
    } catch {
      setWidgetError("Failed to save widget settings.")
    } finally {
      setWidgetSaving(false)
    }
  }

  if (loading) return <div className="text-gray-600">Loading...</div>

  if (!settings) return <div className="text-red-600">Failed to load settings</div>

  return (
    <SettingsCard title="Global Settings">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm mb-4">
          {success}
        </div>
      )}

      <div className="space-y-4">
        <div>
          {/* Not the product's name — the TENANT's. This value is rendered as the
              brokerage on the open-house sign-in kiosk and inside the TCPA consent text
              a lead agrees to, so labelling it "App Name" invited brokers to leave the
              product default in a place their clients read. */}
          <label className="block text-sm font-medium text-gray-700 mb-1">Company / Brokerage Name</label>
          <p className="text-xs text-gray-500 mb-2">
            Shown to your clients on the portal, open-house sign-in, and consent text.
          </p>
          <input
            type="text"
            value={settings.app_name}
            onChange={(e) => handleChange("app_name", e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
          <select
            value={settings.timezone}
            onChange={(e) => handleChange("timezone", e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          >
            <option value="America/New_York">America/New_York (EST)</option>
            <option value="America/Chicago">America/Chicago (CST)</option>
            <option value="America/Denver">America/Denver (MST)</option>
            <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
            <option value="Europe/London">Europe/London (GMT)</option>
            <option value="Europe/Paris">Europe/Paris (CET)</option>
            <option value="Australia/Sydney">Australia/Sydney (AEDT)</option>
            <option value="UTC">UTC</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Date Format</label>
          <select
            value={settings.date_format}
            onChange={(e) => handleChange("date_format", e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          >
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="YYYY-MM-DD">YYYY-MM-DD</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Currency Symbol</label>
          <input
            type="text"
            value={settings.currency_symbol}
            onChange={(e) => handleChange("currency_symbol", e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Primary Color</label>
          <input
            type="color"
            value={settings.primary_color}
            onChange={(e) => handleChange("primary_color", e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 h-10"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Secondary Color</label>
          <input
            type="color"
            value={settings.secondary_color}
            onChange={(e) => handleChange("secondary_color", e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 h-10"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Font Family</label>
          <select
            value={settings.font_family}
            onChange={(e) => handleChange("font_family", e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          >
            <option value="system-ui">System UI</option>
            <option value="Arial">Arial</option>
            <option value="Georgia">Georgia</option>
            <option value="Times New Roman">Times New Roman</option>
            <option value="Courier New">Courier New</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.email_notifications_enabled}
              onChange={(e) => handleChange("email_notifications_enabled", e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-gray-700">Enable Email Notifications</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.sms_notifications_enabled}
              onChange={(e) => handleChange("sms_notifications_enabled", e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-gray-700">Enable SMS Notifications</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.push_notifications_enabled}
              onChange={(e) => handleChange("push_notifications_enabled", e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-gray-700">Enable Push Notifications</span>
          </label>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded-lg"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      <hr className="my-6 border-gray-200" />

      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">Chat Widget Setup</h3>
        <p className="text-xs text-gray-500">Configure who the embedded website chat widget represents and generate the embed code.</p>

        {widgetError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-xs">{widgetError}</div>
        )}
        {widgetSuccess && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded-lg text-xs">{widgetSuccess}</div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Who does this chat represent?</label>
          <div className="space-y-1">
            {(["brokerage", "team", "agent"] as const).map((t) => (
              <label key={t} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="widget_owner_type"
                  value={t}
                  checked={widgetScope.owner_type === t}
                  onChange={() => {
                    const firstMatch = t === "agent"
                      ? widgetAgents[0]?.id ?? ""
                      : t === "team"
                      ? widgetTeams[0]?.id ?? ""
                      : (settings as any)?.brokerage_id ?? ""
                    setWidgetScope((prev) => ({ ...prev, owner_type: t, owner_id: firstMatch }))
                  }}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-700 capitalize">{t === "brokerage" ? "Our Brokerage" : t === "team" ? "A Team" : "A Specific Agent"}</span>
              </label>
            ))}
          </div>
        </div>

        {widgetScope.owner_type === "agent" && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Agent</label>
            <select
              value={widgetScope.owner_id}
              onChange={(e) => {
                const agent = widgetAgents.find((a) => a.id === e.target.value)
                setWidgetScope((prev) => ({ ...prev, owner_id: e.target.value, display_name: agent?.name ?? prev.display_name }))
              }}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            >
              <option value="">Select an agent…</option>
              {widgetAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        )}

        {widgetScope.owner_type === "team" && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Team</label>
            <select
              value={widgetScope.owner_id}
              onChange={(e) => {
                const team = widgetTeams.find((t) => t.id === e.target.value)
                setWidgetScope((prev) => ({ ...prev, owner_id: e.target.value, display_name: team?.name ?? prev.display_name }))
              }}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            >
              <option value="">Select a team…</option>
              {widgetTeams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
          <input
            type="text"
            value={widgetScope.display_name}
            onChange={(e) => setWidgetScope((prev) => ({ ...prev, display_name: e.target.value }))}
            placeholder="e.g. Keller Williams Austin or Sarah Miller"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <button
          onClick={handleWidgetSave}
          disabled={widgetSaving}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm font-medium py-2 px-4 rounded-lg"
        >
          {widgetSaving ? "Saving..." : "Save Widget Settings"}
        </button>

        {widgetScope.owner_id && widgetScope.display_name && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Embed Code</label>
            <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-all">
{`<script>
  (function(w,d,s,o){
    var j=d.createElement(s);j.async=true;
    j.src='${typeof window !== "undefined" ? window.location.origin : ""}/widget/loader.js';
    j.setAttribute('data-scope','${widgetScope.owner_type}');
    j.setAttribute('data-id','${widgetScope.owner_id}');
    j.setAttribute('data-brokerage','${(settings as any)?.brokerage_id ?? ""}');
    d.head.appendChild(j);
  })(window,document,'script');
</script>`}
            </pre>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
