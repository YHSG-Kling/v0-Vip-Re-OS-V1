/**
 * lib/transactions/closing-orchestration.ts
 *
 * The cron that turns "tracked milestones" into "do this today."
 *
 * For every active transaction, evaluates a fixed library of orchestration
 * detectors. Each detector either produces a typed action row (open) or
 * doesn't — the engine is purely declarative and idempotent.
 *
 * Detectors implemented:
 *   appraisal_not_ordered      day 5+ post-contract, appraisal_ordered_date NULL
 *   inspection_window_closing  inspection_deadline within 3 days, no inspections scheduled
 *   inspection_overdue         inspection_deadline passed, no completed inspections
 *   em_not_received            earnest_money_due_at passed, EM not received
 *   clear_to_close_late        close_date ≤ 10 days, lender not clear_to_close
 *   walkthrough_unscheduled    close_date ≤ 5 days, no walkthrough milestone completed
 *   wire_instructions_missing  close_date ≤ 5 days, title row exists but no wire_instructions
 *   cda_missing                close_date ≤ 7 days, no CDA milestone completed
 *   title_commitment_late      day 14+ post-contract, no title_commitment_date
 *
 * Idempotency: (transaction_id, action_type, bucket_key) unique among open
 * rows. The engine never duplicates. When a detected condition disappears
 * (agent ordered the appraisal), the previously-open row is auto-superseded
 * so the agent's dashboard cleans itself up.
 */

import { createServiceClient } from "@/lib/supabase/service"

type Severity = "low" | "medium" | "high" | "urgent"
type Recipient = "buyer" | "seller" | "lender" | "inspector" | "title" | "escrow" | "co_agent" | "agent"

interface DetectedAction {
  actionType:         string
  severity:           Severity
  dueDate:            string | null
  headline:           string
  detail:             string
  suggestedRecipient: Recipient
  bucketKey:          string
}

interface TransactionContext {
  id:                  string
  brokerageId:         string
  agentId:             string | null
  contractDate:        string | null
  closeDate:           string | null
  propertyAddress:     string | null
  /** Resolved from transaction_milestones where milestone_type='earnest_money_due' */
  earnestMoneyDueAt:   string | null
}

interface TransactionEvidence {
  inspections: Array<{
    inspection_type: string | null
    status:          string | null
    scheduled_date:  string | null
    completed_date:  string | null
  }>
  lender: {
    appraisal_ordered_date:   string | null
    appraisal_completed_date: string | null
    clear_to_close_date:      string | null
    underwriting_status:      string | null
  } | null
  titleEscrow: {
    earnest_money_received_date:  string | null
    title_commitment_date:        string | null
    closing_scheduled_date:       string | null
  } | null
  milestones: Array<{
    milestone_type:  string | null
    status:          string | null
    completed_at:    string | null
    target_date:     string | null
  }>
}

const today = () => new Date().toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) =>
  Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)

// ────────────────────────────────────────────────────────────────────────────
// Detectors — pure functions over (ctx, evidence) → DetectedAction | null
// ────────────────────────────────────────────────────────────────────────────

function detectAppraisalNotOrdered(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  if (!ctx.contractDate) return null
  const days = daysBetween(ctx.contractDate, today())
  if (days < 5) return null
  if (ev.lender?.appraisal_ordered_date) return null
  if (!ev.lender) return null  // no lender on file yet — different detector
  return {
    actionType:         "appraisal_not_ordered",
    severity:           days > 10 ? "urgent" : "high",
    dueDate:            null,
    headline:           `Appraisal not ordered yet — day ${days} post-contract`,
    detail:             `Lender hasn't recorded an appraisal-ordered date. Most loans need the appraisal moving by day 7 to close on time. Ping the lender now.`,
    suggestedRecipient: "lender",
    bucketKey:          "appraisal",
  }
}

function detectInspectionWindow(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  const insMile = ev.milestones.find((m) => m.milestone_type === "inspection_deadline" || m.milestone_type === "inspection")
  const deadline = insMile?.target_date
  if (!deadline) return null
  const daysToDeadline = daysBetween(today(), deadline)
  const completed = ev.inspections.filter((i) => i.completed_date != null).length
  const scheduled = ev.inspections.filter((i) => i.scheduled_date != null && !i.completed_date).length

  if (daysToDeadline < 0 && completed === 0) {
    return {
      actionType:         "inspection_overdue",
      severity:           "urgent",
      dueDate:            deadline,
      headline:           `Inspection deadline passed — ${Math.abs(daysToDeadline)} days late`,
      detail:             `Inspection window closed ${Math.abs(daysToDeadline)} days ago and no inspections were marked complete. Buyer may have lost the right to object or terminate.`,
      suggestedRecipient: "buyer",
      bucketKey:          `deadline:${deadline}`,
    }
  }
  if (daysToDeadline >= 0 && daysToDeadline <= 3 && scheduled === 0 && completed === 0) {
    return {
      actionType:         "inspection_window_closing",
      severity:           daysToDeadline <= 1 ? "urgent" : "high",
      dueDate:            deadline,
      headline:           `Inspection window closes in ${daysToDeadline} day${daysToDeadline === 1 ? "" : "s"} — nothing scheduled`,
      detail:             `Buyer hasn't scheduled any inspections and the deadline is ${daysToDeadline === 0 ? "today" : `${daysToDeadline} day${daysToDeadline === 1 ? "" : "s"} out`}. Get something on the calendar today.`,
      suggestedRecipient: "buyer",
      bucketKey:          `deadline:${deadline}`,
    }
  }
  return null
}

function detectEarnestMoneyMissing(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  if (!ctx.earnestMoneyDueAt) return null
  if (ev.titleEscrow?.earnest_money_received_date) return null
  const overdue = daysBetween(ctx.earnestMoneyDueAt.slice(0, 10), today())
  if (overdue < 0) return null  // not yet due
  return {
    actionType:         "em_not_received",
    severity:           overdue >= 2 ? "urgent" : "high",
    dueDate:            ctx.earnestMoneyDueAt.slice(0, 10),
    headline:           `Earnest money ${overdue === 0 ? "due today" : `${overdue} day${overdue === 1 ? "" : "s"} overdue`}`,
    detail:             `Title/escrow hasn't recorded an earnest-money-received date. Contract is breachable without EM in place. Confirm wire + remit by today.`,
    suggestedRecipient: "buyer",
    bucketKey:          `em:${ctx.earnestMoneyDueAt.slice(0, 10)}`,
  }
}

function detectClearToCloseLate(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  if (!ctx.closeDate || !ev.lender) return null
  const daysToClose = daysBetween(today(), ctx.closeDate)
  if (daysToClose > 10 || daysToClose < 0) return null
  if (ev.lender.clear_to_close_date) return null
  if (ev.lender.underwriting_status === "clear_to_close" || ev.lender.underwriting_status === "funded") return null
  return {
    actionType:         "clear_to_close_late",
    severity:           daysToClose <= 5 ? "urgent" : "high",
    dueDate:            ctx.closeDate,
    headline:           `${daysToClose} day${daysToClose === 1 ? "" : "s"} to close, not yet clear to close`,
    detail:             `Lender status is "${ev.lender.underwriting_status ?? "unknown"}". Push for clear-to-close — every day without it risks a close-date slip.`,
    suggestedRecipient: "lender",
    bucketKey:          `ctc:${ctx.closeDate}`,
  }
}

function detectWalkthroughUnscheduled(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  if (!ctx.closeDate) return null
  const daysToClose = daysBetween(today(), ctx.closeDate)
  if (daysToClose > 5 || daysToClose < 0) return null
  const walkthrough = ev.milestones.find((m) => m.milestone_type === "final_walkthrough_scheduled" || m.milestone_type === "final_walkthrough")
  if (walkthrough?.status === "completed" || walkthrough?.completed_at) return null
  return {
    actionType:         "walkthrough_unscheduled",
    severity:           daysToClose <= 2 ? "urgent" : "medium",
    dueDate:            ctx.closeDate,
    headline:           `Final walkthrough not yet scheduled — ${daysToClose} days to close`,
    detail:             `Buyer should walk the property within 24-48 hours of closing. Coordinate with seller's agent and put it on the calendar.`,
    suggestedRecipient: "co_agent",
    bucketKey:          `walkthrough:${ctx.closeDate}`,
  }
}

function detectWireInstructionsMissing(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  if (!ctx.closeDate || !ev.titleEscrow) return null
  const daysToClose = daysBetween(today(), ctx.closeDate)
  if (daysToClose > 5 || daysToClose < 0) return null
  // Title escrow row exists but wire-instructions milestone hasn't fired —
  // best proxy we have today is whether closing is scheduled.
  if (ev.titleEscrow.closing_scheduled_date) return null
  return {
    actionType:         "wire_instructions_missing",
    severity:           "high",
    dueDate:            ctx.closeDate,
    headline:           `Wire instructions / closing logistics not finalised — ${daysToClose} days out`,
    detail:             `Title hasn't confirmed a scheduled closing time + wire instructions. Buyer needs these to fund. Chase title now.`,
    suggestedRecipient: "title",
    bucketKey:          `wire:${ctx.closeDate}`,
  }
}

function detectCDAMissing(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  if (!ctx.closeDate) return null
  const daysToClose = daysBetween(today(), ctx.closeDate)
  if (daysToClose > 7 || daysToClose < 0) return null
  const cda = ev.milestones.find((m) => m.milestone_type === "cda_delivered" || m.milestone_type === "cda")
  if (cda?.status === "completed" || cda?.completed_at) return null
  return {
    actionType:         "cda_missing",
    severity:           daysToClose <= 3 ? "urgent" : "high",
    dueDate:            ctx.closeDate,
    headline:           `Commission Disbursement Authorization not delivered — ${daysToClose} days to close`,
    detail:             `Without the CDA at the title/escrow company, the brokerage doesn't get paid on funding day. Send the CDA today.`,
    suggestedRecipient: "title",
    bucketKey:          `cda:${ctx.closeDate}`,
  }
}

function detectTitleCommitmentLate(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  if (!ctx.contractDate) return null
  const days = daysBetween(ctx.contractDate, today())
  if (days < 14) return null
  if (ev.titleEscrow?.title_commitment_date) return null
  return {
    actionType:         "title_commitment_late",
    severity:           days > 21 ? "urgent" : "high",
    dueDate:            null,
    headline:           `Title commitment not received — day ${days} post-contract`,
    detail:             `Most title companies deliver the commitment within 10-14 days. ${days} days in and nothing on file. Chase the title officer.`,
    suggestedRecipient: "title",
    bucketKey:          "title_commitment",
  }
}

const DETECTORS: Array<(c: TransactionContext, e: TransactionEvidence) => DetectedAction | null> = [
  detectAppraisalNotOrdered,
  detectInspectionWindow,
  detectEarnestMoneyMissing,
  detectClearToCloseLate,
  detectWalkthroughUnscheduled,
  detectWireInstructionsMissing,
  detectCDAMissing,
  detectTitleCommitmentLate,
]

// ────────────────────────────────────────────────────────────────────────────
// Runner — invoked by the cron
// ────────────────────────────────────────────────────────────────────────────

export async function runClosingOrchestration(opts?: { limit?: number }): Promise<{
  scanned: number
  opened:  number
  superseded: number
}> {
  const svc = createServiceClient()
  const limit = opts?.limit ?? 100

  // Active transactions only — anything between accepted offer and closed.
  // Status values vary across brokerages; we exclude only terminal states.
  // earnest_money_due_at lives on transaction_milestones (not on transactions
  // itself) — we resolve it per-transaction from the milestones evidence pull.
  const { data: txns } = await svc
    .from("transactions")
    .select("id, brokerage_id, agent_id, contract_date, close_date, property_address")
    .not("status", "in", "(closed,cancelled,terminated)")
    .not("contract_date", "is", null)
    .order("close_date", { ascending: true, nullsFirst: false })
    .limit(limit)

  if (!txns || txns.length === 0) {
    return { scanned: 0, opened: 0, superseded: 0 }
  }

  let opened = 0
  let superseded = 0

  for (const t of txns as any[]) {
    // Pull evidence in parallel
    const [inspectionsRes, lenderRes, titleRes, milestonesRes] = await Promise.all([
      svc.from("transaction_inspections").select("inspection_type, status, scheduled_date, completed_date").eq("transaction_id", t.id),
      svc.from("transaction_lenders").select("appraisal_ordered_date, appraisal_completed_date, clear_to_close_date, underwriting_status").eq("transaction_id", t.id).maybeSingle(),
      svc.from("transaction_title_escrow").select("earnest_money_received_date, title_commitment_date, closing_scheduled_date").eq("transaction_id", t.id).maybeSingle(),
      svc.from("transaction_milestones").select("milestone_type, status, completed_at, target_date").eq("transaction_id", t.id),
    ])
    const evidence: TransactionEvidence = {
      inspections: inspectionsRes.data ?? [],
      lender:      lenderRes.data ?? null,
      titleEscrow: titleRes.data ?? null,
      milestones:  milestonesRes.data ?? [],
    }

    // Derive earnest-money due date from milestones; column doesn't exist on
    // transactions directly.
    const emMile = evidence.milestones.find(
      (m) => m.milestone_type === "earnest_money_due" || m.milestone_type === "em_due"
    )
    const ctx: TransactionContext = {
      id:                t.id,
      brokerageId:       t.brokerage_id,
      agentId:           t.agent_id,
      contractDate:      t.contract_date,
      closeDate:         t.close_date,
      propertyAddress:   t.property_address,
      earnestMoneyDueAt: emMile?.target_date ?? null,
    }

    // Run all detectors
    const detected: DetectedAction[] = []
    for (const d of DETECTORS) {
      const result = d(ctx, evidence)
      if (result) detected.push(result)
    }

    // Load currently-open rows for this transaction
    const { data: openRows } = await svc
      .from("transaction_pending_actions")
      .select("id, action_type, bucket_key")
      .eq("transaction_id", t.id)
      .eq("status", "open")
    const openSet = new Set((openRows ?? []).map((r: any) => `${r.action_type}:${r.bucket_key}`))
    const detectedSet = new Set(detected.map((d) => `${d.actionType}:${d.bucketKey}`))

    // Insert any new detections (idempotency unique index also guards)
    for (const d of detected) {
      const key = `${d.actionType}:${d.bucketKey}`
      if (openSet.has(key)) continue
      const { error } = await svc.from("transaction_pending_actions").insert({
        brokerage_id:        ctx.brokerageId,
        transaction_id:      ctx.id,
        agent_id:            ctx.agentId,
        action_type:         d.actionType,
        severity:            d.severity,
        due_date:            d.dueDate,
        headline:            d.headline,
        detail:              d.detail,
        suggested_recipient: d.suggestedRecipient,
        bucket_key:          d.bucketKey,
        status:              "open",
      })
      if (!error) opened++
    }

    // Supersede rows whose condition has cleared (e.g., appraisal ordered)
    for (const r of (openRows ?? []) as any[]) {
      const key = `${r.action_type}:${r.bucket_key}`
      if (detectedSet.has(key)) continue
      const { error } = await svc
        .from("transaction_pending_actions")
        .update({ status: "superseded", resolved_at: new Date().toISOString() })
        .eq("id", r.id)
        .eq("status", "open")
      if (!error) superseded++
    }
  }

  return { scanned: txns.length, opened, superseded }
}
