"use server"

// app/actions/superadmin/tenant-users.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant USER management for the god console. The superadmin brokerage-detail roster was view-only and
// the existing per-user actions were brokerage-scoped (a superadmin whose own brokerage_id differed couldn't
// act on another tenant's users/invites). These actions let a superadmin manage ANY tenant's users +
// invitations in-context: list with status + last-login, activate/suspend a user, and resend/revoke an
// invitation across tenants. Every mutation is superadmin-gated and audited (IP/UA).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

async function requireSuperadmin(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const isSuper = (data as any)?.user_type === "superadmin" || (data as any)?.platform_role === "superadmin"
  if (!isSuper) return { ok: false, error: "Forbidden — superadmin only" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

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
