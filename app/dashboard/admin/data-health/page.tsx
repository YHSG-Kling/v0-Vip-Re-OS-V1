"use client"

import { useState, useEffect, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Loader2, Shield, AlertTriangle, CheckCircle2, RefreshCw, Scan, XCircle, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { getDataHealthStats, runDataHygieneScan, getDataHealthLogs } from "@/app/actions/data-health"
import { refreshStalePredictions } from "@/app/actions/ai-predictions"
import { loadSelfAuditRollup } from "@/app/actions/self-audit-rollup"
import type { SelfAuditRollup } from "@/lib/platform/self-audit-rollup"
import { EnrichmentBacklogPanel } from "./enrichment-backlog-panel"

export default function DataHealthPage() {
  const [stats, setStats] = useState<any>(null)
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [selfAudit, setSelfAudit] = useState<SelfAuditRollup | null>(null)
  const [isPending, startTransition] = useTransition()

  const loadData = async () => {
    setFetchError(null)
    try {
      const [statsRes, logsRes] = await Promise.allSettled([
        getDataHealthStats(),
        getDataHealthLogs({}),
      ])

      let hadError = false

      if (statsRes.status === "fulfilled" && statsRes.value.success) {
        setStats(statsRes.value.stats)
      } else {
        const reason = statsRes.status === "rejected"
          ? (statsRes.reason instanceof Error ? statsRes.reason.message : "Unknown error")
          : (statsRes.value as any).error ?? "Failed to load stats"
        setFetchError(`Stats: ${reason}`)
        hadError = true
      }

      if (logsRes.status === "fulfilled" && (logsRes.value as any).success) {
        setLogs((logsRes.value as any).logs ?? [])
      } else if (!hadError) {
        const reason = logsRes.status === "rejected"
          ? (logsRes.reason instanceof Error ? logsRes.reason.message : "Unknown error")
          : (logsRes.value as any).error ?? "Failed to load logs"
        setFetchError(`Logs: ${reason}`)
      }
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Unexpected error loading data")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
    // First-week telemetry — what the OS caught itself doing wrong, by tenant.
    loadSelfAuditRollup().then((r) => { if (r.success && r.rollup) setSelfAudit(r.rollup) }).catch(() => {})
  }, [])

  const handleScan = () => {
    startTransition(async () => {
      const result = await runDataHygieneScan()
      if ((result as any).success) {
        toast.success(`Scan complete — ${(result as any).invalidCount ?? 0} issues found`)
        await loadData()
      } else {
        toast.error("Scan failed")
      }
    })
  }

  const handleRefreshPredictions = () => {
    startTransition(async () => {
      try {
        const result = await refreshStalePredictions()
        toast.success(`Refreshed ${result.refreshed} stale AI prediction${result.refreshed !== 1 ? "s" : ""}`)
      } catch {
        toast.error("Failed to refresh predictions")
      }
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const healthPct = stats ? Math.round((stats.healthy / Math.max(stats.totalLeads, 1)) * 100) : 0

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Data Health</h1>
          <p className="text-muted-foreground text-sm mt-1">Contact database hygiene, validation, and what the OS caught itself</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); loadData() }} disabled={isPending}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefreshPredictions} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
            Refresh AI Predictions
          </Button>
          <Button size="sm" onClick={handleScan} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Scan className="h-4 w-4 mr-1" />}
            Run Scan
          </Button>
        </div>
      </div>

      {/* Enrichment backlog — who is eligible for enrichment right now, and the
          manual lever for it. Both counts already exclude contacts in a live
          listing or transaction (the owner's before-or-after rule), so this is a
          list of work that CAN be done, not a list of what has been forgotten. */}
      <EnrichmentBacklogPanel />

      {/* FIRST-WEEK TELEMETRY — what the OS caught itself doing wrong, by rail and
          tenant (self-audit findings + signature-chase escalations, trailing 7d).
          Empty = quiet week; that is a real signal too. */}
      {selfAudit && selfAudit.totals.length > 0 && (
        <Card className="border-amber-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              What the OS caught itself — last {selfAudit.windowDays} days
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {selfAudit.totals.map((t) => (
                <Badge key={t.kind} variant="outline" className="capitalize">
                  {t.kind.replace(/_/g, " ")}: {t.count}
                </Badge>
              ))}
            </div>
            {selfAudit.byTenant.length > 0 && (
              <ul className="text-sm space-y-1">
                {selfAudit.byTenant.slice(0, 10).map((r, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="truncate">{r.brokerageName ?? r.brokerageId}</span>
                    <span className="text-muted-foreground capitalize">{r.kind.replace(/_/g, " ")} × {r.count}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">The rails tenants actually stall on — let this pick the next build.</p>
          </CardContent>
        </Card>
      )}

      {fetchError && (
        <div className="flex items-start gap-3 p-4 rounded-lg border border-red-200 bg-red-50 text-red-800">
          <XCircle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">Failed to load data health information</p>
            <p className="text-xs mt-0.5 text-red-700">{fetchError}</p>
          </div>
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="h-4 w-4 text-primary" />
                <p className="text-xs text-muted-foreground">Overall Health</p>
              </div>
              <p className="text-2xl font-bold">{healthPct}%</p>
              <Progress value={healthPct} className="h-1.5 mt-2" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1">Total Contacts</p>
              <p className="text-2xl font-bold">{stats.totalLeads.toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <p className="text-xs text-muted-foreground">Risky</p>
              </div>
              <p className="text-2xl font-bold text-amber-600">{stats.risky}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                <p className="text-xs text-muted-foreground">Invalid</p>
              </div>
              <p className="text-2xl font-bold text-red-600">{stats.invalid}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Recent Issues</CardTitle>
            {stats?.lastGlobalScan && (
              <span className="text-xs text-muted-foreground">Last scan: {stats.lastGlobalScan}</span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <div className="py-8 text-center">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
              <p className="text-sm text-muted-foreground">No issues found. Run a scan to check data quality.</p>
            </div>
          ) : (
            <div className="divide-y max-h-96 overflow-y-auto">
              {logs.map((log: any) => (
                <div key={log.id} className="py-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{log.contact_id}</p>
                    <p className="text-xs text-muted-foreground">{log.validation_message ?? log.issue_type}</p>
                  </div>
                  <Badge className={
                    log.validation_status === "Invalid"
                      ? "bg-red-100 text-red-700"
                      : "bg-amber-100 text-amber-700"
                  }>
                    {log.validation_status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
