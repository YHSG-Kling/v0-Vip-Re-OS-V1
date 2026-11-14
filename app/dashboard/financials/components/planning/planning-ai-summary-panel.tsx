"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Loader2, CheckCircle, AlertTriangle, Link as LinkIcon, Clock } from "lucide-react"
import { aiGenerateProfitLossReport } from "@/app/actions/ai-financial-management"
import { getTaxPlanAction } from "@/app/actions/tax-planning"
import Link from "next/link"

interface SyncStatus {
  connected: boolean
  lastSync?: string
  errors: number
}

interface PlanningAiSummaryPanelProps {
  agentId: string
  ytdGCI: number
  ytdExpenses: number
  /**
   * WAVE 153 (lane 153A): IGNORED. The parent computes this at a hardcoded 25% (agent-financials-client.tsx), a rate
   * nobody entered; this panel now reads THE ONE estimator (getTaxPlanAction) instead. Kept optional only until the
   * parent stops passing it (lane 153A Outside-lane request to 153B).
   */
  estimatedTaxLiability?: number
  syncStatus?: SyncStatus | null
}

export function PlanningAiSummaryPanel({
  agentId,
  ytdGCI,
  ytdExpenses,
  syncStatus,
}: PlanningAiSummaryPanelProps) {
  const [summary, setSummary] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  // The suggested reserve set aside so far + still suggested — only when the person has entered their rates (or their
  // accountant's amounts). Otherwise null, and the row says so rather than subtracting an invented tax.
  const [reserveSoFar, setReserveSoFar] = useState<number | null>(null)
  useEffect(() => {
    getTaxPlanAction().then((res) => {
      if (res.success && res.plan.inputs.status === "ready" && res.plan.remainingSuggestedReserve != null) {
        setReserveSoFar(res.plan.alreadySetAsideOrPaid + res.plan.remainingSuggestedReserve)
      }
    }).catch(() => {})
  }, [])

  // Calculate key metrics
  const netIncome = ytdGCI - ytdExpenses
  const expenseRatio = ytdGCI > 0 ? (ytdExpenses / ytdGCI) * 100 : 0
  const netAfterTax = reserveSoFar == null ? null : netIncome - reserveSoFar

  const handleGenerateSummary = async () => {
    setGenerating(true)
    try {
      const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().split("T")[0]
      const today = new Date().toISOString().split("T")[0]

      const result = await aiGenerateProfitLossReport({
        agentId,
        startDate: yearStart,
        endDate: today,
        includeProjections: true,
      })

      if (result.report) {
        setSummary(result.report as any)
      }
    } catch (error) {
      console.error("Error generating summary:", error)
    } finally {
      setGenerating(false)
    }
  }

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-purple-600" />
          Financial Intelligence Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Accounting Sync status */}
        <div className="p-4 rounded-lg border">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Accounting Sync</span>
            {syncStatus?.connected ? (
              <Badge variant="secondary" className="bg-green-100 text-green-700">
                <CheckCircle className="h-3 w-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="bg-amber-100 text-amber-700">
                <AlertTriangle className="h-3 w-3 mr-1" />
                Not Connected
              </Badge>
            )}
          </div>

          {syncStatus?.connected ? (
            <div className="mt-2 space-y-1">
              {syncStatus.lastSync && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  Last synced: {formatDate(syncStatus.lastSync)}
                </div>
              )}
              {syncStatus.errors > 0 && (
                <Link href="/dashboard/settings/integrations" className="text-xs text-amber-700 hover:underline">
                  View {syncStatus.errors} sync error{syncStatus.errors !== 1 ? "s" : ""}
                </Link>
              )}
            </div>
          ) : (
            <div className="mt-2">
              <Link href="/dashboard/settings/integrations">
                <Button variant="outline" size="sm" className="w-full">
                  <LinkIcon className="h-4 w-4 mr-2" />
                  Connect Accounting Software
                </Button>
              </Link>
              <p className="text-xs text-muted-foreground mt-2">
                Connect for automatic expense categorization
              </p>
            </div>
          )}
        </div>

        {/* Key financial insights */}
        <div className="space-y-3">
          <p className="text-sm font-medium">Key Financial Insights</p>
          
          <div className="grid grid-cols-1 gap-2">
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <span className="text-sm text-muted-foreground">Net Income</span>
              <span className={`text-sm font-semibold ${netIncome >= 0 ? "text-green-700" : "text-red-600"}`}>
                {formatCurrency(netIncome)}
              </span>
            </div>
            
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <span className="text-sm text-muted-foreground">Expense Ratio</span>
              <span className="text-sm font-semibold">{expenseRatio.toFixed(1)}%</span>
            </div>
            
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <span className="text-sm text-muted-foreground">Net after your tax reserve</span>
              {netAfterTax == null ? (
                <span className="text-xs text-muted-foreground">Enter your tax rates in the tax planner</span>
              ) : (
                <span className={`text-sm font-semibold ${netAfterTax >= 0 ? "text-green-700" : "text-red-600"}`}>
                  {formatCurrency(netAfterTax)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Generate full summary button */}
        <Button
          onClick={handleGenerateSummary}
          disabled={generating}
          className="w-full"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4 mr-2" />
          )}
          Generate Full Financial Summary
        </Button>

        {/* AI Summary display */}
        {summary && (
          <div className="p-4 rounded-lg bg-purple-50 border border-purple-200 max-h-64 overflow-y-auto">
            <p className="text-sm text-purple-900 whitespace-pre-wrap">{summary}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
