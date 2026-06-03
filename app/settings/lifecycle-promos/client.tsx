"use client"

import { useState, useTransition } from "react"
import {
  upsertLifecyclePromoPolicy,
  deleteLifecyclePromoPolicy,
  type LifecycleEventDisplay,
} from "@/app/actions/lifecycle-promo-policy"

export function LifecyclePromoSettingsClient({ events: initialEvents }: { events: LifecycleEventDisplay[] }) {
  const [events, setEvents] = useState(initialEvents)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleToggle(eventType: LifecycleEventDisplay["eventType"], next: boolean) {
    setError(null)
    // Optimistic update — flip locally, persist server-side. On failure we
    // restore from the server response.
    setEvents((prev) => prev.map((e) =>
      e.eventType === eventType
        ? { ...e, effectiveAutoSpawn: next, hasAgentOverride: true, agentOverride: { autoSpawn: next, cooldownHours: e.effectiveCooldownHr } }
        : e
    ))
    startTransition(async () => {
      const target = events.find((e) => e.eventType === eventType)
      const r = await upsertLifecyclePromoPolicy({
        eventType,
        autoSpawn:     next,
        cooldownHours: target?.effectiveCooldownHr ?? null,
      })
      if (!r.success) {
        setError(r.error ?? "Save failed")
        // Roll back optimistic flip
        setEvents((prev) => prev.map((e) =>
          e.eventType === eventType ? { ...e, effectiveAutoSpawn: !next } : e
        ))
      }
    })
  }

  function handleReset(eventType: LifecycleEventDisplay["eventType"]) {
    setError(null)
    const target = events.find((e) => e.eventType === eventType)
    if (!target) return
    setEvents((prev) => prev.map((e) =>
      e.eventType === eventType
        ? {
            ...e,
            effectiveAutoSpawn:  e.platformDefault.autoSpawn,
            effectiveCooldownHr: e.platformDefault.cooldownHours,
            hasAgentOverride:    false,
            agentOverride:       null,
          }
        : e
    ))
    startTransition(async () => {
      const r = await deleteLifecyclePromoPolicy({ eventType })
      if (!r.success) {
        setError(r.error ?? "Reset failed")
        setEvents((prev) => prev.map((e) =>
          e.eventType === eventType
            ? { ...e, effectiveAutoSpawn: target.effectiveAutoSpawn, hasAgentOverride: target.hasAgentOverride, agentOverride: target.agentOverride }
            : e
        ))
      }
    })
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Lifecycle Promo Settings</h1>
        <p className="text-gray-600 mt-2">
          Control which listing lifecycle moments auto-generate a promo draft for your approval queue.
          Drafts always require your approval before publishing — disabling auto-spawn just means you'll
          trigger that moment's promo manually from the listing detail page when you want it.
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded">{error}</div>
      )}

      <div className="space-y-3">
        {events.map((e) => (
          <div
            key={e.eventType}
            className={`border rounded-lg p-4 ${isPending ? "opacity-70" : ""}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-gray-900">{e.label}</h3>
                  {e.hasAgentOverride ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                      Your override
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                      Platform default
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mb-2">{e.description}</p>
                {e.effectiveCooldownHr != null && (
                  <p className="text-xs text-gray-500">
                    Cooldown: {e.effectiveCooldownHr}h between drafts for the same listing
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <label className="inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={e.effectiveAutoSpawn}
                    onChange={(ev) => handleToggle(e.eventType, ev.target.checked)}
                    disabled={isPending}
                  />
                  <div className="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  <span className="ml-2 text-sm font-medium text-gray-700">
                    {e.effectiveAutoSpawn ? "Auto-spawn ON" : "Auto-spawn OFF"}
                  </span>
                </label>
                {e.hasAgentOverride && (
                  <button
                    onClick={() => handleReset(e.eventType)}
                    disabled={isPending}
                    className="text-xs text-gray-500 hover:text-gray-700 underline"
                  >
                    Reset to default
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
