"use server"

// app/actions/superadmin/tenant-users.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant USER management for the god console. The superadmin brokerage-detail roster was view-only and
// the existing per-user actions were brokerage-scoped (a superadmin whose own brokerage_id differed couldn't
// act on another tenant's users/invites). These actions let a superadmin manage ANY tenant's users +
// invitations in-context: list with status + last-login, activate/suspend a user, and resend/revoke an
// invitation across tenants. Every mutation is superadmin-gated and audited (IP/UA).

import { createServiceClient } from "@/lib/supabase/service"
import { inviteTenantMember, type UserDomainRole } from "@/lib/kernel/users"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "user", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[tenant-users audit] failed:", err) }
}

export interface TenantUserRow { id: string; email: string | null; name: string; role: string; status: string | null }
export interface TenantInviteRow { id: string; email: string; role: string; status: string; expiresAt: string | null; createdAt: string }

export async function listTenantUsersAction(brokerageId: string): Promise<
  | { ok: true; users: TenantUserRow[]; invites: TenantInviteRow[] }
  | { ok: false; error: string }
> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const [{ data: users }, { data: invites }] = await Promise.all([
    svc.from("users").select("id, email, first_name, last_name, user_type, status").eq("brokerage_id", brokerageId).is("deleted_at", null).limit(500),
    svc.from("user_invitations").select("id, email, user_type, status, expires_at, created_at").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(200),
  ])
  return {
    ok: true,
    users: ((users ?? []) as any[]).map((u) => ({ id: u.id, email: u.email, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || "—", role: u.user_type, status: u.status })),
    invites: ((invites ?? []) as any[]).map((i) => ({ id: i.id, email: i.email, role: i.user_type, status: i.status, expiresAt: i.expires_at, createdAt: i.created_at })),
  }
}

// Roles a superadmin can create INTO a tenant from the god console. (superadmin is
// deliberately excluded — platform staff are provisioned through their own path.)
const TENANT_CREATABLE_ROLES = new Set<string>([
  "admin", "broker", "agent", "team_lead", "tc", "isa", "compliance_officer", "lender", "vendor",
])

/**
 * Create (invite) a user INTO any tenant — superadmin-down manual provisioning. Uses the
 * canonical inviteTenantMember path, so the new user is auth-linked (users.id === auth.id)
 * and gets their role-specific domain records (agents/onboarding/role) exactly like a
 * tenant-initiated invite. A team_lead can be dropped onto an existing team via teamId.
 */
export async function createTenantUserAction(params: {
  brokerageId: string
  email: string
  firstName?: string
  lastName?: string
  userType: string
  teamId?: string | null
}): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const email = params.email?.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Valid email required" }
  if (!params.brokerageId) return { ok: false, error: "Target brokerage required" }
  if (!TENANT_CREATABLE_ROLES.has(params.userType)) return { ok: false, error: `Role not allowed: ${params.userType}` }

  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id").eq("id", params.brokerageId).maybeSingle()
  if (!brk) return { ok: false, error: "Brokerage not found" }

  const res = await inviteTenantMember({
    brokerageId:  params.brokerageId,
    teamId:       params.teamId ?? null,
    email,
    firstName:    params.firstName ?? "",
    lastName:     params.lastName ?? "",
    userType:     params.userType as UserDomainRole,
    callerUserId: auth.userId,
    redirectTo:   `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/onboarding`,
  })
  if (!res.success || !res.userId) return { ok: false, error: res.error ?? "Failed to create user" }

  await audit(auth.userId, auth.email, "user.created", res.userId, { brokerage_id: params.brokerageId, role: params.userType, email })
  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  return { ok: true, userId: res.userId }
}

/** Activate / suspend any tenant's user (cross-tenant). */
export async function setTenantUserStatusAction(params: { userId: string; status: "active" | "suspended" }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  if (params.status !== "active" && params.status !== "suspended") return { ok: false, error: "Invalid status" }
  const svc = createServiceClient()
  const { data: target } = await svc.from("users").select("brokerage_id, user_type").eq("id", params.userId).maybeSingle()
  if (!target) return { ok: false, error: "User not found" }
  if ((target as any).user_type === "superadmin") return { ok: false, error: "Refusing to change a superadmin's status" }
  const { error } = await svc.from("users").update({ status: params.status, updated_at: new Date().toISOString() }).eq("id", params.userId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, params.status === "suspended" ? "user.suspended" : "user.reactivated", params.userId, { brokerage_id: (target as any).brokerage_id, status: params.status })
  if ((target as any).brokerage_id) revalidatePath(`/dashboard/superadmin/brokerages/${(target as any).brokerage_id}`)
  return { ok: true }
}

/** Resend a pending/expired invitation (cross-tenant) — re-arms the 7-day window. */
export async function resendTenantInviteAction(invitationId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: inv } = await svc.from("user_invitations").select("brokerage_id, status").eq("id", invitationId).maybeSingle()
  if (!inv) return { ok: false, error: "Invitation not found" }
  if ((inv as any).status === "accepted") return { ok: false, error: "Already accepted" }
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const { error } = await svc.from("user_invitations").update({ status: "pending", expires_at: expires, updated_at: new Date().toISOString() }).eq("id", invitationId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "invitation.resent", invitationId, { brokerage_id: (inv as any).brokerage_id, expires_at: expires })
  if ((inv as any).brokerage_id) revalidatePath(`/dashboard/superadmin/brokerages/${(inv as any).brokerage_id}`)
  return { ok: true }
}

/** Revoke a pending invitation (cross-tenant). */
export async function revokeTenantInviteAction(invitationId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: inv } = await svc.from("user_invitations").select("brokerage_id, status").eq("id", invitationId).maybeSingle()
  if (!inv) return { ok: false, error: "Invitation not found" }
  if ((inv as any).status === "accepted") return { ok: false, error: "Cannot revoke an accepted invitation" }
  const { error } = await svc.from("user_invitations").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("id", invitationId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "invitation.revoked", invitationId, { brokerage_id: (inv as any).brokerage_id })
  if ((inv as any).brokerage_id) revalidatePath(`/dashboard/superadmin/brokerages/${(inv as any).brokerage_id}`)
  return { ok: true }
}
