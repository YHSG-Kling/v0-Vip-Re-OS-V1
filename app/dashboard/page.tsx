import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveUserWorkspaceContext, emitUserProvisionedEvent } from "@/lib/kernel/users"
import { KernelEvent } from "@/lib/kernel/events"
import { determineFirstLoginDestination } from "@/lib/kernel/onboarding"

export const dynamic = "force-dynamic"

/**
 * Dashboard entry router.
 *
 * Resolution order:
 *   1. Not authenticated              → /login
 *   2. Detect an incomplete account   → evidence row, visible setup route
 *   3. determineFirstLoginDestination → the correct route for role, setup
 *      state and onboarding progress
 *
 * This page never renders UI — it is a pure server-side redirect.
 *
 * FIRST LOGIN IS NEVER A HIDDEN REPAIR (owner, wave 140). TOMBSTONE: this page
 * used to call `ensureAgentBrokerage()` (mint a brokerage-of-one + a trialing
 * subscription on a GET) and `repairIncompleteAccountSetup()` (write agents /
 * onboarding / RBAC rows) on EVERY visit — a repair nobody asked for, invisible
 * to the tenant, and ineffective for exactly the accounts that need it: measured
 * live 2026-10-11, the 4 agent-type users without an agents row and the 10
 * tenant users without a role grant had never reached this page. The seat flow
 * now produces the whole chain (lib/kernel/users.ts inviteTenantMember →
 * createOrRepairUserDomainRecords, which the tenant invite, the god console and
 * the recruiting door all converge on), and an incomplete account is DETECTED
 * here, evidenced (USER_ACCOUNT_INCOMPLETE), and routed to a setup screen the
 * person can see. The repair executor survives as lib/kernel/users.ts
 * repairIncompleteAccountSetup for the readiness repair.
 */
export default async function DashboardPage() {
  const context = await getAgentContext()

  if (!context.isAuthenticated) {
    redirect("/login")
  }

  const workspace = await resolveUserWorkspaceContext(context.userId)
  if (!workspace.isComplete) {
    // Evidence, never a silent write (LAW 5): who, what is missing, where it was seen.
    await emitUserProvisionedEvent({
      userId:       context.userId,
      userType:     workspace.userType,
      brokerageId:  workspace.brokerageId,
      callerUserId: context.userId,
      eventType:    KernelEvent.USER_ACCOUNT_INCOMPLETE,
      metadata:     { missingRecords: workspace.missingRecords, surface: "dashboard_router" },
    })
    // READINESS HOOK (integrator): evaluateTenantReadiness(svc, workspace.brokerageId, { repair: true })
    // — lane 140B's contract (seats / adminUser checks) routes this REPAIRABLE gap through the
    // self-healing engine (lane 140K) to repairIncompleteAccountSetup and re-verifies. Until it is
    // wired, determineFirstLoginDestination routes the account to /dashboard/onboarding
    // (setup_incomplete): visible, never hidden.
  }

  // Determine the correct destination from onboarding + workspace state
  const destination = await determineFirstLoginDestination(context.userId)
  redirect(destination.route)
}
