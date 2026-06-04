"use client"

import { useState, useTransition } from "react"
import {
  approveMarketingAction,
  type PendingActionRow,
} from "@/app/actions/marketing-agent-resolutions"

const ACTION_LABELS: Record<string, { label: string; color: string; explain: string }> = {
  retry_listing_promo_render: {
    label:   "Retry Listing Promo Render",
    color:   "blue",
    explain: "Re-dispatches the listing promo video pipeline. Cooldown still applies.",
  },
  mark_topic_used: {
    label:   "Mark Topic Used",
    color:   "amber",
    explain: "Removes a topic from this week's picker so it isn't repeated across channels.",
  },
  defer_newsletter_campaign: {
    label:   "Defer Newsletter Campaign",
    color:   "purple",
    explain: "Moves a scheduled campaign to deferred status with a structured reason.",
  },
  stage_newsletter_draft: {
    label:   "Stage Newsletter Draft",
    color:   "green",
    explain: "Spawns a new newsletter draft via the topic-bank + image generation chain.",
  },
  cancel_blog_cadence_tick: {
    label:   "Skip This Week's Blog Cadence",
    color:   "gray",
    explain: "Skips THIS week's auto-blog spawn for the scope; next week fires normally.",
  },
  flag_listing_for_review: {
    label:   "Flag Listing for Broker Review",
    color:   "red",
    explain: "Routes a degraded listing asset to the broker's automation_errors review queue.",
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

export function MarketingAgentActionsClient({ initialActions }: { initialActions: PendingActionRow[] }) {
  const [actions, setActions] = useState(initialActions)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  function handleApprove(actionId: string) {
    setError(null)
    setBusyId(actionId)
    startTransition(async () => {
      try {
        const r = await approveMarketingAction(actionId)
        if (!r.success) {
          setError(r.error ?? "Approve failed")
        } else {
          // Reflect the new status + result inline. Status from server
          // is the source of truth — succeeded/failed/skipped depending
          // on the handler outcome.
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

  const pending  = actions.filter((a) => a.status === "proposed")
  const recent   = actions.filter((a) => a.status !== "proposed").slice(0, 25)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Marketing Agent Actions</h1>
        <p className="text-gray-600 mt-2">
          The marketing agent proposes structured resolutions in its weekly plan.
          Approve each one to execute through the canonical pipelines (compliance + cooldown + tenant gates apply).
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded">{error}</div>
      )}

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          Pending approval <span className="text-gray-500 font-normal">({pending.length})</span>
        </h2>
        {pending.length === 0 ? (
          <p className="text-gray-500 text-sm italic">No proposed actions waiting.</p>
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

function ActionCard({ action, onApprove, busy }: { action: PendingActionRow; onApprove: () => void; busy: boolean }) {
  const meta = ACTION_LABELS[action.action_type] ?? { label: action.action_type, color: "gray", explain: "" }
  return (
    <div className={`border rounded-lg p-4 ${busy ? "opacity-70" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-gray-900">{meta.label}</h3>
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
