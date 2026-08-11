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
import { runDealAutopsy } from "@/lib/kernel/deal-autopsy"
import { resolveMilestoneIdentity } from "./milestone-identity"
import {
  readHazardInsurance,
  hazardSeverity,
  hazardReminderHeadline,
  HAZARD_EVIDENCE_LEAD_DAYS,
  type HazardServiceRow,
  selectHazardService,
} from "./hazard-insurance"

type Severity = "low" | "medium" | "high" | "urgent"
type Recipient = "buyer" | "seller" | "lender" | "inspector" | "title" | "escrow" | "co_agent" | "agent"

/** Which oversight manager a high-severity pending action escalates to (null = TC keeps it in the
 *  closing-concierge UI). Lender items are Finance's; title/escrow/inspection deadline items are
 *  Compliance's; buyer/seller/agent/co_agent items stay with the Deal Coordinator (the TC). */
export function closingActionManager(recipient: Recipient): "finance_manager" | "compliance_officer" | null {
  if (recipient === "lender") return "finance_manager"
  if (recipient === "title" || recipient === "escrow" || recipient === "inspector") return "compliance_officer"
  return null
}

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
  /** transactions.deal_type — 'buyer' | 'seller' | 'dual' | null on legacy rows. */
  dealType:            string | null
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
    milestone_name:  string | null
    status:          string | null
    completed_at:    string | null
    target_date:     string | null
  }>
  /** transaction_vendor_services rows with service_type='insurance_quote' (m385). */
  insuranceServices: HazardServiceRow[]
  /**
   * FALSE when the insurance read was REFUSED. An empty array and a refused
   * query are indistinguishable in supabase-js (both resolve), and here they
   * mean opposite things: "this buyer has no coverage on file" versus "we could
   * not look". Opening an urgent closing alarm on the second would be a
   * fabricated finding, so the detector abstains instead.
   */
  insuranceEvidenceAvailable: boolean
}

// Match a milestone by its CANONICAL identity (milestone_type for catalog/journey
// rows, milestone_name for legacy snake_case rows) so detections fire regardless of
// which route created the milestone.
const isMilestone = (m: { milestone_type: string | null; milestone_name: string | null }, id: string): boolean =>
  resolveMilestoneIdentity(m) === id

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
  const insMile = ev.milestones.find((m) => isMilestone(m, "inspection_deadline"))
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
  const walkthrough = ev.milestones.find((m) => isMilestone(m, "final_walkthrough_scheduled"))
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
  const cda = ev.milestones.find((m) => isMilestone(m, "cda_delivered"))
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

/**
 * HAZARD / HOMEOWNER'S INSURANCE NOT BOUND (m385).
 *
 * The lead-time reminder the owner asked for, riding the closing-prerequisite
 * engine that already exists rather than a second one beside it. A lender wants
 * evidence of coverage roughly 7-10 days before funding, so this opens at
 * HAZARD_EVIDENCE_LEAD_DAYS (10) and escalates inside 7.
 *
 * BUYER SIDE ONLY, decided from two independent signals so a NULL deal_type on a
 * legacy row cannot silently mute it AND a seller-side deal cannot silently
 * acquire it:
 *   · transactions.deal_type is 'buyer' or 'dual' (we represent the buyer), OR
 *   · the deal carries the hazard_insurance_bound milestone, which only the
 *     BUYER journey seeds (lib/transactions/milestone-catalog.ts).
 * Neither present → the detector stays silent. That is honest: on a seller-side
 * deal the buyer's coverage is not ours to chase.
 *
 * The verdict itself comes from the shared pure evaluator, so what the cron acts
 * on and what the agent's panel renders can never disagree.
 */
function detectHazardInsuranceUnbound(ctx: TransactionContext, ev: TransactionEvidence): DetectedAction | null {
  // Never raise an alarm off a read we could not perform.
  if (!ev.insuranceEvidenceAvailable) return null
  if (!ctx.closeDate) return null
  const daysToClose = daysBetween(today(), ctx.closeDate)
  if (daysToClose > HAZARD_EVIDENCE_LEAD_DAYS || daysToClose < 0) return null

  const milestone = ev.milestones.find((m) => isMilestone(m, "hazard_insurance_bound"))
  const buyerSide =
    ctx.dealType === "buyer" || ctx.dealType === "dual" || milestone != null
  if (!buyerSide) return null

  // An explicitly completed milestone is the agent asserting the step is done.
  // Honour it — the panel is where the evidence gets argued, not the cron.
  if (milestone?.status === "completed" || milestone?.completed_at) return null

  const status = readHazardInsurance({
    // ONE SELECTOR. Taking [0] meant the closing engine and the agent's hazard
    // panel could name DIFFERENT engagements off the same list — the panel uses
    // selectHazardService (which prefers a real, non-cancelled engagement),
    // whereas [0] is whatever the query happened to return first. Two surfaces
    // disagreeing about which policy is the deal's is worse than either being
    // wrong, because each looks authoritative on its own screen.
    service: selectHazardService(ev.insuranceServices),
    closeDate: ctx.closeDate,
    now: new Date(),
  })
  if (!status.blocksClosing) return null

  return {
    actionType:         "hazard_insurance_unbound",
    severity:           hazardSeverity(status),
    dueDate:            status.evidenceDueDate ?? ctx.closeDate,
    headline:           hazardReminderHeadline(status),
    detail:
      `${status.detail} The lender needs the binder or declarations page on file by ` +
      `${status.evidenceDueDate ?? "the lead-time date"} to fund on ${ctx.closeDate}. ` +
      `Recommend an insurance vendor from the brokerage marketplace on the transaction's Hazard Insurance panel.`,
    suggestedRecipient: "buyer",
    bucketKey:          `hazard_insurance:${ctx.closeDate}`,
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
  detectHazardInsuranceUnbound,
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
    .select("id, brokerage_id, agent_id, contract_date, close_date, property_address, deal_type")
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
    const [inspectionsRes, lenderRes, titleRes, milestonesRes, insuranceRes] = await Promise.all([
      svc.from("transaction_inspections").select("inspection_type, status, scheduled_date, completed_date").eq("transaction_id", t.id),
      svc.from("transaction_lenders").select("appraisal_ordered_date, appraisal_completed_date, clear_to_close_date, underwriting_status").eq("transaction_id", t.id).maybeSingle(),
      svc.from("transaction_title_escrow").select("earnest_money_received_date, title_commitment_date, closing_scheduled_date").eq("transaction_id", t.id).maybeSingle(),
      svc.from("transaction_milestones").select("milestone_type, milestone_name, status, completed_at, target_date").eq("transaction_id", t.id),
      // m385 — the deal's hazard-insurance engagement(s). Tenant-scoped on top of
      // the transaction id: transaction_vendor_services carries its own
      // brokerage_id and this sweep runs with the service client.
      svc.from("transaction_vendor_services")
        .select("id, service_type, status, vendor_name, vendor_id, quote_amount, cost, policy")
        .eq("transaction_id", t.id)
        .eq("brokerage_id", t.brokerage_id)
        .eq("service_type", "insurance_quote")
        .order("created_at", { ascending: false }),
    ])
    // A REFUSED read RESOLVES with data:null, which is indistinguishable from an
    // empty result — and here those mean opposite things. Destructure the error
    // and carry "we could not look" as its own fact rather than letting it read
    // as "this buyer has no coverage".
    if (insuranceRes.error) {
      console.error(`[closing-orchestration] insurance evidence read failed for ${t.id}:`, insuranceRes.error.message)
    }
    const evidence: TransactionEvidence = {
      inspections: inspectionsRes.data ?? [],
      lender:      lenderRes.data ?? null,
      titleEscrow: titleRes.data ?? null,
      milestones:  milestonesRes.data ?? [],
      insuranceServices: ((insuranceRes.data ?? []) as unknown as HazardServiceRow[]),
      insuranceEvidenceAvailable: !insuranceRes.error,
    }

    // Derive earnest-money due date from milestones; column doesn't exist on
    // transactions directly.
    const emMile = evidence.milestones.find(
      (m) => isMilestone(m, "earnest_money_due")
    )
    const ctx: TransactionContext = {
      id:                t.id,
      brokerageId:       t.brokerage_id,
      agentId:           t.agent_id,
      contractDate:      t.contract_date,
      closeDate:         t.close_date,
      propertyAddress:   t.property_address,
      earnestMoneyDueAt: emMile?.target_date ?? null,
      dealType:          t.deal_type ?? null,
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
      if (!error) {
        opened++
        // MULTI-MANAGER ESCALATION — an URGENT/HIGH pending action whose owner is the lender
        // (financing) or a deadline-bearing vendor (title/escrow/inspection) is NOT just a TC
        // dashboard item: it goes on the bus so Finance / Compliance act proactively. The Deal
        // Coordinator's own buyer/seller/agent items stay in the closing-concierge UI.
        const manager = closingActionManager(d.suggestedRecipient)
        if (manager && (d.severity === "high" || d.severity === "urgent")) {
          try {
            const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
            await publishManagerSignal({
              brokerageId: ctx.brokerageId, fromManager: "deal_coordinator", toManager: manager,
              signalType: "transaction_action_pending", message: d.headline,
              entityType: "transaction", entityId: ctx.id,
              payload: { actionType: d.actionType, severity: d.severity, recipient: d.suggestedRecipient, headline: d.headline, detail: d.detail },
            }, svc)
          } catch { /* best-effort — the dashboard item already landed */ }
        }
      }
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

// ────────────────────────────────────────────────────────────────────────────
// Deal-Autopsy trigger — fires when a transaction transitions to terminal failure
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run deal autopsies for recently-lost transactions (status='lost') that have
 * not yet been autopsied. This is the TRIGGER SEAM: wired here so the deal-
 * autopsy runs as part of the same closing-orchestration cron pass that owns
 * the full transaction lifecycle. Additive — does NOT modify runClosingOrchestration.
 *
 * Idempotency is owned by runDealAutopsy itself (unique index on transaction_id
 * in deal_autopsy_observations). Re-running this for the same lost transaction
 * is a cheap no-op.
 */
export async function runLostTransactionAutopsies(opts?: { limit?: number; sinceHours?: number }): Promise<{
  scanned:   number
  autopsied: number
  skipped:   number
  errors:    string[]
}> {
  const svc = createServiceClient()
  const limit = opts?.limit ?? 50
  // Default look-back: transactions that went lost in the last 72 hours (catches
  // both the immediate transition and any missed cron windows). Pass sinceHours=0
  // to scan ALL lost transactions (useful for backfill / simulator cleanup).
  const since = opts?.sinceHours != null && opts.sinceHours === 0
    ? null
    : new Date(Date.now() - (opts?.sinceHours ?? 72) * 3_600_000).toISOString()

  // tenant anchor (scope burn-down): platform sweep carries each row's
  // brokerage — rows without a tenant are excluded from processing.
  let q = svc
    .from("transactions")
    .select("id, brokerage_id")
    .not("brokerage_id", "is", null)
    .eq("status", "lost")
    .order("updated_at", { ascending: false })
    .limit(limit)
  if (since) q = q.gte("updated_at", since)

  const { data: lostTxns } = await q
  if (!lostTxns || lostTxns.length === 0) return { scanned: 0, autopsied: 0, skipped: 0, errors: [] }

  let autopsied = 0
  let skipped   = 0
  const errors: string[] = []

  for (const t of lostTxns as Array<{ id: string }>) {
    try {
      const result = await runDealAutopsy(t.id, svc)
      if (result.error) {
        skipped += 1
        errors.push(`${t.id}: ${result.error}`)
      } else if (result.idempotent) {
        skipped += 1
      } else {
        autopsied += 1
      }
    } catch (e: any) {
      skipped += 1
      errors.push(`${t.id}: ${e?.message ?? String(e)}`)
    }
  }

  return { scanned: lostTxns.length, autopsied, skipped, errors }
}
