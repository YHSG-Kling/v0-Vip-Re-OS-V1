"use client"

import { useRouter, usePathname } from "next/navigation"
import { useState, useTransition } from "react"
import type { PolicyScopeAccess } from "@/lib/identity/policy-scope"
import type { LifecycleEventDisplay } from "@/app/actions/lifecycle-promo-policy"
import {
  upsertLifecyclePromoPolicy,
  deleteLifecyclePromoPolicy,
  upsertLifecycleMailFields,
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

      {/* Mail-sub-row component lives at the bottom of this file. */}
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
                    {e.effectiveAutoSpawn ? "Video ON" : "Video OFF"}
                  </span>
                </label>
                {e.hasAgentOverride && (
                  <button
                    onClick={() => handleReset(e.eventType)}
                    disabled={isPending}
                    className="text-xs text-gray-500 hover:text-gray-700 underline"
                  >
                    Reset video
                  </button>
                )}
              </div>
            </div>

            {/* Wave 36 — direct mail sub-row. Independent from the video
                toggle: an admin can ship the postcard without the video
                or vice versa. */}
            <LifecycleMailRow
              event={e}
              scopeType={activeTab}
              activeTeamId={activeTeamId}
              setError={setError}
              setEvents={setEvents}
              isPending={isPending}
              startTransition={startTransition}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function LifecycleMailRow({
  event,
  scopeType,
  activeTeamId,
  setError,
  setEvents,
  isPending,
  startTransition,
}: {
  event:           LifecycleEventDisplay
  scopeType:       TabKey
  activeTeamId:    string | null
  setError:        (e: string | null) => void
  setEvents:       (fn: (prev: LifecycleEventDisplay[]) => LifecycleEventDisplay[]) => void
  isPending:       boolean
  startTransition: (cb: () => void) => void
}) {
  const [audience, setAudience] = useState<"farm" | "sphere" | "farm+sphere">(event.mailTargetAudience ?? "farm")
  const [cap, setCap]           = useState<string>(event.mailMaxRecipients?.toString() ?? "")

  // Per-event size recommendation. The lifecycle reactor applies its own
  // default when null; we surface that as the hint to the admin.
  const RECOMMENDED_SIZES: Record<LifecycleEventDisplay["eventType"], "4x6" | "6x9"> = {
    coming_soon:         "6x9",
    just_listed:         "6x9",
    open_house_announce: "6x9",
    open_house_reminder: "4x6",
    price_reduction:     "4x6",
    under_contract:      "4x6",
    just_sold:           "6x9",
  }
  const effectiveSize = event.mailPostcardSize ?? RECOMMENDED_SIZES[event.eventType]

  function patch(input: Parameters<typeof upsertLifecycleMailFields>[0]) {
    setError(null)
    startTransition(async () => {
      const r = await upsertLifecycleMailFields({
        ...input,
        scopeType,
        scopeId: scopeType === "team" ? (activeTeamId ?? undefined) : undefined,
      })
      if (!r.success) setError(r.error ?? "Save failed")
      else setEvents((prev) => prev.map((p) => p.eventType !== event.eventType ? p : {
        ...p,
        mailEnabled:        input.mailEnabled ?? p.mailEnabled,
        mailPostcardSize:   input.mailPostcardSize !== undefined ? input.mailPostcardSize : p.mailPostcardSize,
        mailTargetAudience: input.mailTargetAudience ?? p.mailTargetAudience,
        mailMaxRecipients:  input.mailMaxRecipients !== undefined ? input.mailMaxRecipients : p.mailMaxRecipients,
      }))
    })
  }

  return (
    <div className="mt-4 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-gray-700">Direct mail (postcard)</span>
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={event.mailEnabled}
            onChange={(ev) => patch({ eventType: event.eventType, mailEnabled: ev.target.checked })}
            disabled={isPending}
          />
          <div className="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-amber-300 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-600"></div>
          <span className="ml-2 text-sm font-medium text-gray-700">
            {event.mailEnabled ? "Mail ON" : "Mail OFF"}
          </span>
        </label>
      </div>

      {event.mailEnabled && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="block text-xs text-gray-500 mb-1">Size (recommended: {RECOMMENDED_SIZES[event.eventType]})</span>
            <div className="flex gap-1">
              {(["4x6", "6x9"] as const).map((s) => (
                <button
                  key={s}
                  disabled={isPending}
                  onClick={() => patch({ eventType: event.eventType, mailPostcardSize: s })}
                  className={`px-3 py-1.5 text-xs font-medium rounded border ${
                    effectiveSize === s
                      ? "bg-amber-600 text-white border-amber-600"
                      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                  } disabled:opacity-50`}
                >{s}</button>
              ))}
            </div>
          </div>
          <div>
            <span className="block text-xs text-gray-500 mb-1">Audience</span>
            <select
              value={audience}
              onChange={(e) => { setAudience(e.target.value as typeof audience); patch({ eventType: event.eventType, mailTargetAudience: e.target.value as typeof audience }) }}
              disabled={isPending}
              className="border rounded px-2 py-1 text-xs w-full"
            >
              <option value="farm">Farm zips</option>
              <option value="sphere">Sphere (12mo touched)</option>
              <option value="farm+sphere">Farm + sphere</option>
            </select>
          </div>
          <div>
            <span className="block text-xs text-gray-500 mb-1">Max recipients (default 100)</span>
            <input
              type="number"
              min={1}
              max={500}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onBlur={() => patch({ eventType: event.eventType, mailMaxRecipients: cap.trim() ? Number(cap) : null })}
              disabled={isPending}
              className="border rounded px-2 py-1 text-xs w-full"
            />
          </div>
        </div>
      )}
    </div>
  )
}
