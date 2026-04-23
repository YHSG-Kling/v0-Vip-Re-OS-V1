"use client"

import { useState, useEffect, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Loader2, Shield, AlertTriangle, CheckCircle2, RefreshCw, Scan } from "lucide-react"
import { toast } from "sonner"
import { getDataHealthStats, runDataHygieneScan, getDataHealthLogs } from "@/app/actions/data-health"

export default function DataHealthPage() {
  const [stats, setStats] = useState<any>(null)
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  const loadData = async () => {
    const [statsRes, logsRes] = await Promise.allSettled([
      getDataHealthStats(),
      getDataHealthLogs({}),
    ])
    if (statsRes.status === "fulfilled" && statsRes.value.success) {
      setStats(statsRes.value.stats)
    }
    if (logsRes.status === "fulfilled" && (logsRes.value as any).success) {
      setLogs((logsRes.value as any).logs ?? [])
    }
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

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
          <p className="text-muted-foreground text-sm mt-1">Contact database hygiene and validation</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); loadData() }} disabled={isPending}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button size="sm" onClick={handleScan} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Scan className="h-4 w-4 mr-1" />}
            Run Scan
          </Button>
        </div>
      </div>

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
