"use server"

// app/actions/superadmin/impersonation.ts
// ─────────────────────────────────────────────────────────────────────────────
// STAFF "ACT AS TENANT" — enter/exit a tenant as platform staff (GoHighLevel model).
// Gated to platform staff (superadmin/support). Every enter + exit is written to
// superadmin_audit_log (actor = the real staff member, target = the tenant), and each
// session auto-expires. While a session is active, getAgentContext resolves the target
// tenant's workspace context (see lib/platform/impersonation.ts).

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformStaff } from "@/lib/auth/platform-guard"
import {
  startImpersonation, endImpersonation, loadActiveImpersonation,
  type ImpersonationMode,
} from "@/lib/platform/impersonation"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const h = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "brokerage", target_id: targetId,
      details, ip_address: h.get("x-forwarded-for") ?? h.get("x-real-ip"), user_agent: h.get("user-agent"),
    })
  } catch (err) { console.error("[impersonation audit] failed:", err) }
}

export interface ActiveImpersonation {
  active: boolean
  sessionId?: string
  targetBrokerageId?: string
  targetBrokerageName?: string
  targetUserId?: string | null
  mode?: ImpersonationMode
  expiresAt?: string
}

/** Enter a tenant — begin an audited impersonation session. */
export async function enterTenantAction(params: {
  brokerageId: string
  targetUserId?: string | null
  mode?: ImpersonationMode
  reason?: string
}): Promise<{ ok: boolean; error?: string; expiresAt?: string }> {
  const auth = await requirePlatformStaff()
  if (!auth.ok) return auth
  if (!params.brokerageId) return { ok: false, error: "Target brokerage required" }

  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id, name").eq("id", params.brokerageId).maybeSingle()
  if (!brk) return { ok: false, error: "Brokerage not found" }
  // A named target user must actually belong to the target tenant.
  if (params.targetUserId) {
    const { data: tu } = await svc.from("users").select("id, brokerage_id").eq("id", params.targetUserId).maybeSingle()
    if (!tu || (tu as any).brokerage_id !== params.brokerageId) return { ok: false, error: "Target user is not in that tenant" }
  }
  const h = await headers()
  const started = await startImpersonation({
    actorUserId: auth.userId, actorEmail: auth.email,
    targetBrokerageId: params.brokerageId, targetUserId: params.targetUserId ?? null,
    mode: params.mode ?? "full", reason: params.reason ?? null,
    ipAddress: h.get("x-forwarded-for") ?? h.get("x-real-ip"), userAgent: h.get("user-agent"),
    client: svc,
  })
  if (!started.ok) return { ok: false, error: started.error }

  await audit(auth.userId, auth.email, "impersonation.enter", params.brokerageId, {
    session_id: started.sessionId, target_user_id: params.targetUserId ?? null, mode: params.mode ?? "full",
    reason: params.reason ?? null, expires_at: started.expiresAt, brokerage_name: (brk as any).name,
  })
  revalidatePath("/dashboard")
  return { ok: true, expiresAt: started.expiresAt }
}

/** Exit the current tenant — end the active impersonation session. */
export async function exitTenantAction(): Promise<{ ok: boolean; error?: string }> {
  const auth = await requirePlatformStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const active = await loadActiveImpersonation(auth.userId, svc)
  const ended = await endImpersonation(auth.userId, svc)
  if (active) {
    await audit(auth.userId, auth.email, "impersonation.exit", active.targetBrokerageId, {
      session_id: ended.endedSessionId ?? active.id, target_user_id: active.targetUserId,
    })
  }
  revalidatePath("/dashboard")
  return { ok: true }
}

/** The caller's active impersonation (for the banner + entry-button state). */
export async function getActiveImpersonationAction(): Promise<ActiveImpersonation> {
  const auth = await requirePlatformStaff()
  if (!auth.ok) return { active: false }
  const svc = createServiceClient()
  const s = await loadActiveImpersonation(auth.userId, svc)
  if (!s) return { active: false }
  const { data: brk } = await svc.from("brokerages").select("name").eq("id", s.targetBrokerageId).maybeSingle()
  return {
    active: true, sessionId: s.id, targetBrokerageId: s.targetBrokerageId,
    targetBrokerageName: (brk as any)?.name ?? null, targetUserId: s.targetUserId, mode: s.mode, expiresAt: s.expiresAt,
  }
}
