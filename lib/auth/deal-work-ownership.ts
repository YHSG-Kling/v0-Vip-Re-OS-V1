// lib/auth/deal-work-ownership.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHO OWNS WHICH WORK ON A DEAL — STAGE-AWARE, FROM THE ASSIGNMENTS THAT ALREADY EXIST (wave 153, lane 153C; directive §153C C1).
//
// Owner (verbatim, 2026-11-14): "when there is an offer, listing or transaction, the agetn takes charge and a transaction
// coordinator can see and assist active listings and transactions, and compliance can review/make notes etc on listings and
// transactions. when the transaction is closing and goes through a compliance review, they take charge of approving …"
//
// NO NEW USER TYPES, NO NEW ROLES. Every input is an existing fact:
//   · the OWNING AGENT       transactions.agent_id (an agents.id — crossed from the session via agents.user_id, CLAUDE.md §3)
//   · the ASSISTING TC       transactions.coordinator_id / transaction_assignments.coordinator_id → transaction_coordinators.user_id,
//                            or a `tc` seat / grant in the tenant (the workspace page already admits the tenant's TC seats)
//   · COMPLIANCE             users.user_type / grant `compliance_officer`
//   · TENANT ADMINS          the operational roster TENANT_ADMIN_USER_TYPES by NAMED SUBTRACTION (minus team_lead, minus
//                            compliance_officer — both answered separately), never a retyped list (CLAUDE.md §4)
//   · the TEAM LEAD          teams.team_lead_id of the deal agent's team (a team is a mini brokerage — its own board only)
//   · ACTIVE                 lib/enrichment/deal-vocabulary.ts isTransactionLive (the one active-deal predicate)
//
// WHAT EACH MAY DO (the rule — pure, so a panel, a door and a proof read the same answer):
//   owning agent    representation, negotiation, client response, governing decisions (actAsAgent) on ITS active deal; assists, flags
//   assisting TC    reads; on an ACTIVE deal assists (tasks, documents, follow-ups) and flags — NEVER acts as the agent or broker
//   compliance      inspects and ANNOTATES throughout (closed deals too), flags, verifies lender evidence, controls closing approval
//   tenant admin    reads, assists, annotates, flags, verifies, closing approval — never acts AS the agent (impersonation is the
//                   separate support seam, CLAUDE.md §5)
//   team lead       reads, assists and flags on its own team's deals — no closing approval (a team board, not the brokerage's)
//   anyone else     nothing (vendors, lenders and title reach only their OWN documents through lib/kernel/portal-auth.ts)
// Capabilities are a UNION over every role the person holds on the deal (one person may carry several seats — the solo
// tenant's second seat is the designed case).

import type { SupabaseClient } from "@supabase/supabase-js"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { isTransactionLive } from "@/lib/enrichment/deal-vocabulary"

type DealWorkRole = "owning_agent" | "compliance_reviewer" | "tenant_admin" | "team_lead" | "assisting_tc" | "none"

interface DealWorkCapabilities {
  read: boolean
  /** tasks, documents, follow-ups, recording what a lender said */
  assist: boolean
  /** raise a problem to the agent / compliance */
  flag: boolean
  /** persisted compliance review notes */
  annotate: boolean
  /** representation, negotiation, client response, governing deal decisions — the agent's alone */
  actAsAgent: boolean
  /** final closing-compliance approve / hold / reject */
  closingApproval: boolean
  /** verify a reported lender fact with the lender's written evidence */
  verifyLenderEvidence: boolean
}

interface DealWorkAccess {
  role: DealWorkRole
  roles: DealWorkRole[]
  capabilities: DealWorkCapabilities
  dealActive: boolean
  /** one plain line naming what this person owns on the deal */
  summary: string
}

/** The tenant admin seats that answer as "tenant admin" here: the roster MINUS team_lead and compliance_officer (named subtraction). */
const DEAL_ADMIN_USER_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "team_lead" && t !== "compliance_officer"))

const NONE: DealWorkCapabilities = { read: false, assist: false, flag: false, annotate: false, actAsAgent: false, closingApproval: false, verifyLenderEvidence: false }

const SUMMARY: Record<DealWorkRole, string> = {
  owning_agent: "You lead this deal: representation, negotiation, client responses and the deal's decisions are yours.",
  compliance_reviewer: "You review this deal: inspect documents and terms, add review notes, and decide the closing compliance approval.",
  tenant_admin: "You oversee this deal for the account: review, assist, add notes and decide closing approval. The agent leads the client side.",
  team_lead: "This deal is on your team's board: you can review, assist and flag. The agent leads it.",
  assisting_tc: "You coordinate this deal: tasks, documents and follow-ups, and you can flag problems. The agent leads the client side and its decisions.",
  none: "You do not have access to this deal.",
}

/** PURE — the stage-aware work ownership on ONE deal. */
export function resolveDealWork(input: {
  sameTenant: boolean
  userType: string | null
  grantedRoles: readonly string[]
  isOwningAgent: boolean
  isAssignedTc: boolean
  isTeamLeadOfDealAgent: boolean
  dealStatus: string | null
  dealStage: string | null
}): DealWorkAccess {
  const dealActive = isTransactionLive({ status: input.dealStatus, stage: input.dealStage })
  if (!input.sameTenant) return { role: "none", roles: [], capabilities: NONE, dealActive, summary: SUMMARY.none }
  const held = new Set([String(input.userType ?? "").toLowerCase(), ...input.grantedRoles.map((r) => String(r).toLowerCase())].filter(Boolean))
  const roles: DealWorkRole[] = []
  if (input.isOwningAgent) roles.push("owning_agent")
  if (held.has("compliance_officer")) roles.push("compliance_reviewer")
  if ([...held].some((r) => DEAL_ADMIN_USER_TYPES.has(r))) roles.push("tenant_admin")
  if (input.isTeamLeadOfDealAgent) roles.push("team_lead")
  if (input.isAssignedTc || held.has("tc")) roles.push("assisting_tc")
  if (roles.length === 0) return { role: "none", roles: [], capabilities: NONE, dealActive, summary: SUMMARY.none }

  const cap: DealWorkCapabilities = { ...NONE }
  for (const r of roles) {
    cap.read = true
    cap.flag = true
    if (r === "owning_agent") { cap.actAsAgent = cap.actAsAgent || dealActive; cap.assist = cap.assist || dealActive }
    if (r === "assisting_tc" || r === "team_lead") cap.assist = cap.assist || dealActive
    if (r === "compliance_reviewer") { cap.annotate = true; cap.closingApproval = true; cap.verifyLenderEvidence = true }
    if (r === "tenant_admin") { cap.annotate = true; cap.closingApproval = true; cap.verifyLenderEvidence = true; cap.assist = cap.assist || dealActive }
  }
  return { role: roles[0], roles, capabilities: cap, dealActive, summary: SUMMARY[roles[0]] }
}

type Svc = SupabaseClient<any, any, any>

/**
 * Read the facts resolveDealWork needs for the SESSION user on one deal — tenant-pinned, every error read. A refused read FAILS
 * CLOSED (ok:false; the caller refuses), and a deal outside the caller's tenant answers `none`, never another tenant's facts.
 */
export async function loadDealWorkAccess(svc: Svc, input: { userId: string; brokerageId: string; userType: string | null; transactionId: string }): Promise<
  { ok: true; access: DealWorkAccess; deal: { id: string; agentId: string | null; status: string | null; stage: string | null } } | { ok: false; error: string }
> {
  const { userId, brokerageId, transactionId } = input
  if (!userId || !brokerageId || !transactionId) return { ok: false, error: "the caller and the deal are required" }
  const { data: tx, error: txErr } = await svc.from("transactions").select("id, brokerage_id, agent_id, coordinator_id, status, stage").eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (txErr) return { ok: false, error: `the deal could not be read: ${txErr.message}` }
  if (!tx) {
    const access = resolveDealWork({ sameTenant: false, userType: input.userType, grantedRoles: [], isOwningAgent: false, isAssignedTc: false, isTeamLeadOfDealAgent: false, dealStatus: null, dealStage: null })
    return { ok: true, access, deal: { id: transactionId, agentId: null, status: null, stage: null } }
  }
  const t = tx as { id: string; agent_id: string | null; coordinator_id: string | null; status: string | null; stage: string | null }
  const [meAgent, meTc, grants, assigned] = await Promise.all([
    svc.from("agents").select("id").eq("user_id", userId).eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("transaction_coordinators").select("id").eq("user_id", userId).eq("brokerage_id", brokerageId),
    svc.from("user_role_assignments").select("role, brokerage_id").eq("user_id", userId),
    svc.from("transaction_assignments").select("coordinator_id").eq("transaction_id", transactionId).eq("brokerage_id", brokerageId),
  ])
  for (const r of [meAgent, meTc, grants, assigned]) if (r.error) return { ok: false, error: `the deal roles could not be read: ${r.error.message}` }
  const myAgentId = ((meAgent.data ?? null) as { id?: string } | null)?.id ?? null
  const myTcIds = new Set(((meTc.data ?? []) as Array<{ id: string }>).map((r) => r.id))
  const assignedTcIds = new Set([t.coordinator_id, ...((assigned.data ?? []) as Array<{ coordinator_id: string | null }>).map((r) => r.coordinator_id)].filter((x): x is string => !!x))
  const grantedRoles = ((grants.data ?? []) as Array<{ role: string | null; brokerage_id: string | null }>).filter((g) => g.brokerage_id === brokerageId && g.role).map((g) => String(g.role))

  let isTeamLeadOfDealAgent = false
  if (t.agent_id) {
    const { data: dealAgent, error: daErr } = await svc.from("agents").select("team_id").eq("id", t.agent_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (daErr) return { ok: false, error: `the deal agent's team could not be read: ${daErr.message}` }
    const teamId = ((dealAgent ?? null) as { team_id?: string | null } | null)?.team_id ?? null
    if (teamId) {
      const { data: team, error: tErr } = await svc.from("teams").select("team_lead_id").eq("id", teamId).eq("brokerage_id", brokerageId).maybeSingle()
      if (tErr) return { ok: false, error: `the deal agent's team could not be read: ${tErr.message}` }
      isTeamLeadOfDealAgent = ((team ?? null) as { team_lead_id?: string | null } | null)?.team_lead_id === userId
    }
  }
  const access = resolveDealWork({
    sameTenant: true, userType: input.userType, grantedRoles,
    isOwningAgent: !!myAgentId && myAgentId === t.agent_id,
    isAssignedTc: [...myTcIds].some((id) => assignedTcIds.has(id)),
    isTeamLeadOfDealAgent, dealStatus: t.status, dealStage: t.stage,
  })
  return { ok: true, access, deal: { id: t.id, agentId: t.agent_id, status: t.status, stage: t.stage } }
}
