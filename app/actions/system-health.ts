"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { redirect } from "next/navigation"

// Types
export type ServiceStatus = {
  id: string
  service_name: string
  service_key: string
  service_category: string
  current_status: "healthy" | "degraded" | "down" | "unknown"
  last_checked_at: string | null
  last_healthy_at: string | null
  consecutive_failures: number
  response_time_ms: number | null
  error_message: string | null
  is_critical: boolean
}

export type HealthCheck = {
  id: string
  service_key: string
  service_name: string
  service_category: string
  status: string
  response_time_ms: number | null
  http_status_code: number | null
  error_message: string | null
  checked_at: string
}

export type HealthMetric = {
  id: string
  service_key: string
  period_start: string
  period_end: string
  total_checks: number
  successful_checks: number
  failed_checks: number
  uptime_pct: number
  avg_response_time_ms: number | null
  p95_response_time_ms: number | null
  incidents_count: number
}

export type CronExecutionLog = {
  id: string
  cron_path: string
  cron_name: string
  status: "completed" | "failed" | "timeout" | "started"
  duration_ms: number | null
  records_processed: number | null
  error_message: string | null
  started_at: string
  completed_at: string | null
  metadata: Record<string, unknown> | null
}

export type AutomationError = {
  id: string
  workflow_name: string
  error_message: string
  severity: "critical" | "high" | "medium" | "low"
  status: string
  created_at: string
  resolved_at: string | null
}

export type HealthCheckHistory = {
  id: string
  service_key: string
  snapshot_date: string
  uptime_pct: number
  failed_checks: number
  avg_response_ms: number | null
  incidents: number
}

export type ApiResponseLog = {
  id: string
  service_key: string
  endpoint: string
  response_time_ms: number
  status_code: number
  is_error: boolean
  error_type: string | null
  recorded_at: string
}

export type MessageProviderStats = {
  provider_key: string
  sent_count: number
  error_count: number
  delivery_rate: number
}

// ============================================================================
// Server Actions
// ============================================================================

export async function getServiceStatuses(): Promise<{
  services: ServiceStatus[]
  overallStatus: "operational" | "critical" | "degraded"
  criticalIssues: ServiceStatus[]
  lastCheckedAt: string | null
}> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx) {
    redirect("/login")
  }

  // Role gate: superadmin, admin, broker only
  if (!["superadmin", "admin", "broker"].includes(ctx.role)) {
    redirect("/dashboard")
  }

  const { data: services, error } = await supabase
    .from("service_status")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .order("is_critical", { ascending: false })
    .order("service_category")
    .order("service_name")

  if (error) {
    console.error("Error fetching service statuses:", error)
    return {
      services: [],
      overallStatus: "operational",
      criticalIssues: [],
      lastCheckedAt: null,
    }
  }

  const typedServices = (services || []) as ServiceStatus[]

  // Determine overall status
  const criticalDown = typedServices.filter(
    (s) => s.is_critical && s.current_status === "down"
  )
  const anyDegraded = typedServices.some(
    (s) => s.current_status === "degraded" || s.current_status === "down"
  )

  let overallStatus: "operational" | "critical" | "degraded" = "operational"
  if (criticalDown.length > 0) {
    overallStatus = "critical"
  } else if (anyDegraded) {
    overallStatus = "degraded"
  }

  // Get last checked timestamp
  const lastCheckedAt = typedServices.reduce((latest, s) => {
    if (!s.last_checked_at) return latest
    if (!latest) return s.last_checked_at
    return new Date(s.last_checked_at) > new Date(latest)
      ? s.last_checked_at
      : latest
  }, null as string | null)

  return {
    services: typedServices,
    overallStatus,
    criticalIssues: criticalDown,
    lastCheckedAt,
  }
}

export async function getServiceHealthHistory(
  serviceKey: string,
  limit = 10
): Promise<HealthCheck[]> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return []
  }

  const { data, error } = await supabase
    .from("system_health_checks")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("service_key", serviceKey)
    .order("checked_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Error fetching health history:", error)
    return []
  }

  return (data || []) as HealthCheck[]
}

export async function getUptimeHistory(
  serviceKey: string,
  days = 7
): Promise<HealthCheckHistory[]> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return []
  }

  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)

  const { data, error } = await supabase
    .from("health_check_history")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("service_key", serviceKey)
    .gte("snapshot_date", startDate.toISOString().split("T")[0])
    .order("snapshot_date", { ascending: true })

  if (error) {
    console.error("Error fetching uptime history:", error)
    return []
  }

  return (data || []) as HealthCheckHistory[]
}

export async function getResponseTimeLogs(
  serviceKeys: string[],
  hours = 24
): Promise<ApiResponseLog[]> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return []
  }

  const startTime = new Date()
  startTime.setHours(startTime.getHours() - hours)

  const { data, error } = await supabase
    .from("api_response_logs")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .in("service_key", serviceKeys)
    .gte("recorded_at", startTime.toISOString())
    .order("recorded_at", { ascending: true })

  if (error) {
    console.error("Error fetching response time logs:", error)
    return []
  }

  return (data || []) as ApiResponseLog[]
}

export async function getCronExecutionLogs(limit = 50): Promise<CronExecutionLog[]> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return []
  }

  const { data, error } = await supabase
    .from("cron_execution_logs")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .order("started_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Error fetching cron logs:", error)
    return []
  }

  return (data || []) as CronExecutionLog[]
}

export async function getAutomationErrors(days = 7): Promise<{
  errors: AutomationError[]
  byWorkflow: Record<string, { count: number; severity: string }[]>
}> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return { errors: [], byWorkflow: {} }
  }

  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)

  const { data, error } = await supabase
    .from("automation_errors")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .gte("created_at", startDate.toISOString())
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Error fetching automation errors:", error)
    return { errors: [], byWorkflow: {} }
  }

  const errors = (data || []) as AutomationError[]

  // Group by workflow
  const byWorkflow: Record<string, { count: number; severity: string }[]> = {}
  errors.forEach((err) => {
    if (!byWorkflow[err.workflow_name]) {
      byWorkflow[err.workflow_name] = []
    }
    const existing = byWorkflow[err.workflow_name].find(
      (e) => e.severity === err.severity
    )
    if (existing) {
      existing.count++
    } else {
      byWorkflow[err.workflow_name].push({ count: 1, severity: err.severity })
    }
  })

  return { errors, byWorkflow }
}

export async function getMessageProviderStats(): Promise<MessageProviderStats[]> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return []
  }

  const startTime = new Date()
  startTime.setHours(startTime.getHours() - 24)

  const { data, error } = await supabase
    .from("message_provider_logs")
    .select("provider_key, provider_status")
    .eq("brokerage_id", ctx.brokerageId)
    .gte("event_at", startTime.toISOString())

  if (error) {
    console.error("Error fetching message provider logs:", error)
    return []
  }

  // Aggregate by provider
  const stats: Record<string, { sent: number; errors: number }> = {}
  ;(data || []).forEach((log: { provider_key: string; provider_status: string }) => {
    if (!stats[log.provider_key]) {
      stats[log.provider_key] = { sent: 0, errors: 0 }
    }
    stats[log.provider_key].sent++
    if (
      log.provider_status === "failed" ||
      log.provider_status === "error" ||
      log.provider_status === "bounced"
    ) {
      stats[log.provider_key].errors++
    }
  })

  return Object.entries(stats).map(([provider_key, s]) => ({
    provider_key,
    sent_count: s.sent,
    error_count: s.errors,
    delivery_rate: s.sent > 0 ? ((s.sent - s.errors) / s.sent) * 100 : 100,
  }))
}

export async function getSLASummary(days = 30): Promise<
  {
    service_key: string
    service_name: string
    uptime_30d: number
    avg_response_ms: number
    total_incidents: number
  }[]
> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return []
  }

  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)

  const { data: history, error } = await supabase
    .from("health_check_history")
    .select("service_key, uptime_pct, avg_response_ms, incidents")
    .eq("brokerage_id", ctx.brokerageId)
    .gte("snapshot_date", startDate.toISOString().split("T")[0])

  if (error) {
    console.error("Error fetching SLA summary:", error)
    return []
  }

  // Get service names
  const { data: services } = await supabase
    .from("service_status")
    .select("service_key, service_name")
    .eq("brokerage_id", ctx.brokerageId)

  const serviceNames: Record<string, string> = {}
  ;(services || []).forEach((s: { service_key: string; service_name: string }) => {
    serviceNames[s.service_key] = s.service_name
  })

  // Aggregate by service
  const aggregated: Record<
    string,
    { uptimes: number[]; responseTimes: number[]; incidents: number }
  > = {}
  ;(
    history || []
  ).forEach(
    (h: {
      service_key: string
      uptime_pct: number
      avg_response_ms: number | null
      incidents: number
    }) => {
      if (!aggregated[h.service_key]) {
        aggregated[h.service_key] = { uptimes: [], responseTimes: [], incidents: 0 }
      }
      if (h.uptime_pct !== null) aggregated[h.service_key].uptimes.push(h.uptime_pct)
      if (h.avg_response_ms !== null)
        aggregated[h.service_key].responseTimes.push(h.avg_response_ms)
      aggregated[h.service_key].incidents += h.incidents || 0
    }
  )

  return Object.entries(aggregated)
    .map(([service_key, agg]) => ({
      service_key,
      service_name: serviceNames[service_key] || service_key,
      uptime_30d:
        agg.uptimes.length > 0
          ? agg.uptimes.reduce((a, b) => a + b, 0) / agg.uptimes.length
          : 100,
      avg_response_ms:
        agg.responseTimes.length > 0
          ? Math.round(
              agg.responseTimes.reduce((a, b) => a + b, 0) / agg.responseTimes.length
            )
          : 0,
      total_incidents: agg.incidents,
    }))
    .sort((a, b) => a.uptime_30d - b.uptime_30d) // Sort by worst uptime first
}

export async function triggerManualHealthCheck(): Promise<{
  success: boolean
  message: string
}> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return { success: false, message: "Unauthorized" }
  }

  // Trigger the health check cron via internal API call
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL || ""}/api/cron/health-check`,
      {
        method: "POST",
        headers: {
          "x-cron-secret": process.env.CRON_SECRET || "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ manual: true, brokerageId: ctx.brokerageId }),
      }
    )

    if (!response.ok) {
      return { success: false, message: "Health check trigger failed" }
    }

    return { success: true, message: "Health check initiated" }
  } catch (err) {
    console.error("Error triggering health check:", err)
    return { success: false, message: "Failed to trigger health check" }
  }
}

export async function exportSLAReport(): Promise<{
  success: boolean
  csvData?: string
  error?: string
}> {
  const supabase = await createClient()
  const ctx = await getAgentContext(supabase)

  if (!ctx || !["superadmin", "admin", "broker"].includes(ctx.role)) {
    return { success: false, error: "Unauthorized" }
  }

  const summary = await getSLASummary(30)

  if (summary.length === 0) {
    return { success: false, error: "No data available" }
  }

  // Generate CSV
  const headers = ["Service", "30-Day Uptime %", "Avg Response (ms)", "Total Incidents"]
  const rows = summary.map((s) => [
    s.service_name,
    s.uptime_30d.toFixed(2),
    s.avg_response_ms.toString(),
    s.total_incidents.toString(),
  ])

  const csvData = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n")

  return { success: true, csvData }
}
