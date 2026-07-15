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
import { HeartPulse, ChevronDown, ChevronUp } from "lucide-react"
import { getSelfHealRollup, getRepairAutonomy } from "@/app/actions/self-heal-rollup"
import type { SelfHealRollup, RepairAutonomyRow } from "@/lib/kernel/self-heal-ledger"

const DOMAIN_LABEL: Record<string, string> = { data_flow: "data flows", connector: "connections" }

export function BrokerSelfHealPanel() {
  const [r, setR] = useState<SelfHealRollup | null>(null)
  const [repairs, setRepairs] = useState<RepairAutonomyRow[]>([])
  const [showRepairs, setShowRepairs] = useState(false)
  useEffect(() => {
    getSelfHealRollup().then((x) => { if (x.success) setR(x.rollup) }).catch(() => {})
    getRepairAutonomy().then((x) => { if (x.success) setRepairs(x.repairs) }).catch(() => {})
  }, [])

  if (!r || r.healed === 0) return null
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
