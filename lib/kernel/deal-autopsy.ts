// lib/kernel/deal-autopsy.ts
//
// DEAL-AUTOPSY LEARNING — post-mortem for fallen-through deals.
//
// When a transaction reaches the terminal failure state (status='lost'), the
// autopsy:
//   1. Loads the real transaction record + its evidence (lender, inspections,
//      title/escrow, milestones, timeline).
//   2. Classifies the failure reason from REAL column values — NEVER fabricated.
//      Reason enum: financing / inspection / appraisal / cold_feet / title /
//      low_appraisal / competing_offer / other.
//   3. Persists the autopsy to deal_autopsy_observations (idempotent per transaction).
//   4. FEEDS the coaching loop: proposes a gated, manager-facing coaching brief
//      (proposeClientMessage, audience 'agent', agentKind 'recruiting_manager')
//      so the Deal Coordinator's failure pattern reaches the coaching inbox.
//      This is the SAME seam used by runAgentCoaching — no edit to agent-coaching.ts.
//   5. Publishes a deal_coordinator → recruiting_manager manager signal on the
//      existing inter-manager bus (publishManagerSignal) so the Recruiting Manager
//      can consume + act on the coaching prompt through SIGNAL_HANDLERS.
//
// OWNER: deal_coordinator (post-acceptance deal execution through closing/failure).
// SIGNAL: deal_coordinator → recruiting_manager:deal_autopsy_completed.
//
// Pure + testable: classifyFailureReason is a pure function over real facts.
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

type Svc = ReturnType<typeof createServiceClient>

// ── Failure reason taxonomy ───────────────────────────────────────────────────

export type FailureReason =
  | "financing"       // lender/financing contingency failed or was never removed
  | "inspection"      // inspection issues not resolved / contingency live at termination
  | "appraisal"       // appraisal completed but value came in below purchase price
  | "cold_feet"       // no contingency evidence; buyer/seller withdrew late
  | "title"           // title issues present in title_escrow record
  | "low_appraisal"   // explicit low-appraisal variant: price gap > LOW_APPRAISAL_GAP_PCT
  | "competing_offer" // lost_category / lost_reason explicitly names competition
  | "other"           // evidence insufficient to classify; recorded honestly

// Confidence bands: hard-evidence reasons get high; suggestive medium; catch-all low.
export const CONFIDENCE_HIGH   = 0.90
export const CONFIDENCE_MEDIUM = 0.65
export const CONFIDENCE_LOW    = 0.40

// A deal's appraisal is "low" when the gap is >= this fraction of purchase price.
export const LOW_APPRAISAL_GAP_PCT = 0.02  // 2 % — a material gap on any deal size

// Keywords in lost_category / lost_reason that signal a competing-offer failure.
const COMPETING_OFFER_KEYWORDS = ["compet", "other offer", "higher offer", "multiple offer", "bidding"]

// ── The facts the classifier operates on ─────────────────────────────────────

/** REAL transaction facts loaded from the live schema. Every field is nullable —
 *  a missing value is honest, never zero-faked. */
export interface TxnFacts {
  // From transactions row
  status:                             string
  stage:                              string | null
  purchasePrice:                      number | null
  contractDate:                       string | null
  closeDate:                          string | null
  lostAt:                             string | null
  lostCategory:                       string | null
  lostReason:                         string | null
  inspectionDeadline:                 string | null
  appraisalDeadline:                  string | null
  financingDeadline:                  string | null
  inspectionContingencyRemovedAt:     string | null
  appraisalContingencyRemovedAt:      string | null
  financingContingencyRemovedAt:      string | null
  appraisalValue:                     number | null
  dealType:                           string | null
  // From transaction_lenders (first row, if any)
  lenderUnderwritingStatus:           string | null
  lenderClearToCloseDate:             string | null
  lenderAppraisalValue:               number | null
  // From transaction_inspections (any row)
  inspectionIssuesFound:              string | null  // non-null when any inspection found issues
  inspectionStatus:                   string | null  // status of the most-relevant inspection
  // From transaction_title_escrow
  titleIssues:                        string | null
  // From transaction_timeline (last N entries)
  lastTimelineActivities:             string[]
}

/** Classifier output — pure, no side-effects. */
export interface AutopsyClassification {
  reason:     FailureReason
  confidence: number
  evidence:   string[]
}

// ── Pure classifier ───────────────────────────────────────────────────────────

/**
 * PURE + deterministic. Classify the failure reason from REAL transaction facts.
 *
 * Priority ladder (most specific wins):
 *   1. competing_offer  — explicit in lost_category/lost_reason
 *   2. low_appraisal    — appraisal completed, value materially below purchase price
 *   3. appraisal        — appraisal contingency live at termination (never removed)
 *   4. financing        — financing contingency live OR lender status declined/withdrawn
 *   5. inspection       — inspection contingency live OR inspection issues flagged
 *   6. title            — title issues present
 *   7. cold_feet        — no contingency signals; everything else ruled out
 *   8. other            — honest fallback when evidence is too thin to classify
 */
export function classifyFailureReason(facts: TxnFacts): AutopsyClassification {
  const evidence: string[] = []

  // ── 1. competing_offer — explicit human notes ──
  const lostText = `${facts.lostCategory ?? ""} ${facts.lostReason ?? ""}`.toLowerCase()
  if (COMPETING_OFFER_KEYWORDS.some((kw) => lostText.includes(kw))) {
    evidence.push(`lost_category="${facts.lostCategory}"`, `lost_reason="${facts.lostReason}"`)
    return { reason: "competing_offer", confidence: CONFIDENCE_HIGH, evidence }
  }

  // ── 2. low_appraisal — completed appraisal materially below purchase price ──
  const purchasePrice = facts.purchasePrice ?? null
  // Prefer lender-side appraisal value; fall back to transaction-level column.
  const appraisalVal = facts.lenderAppraisalValue ?? facts.appraisalValue ?? null
  if (purchasePrice && appraisalVal && purchasePrice > 0) {
    const gap = (purchasePrice - appraisalVal) / purchasePrice
    if (gap >= LOW_APPRAISAL_GAP_PCT) {
      evidence.push(
        `purchase_price=${purchasePrice}`,
        `appraisal_value=${appraisalVal}`,
        `gap=${(gap * 100).toFixed(1)}% (>= ${(LOW_APPRAISAL_GAP_PCT * 100).toFixed(0)}% threshold)`,
      )
      return { reason: "low_appraisal", confidence: CONFIDENCE_HIGH, evidence }
    }
  }

  // ── 3. appraisal — contingency was never removed ──
  if (facts.appraisalDeadline && !facts.appraisalContingencyRemovedAt) {
    evidence.push(
      `appraisal_deadline=${facts.appraisalDeadline}`,
      "appraisal_contingency_removed_at IS NULL (never removed)",
    )
    if (facts.lenderAppraisalValue || facts.appraisalValue) {
      evidence.push(`appraisal_value=${facts.lenderAppraisalValue ?? facts.appraisalValue}`)
    }
    return { reason: "appraisal", confidence: CONFIDENCE_MEDIUM, evidence }
  }

  // ── 4. financing — contingency live OR lender declined/withdrawn ──
  const declinedStatuses = ["declined", "denied", "withdrawn", "cancelled", "suspended"]
  const lenderFailed = facts.lenderUnderwritingStatus
    ? declinedStatuses.some((s) => (facts.lenderUnderwritingStatus ?? "").toLowerCase().includes(s))
    : false
  const financingContingencyLive = !!facts.financingDeadline && !facts.financingContingencyRemovedAt
  if (lenderFailed || financingContingencyLive) {
    if (lenderFailed) {
      evidence.push(`lender.underwriting_status="${facts.lenderUnderwritingStatus}"`)
    }
    if (financingContingencyLive) {
      evidence.push(
        `financing_deadline=${facts.financingDeadline}`,
        "financing_contingency_removed_at IS NULL (never removed)",
      )
    }
    if (!facts.lenderClearToCloseDate) evidence.push("lender.clear_to_close_date IS NULL")
    return { reason: "financing", confidence: lenderFailed ? CONFIDENCE_HIGH : CONFIDENCE_MEDIUM, evidence }
  }

  // ── 5. inspection — contingency live OR issues flagged ──
  const inspectionContingencyLive = !!facts.inspectionDeadline && !facts.inspectionContingencyRemovedAt
  const inspectionIssues = facts.inspectionIssuesFound && facts.inspectionIssuesFound.trim().length > 0
  if (inspectionContingencyLive || inspectionIssues) {
    if (inspectionContingencyLive) {
      evidence.push(
        `inspection_deadline=${facts.inspectionDeadline}`,
        "inspection_contingency_removed_at IS NULL (never removed)",
      )
    }
    if (inspectionIssues) {
      evidence.push(`inspection.issues_found present (${facts.inspectionStatus ?? "unknown status"})`)
    }
    return {
      reason: "inspection",
      confidence: (inspectionContingencyLive && inspectionIssues) ? CONFIDENCE_HIGH : CONFIDENCE_MEDIUM,
      evidence,
    }
  }

  // ── 6. title — title issues present ──
  if (facts.titleIssues && facts.titleIssues.trim().length > 0) {
    evidence.push(`title_escrow.title_issues="${facts.titleIssues.slice(0, 120)}"`)
    return { reason: "title", confidence: CONFIDENCE_MEDIUM, evidence }
  }

  // ── 7. cold_feet — no contingency signals; all ruled out ──
  // Criteria: had a contract date (it was under contract), all contingencies were
  // either removed or had no deadline set, no external failure evidence — the deal
  // fell through from buyer/seller cold feet or undocumented reason.
  const hadContract = !!facts.contractDate
  const allContingenciesResolved =
    (!facts.financingDeadline || !!facts.financingContingencyRemovedAt) &&
    (!facts.inspectionDeadline || !!facts.inspectionContingencyRemovedAt) &&
    (!facts.appraisalDeadline  || !!facts.appraisalContingencyRemovedAt)
  if (hadContract && allContingenciesResolved) {
    evidence.push(
      "contract_date present (deal was under contract)",
      "all contingencies resolved or not applicable",
      "no financing/inspection/appraisal/title failure evidence found",
    )
    return { reason: "cold_feet", confidence: CONFIDENCE_MEDIUM, evidence }
  }

  // ── 8. other — honest fallback ──
  evidence.push("insufficient evidence to classify; no dominant failure signal found")
  return { reason: "other", confidence: CONFIDENCE_LOW, evidence }
}

// ── Database loaders ──────────────────────────────────────────────────────────

interface TxnRow {
  id: string
  brokerage_id: string
  status: string
  stage: string | null
  purchase_price: number | null
  contract_date: string | null
  close_date: string | null
  lost_at: string | null
  lost_category: string | null
  lost_reason: string | null
  inspection_deadline: string | null
  appraisal_deadline: string | null
  financing_deadline: string | null
  inspection_contingency_removed_at: string | null
  appraisal_contingency_removed_at: string | null
  financing_contingency_removed_at: string | null
  appraisal_value: number | null
  deal_type: string | null
  agent_id: string | null
  contact_id: string | null
}

async function loadTxnFacts(transactionId: string, svc: Svc): Promise<{ row: TxnRow; facts: TxnFacts } | null> {
  // Core transaction row
  const { data: txn } = await svc
    .from("transactions")
    .select(
      "id, brokerage_id, status, stage, purchase_price, contract_date, close_date, lost_at, " +
      "lost_category, lost_reason, inspection_deadline, appraisal_deadline, financing_deadline, " +
      "inspection_contingency_removed_at, appraisal_contingency_removed_at, financing_contingency_removed_at, " +
      "appraisal_value, deal_type, agent_id, contact_id"
    )
    .eq("id", transactionId)
    .maybeSingle()
  if (!txn) return null
  const t = txn as unknown as TxnRow

  // Evidence in parallel
  const [lenderRes, insRes, titleRes, timelineRes] = await Promise.all([
    svc.from("transaction_lenders")
      .select("underwriting_status, clear_to_close_date, appraisal_value")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc.from("transaction_inspections")
      .select("issues_found, status")
      .eq("transaction_id", transactionId)
      .not("issues_found", "is", null)
      .limit(5),
    svc.from("transaction_title_escrow")
      .select("title_issues")
      .eq("transaction_id", transactionId)
      .maybeSingle(),
    svc.from("transaction_timeline")
      .select("activity_type, description")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: false })
      .limit(10),
  ])

  const lender = lenderRes.data as { underwriting_status: string | null; clear_to_close_date: string | null; appraisal_value: number | null } | null
  const inspections = (insRes.data ?? []) as Array<{ issues_found: string | null; status: string | null }>
  const title = titleRes.data as { title_issues: string | null } | null
  const timeline = (timelineRes.data ?? []) as Array<{ activity_type: string | null; description: string | null }>

  // Pick the inspection with the most notable issues (first non-null issues_found)
  const firstIssue = inspections.find((i) => i.issues_found && i.issues_found.trim().length > 0)

  const facts: TxnFacts = {
    status:                             t.status,
    stage:                              t.stage,
    purchasePrice:                      t.purchase_price,
    contractDate:                       t.contract_date,
    closeDate:                          t.close_date,
    lostAt:                             t.lost_at,
    lostCategory:                       t.lost_category,
    lostReason:                         t.lost_reason,
    inspectionDeadline:                 t.inspection_deadline?.toString() ?? null,
    appraisalDeadline:                  t.appraisal_deadline?.toString() ?? null,
    financingDeadline:                  t.financing_deadline?.toString() ?? null,
    inspectionContingencyRemovedAt:     t.inspection_contingency_removed_at,
    appraisalContingencyRemovedAt:      t.appraisal_contingency_removed_at,
    financingContingencyRemovedAt:      t.financing_contingency_removed_at,
    appraisalValue:                     t.appraisal_value,
    dealType:                           t.deal_type,
    lenderUnderwritingStatus:           lender?.underwriting_status ?? null,
    lenderClearToCloseDate:             lender?.clear_to_close_date ?? null,
    lenderAppraisalValue:               lender?.appraisal_value ?? null,
    inspectionIssuesFound:              firstIssue?.issues_found ?? null,
    inspectionStatus:                   firstIssue?.status ?? null,
    titleIssues:                        title?.title_issues ?? null,
    lastTimelineActivities:             timeline.map((e) => `${e.activity_type ?? ""}:${e.description ?? ""}`),
  }

  return { row: t, facts }
}

// ── Days under contract ───────────────────────────────────────────────────────

function daysUnderContract(row: TxnRow): number | null {
  if (!row.contract_date) return null
  const end = row.lost_at ? new Date(row.lost_at) : new Date()
  const start = new Date(row.contract_date)
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000))
}

// ── The live runner ───────────────────────────────────────────────────────────

export interface DealAutopsyResult {
  transactionId:  string
  autopsyId:      string | null
  reason:         FailureReason
  confidence:     number
  evidence:       string[]
  coachingOk:     boolean
  signalOk:       boolean
  /** true when the autopsy already existed and this was a no-op re-run. */
  idempotent:     boolean
  error:          string | null
}

/**
 * Run the deal autopsy for one transaction.
 *
 * Idempotent per transaction — if an autopsy row already exists, returns it
 * without re-classifying, re-proposing coaching, or re-publishing the signal.
 *
 * Steps:
 *   1. Load REAL transaction facts (never fabricated).
 *   2. Guard: transaction must be in terminal failure state (status='lost').
 *   3. Classify failure reason (pure, deterministic).
 *   4. Persist to deal_autopsy_observations (unique index guards idempotency).
 *   5. Feed coaching: proposeClientMessage (audience='agent', agentKind=
 *      'recruiting_manager') — the SAME coaching seam as runAgentCoaching.
 *      agent-coaching.ts is NOT edited; the coaching brief lands in the same
 *      agent_client_messages inbox the coaching loop already uses.
 *   6. Publish deal_coordinator → recruiting_manager:deal_autopsy_completed signal.
 */
export async function runDealAutopsy(
  transactionId: string,
  client?: Svc,
): Promise<DealAutopsyResult> {
  const svc = client ?? createServiceClient()

  // Idempotency check first (cheap)
  const { data: existing } = await svc
    .from("deal_autopsy_observations")
    .select("id, failure_reason, confidence, evidence, coaching_proposed_at, signal_published_at")
    .eq("transaction_id", transactionId)
    .maybeSingle()
  if (existing) {
    const ex = existing as {
      id: string
      failure_reason: FailureReason
      confidence: number
      evidence: string[]
      coaching_proposed_at: string | null
      signal_published_at: string | null
    }
    return {
      transactionId,
      autopsyId:  ex.id,
      reason:     ex.failure_reason,
      confidence: ex.confidence,
      evidence:   ex.evidence ?? [],
      coachingOk: !!ex.coaching_proposed_at,
      signalOk:   !!ex.signal_published_at,
      idempotent: true,
      error:      null,
    }
  }

  // Load real facts
  const loaded = await loadTxnFacts(transactionId, svc)
  if (!loaded) {
    return { transactionId, autopsyId: null, reason: "other", confidence: 0, evidence: [], coachingOk: false, signalOk: false, idempotent: false, error: "transaction not found" }
  }
  const { row, facts } = loaded

  // Guard: must be terminal failure state
  if (row.status !== "lost") {
    return {
      transactionId, autopsyId: null, reason: "other", confidence: 0, evidence: [],
      coachingOk: false, signalOk: false, idempotent: false,
      error: `transaction status='${row.status}' is not terminal (expected 'lost') — autopsy skipped`,
    }
  }

  // Classify
  const classification = classifyFailureReason(facts)

  // Persist autopsy observation
  const duc = daysUnderContract(row)
  const { data: inserted, error: insertErr } = await svc
    .from("deal_autopsy_observations")
    .insert({
      brokerage_id:         row.brokerage_id,
      transaction_id:       transactionId,
      terminal_status:      row.status,
      failure_reason:       classification.reason,
      confidence:           classification.confidence,
      evidence:             classification.evidence,
      purchase_price:       row.purchase_price ?? null,
      days_under_contract:  duc,
      deal_type:            row.deal_type ?? null,
    })
    .select("id")
    .single()

  if (insertErr || !inserted) {
    return {
      transactionId, autopsyId: null,
      reason: classification.reason, confidence: classification.confidence, evidence: classification.evidence,
      coachingOk: false, signalOk: false, idempotent: false,
      error: insertErr?.message ?? "autopsy insert failed",
    }
  }
  const autopsyId = (inserted as { id: string }).id

  // ── Coaching feed: propose a gated, manager-facing brief ─────────────────
  // This is the SAME seam used by runAgentCoaching in agent-coaching.ts:
  //   proposeClientMessage(audience='agent', agentKind='recruiting_manager')
  // No edit to agent-coaching.ts; the brief lands in the same inbox.
  let coachingOk = false
  try {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const addr = row.agent_id ?? null
    // When an agent exists, propose directly to them (manager-audience coaching brief).
    // When no agent, the brief is brokerage-scoped so a broker/admin can review it.
    const briefBody = composeAutopsyCoachingBrief(facts, classification, row.purchase_price)
    const res = await proposeClientMessage({
      brokerageId:         row.brokerage_id,
      agentKind:           "recruiting_manager",
      entityType:          "transaction",
      entityId:            transactionId,
      recipientContactId:  row.contact_id ?? undefined,
      audience:            "agent",
      subject:             `Deal autopsy: ${classification.reason.replace(/_/g, " ")} (${row.deal_type ?? "transaction"} — ${formatPrice(row.purchase_price)})`,
      body:                briefBody,
      rationale:           `DEAL AUTOPSY — transaction:${transactionId} — reason:${classification.reason} confidence:${classification.confidence} — gated manager-facing coaching brief (autopsy:${autopsyId}).`,
      channel:             "portal",
    }, svc)
    coachingOk = res.ok

    if (res.ok) {
      await svc.from("deal_autopsy_observations")
        .update({ coaching_proposed_at: new Date().toISOString() })
        .eq("id", autopsyId)
    }
  } catch (e) {
    console.error("[deal-autopsy] coaching proposal skipped:", (e as Error).message)
  }

  // ── Manager signal: deal_coordinator → recruiting_manager ─────────────────
  let signalOk = false
  try {
    const sigRes = await publishManagerSignal({
      brokerageId:  row.brokerage_id,
      fromManager:  "deal_coordinator",
      toManager:    "recruiting_manager",
      signalType:   "deal_autopsy_completed",
      message:      `Deal autopsy: ${classification.reason.replace(/_/g, " ")} (${formatPrice(row.purchase_price)}, ${duc != null ? `${duc} days under contract` : "contract date unknown"}). Evidence: ${classification.evidence.slice(0, 2).join("; ")}.`,
      entityType:   "transaction",
      entityId:     transactionId,
      contactId:    row.contact_id ?? null,
      payload: {
        autopsy_id:    autopsyId,
        failure_reason: classification.reason,
        confidence:    classification.confidence,
        evidence:      classification.evidence,
        agent_id:      row.agent_id,
        purchase_price: row.purchase_price,
        days_under_contract: duc,
        deal_type:     row.deal_type,
      },
      dedupe: true,
    }, svc)
    signalOk = sigRes.ok

    if (sigRes.ok) {
      await svc.from("deal_autopsy_observations")
        .update({ signal_published_at: new Date().toISOString() })
        .eq("id", autopsyId)
    }
  } catch (e) {
    console.error("[deal-autopsy] signal publish skipped:", (e as Error).message)
  }

  return {
    transactionId,
    autopsyId,
    reason:     classification.reason,
    confidence: classification.confidence,
    evidence:   classification.evidence,
    coachingOk,
    signalOk,
    idempotent: false,
    error:      null,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPrice(price: number | null | undefined): string {
  if (!price) return "unknown price"
  return `$${Math.round(price).toLocaleString()}`
}

/**
 * PURE. Compose the coaching brief body from real autopsy facts.
 * Every line is earned from a real row — no invented criticism.
 */
export function composeAutopsyCoachingBrief(
  facts: TxnFacts,
  classification: AutopsyClassification,
  purchasePrice: number | null | undefined,
): string {
  const lines: string[] = [
    `Post-mortem: this ${facts.dealType ?? "transaction"} fell through (${facts.status}).`,
    "",
    `Failure reason classified: ${classification.reason.replace(/_/g, " ")}`,
    `Confidence: ${Math.round(classification.confidence * 100)}%`,
  ]

  if (classification.evidence.length > 0) {
    lines.push("", "Evidence from the real deal record:")
    for (const e of classification.evidence) lines.push(`  • ${e}`)
  }

  lines.push("")
  switch (classification.reason) {
    case "financing":
      lines.push("Coaching focus: the financing thread slipped. Did the agent have a weekly lender check-in routine? Pre-underwriting earlier catches declines before they kill the deal.")
      break
    case "inspection":
      lines.push("Coaching focus: inspection issue not resolved. Was a repair negotiation proposed? A written repair addendum + a reinspection often save deals the inspection report ends.")
      break
    case "appraisal":
      lines.push("Coaching focus: appraisal contingency was never removed. Pre-appraisal listing pricing conversations with buyers/sellers before going under contract prevent a lot of appraisal exits.")
      break
    case "low_appraisal":
      lines.push("Coaching focus: the appraisal came in below contract price. Three levers exist: seller price reduction, buyer bridging the gap, or split-the-difference. Did the agent propose all three to both parties?")
      break
    case "competing_offer":
      lines.push("Coaching focus: a stronger competing offer won. Review the escalation strategy conversation — was an escalation clause discussed? Was the offer submitted at peak strength?")
      break
    case "cold_feet":
      lines.push("Coaching focus: all contingencies were resolved, yet the deal fell. Cold feet typically signal a relationship breakdown or expectations mismatch. Post-contract check-ins with buyers/sellers help surface concerns early.")
      break
    case "title":
      lines.push("Coaching focus: title issues derailed the deal. Early title search orders (within days of contract) give the team maximum runway to cure defects before a buyer walks.")
      break
    default:
      lines.push("Coaching focus: reason unclear from the evidence on file. Consider adding more structured notes at the deal-exit stage to improve future classification.")
  }

  if (purchasePrice) {
    lines.push("", `Deal value: ${formatPrice(purchasePrice)} — a real revenue loss worth a debrief.`)
  }

  return lines.join("\n")
}
