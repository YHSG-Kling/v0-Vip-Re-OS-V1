// lib/kernel/observability.ts
// Read-only observability layer for superadmin dashboards.
// Queries automation_errors and calendar_sync_logs.
// All functions require the platform 'sentinel' capability. No writes.

import { createClient } from "@/lib/supabase/server"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
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
//
// TWO DEFECTS IN THE GATE THIS REPLACES.
//
// 1. IT ADMITTED NOBODY. It read the profile of `userId` and threw unless
//    `user_type === 'superadmin'`. Measured live: no row in public.users carries
//    that user_type. The one platform superadmin is platform_role='superadmin'
//    with user_type='admin' — 'admin' being also a TENANT user_type is exactly
//    why the platform roster is carried on platform_role
//    (lib/platform/platform-staff-roster.ts). The predicate was unsatisfiable,
//    so all three exports threw for every caller. The only consumer,
//    /dashboard/superadmin/observability, already gates on
//    requirePlatformCapability("sentinel") and let staff in — then its try/catch
//    swallowed this throw and rendered "Failed to load observability data".
//    Nobody has ever seen that page's contents.
//
// 2. IT AUTHORIZED A CALLER-SUPPLIED ID. `userId` arrived as a parameter and the
//    role was read from THAT row, not from the session. Identity must be
//    resolved from the session and the supplied id authorized against it, never
//    the reverse. The gate now does exactly that, and the claimed id must match
//    the signed-in actor.
//
// WHICH CAPABILITY: 'sentinel' — the SAME capability the one calling page
// already declares, so gate and page can no longer disagree. Automation-error
// and calendar-sync telemetry is platform-integrity monitoring, not tenant
// financials, so 'sentinel' ({superadmin, admin}) is the right authority and
// 'billing'/'tenants' are not. Every export here is read-only.

async function requirePlatformObservability(claimedUserId: string): Promise<void> {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok) throw new Error(gate.error ?? "Forbidden: platform 'sentinel' capability required")
  if (claimedUserId && claimedUserId !== gate.userId) {
    throw new Error("Forbidden: observability may only be read as the signed-in actor")
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

export async function listAutomationErrors(
  params: ObservabilityFilterParams & { userId: string }
): Promise<{ rows: AutomationErrorRow[]; total: number }> {
  await requirePlatformObservability(params.userId)

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
  await requirePlatformObservability(params.userId)

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
  await requirePlatformObservability(params.userId)

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
