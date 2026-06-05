"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  saveSizePrefCell,
  type SizePrefCell,
  type ScopeType,
} from "@/app/actions/direct-mail-size-prefs"
import type { Persona } from "@/lib/kernel/types"
import type { PostcardSize, DirectMailUseKind } from "@/lib/direct-mail/resolve-size-pref"

const USE_KINDS: DirectMailUseKind[] = ["farm_mail", "welcome_kit", "sphere_outreach"]
const PERSONAS:  Persona[] = [
  "first_time", "relocated", "luxury", "fsbo", "probate",
  "upsize", "downsize", "military", "divorce", "senior",
  "expired", "foreclosure", "other",
]

const USE_KIND_LABEL: Record<DirectMailUseKind, string> = {
  farm_mail:        "Farm Mail",
  welcome_kit:      "Welcome Kit",
  sphere_outreach:  "Sphere Outreach",
}

const PERSONA_LABEL: Record<Persona, string> = {
  first_time: "First-Time Buyer",
  relocated:  "Relocated",
  luxury:     "Luxury",
  fsbo:       "FSBO",
  probate:    "Probate",
  upsize:     "Upsize",
  downsize:   "Downsize",
  military:   "Military",
  divorce:    "Divorce",
  senior:     "Senior",
  expired:    "Expired Listing",
  foreclosure:"Foreclosure",
  other:      "Other",
}

export interface SizePrefsMatrixClientProps {
  initialCells:     SizePrefCell[]
  initialOverrides: Record<string, PostcardSize>
  activeScope:      ScopeType
  activeTeamId:     string | null
  scopeOptions: {
    agent:     boolean
    team:      { id: string; name: string }[]
    brokerage: boolean
  }
}

export function SizePrefsMatrixClient(props: SizePrefsMatrixClientProps) {
  const [cells, setCells] = useState(props.initialCells)
  const [overrides, setOverrides] = useState(props.initialOverrides)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const router = useRouter()

  function handleScopeChange(next: ScopeType, teamId?: string) {
    const sp = new URLSearchParams()
    sp.set("scope", next)
    if (teamId) sp.set("team", teamId)
    router.push(`/settings/direct-mail/size-prefs?${sp.toString()}`)
  }

  function handleSet(useKind: DirectMailUseKind, persona: Persona, value: PostcardSize | "reset") {
    const key = `${useKind}:${persona}`
    setError(null)
    setBusyKey(key)
    startTransition(async () => {
      try {
        const r = await saveSizePrefCell({
          scopeType: props.activeScope,
          teamId:    props.activeTeamId ?? undefined,
          useKind, persona, size: value,
        })
        if (!r.success) {
          setError(r.error ?? "Save failed")
          return
        }
        // Optimistic state update
        setOverrides((prev) => {
          const next = { ...prev }
          if (value === "reset") delete next[key]
          else next[key] = value
          return next
        })
        // Recompute the cell — when reset, fall through to the
        // platform recommendation (the cell already carries it).
        setCells((prev) => prev.map((c) => {
          if (c.use_kind !== useKind || c.persona !== persona) return c
          if (value === "reset") {
            return { ...c, effective_size: c.recommendation, source: "platform_recommendation" }
          }
          return { ...c, effective_size: value, source: props.activeScope }
        }))
      } finally {
        setBusyKey(null)
      }
    })
  }

  const cellByKey = new Map(cells.map((c) => [`${c.use_kind}:${c.persona}`, c]))

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Direct Mail Size Preferences</h1>
        <p className="text-gray-600 mt-2">
          Pick 4×6 (cost-efficient at scale) or 6×9 (premium tier, room for a property
          photo) per persona × use kind. Cells you don&apos;t override fall through to your
          team, then your brokerage, then the platform recommendation shown below each cell.
        </p>
      </header>

      {/* Scope picker */}
      <div className="flex gap-2 mb-6">
        {props.scopeOptions.agent && (
          <button
            onClick={() => handleScopeChange("agent")}
            className={`px-4 py-2 text-sm rounded ${props.activeScope === "agent" ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
          >My settings (agent)</button>
        )}
        {props.scopeOptions.team.length > 0 && props.scopeOptions.team.map((t) => (
          <button
            key={t.id}
            onClick={() => handleScopeChange("team", t.id)}
            className={`px-4 py-2 text-sm rounded ${props.activeScope === "team" && props.activeTeamId === t.id ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
          >Team: {t.name}</button>
        ))}
        {props.scopeOptions.brokerage && (
          <button
            onClick={() => handleScopeChange("brokerage")}
            className={`px-4 py-2 text-sm rounded ${props.activeScope === "brokerage" ? "bg-blue-600 text-white" : "bg-gray-100 hover:bg-gray-200"}`}
          >Brokerage</button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">{error}</div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-3 px-3 text-sm font-semibold text-gray-700">Persona</th>
              {USE_KINDS.map((u) => (
                <th key={u} className="text-left py-3 px-3 text-sm font-semibold text-gray-700">{USE_KIND_LABEL[u]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERSONAS.map((p) => (
              <tr key={p} className="border-b border-gray-100">
                <td className="py-3 px-3 text-sm font-medium text-gray-900 whitespace-nowrap">{PERSONA_LABEL[p]}</td>
                {USE_KINDS.map((u) => {
                  const key = `${u}:${p}`
                  const cell = cellByKey.get(key)
                  if (!cell) return <td key={u} />
                  const isOverridden = !!overrides[key]
                  const isBusy = busyKey === key && pending
                  return (
                    <td key={u} className="py-3 px-3 align-top">
                      <div className="flex gap-1 mb-1">
                        {(["4x6", "6x9"] as const).map((s) => {
                          const isSelected = cell.effective_size === s
                          return (
                            <button
                              key={s}
                              disabled={isBusy}
                              onClick={() => handleSet(u, p, s)}
                              className={`px-3 py-1.5 text-xs font-medium rounded border ${
                                isSelected
                                  ? "bg-blue-600 text-white border-blue-600"
                                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                              } disabled:opacity-50`}
                            >{s}</button>
                          )
                        })}
                        {isOverridden && (
                          <button
                            disabled={isBusy}
                            onClick={() => handleSet(u, p, "reset")}
                            title="Reset to cascade default"
                            className="px-2 py-1.5 text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
                          >↺</button>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-500 leading-tight">
                        <div>Recommended: <span className="font-medium text-gray-700">{cell.recommendation}</span></div>
                        <div>From: <span className="font-medium">{cell.source.replace("_", " ")}</span></div>
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-gray-500">
        Cells marked &quot;From: agent/team/brokerage&quot; are your overrides. &quot;From: platform recommendation&quot;
        means you haven&apos;t overridden and the platform default applies. The ↺ button clears an override
        so the cascade re-takes over.
      </p>
    </div>
  )
}
