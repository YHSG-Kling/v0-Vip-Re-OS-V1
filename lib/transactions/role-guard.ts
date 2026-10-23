import { createServiceClient } from "@/lib/supabase/service"
import type { UserRole } from "@/lib/security"
import { toCanonicalRoleOrDefault } from "@/lib/security"
import { stageTransitionTier } from "@/lib/auth/resolve-user-role"

export type { UserRole }

export interface RoleContext {
  userId: string
  /**
   * The user's role.  Pass either a canonical role string ('tc', 'admin', …)
   * or a legacy string ('TC', 'transaction_coordinator', …) — both are
   * normalised internally via toCanonicalRoleOrDefault().
   */
  role: UserRole | string
  brokerageId: string
  transactionId?: string
}

// Resolve a raw role string from RoleContext to a canonical UserRole.
function resolveRole(ctx: RoleContext): UserRole {
  return toCanonicalRoleOrDefault(ctx.role, 'contact')
}

/**
 * THE stage-transition gate — the one TransactionOrchestrator asks before it
 * moves (or checks moving) a deal. `context.role` is the caller's users.user_type
 * from the SESSION (requireCallerTenant), never a body value.
 *
 * Lane 93A merged the orchestrator's hard-coded `["admin","broker","tc","agent"]`
 * list ONTO this survivor (see transaction-orchestrator.ts). That list dropped
 * team_lead and compliance_officer, and — fed by the stage machine's private
 * `role ?? user_type ?? "agent"` — graded broker_owner/broker_admin by the
 * legacy free-form users.role column. This function, in turn, carried a
 * DISJOINT-ID defect from its first day: it compared transactions.agent_id (an
 * agents.id) to context.userId (a users.id), so no agent ever matched (§3,
 * 23503). The own-deal check now crosses through agents.user_id.
 *
 * Every read is error-checked and a refused read REFUSES (§3/§4).
 */
export async function canTransitionStage(
  context: RoleContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const tier = stageTransitionTier(context.role)
  if (tier === "none") {
    return { allowed: false, reason: "Your role cannot move transaction stages" }
  }
  if (!context.transactionId) {
    return { allowed: false, reason: 'Transaction ID required' }
  }
  if (!context.brokerageId || !context.userId) {
    return { allowed: false, reason: "No session tenant" }
  }

  const supabase = createServiceClient()
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('agent_id, buyer_agent_id, seller_agent_id')
    .eq('id', context.transactionId)
    .eq('brokerage_id', context.brokerageId)
    .maybeSingle()
  if (txError) return { allowed: false, reason: `Could not read the transaction: ${txError.message}` }
  if (!transaction) return { allowed: false, reason: "Transaction not found in your brokerage" }

  if (tier === "brokerage") return { allowed: true }

  // "deal" tier — own deal first (agents.id via agents.user_id, never users.id).
  const t = transaction as { agent_id: string | null; buyer_agent_id: string | null; seller_agent_id: string | null }
  const dealAgentIds = [...new Set([t.agent_id, t.buyer_agent_id, t.seller_agent_id].filter((x): x is string => !!x))]
  if (dealAgentIds.length === 0) {
    return { allowed: false, reason: "This transaction has no assigned agent — a broker or coordinator moves it" }
  }
  const { data: ownAgents, error: agentError } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', context.userId)
    .eq('brokerage_id', context.brokerageId)
  if (agentError) return { allowed: false, reason: `Could not resolve your agent record: ${agentError.message}` }
  const own = new Set(((ownAgents ?? []) as Array<{ id: string }>).map((a) => a.id))
  if (dealAgentIds.some((id) => own.has(id))) return { allowed: true }

  // Team deal — the team the caller LEADS (teams.team_lead_id), resolved by the
  // one team-scope survivor. A refused read refuses. (Imported lazily: that
  // module is `server-only`, and this one is also loaded by pure proofs for
  // stageTransitionTier.)
  const { leadsAgentsTeam } = await import("@/lib/teams/team-scope")
  for (const agentId of dealAgentIds) {
    const led = await leadsAgentsTeam(supabase, context.userId, agentId)
    if (!led.ok) return { allowed: false, reason: led.error }
    if (!led.ledTeamId) break // leads no team: no later agent can match
    if (led.leads) return { allowed: true }
  }
  return { allowed: false, reason: "Not your deal — you can move your own transactions and your team's" }
}

/**
 * Check if user can override a milestone with a reason.
 */
export async function canOverrideMilestone(
  context: RoleContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const role = resolveRole(context)

  if (role === 'superadmin' || role === 'admin' || role === 'broker' || role === 'tc') {
    return { allowed: true }
  }

  return { allowed: false, reason: 'Only broker / admin / TC can override milestones' }
}

/**
 * Check if user can edit milestone dates.
 */
export async function canEditMilestoneDate(
  context: RoleContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const role = resolveRole(context)

  if (['superadmin', 'admin', 'broker', 'tc', 'agent', 'team_lead'].includes(role)) {
    return { allowed: true }
  }

  return { allowed: false, reason: 'Cannot edit milestone dates' }
}

/**
 * Check if user can view financial details (CDA, commissions, etc.).
 */
export function canViewFinancials(
  context: RoleContext,
): { allowed: boolean; reason?: string } {
  const role = resolveRole(context)

  if (role === 'contact') {
    return { allowed: false, reason: 'Contacts cannot view internal financial details' }
  }

  if (role === 'lender' || role === 'title_agent') {
    return { allowed: false, reason: 'External parties cannot view commission details' }
  }

  return { allowed: true }
}

// ─── TOMBSTONE: canActAsExternalParty — DELETED, FUNCTIONALITY LIVES ELSEWHERE ─
//
// It gated a lender / title agent updating a milestone, on a
// `deal_team_members` row matched by `member_id` + member_type 'lender'/'title'.
// It was a DOUBLE orphan and the two halves proved each other dead:
//
//  · NO CALLER. The only reference in the tree was the barrel re-export at
//    lib/transactions/index.ts:39. Nothing ever invoked it.
//  · NO DATA, AND NO WRITER FOR THE DATA. `deal_team_members.member_id` is
//    written by nothing in the repository — the table's sole writer
//    (lib/transactions/vendor-quote-workflow.ts:approveQuote) only ever creates
//    'inspector' / 'insurance_provider' rows and never sets member_id. Measured
//    2026-08-22 on hrvaqgvukzxfskkcrwbt: deal_team_members holds 0 rows, and
//    the column carries no DEFAULT and no trigger. Every arm of this function
//    therefore evaluated to `{ allowed: false }` for its whole life.
//
// THE SURVIVOR is the external-party rail that runs on identities that actually
// exist and is called by the live portals:
//
//   lib/kernel/portal-auth.ts:61   requireLenderVendorActor(transactionId)
//        lender identity via user_role_assignments → vendors (lender category),
//        assignment proven through vendor_assignments for THIS transaction.
//   lib/kernel/portal-auth.ts:111  requireTitleActor(claimedTitleUserId)
//        title identity via title_company_users owned by the session user.
//
// THE MILESTONE ALLOW-LIST IS NOT LOST — it was made unnecessary rather than
// dropped. This function existed to keep an external party away from milestones
// that are not theirs, by filtering a caller-supplied `milestoneType`. The
// surviving actions accept NO milestone parameter at all, which is the stronger
// form of the same rule: app/actions/lender-portal-actions.ts:161
// issueClearToClose writes only `clear_to_close_received`, and
// app/actions/title-portal.ts:332 updateTitleStatus writes only
// `closing_scheduled` / `closed`. The read-side visibility vocabularies are
// app/actions/lender-portal.ts:4 LENDER_VISIBLE_MILESTONES and
// lib/title-portal/constants.ts:8 TITLE_VISIBLE_MILESTONES.

// TOMBSTONE (wave 93 integrator): assertUserHasRole — its one caller (TransactionOrchestrator.advanceToStage,
// a retyped ["admin","broker","tc","agent"] list) moved to canTransitionStage in this file, which derives
// the tiers from TENANT_ADMIN_USER_TYPES and scopes agents / team leads to their own / led team's deals.
