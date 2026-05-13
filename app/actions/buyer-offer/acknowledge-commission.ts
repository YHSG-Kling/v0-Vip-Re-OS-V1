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

export interface AcknowledgeCommissionInput {
  offerId: string
  disclosedBuyerCommissionPct?:  number
  disclosedBuyerCommissionFlat?: number
  disclosedCommissionPayer:      "seller" | "buyer" | "split" | "either"
  disclosedCommissionNotes?:     string
  affirmativeConsent:            boolean
  /** When the agent records the acknowledgment via wet sig / DocuSign instead of
   *  the buyer self-clicking, set this. Else 'click_through'. */
  disclosureMethod?:             "click_through" | "wet_signature" | "docusign" | "dotloop"
}

export async function acknowledgeBuyerCommissionAction(
  input: AcknowledgeCommissionInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.affirmativeConsent) {
    return { ok: false, error: "Buyer must affirmatively acknowledge the commission terms" }
  }
  if (!input.disclosedBuyerCommissionPct && !input.disclosedBuyerCommissionFlat) {
    return { ok: false, error: "Commission percentage or flat amount required (NAR 2024 — explicit comp terms mandatory)" }
  }
  if (!input.disclosedCommissionPayer) {
    return { ok: false, error: "Commission payer required (seller / buyer / split / either)" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const svc = createServiceClient()

  // Verify caller is the buyer OR an agent on the offer's brokerage
  const { data: offer } = await svc
    .from("offers")
    .select("id, buyer_id, brokerage_id, status, buyer_commission_acknowledged_at")
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
    .eq("id", offer.buyer_id)
    .maybeSingle()
    .then(r => r.data?.user_id === user.id)

  const isAuthorizedAgent =
    profile?.brokerage_id === offer.brokerage_id
    && ["broker","broker_admin","admin","superadmin","team_lead","agent","tc"].includes(profile?.user_type ?? "")

  if (!isBuyer && !isAuthorizedAgent) {
    return { ok: false, error: "Only the buyer or an authorized agent can acknowledge" }
  }

  // If agent is recording, force a disclosureMethod different from 'click_through'
  if (!isBuyer && (input.disclosureMethod ?? "click_through") === "click_through") {
    return { ok: false, error: "Agent must record acknowledgment via wet_signature, docusign, or dotloop" }
  }

  const hdrs = await headers()
  const method = input.disclosureMethod ?? (isBuyer ? "click_through" : "wet_signature")

  const { error } = await svc
    .from("offers")
    .update({
      buyer_commission_acknowledged_at:  new Date().toISOString(),
      buyer_commission_acknowledged_ip:  isBuyer ? (hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip")) : null,
      buyer_commission_acknowledged_ua:  isBuyer ? hdrs.get("user-agent") : null,
      disclosed_buyer_commission_pct:    input.disclosedBuyerCommissionPct ?? null,
      disclosed_buyer_commission_flat:   input.disclosedBuyerCommissionFlat ?? null,
      disclosed_commission_payer:        input.disclosedCommissionPayer,
      disclosed_commission_notes:        input.disclosedCommissionNotes ?? null,
      commission_disclosure_method:      method,
    })
    .eq("id", input.offerId)

  if (error) return { ok: false, error: error.message }

  revalidatePath(`/dashboard/offers/${input.offerId}`)
  revalidatePath("/portal")
  return { ok: true }
}
