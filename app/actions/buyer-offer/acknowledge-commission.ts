"use server"

/**
 * Buyer-side commission disclosure acknowledgment.
 *
 * NAR 2024 settlement: the buyer must explicitly acknowledge the compensation
 * their agent will receive BEFORE the offer is submitted. This is distinct
 * from the BBA (representation agreement) — disclosure is per-offer because
 * the seller's offered comp can differ from BBA terms.
 *
 * Flow:
 *   1. createBuyerOffer (existing) writes the offer draft + BBA gate (Commit H).
 *   2. Agent fills in disclosed commission terms on the offer.
 *   3. Buyer reviews + ACKNOWLEDGES via click_through (this action).
 *   4. submit-for-signature gate requires acknowledged_at IS NOT NULL.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { resolveESignProviderForActor } from "@/lib/integrations/resolve-esign-provider"
import {
  validateCommissionDisclosure, resolveDisclosureMethod, isEsignDispatchMethod,
  type CommissionPayer, type DisclosureMethod,
} from "@/lib/offers/commission-disclosure"

export interface AcknowledgeCommissionInput {
  offerId: string
  disclosedBuyerCommissionPct?:  number
  disclosedBuyerCommissionFlat?: number
  disclosedCommissionPayer:      CommissionPayer
  disclosedCommissionNotes?:     string
  affirmativeConsent:            boolean
  /** Buyer self-ack → 'click_through'. Agent-recorded → 'wet_signature' (on file) or
   *  'esign' (dispatched via the brokerage's connected provider, resolved server-side). */
  disclosureMethod?:             DisclosureMethod
}

export async function acknowledgeBuyerCommissionAction(
  input: AcknowledgeCommissionInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const svc = createServiceClient()

  // Verify caller is the buyer OR an agent on the offer's brokerage
  const { data: offer } = await svc
    .from("offers")
    .select("id, contact_id, brokerage_id, status, buyer_commission_acknowledged_at")
    .eq("id", input.offerId)
    .maybeSingle()
  if (!offer) return { ok: false, error: "Offer not found" }
  if (offer.buyer_commission_acknowledged_at) {
    return { ok: false, error: "Commission already acknowledged on this offer" }
  }
  if (offer.status !== "draft" && offer.status !== "pending_buyer_review") {
    return { ok: false, error: `Cannot acknowledge — offer status is ${offer.status}` }
  }

  // Authorize: buyer can self-ack (via contacts.user_id linkage); agent can
  // record on buyer's behalf (typically with wet sig / DocuSign).
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const isBuyer = await svc
    .from("contacts")
    .select("user_id")
    .eq("id", offer.contact_id)
    .maybeSingle()
    .then(r => r.data?.user_id === user.id)

  const isAuthorizedAgent =
    profile?.brokerage_id === offer.brokerage_id
    // SCOPE LADDER (kept inline — admits agent/tc/team_lead): 'superadmin'
    // removed — dead as users.user_type (0 live rows); broker_owner added.
    && ["broker","broker_owner","broker_admin","admin","team_lead","agent","tc"].includes(profile?.user_type ?? "")

  if (!isBuyer && !isAuthorizedAgent) {
    return { ok: false, error: "Only the buyer or an authorized agent can acknowledge" }
  }

  // NAR-2024 disclosure validation (consent + explicit comp terms + payer, and an
  // agent recording on the buyer's behalf may not use the buyer's self-click path).
  const validationError = validateCommissionDisclosure(input, isBuyer)
  if (validationError) return { ok: false, error: validationError }

  const hdrs = await headers()
  let method = resolveDisclosureMethod(input.disclosureMethod, isBuyer)

  // If method is docusign/dotloop, dispatch through the brokerage's configured
  // e-sign provider so the buyer receives an actual signing email through the
  // platform they expect. The provider's webhook will update signed_at when the
  // buyer signs; click_through and wet_signature are recorded inline below.
  if (isEsignDispatchMethod(method)) {
    try {
      // user → team → brokerage cascade — agent's own DocuSign/Dotloop wins
      const resolved = await resolveESignProviderForActor({
        brokerageId: offer.brokerage_id,
        userId:      user.id,
      })
      // Look up buyer's email for the signer
      const { data: buyer } = await svc
        .from("contacts")
        .select("first_name, last_name, email")
        .eq("id", offer.contact_id)
        .maybeSingle()
      if (!buyer?.email) {
        return { ok: false, error: "Buyer contact has no email — cannot dispatch e-sign request" }
      }
      const tx = await resolved.provider.createTransaction({
        propertyAddress: `Commission disclosure — offer ${input.offerId.slice(0, 8)}`,
        transactionType: "purchase",
        contactId:       offer.contact_id,
      })
      if (!tx.success || !tx.externalTransactionId) {
        return { ok: false, error: tx.error ?? "E-sign provider createTransaction failed" }
      }
      const send = await resolved.provider.sendForSignature({
        externalTransactionId: tx.externalTransactionId,
        documentId:            input.offerId,
        signers: [{
          email: buyer.email as string,
          name:  [buyer.first_name, buyer.last_name].filter(Boolean).join(" ") || "Buyer",
          role:  "buyer",
        }],
        message: `Please review and acknowledge the commission terms for this offer.`,
      })
      if (!send.success) {
        return { ok: false, error: send.error ?? "E-sign provider sendForSignature failed" }
      }
      method = resolved.providerName === "dotloop" ? "dotloop" : "docusign"
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "E-sign dispatch failed" }
    }
  }

  const ackUpdate = {
    buyer_commission_acknowledged_at:  new Date().toISOString(),
    buyer_commission_acknowledged_ip:  isBuyer ? (hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip")) : null,
    buyer_commission_acknowledged_ua:  isBuyer ? hdrs.get("user-agent") : null,
    disclosed_buyer_commission_pct:    input.disclosedBuyerCommissionPct ?? null,
    disclosed_buyer_commission_flat:   input.disclosedBuyerCommissionFlat ?? null,
    disclosed_commission_payer:        input.disclosedCommissionPayer,
    disclosed_commission_notes:        input.disclosedCommissionNotes ?? null,
    commission_disclosure_method:      method,
  }
  const { error } = await svc
    .from("offers")
    .update(ackUpdate)
    .eq("id", input.offerId)
    // tenant anchor (scope burn-down): write pinned to the validated offer's brokerage
    .eq("brokerage_id", offer.brokerage_id)

  if (error) return { ok: false, error: error.message }

  revalidatePath(`/dashboard/offers/${input.offerId}`)
  revalidatePath("/portal")
  return { ok: true }
}
