import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { createServiceClient } from "@/lib/supabase/service"
import { dollarsToCents } from "../utils"
import { agreementAsOf, loadAgentAgreementAsOf } from "../agreement-terms"
import type { WaterfallContext } from "../types"

type Svc = ReturnType<typeof createServiceClient>

/** listing_agreements.esign_status values that mean the seller's agreement is EXECUTED (the live CHECK's executed members). */
const LISTING_AGREEMENT_EXECUTED = new Set(["fully_signed", "fully_executed", "compliance_pending", "compliance_approved"])

const states = (...vs: unknown[]) => vs.some((v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)))

/**
 * The deal's EXECUTED client agreements and whether each states a commission rate (WAVE 145, owner ruling 4). Read only when
 * the brokerage default would price the deal. A refused read is a finding that makes the rate UNPROVABLE (the engine then
 * refuses a final), never "no agreement". Module-private: reached through resolveGrossRate.
 */
async function governingClientAgreementRates(
  supabase: Svc,
  brokerageId: string,
  txn: { listing_id?: string | null; buyer_contact_id?: string | null },
): Promise<{ governingClientAgreements: Array<{ kind: "listing_agreement" | "buyer_broker_agreement"; id: string; statesRate: boolean }>; findings: string[] }> {
  const out: Array<{ kind: "listing_agreement" | "buyer_broker_agreement"; id: string; statesRate: boolean }> = []
  const findings: string[] = []
  if (txn.listing_id) {
    const { data, error } = await supabase
      .from("listing_agreements")
      .select("id, esign_status, fully_executed_at, total_commission_rate, listing_commission_rate, commission_flat_amount")
      .eq("brokerage_id", brokerageId)
      .eq("listing_id", txn.listing_id)
    if (error) findings.push(`the listing agreement could not be read (${error.message}) — the deal's governing rate is unprovable`)
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      if (!LISTING_AGREEMENT_EXECUTED.has(String(r.esign_status ?? "")) && !r.fully_executed_at) continue
      out.push({ kind: "listing_agreement", id: String(r.id), statesRate: states(r.total_commission_rate, r.listing_commission_rate, r.commission_flat_amount) })
    }
  }
  if (txn.buyer_contact_id) {
    const { data, error } = await supabase
      .from("buyer_broker_agreements")
      .select("id, status, signed_at, commission_percentage, commission_flat_amount")
      .eq("brokerage_id", brokerageId)
      .eq("buyer_contact_id", txn.buyer_contact_id)
      .eq("status", "active")
    if (error) findings.push(`the buyer-broker agreement could not be read (${error.message}) — the deal's governing rate is unprovable`)
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      if (!r.signed_at) continue
      out.push({ kind: "buyer_broker_agreement", id: String(r.id), statesRate: states(r.commission_percentage, r.commission_flat_amount) })
    }
  }
  const stating = out.filter((a) => a.statesRate)
  if (stating.length > 0) {
    findings.push(`the executed ${stating.map((a) => `${a.kind.replace(/_/g, " ")} ${a.id}`).join(" and ")} states the commission, but the deal records no rate of its own — the brokerage default is NOT applied over a signed agreement; record the deal's commission rate from the agreement`)
  }
  return { governingClientAgreements: out, findings }
}

export async function resolveGrossRate(
  transactionId: string,
  brokerageId: string
): Promise<WaterfallContext> {
  const supabase = createServiceClient()
  
  const { data: transaction, error: transactionError } = await supabase
    .from("transactions")
    .select("agent_id, commission_percentage, purchase_price, close_date, estimated_close_date, contract_date, listing_id, buyer_contact_id")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // supabase-js RESOLVES a refusal — a swallowed one reads as "transaction not found" (CLAUDE.md §3).
  if (transactionError) {
    throw new Error(`[commission-engine:resolve-rate] Transaction ${transactionId} read refused: ${transactionError.message}`)
  }
  
  if (!transaction) {
    throw new Error(`[commission-engine:resolve-rate] Transaction ${transactionId} not found`)
  }
  
  if (!transaction.agent_id) {
    throw new Error(`[commission-engine:resolve-rate] Transaction ${transactionId} has no agent assigned`)
  }
  
  // WAVE 143 (lane 143C) — THE AGREEMENT IN FORCE ON THE DEAL'S DATE, not today's profile. The agent's split,
  // fees and caps come from the version applicable to the transaction's period (close_date, else the dates
  // lib/commission/agreement-terms.ts agreementAsOf names), and the resolution rides the context so stage 08
  // (team terms), stage 10 (fees) and stage 11 (the engine_inputs snapshot) all price the SAME agreement.
  const asOf = agreementAsOf(transaction, new Date().toISOString().slice(0, 10))
  const agreement = await loadAgentAgreementAsOf(supabase, { brokerageId, agentId: transaction.agent_id, asOf })
  for (const f of agreement.findings) console.warn(`[commission-engine:agreement] ${transactionId}: ${f}`)

  const structure = await getDefaultCommissionStructure(
    brokerageId,
    transaction.agent_id,
    transaction.commission_percentage ?? undefined,
    agreement.terms,
  )

  // WAVE 145 (lane 145C; owner ruling 4: "no platform-default percentages when a signed agreement governs"): the brokerage's
  // default rate prices a deal ONLY when no EXECUTED client agreement on the deal states a rate. When one does and the deal
  // records no rate of its own (transactions.commission_percentage), the engine does not pick a number for it — the evidence
  // names the agreement and the engine refuses a FINAL by name (lib/commission/engine.ts); a preview carries the finding.
  const grossRateEvidence = structure.resolvedFrom === "brokerage_default"
    ? await governingClientAgreementRates(supabase, brokerageId, transaction as { listing_id?: string | null; buyer_contact_id?: string | null })
    : { governingClientAgreements: [], findings: [] as string[] }

  return {
    transactionId,
    brokerageId,
    agentId: transaction.agent_id,
    purchasePriceCents: dollarsToCents(transaction.purchase_price),
    grossRateDecimal: structure.resolvedGrossRateDecimal,
    agentSplitPercent: structure.splitDecimal * 100,
    resolvedFrom: structure.resolvedFrom,
    agreement,
    grossRateEvidence: { from: structure.resolvedFrom, ...grossRateEvidence },
    grossCommissionCents: 0,
    adjustedGrossCents: 0,
    agentPortionCents: 0,
    brokeragePortionCents: 0,
    agentNetCents: 0,
    brokerageFinalCents: 0,
    agentFinalNetCents: 0,
    totalFeesCents: 0,
    capApplied: false,
    capStatus: 'n/a',
    amountTowardsCap: 0,
    grossAdjustments: [],
    agentAdjustments: [],
    brokerageAdjustments: [],
    teamDistributions: [],
    revenueShareDistributions: [],
    feeDistributions: []
  }
}
