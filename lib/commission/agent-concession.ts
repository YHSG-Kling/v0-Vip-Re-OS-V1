// lib/commission/agent-concession.ts — THE AGENT CONCESSION (wave 144, lane 144D; owner ruling 4, 2026-10-25).
//
// Owner, verbatim essentials: "SELLER concession = the SELLER gives a $ amount to the BUYER out of the seller's net sales
// amount — NEVER from the agent's commission. AGENT concession = a credit the AGENT gives to buyer or seller; it shows as an
// agent concession and the $ amount is subtracted from THAT agent's gross commission. Some brokers require the agent to ASK
// PERMISSION FIRST before offering any concession → request broker approval, block unauthorized commitment, keep approval
// evidence. Record agent, beneficiary, amount, reason, approval, transaction, settlement treatment, ledger effect. Never
// conflate the two credits."
//
// SURVIVOR EXTENDED, nothing parallel (CLAUDE.md §1): commission_adjustments was already the ledger of gross-level commission
// credits — its one writer (app/actions/seller-listing/execution-engine.ts) records the listing agreement's agreed commission
// reduction (applies_to 'gross', direction 'credit', recipient seller), which IS an agent concession in the owner's terms: the
// agent gives the seller a credit off that agent's gross commission. Stage 03 (lib/commission/waterfall/03-apply-gross-adjustments.ts)
// already nets it from the gross before the split. m850 adds what the record lacked: WHICH agent's commission it comes off
// (concession_agent_id), the approval state + its evidence (approval_status / requested / decided / by / note / policy ref) and
// how it settles (settlement_treatment). This module is the rule (pure, top) and the one writer of those columns (bottom).
//
// A SELLER concession is NOT here and never will be: its record is the executed contract term (offers / transactions
// .closing_cost_contribution, governed by lib/transactions/closing-compliance-core.ts `seller_credit`) and the seller net sheet
// (lib/offers/offer-math.ts calcNetToSeller: net = price − commission − credit; the commission is priced on the FULL price).
// scripts/concession-ledger-guard.ts proves both halves.
//
// WHO BEARS IT (business process, stated so it is not mistaken for a universal rule): the ruling says the amount is subtracted
// from THAT agent's GROSS commission, so it comes off the gross before the agent/brokerage split (the brokerage's share falls
// with it) — which is also why some brokers require the agent to ask first. A brokerage whose agreement charges a concession to
// the agent's share alone is not modelled; that is a per-agreement term (see the lane notes, "Still open"), never assumed here.
//
// AI never computes or approves a concession: an agent requests, a finance admin decides, the deterministic waterfall applies.

import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"

// ─── Vocabulary (mirrors the m850 CHECKs; adding a member needs the matching migration) ──────────────────────────────

export const AGENT_CONCESSION_APPROVAL_STATUSES = ["not_required", "requested", "approved", "denied", "withdrawn"] as const
export type AgentConcessionApprovalStatus = (typeof AGENT_CONCESSION_APPROVAL_STATUSES)[number]

/** How the concession settles (m850 commission_adjustments_settlement_treatment_check). */
export const CONCESSION_SETTLEMENT_TREATMENTS = ["reduced_commission_rate", "closing_statement_credit"] as const
export type ConcessionSettlementTreatment = (typeof CONCESSION_SETTLEMENT_TREATMENTS)[number]

/** The brokerage setting (m850 brokerages_agent_concession_approval_check). */
export const AGENT_CONCESSION_APPROVAL_POLICIES = ["broker_approval_required", "no_approval_required"] as const
export type AgentConcessionApprovalPolicy = (typeof AGENT_CONCESSION_APPROVAL_POLICIES)[number]

export const AGENT_CONCESSION_BENEFICIARIES = ["buyer", "seller"] as const
export type AgentConcessionBeneficiary = (typeof AGENT_CONCESSION_BENEFICIARIES)[number]

/** Minimum stated reason — a concession without a why is not evidence. */
export const AGENT_CONCESSION_REASON_MIN = 5

export const AGENT_CONCESSION_APPROVAL_LABEL: Record<AgentConcessionApprovalStatus, string> = {
  not_required: "No approval required",
  requested: "Awaiting broker approval",
  approved: "Approved by the broker",
  denied: "Denied by the broker",
  withdrawn: "Withdrawn by the agent",
}

// ─── PURE: the policy ─────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentConcessionPolicy {
  requiresApproval: boolean
  /** false = the brokerage never answered (NULL, or the column is not applied yet) — the answer is then FAIL CLOSED. */
  declared: boolean
  value: AgentConcessionApprovalPolicy | null
}

/**
 * PURE — does this brokerage require broker approval before an agent commits a concession?
 * UNDECLARED IS "YES" (fail closed): a concession reduces the gross before the split, so it spends the brokerage's money too;
 * an unanswered setting must never let an agent commit it alone. Only an explicit 'no_approval_required' lets it stand.
 */
export function resolveAgentConcessionPolicy(raw: unknown): AgentConcessionPolicy {
  if (raw === "no_approval_required") return { requiresApproval: false, declared: true, value: "no_approval_required" }
  if (raw === "broker_approval_required") return { requiresApproval: true, declared: true, value: "broker_approval_required" }
  return { requiresApproval: true, declared: false, value: null }
}

// ─── PURE: the waterfall gate (stage 03 asks this for every gross-level row) ─────────────────────────────────────

export interface GrossAdjustmentRow {
  id: string
  direction?: string | null
  concession_agent_id?: string | null
  approval_status?: string | null
  is_active?: boolean | null
}

export type ConcessionWaterfallVerdict =
  | { verdict: "apply" }
  | { verdict: "skip"; finding: string }
  /** A FINAL calculation refuses by name; a PREVIEW shows the finding and does not apply the row. */
  | { verdict: "hold"; finding: string }

/**
 * PURE — may this gross-level adjustment move THIS calculation's gross?
 *   · a surcharge is not a concession — it applies as before (direction is load-bearing, stage 03's own rule);
 *   · a credit charged to ANOTHER agent's commission never comes off this agent's gross → HOLD (a final refuses: charging it
 *     here would bill the wrong agent, ignoring it would overpay — a human must move it to the right deal);
 *   · requested → HOLD (no unauthorized commitment reaches the books: the final waits for the broker's decision);
 *   · denied / withdrawn → SKIP with a finding (never applied);
 *   · approved / not_required / absent (a row written before m850) → APPLY.
 */
export function concessionWaterfallVerdict(row: GrossAdjustmentRow, ctx: { producingAgentId: string }): ConcessionWaterfallVerdict {
  if (row.direction !== "credit") return { verdict: "apply" }
  const status = row.approval_status ?? "not_required"
  if (status === "denied" || status === "withdrawn") {
    return { verdict: "skip", finding: `agent concession ${row.id} was ${status} — not applied` }
  }
  if (row.concession_agent_id && row.concession_agent_id !== ctx.producingAgentId) {
    return {
      verdict: "hold",
      finding: `agent concession ${row.id} comes off agent ${row.concession_agent_id}'s gross commission, not the producing agent ${ctx.producingAgentId}'s — it cannot be charged to this calculation; move it to that agent's deal or correct the agent`,
    }
  }
  if (status === "requested") {
    return { verdict: "hold", finding: `agent concession ${row.id} is awaiting broker approval — the commission is not final until the broker approves or denies it` }
  }
  if (status !== "approved" && status !== "not_required") {
    return { verdict: "hold", finding: `agent concession ${row.id} carries an unknown approval status "${status}" — not applied (never guessed)` }
  }
  return { verdict: "apply" }
}

// ─── PURE: request validation ──────────────────────────────────────────────────────────────────────────────────────

export interface AgentConcessionRequestInput {
  /** The transaction the concession comes off… */
  transactionId?: string | null
  /** …or (wave 145, lane 145C — m861) the OFFER it is promised on, before any transaction exists. Exactly one of the two.
   *  "Ask permission FIRST … block unauthorized commitment" (owner ruling 4): the request is made while the offer is still
   *  being written, and the chain's offer-anchored rows are re-pointed to the transaction when it is created
   *  (anchorOfferConcessionsToTransaction, called by lib/offers/governing-terms.ts freezeExecutedTermsAfterPromotion). */
  offerId?: string | null
  beneficiary: string
  beneficiaryName?: string | null
  amount: number
  valueType: "flat" | "percent"
  reason: string
}

/** PURE — refuse a malformed request by name. Money is never rounded on the agent's behalf. Module-private: reached
 *  through requestAgentConcession. */
function validateAgentConcessionRequest(input: AgentConcessionRequestInput): { ok: true } | { ok: false; error: string } {
  if (!!input.transactionId === !!input.offerId) return { ok: false, error: "anchor_invalid: name the transaction OR the offer the concession is promised on — exactly one" }
  if (!(AGENT_CONCESSION_BENEFICIARIES as readonly string[]).includes(input.beneficiary)) {
    return { ok: false, error: "beneficiary_invalid: an agent concession is a credit to the buyer or the seller" }
  }
  if (input.valueType !== "flat" && input.valueType !== "percent") return { ok: false, error: "value_type_invalid: flat or percent" }
  const n = Number(input.amount)
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "amount_invalid: a concession is a positive amount" }
  if (input.valueType === "percent" && n > 100) return { ok: false, error: "amount_invalid: a percent concession is at most 100% of the gross commission" }
  const decimals = String(input.amount).includes(".") ? String(input.amount).split(".")[1].length : 0
  if (input.valueType === "flat" && decimals > 2) return { ok: false, error: "amount_invalid: at most 2 decimal places (cents)" }
  if (String(input.reason ?? "").trim().length < AGENT_CONCESSION_REASON_MIN) {
    return { ok: false, error: `reason_required: state why (at least ${AGENT_CONCESSION_REASON_MIN} characters) — it is kept as evidence` }
  }
  return { ok: true }
}

// ─── The writer (service client passed in; every { error } read; every UPDATE counted — CLAUDE.md §3) ──────────────

type Db = { from: (t: string) => any }

export interface ConcessionActor {
  userId: string
  /** agents.id of the caller (agents.id and users.id are DISJOINT — §3). */
  agentId: string | null
  /** The SESSION's tenant — never a body field (§4). */
  brokerageId: string
  userType: string
  isTenantPrincipal?: boolean
}

/** A missing m850 column — the one refusal that is reported by name rather than as a generic failure. */
function m850Missing(message: string | undefined): boolean {
  return /approval_status|concession_agent_id|settlement_treatment|agent_concession_approval|approval_requested_at|approval_policy_ref/.test(String(message ?? ""))
}

export interface AgentConcessionRecord {
  id: string
  transactionId: string
  /** wave 145 (m861): the offer it was promised on (kept as provenance after the transaction exists). */
  offerId?: string | null
  concessionAgentId: string | null
  beneficiary: string | null
  beneficiaryName: string | null
  valueType: string
  value: number
  reason: string | null
  approvalStatus: string
  approvalRequestedAt: string | null
  approvalDecidedAt: string | null
  approvalDecidedBy: string | null
  approvalNote: string | null
  settlementTreatment: string | null
  isActive: boolean
}

function toRecord(r: Record<string, unknown>): AgentConcessionRecord {
  return {
    id: String(r.id),
    transactionId: String(r.transaction_id ?? ""),
    offerId: (r.offer_id as string | null | undefined) ?? null,
    concessionAgentId: (r.concession_agent_id as string | null) ?? null,
    beneficiary: (r.recipient_type as string | null) ?? null,
    beneficiaryName: (r.recipient_name as string | null) ?? null,
    valueType: String(r.value_type ?? "flat"),
    value: Number(r.value ?? 0),
    reason: (r.notes as string | null) ?? null,
    approvalStatus: String(r.approval_status ?? "not_required"),
    approvalRequestedAt: (r.approval_requested_at as string | null) ?? null,
    approvalDecidedAt: (r.approval_decided_at as string | null) ?? null,
    approvalDecidedBy: (r.approval_decided_by as string | null) ?? null,
    approvalNote: (r.approval_note as string | null) ?? null,
    settlementTreatment: (r.settlement_treatment as string | null) ?? null,
    isActive: r.is_active !== false,
  }
}

async function ledger(
  db: Db,
  entry: { brokerageId: string; action: string; actor: ConcessionActor; subjectId: string | null; transactionId: string; reasonDetail: string; detail: Record<string, unknown> },
  run: () => Promise<{ ok: boolean; error?: string }>,
): Promise<{ ok: boolean; error?: string }> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<{ ok: boolean; error?: string }>(
    {
      brokerageId: entry.brokerageId,
      action: entry.action,
      actor: { type: "user", userId: entry.actor.userId, agentId: entry.actor.agentId },
      subject: { type: "commission_adjustment", id: entry.subjectId, ref: entry.transactionId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: entry.reasonDetail.slice(0, 500),
      riskClass: "FINANCIAL",
      systemSource: "agent_concession",
      detail: entry.detail,
    },
    run,
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: "recorded" } : { status: "failed", outcome: "refused", error: r.error ?? null }),
      replay: (claim) => ({ ok: false, error: `already ${claim.kind === "in_flight" ? "in flight" : "recorded"}` }),
    },
    { client: db as never },
  )
}

/**
 * REQUEST (or, where the brokerage requires no approval, RECORD) an agent concession on a transaction.
 * THAT agent is the caller: an agent records a concession off their own commission, and only on a deal they are on.
 * Refused once the commission is final (CDA signed / final CD) or already posted — a concession after that is a CORRECTION
 * (lib/kernel/financial.ts correctCommissionDistribution), never a silent re-price.
 */
export async function requestAgentConcession(
  db: Db,
  actor: ConcessionActor,
  input: AgentConcessionRequestInput,
): Promise<{ ok: true; record: AgentConcessionRecord; requiresApproval: boolean } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!actor.agentId) return { ok: false, error: "agent_required: an agent concession comes off an agent's own commission — the caller has no agent seat" }
  const v = validateAgentConcessionRequest(input)
  if (!v.ok) return v

  // WAVE 145 (m861): an OFFER anchor — the agent on the offer asks BEFORE the offer commits the credit. An offer that already
  // became a transaction is judged on its transaction (the request lands there, never on a closed-out offer row).
  let transactionId: string | null = input.transactionId ?? null
  let offerId: string | null = null
  if (input.offerId) {
    const { data: offer, error: offerErr } = await db
      .from("offers")
      .select("id, agent_id, transaction_id, status")
      .eq("id", input.offerId)
      .eq("brokerage_id", actor.brokerageId)
      .maybeSingle()
    if (offerErr) return { ok: false, error: `offer_read_refused: ${offerErr.message}` }
    if (!offer) return { ok: false, error: "offer_not_found" }
    const o = offer as { agent_id?: string | null; transaction_id?: string | null }
    if (o.transaction_id) transactionId = o.transaction_id
    else {
      if (o.agent_id !== actor.agentId) return { ok: false, error: "not_on_offer: an agent requests a concession only off their own commission, on an offer they wrote" }
      offerId = input.offerId
    }
  }

  if (transactionId) {
    const { data: txn, error: txnErr } = await db
      .from("transactions")
      .select("id, agent_id, buyer_agent_id, seller_agent_id, commission_finalized_at")
      .eq("id", transactionId)
      .eq("brokerage_id", actor.brokerageId)
      .maybeSingle()
    if (txnErr) return { ok: false, error: `transaction_read_refused: ${txnErr.message}` }
    if (!txn) return { ok: false, error: "transaction_not_found" }
    const t = txn as { agent_id?: string | null; buyer_agent_id?: string | null; seller_agent_id?: string | null; commission_finalized_at?: string | null }
    if (![t.agent_id, t.buyer_agent_id, t.seller_agent_id].includes(actor.agentId)) {
      return { ok: false, error: "not_on_deal: an agent records a concession only off their own commission on a deal they are on" }
    }
    if (t.commission_finalized_at) {
      return { ok: false, error: "commission_final: the commission is finalized (CDA signed / final CD) — a change now is a correction by a finance admin" }
    }
    const { data: posted, error: postedErr } = await db
      .from("commission_distributions")
      .select("id, status")
      .eq("transaction_id", transactionId)
      .eq("brokerage_id", actor.brokerageId)
    if (postedErr) return { ok: false, error: `ledger_read_refused: ${postedErr.message}` }
    if (((posted ?? []) as Array<{ status?: string | null }>).some((r) => r.status !== "voided")) {
      return { ok: false, error: "commission_posted: the commission is already posted — a concession now is a correction by a finance admin" }
    }
  }
  const anchorRef = transactionId ?? `offer:${offerId}`

  const { data: brk, error: brkErr } = await db.from("brokerages").select("*").eq("id", actor.brokerageId).maybeSingle()
  if (brkErr) return { ok: false, error: `policy_read_refused: ${brkErr.message}` }
  const policy = resolveAgentConcessionPolicy((brk as Record<string, unknown> | null)?.agent_concession_approval)
  const now = new Date().toISOString()
  const status: AgentConcessionApprovalStatus = policy.requiresApproval ? "requested" : "not_required"
  const reason = input.reason.trim()

  let inserted: Record<string, unknown> | null = null
  const result = await ledger(
    db,
    {
      brokerageId: actor.brokerageId,
      action: policy.requiresApproval ? "finance.agent_concession.requested" : "finance.agent_concession.recorded",
      actor,
      subjectId: null,
      transactionId: anchorRef,
      reasonDetail: `agent concession to the ${input.beneficiary}${offerId ? " (promised on an offer, before the contract commits it)" : ""}: ${reason}`,
      detail: {
        transaction_id: transactionId,
        offer_id: offerId,
        concession_agent_id: actor.agentId,
        beneficiary: input.beneficiary,
        beneficiary_name: input.beneficiaryName ?? null,
        amount: Number(input.amount),
        value_type: input.valueType,
        settlement_treatment: "closing_statement_credit",
        ledger_effect: "reduces_gross_before_split",
        approval_status: status,
        policy: { key: "brokerages.agent_concession_approval", value: policy.value, declared: policy.declared },
      },
    },
    async () => {
      const { data, error } = await db
        .from("commission_adjustments")
        .insert({
          brokerage_id: actor.brokerageId,
          transaction_id: transactionId,
          // m861 — named ONLY when the anchor is an offer: before m861 is applied a transaction-anchored insert must not name
          // an absent column (PGRST204 refuses the whole row — CLAUDE.md §3)
          ...(offerId ? { offer_id: offerId } : {}),
          created_by_agent_id: actor.agentId,
          concession_agent_id: actor.agentId,
          adjustment_type: "credit",
          applies_to: "gross",
          direction: "credit",
          recipient_type: input.beneficiary,
          recipient_name: input.beneficiaryName?.trim() || null,
          value: Number(input.amount),
          value_type: input.valueType,
          notes: `Agent concession — ${reason}`,
          is_active: true,
          effective_date: now.slice(0, 10),
          approval_status: status,
          approval_requested_at: policy.requiresApproval ? now : null,
          approval_policy_ref: `brokerages.agent_concession_approval=${policy.value ?? "undeclared"}`,
          settlement_treatment: "closing_statement_credit",
        })
        .select("*")
      if (error) return { ok: false, error: m850Missing(error.message) ? `m850 (agent concession columns) is not applied: ${error.message}` : offerId && /offer_id|transaction_id/.test(error.message) ? `m861 (offer-anchored concessions) is not applied: ${error.message}` : `concession_refused: ${error.message}` }
      const rows = (data ?? []) as Array<Record<string, unknown>>
      if (rows.length !== 1) return { ok: false, error: `concession_not_recorded (${rows.length} rows written)` }
      inserted = rows[0]
      return { ok: true }
    },
  )
  if (!result.ok || !inserted) return { ok: false, error: result.error ?? "concession_not_recorded" }

  if (policy.requiresApproval) {
    try {
      const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
      await notifyBrokerageAdmins(db as never, actor.brokerageId, {
        type: "agent_concession_requested",
        title: "An agent asks to give a concession",
        body: `An agent asks to credit the ${input.beneficiary} ${input.valueType === "flat" ? `$${Number(input.amount).toLocaleString("en-US")}` : `${input.amount}% of the gross commission`} off their gross commission${offerId ? " on an offer that is not yet a contract" : ""}. Reason: ${reason}. Approve or deny it ${offerId ? "before the offer is sent" : "on the transaction's CDA page before it is committed"}.`,
        entityType: transactionId ? "transaction" : "offer",
        entityId: (transactionId ?? offerId) as string,
        priority: "high",
      })
    } catch (e) {
      console.error("[agent-concession] broker notice failed:", e instanceof Error ? e.message : String(e))
    }
  }
  return { ok: true, record: toRecord(inserted), requiresApproval: policy.requiresApproval }
}

/**
 * The BROKER's decision on a requested concession. Finance admins only; compare-and-swap on approval_status = 'requested'
 * (a second decision, or a decision on a concession that was never requested, matches nothing and is REFUSED — §3).
 * A denial also deactivates the row so no legacy reader can apply it.
 */
export async function decideAgentConcession(
  db: Db,
  actor: ConcessionActor,
  input: { adjustmentId: string; decision: "approved" | "denied"; note?: string | null },
): Promise<{ ok: true; record: AgentConcessionRecord } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!isBrokerageFinanceAdmin({ user_type: actor.userType, is_tenant_principal: actor.isTenantPrincipal })) {
    return { ok: false, error: "forbidden: only the brokerage's finance admins approve or deny a concession" }
  }
  if (input.decision !== "approved" && input.decision !== "denied") return { ok: false, error: "decision_invalid: approved or denied" }
  const note = (input.note ?? "").trim() || null
  if (input.decision === "denied" && (!note || note.length < AGENT_CONCESSION_REASON_MIN)) {
    return { ok: false, error: `note_required: a denial states why (at least ${AGENT_CONCESSION_REASON_MIN} characters)` }
  }
  const { data: current, error: readErr } = await db
    .from("commission_adjustments")
    .select("*")
    .eq("id", input.adjustmentId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (readErr) return { ok: false, error: `concession_read_refused: ${readErr.message}` }
  if (!current) return { ok: false, error: "concession_not_found" }
  const before = toRecord(current as Record<string, unknown>)
  if (before.approvalStatus !== "requested") return { ok: false, error: `not_pending: this concession is ${before.approvalStatus}` }
  const now = new Date().toISOString()
  let updated: Record<string, unknown> | null = null
  const result = await ledger(
    db,
    {
      brokerageId: actor.brokerageId,
      action: `finance.agent_concession.${input.decision}`,
      actor,
      subjectId: input.adjustmentId,
      transactionId: before.transactionId,
      reasonDetail: `broker ${input.decision} an agent concession${note ? `: ${note}` : ""}`,
      detail: {
        adjustment_id: input.adjustmentId,
        transaction_id: before.transactionId,
        concession_agent_id: before.concessionAgentId,
        beneficiary: before.beneficiary,
        amount: before.value,
        value_type: before.valueType,
        decision: input.decision,
        note,
      },
    },
    async () => {
      const { data, error } = await db
        .from("commission_adjustments")
        .update({
          approval_status: input.decision,
          approval_decided_at: now,
          approval_decided_by: actor.userId,
          approval_note: note,
          ...(input.decision === "denied" ? { is_active: false } : {}),
          updated_at: now,
        })
        .eq("id", input.adjustmentId)
        .eq("brokerage_id", actor.brokerageId)
        .eq("approval_status", "requested")
        .select("*")
      if (error) return { ok: false, error: m850Missing(error.message) ? `m850 (agent concession columns) is not applied: ${error.message}` : `decision_refused: ${error.message}` }
      const rows = (data ?? []) as Array<Record<string, unknown>>
      if (rows.length !== 1) return { ok: false, error: "not_pending: no concession awaiting approval matches (already decided, withdrawn, or not in this brokerage)" }
      updated = rows[0]
      return { ok: true }
    },
  )
  if (!result.ok || !updated) return { ok: false, error: result.error ?? "decision_not_recorded" }
  return { ok: true, record: toRecord(updated) }
}

/** The requesting agent withdraws their own still-pending request (compare-and-swap on 'requested' + their agent id). */
export async function withdrawAgentConcession(
  db: Db,
  actor: ConcessionActor,
  input: { adjustmentId: string },
): Promise<{ ok: true; record: AgentConcessionRecord } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!actor.agentId) return { ok: false, error: "agent_required" }
  const now = new Date().toISOString()
  const { data, error } = await db
    .from("commission_adjustments")
    .update({ approval_status: "withdrawn", is_active: false, updated_at: now })
    .eq("id", input.adjustmentId)
    .eq("brokerage_id", actor.brokerageId)
    .eq("concession_agent_id", actor.agentId)
    .eq("approval_status", "requested")
    .select("*")
  if (error) return { ok: false, error: `withdraw_refused: ${error.message}` }
  const rows = (data ?? []) as Array<Record<string, unknown>>
  if (rows.length !== 1) return { ok: false, error: "not_pending: only your own concession that still awaits approval can be withdrawn" }
  return { ok: true, record: toRecord(rows[0]) }
}

/** The transaction's gross-level concessions, for the CDA page (tenant-pinned; a refused read is a refusal, never "none"). */
export async function listAgentConcessions(
  db: Db,
  actor: ConcessionActor,
  input: { transactionId?: string | null; offerIds?: readonly string[] | null },
): Promise<{ ok: true; records: AgentConcessionRecord[]; policy: AgentConcessionPolicy } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  // wave 145 (m861): before a transaction exists, the concessions promised on the offer chain
  const byOffer = !input.transactionId && (input.offerIds?.length ?? 0) > 0
  if (!input.transactionId && !byOffer) return { ok: false, error: "anchor_required: a transaction or the offer chain" }
  const base = db.from("commission_adjustments").select("*")
  const { data, error } = await (byOffer ? base.in("offer_id", [...(input.offerIds as string[])]) : base.eq("transaction_id", input.transactionId as string))
    .eq("brokerage_id", actor.brokerageId)
    .eq("applies_to", "gross")
    .eq("direction", "credit")
    .order("created_at", { ascending: true })
  if (error) return { ok: false, error: `concessions_read_refused: ${error.message}` }
  const { data: brk, error: brkErr } = await db.from("brokerages").select("*").eq("id", actor.brokerageId).maybeSingle()
  if (brkErr) return { ok: false, error: `policy_read_refused: ${brkErr.message}` }
  return {
    ok: true,
    records: ((data ?? []) as Array<Record<string, unknown>>).map(toRecord),
    policy: resolveAgentConcessionPolicy((brk as Record<string, unknown> | null)?.agent_concession_approval),
  }
}

// ─── WAVE 145 (lane 145C, m861): the offer anchor — before the contract, and at the moment it becomes a transaction ──────────

/**
 * PURE — the concessions promised on an offer chain that are NOT yet authorized (still 'requested'): an offer stating them is an
 * UNAUTHORIZED COMMITMENT if sent or signed now (owner ruling 4: "ask permission FIRST … block unauthorized commitment"). Read
 * here at promotion (below); the offer send / e-sign doors are other lanes' files — when they wire the pre-dispatch check (lane
 * 145C notes, Outside-lane) this becomes their export. The commission engine already holds a FINAL on a requested concession
 * (stage 03). Module-private until then: proved through anchorOfferConcessionsToTransaction's `unauthorized`.
 */
function unauthorizedOfferConcessions(rows: ReadonlyArray<Record<string, unknown>>): Array<{ id: string; value: number; valueType: string; beneficiary: string | null }> {
  return rows
    .filter((r) => r.is_active !== false && r.applies_to === "gross" && r.direction === "credit" && String(r.approval_status ?? "not_required") === "requested")
    .map((r) => ({ id: String(r.id), value: Number(r.value ?? 0), valueType: String(r.value_type ?? "flat"), beneficiary: (r.recipient_type as string | null) ?? null }))
}

/**
 * AT PROMOTION (offer → transaction): re-point the chain's offer-anchored concession rows to the new transaction — one counted
 * UPDATE, tenant-pinned, only rows that have no transaction yet (offer_id stays as provenance). Called by
 * lib/offers/governing-terms.ts freezeExecutedTermsAfterPromotion, which every promotion path already calls. A refused write is
 * RETURNED (the promotion has happened and is never undone for this); before m861 is applied the column is absent and nothing
 * can be offer-anchored, which is reported as `unavailable`, not as an error.
 */
export async function anchorOfferConcessionsToTransaction(
  db: Db,
  input: { brokerageId: string; offerIds: readonly string[]; transactionId: string },
): Promise<{ ok: true; moved: number; unauthorized: ReturnType<typeof unauthorizedOfferConcessions>; unavailable?: boolean } | { ok: false; error: string }> {
  if (!input.brokerageId) return { ok: false, error: "no_tenant" }
  if (input.offerIds.length === 0) return { ok: true, moved: 0, unauthorized: [] }
  const { data, error } = await db
    .from("commission_adjustments")
    .update({ transaction_id: input.transactionId, updated_at: new Date().toISOString() })
    .eq("brokerage_id", input.brokerageId)
    .in("offer_id", [...input.offerIds])
    .is("transaction_id", null)
    .select("*")
  if (error) {
    if (/offer_id/.test(String(error.message ?? "")) && /column|schema cache|does not exist/i.test(String(error.message ?? ""))) return { ok: true, moved: 0, unauthorized: [], unavailable: true }
    return { ok: false, error: `concession_reanchor_refused: ${error.message}` }
  }
  const moved = (data ?? []) as Array<Record<string, unknown>>
  // A contract that EXECUTED while a concession it carries still awaited the broker's decision is the unauthorized commitment
  // ruling 4 forbids: the broker is told at once (the waterfall already holds a FINAL on it — stage 03).
  const unauthorized = unauthorizedOfferConcessions(moved)
  if (unauthorized.length > 0) {
    try {
      const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
      await notifyBrokerageAdmins(db as never, input.brokerageId, {
        type: "agent_concession_unauthorized_commitment",
        title: "A contract executed with an agent concession still awaiting approval",
        body: `${unauthorized.length} agent concession(s) promised on the offer were not decided before the contract became a transaction. Approve or deny them on the transaction's CDA page — the commission will not finalize until you do.`,
        entityType: "transaction",
        entityId: input.transactionId,
        priority: "high",
      })
    } catch (e) {
      console.error("[agent-concession] unauthorized-commitment notice failed:", e instanceof Error ? e.message : String(e))
    }
  }
  return { ok: true, moved: moved.length, unauthorized }
}
