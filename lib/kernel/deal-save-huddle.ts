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

/** Which manager owns the save for each failing health component. */
export const COMPONENT_OWNER: Record<string, ManagerKey> = {
  LENDER: "finance_manager",
  EARNEST_MONEY: "finance_manager",
  DEADLINES: "compliance_officer",
  COMPLIANCE: "compliance_officer",
  INSPECTION: "compliance_officer",
  TITLE: "deal_coordinator",
  DOCUMENTS: "deal_coordinator",
  MILESTONES: "deal_coordinator",
  PARTICIPANTS: "deal_coordinator",
  COMMUNICATION: "deal_coordinator",
}

/** The Deal Coordinator quarterbacks the huddle (owns the transaction). */
export const HUDDLE_CONVENER: ManagerKey = "deal_coordinator"
export const HUDDLE_SIGNAL = "deal_save_huddle"

/** A component is "failing" when it scored below the pass bar OR carries explicit issues. */
export const COMPONENT_FAIL_THRESHOLD = 70
export function isFailingComponent(c: HealthComponentLite): boolean {
  return c.score < COMPONENT_FAIL_THRESHOLD || (c.issues?.length ?? 0) > 0
}

const RISK_RANK: Record<DealRiskLevel, number> = { healthy: 0, watch: 1, at_risk: 2, critical: 3 }

/** PURE: did the deal WORSEN into the danger zone (at_risk/critical and worse than before)? */
export function isWorseningToDanger(prev: DealRiskLevel | null | undefined, next: DealRiskLevel): boolean {
  if (next !== "at_risk" && next !== "critical") return false
  const prevRank = prev ? RISK_RANK[prev] ?? 0 : 0
  return RISK_RANK[next] > prevRank
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
  switch (manager) {
    case "finance_manager":
      return `Work the financing side (${cats})${detail}: confirm the loan/clear-to-close ETA and chase the lender now.`
    case "compliance_officer":
      return `Deadline/contingency exposure (${cats})${detail}: verify the clock and flag any slipping contingency before it lapses.`
    default:
      return `Drive to done (${cats})${detail}: chase the open docs/title/milestones to keep the close on track.`
  }
}

export interface DealSaveHuddleResult {
  convened: boolean
  coordinatorTaskCreated: boolean
  delegatedTo: ManagerKey[]
  reason?: string
}

/**
 * Convene the huddle for a deal that worsened into the danger zone. The Deal Coordinator
 * delegates the money side to Finance + the deadline side to Compliance over the bus, and opens
 * its own drive-to-done task for the docs/title bucket. Idempotent (signals dedupe per open
 * (deal, manager); the coordinator task dedupes on a tagged title). Best-effort, never throws.
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
  if (buckets.length === 0) return { convened: false, coordinatorTaskCreated: false, delegatedTo: [], reason: "no failing components" }

  const deal = params.dealName?.trim() || "this deal"
  const delegatedTo: ManagerKey[] = []
  let coordinatorTaskCreated = false

  for (const bucket of buckets) {
    const play = huddlePlay(bucket.manager, bucket)
    if (bucket.manager === HUDDLE_CONVENER) {
      // The convener handles its own bucket directly — a tagged, deduped drive-to-done task.
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
          priority: params.riskLevel === "critical" ? "high" : "medium",
          category: "deal_save",
          ai_generated: true,
          status: "pending",
        })
        coordinatorTaskCreated = !error
      }
    } else {
      // Delegate to Finance / Compliance over the bus (visible in the managers-talking feed).
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

  return { convened: true, coordinatorTaskCreated, delegatedTo }
}
