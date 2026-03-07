// lib/kernel/observability.ts
// Read-only observability layer for superadmin dashboards.
// Queries automation_errors and calendar_sync_logs.
// All functions require superadmin role. No writes.

import { createClient } from "@/lib/supabase/server"
import type { CalendarSyncLogRow } from "./calendar-sync"

// ─── RE-EXPORT CalendarSyncLogRow so consumers only import from observability ─
export type { CalendarSyncLogRow }

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type AutomationErrorRow = {
  id: string
  workflow_name: string
  error_message: string | null
  context_json: string | null
  severity: string
  status: "open" | "investigating" | "resolved"
  created_at: string
  resolved_at: string | null
}

export type ObservabilityFilterParams = {
  brokerageId: string
  type: "automation" | "calendar" | "both"
  severity?: "low" | "medium" | "high" | "critical"
  status?: "open" | "investigating" | "resolved"
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}

// ─── INTERNAL GUARD ───────────────────────────────────────────────────────────

async function requireSuperadmin(userId: string): Promise<void> {
  const supabase = await createClient()
  const { data: user, error } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", userId)
    .single()

  if (error || !user) throw new Error("User not found")
  if (user.user_type !== "superadmin") {
    throw new Error("Forbidden: superadmin access required")
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

export async function listAutomationErrors(
  params: ObservabilityFilterParams & { userId: string }
): Promise<{ rows: AutomationErrorRow[]; total: number }> {
  await requireSuperadmin(params.userId)

  const supabase = await createClient()
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0

  // Build data query
  let query = supabase
    .from("automation_errors")
    .select("*")
    .eq("brokerage_id", params.brokerageId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (params.status) {
    query = query.eq("status", params.status)
  }
  if (params.severity) {
    query = query.eq("severity", params.severity)
  }
  if (params.startDate) {
    query = query.gte("created_at", params.startDate.toISOString())
  }
  if (params.endDate) {
    query = query.lte("created_at", params.endDate.toISOString())
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to list automation errors: ${error.message}`)

  // Count query (mirrors filters, no range)
  let countQuery = supabase
    .from("automation_errors")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", params.brokerageId)

  if (params.status) countQuery = countQuery.eq("status", params.status)
  if (params.severity) countQuery = countQuery.eq("severity", params.severity)
  if (params.startDate) countQuery = countQuery.gte("created_at", params.startDate.toISOString())
  if (params.endDate) countQuery = countQuery.lte("created_at", params.endDate.toISOString())

  const { count, error: countError } = await countQuery

  if (countError) throw new Error(`Failed to count automation errors: ${countError.message}`)

  return {
    rows: (data ?? []) as AutomationErrorRow[],
    total: count ?? 0,
  }
}

export async function listCalendarSyncLogs(params: {
  userId: string
  brokerageId: string
  limit?: number
  offset?: number
}): Promise<CalendarSyncLogRow[]> {
  await requireSuperadmin(params.userId)

  const supabase = await createClient()
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0

  const { data, error } = await supabase
    .from("calendar_sync_logs")
    .select("*")
    .eq("brokerage_id", params.brokerageId)
    .order("started_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw new Error(`Failed to list calendar sync logs: ${error.message}`)

  return (data ?? []) as CalendarSyncLogRow[]
}

export async function getObservabilityDashboard(params: {
  userId: string
  brokerageId: string
}): Promise<{
  automationErrorCount: number
  automationErrorsCritical: number
  calendarSyncFailures: number
  lastUpdated: string
}> {
  await requireSuperadmin(params.userId)

  const supabase = await createClient()

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [openErrors, criticalErrors, syncFailures] = await Promise.all([
    supabase
      .from("automation_errors")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", params.brokerageId)
      .eq("status", "open"),

    supabase
      .from("automation_errors")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", params.brokerageId)
      .eq("severity", "critical"),

    supabase
      .from("calendar_sync_logs")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", params.brokerageId)
      .eq("status", "failed")
      .gte("started_at", sevenDaysAgo),
  ])

  if (openErrors.error) throw new Error(`Failed to count open errors: ${openErrors.error.message}`)
  if (criticalErrors.error) throw new Error(`Failed to count critical errors: ${criticalErrors.error.message}`)
  if (syncFailures.error) throw new Error(`Failed to count sync failures: ${syncFailures.error.message}`)

  return {
    automationErrorCount: openErrors.count ?? 0,
    automationErrorsCritical: criticalErrors.count ?? 0,
    calendarSyncFailures: syncFailures.count ?? 0,
    lastUpdated: new Date().toISOString(),
  }
}
