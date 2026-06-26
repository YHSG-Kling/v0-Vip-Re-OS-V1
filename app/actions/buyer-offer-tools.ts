"use server"

// app/actions/buyer-offer-tools.ts
// ─────────────────────────────────────────────────────────────────────────────
// BUYER SELF-SERVE → SIGNAL THE AGENT. When a buyer uses a portal tool on a property they like —
// runs the affordability numbers, or asks for help making an offer — the Shopping Agent's human
// is looped in immediately, and "help me make an offer" fires the gated Offer Accelerator (the
// comps-grounded plan + the offer-confidence reel). The buyer self-qualifies; the team convenes.
// Mirrors the requestShowing buyer-as-actor pattern (client_portal_activity + agent notification).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

/** Resolve the contact's tenancy + assigned agent (agents.id → users.id) from the contact row,
 *  NOT the auth user (the buyer's portal user is not the agent). Mirrors requestShowing. */
async function resolveContactAgent(supabase: any, contactId: string) {
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, brokerage_id, agent_id")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return null
  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    agentUserId = (agentRow as { user_id: string | null } | null)?.user_id ?? null
  }
  return { contact, agentUserId }
}

async function notifyAgent(
  supabase: any,
  args: { agentUserId: string | null; brokerageId: string | null; type: string; title: string; body: string; entityId: string },
) {
  if (!args.agentUserId || !args.brokerageId) return
  try {
    await supabase.from("notifications").insert({
      user_id: args.agentUserId, brokerage_id: args.brokerageId,
      type: args.type, title: args.title, body: args.body,
      entity_type: "contact", entity_id: args.entityId, priority: "high", channel: "in_app",
    })
  } catch { /* non-critical */ }
}

/**
 * signalAffordabilityChecked — the buyer ran the affordability numbers on a property. Record the
 * activity + notify the agent that the buyer is actively evaluating a specific home (high intent).
 */
export async function signalAffordabilityChecked(input: {
  contactId: string
  propertyId: string
  propertyAddress: string
  price: number
  monthlyEstimate: number
  verdict: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const resolved = await resolveContactAgent(supabase, input.contactId)
    if (!resolved) return { success: false, error: "Contact not found" }
    const { contact, agentUserId } = resolved

    try {
      await supabase.from("client_portal_activity").insert({
        contact_id: input.contactId,
        activity_type: "affordability_checked",
        metadata: {
          property_id: input.propertyId, property_address: input.propertyAddress,
          price: input.price, monthly_estimate: input.monthlyEstimate, verdict: input.verdict,
          source: "buyer_portal",
        },
      })
    } catch { /* non-critical */ }

    const money = (n: number) => `$${Math.round(n).toLocaleString()}`
    await notifyAgent(supabase, {
      agentUserId, brokerageId: contact.brokerage_id,
      type: "buyer.affordability_checked",
      title: "Buyer is running the numbers",
      body: `${contact.first_name ?? "Your buyer"} checked affordability on ${input.propertyAddress} — ~${money(input.monthlyEstimate)}/mo (${input.verdict.replace(/_/g, " ")}). They're evaluating this home.`,
      entityId: input.contactId,
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}

/**
 * requestOfferHelp — the buyer asked for help writing an offer on a property they like. Notify
 * the agent AND fire the gated Offer Accelerator so the agent gets the comps-grounded plan +
 * the offer-confidence reel handoff. The buyer-initiated team play.
 */
export async function requestOfferHelp(input: {
  contactId: string
  propertyId: string
  propertyAddress: string
}): Promise<{ success: boolean; accelerated?: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const resolved = await resolveContactAgent(supabase, input.contactId)
    if (!resolved) return { success: false, error: "Contact not found" }
    const { contact, agentUserId } = resolved

    try {
      await supabase.from("client_portal_activity").insert({
        contact_id: input.contactId,
        activity_type: "offer_help_requested",
        metadata: { property_id: input.propertyId, property_address: input.propertyAddress, source: "buyer_portal" },
      })
    } catch { /* non-critical */ }

    await notifyAgent(supabase, {
      agentUserId, brokerageId: contact.brokerage_id,
      type: "buyer.offer_help_requested",
      title: "Buyer wants to make an offer",
      body: `${contact.first_name ?? "Your buyer"} asked for help writing an offer on ${input.propertyAddress}. The offer plan is being prepared for your review.`,
      entityId: input.contactId,
    })

    // Fire the gated Offer Accelerator (service client — it writes the agent_client_messages
    // draft + publishes the offer-confidence reel handoff). Idempotent per buyer journey.
    let accelerated = false
    if (contact.brokerage_id) {
      try {
        const svc = createServiceClient()
        const { produceOfferStrategyBrief } = await import("@/lib/agents/offer-strategy-producer")
        const r = await produceOfferStrategyBrief(contact.brokerage_id, input.contactId, svc)
        accelerated = r.proposed > 0
      } catch (e) {
        console.error("[requestOfferHelp] accelerator failed:", e)
      }
    }
    return { success: true, accelerated }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}

/**
 * analyzeAddressForBuyer — the buyer pastes ANY address and our tools run on it: free OSINT spec
 * lookup + the (cache/Perplexity-first, non-paid) AVM → estimated value + specs, so the
 * affordability tool works on the whole market, not just saved homes. Researching a specific
 * address is a HIGH-intent signal — recorded quietly for the agent (no notification spam).
 */
export async function analyzeAddressForBuyer(input: {
  contactId: string
  address: string
}): Promise<{ success: boolean; analysis?: import("@/lib/buyer-offers/address-analysis").AddressAnalysis; error?: string }> {
  try {
    const address = (input.address ?? "").trim()
    if (address.length < 5) return { success: false, error: "Enter a full address" }
    const supabase = await createClient()
    const { data: contact } = await supabase.from("contacts").select("id, brokerage_id").eq("id", input.contactId).maybeSingle()
    const brokerageId = (contact as { brokerage_id: string | null } | null)?.brokerage_id ?? null

    const [{ lookupPropertyByAddress }, { getCurrentAvm }, { buildAddressAnalysis }] = await Promise.all([
      import("@/lib/property/address-lookup"),
      import("@/lib/avm/provider-chain"),
      import("@/lib/buyer-offers/address-analysis"),
    ])
    const [lookup, avm] = await Promise.all([
      lookupPropertyByAddress({ address, city: "", state: "" }).catch(() => null),
      getCurrentAvm({ address, brokerageId }).catch(() => null),
    ])
    const analysis = buildAddressAnalysis(lookup as any, avm as any)

    // Quiet high-intent signal — the buyer is researching a specific home.
    try {
      await supabase.from("client_portal_activity").insert({
        contact_id: input.contactId, activity_type: "address_analyzed",
        metadata: { address, estimated_value: analysis.estimatedValue, source: "buyer_portal" },
      })
    } catch { /* non-critical */ }

    return { success: true, analysis }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}

/**
 * requestComparisonReview — the buyer has lined up their finalists side-by-side and wants the
 * agent's take. A HIGH-intent moment (they're close to choosing) — notify the agent WHICH homes
 * they're weighing so the agent can guide the decision. Fires only on the explicit ask (never on
 * mere browsing) — signal, not noise.
 */
export async function requestComparisonReview(input: {
  contactId: string
  addresses: string[]
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const resolved = await resolveContactAgent(supabase, input.contactId)
    if (!resolved) return { success: false, error: "Contact not found" }
    const { contact, agentUserId } = resolved
    const homes = (input.addresses ?? []).filter(Boolean).slice(0, 4)
    if (homes.length < 2) return { success: false, error: "Pick at least two homes to compare" }

    try {
      await supabase.from("client_portal_activity").insert({
        contact_id: input.contactId,
        activity_type: "comparison_review_requested",
        metadata: { addresses: homes, source: "buyer_portal" },
      })
    } catch { /* non-critical */ }

    await notifyAgent(supabase, {
      agentUserId, brokerageId: contact.brokerage_id,
      type: "buyer.comparison_review_requested",
      title: "Buyer is weighing their finalists",
      body: `${contact.first_name ?? "Your buyer"} is comparing ${homes.join(" vs ")} and wants your take — they're close to choosing.`,
      entityId: input.contactId,
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}

/**
 * requestPreApprovalRefresh — the buyer's pre-approval is expired/expiring (or missing) and they
 * want to get (back) to offer-ready. Notify the agent to connect them with a lender. The agent is
 * the right owner pre-offer (the Finance Manager owns the in-deal lender side); this keeps the
 * buyer's self-serve tool honest — an expired approval shouldn't masquerade as a real ceiling.
 */
export async function requestPreApprovalRefresh(input: {
  contactId: string
  propertyId: string
  propertyAddress: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const resolved = await resolveContactAgent(supabase, input.contactId)
    if (!resolved) return { success: false, error: "Contact not found" }
    const { contact, agentUserId } = resolved

    try {
      await supabase.from("client_portal_activity").insert({
        contact_id: input.contactId,
        activity_type: "preapproval_refresh_requested",
        metadata: { property_id: input.propertyId, property_address: input.propertyAddress, source: "buyer_portal" },
      })
    } catch { /* non-critical */ }

    await notifyAgent(supabase, {
      agentUserId, brokerageId: contact.brokerage_id,
      type: "buyer.preapproval_refresh_requested",
      title: "Buyer wants to refresh their pre-approval",
      body: `${contact.first_name ?? "Your buyer"} is evaluating ${input.propertyAddress} and asked to refresh their pre-approval — connect them with a lender to get back to offer-ready.`,
      entityId: input.contactId,
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? "failed" }
  }
}
