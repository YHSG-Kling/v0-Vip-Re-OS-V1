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

// TOMBSTONE (§1.3, 2026-08-27): `HealthMetric` deleted — it described a period-based
// system_health_metrics rollup table that does not exist on the live database and
// that nothing referenced. The uptime rollup is BUILT ANOTHER WAY: the daily
// health_check_history snapshots written by app/api/cron/health-check and read by
// getSlaSummary below (service_key, uptime_pct, avg_response_ms, incidents).

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

/**
 * One failed dispatch, with everything the writers recorded about WHY (lane
 * M2 — these columns had five writers and no reader): the provider's
 * error_message, the channel and direction, what the provider later reported
 * back through the webhook fanout (provider_event, and the provider_response
 * envelope that names the recipient/subject), and the source rows the send
 * came from (message_id → messages, outreach_log_id → isa_outreach_log).
 */
export type MessageProviderFailure = {
  channel: string | null
  direction: string | null
  provider_key: string
  error_message: string | null
  provider_event: string | null
  provider_response: Record<string, unknown> | null
  message_id: string | null
  outreach_log_id: string | null
  sent_at: string | null
  event_at: string | null
}

export type MessageProviderSummary = {
  windowHours: number
  providers: MessageProviderStats[]
  /**
   * The most recent failed/errored/bounced dispatches in the window — the
   * rows behind error_count, so "3 failed" is inspectable instead of a bare
   * number. Empty when everything delivered.
   */
  recentFailures: MessageProviderFailure[]
  /**
   * Rows in message_provider_logs that carry NEITHER sent_at NOR event_at and
   * are therefore invisible to ANY time-windowed aggregate. Failed sends from
   * lib/services/communication.service.tsx write sent_at: null on failure, so
   * this count is skewed toward failures — surfacing it is the only way a
   * delivery-rate number can be read honestly.
   */
  undatedExcluded: number
}

// ============================================================================
// READ VERDICTS
// ----------------------------------------------------------------------------
// An observability reader must never let a REFUSED read look like a healthy
// zero. supabase-js resolves a refused query instead of throwing, so
// `const { data } = await ...` plus `data ?? []` renders "0 errors / 100%
// uptime" out of an RLS denial. Every reader below reports one of three
// states and the caller renders each differently:
//
//   ok          - the query ran and returned rows. The numbers are real.
//   empty       - the query ran and returned nothing. This is an ABSENCE OF
//                 MEASUREMENT, not a clean bill of health. `collector` names
//                 the process that was supposed to write the rows.
//   unavailable - the caller is not authorized, has no tenant scope, or the
//                 query was refused. The UI must render a failure here and
//                 must NOT render a metric.
// ============================================================================

export type HealthReadFailure = "unauthorized" | "not_scoped" | "query_failed"

export type HealthRead<T> =
  | { status: "ok"; data: T }
  | { status: "empty"; collector: string; detail: string }
  | { status: "unavailable"; reason: HealthReadFailure; detail: string }

// TRUE ADMIN GATES (operational: system health) — every role check in this file
// is repointed to the ONE tenant roster (isAdminOrBroker). The old
// ["superadmin","admin","broker"] literals were dead on 'superadmin': 0 live
// rows store that users.user_type.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { serviceCatalogueScope } from "@/lib/platform/service-catalogue-scope"

// ============================================================================
// Server Actions
// ============================================================================

export async function getServiceStatuses(): Promise<{
  services: ServiceStatus[]
  overallStatus: "operational" | "critical" | "degraded" | "unknown"
  criticalIssues: ServiceStatus[]
  lastCheckedAt: string | null
  /** How to read `overallStatus`. "unknown" is ONLY ever paired with empty/unavailable. */
  readStatus: "ok" | "empty" | "unavailable"
  readDetail: string | null
}> {
  const ctx = await getAgentContext()

  if (!ctx.isAuthenticated) {
    redirect("/login")
  }

  // Role gate: brokerage admin roles only
  if (!isAdminOrBroker({ user_type: ctx.role })) {
    redirect("/dashboard")
  }

  if (!ctx.brokerageId) {
    return {
      services: [],
      overallStatus: "unknown",
      criticalIssues: [],
      lastCheckedAt: null,
      readStatus: "unavailable",
      readDetail:
        "This session has no brokerage. service_status RLS is (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()); with no tenant to anchor the second arm there is no scope to read under, so the catalogue is not read at all.",
    }
  }

  const supabase = await createClient()
  // SCOPE, NOT `.eq`. `service_status` is the PLATFORM catalogue: all 13 live
  // rows carry brokerage_id IS NULL and nothing in the tree ever inserts a
  // per-tenant one, so `.eq("brokerage_id", <uuid>)` matched zero rows and this
  // page told every brokerage admin "no service is registered" over a full
  // table. serviceCatalogueScope mirrors the live RLS SELECT policy exactly —
  // the untenanted platform row plus this tenant's own, never another tenant's.
  // See lib/platform/service-catalogue-scope.ts for the measurement.
  const { data: services, error } = await supabase
    .from("service_status")
    .select("*")
    .or(serviceCatalogueScope(ctx.brokerageId))
    .order("is_critical", { ascending: false })
    .order("service_category")
    .order("service_name")

  if (error) {
    console.error("Error fetching service statuses:", error)
    // A REFUSED read is not an operational platform. Previously this returned
    // overallStatus "operational" from a denial — a green tick manufactured
    // out of an error.
    return {
      services: [],
      overallStatus: "unknown",
      criticalIssues: [],
      lastCheckedAt: null,
      readStatus: "unavailable",
      readDetail: `service_status read was refused: ${error.message}`,
    }
  }

  const typedServices = (services ?? []) as ServiceStatus[]

  if (typedServices.length === 0) {
    // Neither the platform catalogue nor a tenant row is visible, so NOTHING
    // has been measured. Reporting "operational" here is the defect this rail
    // exists to prevent.
    return {
      services: [],
      overallStatus: "unknown",
      criticalIssues: [],
      lastCheckedAt: null,
      readStatus: "empty",
      readDetail:
        "No service is registered in service_status — neither the platform catalogue nor a row for this brokerage — so no health check has ever run. System status is UNKNOWN, not operational.",
    }
  }

  // Determine overall status
  const criticalDown = typedServices.filter(
    (s) => s.is_critical && s.current_status === "down"
  )
  const anyDegraded = typedServices.some(
    (s) => s.current_status === "degraded" || s.current_status === "down"
  )

  let overallStatus: "operational" | "critical" | "degraded" | "unknown" = "operational"
  if (criticalDown.length > 0) {
    overallStatus = "critical"
  } else if (anyDegraded) {
    overallStatus = "degraded"
  } else if (typedServices.every((s) => s.current_status === "unknown" || !s.last_checked_at)) {
    // Rows exist but no check has ever landed on any of them. Registered is
    // not the same as measured.
    overallStatus = "unknown"
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
    readStatus: "ok",
    readDetail:
      lastCheckedAt === null
        ? "Services are registered but no health check has ever recorded a timestamp against them."
        : null,
  }
}

export async function getServiceHealthHistory(
  serviceKey: string,
  limit = 10
): Promise<HealthRead<HealthCheck[]>> {
  const ctx = await getAgentContext()

  if (!ctx.isAuthenticated || !isAdminOrBroker({ user_type: ctx.role })) {
    return {
      status: "unavailable",
      reason: "unauthorized",
      detail: "System health history is limited to brokerage admin roles.",
    }
  }
  if (!ctx.brokerageId) {
    return {
      status: "unavailable",
      reason: "not_scoped",
      detail:
        "This session has no brokerage. system_health_checks is tenant-scoped and its RLS admits untenanted rows, so it is never read without an explicit brokerage filter.",
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("system_health_checks")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("service_key", serviceKey)
    .order("checked_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Error fetching health history:", error)
    return {
      status: "unavailable",
      reason: "query_failed",
      detail: `system_health_checks read was refused: ${error.message}`,
    }
  }

  const rows = (data ?? []) as HealthCheck[]
  if (rows.length === 0) {
    return {
      status: "empty",
      collector: "app/api/cron/health-check (scheduled 13,28,43,58 * * * * by lib/kernel/cron-dispatch.ts)",
      detail: `No health check has ever been recorded for "${serviceKey}" under this brokerage. That is an absence of measurement, not a passing check.`,
    }
  }

  return { status: "ok", data: rows }
}

export async function getUptimeHistory(
  serviceKey: string,
  days = 7
): Promise<HealthRead<HealthCheckHistory[]>> {
  const ctx = await getAgentContext()

  if (!ctx.isAuthenticated || !isAdminOrBroker({ user_type: ctx.role })) {
    return {
      status: "unavailable",
      reason: "unauthorized",
      detail: "Uptime history is limited to brokerage admin roles.",
    }
  }
  if (!ctx.brokerageId) {
    return {
      status: "unavailable",
      reason: "not_scoped",
      detail:
        "This session has no brokerage. health_check_history is tenant-scoped and its RLS admits untenanted rows, so it is never read without an explicit brokerage filter.",
    }
  }

  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("health_check_history")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("service_key", serviceKey)
    .gte("snapshot_date", startDate.toISOString().split("T")[0])
    .order("snapshot_date", { ascending: true })

  if (error) {
    console.error("Error fetching uptime history:", error)
    return {
      status: "unavailable",
      reason: "query_failed",
      detail: `health_check_history read was refused: ${error.message}`,
    }
  }

  const rows = (data ?? []) as HealthCheckHistory[]
  if (rows.length === 0) {
    return {
      status: "empty",
      collector: "app/api/cron/health-check (daily rollup rows keyed service_key + snapshot_date + brokerage_id)",
      detail: `No daily uptime snapshot exists for "${serviceKey}" in the last ${days} days. Uptime is unknown here — it is not 100%.`,
    }
  }

  return { status: "ok", data: rows }
}

export async function getResponseTimeLogs(
  serviceKeys: string[],
  hours = 24
): Promise<HealthRead<ApiResponseLog[]>> {
  const ctx = await getAgentContext()

  if (!ctx.isAuthenticated || !isAdminOrBroker({ user_type: ctx.role })) {
    return {
      status: "unavailable",
      reason: "unauthorized",
      detail: "API latency logs are limited to brokerage admin roles.",
    }
  }
  if (!ctx.brokerageId) {
    return {
      status: "unavailable",
      reason: "not_scoped",
      detail:
        "This session has no brokerage. api_response_logs RLS is (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()), so dropping the explicit filter would expose every tenant's untenanted egress telemetry.",
    }
  }
  if (serviceKeys.length === 0) {
    return {
      status: "empty",
      collector: "lib/agentic-os/connector-gateway.ts logApiResponse",
      detail: "No service was selected, so no latency window was read.",
    }
  }

  const startTime = new Date()
  startTime.setHours(startTime.getHours() - hours)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("api_response_logs")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .in("service_key", serviceKeys)
    .gte("recorded_at", startTime.toISOString())
    .order("recorded_at", { ascending: true })

  if (error) {
    console.error("Error fetching response time logs:", error)
    return {
      status: "unavailable",
      reason: "query_failed",
      detail: `api_response_logs read was refused: ${error.message}`,
    }
  }

  const rows = (data ?? []) as ApiResponseLog[]
  if (rows.length === 0) {
    return {
      status: "empty",
      collector: "lib/agentic-os/connector-gateway.ts logApiResponse — writes brokerage_id: null on every row",
      detail:
        "No tenant-attributed latency samples exist. The only writer of api_response_logs records untenanted rows, so a tenant-scoped read of this table is expected to stay empty until the gateway attributes a brokerage. Read this as UNINSTRUMENTED, not as zero latency and zero errors.",
    }
  }

  return { status: "ok", data: rows }
}

export async function getCronExecutionLogs(limit = 50): Promise<CronExecutionLog[]> {
  const supabase = await createClient()
  const ctx = await getAgentContext()

  if (!ctx || !isAdminOrBroker({ user_type: ctx.role })) {
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
  const ctx = await getAgentContext()

  if (!ctx || !isAdminOrBroker({ user_type: ctx.role })) {
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

export async function getMessageProviderStats(
  hours = 24
): Promise<HealthRead<MessageProviderSummary>> {
  const ctx = await getAgentContext()

  if (!ctx.isAuthenticated || !isAdminOrBroker({ user_type: ctx.role })) {
    return {
      status: "unavailable",
      reason: "unauthorized",
      detail: "Message provider delivery stats are limited to brokerage admin roles.",
    }
  }
  if (!ctx.brokerageId) {
    return {
      status: "unavailable",
      reason: "not_scoped",
      detail:
        "This session has no brokerage. message_provider_logs RLS admits untenanted rows, so it is never read without an explicit brokerage filter.",
    }
  }

  const startTime = new Date()
  startTime.setHours(startTime.getHours() - hours)
  const since = startTime.toISOString()

  const supabase = await createClient()

  // COLUMN AUDIT: event_at has NO default and NO writer in this codebase sets
  // it (all five inserters populate sent_at, which defaults to now()). The
  // original `.gte("event_at", ...)` filter therefore excluded every row that
  // has ever been written — a permanent zero wearing a working query. Match on
  // EITHER timestamp so the window reflects what the writers actually record.
  const { data, error } = await supabase
    .from("message_provider_logs")
    .select("provider_key, provider_status, sent_at, event_at")
    .eq("brokerage_id", ctx.brokerageId)
    .or(`sent_at.gte.${since},event_at.gte.${since}`)

  if (error) {
    console.error("Error fetching message provider logs:", error)
    return {
      status: "unavailable",
      reason: "query_failed",
      detail: `message_provider_logs read was refused: ${error.message}`,
    }
  }

  // Rows with neither timestamp cannot fall inside ANY window. Failed sends
  // from communication.service write sent_at: null, so this bucket skews
  // toward failures; a delivery rate that hides it would read too clean.
  const { count: undatedCount, error: undatedError } = await supabase
    .from("message_provider_logs")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", ctx.brokerageId)
    .is("sent_at", null)
    .is("event_at", null)

  if (undatedError) {
    console.error("Error counting undated message provider logs:", undatedError)
    return {
      status: "unavailable",
      reason: "query_failed",
      detail: `message_provider_logs undated-row count was refused: ${undatedError.message}`,
    }
  }

  const rows = (data ?? []) as Array<{ provider_key: string; provider_status: string | null }>
  const undatedExcluded = undatedCount ?? 0

  if (rows.length === 0 && undatedExcluded === 0) {
    return {
      status: "empty",
      collector:
        "lib/services/communication.service.tsx, lib/campaign-sequences/step-executor.ts, lib/ai-isa/direct-mail-trigger.ts, app/actions/ai-communication-hub.ts, app/actions/social-dm.ts",
      detail: `No provider dispatch was logged for this brokerage in the last ${hours}h. Nothing was sent — this is not a 100% delivery rate.`,
    }
  }

  // Aggregate by provider. The vocabulary actually written by the five
  // inserters is 'sent' | 'failed'; 'error' and 'bounced' are accepted because
  // no CHECK constrains provider_status and a webhook may widen it later.
  const stats: Record<string, { sent: number; errors: number }> = {}
  for (const log of rows) {
    const key = log.provider_key
    if (!stats[key]) stats[key] = { sent: 0, errors: 0 }
    stats[key].sent++
    if (
      log.provider_status === "failed" ||
      log.provider_status === "error" ||
      log.provider_status === "bounced"
    ) {
      stats[key].errors++
    }
  }

  const providers = Object.entries(stats).map(([provider_key, s]) => ({
    provider_key,
    sent_count: s.sent,
    error_count: s.errors,
    // Only ever computed from rows that exist. A provider with no rows is not
    // listed at all rather than being listed at 100%.
    delivery_rate: ((s.sent - s.errors) / s.sent) * 100,
  }))

  // THE FAILURES BEHIND THE COUNT (lane M2). The aggregate above says "N
  // failed" and, until this read, nothing anywhere showed WHICH sends failed
  // or what the provider said — error_message, channel, direction, the
  // webhook-reported provider_event, the provider_response envelope (which
  // carries the recipient and subject/excerpt the writers stamp), and the
  // message_id / outreach_log_id linking back to the source rows were written
  // by five inserters and read by nobody. Deliberately NOT windowed on the
  // timestamps: failed sends from communication.service carry sent_at NULL
  // (and no webhook ever stamps event_at on them), so the aggregate's OR
  // window excludes exactly the rows this list exists for — the same rows the
  // undatedExcluded caveat above counts. The table has no created_at, so
  // there is no honest chronology for those rows either; this orders webhook-
  // stamped failures (bounces) newest-first and surfaces the undatable ones
  // ahead of them rather than pretending to a recency the schema cannot back.
  const { data: failureRows, error: failuresError } = await supabase
    .from("message_provider_logs")
    .select(
      "channel, direction, provider_key, error_message, provider_event, provider_response, message_id, outreach_log_id, sent_at, event_at",
    )
    .eq("brokerage_id", ctx.brokerageId)
    .in("provider_status", ["failed", "error", "bounced"])
    .order("event_at", { ascending: false, nullsFirst: true })
    .limit(10)

  if (failuresError) {
    console.error("Error fetching message provider failures:", failuresError)
    return {
      status: "unavailable",
      reason: "query_failed",
      detail: `message_provider_logs failure detail read was refused: ${failuresError.message}`,
    }
  }

  const recentFailures = (failureRows ?? []) as MessageProviderFailure[]

  return { status: "ok", data: { windowHours: hours, providers, recentFailures, undatedExcluded } }
}

export type SLARow = {
  service_key: string
  service_name: string
  uptime_30d: number
  avg_response_ms: number
  total_incidents: number
}

/**
 * Single honest implementation behind BOTH getSLASummary (legacy array shape,
 * kept for its existing panel caller) and exportSLAReport (verdict shape).
 * Never invents a number: a service with no snapshot rows is not emitted at
 * all rather than being emitted at 100% uptime.
 */
async function readSLASummary(
  days: number
): Promise<HealthRead<SLARow[]>> {
  const ctx = await getAgentContext()

  if (!ctx.isAuthenticated || !isAdminOrBroker({ user_type: ctx.role })) {
    return {
      status: "unavailable",
      reason: "unauthorized",
      detail: "SLA reporting is limited to brokerage admin roles.",
    }
  }
  if (!ctx.brokerageId) {
    return {
      status: "unavailable",
      reason: "not_scoped",
      detail:
        "This session has no brokerage. health_check_history and service_status both admit untenanted rows under RLS, so neither is read without an explicit brokerage filter.",
    }
  }

  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)

  const supabase = await createClient()
  const { data: history, error } = await supabase
    .from("health_check_history")
    .select("service_key, uptime_pct, avg_response_ms, incidents")
    .eq("brokerage_id", ctx.brokerageId)
    .gte("snapshot_date", startDate.toISOString().split("T")[0])

  if (error) {
    console.error("Error fetching SLA summary:", error)
    return {
      status: "unavailable",
      reason: "query_failed",
      detail: `health_check_history read was refused: ${error.message}`,
    }
  }

  // Service display names. A refused read here would silently downgrade every
  // label to its raw key, so it is reported rather than swallowed.
  // Same platform-catalogue scope as getServiceStatuses: `.eq("brokerage_id",…)`
  // matched none of the 13 untenanted rows, so EVERY service label in the SLA
  // report silently degraded to its raw key. lib/platform/service-catalogue-scope.ts
  const { data: services, error: servicesError } = await supabase
    .from("service_status")
    .select("service_key, service_name")
    .or(serviceCatalogueScope(ctx.brokerageId))

  if (servicesError) {
    console.error("Error fetching service names for SLA summary:", servicesError)
    return {
      status: "unavailable",
      reason: "query_failed",
      detail: `service_status read was refused: ${servicesError.message}`,
    }
  }

  const rows = (history ?? []) as Array<{
    service_key: string
    uptime_pct: number | null
    avg_response_ms: number | null
    incidents: number | null
  }>

  if (rows.length === 0) {
    return {
      status: "empty",
      collector: "app/api/cron/health-check (daily health_check_history rollup)",
      detail: `No uptime snapshot exists for this brokerage in the last ${days} days. There is no SLA to report — an empty report is not a passing one.`,
    }
  }

  const serviceNames: Record<string, string> = {}
  for (const s of (services ?? []) as Array<{ service_key: string; service_name: string }>) {
    serviceNames[s.service_key] = s.service_name
  }

  const aggregated: Record<
    string,
    { uptimes: number[]; responseTimes: number[]; incidents: number }
  > = {}
  for (const h of rows) {
    if (!aggregated[h.service_key]) {
      aggregated[h.service_key] = { uptimes: [], responseTimes: [], incidents: 0 }
    }
    if (h.uptime_pct !== null) aggregated[h.service_key].uptimes.push(Number(h.uptime_pct))
    if (h.avg_response_ms !== null)
      aggregated[h.service_key].responseTimes.push(h.avg_response_ms)
    aggregated[h.service_key].incidents += h.incidents ?? 0
  }

  const summary = Object.entries(aggregated)
    // A service whose snapshots all carried a null uptime has no measured
    // uptime. Dropping it is honest; defaulting it to 100 is not.
    .filter(([, agg]) => agg.uptimes.length > 0)
    .map(([service_key, agg]) => ({
      service_key,
      service_name: serviceNames[service_key] || service_key,
      uptime_30d: agg.uptimes.reduce((a, b) => a + b, 0) / agg.uptimes.length,
      avg_response_ms:
        agg.responseTimes.length > 0
          ? Math.round(
              agg.responseTimes.reduce((a, b) => a + b, 0) / agg.responseTimes.length
            )
          : 0,
      total_incidents: agg.incidents,
    }))
    .sort((a, b) => a.uptime_30d - b.uptime_30d) // worst uptime first

  if (summary.length === 0) {
    return {
      status: "empty",
      collector: "app/api/cron/health-check (daily health_check_history rollup)",
      detail: `Snapshot rows exist for the last ${days} days but none carries a measured uptime value.`,
    }
  }

  return { status: "ok", data: summary }
}

export async function getSLASummary(days = 30): Promise<SLARow[]> {
  const result = await readSLASummary(days)
  return result.status === "ok" ? result.data : []
}

export async function triggerManualHealthCheck(): Promise<{
  success: boolean
  message: string
}> {
  const supabase = await createClient()
  const ctx = await getAgentContext()

  if (!ctx || !isAdminOrBroker({ user_type: ctx.role })) {
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

export type SLAReportFile = {
  filename: string
  csvData: string
  rowCount: number
  windowDays: number
}

export async function exportSLAReport(
  days = 30
): Promise<HealthRead<SLAReportFile>> {
  const summary = await readSLASummary(days)

  // An unauthorized, refused or unmeasured read must NOT produce a CSV. A
  // downloaded file reads as an authoritative record long after the screen
  // that produced it is gone, so only status "ok" yields bytes.
  if (summary.status !== "ok") {
    return summary
  }

  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const headers = [
    "Service",
    `${days}-Day Uptime %`,
    "Avg Response (ms)",
    "Total Incidents",
  ]
  const rows = summary.data.map((s) => [
    escape(s.service_name),
    s.uptime_30d.toFixed(2),
    s.avg_response_ms.toString(),
    s.total_incidents.toString(),
  ])

  const csvData = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n")

  return {
    status: "ok",
    data: {
      filename: `sla-report-${days}d-${new Date().toISOString().split("T")[0]}.csv`,
      csvData,
      rowCount: summary.data.length,
      windowDays: days,
    },
  }
}
