import { createServiceClient } from "@/lib/supabase/service"
import { ActivityFactory } from "./activity-factory"
import { NotificationService } from "./notification-service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

const activityFactory = new ActivityFactory()
const notificationService = new NotificationService()

const CRITICAL_MILESTONES = [
  "inspection_deadline",
  "appraisal_deadline",
  "financing_deadline",
  "cda_delivered"
]

const WARNING_THRESHOLDS = {
  earnest_money_due: 48, // hours
  inspection_deadline: 24,
  financing_deadline: 48
}

/**
 * Hourly cron job to check transaction deadlines
 * Marks overdue, sends warnings, creates activities
 */
export async function checkTransactionDeadlines() {
  const supabase = createServiceClient()
  
  // Get all active transactions
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, brokerage_id, agent_id, stage")
    .not("status", "in", '("closed","lost")')
    .order("created_at", { ascending: false })
  
  if (!transactions) return
  
  const now = new Date()
  
  for (const txn of transactions) {
    // Get pending milestones with dates
    const { data: milestones } = await supabase
      .from("transaction_milestones")
      .select("*")
      .eq("transaction_id", txn.id)
      .eq("brokerage_id", txn.brokerage_id)
      .eq("status", "pending")
      .not("target_date", "is", null)
    
    if (!milestones) continue
    
    for (const milestone of milestones) {
      const milestoneDate = new Date(milestone.target_date)
      const hoursUntil = (milestoneDate.getTime() - now.getTime()) / (1000 * 60 * 60)
      
      // Check if overdue
      if (now > milestoneDate) {
        await handleOverdue(txn, milestone)
      }
      // Check if warning threshold reached
      else if (milestone.milestone_name in WARNING_THRESHOLDS) {
        const threshold = WARNING_THRESHOLDS[milestone.milestone_name as keyof typeof WARNING_THRESHOLDS]
        if (hoursUntil <= threshold && hoursUntil > 0) {
          await sendWarning(txn, milestone, hoursUntil)
        }
      }
    }
  }
}

/**
 * ONE MOMENT, ONE SPELLING (wave 155, lane 155B2 — CLAUDE.md §6). An overdue milestone used to be recorded TWO ways: this
 * monitor wrote the lifecycle label "milestone.overdue" (stored as `lifecycle.milestone.overdue`) and sent its OWN activity +
 * multi-channel notification, while app/actions/copilot.ts checkOverdueMilestones wrote KernelEvent.MILESTONE_OVERDUE through
 * logMilestoneOverdue → orchestrateEvent → a SECOND suggestion + bell. The same milestone found by both paths on one day rang
 * twice, and the copilot path never marked the row, so every call re-rang. Now the monitor EMITS the one spelling
 * (KernelEvent.MILESTONE_OVERDUE, via emitEventFromCron, the dispatching emitter), the orchestrator's case for it calls
 * raiseMilestoneOverdue, and so does the copilot path — ONE body, ONE notification, ONE card, at most once per milestone per
 * UTC day (agent_action_ledger key). A dispatch that does not run falls back to calling the body directly; the key makes that
 * safe. The dotted label is not written any more (it had no reader: the warning dedupe reads `lifecycle.milestone.warning`).
 */
async function handleOverdue(
  txn: { id: string; brokerage_id: string; agent_id: string; stage: string },
  milestone: any
) {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const daysOverdue = Math.max(0, Math.floor((now.getTime() - new Date(milestone.target_date).getTime()) / 86_400_000))
  let dispatched = false
  try {
    const { emitEventFromCron } = await import("@/lib/orchestrator/internal")
    const { KernelEvent } = await import("@/lib/kernel/events")
    const r = await emitEventFromCron({
      brokerage_id: txn.brokerage_id,
      event_type:   KernelEvent.MILESTONE_OVERDUE,
      payload:      { milestone_id: milestone.id, milestone_title: milestone.title ?? milestone.milestone_name, milestone_name: milestone.milestone_name, transaction_id: txn.id, target_date: milestone.target_date, stage: txn.stage, days_overdue: daysOverdue },
      source:       "cron",
      dedupe_key:   `milestone_overdue:${milestone.id}:${day}`,
      entity_type:  "transaction",
      entity_id:    txn.id,
    })
    dispatched = r.success && (r.deduped === true || r.dispatched === true)
    if (!r.success) console.error(`[deadline-monitor] milestone_overdue event not recorded for ${milestone.id}: ${r.error}`)
  } catch (e) {
    console.error(`[deadline-monitor] milestone_overdue emit threw for ${milestone.id}:`, e instanceof Error ? e.message : e)
  }
  // RECOVERY: the event row may land without its dispatch (or not at all) — the person is still told, exactly once.
  if (!dispatched) await raiseMilestoneOverdue(createServiceClient(), { brokerageId: txn.brokerage_id, milestoneId: milestone.id, source: "deadline_monitor", now })
}

export type MilestoneOverdueOutcome = {
  decision: "raised" | "already_raised_today" | "not_overdue" | "unreadable"
  notified: number
  detail: string
}

/**
 * THE ONE OVERDUE-MILESTONE RAISE (wave 155, lane 155B2). Both finders end here: the hourly monitor (via its
 * KernelEvent.MILESTONE_OVERDUE dispatch, or directly on recovery) and the copilot's checkOverdueMilestones (via
 * logMilestoneOverdue → orchestrateEvent). Tenant: the caller's verified brokerageId; the milestone and its transaction are
 * read IN it. Once per milestone per UTC day: agent_action_ledger idempotency key `milestone.overdue:<tenant>:<milestone>:<day>`
 * — a second finder, a re-dispatch or a retry the same day replays and notifies nobody. What it does is what the monitor
 * already did (mark the row overdue, the urgent activity, the agent / TC / broker notification) plus the agent card the copilot
 * path wrote, passed in as `suggest` so this module stays free of the orchestrator.
 */
export async function raiseMilestoneOverdue(
  svc: any,
  input: { brokerageId: string; milestoneId: string; source: "deadline_monitor" | "copilot"; now?: Date; actorUserId?: string | null },
  deps: {
    notify?: (p: Parameters<NotificationService["notifyMilestoneOverdue"]>[0]) => Promise<void>
    activity?: (p: Parameters<ActivityFactory["createMilestoneActivity"]>[0]) => Promise<unknown>
    suggest?: (p: { brokerageId: string; userId: string; transactionId: string; milestoneId: string; title: string; daysOverdue: number }) => Promise<void>
  } = {},
): Promise<MilestoneOverdueOutcome> {
  const now = input.now ?? new Date()
  const { data: m, error: mErr } = await svc
    .from("transaction_milestones")
    .select("id, transaction_id, brokerage_id, milestone_name, title, target_date, status")
    .eq("id", input.milestoneId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (mErr || !m) return { decision: "unreadable", notified: 0, detail: mErr ? `milestone read refused: ${mErr.message}` : `milestone ${input.milestoneId} is not in brokerage ${input.brokerageId}` }
  if (!m.target_date || new Date(m.target_date).getTime() >= now.getTime() || (m.status !== "pending" && m.status !== "overdue")) {
    return { decision: "not_overdue", notified: 0, detail: `status ${m.status}, target ${m.target_date}` }
  }
  const { data: txn, error: tErr } = await svc
    .from("transactions").select("id, brokerage_id, agent_id, stage").eq("id", m.transaction_id).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (tErr || !txn) return { decision: "unreadable", notified: 0, detail: tErr ? `transaction read refused: ${tErr.message}` : `transaction ${m.transaction_id} is not in brokerage ${input.brokerageId}` }
  const day = now.toISOString().slice(0, 10)
  const daysOverdue = Math.max(0, Math.floor((now.getTime() - new Date(m.target_date).getTime()) / 86_400_000))
  const isCritical = CRITICAL_MILESTONES.includes(m.milestone_name)
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<MilestoneOverdueOutcome>(
    {
      brokerageId: input.brokerageId,
      action: "transaction.milestone.overdue_notice",
      actor: { type: "manager", managerKey: "deal_coordinator" },
      subject: { type: "transaction", id: txn.id, ref: m.id },
      reasonCode: "TRANSACTION_DEADLINE",
      reasonDetail: `${m.milestone_name} is ${daysOverdue} day(s) past its target date (found by ${input.source})`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "milestone_overdue",
      idempotencyKey: `milestone.overdue:${input.brokerageId}:${m.id}:${day}`,
      detail: { milestone_id: m.id, milestone_name: m.milestone_name, target_date: m.target_date, days_overdue: daysOverdue, critical: isCritical, found_by: input.source, decided_by: "transaction_milestones.target_date < now (pending)" },
    },
    async () => {
      const { data: marked, error: markErr } = await svc
        .from("transaction_milestones").update({ status: "overdue" })
        .eq("id", m.id).eq("brokerage_id", input.brokerageId).in("status", ["pending", "overdue"]).select("id")
      if (markErr) console.error(`[deadline-monitor] milestone NOT marked overdue: ${markErr.message}`)
      else if (!Array.isArray(marked) || marked.length === 0) console.error(`[deadline-monitor] milestone ${m.id} overdue mark matched no row`)
      await (deps.activity ?? ((p) => activityFactory.createMilestoneActivity(p)))({
        transactionId: txn.id, brokerageId: input.brokerageId, milestoneType: "overdue", assignedTo: txn.agent_id, priority: "high",
      })
      await (deps.notify ?? ((p) => notificationService.notifyMilestoneOverdue(p)))({
        transactionId: txn.id, brokerageId: input.brokerageId, agentId: txn.agent_id, milestoneName: m.milestone_name,
        propertyAddress: txn.id, // address resolved downstream from transaction record
        isCritical,
      })
      if (deps.suggest) {
        // The card goes to the deal's agent (transactions.agent_id is agents-class → agents.user_id, §3); the finder's own user
        // is the fallback only when the deal has no agent row in the tenant.
        let userId: string | null = null
        if (txn.agent_id) {
          const { data: ag } = await svc.from("agents").select("user_id").eq("id", txn.agent_id).eq("brokerage_id", input.brokerageId).maybeSingle()
          userId = (ag?.user_id as string | null) ?? null
        }
        userId = userId ?? input.actorUserId ?? null
        if (userId) {
          try { await deps.suggest({ brokerageId: input.brokerageId, userId, transactionId: txn.id, milestoneId: m.id, title: m.title ?? m.milestone_name, daysOverdue }) }
          catch (e) { console.error(`[deadline-monitor] overdue card not written for ${m.id}:`, e instanceof Error ? e.message : e) }
        }
      }
      return { decision: "raised", notified: 1, detail: `${m.milestone_name} ${daysOverdue}d overdue` }
    },
    {
      settle: (o) => ({ status: "executed", outcome: `notified:${o.notified}` }),
      replay: (claim) => ({ decision: "already_raised_today", notified: 0, detail: `ledger claim ${claim.kind}` }),
    },
    { client: svc },
  )
}

async function sendWarning(
  txn: { id: string; brokerage_id: string; agent_id: string },
  milestone: any,
  hoursUntil: number
) {
  const supabase = createServiceClient()
  
  // Check if warning already sent (prevent spam).
  //
  // DOTTED WRITE PATH (CLAUDE.md §1, lane BC 2026-09-08 hunt 1): the transitionLifecycle
  // call just below passes eventType "milestone.warning", and transitionLifecycle
  // (lib/kernel/lifecycle.ts) always writes `event_type = \`lifecycle.${eventType}\`` — so
  // the row this dedupe check needs to find is "lifecycle.milestone.warning", not
  // "transaction.milestone.warning" (a third, unwritten spelling — the writer's own
  // NotificationService.notifyMilestoneWarning uses that string for a DIFFERENT table's
  // eventType field, not this one). This query matched nothing, so the 72-hour dedupe
  // never fired and every hourly cron tick re-sent the same milestone warning.
  const { data: existingWarning } = await supabase
    .from("lifecycle_events")
    .select("id")
    .eq("entity_id", txn.id)
    .eq("event_type", "lifecycle.milestone.warning")
    .eq("metadata->>milestone_name", milestone.milestone_name)
    .gte("created_at", new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
    .maybeSingle()
  
  if (existingWarning) return // Already warned recently
  
  // Log warning event via kernel
  await transitionLifecycle({
    brokerageId: txn.brokerage_id,
    entityType:  "transaction",
    entityId:    txn.id,
    fromState:   "milestone_pending",
    toState:     "milestone_warning",
    actorUserId: "",
    actorRole:   "agent",
    eventType:   "milestone.warning",
    metadata:    { milestone_name: milestone.milestone_name, target_date: milestone.target_date, hours_until: Math.round(hoursUntil) },
  })
  
  // Notify agent + TC
  await notificationService.notifyMilestoneWarning({
    transactionId: txn.id,
    brokerageId: txn.brokerage_id,
    agentId: txn.agent_id,
    milestoneName: milestone.milestone_name,
    propertyAddress: txn.id,
    dueDate: milestone.target_date,
    hoursUntilDue: Math.round(hoursUntil),
  })
}
