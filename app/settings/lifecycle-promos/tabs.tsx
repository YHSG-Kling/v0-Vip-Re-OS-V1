"use client"

import { useRouter, usePathname } from "next/navigation"
import { useState, useTransition } from "react"
import type { PolicyScopeAccess } from "@/lib/identity/policy-scope"
import type { LifecycleEventDisplay } from "@/app/actions/lifecycle-promo-policy"
import {
  upsertLifecyclePromoPolicy,
  deleteLifecyclePromoPolicy,
} from "@/app/actions/lifecycle-promo-policy"

type TabKey = "agent" | "team" | "brokerage"

const TAB_LABEL: Record<TabKey, string> = {
  agent:     "Your Settings",
  team:      "Team Settings",
  brokerage: "Brokerage Settings",
}

const TAB_SUBTITLE: Record<TabKey, string> = {
  agent:     "Override the team/brokerage defaults for your own listings.",
  team:      "Apply to all agents on the team unless they override personally.",
  brokerage: "Apply to every agent in the brokerage unless their team or personal settings override.",
}

export function LifecyclePromoSettingsTabs({
  access,
  activeTab,
  activeTeamId,
  events: initialEvents,
  error: initialError,
}: {
  access:       PolicyScopeAccess
  activeTab:    TabKey
  activeTeamId: string | null
  events:       LifecycleEventDisplay[]
  error:        string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [events, setEvents] = useState(initialEvents)
  const [error, setError] = useState<string | null>(initialError)
  const [isPending, startTransition] = useTransition()

  const visibleTabs: TabKey[] = [
    ...(access.canEditAgent ? ["agent"] as TabKey[] : []),
    ...(access.canEditTeam ? ["team"] as TabKey[] : []),
    ...(access.canEditBrokerage ? ["brokerage"] as TabKey[] : []),
  ]

  function gotoTab(tab: TabKey, team?: string) {
    const url = new URL(pathname, "http://x")
    url.searchParams.set("tab", tab)
    if (team) url.searchParams.set("team", team)
    router.push(url.pathname + url.search)
  }

  function handleToggle(eventType: LifecycleEventDisplay["eventType"], next: boolean) {
    setError(null)
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
        scopeType:     activeTab,
        scopeId:       activeTab === "team" ? (activeTeamId ?? undefined) : undefined,
      })
      if (!r.success) {
        setError(r.error ?? "Save failed")
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
        ? { ...e, effectiveAutoSpawn: e.platformDefault.autoSpawn, hasAgentOverride: false, agentOverride: null }
        : e
    ))
    startTransition(async () => {
      const r = await deleteLifecyclePromoPolicy({
        eventType,
        scopeType: activeTab,
        scopeId:   activeTab === "team" ? (activeTeamId ?? undefined) : undefined,
      })
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
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Lifecycle Promo Settings</h1>
        <p className="text-gray-600 mt-2">{TAB_SUBTITLE[activeTab]}</p>
      </header>

      {visibleTabs.length > 1 && (
        <div className="mb-6 border-b border-gray-200">
          <nav className="flex gap-2">
            {visibleTabs.map((t) => (
              <button
                key={t}
                onClick={() => gotoTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === t
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </nav>
        </div>
      )}

      {activeTab === "team" && access.teamScopeIds.length > 1 && (
        <div className="mb-4">
          <label className="text-sm text-gray-700 mr-2">Team:</label>
          <select
            value={activeTeamId ?? ""}
            onChange={(e) => gotoTab("team", e.target.value)}
            className="border rounded px-3 py-1.5 text-sm"
          >
            {access.teamScopeIds.map((tid) => (
              <option key={tid} value={tid}>{tid.slice(0, 8)}…</option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded">{error}</div>
      )}

      <div className="space-y-3">
        {events.map((e) => (
          <div key={e.eventType} className={`border rounded-lg p-4 ${isPending ? "opacity-70" : ""}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-gray-900">{e.label}</h3>
                  {e.hasAgentOverride ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-800">Override</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">Inherited</span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mb-2">{e.description}</p>
                {e.effectiveCooldownHr != null && (
                  <p className="text-xs text-gray-500">Cooldown: {e.effectiveCooldownHr}h between drafts</p>
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
                    Reset to inherited
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
