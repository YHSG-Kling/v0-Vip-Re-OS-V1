"use client"

/**
 * app/settings/channel-presets/client.tsx
 *
 * Wave 38 — single page that manages all 7 channel preset tables via
 * tabs. Each tab renders a list of presets in that channel + a per-
 * channel editor form with the right fields. Compliance violations
 * surface inline.
 */

import { useState, useTransition } from "react"
import {
  upsertChannelPreset,
  deactivateChannelPreset,
  type PresetChannel,
  type ChannelPresetRow,
  type UpsertChannelPresetInput,
} from "@/app/actions/channel-presets"

interface AccessProp {
  canEditAgent:     boolean
  canEditTeam:      boolean
  canEditBrokerage: boolean
  agentScopeId:     string | null
  teamScopeIds:     string[]
  brokerageScopeId: string | null
}

const CHANNEL_LABEL: Record<PresetChannel, string> = {
  email:           "Email",
  sms:             "SMS",
  social_post:     "Social",
  voicedrop:       "Voicedrop",
  podcast_episode: "Podcast",
  ad_retarget:     "Ad Retarget",
  portal_push:     "Portal Push",
}

const CHANNEL_GATE_NOTE: Record<PresetChannel, string> = {
  email:           "Fair Housing + Them-First gate runs at save.",
  sms:             "Fair Housing + Them-First gate runs at save. TCPA still applies at dispatch.",
  social_post:     "Fair Housing + Them-First gate runs at save.",
  voicedrop:       "Fair Housing + Them-First gate runs against the TTS script at save. TCPA still applies at dispatch.",
  podcast_episode: "No content gate at preset level — episode content was gated at episode creation.",
  ad_retarget:     "Fair Housing + Them-First gate runs against headline + body + CTA at save.",
  portal_push:     "No content gate — portal cards are internal client surfaces.",
}

const CHANNELS: PresetChannel[] = [
  "email", "sms", "social_post", "voicedrop",
  "podcast_episode", "ad_retarget", "portal_push",
]

type PresetsByChannel = Record<PresetChannel, ChannelPresetRow[]>

export function ChannelPresetsClient({
  initialPresets, loadErrors, access,
}: {
  initialPresets: PresetsByChannel
  loadErrors:     string[]
  access:         AccessProp
}) {
  const [activeTab, setActiveTab] = useState<PresetChannel>("email")
  const [presets, setPresets] = useState<PresetsByChannel>(initialPresets)
  const [editing, setEditing] = useState<ChannelPresetRow | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [violations, setViolations] = useState<string[] | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSave(input: UpsertChannelPresetInput, presetId?: string) {
    setError(null); setViolations(null)
    startTransition(async () => {
      const r = await upsertChannelPreset(activeTab, { ...input, id: presetId })
      if (!r.success) {
        if (r.violations) setViolations(r.violations)
        setError(r.error ?? "Save failed")
        return
      }
      setEditing(null); setShowCreate(false)
      if (typeof window !== "undefined") window.location.reload()
    })
  }

  function handleDeactivate(channel: PresetChannel, id: string) {
    setError(null)
    startTransition(async () => {
      const r = await deactivateChannelPreset(channel, id)
      if (!r.success) { setError(r.error ?? "Deactivate failed"); return }
      setPresets((prev) => ({
        ...prev,
        [channel]: prev[channel].map((p) => p.id === id ? { ...p, is_active: false } : p),
      }))
    })
  }

  const channelPresets = presets[activeTab] ?? []
  const active   = channelPresets.filter((p) => p.is_active)
  const inactive = channelPresets.filter((p) => !p.is_active)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Channel Presets</h1>
        <p className="text-gray-600 mt-2 max-w-2xl">
          Locked creative for every bundle channel. Each preset is gated for compliance
          once at save; the bundle dispatcher fires saved presets verbatim.
        </p>
      </header>

      {loadErrors.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 text-amber-900 rounded text-xs">
          <div className="font-medium mb-1">Some channels failed to load:</div>
          <ul className="list-disc list-inside">{loadErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      <div className="flex border-b border-gray-200 overflow-x-auto">
        {CHANNELS.map((c) => (
          <button key={c}
            onClick={() => { setActiveTab(c); setError(null); setViolations(null) }}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
              activeTab === c
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}>
            {CHANNEL_LABEL[c]} ({presets[c]?.length ?? 0})
          </button>
        ))}
      </div>

      <p className="text-xs text-gray-500 italic">{CHANNEL_GATE_NOTE[activeTab]}</p>

      <div className="flex justify-end">
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
        >+ New {CHANNEL_LABEL[activeTab].toLowerCase()} preset</button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">{error}</div>
      )}
      {violations && violations.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 text-amber-900 rounded text-sm">
          <div className="font-medium mb-1">Compliance gate blocked the copy:</div>
          <ul className="list-disc list-inside text-xs">
            {violations.map((v, i) => <li key={i}>{v}</li>)}
          </ul>
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Active ({active.length})</h2>
        {active.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No active presets in this channel. Click the button above to build one.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {active.map((p) => (
              <PresetCard
                key={p.id} channel={activeTab} preset={p}
                onEdit={() => setEditing(p)}
                onDeactivate={() => handleDeactivate(activeTab, p.id)}
                pending={pending}
              />
            ))}
          </div>
        )}
      </section>

      {inactive.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Inactive ({inactive.length})</h2>
          <ul className="text-xs text-gray-500 space-y-1">
            {inactive.map((p) => <li key={p.id}>{p.name} · {p.scope_type}</li>)}
          </ul>
        </section>
      )}

      {(showCreate || editing) && (
        <PresetEditor
          channel={activeTab}
          initial={editing}
          access={access}
          onClose={() => { setEditing(null); setShowCreate(false); setError(null); setViolations(null) }}
          onSave={handleSave}
          pending={pending}
        />
      )}
    </div>
  )
}

function PresetCard({ channel, preset, onEdit, onDeactivate, pending }: {
  channel:      PresetChannel
  preset:       ChannelPresetRow
  onEdit:       () => void
  onDeactivate: () => void
  pending:      boolean
}) {
  const p = preset.payload
  const summary = (() => {
    switch (channel) {
      case "email":           return String(p.subject ?? "")
      case "sms":             return String(p.body ?? "").slice(0, 140)
      case "social_post":     return `${((p.target_platforms as string[]) ?? []).join(", ")} · ${String(p.caption ?? "").slice(0, 80)}`
      case "voicedrop":       return p.audio_url ? "uploaded audio" : String(p.tts_script ?? "").slice(0, 100)
      case "portal_push":     return `${String(p.priority ?? "normal")} · ${String(p.title ?? "")}`
      case "podcast_episode": return p.podcast_episode_id ? `bound to ${String(p.podcast_episode_id).slice(0, 8)}…` : "(no episode bound)"
      case "ad_retarget":     return `${String(p.ad_headline ?? "")} · $${(((p.daily_budget_cents as number) ?? 0) / 100).toFixed(0)}/day`
    }
  })()
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <h3 className="font-semibold text-gray-900">{preset.name}</h3>
      <div className="flex flex-wrap gap-1 mt-1">
        <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">{preset.scope_type}</span>
        {preset.compliance_event_id && (
          <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700">Compliance: passed</span>
        )}
      </div>
      {summary && <p className="mt-2 text-sm text-gray-700 line-clamp-2">{summary}</p>}
      <div className="flex gap-2 mt-3 justify-end">
        <button onClick={onEdit} disabled={pending}
          className="text-xs px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50">Edit</button>
        <button onClick={onDeactivate} disabled={pending}
          className="text-xs px-3 py-1 border border-gray-200 rounded text-red-600 hover:bg-red-50 disabled:opacity-50">Deactivate</button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// Editor: scope picker + per-channel fields
// ──────────────────────────────────────────────────────────────────

function PresetEditor({ channel, initial, access, onClose, onSave, pending }: {
  channel:  PresetChannel
  initial:  ChannelPresetRow | null
  access:   AccessProp
  onClose:  () => void
  onSave:   (input: UpsertChannelPresetInput, presetId?: string) => void
  pending:  boolean
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [scopeType, setScopeType] = useState<"agent" | "team" | "brokerage">(
    initial?.scope_type
    ?? (access.canEditBrokerage ? "brokerage"
        : access.canEditTeam     ? "team"
        : "agent")
  )
  const [scopeId, setScopeId] = useState<string>(
    initial?.scope_id
    ?? (access.canEditBrokerage ? (access.brokerageScopeId ?? "")
        : access.canEditTeam     ? (access.teamScopeIds[0] ?? "")
        : (access.agentScopeId ?? ""))
  )
  const [payload, setPayload] = useState<Record<string, unknown>>(initial?.payload ?? {})

  function setField<K extends string>(key: K, value: unknown) {
    setPayload((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSave({
      name,
      scope_type: scopeType,
      scope_id: scopeId,
      payload,
    }, initial?.id)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-xl max-w-3xl w-full p-6 my-6 space-y-4">
        <header className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-900">
            {initial ? `Edit ${CHANNEL_LABEL[channel].toLowerCase()} preset` : `New ${CHANNEL_LABEL[channel].toLowerCase()} preset`}
          </h2>
          <button type="button" onClick={onClose} className="text-2xl text-gray-400 hover:text-gray-700">×</button>
        </header>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Just Listed Email Blast"
              className="w-full border rounded px-3 py-1.5" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Scope</span>
            <select value={scopeType}
              onChange={(e) => {
                const next = e.target.value as "agent" | "team" | "brokerage"
                setScopeType(next)
                if (next === "agent")     setScopeId(access.agentScopeId ?? "")
                if (next === "team")      setScopeId(access.teamScopeIds[0] ?? "")
                if (next === "brokerage") setScopeId(access.brokerageScopeId ?? "")
              }}
              className="w-full border rounded px-3 py-1.5">
              {access.canEditAgent     && <option value="agent">Agent (mine)</option>}
              {access.canEditTeam      && <option value="team">Team</option>}
              {access.canEditBrokerage && <option value="brokerage">Brokerage</option>}
            </select>
          </label>
        </div>

        {scopeType === "team" && access.teamScopeIds.length > 1 && (
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Team</span>
            <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}
              className="w-full border rounded px-3 py-1.5 font-mono text-xs">
              {access.teamScopeIds.map((tid) => <option key={tid} value={tid}>{tid}</option>)}
            </select>
          </label>
        )}

        <ChannelFields channel={channel} payload={payload} setField={setField} />

        <div className="flex justify-end gap-2 border-t pt-3">
          <button type="button" onClick={onClose}
            className="px-4 py-2 border rounded text-sm hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={pending}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {pending ? "Saving…" : (initial ? "Save changes" : "Run gate + save")}
          </button>
        </div>
      </form>
    </div>
  )
}

function ChannelFields({ channel, payload, setField }: {
  channel:  PresetChannel
  payload:  Record<string, unknown>
  setField: (key: string, value: unknown) => void
}) {
  const get = (k: string, fallback = "") => String(payload[k] ?? fallback)

  switch (channel) {
    case "email":
      return (
        <>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Subject</span>
            <input required value={get("subject")}
              onChange={(e) => setField("subject", e.target.value)}
              className="w-full border rounded px-3 py-1.5" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Body (HTML)</span>
            <textarea required rows={8} value={get("body_html")}
              onChange={(e) => setField("body_html", e.target.value)}
              className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Body (plain text fallback)</span>
            <textarea rows={4} value={get("body_text")}
              onChange={(e) => setField("body_text", e.target.value || null)}
              className="w-full border rounded px-3 py-1.5 text-xs" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block text-xs text-gray-700 mb-1">From name override</span>
              <input value={get("from_name_override")}
                onChange={(e) => setField("from_name_override", e.target.value || null)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-700 mb-1">Reply-to override</span>
              <input type="email" value={get("reply_to_override")}
                onChange={(e) => setField("reply_to_override", e.target.value || null)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
          </div>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Channel purpose</span>
            <select value={get("channel_purpose", "campaign")}
              onChange={(e) => setField("channel_purpose", e.target.value)}
              className="w-full border rounded px-3 py-1.5">
              <option value="conversation">Conversation</option>
              <option value="campaign">Campaign</option>
              <option value="update">Update</option>
              <option value="transactional">Transactional</option>
            </select>
          </label>
        </>
      )

    case "sms":
      return (
        <label className="text-sm block">
          <span className="block text-xs text-gray-700 mb-1">Body (160-char target; provider may segment)</span>
          <textarea required rows={4} value={get("body")}
            onChange={(e) => setField("body", e.target.value)}
            className="w-full border rounded px-3 py-1.5" />
          <span className="block text-xs text-gray-500 mt-1">{get("body").length} chars</span>
        </label>
      )

    case "social_post": {
      const platforms = (payload.target_platforms as string[]) ?? []
      const ALL_PLATFORMS = ["facebook","instagram","linkedin","twitter","tiktok","youtube_shorts","pinterest","google_business"] as const
      const mediaUrls = ((payload.media_urls as string[]) ?? []).join("\n")
      return (
        <>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Caption (canonical — overridden per-platform below)</span>
            <textarea required rows={5} value={get("caption")}
              onChange={(e) => setField("caption", e.target.value)}
              className="w-full border rounded px-3 py-1.5" />
          </label>
          <div className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Target platforms</span>
            <div className="flex flex-wrap gap-2">
              {ALL_PLATFORMS.map((plat) => {
                const checked = platforms.includes(plat)
                return (
                  <label key={plat} className="text-xs flex items-center gap-1 px-2 py-1 border border-gray-200 rounded">
                    <input type="checkbox" checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...platforms, plat]
                          : platforms.filter((p) => p !== plat)
                        setField("target_platforms", next)
                      }} />
                    {plat}
                  </label>
                )
              })}
            </div>
          </div>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Media URLs (one per line, optional)</span>
            <textarea rows={2} value={mediaUrls}
              onChange={(e) => setField("media_urls", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
              placeholder="https://..."
              className="w-full border rounded px-3 py-1.5 text-xs font-mono" />
          </label>
        </>
      )
    }

    case "voicedrop":
      return (
        <>
          <p className="text-xs text-gray-500 italic">
            Provide either a TTS script (we synthesize with the agent&apos;s cloned voice) OR a hosted audio URL.
          </p>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">TTS script</span>
            <textarea rows={6} value={get("tts_script")}
              onChange={(e) => setField("tts_script", e.target.value || null)}
              placeholder="Hi {{first_name}}, this is …"
              className="w-full border rounded px-3 py-1.5" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Audio URL (alternative to TTS)</span>
            <input type="url" value={get("audio_url")}
              onChange={(e) => setField("audio_url", e.target.value || null)}
              placeholder="https://blob.../voicemail.mp3"
              className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">ElevenLabs voice ID override (defaults to agent&apos;s clone)</span>
            <input value={get("voice_id_override")}
              onChange={(e) => setField("voice_id_override", e.target.value || null)}
              className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
          </label>
        </>
      )

    case "portal_push":
      return (
        <>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Title</span>
            <input required value={get("title")}
              onChange={(e) => setField("title", e.target.value)}
              className="w-full border rounded px-3 py-1.5" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Body (Markdown)</span>
            <textarea required rows={6} value={get("body_md")}
              onChange={(e) => setField("body_md", e.target.value)}
              className="w-full border rounded px-3 py-1.5 text-xs font-mono" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block text-xs text-gray-700 mb-1">CTA label</span>
              <input value={get("cta_label")}
                onChange={(e) => setField("cta_label", e.target.value || null)}
                className="w-full border rounded px-3 py-1.5" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-700 mb-1">CTA URL</span>
              <input type="url" value={get("cta_url")}
                onChange={(e) => setField("cta_url", e.target.value || null)}
                className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
            </label>
          </div>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Priority</span>
            <select value={get("priority", "normal")}
              onChange={(e) => setField("priority", e.target.value)}
              className="w-full border rounded px-3 py-1.5">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        </>
      )

    case "podcast_episode": {
      const channels = ((payload.target_distribution_channels as string[]) ?? []).join(", ")
      return (
        <>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Podcast episode ID (leave blank to bind later)</span>
            <input value={get("podcast_episode_id")}
              onChange={(e) => setField("podcast_episode_id", e.target.value || null)}
              placeholder="uuid…"
              className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Target distribution channels (comma-separated)</span>
            <input value={channels}
              onChange={(e) => setField("target_distribution_channels", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
              placeholder="spotify, apple_podcasts, youtube"
              className="w-full border rounded px-3 py-1.5 text-xs" />
          </label>
        </>
      )
    }

    case "ad_retarget":
      return (
        <>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Facebook custom audience ID</span>
            <input value={get("facebook_audience_id")}
              onChange={(e) => setField("facebook_audience_id", e.target.value || null)}
              placeholder="uuid… (must already exist in facebook_custom_audiences)"
              className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Ad headline</span>
            <input required value={get("ad_headline")}
              onChange={(e) => setField("ad_headline", e.target.value)}
              className="w-full border rounded px-3 py-1.5" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Ad body</span>
            <textarea required rows={4} value={get("ad_body")}
              onChange={(e) => setField("ad_body", e.target.value)}
              className="w-full border rounded px-3 py-1.5" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block text-xs text-gray-700 mb-1">CTA</span>
              <input value={get("ad_cta")}
                onChange={(e) => setField("ad_cta", e.target.value || null)}
                placeholder="LEARN_MORE / SIGN_UP / CONTACT_US"
                className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-gray-700 mb-1">Daily budget ($)</span>
              <input type="number" min={1} step={1}
                value={Math.round(((payload.daily_budget_cents as number) ?? 1000) / 100)}
                onChange={(e) => setField("daily_budget_cents", Math.max(100, (parseInt(e.target.value, 10) || 10) * 100))}
                className="w-full border rounded px-3 py-1.5" />
            </label>
          </div>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Ad image URL</span>
            <input type="url" value={get("ad_image_url")}
              onChange={(e) => setField("ad_image_url", e.target.value || null)}
              placeholder="https://..."
              className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
          </label>
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Landing URL</span>
            <input type="url" value={get("ad_landing_url")}
              onChange={(e) => setField("ad_landing_url", e.target.value || null)}
              placeholder="https://..."
              className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
          </label>
        </>
      )
  }
}
