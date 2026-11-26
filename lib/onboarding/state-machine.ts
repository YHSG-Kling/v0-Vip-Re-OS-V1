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
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
 *
 * LOGIN IS A JOURNEY STEP WITH A POST-CONDITION (wave 148, lane 148A — the subscriber journey's "login →
 * immediate error reporting"). Before this, the invitation READ dropped its error (a refused read was "no
 * invitation"), the accept UPDATE only logged a refusal and still returned accepted: true, an update that
 * matched no row (the invitation flipped or vanished between read and write) read as success, and the
 * callback (app/auth/callback/route.ts) wrapped it all in an empty catch. So a member who signed in never
 * left `pending`, the brokerage's onboarding never advanced, and nobody was told. Now every refusal is READ,
 * the update is COUNTED, and a failed post-condition is reported IMMEDIATELY through the one reporter
 * (lib/kernel/immediate-operations.ts reportOperationOutcome, operation `invitation`) — evidence row + the
 * owning manager's open signal — and returned as `accepted: false` with the reason. Sign-in itself is never
 * blocked by it (the session already exists); the failure is visible, not swallowed.
 * `client` is the proof seam (scripts/subscriber-provisioning-guard.ts); production uses the service client.
 */
export async function acceptUserInvitationOnFirstLogin(params: {
  userId:       string
  email:        string
  brokerageId:  string | null
  client?:      ReturnType<typeof createServiceClient>
}): Promise<{ accepted: boolean; advanced?: OnboardingStatus; error?: string }> {
  if (!params.brokerageId) return { accepted: false }
  const brokerageId = params.brokerageId

  const svc = params.client ?? createServiceClient()
  const email = params.email.toLowerCase()
  const reportFailure = async (error: string, evidence: Record<string, unknown>) => {
    try {
      const { reportOperationOutcome } = await import("@/lib/kernel/immediate-operations")
      await reportOperationOutcome(svc, {
        operation: "invitation", brokerageId, ok: false, subjectType: "user", subjectId: params.userId,
        actorUserId: params.userId, source: "ui", evidence: { stage: "first_login_acceptance", email, ...evidence }, error,
        tenantFacing: "a team member signed in but their invitation could not be marked accepted — the OS is re-checking it",
      })
    } catch (err) {
      console.error("[onboarding/state-machine] invitation acceptance failure NOT reported:", (err as Error)?.message)
    }
    return { accepted: false, error }
  }

  // Find pending invitation matching this user's email + brokerage
  const { data: invite, error: inviteReadErr } = await svc
    .from("user_invitations")
    .select("id, user_type, status")
    .eq("brokerage_id", brokerageId)
    .eq("email", email)
    .eq("status", "pending")
    .maybeSingle()
  if (inviteReadErr) return reportFailure(`invitation read refused: ${inviteReadErr.message}`, { read: "user_invitations" })

  if (!invite) return { accepted: false }

  // Mark accepted — COUNTED: an update that matches nothing resolves too (CLAUDE.md §3).
  const { data: acceptedRows, error: inviteAcceptErr } = await svc
    .from("user_invitations")
    .update({
      status:           "accepted",
      accepted_user_id: params.userId,
      accepted_at:      new Date().toISOString(),
    })
    .eq("id", invite.id)
    .eq("status", "pending")
    .select("id")
  if (inviteAcceptErr) return reportFailure(`invitation NOT marked accepted: ${inviteAcceptErr.message}`, { invitation_id: invite.id })
  if ((acceptedRows ?? []).length !== 1) return reportFailure(`invitation NOT marked accepted: the update matched ${(acceptedRows ?? []).length} rows`, { invitation_id: invite.id, matched: (acceptedRows ?? []).length })

  // If this is a NON-ADMIN role accepting, the brokerage has moved beyond
  // the initial setup phase — advance to in_progress (idempotent).
  // Admin-only acceptances don't advance, since brokerage admins ARE
  // the onboarding driver.
  if (!isAdminOrBroker({ user_type: invite.user_type })) {
    const r = await advanceBrokerageOnboarding(brokerageId, "in_progress")
    if (!r.ok) console.warn(`[onboarding/state-machine] onboarding not advanced for ${brokerageId}: ${r.error}`)
    return { accepted: true, advanced: r.status }
  }

  return { accepted: true }
}
