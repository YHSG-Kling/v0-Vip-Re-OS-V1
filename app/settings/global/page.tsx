"use client"

import React, { useEffect, useState } from "react"
import { fetchGlobalSettings, updateSettings } from "@/app/actions/settings/global-settings-actions"
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

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchGlobalSettings()
        setSettings(data)
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
          <label className="block text-sm font-medium text-gray-700 mb-1">App Name</label>
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
    </SettingsCard>
  )
}
