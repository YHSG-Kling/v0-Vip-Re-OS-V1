import { Suspense } from "react"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import {
  getServiceStatuses,
  getCronExecutionLogs,
  getAutomationErrors,
  getMessageProviderStats,
  getSLASummary,
} from "@/app/actions/system-health"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ServiceStatusCard } from "@/app/components/admin/health/ServiceStatusCard"
import { ResponseTimeChart } from "@/app/components/admin/health/ResponseTimeChart"
import { CronHistoryTable } from "@/app/components/admin/health/CronHistoryTable"
import { ErrorRateWidget } from "@/app/components/admin/health/ErrorRateWidget"
import { HealthDashboardClient } from "./health-dashboard-client"

export const dynamic = "force-dynamic"

export default async function SystemHealthPage() {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx) {
    redirect("/login")
  }

  // Role gate: superadmin, admin, broker only
  if (!["superadmin", "admin", "broker"].includes(ctx.role)) {
    redirect("/dashboard")
  }

  // Fetch initial data
  const [
    serviceData,
    cronLogs,
    automationErrorsData,
    messageStats,
    slaSummary,
  ] = await Promise.all([
    getServiceStatuses(),
    getCronExecutionLogs(50),
    getAutomationErrors(7),
    getMessageProviderStats(),
    getSLASummary(30),
  ])

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Page Header */}
      <HealthDashboardClient
        initialServices={serviceData.services}
        initialOverallStatus={serviceData.overallStatus}
        initialCriticalIssues={serviceData.criticalIssues}
        initialLastCheckedAt={serviceData.lastCheckedAt}
      />

      {/* Critical Services Banner */}
      {serviceData.criticalIssues.length > 0 && (
        <div className="flex flex-col gap-2">
          {serviceData.criticalIssues.map((issue) => (
            <div
              key={issue.id}
              className="flex items-center justify-between rounded-lg border border-destructive bg-destructive/10 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="text-destructive font-medium">
                  {issue.service_name} is {issue.current_status}
                </span>
                {issue.error_message && (
                  <span className="text-sm text-muted-foreground truncate max-w-md">
                    — {issue.error_message}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Status Grid */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Service Status</h2>
        {serviceData.services.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">
                Health checks will appear after the first cron run (every 5 minutes)
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {serviceData.services.map((service) => (
              <Suspense key={service.id} fallback={<Skeleton className="h-40" />}>
                <ServiceStatusCard service={service} />
              </Suspense>
            ))}
          </div>
        )}
      </section>

      {/* Response Time Chart */}
      <section>
        <Card>
          <CardHeader>
            <CardTitle>Response Times (24h)</CardTitle>
            <CardDescription>
              Average response times by service over the last 24 hours
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<Skeleton className="h-64" />}>
              <ResponseTimeChart
                criticalServices={serviceData.services
                  .filter((s) => s.is_critical)
                  .map((s) => s.service_key)}
              />
            </Suspense>
          </CardContent>
        </Card>
      </section>

      {/* Error Rate and Message Provider Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Error Rate by Module */}
        <section>
          <Card>
            <CardHeader>
              <CardTitle>Error Rate by Module (7 days)</CardTitle>
              <CardDescription>
                Top 10 workflows by error count
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Suspense fallback={<Skeleton className="h-64" />}>
                <ErrorRateWidget data={automationErrorsData} />
              </Suspense>
            </CardContent>
          </Card>
        </section>

        {/* Message Provider Health */}
        <section>
          <Card>
            <CardHeader>
              <CardTitle>Message Provider Health (24h)</CardTitle>
              <CardDescription>
                Delivery rates by provider
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {messageStats.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No message data in the last 24 hours
                  </p>
                ) : (
                  messageStats.map((stat) => (
                    <div
                      key={stat.provider_key}
                      className="flex items-center justify-between"
                    >
                      <div>
                        <p className="font-medium capitalize">
                          {stat.provider_key.replace(/_/g, " ")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {stat.sent_count} sent, {stat.error_count} errors
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {stat.delivery_rate.toFixed(1)}%
                        </span>
                        {stat.delivery_rate < 80 ? (
                          <Badge variant="destructive">Alert</Badge>
                        ) : stat.delivery_rate < 95 ? (
                          <Badge variant="secondary">Warning</Badge>
                        ) : (
                          <Badge className="bg-green-500/10 text-green-600">Good</Badge>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </section>
      </div>

      {/* Cron Execution Table */}
      <section>
        <Card>
          <CardHeader>
            <CardTitle>Cron Execution History</CardTitle>
            <CardDescription>
              Last 50 cron job executions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<Skeleton className="h-64" />}>
              <CronHistoryTable logs={cronLogs} />
            </Suspense>
          </CardContent>
        </Card>
      </section>

      {/* SLA Summary */}
      <section>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>SLA Summary (30 days)</CardTitle>
              <CardDescription>
                Service level performance sorted by worst uptime first
              </CardDescription>
            </div>
            <SLAExportButton />
          </CardHeader>
          <CardContent>
            {slaSummary.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No SLA data available yet
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 font-medium">Service</th>
                      <th className="text-right py-3 px-4 font-medium">30-Day Uptime</th>
                      <th className="text-right py-3 px-4 font-medium">Avg Response</th>
                      <th className="text-right py-3 px-4 font-medium">Incidents</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slaSummary.map((row) => (
                      <tr key={row.service_key} className="border-b last:border-0">
                        <td className="py-3 px-4">{row.service_name}</td>
                        <td className="py-3 px-4 text-right">
                          <span
                            className={
                              row.uptime_30d >= 99.9
                                ? "text-green-600"
                                : row.uptime_30d >= 99
                                  ? "text-amber-600"
                                  : "text-destructive"
                            }
                          >
                            {row.uptime_30d.toFixed(2)}%
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span
                            className={
                              row.avg_response_ms < 300
                                ? "text-green-600"
                                : row.avg_response_ms < 1000
                                  ? "text-amber-600"
                                  : "text-destructive"
                            }
                          >
                            {row.avg_response_ms}ms
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {row.total_incidents > 0 ? (
                            <Badge variant="destructive">{row.total_incidents}</Badge>
                          ) : (
                            <Badge variant="outline">0</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function SLAExportButton() {
  return (
    <form
      action={async () => {
        "use server"
        const { exportSLAReport } = await import("@/app/actions/system-health")
        const result = await exportSLAReport()
        if (result.success && result.csvData) {
          // In a real implementation, this would trigger a download
          // For now, we'll just return the data
          console.log("SLA Report generated")
        }
      }}
    >
      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4"
      >
        Export SLA Report
      </button>
    </form>
  )
}
