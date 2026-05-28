import { getCronHealth } from "@/app/actions/pl-truth-engine"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertTriangle, CheckCircle2, Clock, XCircle, Activity, Zap } from "lucide-react"

export const dynamic = "force-dynamic"

function formatDuration(ms: number | null) {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatRelative(iso: string | null) {
  if (!iso) return "never"
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(diff / 3_600_000)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function StatusIcon({ status, isStale }: { status: string | null; isStale: boolean }) {
  if (isStale && status !== "success") return <AlertTriangle className="h-4 w-4 text-amber-500" />
  if (status === "failure") return <XCircle className="h-4 w-4 text-red-500" />
  if (status === "success") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
  return <Clock className="h-4 w-4 text-slate-400" />
}

function statusBadge(status: string | null, isStale: boolean) {
  if (status === "failure")   return <Badge className="bg-red-100 text-red-800 text-xs">failed</Badge>
  if (isStale && !status)     return <Badge className="bg-amber-100 text-amber-800 text-xs">never run</Badge>
  if (isStale)                return <Badge className="bg-amber-100 text-amber-800 text-xs">stale</Badge>
  if (status === "success")   return <Badge className="bg-emerald-100 text-emerald-800 text-xs">ok</Badge>
  if (status === "running")   return <Badge className="bg-blue-100 text-blue-800 text-xs">running</Badge>
  return <Badge variant="outline" className="text-xs">unknown</Badge>
}

export default async function CronHealthPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(profile?.user_type ?? "")) {
    redirect("/dashboard")
  }

  const result = await getCronHealth()
  if (!result.ok) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Unable to load cron health: {result.error}
      </div>
    )
  }

  const { rows, staleCount, failedCount } = result
  const okCount = rows.filter(r => r.last_status === "success" && !r.is_stale).length
  const neverRun = rows.filter(r => !r.last_run_at).length

  // Group: problems first, then ok, sorted by last_run_at desc
  const sorted = [...rows].sort((a, b) => {
    const aScore = a.last_status === "failure" ? 3 : a.is_stale ? 2 : !a.last_run_at ? 1 : 0
    const bScore = b.last_status === "failure" ? 3 : b.is_stale ? 2 : !b.last_run_at ? 1 : 0
    if (aScore !== bScore) return bScore - aScore
    if (a.last_run_at && b.last_run_at) return new Date(b.last_run_at).getTime() - new Date(a.last_run_at).getTime()
    return 0
  })

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Activity className="h-6 w-6" />
          Cron Health
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {rows.length} registered crons · last updated live
        </p>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span className="text-xs text-muted-foreground">Healthy</span>
            </div>
            <p className="text-2xl font-bold mt-1">{okCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-500" />
              <span className="text-xs text-muted-foreground">Last Run Failed</span>
            </div>
            <p className="text-2xl font-bold mt-1 text-red-600">{failedCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span className="text-xs text-muted-foreground">Stale</span>
            </div>
            <p className="text-2xl font-bold mt-1 text-amber-600">{staleCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-slate-400" />
              <span className="text-xs text-muted-foreground">Never Run</span>
            </div>
            <p className="text-2xl font-bold mt-1 text-slate-500">{neverRun}</p>
          </CardContent>
        </Card>
      </div>

      {/* Main table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">All Crons — {rows.length} registered</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground w-8"></th>
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Cron Name</th>
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Last Run</th>
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Duration</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Records</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">7d Runs</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">7d Failures</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Interval</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => {
                  const rowBg =
                    r.last_status === "failure"
                      ? "bg-red-50/50"
                      : r.is_stale && !r.last_run_at
                      ? "bg-amber-50/30"
                      : r.is_stale
                      ? "bg-amber-50/20"
                      : ""
                  return (
                    <tr key={r.cron_name} className={`border-b last:border-0 ${rowBg}`}>
                      <td className="px-4 py-2.5">
                        <StatusIcon status={r.last_status} isStale={r.is_stale} />
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs">{r.cron_name}</span>
                        {r.last_error_message && (
                          <p className="text-xs text-red-600 mt-0.5 truncate max-w-[280px]">
                            {r.last_error_message}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {statusBadge(r.last_status, r.is_stale)}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">
                        {formatRelative(r.last_run_at)}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">
                        {formatDuration(r.last_duration_ms)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {r.last_records_processed ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs">
                        {r.run_count_7d > 0
                          ? <span className="text-emerald-700 font-medium">{r.run_count_7d}</span>
                          : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs">
                        {r.failure_count_7d > 0
                          ? <span className="text-red-600 font-medium">{r.failure_count_7d}</span>
                          : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {r.expected_interval_hours >= 8760
                          ? "annual"
                          : r.expected_interval_hours >= 168
                          ? `${r.expected_interval_hours / 168}w`
                          : r.expected_interval_hours >= 24
                          ? `${r.expected_interval_hours / 24}d`
                          : `${r.expected_interval_hours}h`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        <Zap className="inline h-3 w-3 mr-1" />
        Stale = last run older than expected interval. Failures and stale crons auto-surface here.
        All 63 crons are pre-seeded; status updates on each successful run.
      </p>
    </div>
  )
}
