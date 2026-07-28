"use server"

// app/actions/onboarding/onboarding-ops.ts
// ─────────────────────────────────────────────────────────────────────────────
// The broker-side onboarding operations that the Onboarding Operations console
// offered but never performed. Its "Actions" tab rendered a batch panel whose
// selection state nothing populated, wired to an `onBatchAction` handler whose
// body was a comment saying the panel handled it — a circular no-op. Both
// buttons were permanently disabled, and the Quick Actions panel's three buttons
// had no onClick at all.
//
// These are real writes: a nudge lands an in-app notification on the agent's own
// user row. Admin/broker gated, and the target agents are always re-read from
// the caller's own brokerage, never trusted from the client.

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { loadOnboardingRoster, type OnboardingRosterRow } from "@/lib/onboarding/onboarding-roster"
import { revalidatePath } from "next/cache"

const OPS_ROLES = ["admin", "broker", "broker_admin", "superadmin"]

async function requireOnboardingOps(): Promise<
  { ok: true; brokerageId: string; userId: string } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Not authenticated" }
  if (!OPS_ROLES.includes(ctx.role)) return { ok: false, error: "Forbidden" }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId }
}

export async function listOnboardingAgentsAction(): Promise<
  { success: true; agents: OnboardingRosterRow[] } | { success: false; error: string }
> {
  const auth = await requireOnboardingOps()
  if (!auth.ok) return { success: false, error: auth.error }
  try {
    const roster = await loadOnboardingRoster(createServiceClient(), auth.brokerageId)
    return { success: true, agents: roster.agents }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Failed to load agents" }
  }
}

/**
 * Nudge selected agents about their unfinished onboarding.
 *
 * One in-app notification per agent, deep-linked at their own onboarding
 * dashboard. Agents whose seat has no linked user row cannot receive one and are
 * reported as skipped rather than silently dropped — the panel says so.
 */
export async function nudgeOnboardingAgentsAction(agentIds: string[]): Promise<
  { success: true; notified: number; skipped: number } | { success: false; error: string }
> {
  const auth = await requireOnboardingOps()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return { success: false, error: "Select at least one agent" }
  }

  try {
    const svc = createServiceClient()
    // Re-read the roster from the caller's own brokerage: a client-supplied id
    // that is not in it simply does not appear here.
    const roster = await loadOnboardingRoster(svc, auth.brokerageId)
    const wanted = new Set(agentIds)
    const targets = roster.agents.filter((a) => wanted.has(a.agentId))
    if (targets.length === 0) return { success: false, error: "No matching agents in your brokerage" }

    const deliverable = targets.filter((a) => a.userId)
    const skipped = targets.length - deliverable.length

    if (deliverable.length > 0) {
      // Live CHECK vocabularies: channel ∈ (in_app, email, sms), priority ∈
      // (low, medium, high, critical). notifications.user_id is a users(id) FK —
      // the roster carries the resolved users.id beside the agents.id.
      const { error } = await svc.from("notifications").insert(
        deliverable.map((a) => ({
          user_id: a.userId,
          brokerage_id: auth.brokerageId,
          type: "onboarding_nudge",
          title: "Finish setting up your account",
          body:
            a.percentComplete > 0
              ? `You're ${a.percentComplete}% through onboarding. Pick up where you left off — it takes a few minutes.`
              : "Your onboarding hasn't started yet. It only takes a few minutes and unlocks the rest of the platform.",
          entity_type: "agent_onboarding",
          entity_id: a.agentId,
          priority: "medium",
          channel: "in_app",
          is_read: false,
        })),
      )
      if (error) return { success: false, error: error.message }
    }

    revalidatePath("/dashboard/admin/onboarding")
    return { success: true, notified: deliverable.length, skipped }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Nudge failed" }
  }
}
