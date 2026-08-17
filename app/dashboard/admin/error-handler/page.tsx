export const dynamic = "force-dynamic"

import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getErrorMetrics } from "@/app/actions/error-handler"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertTriangle, TrendingUp, Clock, CheckCircle } from "lucide-react"
import ErrorHandlerClient from "./error-handler-client"

export const metadata = {
  title: "Error Handler | VIP-OS Admin",
  description: "Monitor and manage system automation errors",
}

/** Deterministic triage over the SAME metrics the cards show — an error
 *  console's job is to say what to fix first, not to display four counters.
 *  Signal ownership: automation-error triage is the platform_sentinel /
 *  cron-manager domain (lib/kernel/manager-registry.ts); this composes that
 *  manager's existing signal and mints nothing new. */
function ErrorTriageRead({ metrics }: { metrics: Awaited<ReturnType<typeof getErrorMetrics>> }) {
  const reads: Array<{ severity: "urgent" | "warn" | "good"; text: string }> = []
  const sev = metrics.severityCounts
  const top = metrics.topErrors[0]

  if (metrics.totalErrors24h === 0) {
    reads.push({ severity: "good", text: "No automation errors in the last 24 hours — the rails are running clean." })
  } else {
    if (sev.critical > 0) {
      reads.push({
        severity: "urgent",
        text: `${sev.critical} critical error${sev.critical === 1 ? "" : "s"} in 24h — critical means a rail stopped, not that it retried. These block work until someone clears them.`,
      })
    }
    if (top && top.error_count >= 3) {
      const share = Math.round((top.error_count / Math.max(1, metrics.totalErrors24h)) * 100)
      reads.push({
        severity: "warn",
        text: `"${top.error_type}" accounts for ${top.error_count} of ${metrics.totalErrors24h} errors (${share}%) — this is one broken thing repeating, not ${metrics.totalErrors24h} separate problems. Fix it and the board mostly clears.`,
      })
    }
    if (metrics.retrySuccessRate >= 80) {
      reads.push({
        severity: "good",
        text: `${metrics.retrySuccessRate}% of auto-retries succeeded — most failures are self-healing; what's left on this board genuinely needs a human.`,
      })
    } else if (metrics.retrySuccessRate < 40) {
      reads.push({
        severity: "urgent",
        text: `Auto-retry is only succeeding ${metrics.retrySuccessRate}% of the time — retrying isn't fixing these. The failure is upstream (credentials, schema, or a provider that's down), so retries just burn attempts.`,
      })
    }
    if (sev.critical === 0 && sev.high === 0 && metrics.totalErrors24h > 0) {
      reads.push({
        severity: "good",
        text: "Nothing critical or high — everything on the board is medium/low noise that the retry loop is absorbing.",
      })
    }
  }

  const STYLE: Record<string, string> = {
    urgent: "border-red-200 bg-red-50/60", warn: "border-amber-200 bg-amber-50/60", good: "border-emerald-200 bg-emerald-50/60",
  }
  const DOT: Record<string, string> = { urgent: "bg-red-500", warn: "bg-amber-500", good: "bg-emerald-500" }

  return (
    <Card className="border-indigo-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Your AI team&apos;s read</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {reads.map((r, i) => (
          <div key={i} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${STYLE[r.severity]}`}>
            <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${DOT[r.severity]}`} />
            <p className="text-sm leading-relaxed">{r.text}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

async function ErrorMetricsSection() {
  try {
    const metrics = await getErrorMetrics()

    return (
      <div className="space-y-4">
      <ErrorTriageRead metrics={metrics} />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Critical Errors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{metrics.severityCounts.critical}</p>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-orange-500" />
              Total Errors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{metrics.totalErrors24h}</p>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-blue-500" />
              Retry Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{metrics.retrySuccessRate}%</p>
            <p className="text-xs text-muted-foreground">Success rate</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Top Error Type
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold truncate">
              {metrics.topErrors[0]?.error_type || "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              {metrics.topErrors[0]?.error_count || 0} occurrences
            </p>
          </CardContent>
        </Card>
      </div>
      </div>
    )
  } catch (error) {
    console.error("Error loading metrics:", error)
    return <div className="text-sm text-muted-foreground">Failed to load metrics</div>
  }
}

export default async function ErrorHandlerPage() {
  const { role } = await getAgentContext()

  // Only admins and compliance officers can access.
  // SCOPE LADDER (kept inline — admits compliance_officer): 'superadmin'
  // removed — dead as users.user_type (0 live rows); broker_owner added.
  if (!["broker", "broker_owner", "admin", "compliance_officer"].includes(role)) {
    redirect("/dashboard")
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Error Handler</h1>
          <p className="text-muted-foreground">
            Monitor, debug, and resolve system automation errors
          </p>
        </div>

        {/* Metrics */}
        <div className="mb-8">
          <Suspense
            fallback={
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-24" />
                ))}
              </div>
            }
          >
            <ErrorMetricsSection />
          </Suspense>
        </div>

        {/* Error Groups and Details */}
        <Suspense fallback={<Skeleton className="h-96" />}>
          <ErrorHandlerClient />
        </Suspense>
      </div>
    </main>
  )
}
