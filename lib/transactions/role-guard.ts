import { createServiceClient } from "@/lib/supabase/service"
import type { UserRole } from "@/lib/security"
// Imported from the defining modules, not the barrel (wave 144, lane 144Z — test:proxy-graph-budget: the barrel pulls every
// sibling module into app/crm/page.tsx's graph; the same symbols, nothing else).
import { toCanonicalRoleOrDefault } from "@/lib/security/types"
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

/** Why the deal desk refused — a CODE, so each caller can word the refusal for its own act (a stage move, a milestone, an edit). */
export type DealDeskRefusal =
  | "role_none" | "no_transaction" | "no_session_tenant" | "deal_unreadable" | "deal_not_found"
  | "no_assigned_agent" | "agent_unreadable" | "team_unreadable" | "not_your_deal"

export type DealDeskDecision =
  | { allowed: true; tier: "brokerage" | "deal"; via: "seat" | "own_deal" | "led_team" }
  | { allowed: false; code: DealDeskRefusal; reason: string }

/**
 * THE DEAL DESK — who may WORK one deal (move its stage, complete or schedule a milestone, edit its details). ONE gate.
 *
 * It was written as the stage-transition gate (lane 93A: `canTransitionStage` below, which now only words this decision for a
 * stage move) and is generalised here (wave 155) because two other deal gates had drifted from it:
 *   · app/actions/transaction-milestones.ts took the tenant from the request BODY and proved the deal with a read on the
 *     caller's row-security client. Any seat that could READ the deal passed — and the transactions SELECT policies admit a
 *     vendor seat assigned to it, so an assigned lender / title / inspector seat could complete or reschedule its milestones.
 *   · app/actions/transactions.ts requireTransactionActor admitted the agent on the deal or the tenant-admin roster. It refused
 *     the coordinator (`tc`) who normally enters title, escrow and deadline details, and it admitted a team lead on every deal
 *     of the brokerage rather than their own and their team's.
 * Both now ask this. `context.role` is the caller's users.user_type from the SESSION, never a body value; the tenant is the
 * session's and the deal must be in it.
 *
 * THE RULE (unchanged from lane 93A; the tiers are lib/auth/resolve-user-role.ts stageTransitionTier, derived from
 * TENANT_ADMIN_USER_TYPES — never a retyped list):
 *   "brokerage" — broker / broker_owner / broker_admin / admin / compliance_officer, and the coordinator (`tc`): any deal of
 *                 the tenant.
 *   "deal"      — an agent on the deal (any side — agents.id through agents.user_id, never users.id), and a team lead for their
 *                 own deals and the deals of the team they LEAD (teams.team_lead_id).
 *   refused     — every other seat (vendor, contact, isa, support, system) and a missing user_type. FAILS CLOSED.
 *
 * Every read is error-checked and a refused read REFUSES (§3/§4). Runs on the service client AFTER the session is known.
 */
export async function decideDealDesk(context: RoleContext): Promise<DealDeskDecision> {
  const no = (code: DealDeskRefusal, reason: string): DealDeskDecision => ({ allowed: false, code, reason })
  const tier = stageTransitionTier(context.role)
  if (tier === "none") return no("role_none", "Your seat cannot work on transactions")
  if (!context.transactionId) return no("no_transaction", "Transaction ID required")
  if (!context.brokerageId || !context.userId) return no("no_session_tenant", "No session tenant")

  const supabase = createServiceClient()
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('agent_id, buyer_agent_id, seller_agent_id')
    .eq('id', context.transactionId)
    .eq('brokerage_id', context.brokerageId)
    .maybeSingle()
  if (txError) return no("deal_unreadable", `Could not read the transaction: ${txError.message}`)
  if (!transaction) return no("deal_not_found", "Transaction not found in your brokerage")

  if (tier === "brokerage") return { allowed: true, tier, via: "seat" }

  // "deal" tier — own deal first (agents.id via agents.user_id, never users.id).
  const t = transaction as { agent_id: string | null; buyer_agent_id: string | null; seller_agent_id: string | null }
  const dealAgentIds = [...new Set([t.agent_id, t.buyer_agent_id, t.seller_agent_id].filter((x): x is string => !!x))]
  if (dealAgentIds.length === 0) return no("no_assigned_agent", "This transaction has no assigned agent — a broker or coordinator works it")
  const { data: ownAgents, error: agentError } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', context.userId)
    .eq('brokerage_id', context.brokerageId)
  if (agentError) return no("agent_unreadable", `Could not resolve your agent record: ${agentError.message}`)
  const own = new Set(((ownAgents ?? []) as Array<{ id: string }>).map((a) => a.id))
  if (dealAgentIds.some((id) => own.has(id))) return { allowed: true, tier, via: "own_deal" }

  // Team deal — the team the caller LEADS (teams.team_lead_id), resolved by the
  // one team-scope survivor. A refused read refuses. (Imported lazily: that
  // module is `server-only`, and this one is also loaded by pure proofs for
  // stageTransitionTier.)
  const { leadsAgentsTeam } = await import("@/lib/teams/team-scope")
  for (const agentId of dealAgentIds) {
    const led = await leadsAgentsTeam(supabase, context.userId, agentId)
    if (!led.ok) return no("team_unreadable", led.error)
    if (!led.ledTeamId) break // leads no team: no later agent can match
    if (led.leads) return { allowed: true, tier, via: "led_team" }
  }
  return no("not_your_deal", "Not your deal — you can work on your own transactions and your team's")
}

/** The stage machine's own wording for the three refusals a person can act on; every other refusal is relayed as decided. */
const STAGE_REFUSAL: Partial<Record<DealDeskRefusal, string>> = {
  role_none: "Your role cannot move transaction stages",
  no_assigned_agent: "This transaction has no assigned agent — a broker or coordinator moves it",
  not_your_deal: "Not your deal — you can move your own transactions and your team's",
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
 * The decision itself is decideDealDesk above (wave 155) — the same rule, now also asked by the milestone doors and the
 * deal-detail edits. This function words it for a stage move.
 */
export async function canTransitionStage(
  context: RoleContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const d = await decideDealDesk(context)
  if (d.allowed) return { allowed: true }
  return { allowed: false, reason: STAGE_REFUSAL[d.code] ?? d.reason }
}

// TOMBSTONE (wave 155 — CLAUDE.md §1 case 2 and §6, one vocabulary): canOverrideMilestone and canEditMilestoneDate are DELETED.
// Both answered "may this seat touch a milestone?" from the ROLE STRING ALONE — no session, no tenant, no deal — and neither had
// a caller (their one reference was the barrel re-export in lib/transactions/index.ts). They were two more spellings of the deal
// desk, and each disagreed with the gate that actually runs:
//   · canEditMilestoneDate (admin / broker / tc / agent / team_lead) → SURVIVOR decideDealDesk in THIS file — the same seats, with
//     the deal proven in the session's tenant and an agent or team lead held to their own / led team's deals. Called by
//     app/actions/transaction-milestones.ts (dealDeskFor) and app/actions/transactions.ts (requireTransactionActor).
//   · canOverrideMilestone (admin / broker / tc) → SURVIVOR lib/kernel/portal-auth.ts:474 requireOverrideActor, called by
//     app/actions/transaction-milestones.ts overrideMilestoneAction: broker / admin / compliance seats WITH a written reason. The
//     coordinator is not on the override roster there, and this deletion does not add them.

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

  // A lender or title company is a VENDOR CATEGORY on a user_type='vendor' seat (CLAUDE.md §4), so the
  // stored role of every live lender/title user is 'vendor' — which used to fall through to allowed:true
  // here (wave 153, lane 153Q). 'lender' / 'title_agent' stay as canonical permission roles.
  if (role === 'vendor' || role === 'lender' || role === 'title_agent') {
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
//   lib/kernel/portal-auth.ts      requireTitleVendorActor(transactionId)
//        title identity via user_role_assignments → vendors (title category),
//        assignment proven through vendor_assignments for THIS transaction
//        (lane 155T3 — it replaced requireTitleActor, which read the writer-less
//        title_company_users table).

//
// THE MILESTONE ALLOW-LIST IS NOT LOST — it was made unnecessary rather than
// dropped. This function existed to keep an external party away from milestones
// that are not theirs, by filtering a caller-supplied `milestoneType`. The
// surviving actions accept NO milestone parameter at all, which is the stronger
// form of the same rule: app/actions/lender-portal-actions.ts:161
// issueClearToClose writes only `clear_to_close_received`, and
// app/actions/title-portal.ts:436 updateTitleStatus writes only
// `closing_scheduled` / `closed`. The read-side visibility vocabularies are
// app/actions/lender-portal.ts:4 LENDER_VISIBLE_MILESTONES and
// lib/title-portal/constants.ts:8 TITLE_VISIBLE_MILESTONES.

// TOMBSTONE (wave 93 integrator): assertUserHasRole — its one caller (TransactionOrchestrator.advanceToStage,
// a retyped ["admin","broker","tc","agent"] list) moved to canTransitionStage in this file, which derives
// the tiers from TENANT_ADMIN_USER_TYPES and scopes agents / team leads to their own / led team's deals.
