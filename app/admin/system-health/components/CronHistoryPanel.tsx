// app/admin/system-health/components/CronHistoryPanel.tsx
//
// Live Cron Execution History Dashboard
//
// Shows:
// - Last 50 cron executions with status, duration, records processed
// - Failure alerting for last 24h
// - Correlation ID search for debugging
// - Average duration per cron type
// - Success rate trends

"use client"

import { useEffect, useState } from "react"
import { createClient } from "@supabase/supabase-js"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  RefreshCw, 
  Search, 
  AlertTriangle,
  TrendingDown,
  Activity,
} from "lucide-react"

interface CronExecutionLog {
  id: string
  cron_path: string
  cron_name: string
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  status: "running" | "success" | "failure" | "partial"
  error_message: string | null
  records_processed: number | null
  metadata: Record<string, any>
  brokerage_id: string | null
  created_at: string
}

export function CronHistoryPanel() {
  const [logs, setLogs] = useState<CronExecutionLog[]>([])
  const [loading, setLoading] = useState(true)
  const [searchCorrelationId, setSearchCorrelationId] = useState("")
  const [filteredLogs, setFilteredLogs] = useState<CronExecutionLog[]>([])
  const [stats, setStats] = useState({
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    last24hFailures: 0,
    avgDuration: 0,
  })

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const fetchLogs = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from("cron_execution_logs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(50)

      if (error) {
        console.error("[v0] Error fetching cron logs:", error)
        return
      }

      setLogs(data || [])

      // Calculate stats
      const total = data?.length || 0
      const successes = data?.filter((d) => d.status === "success").length || 0
      const failures = data?.filter((d) => d.status === "failure").length || 0
      const last24h = data?.filter((d) => {
        const date = new Date(d.completed_at || d.started_at)
        const now = new Date()
        return now.getTime() - date.getTime() < 24 * 60 * 60 * 1000
      })
      const last24hFailures = last24h?.filter((d) => d.status === "failure").length || 0
      const avgDuration =
        data && data.length > 0
          ? Math.round(
              data.reduce((sum, d) => sum + (d.duration_ms || 0), 0) /
                data.filter((d) => d.duration_ms).length
            )
          : 0

      setStats({
        totalRuns: total,
        successCount: successes,
        failureCount: failures,
        last24hFailures,
        avgDuration,
      })

      // Filter by correlation ID if searching
      if (searchCorrelationId.trim()) {
        const filtered = data?.filter((d) => {
          const correlationId = d.metadata?.correlation_id || ""
          return correlationId.includes(searchCorrelationId)
        })
        setFilteredLogs(filtered || [])
      } else {
        setFilteredLogs(data || [])
      }
    } catch (error) {
      console.error("[v0] Failed to fetch cron logs:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()
    // Refresh every 30 seconds
    const interval = setInterval(fetchLogs, 30000)
    return () => clearInterval(interval)
  }, [])

  // Filter when search changes
  useEffect(() => {
    if (searchCorrelationId.trim()) {
      const filtered = logs.filter((d) => {
        const correlationId = d.metadata?.correlation_id || ""
        return correlationId.includes(searchCorrelationId)
      })
      setFilteredLogs(filtered)
    } else {
      setFilteredLogs(logs)
    }
  }, [searchCorrelationId, logs])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle2 className="h-5 w-5 text-green-600" />
      case "failure":
        return <AlertCircle className="h-5 w-5 text-red-600" />
      case "partial":
        return <AlertTriangle className="h-5 w-5 text-amber-600" />
      case "running":
        return <Activity className="h-5 w-5 text-blue-600 animate-pulse" />
      default:
        return <Clock className="h-5 w-5 text-gray-400" />
    }
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      success: "default",
      failure: "destructive",
      partial: "secondary",
      running: "outline",
    }
    return <Badge variant={variants[status] || "default"}>{status}</Badge>
  }

  const formatDuration = (ms: number | null) => {
    if (!ms) return "—"
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "—"
    const date = new Date(dateString)
    return date.toLocaleTimeString("en-US", { 
      hour: "2-digit", 
      minute: "2-digit", 
      second: "2-digit",
    })
  }

  return (
    <div className="space-y-6">
      {/* Stats Overview */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalRuns}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Success Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {stats.totalRuns > 0
                ? Math.round((stats.successCount / stats.totalRuns) * 100)
                : 0}%
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failures (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${stats.last24hFailures > 0 ? "text-red-600" : "text-gray-600"}`}>
              {stats.last24hFailures}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Duration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(stats.avgDuration)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Running</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {logs.filter((l) => l.status === "running").length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search & Controls */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Cron Execution History</CardTitle>
              <CardDescription>Last 50 cron runs with status and details</CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={fetchLogs}
              disabled={loading}
              className="bg-transparent"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Correlation ID Search */}
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search correlation ID..."
              value={searchCorrelationId}
              onChange={(e) => setSearchCorrelationId(e.target.value)}
              className="max-w-xs"
            />
            {searchCorrelationId && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSearchCorrelationId("")}
              >
                Clear
              </Button>
            )}
          </div>

          {/* Cron History Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3 font-medium">Cron</th>
                  <th className="text-left py-2 px-3 font-medium">Status</th>
                  <th className="text-left py-2 px-3 font-medium">Started</th>
                  <th className="text-left py-2 px-3 font-medium">Duration</th>
                  <th className="text-left py-2 px-3 font-medium">Records</th>
                  <th className="text-left py-2 px-3 font-medium">Error</th>
                  <th className="text-left py-2 px-3 font-medium">Correlation ID</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-4 px-3 text-center text-muted-foreground">
                      {loading ? "Loading..." : "No cron runs found"}
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => (
                    <tr key={log.id} className="border-b hover:bg-muted/50">
                      <td className="py-2 px-3 font-mono text-xs">{log.cron_name}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          {getStatusIcon(log.status)}
                          {getStatusBadge(log.status)}
                        </div>
                      </td>
                      <td className="py-2 px-3 text-xs">{formatDate(log.started_at)}</td>
                      <td className="py-2 px-3 text-xs">{formatDuration(log.duration_ms)}</td>
                      <td className="py-2 px-3 text-xs">{log.records_processed || "—"}</td>
                      <td className="py-2 px-3 text-xs max-w-xs truncate" title={log.error_message || ""}>
                        {log.error_message ? (
                          <span className="text-red-600">{log.error_message.slice(0, 50)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs font-mono">
                        {log.metadata?.correlation_id
                          ? log.metadata.correlation_id.slice(0, 8)
                          : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {filteredLogs.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Showing {filteredLogs.length} of {logs.length} cron runs
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
