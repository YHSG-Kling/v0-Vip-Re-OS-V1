"use client"

/**
 * app/settings/campaign-bundles/client.tsx
 *
 * Wave 38 — bundle builder UI. A bundle composes N (channel, preset)
 * items in order with a per-item send-after-delay. The dispatcher fires
 * each item in sequence; the per-preset compliance gate already ran at
 * preset-save time, so bundling is pure orchestration.
 *
 * Builder model:
 *   · Pick scope (agent / team / brokerage) — only tiers the caller
 *     has edit access to are offered
 *   · Add items: each is (channel, preset, send_after_minutes)
 *   · Reorder with up/down — order_index = position in list at save
 *   · Picker filters the preset catalog by channel so the user only
 *     sees presets that actually match the selected kind
 */

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  upsertCampaignBundle,
  deactivateCampaignBundle,
  type BundleRow,
  type BundleChannel,
  type PresetCatalog,
  type UpsertBundleInput,
} from "@/app/actions/campaign-bundles"
import { upsertCampaignPreset, type PresetChannel } from "@/app/actions/campaign-presets"

interface AccessProp {
  canEditAgent:     boolean
  canEditTeam:      boolean
  canEditBrokerage: boolean
  agentScopeId:     string | null
  teamScopeIds:     string[]
  brokerageScopeId: string | null
}

const CHANNEL_LABEL: Record<BundleChannel, string> = {
  direct_mail_postcard: "Postcard",
  direct_mail_letter:   "Letter",
  email:                "Email",
  sms:                  "SMS",
  voicedrop:            "Voicedrop (ringless VM)",
  social_post:          "Social post",
  podcast_episode:      "Podcast episode",
  ad_retarget:          "Ad retarget",
  portal_push:          "Portal push",
}

const CHANNEL_ORDER: BundleChannel[] = [
  "direct_mail_postcard",
  "direct_mail_letter",
  "email",
  "sms",
  "voicedrop",
  "social_post",
  "podcast_episode",
  "ad_retarget",
  "portal_push",
]

export function CampaignBundlesClient({
  initialBundles, catalog, access,
}: {
  initialBundles: BundleRow[]
  catalog:        PresetCatalog
  access:         AccessProp
}) {
  const [bundles, setBundles] = useState(initialBundles)
  const [editing, setEditing] = useState<BundleRow | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showQuickPreset, setShowQuickPreset] = useState(false)
  const [qpChannel, setQpChannel] = useState<PresetChannel>("sms")
  const [qpName, setQpName] = useState("")
  const [qpContent, setQpContent] = useState("")
  const [qpMedia, setQpMedia] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleSave(input: UpsertBundleInput, bundleId?: string) {
    setError(null)
    startTransition(async () => {
      const r = await upsertCampaignBundle({ ...input, id: bundleId })
      if (!r.success) {
        setError(r.error ?? "Save failed")
        return
      }
      setEditing(null); setShowCreate(false)
      // router.refresh re-renders the page's RSC tree with fresh data
      // without unmounting the client tree — preserves scroll + the
      // rest of client state, unlike a full window.location.reload.
      router.refresh()
    })
  }

  function handleDeactivate(id: string) {
    setError(null)
    startTransition(async () => {
      const r = await deactivateCampaignBundle(id)
      if (!r.success) { setError(r.error ?? "Deactivate failed"); return }
      setBundles((prev) => prev.map((b) => b.id === id ? { ...b, is_active: false } : b))
    })
  }

  // QUICK PRESET — the canonical writer for the seven preset shelves this
  // builder composes from (writer-less burn-down: the shelves were read-only).
  // One primary content field per channel; the action compliance-gates at save.
  const QP_FIELD: Record<PresetChannel, string> = {
    email: "body_text", sms: "body", voicedrop: "tts_script",
    social_post: "caption", portal_push: "body_md",
    podcast_episode: "tts_script", ad_retarget: "ad_body",
    blog_post: "content", facebook_audience: "audience_type",
  }
  // Channels that carry a media/video attachment (owner spec: ads carry video,
  // social carries media, email/SMS carry a video link, voicedrop carries audio).
  const QP_MEDIA_FIELD: Partial<Record<PresetChannel, { key: string; label: string; asArray?: boolean }>> = {
    email: { key: "video_url", label: "Video URL (optional)" },
    sms: { key: "video_url", label: "Video link (optional)" },
    social_post: { key: "media_urls", label: "Media URL (optional)", asArray: true },
    ad_retarget: { key: "ad_video_url", label: "Video creative URL (optional)" },
    voicedrop: { key: "audio_url", label: "Audio URL (optional — else the script is voiced)" },
    podcast_episode: { key: "voice_id_override", label: "Voice ID (optional — else the agent's clone)" },
    blog_post: { key: "featured_image_url", label: "Featured image URL (optional)" },
  }
  function handleQuickPreset() {
    setError(null)
    startTransition(async () => {
      const media = QP_MEDIA_FIELD[qpChannel]
      const fields: Record<string, unknown> = { [QP_FIELD[qpChannel]]: qpContent }
      if (media && qpMedia.trim()) fields[media.key] = media.asArray ? [qpMedia.trim()] : qpMedia.trim()
      const r = await upsertCampaignPreset({
        channel: qpChannel,
        name: qpName,
        fields,
      })
      if (!r.success) { setError(r.error === "compliance_gate_blocked" ? "Blocked by the compliance gate — revise the copy." : (r.error ?? "Save failed")); return }
      setShowQuickPreset(false); setQpName(""); setQpContent(""); setQpMedia("")
      router.refresh()
    })
  }

  const active   = bundles.filter((b) => b.is_active)
  const inactive = bundles.filter((b) => !b.is_active)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campaign Bundles</h1>
          <p className="text-gray-600 mt-2 max-w-2xl">
            A bundle is a coordinated multi-channel campaign — postcard + email + social,
            voicedrop + SMS, ad retarget + portal push. Compose existing presets in
            order with per-step delays; one dispatch fires them all as a unit and
            cross-channel attribution rolls up automatically.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowQuickPreset((v) => !v)}
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded hover:bg-gray-50 whitespace-nowrap"
          >+ Quick preset</button>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 whitespace-nowrap"
          >+ New bundle</button>
        </div>
      </header>

      {showQuickPreset && (
        <section className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">New preset — saved to the shelf this builder composes from (compliance-gated on save)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select
              value={qpChannel}
              onChange={(e) => setQpChannel(e.target.value as PresetChannel)}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
            >
              <option value="sms">SMS</option>
              <option value="email">Email</option>
              <option value="voicedrop">Voicedrop</option>
              <option value="social_post">Social post</option>
              <option value="portal_push">Portal push</option>
              <option value="ad_retarget">Ad retarget</option>
              <option value="podcast_episode">Podcast episode</option>
              <option value="blog_post">Blog post</option>
              <option value="facebook_audience">Facebook audience</option>
            </select>
            <input
              value={qpName}
              onChange={(e) => setQpName(e.target.value)}
              placeholder="Preset name"
              className="border border-gray-300 rounded px-2 py-1.5 text-sm sm:col-span-2"
            />
          </div>
          <textarea
            value={qpContent}
            onChange={(e) => setQpContent(e.target.value)}
            placeholder="The copy this preset sends (gated by Fair Housing + brand rules on save)"
            rows={3}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
          {QP_MEDIA_FIELD[qpChannel] && (
            <input
              value={qpMedia}
              onChange={(e) => setQpMedia(e.target.value)}
              placeholder={QP_MEDIA_FIELD[qpChannel]!.label}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            />
          )}
          <div className="flex gap-2">
            <button
              onClick={handleQuickPreset}
              disabled={pending || !qpName.trim() || !qpContent.trim()}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded disabled:opacity-50"
            >{pending ? "Saving…" : "Save preset"}</button>
            <button onClick={() => setShowQuickPreset(false)} className="px-3 py-1.5 text-sm text-gray-600">Cancel</button>
          </div>
        </section>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">{error}</div>
      )}

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Active bundles ({active.length})</h2>
        {active.length === 0 ? (
          <p className="text-sm text-gray-500 italic">
            No active bundles yet. Click &ldquo;New bundle&rdquo; to compose one from your saved presets.
          </p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {active.map((b) => (
              <BundleCard
                key={b.id} bundle={b} catalog={catalog}
                onEdit={() => setEditing(b)}
                onDeactivate={() => handleDeactivate(b.id)}
                pending={pending}
              />
            ))}
          </div>
        )}
      </section>

      {inactive.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-700 mb-3">Inactive ({inactive.length})</h2>
          <ul className="text-sm text-gray-500 space-y-1">
            {inactive.map((b) => (
              <li key={b.id}>{b.name} · {b.items.length} step{b.items.length === 1 ? "" : "s"} · {b.scope_type}</li>
            ))}
          </ul>
        </section>
      )}

      {(showCreate || editing) && (
        <BundleEditor
          initial={editing}
          catalog={catalog}
          access={access}
          onClose={() => { setEditing(null); setShowCreate(false); setError(null) }}
          onSave={handleSave}
          pending={pending}
        />
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs font-semibold text-gray-900">{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
    </div>
  )
}

function BundleCard({ bundle, catalog, onEdit, onDeactivate, pending }: {
  bundle:       BundleRow
  catalog:      PresetCatalog
  onEdit:       () => void
  onDeactivate: () => void
  pending:      boolean
}) {
  const presetName = (channel: BundleChannel, presetId: string | null): string => {
    if (!presetId) return "(no preset)"
    const list = catalog[channel] ?? []
    return list.find((p) => p.id === presetId)?.name ?? "(preset removed)"
  }
  const p = bundle.performance
  const hasFired = p.dispatch_count > 0
  const leadRate = hasFired ? (p.total_leads / p.dispatch_count) : 0
  const lastFiredLabel = (() => {
    if (!p.last_dispatched_at) return "never fired"
    const days = Math.floor((Date.now() - new Date(p.last_dispatched_at).getTime()) / 86_400_000)
    if (days <= 0) return "today"
    if (days === 1) return "yesterday"
    if (days < 30) return `${days}d ago`
    if (days < 365) return `${Math.floor(days / 30)}mo ago`
    return `${Math.floor(days / 365)}y ago`
  })()
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900">{bundle.name}</h3>
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">{bundle.scope_type}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">{bundle.items.length} step{bundle.items.length === 1 ? "" : "s"}</span>
          </div>
          {bundle.description && (
            <p className="mt-2 text-sm text-gray-600 line-clamp-2">{bundle.description}</p>
          )}
          {/* Performance row — populated daily by the
              bundle-attribution-rollup cron. Shown even when zero so
              the agent can see the bundle has never fired. */}
          <div className="mt-2 grid grid-cols-4 gap-2 border-t pt-2">
            <Metric label="dispatches"  value={p.dispatch_count} />
            <Metric label="scans"       value={p.total_scans}    />
            <Metric label="leads"       value={p.total_leads}    />
            <Metric
              label="lead / send"
              value={hasFired ? leadRate.toFixed(2) : "—"}
            />
          </div>
          <div className="text-xs text-gray-400 mt-1">Last fired: {lastFiredLabel}</div>
          <ol className="mt-3 space-y-1">
            {bundle.items.map((it, idx) => (
              <li key={it.id} className="text-xs text-gray-700 flex gap-2">
                <span className="font-mono text-gray-400">{idx + 1}.</span>
                <span className="font-medium">{CHANNEL_LABEL[it.channel]}</span>
                <span className="text-gray-500 truncate">{presetName(it.channel, it.preset_id)}</span>
                {it.send_after_minutes > 0 && (
                  <span className="text-gray-400">· +{it.send_after_minutes}min</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="flex gap-2 mt-3 justify-end">
        <button onClick={onEdit} disabled={pending}
          className="text-xs px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50">Edit</button>
        <button onClick={onDeactivate} disabled={pending}
          className="text-xs px-3 py-1 border border-gray-200 rounded text-red-600 hover:bg-red-50 disabled:opacity-50">Deactivate</button>
      </div>
    </div>
  )
}

interface EditorItem {
  key:                string  // stable client-side key for list reordering
  channel:            BundleChannel
  preset_id:          string
  send_after_minutes: number
}

let nextKey = 1

function BundleEditor({ initial, catalog, access, onClose, onSave, pending }: {
  initial:  BundleRow | null
  catalog:  PresetCatalog
  access:   AccessProp
  onClose:  () => void
  onSave:   (input: UpsertBundleInput, bundleId?: string) => void
  pending:  boolean
}) {
  const [name, setName]               = useState(initial?.name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [scopeType, setScopeType]     = useState<"agent" | "team" | "brokerage">(
    initial?.scope_type
    ?? (access.canEditBrokerage ? "brokerage"
        : access.canEditTeam     ? "team"
        : "agent")
  )
  // Initial scope_id: only auto-resolve when unambiguous (the caller
  // has exactly one team / is brokerage tier / is a solo agent). When
  // a brokerage admin lands on the team tab with N teams in scope, we
  // leave scopeId empty and force them to pick — silently defaulting
  // to teamScopeIds[0] would let a save land on the wrong team.
  const initialScopeId = (() => {
    if (initial?.scope_id) return initial.scope_id
    if (access.canEditBrokerage) return access.brokerageScopeId ?? ""
    if (access.canEditTeam) {
      if (access.teamScopeIds.length === 1) return access.teamScopeIds[0]
      return ""
    }
    return access.agentScopeId ?? ""
  })()
  const [scopeId, setScopeId] = useState<string>(initialScopeId)
  const [items, setItems] = useState<EditorItem[]>(
    initial
      ? initial.items.map((it) => ({
          key: `existing-${it.id}`,
          channel: it.channel,
          preset_id: it.preset_id ?? "",
          send_after_minutes: it.send_after_minutes,
        }))
      : []
  )
  const [localError, setLocalError] = useState<string | null>(null)

  const teamOptions = useMemo(() => access.teamScopeIds, [access.teamScopeIds])

  function addItem() {
    const firstChannel = CHANNEL_ORDER.find((c) => catalog[c].length > 0) ?? "email"
    const firstPreset  = catalog[firstChannel]?.[0]?.id ?? ""
    setItems((prev) => [
      ...prev,
      { key: `new-${nextKey++}`, channel: firstChannel, preset_id: firstPreset, send_after_minutes: 0 },
    ])
  }
  function removeItem(key: string) { setItems((prev) => prev.filter((i) => i.key !== key)) }
  function moveItem(key: string, dir: -1 | 1) {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.key === key)
      const newIdx = idx + dir
      if (idx < 0 || newIdx < 0 || newIdx >= prev.length) return prev
      const copy = [...prev]
      const [it] = copy.splice(idx, 1)
      copy.splice(newIdx, 0, it)
      return copy
    })
  }
  function updateItem(key: string, patch: Partial<EditorItem>) {
    setItems((prev) => prev.map((i) => i.key === key ? { ...i, ...patch } : i))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLocalError(null)
    if (!name.trim()) { setLocalError("Name required"); return }
    if (scopeType === "team" && !scopeId) { setLocalError("Pick a team"); return }
    if (items.length === 0) { setLocalError("Add at least one item"); return }
    for (const it of items) {
      if (!it.preset_id) { setLocalError(`Pick a preset for the ${CHANNEL_LABEL[it.channel]} item`); return }
    }
    onSave({
      name: name.trim(),
      description: description.trim() || null,
      scope_type: scopeType,
      scope_id: scopeId,
      items: items.map((it) => ({
        channel: it.channel,
        preset_id: it.preset_id,
        order_index: 0,  // server overrides with array index
        send_after_minutes: it.send_after_minutes,
      })),
    }, initial?.id)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-xl max-w-3xl w-full p-6 my-6 space-y-4">
        <header className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-900">{initial ? "Edit bundle" : "New bundle"}</h2>
          <button type="button" onClick={onClose} className="text-2xl text-gray-400 hover:text-gray-700">×</button>
        </header>

        {localError && (
          <div className="p-2 bg-red-50 border border-red-200 text-red-800 rounded text-sm">{localError}</div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Listing Launch Multi-Channel" className="w-full border rounded px-3 py-1.5" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Scope</span>
            <select value={scopeType}
              onChange={(e) => {
                const next = e.target.value as "agent" | "team" | "brokerage"
                setScopeType(next)
                if (next === "agent")     setScopeId(access.agentScopeId ?? "")
                if (next === "brokerage") setScopeId(access.brokerageScopeId ?? "")
                if (next === "team") {
                  // Same rule as initial resolution: auto-pick only
                  // when there's a single team in scope; otherwise
                  // empty + force the dropdown below to be touched.
                  setScopeId(teamOptions.length === 1 ? teamOptions[0] : "")
                }
              }}
              className="w-full border rounded px-3 py-1.5">
              {access.canEditAgent     && <option value="agent">Agent (mine)</option>}
              {access.canEditTeam      && <option value="team">Team</option>}
              {access.canEditBrokerage && <option value="brokerage">Brokerage</option>}
            </select>
          </label>
        </div>

        {scopeType === "team" && teamOptions.length > 1 && (
          <label className="text-sm block">
            <span className="block text-xs text-gray-700 mb-1">Team (required)</span>
            <select required value={scopeId} onChange={(e) => setScopeId(e.target.value)}
              className="w-full border rounded px-3 py-1.5 font-mono text-xs">
              <option value="">— pick a team —</option>
              {teamOptions.map((tid) => <option key={tid} value={tid}>{tid}</option>)}
            </select>
          </label>
        )}

        <label className="text-sm block">
          <span className="block text-xs text-gray-700 mb-1">Description (optional)</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="What this bundle is for + when to use it"
            className="w-full border rounded px-3 py-1.5" />
        </label>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Items ({items.length})</h3>
            <button type="button" onClick={addItem}
              className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">+ Add item</button>
          </div>
          {items.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No items yet. Click &ldquo;Add item&rdquo; to add a channel step.</p>
          ) : (
            <ol className="space-y-2">
              {items.map((it, idx) => (
                <ItemEditor
                  key={it.key} idx={idx} item={it} catalog={catalog}
                  onMove={(dir) => moveItem(it.key, dir)}
                  onRemove={() => removeItem(it.key)}
                  onUpdate={(patch) => updateItem(it.key, patch)}
                  isFirst={idx === 0}
                  isLast={idx === items.length - 1}
                />
              ))}
            </ol>
          )}
        </section>

        <div className="flex justify-end gap-2 border-t pt-3">
          <button type="button" onClick={onClose}
            className="px-4 py-2 border rounded text-sm hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={pending}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {pending ? "Saving…" : (initial ? "Save changes" : "Create bundle")}
          </button>
        </div>
      </form>
    </div>
  )
}

function ItemEditor({ idx, item, catalog, onMove, onRemove, onUpdate, isFirst, isLast }: {
  idx:      number
  item:     EditorItem
  catalog:  PresetCatalog
  onMove:   (dir: -1 | 1) => void
  onRemove: () => void
  onUpdate: (patch: Partial<EditorItem>) => void
  isFirst:  boolean
  isLast:   boolean
}) {
  const channelPresets = catalog[item.channel] ?? []
  const selectedSummary = channelPresets.find((p) => p.id === item.preset_id)?.summary ?? ""
  return (
    <li className="border border-gray-200 rounded p-3 bg-gray-50">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-gray-400 w-6">{idx + 1}.</span>
        <select value={item.channel}
          onChange={(e) => {
            const channel = e.target.value as BundleChannel
            const firstPreset = catalog[channel]?.[0]?.id ?? ""
            onUpdate({ channel, preset_id: firstPreset })
          }}
          className="border rounded px-2 py-1 text-xs">
          {CHANNEL_ORDER.map((c) => (
            <option key={c} value={c} disabled={catalog[c].length === 0}>
              {CHANNEL_LABEL[c]}{catalog[c].length === 0 ? " (no presets)" : ""}
            </option>
          ))}
        </select>
        <select value={item.preset_id}
          onChange={(e) => onUpdate({ preset_id: e.target.value })}
          className="border rounded px-2 py-1 text-xs flex-1 min-w-0">
          {channelPresets.length === 0 && <option value="">(no presets in scope)</option>}
          {channelPresets.map((p) => (
            <option key={p.id} value={p.id}>{p.name} [{p.scope_type}]</option>
          ))}
        </select>
        <label className="text-xs text-gray-700 flex items-center gap-1 whitespace-nowrap">
          <span>+</span>
          <input type="number" min={0} step={1} value={item.send_after_minutes}
            onChange={(e) => onUpdate({ send_after_minutes: Math.max(0, parseInt(e.target.value, 10) || 0) })}
            className="w-16 border rounded px-1 py-0.5 text-xs" />
          <span>min</span>
        </label>
        <div className="flex gap-0.5">
          <button type="button" onClick={() => onMove(-1)} disabled={isFirst}
            title="Move up" className="text-xs px-1.5 py-0.5 border border-gray-200 rounded disabled:opacity-30">↑</button>
          <button type="button" onClick={() => onMove(1)} disabled={isLast}
            title="Move down" className="text-xs px-1.5 py-0.5 border border-gray-200 rounded disabled:opacity-30">↓</button>
          <button type="button" onClick={onRemove}
            title="Remove" className="text-xs px-1.5 py-0.5 border border-gray-200 rounded text-red-600">×</button>
        </div>
      </div>
      {selectedSummary && (
        <p className="mt-1 text-xs text-gray-500 truncate pl-8">{selectedSummary}</p>
      )}
    </li>
  )
}
