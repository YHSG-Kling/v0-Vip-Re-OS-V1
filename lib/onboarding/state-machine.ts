/**
 * Brokerage onboarding state machine
 * ─────────────────────────────────────────────────────────────
 * Single canonical entry point for advancing brokerages.onboarding_status.
 * The transition rules live in the Postgres function advance_brokerage_onboarding
 * (migration 1058) so the same logic governs both server actions AND any
 * future SQL-level automations (cron, triggers, etc.).
 *
 * States: pending → in_progress → completed
 *                              ↘  abandoned   (terminal — manual only)
 *
 * - pending     : brokerage created, no one has logged in yet
 * - in_progress : first non-admin user accepted invite (or admin opened
 *                 the setup wizard)
 * - completed   : admin clicked "Finish setup"
 * - abandoned   : superadmin marks a stalled trial brokerage as gone
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type OnboardingStatus = "pending" | "in_progress" | "completed" | "abandoned"

export async function advanceBrokerageOnboarding(
  brokerageId: string,
  targetStatus: OnboardingStatus,
): Promise<{ ok: boolean; status?: OnboardingStatus; error?: string }> {
  if (!brokerageId) return { ok: false, error: "brokerageId required" }
  try {
    const svc = createServiceClient()
    const { data, error } = await svc.rpc("advance_brokerage_onboarding", {
      p_brokerage_id: brokerageId,
      p_target_status: targetStatus,
    })
    if (error) return { ok: false, error: error.message }
    return { ok: true, status: data as OnboardingStatus }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "advance failed" }
  }
}

/**
 * Called on first authenticated load by the invited user. Marks their
 * user_invitation 'accepted' and bumps the brokerage to in_progress
 * if this is the first non-admin acceptance.
 *
 * Idempotent — safe to call on every login. No-ops once status is past
 * pending or the user has no matching invitation.
 */
export async function acceptUserInvitationOnFirstLogin(params: {
  userId:       string
  email:        string
  brokerageId:  string | null
}): Promise<{ accepted: boolean; advanced?: OnboardingStatus }> {
  if (!params.brokerageId) return { accepted: false }

  const svc = createServiceClient()

  // Find pending invitation matching this user's email + brokerage
  const { data: invite } = await svc
    .from("user_invitations")
    .select("id, user_type, status")
    .eq("brokerage_id", params.brokerageId)
    .eq("email", params.email.toLowerCase())
    .eq("status", "pending")
    .maybeSingle()

  if (!invite) return { accepted: false }

  // Mark accepted
  await svc
    .from("user_invitations")
    .update({
      status:           "accepted",
      accepted_user_id: params.userId,
      accepted_at:      new Date().toISOString(),
    })
    .eq("id", invite.id)

  // If this is a NON-ADMIN role accepting, the brokerage has moved beyond
  // the initial setup phase — advance to in_progress (idempotent).
  // Admin-only acceptances don't advance, since brokerage admins ARE
  // the onboarding driver.
  if (!["admin", "broker", "broker_admin", "superadmin"].includes(invite.user_type)) {
    const r = await advanceBrokerageOnboarding(params.brokerageId, "in_progress")
    return { accepted: true, advanced: r.status }
  }

  return { accepted: true }
}
