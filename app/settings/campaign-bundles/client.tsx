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
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 whitespace-nowrap"
        >+ New bundle</button>
      </header>

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
