"use client"

import { useState, useTransition } from "react"
import {
  approveAssetManagerAction,
  type PendingAssetActionRow,
} from "@/app/actions/asset-manager-resolutions"

const ACTION_LABELS: Record<string, { label: string; color: string; explain: string }> = {
  regenerate_asset: {
    label:   "Regenerate Asset",
    color:   "blue",
    explain: "Flips the asset back to a pending state so its existing render cron picks it up on the next tick.",
  },
  deprecate_asset: {
    label:   "Deprecate Asset",
    color:   "gray",
    explain: "Soft-deactivates the asset from rotation. Outcomes history preserved.",
  },
  flag_asset_for_review: {
    label:   "Flag Asset for Broker Review",
    color:   "red",
    explain: "Routes the asset to the broker's automation_errors queue for direct review.",
  },
  request_listing_hero_photo: {
    label:   "Request Listing Hero Photo",
    color:   "amber",
    explain: "Listing has no is_hero=true photo. Writes an info row asking the agent to flag one.",
  },
  request_agent_headshot: {
    label:   "Request Agent Headshot",
    color:   "amber",
    explain: "Agent has no photo_url. Writes an info row asking them to upload.",
  },
  rerender_persona_variants: {
    label:   "Re-render Persona Variants",
    color:   "purple",
    explain: "Queues the (asset, persona) variant render rows for the variant-render reactor's next tick.",
  },
  sync_asset_to_listing: {
    label:   "Sync Asset to Listing",
    color:   "cyan",
    explain: "Backfills the marketing_assets.listing_id link so the asset is formally attached to the listing.",
  },
}

const STATUS_BADGE: Record<string, string> = {
  proposed:   "bg-blue-100 text-blue-800",
  approved:   "bg-blue-100 text-blue-800",
  executing:  "bg-yellow-100 text-yellow-800",
  succeeded:  "bg-green-100 text-green-800",
  failed:     "bg-red-100 text-red-800",
  skipped:    "bg-gray-100 text-gray-600",
}

/** Wave 38 reason codes the Asset Manager emits in action_input.reason
 *  when flagging W38-channel surfaces. Each shows as a chip on the
 *  action card so the broker sees WHY at a glance. */
const REASON_BADGES: Record<string, { label: string; color: string; tooltip: string }> = {
  no_compliance_gate: {
    label:   "compliance gate missing",
    color:   "bg-red-50 text-red-700 border border-red-200",
    tooltip: "Preset has compliance_event_id=NULL — the Fair Housing gate never ran. Future dispatches will bypass the check.",
  },
  unused_bundle: {
    label:   "unused > 14d",
    color:   "bg-gray-100 text-gray-700 border border-gray-200",
    tooltip: "Bundle created > 14 days ago with zero dispatches. Either a dead concept or the agent forgot it exists.",
  },
  zero_lead_rate: {
    label:   "0 leads from ≥5 sends",
    color:   "bg-amber-50 text-amber-800 border border-amber-200",
    tooltip: "Bundle has fired 5+ times but attributed zero leads. Audience targeting or copy isn't landing.",
  },
  tts_audio_renderer_lag: {
    label:   "TTS audio renderer behind",
    color:   "bg-orange-50 text-orange-800 border border-orange-200",
    tooltip: "Letter is > 24h old but tts_audio_url is still NULL despite the agent having a voice clone. ElevenLabs may be quota-paused or the cron is failing.",
  },
  // Pre-W38 reasons the agent may still emit
  stale: {
    label:   "stale (> 365d)",
    color:   "bg-gray-100 text-gray-700 border border-gray-200",
    tooltip: "Brand asset hasn't been used in over a year.",
  },
  underperforming: {
    label:   "underperforming",
    color:   "bg-amber-50 text-amber-800 border border-amber-200",
    tooltip: "Performance score under threshold across 5+ samples.",
  },
  off_brand: {
    label:   "off-brand",
    color:   "bg-orange-50 text-orange-800 border border-orange-200",
    tooltip: "Asset content drifts from current brand voice.",
  },
}

function reasonOf(action: { action_input: Record<string, unknown> }): string | null {
  const r = action.action_input?.reason
  return typeof r === "string" ? r : null
}

export function AssetManagerActionsClient({ initialActions }: { initialActions: PendingAssetActionRow[] }) {
  const [actions, setActions] = useState(initialActions)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reasonFilter, setReasonFilter] = useState<string | null>(null)

  function handleApprove(actionId: string) {
    setError(null)
    setBusyId(actionId)
    startTransition(async () => {
      try {
        const r = await approveAssetManagerAction(actionId)
        if (!r.success) {
          setError(r.error ?? "Approve failed")
        } else {
          setActions((prev) => prev.map((a) =>
            a.id === actionId
              ? { ...a, status: r.status ?? "succeeded", result: r.result ?? null }
              : a
          ))
        }
      } finally {
        setBusyId(null)
      }
    })
  }

  const allPending = actions.filter((a) => a.status === "proposed")
  const pending    = reasonFilter
    ? allPending.filter((a) => reasonOf(a) === reasonFilter)
    : allPending
  const recent     = actions.filter((a) => a.status !== "proposed").slice(0, 25)

  // Aggregate reason counts across the full pending set so the chip
  // bar shows counts before any filter is applied.
  const reasonCounts = new Map<string, number>()
  for (const a of allPending) {
    const r = reasonOf(a)
    if (r) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1)
  }
  const reasonChips = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Asset Manager Actions</h1>
        <p className="text-gray-600 mt-2">
          The Asset Manager Agent reviews the brokerage&apos;s asset library each
          Monday and proposes resolutions. Each action runs through the canonical
          pipelines (tenant + compliance gates apply).
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded">{error}</div>
      )}

      <section className="mb-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900">
            Pending approval{" "}
            <span className="text-gray-500 font-normal">
              ({pending.length}
              {reasonFilter && allPending.length !== pending.length
                ? ` of ${allPending.length}`
                : ""})
            </span>
          </h2>
        </div>

        {reasonChips.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              onClick={() => setReasonFilter(null)}
              className={`text-xs px-2 py-1 rounded border ${
                reasonFilter === null
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
              }`}>
              All ({allPending.length})
            </button>
            {reasonChips.map(([reason, count]) => {
              const meta = REASON_BADGES[reason]
              const active = reasonFilter === reason
              return (
                <button key={reason}
                  onClick={() => setReasonFilter(active ? null : reason)}
                  title={meta?.tooltip ?? reason}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    active
                      ? "bg-gray-900 text-white border-gray-900"
                      : meta?.color ?? "bg-white text-gray-700 border-gray-200"
                  } hover:opacity-90`}>
                  {meta?.label ?? reason} ({count})
                </button>
              )
            })}
          </div>
        )}

        {pending.length === 0 ? (
          <p className="text-gray-500 text-sm italic">
            {reasonFilter
              ? `No proposed actions match "${REASON_BADGES[reasonFilter]?.label ?? reasonFilter}".`
              : "No proposed actions waiting."}
          </p>
        ) : (
          <div className="space-y-3">
            {pending.map((a) => (
              <ActionCard
                key={a.id}
                action={a}
                onApprove={() => handleApprove(a.id)}
                busy={busyId === a.id && isPending}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          Recent activity <span className="text-gray-500 font-normal">({recent.length})</span>
        </h2>
        {recent.length === 0 ? (
          <p className="text-gray-500 text-sm italic">Nothing yet.</p>
        ) : (
          <div className="space-y-2">
            {recent.map((a) => (
              <div key={a.id} className="border rounded p-3 bg-gray-50">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE[a.status] ?? "bg-gray-100"}`}>
                      {a.status}
                    </span>
                    <span className="font-medium text-sm truncate">
                      {ACTION_LABELS[a.action_type]?.label ?? a.action_type}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500 shrink-0">
                    {new Date(a.proposed_at).toLocaleString()}
                  </span>
                </div>
                {a.result && Object.keys(a.result).length > 0 && (
                  <pre className="mt-2 text-xs text-gray-600 bg-white border rounded p-2 overflow-auto">
                    {JSON.stringify(a.result, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ActionCard({ action, onApprove, busy }: { action: PendingAssetActionRow; onApprove: () => void; busy: boolean }) {
  const meta   = ACTION_LABELS[action.action_type] ?? { label: action.action_type, color: "gray", explain: "" }
  const reason = reasonOf(action)
  const reasonMeta = reason ? REASON_BADGES[reason] : null
  return (
    <div className={`border rounded-lg p-4 ${busy ? "opacity-70" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-gray-900">{meta.label}</h3>
            {reasonMeta && (
              <span
                className={`text-xs px-2 py-0.5 rounded ${reasonMeta.color}`}
                title={reasonMeta.tooltip}>
                {reasonMeta.label}
              </span>
            )}
            <span className="text-xs text-gray-500">
              proposed {new Date(action.proposed_at).toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-gray-600 mb-2">{meta.explain}</p>
          {action.rationale && (
            <blockquote className="border-l-2 border-gray-200 pl-3 my-2 text-sm text-gray-700 italic">
              {action.rationale}
            </blockquote>
          )}
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer hover:text-gray-700">View input payload</summary>
            <pre className="mt-1 bg-gray-50 border rounded p-2 overflow-auto">
              {JSON.stringify(action.action_input, null, 2)}
            </pre>
          </details>
        </div>
        <div className="shrink-0">
          <button
            onClick={onApprove}
            disabled={busy}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Executing…" : "Approve"}
          </button>
        </div>
      </div>
    </div>
  )
}
