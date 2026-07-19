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
  /** Resolved display name when the session targets a specific USER (user-granular). */
  targetUserName?: string | null
  mode?: ImpersonationMode
  expiresAt?: string
}

/** Enter a tenant — begin an audited impersonation session.
 *
 *  LANDING ROUTE: `redirectTo` is where the staff member should land. Staff/agent
 *  targets go through /dashboard (the entry router resolves their role route). A
 *  user_type='contact' target is a PORTAL CLIENT — their workspace is
 *  /portal/[contactId], so we resolve their contact row (contact_user_id link
 *  first, then email within the tenant) and land the impersonator THERE. */
export async function enterTenantAction(params: {
  brokerageId: string
  targetUserId?: string | null
  mode?: ImpersonationMode
  reason?: string
}): Promise<{ ok: boolean; error?: string; expiresAt?: string; redirectTo?: string }> {
  const auth = await requirePlatformStaff()
  if (!auth.ok) return auth
  if (!params.brokerageId) return { ok: false, error: "Target brokerage required" }

  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id, name").eq("id", params.brokerageId).maybeSingle()
  if (!brk) return { ok: false, error: "Brokerage not found" }
  // A named target user must actually belong to the target tenant.
  let redirectTo = "/dashboard"
  if (params.targetUserId) {
    const { data: tu } = await svc.from("users").select("id, brokerage_id, user_type, email").eq("id", params.targetUserId).maybeSingle()
    if (!tu || (tu as any).brokerage_id !== params.brokerageId) return { ok: false, error: "Target user is not in that tenant" }
    if ((tu as any).user_type === "contact") {
      // Portal client — land on THEIR portal. contact_user_id is the canonical
      // link (stamped by ensureContactPortalUser); email+brokerage is the fallback
      // for pre-backfill rows.
      const { data: byLink } = await svc.from("contacts")
        .select("id").eq("contact_user_id", params.targetUserId).eq("brokerage_id", params.brokerageId)
        .is("deleted_at", null).limit(1).maybeSingle()
      let contactId: string | null = (byLink as any)?.id ?? null
      if (!contactId && (tu as any).email) {
        const { data: byEmail } = await svc.from("contacts")
          .select("id").ilike("email", (tu as any).email).eq("brokerage_id", params.brokerageId)
          .is("deleted_at", null).limit(1).maybeSingle()
        contactId = (byEmail as any)?.id ?? null
      }
      if (contactId) redirectTo = `/portal/${contactId}`
      // No contact row resolvable → honest fallback to /dashboard (entry router).
    }
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
    redirect_to: redirectTo,
  })
  revalidatePath("/dashboard")
  return { ok: true, expiresAt: started.expiresAt, redirectTo }
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
  const [{ data: brk }, { data: tu }] = await Promise.all([
    svc.from("brokerages").select("name").eq("id", s.targetBrokerageId).maybeSingle(),
    s.targetUserId
      ? svc.from("users").select("first_name, last_name, email").eq("id", s.targetUserId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  // User-granular sessions name the target USER in the banner (name falls back to email).
  const targetUserName = tu
    ? ([(tu as any).first_name, (tu as any).last_name].filter(Boolean).join(" ") || (tu as any).email || null)
    : null
  return {
    active: true, sessionId: s.id, targetBrokerageId: s.targetBrokerageId,
    targetBrokerageName: (brk as any)?.name ?? null, targetUserId: s.targetUserId, targetUserName,
    mode: s.mode, expiresAt: s.expiresAt,
  }
}
