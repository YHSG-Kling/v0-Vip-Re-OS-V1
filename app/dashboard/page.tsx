import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { repairIncompleteAccountSetup } from "@/lib/kernel/users"
import { ensureAgentBrokerage } from "@/app/actions/onboarding/ensure-agent-brokerage"
import { determineFirstLoginDestination } from "@/lib/kernel/onboarding"

export const dynamic = "force-dynamic"

/**
 * Dashboard entry router.
 *
 * Resolution order:
 *   1. Not authenticated              → /login
 *   2. Attempt silent self-repair     → fixes any missing domain records
 *   3. determineFirstLoginDestination → returns the correct route based on
 *      role, setup state, and onboarding progress
 *
 * This page never renders UI — it is a pure server-side redirect.
 */
export default async function DashboardPage() {
  const context = await getAgentContext()

  if (!context.isAuthenticated) {
    redirect("/login")
  }

  // A brokerage-less agent (legacy seed / aborted-invite / hand-created row) is
  // walled out of every brokerage-gated surface ("Requires a brokerage…"). Give
  // them a personal brokerage-of-one FIRST — idempotent, guarded (agent/team_lead
  // only, and never while an invitation is pending) — then the repair below fills
  // the agents/onboarding/RBAC rows for it.
  await ensureAgentBrokerage()

  // Silently repair any missing domain records on every visit.
  // This is idempotent — does nothing if all records already exist.
  // It prevents the infinite-spinner / blank-dashboard state from
  // an incomplete invite provisioning path.
  await repairIncompleteAccountSetup(context.userId)

  // Determine the correct destination from onboarding + workspace state
  const destination = await determineFirstLoginDestination(context.userId)
  redirect(destination.route)
}
