// lib/transactions/auto-execute-offer.ts
// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMOUS "fully executed → under contract" loop. The business rule: once BOTH sides of an offer
// are signed AND the compliance scan confirms every required document for that sale type is present
// and fully signed/initialed, a transaction is created and marked under contract — WITHOUT a manual
// "submit to compliance" click. The listing side already did this on seller-accept; this closes the
// SAME loop for the buyer side at the two moments an offer becomes fully executed (counter signed
// back via the e-sign webhook, or the agent records the seller's acceptance).
//
// NO new workflow / scanner / table: this REUSES the existing comprehensive chokepoint
// submitOfferToCompliance (brokerage-required-docs audit + packet signature/initial scan + stamp
// compliance_passed_at + createTransactionFromOffer → milestones + under_contract). That function
// SELF-GATES — if the scan finds missing docs/signatures it creates NO transaction and fans out a
// compliance flag showing exactly what's missing. So this trigger is safe + idempotent (the bridge
// refuses when a transaction already exists). Best-effort; never throws into its caller (a webhook).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { shouldAutoExecuteOffer } from "./offer-execution-state"

type Svc = ReturnType<typeof createServiceClient>

export interface AutoExecuteResult {
  attempted: boolean
  created: boolean
  transactionId?: string
  reason?: string
}

/**
 * autoExecuteFullySignedOffer — when an offer reaches fully-executed, run the compliance scan and,
 * on pass, create the transaction (under contract). Resolves the responsible agent automatically so
 * no human click is required. Publishes a Deal Coordinator bus signal so the handoff is visible on
 * the Command Center "managers talking" feed.
 */
export async function autoExecuteFullySignedOffer(
  offerId: string,
  client?: Svc,
): Promise<AutoExecuteResult> {
  const svc = client ?? createServiceClient()
  if (!offerId) return { attempted: false, created: false, reason: "no offer id" }

  // `buyer_signed_at` IS LOAD-BEARING IN THIS SELECT and was missing from it.
  // shouldAutoExecuteOffer → isOfferFullyExecuted now reads the buyer leg (the
  // owner's "fully executed by both buyer and seller"); a column left out of the
  // select arrives `undefined`, which the predicate reads as "not signed", and
  // the whole autonomous loop would have gone permanently and SILENTLY dead —
  // returning "offer not fully executed" for every offer forever. A predicate
  // that cannot see the column it judges is CLAUDE.md §2's blind guard.
  const { data: offer } = await svc.from("offers")
    .select("id, brokerage_id, agent_id, contact_id, property_address, transaction_id, buyer_signed_at, seller_response_type, seller_signed_at, fully_signed_contract_received_at")
    .eq("id", offerId).maybeSingle()
  const o = offer as {
    id: string; brokerage_id: string; agent_id: string | null; contact_id: string | null
    property_address: string | null; transaction_id: string | null; buyer_signed_at: string | null
    seller_response_type: string | null; seller_signed_at: string | null; fully_signed_contract_received_at: string | null
  } | null
  if (!o) return { attempted: false, created: false, reason: "offer not found" }

  // PURE gate — only fire when fully executed AND not already converted.
  if (!shouldAutoExecuteOffer(o)) {
    return { attempted: false, created: false, reason: o.transaction_id ? "transaction already exists" : "offer not fully executed" }
  }

  // Resolve the responsible agent's users.id (the audit + activities are attributed to them).
  let agentUserId: string | null = null
  if (o.agent_id) {
    const { data: a } = await svc.from("agents").select("user_id").eq("id", o.agent_id).maybeSingle()
    agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
  }
  if (!agentUserId) return { attempted: false, created: false, reason: "no responsible agent to attribute compliance to" }

  // Run the EXISTING comprehensive compliance + transaction creation (self-gating + idempotent).
  let created = false, transactionId: string | undefined, reason: string | undefined
  try {
    const { submitOfferToCompliance } = await import("@/app/actions/buyer-offer/submit-to-compliance")
    const r = await submitOfferToCompliance({ offerId, userId: agentUserId })
    created = !!r.transaction_id
    transactionId = r.transaction_id
    if (!created) {
      reason = r.error ?? "compliance scan blocked transaction creation"
    }
  } catch (err) {
    reason = (err as Error).message
  }

  // Deal Coordinator bus handoff — visible on the Command Center "managers talking" feed.
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId: o.brokerage_id, fromManager: "deal_coordinator", toManager: "deal_coordinator",
      signalType: "offer_docs_ready",
      message: created
        ? `Offer fully executed for ${o.property_address ?? "a property"} — compliance passed, transaction created and marked under contract.`
        : `Offer fully executed for ${o.property_address ?? "a property"} but compliance is not clear yet: ${reason ?? "missing required documents"}.`,
      entityType: "offer", entityId: o.id, contactId: o.contact_id ?? null,
      payload: { autoExecuted: created, transactionId: transactionId ?? null },
    }, svc)
  } catch { /* best-effort feed write */ }

  return { attempted: true, created, transactionId, reason }
}
