"use server"

/**
 * Tenant Safety — admin-facing reads + actions for the
 * tenant-safety-scan cron findings.
 *
 *   - getRecentTenantSafetyFindings   — paginated unresolved + recent
 *   - resolveTenantSafetyFinding      — mark a finding resolved with note
 *   - triggerTenantSafetyScanAction   — admin-only on-demand rescan
 *
 * All actions gated to broker / admin / superadmin / compliance roles.
 * Findings table has its own RLS gating those roles too (migration 1033).
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

export interface TenantSafetyFinding {
  id:              string
  scanRunId:       string
  findingType:     "rows_missing_brokerage_id" | "table_missing_brokerage_id" | "table_missing_rls_policy" | "cross_tenant_join_risk"
  tableName:       string
  severity:        "low" | "medium" | "high" | "critical"
  details:         Record<string, unknown>
  affectedRows:    number | null
  resolved:        boolean
  resolvedAt:      string | null
  resolutionNote:  string | null
  createdAt:       string
}

const ADMIN_USER_TYPES = new Set([
  "superadmin", "broker", "broker_admin", "admin", "compliance_officer", "compliance_manager",
])

async function requireAdminUser(): Promise<
  | { ok: true; userId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: profile } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()
  const userType = (profile?.user_type as string | undefined) ?? ""
  if (!ADMIN_USER_TYPES.has(userType)) {
    return { ok: false, error: "Insufficient privileges" }
  }
  return { ok: true, userId: user.id, userType }
}

export async function getRecentTenantSafetyFindings(params?: {
  limit?:    number
  resolved?: boolean
}): Promise<{ success: boolean; error?: string; findings?: TenantSafetyFinding[] }> {
  const auth = await requireAdminUser()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const limit = params?.limit ?? 25
  let q = supabase
    .from("tenant_safety_findings")
    .select("id, scan_run_id, finding_type, table_name, severity, details, affected_rows, resolved, resolved_at, resolution_note, created_at")
    .order("severity", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit)

  if (params?.resolved !== undefined) {
    q = q.eq("resolved", params.resolved)
  }

  const { data, error } = await q
  if (error) return { success: false, error: error.message }

  const findings: TenantSafetyFinding[] = (data ?? []).map((r) => ({
    id:              r.id as string,
    scanRunId:       r.scan_run_id as string,
    findingType:     r.finding_type as TenantSafetyFinding["findingType"],
    tableName:       r.table_name as string,
    severity:        r.severity as TenantSafetyFinding["severity"],
    details:         (r.details as Record<string, unknown>) ?? {},
    affectedRows:    (r.affected_rows as number | null) ?? null,
    resolved:        r.resolved as boolean,
    resolvedAt:      (r.resolved_at as string | null) ?? null,
    resolutionNote:  (r.resolution_note as string | null) ?? null,
    createdAt:       r.created_at as string,
  }))
  return { success: true, findings }
}

export async function resolveTenantSafetyFindingAction(params: {
  findingId:       string
  resolutionNote?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.findingId)) {
    return { success: false, error: "Invalid finding id" }
  }
  const auth = await requireAdminUser()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const { error } = await supabase
    .from("tenant_safety_findings")
    .update({
      resolved:        true,
      resolved_at:     new Date().toISOString(),
      resolved_by:     auth.userId,
      resolution_note: params.resolutionNote ?? null,
    })
    .eq("id", params.findingId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/admin/tenant-safety")
  return { success: true }
}

export async function triggerTenantSafetyScanAction(): Promise<{
  success:  boolean
  error?:   string
  summary?: Record<string, unknown>
}> {
  const auth = await requireAdminUser()
  if (!auth.ok) return { success: false, error: auth.error }

  // Hit the cron endpoint with the cron secret. The endpoint already
  // handles auth via CRON_SECRET so we forward the header.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return { success: false, error: "CRON_SECRET not configured" }
  }
  const base = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
  const url = base
    ? `${base.startsWith("http") ? base : `https://${base}`}/api/cron/tenant-safety-scan`
    : "/api/cron/tenant-safety-scan"

  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) {
      return { success: false, error: data?.error ?? `Scan returned ${r.status}` }
    }
    revalidatePath("/dashboard/admin/tenant-safety")
    return { success: true, summary: data?.summary as Record<string, unknown> | undefined }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Scan request failed" }
  }
}
