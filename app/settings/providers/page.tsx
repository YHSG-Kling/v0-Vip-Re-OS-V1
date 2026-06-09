'use client'

import React, { useEffect, useState, useTransition } from 'react'
import {
  getProviderSettings,
  getSystemProviderStatus,
  saveProviderOverride,
  type ProviderOverrideRow,
} from '@/app/actions/settings/provider-settings-actions'
import {
  getPlatformVideoProvider,
  setPlatformVideoProvider,
  getVideoCostFallbackConfig,
  setVideoCostFallbackConfig,
} from '@/app/actions/settings/global-settings-actions'

// ─── PROVIDER CATALOGUES ──────────────────────────────────────────────────────

const EMAIL_PROVIDERS  = ['sendgrid', 'postmark', 'mailgun', 'ses', 'smtp']
const SMS_PROVIDERS    = ['twilio', 'signalwire', 'bandwidth']
const PHONE_PROVIDERS  = ['twilio', 'signalwire', 'bandwidth']

const SYSTEM_DEFAULTS: Record<string, string> = {
  email:       'sendgrid',
  sms:         'twilio',
  phone:       'twilio',
  direct_mail: 'lob',
  video:       'heygen',
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

type ChannelState = {
  provider_key: string
  enabled: boolean
  dirty: boolean
}

type PageState = {
  email:       ChannelState
  sms:         ChannelState
  phone:       ChannelState
  direct_mail: ChannelState
  video:       ChannelState
}

function buildInitial(
  overrides: ProviderOverrideRow[],
  channel: string
): ChannelState {
  const row = overrides.find((r) => r.provider_type === channel)
  return {
    provider_key: row?.provider_key ?? SYSTEM_DEFAULTS[channel] ?? channel,
    enabled:      row?.enabled ?? (channel !== 'direct_mail' && channel !== 'video'),
    dirty:        false,
  }
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function ProviderSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [isSuperadmin, setIsSuperadmin] = useState(false)
  const [directMailAllowed, setDirectMailAllowed] = useState(false)
  const [videoAllowed, setVideoAllowed]           = useState(false)
  const [state, setState] = useState<PageState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedChannel, setSavedChannel] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // Platform video provider state (superadmin only)
  const [platformProvider, setPlatformProviderState] = useState<'did' | 'heygen'>('did')
  const [providerSaving, setProviderSaving] = useState(false)
  const [providerSaved, setProviderSaved] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  // Cost-fallback config — D-ID stays default; HeyGen used only when cheaper + enabled.
  const [costFallbackEnabled, setCostFallbackEnabled] = useState(false)
  const [didCostPerMin, setDidCostPerMin] = useState('0.30')
  const [heygenCostPerMin, setHeygenCostPerMin] = useState('0.50')

  useEffect(() => {
    void (async () => {
      try {
        const [{ overrides, isSuperadmin: isSA }, { directMailEnabled, videoEnabled }, currentProvider, costCfg] =
          await Promise.all([getProviderSettings(), getSystemProviderStatus(), getPlatformVideoProvider(), getVideoCostFallbackConfig()])

        setIsSuperadmin(isSA)
        setDirectMailAllowed(directMailEnabled || isSA)
        setVideoAllowed(videoEnabled || isSA)
        setPlatformProviderState(currentProvider)
        setCostFallbackEnabled(costCfg.enabled)
        setDidCostPerMin(String(costCfg.didCostPerMin))
        setHeygenCostPerMin(String(costCfg.heygenCostPerMin))

        setState({
          email:       buildInitial(overrides, 'email'),
          sms:         buildInitial(overrides, 'sms'),
          phone:       buildInitial(overrides, 'phone'),
          direct_mail: buildInitial(overrides, 'direct_mail'),
          video:       buildInitial(overrides, 'video'),
        })
      } catch {
        setSaveError('Failed to load provider settings.')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  function patch(channel: keyof PageState, partial: Partial<ChannelState>) {
    setState((prev) => prev ? { ...prev, [channel]: { ...prev[channel], ...partial, dirty: true } } : prev)
  }

  function save(channel: keyof PageState) {
    if (!state) return
    const ch = state[channel]
    setSaveError(null)
    setSavedChannel(null)

    startTransition(async () => {
      try {
        await saveProviderOverride({
          provider_type: channel,
          provider_key:  ch.provider_key,
          enabled:       ch.enabled,
        })
        setState((prev) =>
          prev ? { ...prev, [channel]: { ...prev[channel], dirty: false } } : prev
        )
        setSavedChannel(channel)
        setTimeout(() => setSavedChannel(null), 2500)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Save failed')
      }
    })
  }

  async function savePlatformProvider() {
    setProviderSaving(true)
    setProviderError(null)
    setProviderSaved(false)
    try {
      await setPlatformVideoProvider(platformProvider)
      await setVideoCostFallbackConfig({
        enabled: costFallbackEnabled,
        didCostPerMin: parseFloat(didCostPerMin) || 0,
        heygenCostPerMin: parseFloat(heygenCostPerMin) || 0,
      })
      setProviderSaved(true)
      setTimeout(() => setProviderSaved(false), 2500)
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setProviderSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-sm text-gray-500">Loading provider settings…</span>
      </div>
    )
  }

  if (!state) return null

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Provider Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure outbound channel providers for your brokerage. Changes take effect immediately.
        </p>
      </div>

      {saveError && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {saveError}
        </div>
      )}

      {/* ── Platform Video & Voice Provider (superadmin only) ──────────────── */}
      {isSuperadmin && (
        <div className="rounded-xl border bg-white p-6 space-y-4 shadow-sm">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Platform Video &amp; Voice Provider</h2>
            <p className="mt-0.5 text-sm text-gray-500">
              Select the video generation stack used by all agents on this platform. The unchosen provider will be hidden from all user UI.
            </p>
          </div>
          <div className="space-y-3">
            <label className="flex items-start gap-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="radio"
                name="platform_provider"
                value="did"
                checked={platformProvider === 'did'}
                onChange={() => setPlatformProviderState('did')}
                className="mt-1"
              />
              <div>
                <p className="font-medium text-gray-900">D-ID + ElevenLabs <span className="ml-2 text-xs font-normal bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Default — Recommended</span></p>
                <p className="text-sm text-gray-500 mt-0.5">Agents use their own face and cloned voice. Cost-effective and personal.</p>
                <p className="text-xs text-gray-400 mt-1">Requires: DID_API_KEY + ELEVENLABS_API_KEY in environment</p>
              </div>
            </label>
            <label className="flex items-start gap-3 p-4 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
              <input
                type="radio"
                name="platform_provider"
                value="heygen"
                checked={platformProvider === 'heygen'}
                onChange={() => setPlatformProviderState('heygen')}
                className="mt-1"
              />
              <div>
                <p className="font-medium text-gray-900">HeyGen Studio</p>
                <p className="text-sm text-gray-500 mt-0.5">Professional studio avatars and synthetic voices via HeyGen.</p>
                <p className="text-xs text-gray-400 mt-1">Requires: HeyGen API key configured per brokerage</p>
              </div>
            </label>
          </div>

          {/* Cost-gated fallback — D-ID stays the default; HeyGen is used only when it's cheaper. */}
          <div className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={costFallbackEnabled} onChange={(e) => setCostFallbackEnabled(e.target.checked)} />
              <div>
                <p className="text-sm font-medium text-gray-900">Allow HeyGen as a cost fallback</p>
                <p className="text-xs text-gray-500">Keeps D-ID as the default. Only switches to HeyGen when its price per minute is strictly lower than D-ID&apos;s.</p>
              </div>
            </label>
            <div className="grid grid-cols-2 gap-3 pl-6">
              <label className="text-xs text-gray-600">
                D-ID $/min
                <input type="number" step="0.01" min="0" value={didCostPerMin} onChange={(e) => setDidCostPerMin(e.target.value)} disabled={!costFallbackEnabled}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100" />
              </label>
              <label className="text-xs text-gray-600">
                HeyGen $/min
                <input type="number" step="0.01" min="0" value={heygenCostPerMin} onChange={(e) => setHeygenCostPerMin(e.target.value)} disabled={!costFallbackEnabled}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100" />
              </label>
            </div>
            <p className="text-[11px] text-gray-400 pl-6">
              {costFallbackEnabled
                ? ((parseFloat(heygenCostPerMin) || 0) < (parseFloat(didCostPerMin) || 0)
                    ? 'Current prices → HeyGen is cheaper; eligible renders would use HeyGen.'
                    : 'Current prices → D-ID is cheapest; D-ID stays in use.')
                : 'Disabled → D-ID is always used (the default differentiator).'}
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              disabled={providerSaving}
              onClick={savePlatformProvider}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            >
              {providerSaving ? 'Saving…' : 'Save Provider Settings'}
            </button>
            {providerSaved && <span className="text-sm text-green-600 font-medium">Saved</span>}
            {providerError && <span className="text-sm text-red-600">{providerError}</span>}
          </div>
        </div>
      )}

      {/* ── Email ─────────────────────────────────────────────────────────── */}
      <ChannelCard
        title="Email"
        description="Provider used for all outbound transactional and marketing emails."
        channel="email"
        providerOptions={EMAIL_PROVIDERS}
        channelState={state.email}
        locked={false}
        isSuperadmin={isSuperadmin}
        saved={savedChannel === 'email'}
        pending={isPending}
        onChange={(partial) => patch('email', partial)}
        onSave={() => save('email')}
      />

      {/* ── SMS ───────────────────────────────────────────────────────────── */}
      <ChannelCard
        title="SMS"
        description="Provider used for outbound SMS messages."
        channel="sms"
        providerOptions={SMS_PROVIDERS}
        channelState={state.sms}
        locked={false}
        isSuperadmin={isSuperadmin}
        saved={savedChannel === 'sms'}
        pending={isPending}
        onChange={(partial) => patch('sms', partial)}
        onSave={() => save('sms')}
      />

      {/* ── Phone / Voice ─────────────────────────────────────────────────── */}
      <ChannelCard
        title="Phone / Voice"
        description="Provider used for outbound AI voice and call routing."
        channel="phone"
        providerOptions={PHONE_PROVIDERS}
        channelState={state.phone}
        locked={false}
        isSuperadmin={isSuperadmin}
        saved={savedChannel === 'phone'}
        pending={isPending}
        onChange={(partial) => patch('phone', partial)}
        onSave={() => save('phone')}
      />

      {/* ── Direct Mail ───────────────────────────────────────────────────── */}
      <ChannelCard
        title="Direct Mail"
        description={
          directMailAllowed
            ? 'Direct mail via Lob. Enabled by superadmin — contact details only.'
            : 'Direct mail is not enabled for this brokerage. Contact your superadmin.'
        }
        channel="direct_mail"
        providerOptions={['lob']}
        channelState={state.direct_mail}
        locked={!directMailAllowed}
        isSuperadmin={isSuperadmin}
        saved={savedChannel === 'direct_mail'}
        pending={isPending}
        onChange={(partial) => patch('direct_mail', partial)}
        onSave={() => save('direct_mail')}
      />

      {/* ── Video ─────────────────────────────────────────────────────────── */}
      <ChannelCard
        title="Video"
        description={
          videoAllowed
            ? 'AI video sending via HeyGen. Enabled by superadmin.'
            : 'Video sending is not enabled for this brokerage. Contact your superadmin.'
        }
        channel="video"
        providerOptions={['heygen']}
        channelState={state.video}
        locked={!videoAllowed}
        isSuperadmin={isSuperadmin}
        saved={savedChannel === 'video'}
        pending={isPending}
        onChange={(partial) => patch('video', partial)}
        onSave={() => save('video')}
      />
    </div>
  )
}

// ─── CHANNEL CARD COMPONENT ───────────────────────────────────────────────────

type ChannelCardProps = {
  title: string
  description: string
  channel: string
  providerOptions: string[]
  channelState: ChannelState
  locked: boolean
  isSuperadmin: boolean
  saved: boolean
  pending: boolean
  onChange: (partial: Partial<ChannelState>) => void
  onSave: () => void
}

function ChannelCard({
  title,
  description,
  providerOptions,
  channelState,
  locked,
  saved,
  pending,
  onChange,
  onSave,
}: ChannelCardProps) {
  const isDisabled = locked || pending

  return (
    <div className={`rounded-xl border bg-white p-6 space-y-4 shadow-sm ${locked ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <p className="mt-0.5 text-sm text-gray-500">{description}</p>
        </div>
        {locked && (
          <span className="shrink-0 inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
            Superadmin only
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        {/* Provider select */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">
            Provider
          </label>
          <select
            disabled={isDisabled}
            value={channelState.provider_key}
            onChange={(e) => onChange({ provider_key: e.target.value })}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50"
          >
            {providerOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>

        {/* Enabled toggle */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">
            Status
          </label>
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => onChange({ enabled: !channelState.enabled })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed ${
              channelState.enabled ? 'bg-blue-600' : 'bg-gray-300'
            }`}
            aria-pressed={channelState.enabled}
            aria-label={channelState.enabled ? 'Enabled' : 'Disabled'}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                channelState.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className="text-xs text-gray-500">{channelState.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
      </div>

      {/* Save row */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          disabled={isDisabled || !channelState.dirty}
          onClick={onSave}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {saved && (
          <span className="text-sm text-green-600 font-medium">Saved</span>
        )}
      </div>
    </div>
  )
}
