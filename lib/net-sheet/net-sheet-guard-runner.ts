// lib/net-sheet/net-sheet-guard-runner.ts
//
// Live side of the NET-SHEET SURPRISE GUARD. When a deal's FINAL settlement statement /
// Closing Disclosure lands, reconcile the seller's ACTUAL net against the net we PROMISED
// at offer time (offers.seller_net_estimate) and, on a material negative surprise, arm the
// Deal Coordinator to explain it BEFORE the seller feels blindsided: a gated agent alert
// (notification) + an inter-manager bus signal (deal_coordinator → listing_concierge, who
// owns the seller relationship). Every reconciliation is recorded (net_sheet_reconciliations)
// for audit + idempotency. Read-only on the deal; never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import {
  reconcileNetSheet,
  composeSurpriseFallback,
  actualSignature,
  type NetSheetFigures,
  type NetSheetReconciliation,
} from "./net-sheet-reconciler"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface NetSheetGuardInput {
  brokerageId: string
  transactionId: string
  /** agent to alert (users.id); defaults to the transaction's agent_id */
  agentUserId?: string | null
  /** override the estimate (the simulator passes a known estimate) */
  estimateOverride?: NetSheetFigures
  /** override the actuals (else parsed off the settlement statement document) */
  actualOverride?: NetSheetFigures
  copyGenerator?: CopyGenerator
  escalate?: boolean
}

export interface NetSheetGuardResult {
  recon: NetSheetReconciliation
  /** true when a negative surprise was flagged AND escalated */
  escalated: boolean
  /** true when this settlement was already reconciled (idempotent no-op) */
  alreadyReconciled: boolean
  reconciliationId?: string
  notificationId?: string
}

/** Tolerant parser: pull net-sheet figures off a settlement-statement document's
 *  extracted_data JSON. Settlement statements vary wildly, so we read a generous set of
 *  common keys and never fabricate a line that isn't there. */
export function parseSettlementFigures(extracted: Record<string, unknown> | null | undefined): NetSheetFigures {
  if (!extracted || typeof extracted !== "object") return {}
  const e = extracted as Record<string, unknown>
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = e[k]
      if (typeof v === "number" && Number.isFinite(v)) return v
      if (typeof v === "string") {
        const n = Number(v.replace(/[^0-9.\-]/g, ""))
        if (Number.isFinite(n) && v.replace(/[^0-9.\-]/g, "") !== "") return n
      }
    }
    return undefined
  }
  return {
    netProceeds: pick("seller_net", "net_to_seller", "cash_to_seller", "seller_net_proceeds", "net_proceeds", "proceeds_to_seller"),
    salePrice: pick("sale_price", "contract_price", "purchase_price", "gross_sale_price"),
    commission: pick("commission", "total_commission", "real_estate_commission", "broker_commission"),
    mortgagePayoff: pick("mortgage_payoff", "payoff", "loan_payoff", "existing_loan_payoff"),
    taxesProration: pick("property_taxes", "tax_proration", "county_taxes", "taxes"),
    hoaProration: pick("hoa_dues", "hoa_proration", "hoa"),
    buyerCredit: pick("buyer_credit", "seller_concession", "closing_cost_credit", "buyer_closing_credit"),
    titleEscrow: pick("title_fees", "escrow_fees", "title_escrow", "settlement_fees"),
    otherCosts: pick("other_costs", "other_fees", "misc_fees"),
  }
}

async function loadEstimate(svc: Svc, brokerageId: string, txn: any, override?: NetSheetFigures): Promise<NetSheetFigures | null> {
  if (override) return override
  // The promised net lives on the winning/linked offer (offers.seller_net_estimate).
  const { data: offers } = await svc
    .from("offers")
    .select("id, offer_price, closing_cost_contribution, seller_net_estimate, is_winning_offer, status")
    .eq("brokerage_id", brokerageId)
    .or(`transaction_id.eq.${txn.id}${txn.offer_id ? `,id.eq.${txn.offer_id}` : ""}`)
    .limit(20)
  const list = (offers ?? []) as any[]
  if (list.length === 0) return null
  const winner = list.find((o) => o.is_winning_offer) ?? list.find((o) => o.id === txn.offer_id) ?? list[0]
  const net = winner.seller_net_estimate != null ? Number(winner.seller_net_estimate) : null
  if (net == null) return null
  return {
    netProceeds: net,
    salePrice: winner.offer_price != null ? Number(winner.offer_price) : undefined,
    buyerCredit: winner.closing_cost_contribution != null ? Number(winner.closing_cost_contribution) : undefined,
  }
}

async function loadActual(svc: Svc, txn: any, override?: NetSheetFigures): Promise<NetSheetFigures | null> {
  if (override) return override
  const { data: docs } = await svc
    .from("transaction_documents")
    .select("id, doc_type, extracted_data, created_at")
    .eq("transaction_id", txn.id)
    .in("doc_type", ["final_settlement_statement", "closing_disclosure"])
    .order("created_at", { ascending: false })
    .limit(1)
  const doc = (docs ?? [])[0] as any
  if (!doc) return null
  const figures = parseSettlementFigures(doc.extracted_data)
  // Nothing parseable → no actuals.
  if (figures.netProceeds == null && figures.salePrice == null) return null
  return figures
}

/** Reconcile a deal's final settlement net against the estimate; escalate a surprise. */
export async function runNetSheetSurpriseGuard(input: NetSheetGuardInput, client?: Svc): Promise<NetSheetGuardResult> {
  const svc = client ?? createServiceClient()

  const { data: txn } = await svc
    .from("transactions")
    .select("id, brokerage_id, agent_id, offer_id, seller_contact_id, property_address")
    .eq("id", input.transactionId)
    .maybeSingle()

  const empty = (reason: string): NetSheetGuardResult => ({
    recon: {
      reconciled: false, reason, estimatedNet: null, actualNet: null, varianceAmount: null,
      variancePct: null, surpriseLevel: "none", lineDeltas: [], topDriver: null, flagged: false,
    },
    escalated: false, alreadyReconciled: false,
  })

  if (!txn) return empty("Transaction not found.")
  const t = txn as any

  const estimate = await loadEstimate(svc, input.brokerageId, t, input.estimateOverride)
  if (!estimate) return empty("No estimated net on file to reconcile against.")
  const actual = await loadActual(svc, t, input.actualOverride)
  if (!actual) return empty("No actual settlement net available yet.")

  const recon = reconcileNetSheet(estimate, actual)
  if (!recon.reconciled) return { recon, escalated: false, alreadyReconciled: false }

  // IDEMPOTENCY: one reconciliation per (transaction, settlement signature). A corrected
  // statement (new signature) re-triggers; the same statement is a no-op.
  const sig = actualSignature(actual)
  const { data: prior } = await svc
    .from("net_sheet_reconciliations")
    .select("id, settlement_signature")
    .eq("transaction_id", t.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (prior && (prior as any).settlement_signature === sig) {
    return { recon, escalated: false, alreadyReconciled: true, reconciliationId: (prior as any).id }
  }

  const shouldEscalate = recon.flagged && input.escalate !== false
  let escalated = false
  let notificationId: string | undefined

  if (shouldEscalate) {
    const agentUserId = input.agentUserId ?? t.agent_id ?? null
    const fallback = composeSurpriseFallback({ propertyAddress: t.property_address ?? "your listing", recon })
    const draft = await generatePersonaCopy(
      {
        goal: "a short internal alert to the listing agent that the final settlement net differs materially from the seller's estimated net, with the top driver, so the agent can reconcile with title and get ahead of the seller conversation",
        facts: [
          recon.reason,
          recon.topDriver && recon.topDriver.delta != null
            ? `Top driver: ${recon.topDriver.label} (${recon.topDriver.delta >= 0 ? "+" : ""}${Math.round(recon.topDriver.delta)})`
            : "",
        ].filter(Boolean) as string[],
        channel: "portal",
        persona: { audience: "agent", situation: "final net sheet differs from estimate" },
        words: 60,
      },
      { body: fallback },
      { generator: input.copyGenerator },
    )

    try {
      if (agentUserId) {
        const { data: notif } = await svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: input.brokerageId, type: "net_sheet_surprise",
          title: recon.surpriseLevel === "severe" ? "⚠️ Net-sheet surprise — final net is materially short" : "Net-sheet variance — reconcile before closing",
          body: draft.body, entity_type: "transaction", entity_id: t.id,
          priority: recon.surpriseLevel === "severe" ? "critical" : "high",
        }).select("id").single()
        notificationId = (notif as any)?.id
      }
      // The Deal Coordinator hands the seller conversation to the Listing Concierge.
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const sigPub = await publishManagerSignal({
        brokerageId: input.brokerageId, fromManager: "deal_coordinator", toManager: "listing_concierge",
        signalType: "net_sheet_surprise", message: draft.body,
        entityType: "transaction", entityId: t.id,
        payload: {
          surpriseLevel: recon.surpriseLevel, varianceAmount: recon.varianceAmount, variancePct: recon.variancePct,
          estimatedNet: recon.estimatedNet, actualNet: recon.actualNet,
          topDriver: recon.topDriver ? { key: recon.topDriver.key, delta: recon.topDriver.delta } : null,
        },
      }, svc)
      escalated = !!notificationId || sigPub.ok
    } catch { /* escalation best-effort — the verdict + record still land */ }
  }

  // RECORD the reconciliation (audit + idempotency), regardless of escalation.
  let reconciliationId: string | undefined
  try {
    const { data: rec } = await svc.from("net_sheet_reconciliations").insert({
      brokerage_id: input.brokerageId, transaction_id: t.id, offer_id: t.offer_id ?? null,
      estimated_net: recon.estimatedNet, actual_net: recon.actualNet,
      variance_amount: recon.varianceAmount, variance_pct: recon.variancePct,
      surprise_level: recon.surpriseLevel, line_item_deltas: recon.lineDeltas,
      settlement_signature: sig, escalated,
    }).select("id").single()
    reconciliationId = (rec as any)?.id
  } catch { /* record best-effort */ }

  return { recon, escalated, alreadyReconciled: false, reconciliationId, notificationId }
}
