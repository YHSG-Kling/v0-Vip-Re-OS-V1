// lib/commission/reconcile-tracking.ts
//
// THE MONEY LIFECYCLE — close FREEZES the amount; the ledger TRACKS the money after close.
//
// The platform tracks a commission across two systems that represent two REAL stages of the money —
// they are NOT redundant:
//   • THE BRIDGE  — agent_commissions.status (pending → approved → paid): the agent-EARNINGS record
//                   (what the agent will receive). 'approved' = authorized to disburse (the CDA
//                   broker-sign for CDA brokerages; auto at close for non-CDA). 'paid' = the agent
//                   actually received their disbursement.
//   • THE LEDGER  — commission_distributions (pending → paid; deposit_received_at lives on the
//                   summary row): the MONEY MOVEMENT, line by line. A brokerage RECEIVES the
//                   commission deposit at closing, then DISBURSES each split.
//
// KEEP-ONE (m283/m284): the `commissions` summary twin was merged INTO agent_commissions, so the
// bridge row and the summary row are now one record. The two trackings that can still drift are that
// summary row and its per-line distributions.
//
// CLOSE (final CD, both signed) freezes the AMOUNT — it does NOT pay. After close the ledger tracks
// the deposit, then the disbursement. DISBURSEMENT is the ONE LOCK: both trackings go 'paid' together
// (a reaper heals any single-sided drift). This mirrors how real brokerages settle: for a CDA-enforced
// brokerage the commission flows commission → broker → brokerage → agent; for a non-CDA brokerage it
// disburses per the agent's payout preference.
//
// The pure detector/aggregator are unit-tested; the reconcile/deposit helpers do the I/O.

import type { SupabaseClient } from "@supabase/supabase-js"
import { summaryAmountFromDistributions } from "./distribution-correction"
import type { EconomicGraph, LedgerRef } from "@/lib/kernel/economic-graph"

type Svc = SupabaseClient<any, any, any>

export type TrackingDriftDirection = "bridge_ahead" | "ledger_ahead" | null

/**
 * PURE: given the two trackings' status for ONE transaction, are they out of sync on PAID?
 *   • bridge_ahead — the earnings record is paid but the ledger isn't → heal the ledger.
 *   • ledger_ahead — the ledger is paid but the earnings record isn't → an anomaly a human resolves.
 *   • null         — consistent, or one side is absent (nothing to compare).
 * `ledgerStatus` is the AGGREGATE ledger state (paid only when every commissions row for the txn is
 * paid); anything else is treated as not-yet-paid.
 */
export function detectCommissionTrackingDrift(input: {
  bridgeStatus: string | null | undefined
  ledgerStatus: string | null | undefined
}): { drifted: boolean; direction: TrackingDriftDirection } {
  const bridge = input.bridgeStatus ?? null
  const ledger = input.ledgerStatus ?? null
  if (bridge == null || ledger == null) return { drifted: false, direction: null }
  const bridgePaid = bridge === "paid"
  const ledgerPaid = ledger === "paid"
  if (bridgePaid === ledgerPaid) return { drifted: false, direction: null }
  return { drifted: true, direction: bridgePaid ? "bridge_ahead" : "ledger_ahead" }
}

/**
 * PURE: aggregate many ledger rows for one transaction into a single ledger status. Paid only
 * when at least one row exists and every non-cancelled row is paid; otherwise 'pending'. Returns null
 * when there is no ledger row at all (bridge-only — not drift, a separate leak concern).
 */
export function aggregateLedgerStatus(rows: Array<{ status?: string | null }>): string | null {
  const live = (rows ?? []).filter((r) => (r.status ?? "").toLowerCase() !== "cancelled" && (r.status ?? "").toLowerCase() !== "voided")
  if (live.length === 0) return null
  return live.every((r) => (r.status ?? "").toLowerCase() === "paid") ? "paid" : "pending"
}

/**
 * FREEZE THE AMOUNT AT CLOSE — the deal is done (final CD both-signed). This does NOT pay. For a
 * NON-CDA brokerage there is no CDA broker-sign to authorize disbursement, so the earnings record is
 * auto-APPROVED here (pending → approved) to keep the later disbursement path uniform. For a CDA
 * brokerage the broker-sign already approved it (or it stays pending until signed — the CDA authorizes).
 * Idempotent, best-effort — never blocks the close. Returns how many rows were authorized.
 */
export async function finalizeCommissionAtClose(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; actorUserId: string },
): Promise<{ autoApproved: number; offersCda: boolean }> {
  const { data: brk } = await svc
    .from("brokerages")
    .select("offers_cda")
    .eq("id", params.brokerageId)
    .maybeSingle()
  const offersCda = (brk as { offers_cda?: boolean } | null)?.offers_cda ?? false

  // Non-CDA: no CDA authorization step exists, so closing the deal authorizes the amount.
  if (offersCda) return { autoApproved: 0, offersCda }

  const nowIso = new Date().toISOString()
  const { data: pending } = await svc
    .from("agent_commissions")
    .select("id")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .eq("status", "pending")
  let autoApproved = 0
  for (const row of (pending ?? []) as Array<{ id: string }>) {
    const { error } = await svc
      .from("agent_commissions")
      .update({ status: "approved", approved_at: nowIso, approved_by: params.actorUserId, updated_at: nowIso })
      .eq("id", row.id)
      .eq("status", "pending")
    if (!error) autoApproved++
  }
  return { autoApproved, offersCda }
}

/**
 * POST-CLOSE: the brokerage RECEIVED the commission deposit at closing. Stamps deposit_received_at on
 * the ledger for the transaction (idempotent — only stamps rows not already marked). This is the
 * ledger's money-tracking step BETWEEN close and disbursement. Best-effort.
 */
export async function recordCommissionDepositReceived(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; actorUserId: string; at?: string },
): Promise<{ stamped: number }> {
  const at = params.at ?? new Date().toISOString()
  const { data, error } = await svc
    .from("agent_commissions")
    .update({ deposit_received_at: at, deposit_received_by: params.actorUserId })
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .is("deposit_received_at", null)
    .select("id")
  if (error) return { stamped: 0 }
  return { stamped: (data ?? []).length }
}

/**
 * THE ONE LOCK AT DISBURSEMENT — the agent was paid, so lock the LEDGER (the agent_commissions
 * summary row + its commission_distributions) to paid together, so the two trackings converge on
 * 'paid' at the SAME real event (disbursement), never at close. Reuses the canonical payment-tracker
 * per ledger row (correct distribution rows + commission.paid event). Idempotent; best-effort.
 *
 * ORPHAN DISTRIBUTIONS. The per-row path filters `.eq('commission_id', …)`, so it can only ever
 * reach distributions the waterfall wrote — those are the only ones that carry a commission_id.
 * Three writers create transaction-level distributions WITHOUT one, and the most important is the
 * agent-to-agent referral fee: the referral-closer books it to the REFERRING agent, who by
 * definition has no agent_commissions row on this deal, so there is no commission_id to give it.
 * Those rows could not be marked paid by ANY path in the system — real money, pending forever,
 * with markDistributionPaid holding no callers to do it by hand.
 *
 * It also broke convergence. The reaper aggregates the ledger side by transaction_id, and
 * aggregateLedgerStatus only returns 'paid' when EVERY live row is paid — so one unreachable row
 * kept the whole transaction reading 'pending' against a paid summary. The drift alarm therefore
 * re-fired on every single pass and could never be healed by the healer it was pointing at.
 *
 * Disbursement is precisely the event that pays these, so this is where they lock.
 */
export async function reconcileCommissionDisbursement(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; actorUserId: string; paidAt?: string },
): Promise<{ ledgerRowsFound: number; ledgerRowsLocked: number; orphanRowsLocked: number }> {
  const paidAt = params.paidAt ?? new Date().toISOString()
  const { data: ledgerRows } = await svc
    .from("agent_commissions")
    .select("id, status")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  const rows = (ledgerRows ?? []) as Array<{ id: string; status: string | null }>
  let locked = 0
  if (rows.length > 0) {
    const { markCommissionPaid } = await import("./payment-tracker")
    for (const row of rows) {
      const status = (row.status ?? "").toLowerCase()
      if (status === "cancelled" || status === "voided") continue
      // A summary row that is ALREADY paid still needs work when its per-line
      // distributions lag behind — that is exactly the drift the reaper heals.
      // Skipping on summary-status alone would make the heal a no-op.
      if (status === "paid") {
        const { data: dists } = await svc
          .from("commission_distributions")
          .select("status")
          .eq("commission_id", row.id)
          .eq("brokerage_id", params.brokerageId)
        const distStatus = aggregateLedgerStatus((dists ?? []) as Array<{ status?: string | null }>)
        if (distStatus == null || distStatus === "paid") continue
      }
      const res = await markCommissionPaid({
        commissionId: row.id,
        brokerageId: params.brokerageId,
        paidBy: params.actorUserId,
        paidAt,
      })
      if (res.success) locked++
    }
  }

  // The rows no commission_id can reach (see the header). Scoped to this transaction and
  // brokerage, never touching a row that is already terminal, so re-running is a no-op.
  let orphanRowsLocked = 0
  const { data: orphans, error: orphanErr } = await svc
    .from("commission_distributions")
    .update({ status: "paid", paid_at: paidAt })
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .is("commission_id", null)
    .not("status", "in", '("paid","voided")')
    .select("id")
  if (orphanErr) {
    console.error("[reconcile-tracking] orphan distribution lock failed:", orphanErr.message)
  } else {
    orphanRowsLocked = (orphans ?? []).length
  }

  return { ledgerRowsFound: rows.length, ledgerRowsLocked: locked, orphanRowsLocked }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AMOUNT RECONCILIATION — summaries are PROJECTIONS of the ledger (wave 104, 104A).
//
// The STATUS reconcile above keeps two trackings of "paid" in lockstep. This half
// asks the other question: do the MUTABLE MONEY SUMMARIES still SAY what the
// distributions ledger (commission_distributions: posted entries + m690
// corrections) and the cost ledgers (ai_tool_usage) actually add up to?
//   · agent_commissions.net_to_agent / net_to_brokerage — waterfall step 11 writes
//     them once; a m690 correction re-stamps them (distribution-correction.ts)
//   · transaction_commissions.calculated_amount (recipient_type 'agent') — the
//     seven-year stamp (ledger-sync.ts)
//   · agents.ytd_gci — the cached earnings number (payment-tracker.ts refreshes it)
//   · brokerage_earnings (annual) — brokerage-earnings-writer.ts's rollup
//   · meter_readings.total_cost_cents (ai_tokens) — usage-metering's period projection
//
// NEVER REWRITES MONEY. A drift is a FINDING: the reaper (commission-tracking-
// reaper.ts reapCommissionAmountDrift) escalates it to finance, the broker brief
// and the finance page show it, and the correction path stays the existing one
// (lib/kernel/financial.ts correctCommissionDistribution — finance-admin gate,
// session tenant, a new ledger row, never an edit). The pure comparator is what
// the proof exercises; the I/O reads only.
// ═══════════════════════════════════════════════════════════════════════════════

export type SummaryProjection =
  | "agent_commissions.net_to_agent"
  | "agent_commissions.net_to_brokerage"
  | "transaction_commissions.calculated_amount"
  | "agents.ytd_gci"
  | "brokerage_earnings.gross_commission_income"
  | "brokerage_earnings.brokerage_net"
  | "meter_readings.total_cost_cents"

export interface SummaryDrift {
  projection: SummaryProjection
  /** The summary row's id (or the agent id for agents.ytd_gci). */
  subjectId: string
  transactionId: string | null
  projectedCents: number
  ledgerCents: number
  deltaCents: number
  /** The ledger rows the recomputation came from. */
  refs: LedgerRef[]
}

/** Rounding slack between a dollars column and a cents recomputation. */
const SUMMARY_DRIFT_TOLERANCE_CENTS = 1

/** PURE: one projection vs its ledger recomputation. Null when they agree within tolerance.
 * @proofSeam the comparator every drift finding comes through; the proof pins its tolerance directly */
export function compareProjection(input: {
  projection: SummaryProjection
  subjectId: string
  transactionId?: string | null
  projectedCents: number
  ledgerCents: number
  refs: LedgerRef[]
  toleranceCents?: number
}): SummaryDrift | null {
  const tol = input.toleranceCents ?? SUMMARY_DRIFT_TOLERANCE_CENTS
  const delta = input.projectedCents - input.ledgerCents
  if (Math.abs(delta) <= tol) return null
  return {
    projection: input.projection, subjectId: input.subjectId, transactionId: input.transactionId ?? null,
    projectedCents: input.projectedCents, ledgerCents: input.ledgerCents, deltaCents: delta, refs: input.refs,
  }
}

const dollarsToCents = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : (v ?? 0)
  return Number.isFinite(n) ? Math.round((n as number) * 100) : 0
}

/**
 * PURE: an agent_commissions summary row vs the distribution rows that carry its
 * commission_id — the same Σ-over-rows rule the correction re-stamp uses
 * (summaryAmountFromDistributions), so the reconciler and the re-stamp cannot
 * disagree about what the summary should read.
 * @proofSeam the per-summary detector the proof drives with fixtures (agreeing + off-by-$5.50 control)
 */
export function detectSummaryAmountDrift(input: {
  summary: { id: string; transaction_id: string | null; net_to_agent: number | string | null; net_to_brokerage: number | string | null }
  distributions: ReadonlyArray<{ id: string; distribution_type: string | null; calculated_amount: number | string | null; status?: string | null; voided_at?: string | null }>
}): SummaryDrift[] {
  const live = input.distributions.filter((d) => (d.status ?? "").toLowerCase() !== "voided" && !d.voided_at)
  const refs: LedgerRef[] = live.map((d) => ({ table: "commission_distributions" as const, id: d.id }))
  const out: SummaryDrift[] = []
  const agentLedger = Math.round(summaryAmountFromDistributions(live, "agent") * 100)
  const brokerageLedger = Math.round(summaryAmountFromDistributions(live, "brokerage") * 100)
  const a = compareProjection({ projection: "agent_commissions.net_to_agent", subjectId: input.summary.id, transactionId: input.summary.transaction_id, projectedCents: dollarsToCents(input.summary.net_to_agent), ledgerCents: agentLedger, refs })
  const b = compareProjection({ projection: "agent_commissions.net_to_brokerage", subjectId: input.summary.id, transactionId: input.summary.transaction_id, projectedCents: dollarsToCents(input.summary.net_to_brokerage), ledgerCents: brokerageLedger, refs })
  if (a) out.push(a)
  if (b) out.push(b)
  return out
}

export interface SummaryReconciliation {
  brokerageId: string
  since: string
  until: string
  checked: number
  drifts: SummaryDrift[]
  /** false when a read was refused — "nobody could read it" never renders as "no drift". */
  measured: boolean
  warnings: string[]
}

/**
 * READ-ONLY. Recompute every mutable money summary in the window from the ledger
 * (through the economic graph) and report drift. Pass a graph already loaded by
 * the surface to avoid a second read; the YTD-keyed projections (agents.ytd_gci,
 * brokerage_earnings annual) are compared only when the window IS year-to-date,
 * because they are defined on that window and nothing else.
 */
export async function reconcileSummariesAgainstLedger(
  svc: Svc,
  params: { brokerageId: string; graph?: EconomicGraph; sinceIso?: string; untilIso?: string },
): Promise<SummaryReconciliation> {
  const { loadEconomicGraph } = await import("@/lib/kernel/economic-graph")
  const graph = params.graph ?? await loadEconomicGraph(svc, { brokerageId: params.brokerageId, sinceIso: params.sinceIso, untilIso: params.untilIso })
  const { brokerageId } = params
  const warnings = [...graph.warnings]
  let measured = graph.measured
  const drifts: SummaryDrift[] = []
  let checked = 0
  const refuse = (what: string, msg: string) => { measured = false; warnings.push(`${what} read refused: ${msg}`) }
  const txnIds = graph.transactions.map((t) => t.transactionId)
  const byTxn = new Map(graph.transactions.map((t) => [t.transactionId, t]))

  if (txnIds.length > 0) {
    // agent_commissions nets vs Σ distribution rows of that commission_id.
    const [sumRes, distRes, stampRes] = await Promise.all([
      svc.from("agent_commissions").select("id, transaction_id, agent_id, net_to_agent, net_to_brokerage").eq("brokerage_id", brokerageId).in("transaction_id", txnIds),
      svc.from("commission_distributions").select("id, commission_id, distribution_type, calculated_amount, status, voided_at").eq("brokerage_id", brokerageId).in("transaction_id", txnIds).not("commission_id", "is", null),
      svc.from("transaction_commissions").select("id, transaction_id, recipient_id, recipient_type, calculated_amount").eq("brokerage_id", brokerageId).eq("recipient_type", "agent").in("transaction_id", txnIds),
    ])
    if (sumRes.error) refuse("agent_commissions", sumRes.error.message)
    if (distRes.error) refuse("commission_distributions", distRes.error.message)
    if (stampRes.error) refuse("transaction_commissions", stampRes.error.message)
    const distsByCommission = new Map<string, Array<{ id: string; distribution_type: string | null; calculated_amount: number | string | null; status?: string | null; voided_at?: string | null }>>()
    for (const d of (distRes.data ?? []) as Array<Record<string, any>>) {
      const list = distsByCommission.get(d.commission_id) ?? []
      list.push({ id: d.id, distribution_type: d.distribution_type, calculated_amount: d.calculated_amount, status: d.status, voided_at: d.voided_at })
      distsByCommission.set(d.commission_id, list)
    }
    const agentNetBySummary = new Map<string, number>()
    for (const s of (sumRes.data ?? []) as Array<Record<string, any>>) {
      const rows = distsByCommission.get(s.id) ?? []
      if (rows.length === 0) continue // bridge-only summary (manual entry) — a leak concern, not amount drift
      checked++
      drifts.push(...detectSummaryAmountDrift({ summary: { id: s.id, transaction_id: s.transaction_id, net_to_agent: s.net_to_agent, net_to_brokerage: s.net_to_brokerage }, distributions: rows }))
      agentNetBySummary.set(`${s.transaction_id}|${s.agent_id}`, Math.round(summaryAmountFromDistributions(rows.filter((r) => (r.status ?? "") !== "voided" && !r.voided_at), "agent") * 100))
    }
    // The seven-year stamp (agent recipient) vs the same ledger figure.
    for (const st of (stampRes.data ?? []) as Array<Record<string, any>>) {
      const ledger = agentNetBySummary.get(`${st.transaction_id}|${st.recipient_id}`)
      if (ledger == null) continue
      checked++
      const d = compareProjection({ projection: "transaction_commissions.calculated_amount", subjectId: st.id, transactionId: st.transaction_id, projectedCents: dollarsToCents(st.calculated_amount), ledgerCents: ledger, refs: byTxn.get(st.transaction_id)?.evidence.filter((r) => r.table === "commission_distributions") ?? [] })
      if (d) drifts.push(d)
    }
  }

  // YTD-defined projections, only on a YTD window.
  const ytdStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString().slice(0, 10)
  if (graph.since.slice(0, 10) === ytdStart) {
    const { data: agentRows, error: agentErr } = await svc.from("agents").select("id, ytd_gci").eq("brokerage_id", brokerageId).eq("is_active", true).limit(5000)
    if (agentErr) refuse("agents", agentErr.message)
    else for (const a of (agentRows ?? []) as Array<{ id: string; ytd_gci: number | string | null }>) {
      const node = graph.byAgent.find((n) => n.key === a.id)
      const ledgerGross = node?.grossCents ?? 0
      if (ledgerGross === 0 && dollarsToCents(a.ytd_gci) === 0) continue
      checked++
      const refs = graph.transactions.filter((t) => t.agentId === a.id).flatMap((t) => t.evidence.filter((r) => r.table === "commission_calculations"))
      const d = compareProjection({ projection: "agents.ytd_gci", subjectId: a.id, projectedCents: dollarsToCents(a.ytd_gci), ledgerCents: ledgerGross, refs })
      if (d) drifts.push(d)
    }
    const { data: earnRows, error: earnErr } = await svc.from("brokerage_earnings").select("id, gross_commission_income, brokerage_net").eq("brokerage_id", brokerageId).eq("period_type", "annual").order("computed_at", { ascending: false }).limit(1)
    if (earnErr) refuse("brokerage_earnings", earnErr.message)
    else for (const e of (earnRows ?? []) as Array<Record<string, any>>) {
      checked += 2
      const refs = graph.transactions.flatMap((t) => t.evidence.filter((r) => r.table === "commission_calculations"))
      const g = compareProjection({ projection: "brokerage_earnings.gross_commission_income", subjectId: e.id, projectedCents: dollarsToCents(e.gross_commission_income), ledgerCents: graph.brokerage.grossCents, refs })
      const n = compareProjection({ projection: "brokerage_earnings.brokerage_net", subjectId: e.id, projectedCents: dollarsToCents(e.brokerage_net), ledgerCents: graph.brokerage.brokerageShareCents, refs })
      if (g) drifts.push(g)
      if (n) drifts.push(n)
    }
  }

  // meter_readings (ai_tokens) vs Σ ai_tool_usage.cost_cents over the reading's own period.
  const { data: meters, error: meterErr } = await svc.from("meter_readings").select("id, meter_type, period_start, period_end, total_cost_cents").eq("brokerage_id", brokerageId).eq("meter_type", "ai_tokens").gte("period_end", graph.since.slice(0, 10)).limit(50)
  if (meterErr) refuse("meter_readings", meterErr.message)
  else for (const m of (meters ?? []) as Array<Record<string, any>>) {
    const { data: usage, error: usageErr } = await svc.from("ai_tool_usage").select("id, cost_cents").eq("brokerage_id", brokerageId).gte("created_at", m.period_start).lt("created_at", m.period_end).limit(20000)
    if (usageErr) { refuse("ai_tool_usage", usageErr.message); continue }
    checked++
    const rows = (usage ?? []) as Array<{ id: string; cost_cents: number | null }>
    const d = compareProjection({ projection: "meter_readings.total_cost_cents", subjectId: m.id, projectedCents: Math.round(Number(m.total_cost_cents) || 0), ledgerCents: rows.reduce((s, r) => s + Math.round(Number(r.cost_cents) || 0), 0), refs: rows.map((r) => ({ table: "ai_tool_usage" as const, id: r.id })) })
    if (d) drifts.push(d)
  }

  return { brokerageId, since: graph.since, until: graph.until, checked, drifts, measured, warnings }
}
