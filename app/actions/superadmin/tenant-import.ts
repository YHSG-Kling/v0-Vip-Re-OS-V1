"use server"

// app/actions/superadmin/tenant-import.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT DATA IMPORT actions — the god-console entry to lib/platform/
// tenant-import.ts (the inbound mirror of tenant-export). White-glove
// migration: platform staff paste/upload a new subscriber's CSV and land it in
// the TARGET tenant. Gated with the ROUND-19 pattern (resolvePlatformRole →
// platformStaffCan 'tenants' — same as manual-subscriber: platform ADMIN staff
// migrate subscribers too, GHL model). Every run — success or failure — is
// written to superadmin_audit_log with the honest counts.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePlatformRole } from "@/lib/platform/require-capability"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"
import { importContacts, importListings, type ImportDedupeMode, type TenantImportResult } from "@/lib/platform/tenant-import"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

const MAX_CSV_BYTES = 5 * 1024 * 1024 // 5MB of CSV text per run — white-glove scale, not ETL

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "brokerage", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[tenant-import audit] failed:", err) }
}

async function gate(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: profile } = await supabase
    .from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRole(profile as any)
  if (!platformStaffCan(role, "tenants")) return { ok: false, error: "Forbidden — requires platform 'tenants' capability" }
  return { ok: true, userId: user.id, email: (profile as any)?.email ?? user.email ?? "" }
}

export interface TenantImportActionResult extends TenantImportResult {}

/**
 * Mark where this tenant's book of business came from: if the brokerage has no
 * signup_source yet, a white-glove data import stamps it 'import' (the detail
 * page already renders signup_source). Never overwrites an existing source.
 */
async function stampSignupSourceIfNull(svc: any, brokerageId: string): Promise<void> {
  const { data, error } = await svc.from("brokerages").select("signup_source").eq("id", brokerageId).maybeSingle()
  if (error || !data || data.signup_source != null) return
  const { error: updErr } = await svc
    .from("brokerages").update({ signup_source: "import", updated_at: new Date().toISOString() })
    .eq("id", brokerageId).is("signup_source", null)
  if (updErr) console.error("[tenant-import] signup_source stamp failed:", updErr.message)
}

/** Import a contacts CSV into any tenant (cross-tenant, staff-gated, audited). */
export async function importTenantContactsAction(params: {
  brokerageId: string
  csvText: string
  dedupe: ImportDedupeMode
  /** Optional agents.id to anchor rows to; defaults to the tenant's owner agent. */
  agentId?: string | null
}): Promise<TenantImportActionResult> {
  const fail = (error: string): TenantImportActionResult =>
    ({ ok: false, error, inserted: 0, skippedDuplicates: 0, errors: [], totalDataRows: 0 })

  const auth = await gate()
  if (!auth.ok) return fail(auth.error)
  if (!params.brokerageId) return fail("Target brokerage required")
  if (!params.csvText?.trim()) return fail("CSV text required")
  if (params.csvText.length > MAX_CSV_BYTES) return fail("CSV too large (5MB max) — split the file")
  if (params.dedupe !== "email_phone" && params.dedupe !== "none") return fail("Invalid dedupe mode")

  const svc = createServiceClient()
  const result = await importContacts({
    svc,
    brokerageId: params.brokerageId,
    agentId: params.agentId ?? null,
    csvText: params.csvText,
    dedupe: params.dedupe,
    importedBy: auth.userId,
  })

  await audit(auth.userId, auth.email,
    result.ok ? "tenant.contacts_imported" : "tenant.contacts_import_failed",
    params.brokerageId,
    {
      inserted: result.inserted, skipped: result.skippedDuplicates,
      errorCount: result.errors.length, totalRows: result.totalDataRows,
      dedupe: params.dedupe, agent_id: result.agentId ?? null, error: result.error ?? null,
    })

  if (result.ok && result.inserted > 0) {
    await stampSignupSourceIfNull(svc, params.brokerageId)
    revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  }
  return result
}

/** Import a listings CSV (draft shape) into any tenant (staff-gated, audited). */
export async function importTenantListingsAction(params: {
  brokerageId: string
  csvText: string
  agentId?: string | null
}): Promise<TenantImportActionResult> {
  const fail = (error: string): TenantImportActionResult =>
    ({ ok: false, error, inserted: 0, skippedDuplicates: 0, errors: [], totalDataRows: 0 })

  const auth = await gate()
  if (!auth.ok) return fail(auth.error)
  if (!params.brokerageId) return fail("Target brokerage required")
  if (!params.csvText?.trim()) return fail("CSV text required")
  if (params.csvText.length > MAX_CSV_BYTES) return fail("CSV too large (5MB max) — split the file")

  const svc = createServiceClient()
  const result = await importListings({
    svc,
    brokerageId: params.brokerageId,
    agentId: params.agentId ?? null,
    csvText: params.csvText,
    importedBy: auth.userId,
  })

  await audit(auth.userId, auth.email,
    result.ok ? "tenant.listings_imported" : "tenant.listings_import_failed",
    params.brokerageId,
    {
      inserted: result.inserted, skipped: result.skippedDuplicates,
      errorCount: result.errors.length, totalRows: result.totalDataRows,
      agent_id: result.agentId ?? null, error: result.error ?? null,
    })

  if (result.ok && result.inserted > 0) {
    await stampSignupSourceIfNull(svc, params.brokerageId)
    revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  }
  return result
}
