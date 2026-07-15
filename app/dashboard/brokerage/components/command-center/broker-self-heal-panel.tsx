"use client"

/**
 * BROKER SELF-HEAL PANEL — "the OS repaired itself" made visible. Reads the
 * self-healing ledger (flow + connector auto-heals). Renders only when the OS
 * has actually healed something in the window (honest empty otherwise).
 */

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { HeartPulse } from "lucide-react"
import { getSelfHealRollup } from "@/app/actions/self-heal-rollup"
import type { SelfHealRollup } from "@/lib/kernel/self-heal-ledger"

const DOMAIN_LABEL: Record<string, string> = { data_flow: "data flows", connector: "connections" }

export function BrokerSelfHealPanel() {
  const [r, setR] = useState<SelfHealRollup | null>(null)
  useEffect(() => { getSelfHealRollup().then((x) => { if (x.success) setR(x.rollup) }).catch(() => {}) }, [])

  if (!r || r.healed === 0) return null
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
      </CardContent>
    </Card>
  )
}
