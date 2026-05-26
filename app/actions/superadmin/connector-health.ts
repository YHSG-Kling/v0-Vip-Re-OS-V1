"use server"

// Platform-staff read surface for the Connectivity API Agent. Powers the superadmin/support
// "Connector Connectivity" panel: the attention feed (connectors needing action) plus a
// status rollup. Gated to platform staff (superadmin / support) — brokerages see their own
// connectivity via the agent endpoint, not this cross-tenant view.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"

async function requirePlatformStaff(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  if (data?.user_type === "superadmin" || isPlatformStaff(data?.platform_role)) return { ok: true }
  return { ok: false, error: "Platform staff access required" }
}

export interface ConnectorAttentionRow {
  id: string
  brokerageId: string
  brokerageName: string | null
  provider: string
  transport: string
  status: string
  drifted: boolean
  httpStatus: number | null
  error: string | null
  checkedAt: string
}

/** Latest connectors needing attention (expired / expiring_soon / auth_failed / shape_drift),
 *  newest first, joined to brokerage name. Platform staff only. */
export async function getConnectorAttentionFeedAction(
  limit = 100,
): Promise<{ ok: true; rows: ConnectorAttentionRow[] } | { ok: false; error: string }> {
  const gate = await requirePlatformStaff()
  if (!gate.ok) return gate
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("connector_health_log")
    .select("id, brokerage_id, provider, transport, status, drifted, http_status, error, checked_at, brokerages(name)")
    .or("drifted.eq.true,status.in.(expired,expiring_soon,auth_failed,shape_drift)")
    .order("checked_at", { ascending: false })
    .limit(Math.min(limit, 500))
  if (error) return { ok: false, error: error.message }
  const rows: ConnectorAttentionRow[] = (data ?? []).map((r: any) => ({
    id: r.id,
    brokerageId: r.brokerage_id,
    brokerageName: r.brokerages?.name ?? null,
    provider: r.provider,
    transport: r.transport,
    status: r.status,
    drifted: !!r.drifted,
    httpStatus: r.http_status ?? null,
    error: r.error ?? null,
    checkedAt: r.checked_at,
  }))
  return { ok: true, rows }
}

/** Status rollup over the most recent health window (last 24h of rows). Platform staff only. */
export async function getConnectorHealthSummaryAction(): Promise<
  { ok: true; byStatus: Record<string, number>; lastRunAt: string | null } | { ok: false; error: string }
> {
  const gate = await requirePlatformStaff()
  if (!gate.ok) return gate
  const svc = createServiceClient()
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { data, error } = await svc
    .from("connector_health_log")
    .select("status, checked_at")
    .gte("checked_at", since)
    .order("checked_at", { ascending: false })
    .limit(5000)
  if (error) return { ok: false, error: error.message }
  const byStatus: Record<string, number> = {}
  let lastRunAt: string | null = null
  for (const r of data ?? []) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    if (!lastRunAt) lastRunAt = r.checked_at
  }
  return { ok: true, byStatus, lastRunAt }
}
