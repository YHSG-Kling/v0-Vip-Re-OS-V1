"use client"

/**
 * BROKER SELF-HEAL PANEL — "the OS repaired itself" made visible. Reads the
 * self-healing ledger (flow + connector auto-heals). Renders only when the OS
 * has actually healed something in the window (honest empty otherwise).
 * Includes the CONFIDENCE RATCHET standing: each repair type is either
 * "earned" (runs silently — proven by clean heals on the ledger) or
 * "supervised" (still reports every fix until it earns autonomy).
 */

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { HeartPulse, ChevronDown, ChevronUp, Activity } from "lucide-react"
import { getSelfHealRollup, getRepairAutonomy } from "@/app/actions/self-heal-rollup"
import { getOsHealthLine, releaseFinancialWriterHaltAction, getMyHealingIncidentsAction } from "@/app/actions/os-health"
import type { SelfHealRollup, RepairAutonomyRow, HealingIncident } from "@/lib/kernel/self-heal-ledger"
import type { OsHealthLine } from "@/lib/kernel/os-health"

const DOMAIN_LABEL: Record<string, string> = { data_flow: "data flows", connector: "connections" }

export function BrokerSelfHealPanel() {
  const [r, setR] = useState<SelfHealRollup | null>(null)
  const [repairs, setRepairs] = useState<RepairAutonomyRow[]>([])
  const [showRepairs, setShowRepairs] = useState(false)
  const [health, setHealth] = useState<OsHealthLine | null>(null)
  const [releaseNote, setReleaseNote] = useState<string | null>(null)
  // WAVE 139F — this brokerage's OWN healing incidents (tenant-scoped console) + its effective healing policy.
  const [incidents, setIncidents] = useState<HealingIncident[]>([])
  const [policyLine, setPolicyLine] = useState<string | null>(null)
  const [showIncidents, setShowIncidents] = useState(false)
  useEffect(() => {
    getMyHealingIncidentsAction().then((x) => {
      if (!x.success) return
      setIncidents(x.incidents)
      const p = x.policy
      setPolicyLine(p.readable
        ? `Healing policy: diagnosis ≤ $${p.diagnosisCapUsd} · research ≤ $${p.providerResearchCapUsd} · ${p.maxAttemptsPerDay} attempts/day · auto-fix at ≥ ${Math.round(p.autoFixMinConfidence * 100)}% confidence${p.clamped.length ? ` (platform ceiling applied to ${p.clamped.join(", ")})` : ""}`
        : `Healing policy unreadable — the OS takes no autonomous healing action (${p.note ?? "no detail"})`)
    }).catch(() => {})
  }, [])
  useEffect(() => {
    getSelfHealRollup().then((x) => { if (x.success) setR(x.rollup) }).catch(() => {})
    getRepairAutonomy().then((x) => { if (x.success) setRepairs(x.repairs) }).catch(() => {})
    getOsHealthLine().then((x) => { if (x.success) setHealth(x.health) }).catch(() => {})
  }, [])

  // WAVE 108C - THE OS HEALTH LINE (the Cron Manager's supervisor, lib/kernel/os-health.ts). Rendered
  // whenever it loads: "not checked" and "halted for Finance" are states a broker must see even on a
  // day the OS repaired nothing.
  const healthLine = health ? (
    <div className="rounded-md border px-3 py-2 text-xs" data-os-health={health.status}>
      <div className="flex items-center gap-2">
        <Activity className={`h-3.5 w-3.5 ${health.status === "ok" ? "text-emerald-600" : health.status === "warn" ? "text-amber-600" : health.status === "breach" ? "text-red-600" : "text-muted-foreground"}`} />
        <span className="font-medium">OS health</span>
        <span className="text-muted-foreground">{health.line}</span>
      </div>
      {health.halts.map((h) => (
        <div key={h.writer} className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-red-700">{h.label} halted{h.reason ? ` - ${h.reason}` : ""}</span>
          <button
            type="button"
            className="shrink-0 underline text-muted-foreground hover:text-foreground"
            onClick={async () => {
              const reason = window.prompt(`Release ${h.label}? Say why the discrepancy is resolved:`) ?? ""
              if (!reason.trim()) return
              const res = await releaseFinancialWriterHaltAction({ writer: h.writer, reason })
              setReleaseNote(res.success ? `${h.label} released.` : res.error)
              if (res.success) getOsHealthLine().then((x) => { if (x.success) setHealth(x.health) }).catch(() => {})
            }}
          >
            Release (Finance)
          </button>
        </div>
      ))}
      {releaseNote && <p className="mt-1 text-muted-foreground">{releaseNote}</p>}
    </div>
  ) : null

  const incidentsBlock = incidents.length > 0 || policyLine ? (
    <div className="rounded-md border px-3 py-2 text-xs" data-healing-incidents={incidents.length}>
      {policyLine ? <p className="text-muted-foreground">{policyLine}</p> : null}
      {incidents.length > 0 ? (
        <>
          <button type="button" onClick={() => setShowIncidents((v) => !v)} className="mt-1 flex items-center gap-1 text-muted-foreground hover:text-foreground">
            {showIncidents ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {incidents.length} healing incident{incidents.length === 1 ? "" : "s"} in your brokerage
          </button>
          {showIncidents ? (
            <ul className="mt-1 space-y-1.5">
              {incidents.slice(0, 25).map((i) => (
                <li key={i.key} className="border-t pt-1">
                  <div className="flex justify-between gap-2"><span className="font-medium">{i.subject}</span><Badge variant="outline" className="shrink-0">{i.finalState}</Badge></div>
                  <div className="text-muted-foreground">
                    {[i.classification, i.domain, i.provider, i.playbook ? `${i.playbook} × ${i.attempts}` : null, `$${i.costUsd.toFixed(4)}`].filter(Boolean).join(" · ")}
                  </div>
                  {i.diagnosis ? <div>{i.diagnosis.summary}</div> : null}
                  {i.verification ? <div className="text-muted-foreground">{i.verification}</div> : null}
                  {i.escalation?.reason ? <div className="text-amber-700">{i.escalation.reason}</div> : null}
                  {i.evidence.map((c) => <a key={c.url} className="block underline" href={c.url} target="_blank" rel="noreferrer">{c.title ?? c.url}</a>)}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  ) : null

  if (!r || r.healed === 0) {
    if (!healthLine && !incidentsBlock) return null
    return (
      <Card>
        <CardContent className="pt-4 space-y-2">{healthLine}{incidentsBlock}</CardContent>
      </Card>
    )
  }
  const active = repairs.filter((x) => x.healed + x.failed > 0)
  return (
    <Card className="border-emerald-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <HeartPulse className="h-4 w-4 text-emerald-600" />
          Your OS repaired itself
        </CardTitle>
        <p className="text-xs text-muted-foreground">Last {r.windowDays} days · no action needed from you</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {healthLine}
        {incidentsBlock}
        <p className="text-sm">
          The OS auto-fixed <span className="font-semibold">{r.healed}</span> issue{r.healed === 1 ? "" : "s"} before {r.healed === 1 ? "it" : "they"} could reach you.
        </p>
        <div className="flex flex-wrap gap-2">
          {r.byDomain.map((d) => (
            <Badge key={d.domain} variant="outline" className="text-xs">
              {d.healed} {DOMAIN_LABEL[d.domain] ?? d.domain}
            </Badge>
          ))}
        </div>
        {r.escalated > 0 && (
          <p className="text-xs text-amber-700">{r.escalated} needed a human — check your notifications.</p>
        )}
        {active.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowRepairs((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {showRepairs ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              How each repair earns its autonomy
            </button>
            {showRepairs && (
              <ul className="mt-2 space-y-1.5">
                {active.map((x) => (
                  <li key={x.flow} className="flex items-start justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{x.describes}</span>
                    {x.earned ? (
                      <Badge variant="outline" className="shrink-0 border-emerald-300 text-emerald-700">earned · runs silently</Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0 border-amber-300 text-amber-700">
                        supervised · {Math.min(x.healed, 5)}/5 clean{x.failed > 0 ? ` · ${x.failed} failed` : ""}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
