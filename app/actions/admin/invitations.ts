"use server"

/**
 * Admin-side invitation visibility + onboarding state transitions.
 *
 * - listPendingInvitationsAction: surfaces invitation lifecycle to the admin
 *   panel (who's been invited, who hasn't accepted, who's expired).
 * - revokeInvitationAction:       lets admin cancel a pending invite.
 * - markBrokerageSetupCompleteAction: explicit transition from
 *   in_progress → completed when the admin finishes the wizard.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { advanceBrokerageOnboarding } from "@/lib/onboarding/state-machine"
import { revalidatePath } from "next/cache"

const ADMIN_ROLES = new Set(["broker","broker_admin","admin","superadmin","team_lead"])

async function requireBrokerageAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!data?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!ADMIN_ROLES.has(data.user_type ?? "")) return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id, brokerageId: data.brokerage_id, userType: data.user_type }
}

export interface InvitationRow {
  id:               string
  email:            string
  first_name:       string | null
  last_name:        string | null
  user_type:        string
  status:           "pending" | "accepted" | "expired" | "revoked"
  invited_by_name:  string | null
  invited_at:       string
  accepted_at:      string | null
  expires_at:       string
  days_until_expiry: number | null
}

export async function listPendingInvitationsAction(): Promise<
  | { ok: true; rows: InvitationRow[]; pending_count: number; accepted_count: number }
  | { ok: false; error: string }
> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const { data, error } = await svc
    .from("user_invitations")
    .select(`
      id, email, first_name, last_name, user_type, status,
      created_at, accepted_at, expires_at,
      invited_by_user:users!user_invitations_invited_by_fkey ( first_name, last_name )
    `)
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(100)

  if (error) return { ok: false, error: error.message }

  const now = Date.now()
  const rows: InvitationRow[] = (data ?? []).map((r: any) => {
    const expiresMs = new Date(r.expires_at).getTime()
    const invitedBy = Array.isArray(r.invited_by_user) ? r.invited_by_user[0] : r.invited_by_user
    return {
      id:               r.id,
      email:            r.email,
      first_name:       r.first_name,
      last_name:        r.last_name,
      user_type:        r.user_type,
      status:           r.status,
      invited_by_name:  invitedBy ? `${invitedBy.first_name ?? ""} ${invitedBy.last_name ?? ""}`.trim() || null : null,
      invited_at:       r.created_at,
      accepted_at:      r.accepted_at,
      expires_at:       r.expires_at,
      days_until_expiry: r.status === "pending"
        ? Math.max(0, Math.ceil((expiresMs - now) / (1000 * 60 * 60 * 24)))
        : null,
    }
  })

  return {
    ok: true,
    rows,
    pending_count:  rows.filter(r => r.status === "pending").length,
    accepted_count: rows.filter(r => r.status === "accepted").length,
  }
}

/**
 * Re-open a pending/expired invitation for another 7 days — the tenant-tier
 * mirror of superadmin resendTenantInviteAction (ONE resend semantic across
 * tiers). Scoped to the caller's brokerage; accepted invites are immutable.
 */
export async function resendInvitationAction(
  invitationId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: inv } = await svc
    .from("user_invitations")
    .select("status, email")
    .eq("id", invitationId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!inv) return { ok: false, error: "Invitation not found" }
  if (inv.status === "accepted") return { ok: false, error: "Already accepted" }
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const { error } = await svc
    .from("user_invitations")
    .update({ status: "pending", expires_at: expires, updated_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }
  // Audit on the tenant activity rail — same shape inviteUser writes
  // (activities has agent_user_id, NOT user_id; entity_type is required).
  await svc.from("activities").insert({
    activity_type: "admin.invitation.resent",
    agent_user_id: auth.userId,
    brokerage_id: auth.brokerageId,
    entity_type: "invitation",
    entity_id: invitationId,
    title: `Invitation re-opened: ${inv.email}`,
    metadata: { invitation_id: invitationId, expires_at: expires, resent_by: auth.userId },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).then(() => {}, () => {})
  revalidatePath("/dashboard/admin/users/invitations")
  return { ok: true }
}

export async function revokeInvitationAction(
  invitationId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { error } = await svc
    .from("user_invitations")
    .update({ status: "revoked" })
    .eq("id", invitationId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("status", "pending")
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/users/invitations")
  return { ok: true }
}

export async function markBrokerageSetupCompleteAction(): Promise<
  { ok: boolean; status?: string; error?: string }
> {
  const auth = await requireBrokerageAdmin()
  if (!auth.ok) return auth
  // Only admin tier should be able to declare "we're done setting up"
  if (!["broker","broker_admin","admin","superadmin"].includes(auth.userType)) {
    return { ok: false, error: "Forbidden — only admin or broker can mark setup complete" }
  }
  const r = await advanceBrokerageOnboarding(auth.brokerageId, "completed")
  if (!r.ok) return { ok: false, error: r.error }
  revalidatePath("/dashboard/admin")
  return { ok: true, status: r.status }
}
