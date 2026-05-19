"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * Audit-log read/write. The audit_log table is platform-level (no brokerage_id
 * column) and is consumed by the Platform Owner OS page (app/admin/page.tsx),
 * which is gated to user_role_assignments.role = 'platform_admin'.
 *
 * Previously every function here was unauthenticated and trusted caller-
 * supplied user_id and (non-existent) brokerage_id fields — an unauthenticated
 * client could read or forge entries via the RPC layer.
 *
 * Fix: require an authenticated session AND platform_admin role for reads and
 * for the entity-type/action enumerations. Writes use the session user_id
 * (caller-supplied user_id is ignored). The previous `brokerage_id` parameter
 * was a no-op since the table has no such column — kept as `_brokerageId`
 * for backward compat with existing callers but ignored.
 */

export interface AuditEntry {
  id: string
  user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  before: any
  after: any
  created_at: string
  user?: {
    full_name: string | null
    email: string
  }
}

async function requirePlatformAdmin(): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: role } = await svc
    .from("user_role_assignments")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle()
  if (role?.role !== "platform_admin") return { ok: false, error: "Forbidden" }

  return { ok: true, userId: user.id }
}

/** Authenticated session helper (for write that doesn't need platform_admin). */
async function requireSession(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id }
}

export async function getAuditTrail(params?: {
  brokerageId?: string  // ignored — audit_log has no brokerage_id column
  userId?: string
  entityType?: string
  action?: string
  limit?: number
  offset?: number
}): Promise<{ entries: AuditEntry[]; total: number; error?: string }> {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return { entries: [], total: 0, error: auth.error }

  const service = createServiceClient()

  let query = service
    .from("audit_log")
    .select(`
      *,
      user:users(full_name, email)
    `, { count: "exact" })
    .order("created_at", { ascending: false })

  if (params?.userId) {
    query = query.eq("user_id", params.userId)
  }
  if (params?.entityType) {
    query = query.eq("entity_type", params.entityType)
  }
  if (params?.action) {
    query = query.eq("action", params.action)
  }

  const limit = params?.limit ?? 50
  const offset = params?.offset ?? 0
  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) {
    return { entries: [], total: 0, error: error.message }
  }
  return { entries: (data ?? []) as AuditEntry[], total: count ?? 0 }
}

export async function logAuditEntry(params: {
  userId?: string  // ignored — stamped from session
  brokerageId?: string  // ignored — table has no brokerage_id column
  action: string
  entityType: string
  entityId?: string
  oldValue?: any
  newValue?: any
  ipAddress?: string
  userAgent?: string
}): Promise<{ success: boolean; error?: string }> {
  // Audit log writes only require an authenticated session — any signed-in
  // user can log an entry under their own user_id (which is stamped from
  // the session, not from params).
  const auth = await requireSession()
  if (!auth.ok) return { success: false, error: auth.error }

  const service = createServiceClient()

  const { error } = await service.from("audit_log").insert({
    user_id: auth.userId,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId ?? null,
    before: params.oldValue ?? null,
    after: params.newValue ?? null,
  })

  if (error) {
    return { success: false, error: error.message }
  }
  return { success: true }
}

export async function getAuditEntityTypes(): Promise<string[]> {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return []

  const service = createServiceClient()
  const { data } = await service
    .from("audit_log")
    .select("entity_type")
    .limit(100)
  if (!data) return []
  const types = [...new Set(data.map(d => d.entity_type))]
  return types.filter(Boolean).sort()
}

export async function getAuditActions(): Promise<string[]> {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return []

  const service = createServiceClient()
  const { data } = await service
    .from("audit_log")
    .select("action")
    .limit(100)
  if (!data) return []
  const actions = [...new Set(data.map(d => d.action))]
  return actions.filter(Boolean).sort()
}
