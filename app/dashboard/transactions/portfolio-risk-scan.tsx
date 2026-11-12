"use client"

/**
 * PORTFOLIO RISK SCAN — the agent-level companion to the per-deal AI read.
 *
 * monitorTransactionRisks reads the agent's whole in-escrow book in one pass and
 * returns an overall risk level, a per-deal primary risk, the immediate actions,
 * and the week's focus — then writes ai_risk_level / ai_primary_risk back onto
 * each deal it scanned. It was complete and reachable from nowhere, so those two
 * columns were never populated for anyone.
 *
 * Every outcome is READ: a refusal, an empty book and a partial write are each
 * reported as themselves rather than collapsing into a green toast.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Sparkles, AlertTriangle, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { monitorTransactionRisks } from "@/app/actions/ai-transaction-coordinator"

type RiskRow = {
  transactionId: string
  propertyAddress: string
  riskLevel: "low" | "medium" | "high" | "critical"
  primaryRisk: string
  daysToDeadline: number
  recommendedAction: string
  urgency: "routine" | "attention_needed" | "urgent" | "critical"
}

interface ScanResult {
  overallRiskLevel: "low" | "medium" | "high" | "critical"
  transactionRisks: RiskRow[]
  immediateActions: Array<{ transactionId: string; action: string; deadline: string }>
  weeklyFocus: string[]
}

const RISK_TONE: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-amber-100 text-amber-800 border-amber-200",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
  low: "bg-emerald-100 text-emerald-800 border-emerald-200",
}

export function PortfolioRiskScan({ agentId }: { agentId: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<ScanResult | null>(null)
  const [emptyBook, setEmptyBook] = useState(false)

  function runScan() {
    setResult(null)
    setEmptyBook(false)
    startTransition(async () => {
      const res = await monitorTransactionRisks(agentId)
      if (!res.success) {
        toast.error(res.error ?? "Risk scan failed")
        return
      }
      if (!res.riskAnalysis) {
        // The action's own "no active transactions" branch — say so, do not
        // render an empty panel that reads like a clean bill of health.
        setEmptyBook(true)
        return
      }
      setResult(res.riskAnalysis as ScanResult)
      toast.success(
        `Scanned ${res.scannedCount ?? 0} deal${res.scannedCount === 1 ? "" : "s"} · ` +
          `risk written to ${res.appliedCount ?? 0}`,
      )
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Portfolio Risk Scan
          </CardTitle>
          <Button size="sm" variant="outline" onClick={runScan} disabled={isPending}>
            {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
            {isPending ? "Scanning…" : "Scan my open deals"}
          </Button>
        </div>
      </CardHeader>
      {(result || emptyBook) && (
        <CardContent className="space-y-3 text-sm">
          {emptyBook && (
            <p className="text-muted-foreground">
              No deals in escrow right now — nothing to scan.
            </p>
          )}

          {result && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">Overall portfolio risk</span>
                <Badge variant="outline" className={RISK_TONE[result.overallRiskLevel]}>
                  {result.overallRiskLevel}
                </Badge>
              </div>

              {result.transactionRisks.length > 0 && (
                <ul className="space-y-2">
                  {result.transactionRisks.map((r) => (
                    <li key={r.transactionId} className="rounded-md border p-2.5 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium leading-snug">{r.propertyAddress}</span>
                        <Badge variant="outline" className={`${RISK_TONE[r.riskLevel]} text-[10px] shrink-0`}>
                          {r.riskLevel}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{r.primaryRisk}</p>
                      <p className="text-xs">
                        <span className="font-medium">Do next: </span>
                        {r.recommendedAction}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {result.immediateActions.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5">
                  <p className="text-xs font-semibold text-amber-900 flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Immediate
                  </p>
                  <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
                    {result.immediateActions.map((a, i) => (
                      <li key={i}>
                        · {a.action} <span className="opacity-70">({a.deadline})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.weeklyFocus.length > 0 && (
                <div>
                  <p className="text-xs font-semibold">This week&apos;s focus</p>
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {result.weeklyFocus.map((f, i) => (
                      <li key={i}>· {f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
