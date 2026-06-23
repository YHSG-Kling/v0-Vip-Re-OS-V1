// lib/kernel/deal-save-huddle.ts
//
// THE DEAL-SAVE HUDDLE — the multi-manager play that fires when a deal goes sideways.
//
// A deal health score crossing into at_risk/critical used to emit ONE generic event (staff
// notifications). A human deal team doesn't work that way: the moment a deal wobbles, the
// transaction coordinator quarterbacks a huddle — pulls the lender's side into the loan, hands
// the deadline/contingency exposure to whoever watches compliance, and personally drives the
// docs/title to done. This recreates that, routed by WHICH health component is actually failing:
//
//   LENDER / EARNEST_MONEY            → Finance Manager  (work the money + financing side)
//   DEADLINES / COMPLIANCE / INSPECTION → Compliance Officer (the contingency-clock exposure)
//   TITLE / DOCUMENTS / MILESTONES / PARTICIPANTS / COMMUNICATION → Deal Coordinator (drive to done)
//
// The Deal Coordinator CONVENES (it owns the transaction): it delegates the money side to Finance
// and the deadline side to Compliance over the manager-signals bus (so the huddle is VISIBLE in
// the "managers talking" feed), and handles its own docs/title bucket directly as a transaction
// task. Every action is internal drive-to-done (tasks / a manager alert) — no client egress here,
// so nothing bypasses the consent/compliance gate. Idempotent per (deal, manager) while the
// signal is open. PURE routing is unit-tested; the runner does the I/O (not server-only).

import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

/** The component score the deal-health scorer produces (kept local so this stays importable). */
export interface HealthComponentLite {
  category: string
  score: number
  issues: string[]
}

export type DealRiskLevel = "healthy" | "watch" | "at_risk" | "critical"

/** Which manager OWNS the analysis for each failing component. The human recipients of every
 *  play are always the Transaction Coordinator + the deal's agent (NOT the broker — this is
 *  operational, their job); the manager attribution is what the managers-talking feed shows.
 *  Earnest money is the TC's job (+ an urgent client warning); the loan is the finance side;
 *  deadlines/contingencies are the compliance side; title/docs/milestones are the TC's. */
export const COMPONENT_OWNER: Record<string, ManagerKey> = {
  LENDER: "finance_manager",
  EARNEST_MONEY: "deal_coordinator",
  DEADLINES: "compliance_officer",
  COMPLIANCE: "compliance_officer",
  INSPECTION: "compliance_officer",
  TITLE: "deal_coordinator",
  DOCUMENTS: "deal_coordinator",
  MILESTONES: "deal_coordinator",
  PARTICIPANTS: "deal_coordinator",
  COMMUNICATION: "deal_coordinator",
}

/** Components that put the buyer's earnest money at risk → an URGENT client warning is proposed. */
export const EARNEST_MONEY_COMPONENT = "EARNEST_MONEY"

/** The Deal Coordinator quarterbacks the huddle (owns the transaction). */
export const HUDDLE_CONVENER: ManagerKey = "deal_coordinator"
export const HUDDLE_SIGNAL = "deal_save_huddle"

/** A component is "failing" when it scored below the pass bar OR carries explicit issues. */
export const COMPONENT_FAIL_THRESHOLD = 70
export function isFailingComponent(c: HealthComponentLite): boolean {
  return c.score < COMPONENT_FAIL_THRESHOLD || (c.issues?.length ?? 0) > 0
}

const RISK_RANK: Record<DealRiskLevel, number> = { healthy: 0, watch: 1, at_risk: 2, critical: 3 }
const DANGER = new Set<DealRiskLevel>(["at_risk", "critical"])

/** PURE: did the deal WORSEN into the danger zone (at_risk/critical and worse than before)? */
export function isWorseningToDanger(prev: DealRiskLevel | null | undefined, next: DealRiskLevel): boolean {
  if (!DANGER.has(next)) return false
  const prevRank = prev ? RISK_RANK[prev] ?? 0 : 0
  return RISK_RANK[next] > prevRank
}

/** PURE: did the deal RECOVER out of the danger zone (was at_risk/critical, now healthy/watch)? */
export function isRecoveringFromDanger(prev: DealRiskLevel | null | undefined, next: DealRiskLevel): boolean {
  return !!prev && DANGER.has(prev) && !DANGER.has(next)
}

export interface HuddleBucket {
  manager: ManagerKey
  categories: string[]
  issues: string[]
}

/** PURE: route the FAILING components to the manager that owns each save. */
export function routeFailingComponents(components: HealthComponentLite[]): HuddleBucket[] {
  const byManager = new Map<ManagerKey, HuddleBucket>()
  for (const c of components) {
    if (!isFailingComponent(c)) continue
    const manager = COMPONENT_OWNER[c.category]
    if (!manager) continue
    const b = byManager.get(manager) ?? { manager, categories: [], issues: [] }
    b.categories.push(c.category)
    for (const i of c.issues ?? []) if (i) b.issues.push(i)
    byManager.set(manager, b)
  }
  return Array.from(byManager.values())
}

/** PURE: the role-specific play sentence for a manager's bucket. */
export function huddlePlay(manager: ManagerKey, bucket: HuddleBucket): string {
  const cats = bucket.categories.join(", ").toLowerCase()
  const detail = bucket.issues.length > 0 ? ` — ${bucket.issues.slice(0, 4).join("; ")}` : ""
  if (bucket.categories.includes(EARNEST_MONEY_COMPONENT)) {
    return `Earnest money at risk (${cats})${detail}: confirm the deposit/receipt now and warn the buyer of the deadline.`
  }
  switch (manager) {
    case "finance_manager":
      return `Work the financing side (${cats})${detail}: confirm the loan/clear-to-close ETA and chase the lender now.`
    case "compliance_officer":
      return `Deadline/contingency exposure (${cats})${detail}: verify the clock and flag any slipping contingency before it lapses.`
    default:
      return `Drive to done (${cats})${detail}: chase the open docs/title/milestones to keep the close on track.`
  }
}

// ── Deal-team resolution + notification (the Transaction Coordinator + the agent — NOT the
//    broker; the deal-save huddle is operational, their job) ────────────────────────────────

export interface DealTeam {
  agentUserId: string | null
  coordinatorUserId: string | null
  buyerContactId: string | null
  dealName: string | null
}

async function agentIdToUser(supabase: Svc, agentId: string | null | undefined): Promise<string | null> {
  if (!agentId) return null
  const { data } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  return (data as { user_id?: string | null } | null)?.user_id ?? null
}

/** Resolve a deal's Transaction Coordinator user + agent user + buyer contact. Best-effort. */
export async function resolveTransactionTeamUsers(supabase: Svc, transactionId: string): Promise<DealTeam> {
  const { data: t } = await supabase
    .from("transactions")
    .select("agent_id, coordinator_id, buyer_contact_id, contact_id, deal_name")
    .eq("id", transactionId)
    .maybeSingle()
  if (!t) return { agentUserId: null, coordinatorUserId: null, buyerContactId: null, dealName: null }
  const row = t as Record<string, unknown>
  const agentUserId = await agentIdToUser(supabase, row.agent_id as string | null)
  // coordinator_id may be an agents.id (→ user_id) or already a users.id — handle both.
  let coordinatorUserId = await agentIdToUser(supabase, row.coordinator_id as string | null)
  if (!coordinatorUserId && row.coordinator_id) {
    const { data: u } = await supabase.from("users").select("id").eq("id", row.coordinator_id as string).maybeSingle()
    coordinatorUserId = (u as { id?: string } | null)?.id ?? null
  }
  return {
    agentUserId,
    coordinatorUserId,
    buyerContactId: (row.buyer_contact_id as string | null) ?? (row.contact_id as string | null) ?? null,
    dealName: (row.deal_name as string | null) ?? null,
  }
}

/** Notify the deal's TC + agent (deduped per open (user, type, deal)). Returns count notified. */
export async function notifyDealTeam(
  supabase: Svc,
  args: { team: DealTeam; brokerageId: string; transactionId: string; type: string; title: string; body: string; priority: "low" | "medium" | "high" | "critical" },
): Promise<number> {
  const recipients = Array.from(new Set([args.team.coordinatorUserId, args.team.agentUserId].filter(Boolean))) as string[]
  let notified = 0
  for (const userId of recipients) {
    const { data: dup } = await supabase.from("notifications").select("id")
      .eq("user_id", userId).eq("type", args.type).eq("entity_id", args.transactionId).eq("is_read", false).limit(1).maybeSingle()
    if (dup) continue
    const { error } = await supabase.from("notifications").insert({
      user_id: userId, brokerage_id: args.brokerageId, type: args.type,
      title: args.title, body: args.body, entity_type: "transaction", entity_id: args.transactionId,
      priority: args.priority, is_read: false,
    })
    if (!error) notified += 1
  }
  return notified
}

export interface DealSaveHuddleResult {
  convened: boolean
  coordinatorTaskCreated: boolean
  delegatedTo: ManagerKey[]
  notifiedUsers: number
  clientWarningProposed: boolean
  vendorsNotified: string[]
  reason?: string
}

/**
 * Convene the huddle for a deal that worsened into the danger zone. The Deal Coordinator drives
 * its own docs/title/earnest bucket (a task assigned to the TC) and delegates the loan side to
 * Finance + the deadline side to Compliance over the bus. EVERY play keeps the TC + the deal's
 * agent aware (NOT the broker — operational, their job); earnest money also proposes an URGENT
 * gated client warning to the buyer. Idempotent (signals dedupe per open (deal, manager); the
 * coordinator task dedupes on a tagged title; notifications + the client warning dedupe too).
 * Best-effort, never throws.
 */
export async function runDealSaveHuddle(
  params: {
    transactionId: string
    brokerageId: string
    riskLevel: DealRiskLevel
    components: HealthComponentLite[]
    dealName?: string | null
  },
  client?: Svc,
): Promise<DealSaveHuddleResult> {
  const supabase: Svc = client ?? createServiceClient()
  const buckets = routeFailingComponents(params.components)
  const empty = { convened: false, coordinatorTaskCreated: false, delegatedTo: [] as ManagerKey[], notifiedUsers: 0, clientWarningProposed: false, vendorsNotified: [] as string[] }
  if (buckets.length === 0) return { ...empty, reason: "no failing components" }

  const team = await resolveTransactionTeamUsers(supabase, params.transactionId)
  const deal = params.dealName?.trim() || team.dealName?.trim() || "this deal"
  const priority: "high" | "medium" = params.riskLevel === "critical" ? "high" : "medium"
  const delegatedTo: ManagerKey[] = []
  let coordinatorTaskCreated = false
  let clientWarningProposed = false
  let notifiedUsers = 0

  for (const bucket of buckets) {
    const play = huddlePlay(bucket.manager, bucket)
    if (bucket.manager === HUDDLE_CONVENER) {
      // The TC's own bucket — a tagged, deduped drive-to-done task assigned to the TC.
      const title = `[Deal-Save Huddle] ${deal}: ${bucket.categories.join(", ")}`
      const { data: dup } = await supabase
        .from("transaction_tasks").select("id")
        .eq("transaction_id", params.transactionId).eq("title", title)
        .in("status", ["pending", "in_progress"]).limit(1).maybeSingle()
      if (!dup) {
        const { error } = await supabase.from("transaction_tasks").insert({
          transaction_id: params.transactionId,
          brokerage_id: params.brokerageId,
          title,
          description: play,
          priority,
          category: "deal_save",
          ai_generated: true,
          status: "pending",
          assigned_user_id: team.coordinatorUserId ?? null,
        })
        coordinatorTaskCreated = !error
      }
      // Keep the TC + agent aware.
      notifiedUsers += await notifyDealTeam(supabase, {
        team, brokerageId: params.brokerageId, transactionId: params.transactionId,
        type: "deal_save_huddle", title: `Deal needs attention — ${deal}`, body: play, priority,
      })
      // Earnest money at risk → an URGENT gated client warning to the buyer (proposed; human approves).
      if (bucket.categories.includes(EARNEST_MONEY_COMPONENT) && team.buyerContactId) {
        const dupTag = "[Deal-Save Huddle · Earnest Money]"
        const { data: dupMsg } = await supabase.from("agent_client_messages").select("id")
          .eq("recipient_contact_id", team.buyerContactId).ilike("rationale", `${dupTag}%`).eq("status", "proposed").limit(1).maybeSingle()
        if (!dupMsg) {
          const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
          const res = await proposeClientMessage({
            brokerageId: params.brokerageId,
            agentKind: "deal_coordinator",
            entityType: "transaction",
            entityId: params.transactionId,
            recipientContactId: team.buyerContactId,
            audience: "buyer",
            subject: "Time-sensitive: your earnest money",
            body: "Hi — a quick but time-sensitive heads-up on your purchase: there's an item around your earnest money that needs attention to keep your closing on track. Please reach out as soon as you can so we can confirm the details together.",
            rationale: `${dupTag} — Deal Coordinator: earnest money is at risk on ${deal}; an URGENT buyer heads-up, drafted for approval.`,
            channel: "portal",
          }, supabase)
          clientWarningProposed = res.ok
        }
      }
    } else {
      // Delegate the loan side (Finance) / deadline side (Compliance) over the bus (visible in
      // the managers-talking feed). Those handlers keep the SAME TC + agent aware — never the broker.
      const res = await publishManagerSignal({
        brokerageId: params.brokerageId,
        fromManager: HUDDLE_CONVENER,
        toManager: bucket.manager,
        signalType: HUDDLE_SIGNAL,
        message: `${deal} is ${params.riskLevel}. ${play}`,
        entityType: "transaction",
        entityId: params.transactionId,
        payload: { risk_level: params.riskLevel, categories: bucket.categories, issues: bucket.issues, play },
      }, supabase)
      if (res.ok) delegatedTo.push(bucket.manager)
    }
  }

  // B2B leg — if a lender / title / escrow company is on the deal, notify whoever can move the
  // failing item (loan officer for financing, title/escrow officer for title or earnest money).
  // Deduped + audited + best-effort; the huddle never fails on a vendor send.
  const allCategories = buckets.flatMap((b) => b.categories)
  const allIssues = buckets.flatMap((b) => b.issues)
  let vendorsNotified: string[] = []
  try {
    const { notifyDealVendorsOfIssue } = await import("@/lib/transactions/deal-vendor-notify")
    const v = await notifyDealVendorsOfIssue(supabase, {
      transactionId: params.transactionId, brokerageId: params.brokerageId,
      dealName: deal, categories: allCategories, issues: allIssues,
    })
    vendorsNotified = v.notified
  } catch { /* best-effort — vendor notice never breaks the huddle */ }

  return { convened: true, coordinatorTaskCreated, delegatedTo, notifiedUsers, clientWarningProposed, vendorsNotified }
}

export interface DealSaveStandDownResult {
  stoodDown: number
  notifiedUsers: number
}

/**
 * Stand the huddle DOWN when a deal recovers out of the danger zone — finishing the loop the
 * huddle opened. Expires the open deal_save_huddle signals for the deal (the bus coordination
 * closes) and gives the TC + agent the good news. The open drive-to-done tasks are left for the
 * human to close (auto-completing them could falsely claim work that the recovery didn't do).
 * Idempotent (only OPEN signals are expired); best-effort, never throws.
 */
export async function standDownDealSaveHuddle(
  params: { transactionId: string; brokerageId: string; newRiskLevel: DealRiskLevel; dealName?: string | null },
  client?: Svc,
): Promise<DealSaveStandDownResult> {
  const supabase: Svc = client ?? createServiceClient()
  const { data: expired } = await supabase
    .from("manager_signals")
    .update({ status: "expired", consumed_at: new Date().toISOString(), consumed_action: `stood down — deal recovered to ${params.newRiskLevel}` })
    .eq("brokerage_id", params.brokerageId)
    .eq("signal_type", HUDDLE_SIGNAL)
    .eq("entity_id", params.transactionId)
    .eq("status", "open")
    .select("id")
  const stoodDown = (expired ?? []).length
  if (stoodDown === 0) return { stoodDown: 0, notifiedUsers: 0 }

  const team = await resolveTransactionTeamUsers(supabase, params.transactionId)
  const deal = params.dealName?.trim() || team.dealName?.trim() || "the deal"
  const notifiedUsers = await notifyDealTeam(supabase, {
    team, brokerageId: params.brokerageId, transactionId: params.transactionId,
    type: "deal_save_stood_down",
    title: `Back on track — ${deal}`,
    body: `Good news: ${deal} recovered to ${params.newRiskLevel}. The deal-save huddle stood down — close out any remaining items when you get a moment.`,
    priority: "low",
  })
  return { stoodDown, notifiedUsers }
}
