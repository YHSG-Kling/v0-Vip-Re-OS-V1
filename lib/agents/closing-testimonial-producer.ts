/**
 * lib/agents/closing-testimonial-producer.ts
 *
 * Wave 50 — deal-closed AUTO-handoff: when a transaction closes, auto-propose a
 * review/testimonial request to the buyer AND the seller — zero agent effort. Each
 * lands in the client_message deliverable gate (the agent reviews/edits before it
 * sends, consent-enforced per channel). Compounds every closing into reviews +
 * referrals. Idempotent (one request per party per listing).
 *
 * The "just sold in your neighborhood" sphere announcement is already auto-produced
 * as the just-sold social post + ad creative (both gated); this adds the testimonial.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

export interface ClosingResult { proposed: number }

/** Pure: the seller-/buyer-safe review request copy. */
export function buildTestimonialMessage(audience: "buyer" | "seller", agentName: string): { subject: string; body: string } {
  const what = audience === "buyer" ? "finding your new home" : "selling your home"
  // agentName is a display field (user-controlled) — sanitize before it reaches the client.
  const safeName = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  return {
    subject: "A quick favor — would you share your experience?",
    body: `Congratulations again on ${what}! It was a privilege to work with you. If you have 60 seconds, a short review would mean the world and helps other ${audience === "buyer" ? "buyers" : "sellers"} find great help. Thank you! — ${safeName}`,
  }
}

/**
 * For a closed listing's transaction, propose a testimonial request to each party
 * (buyer + seller) into the client_message gate. Idempotent per (contact, listing).
 */
export async function produceClosingTestimonials(
  brokerageId: string, listingId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<ClosingResult> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !listingId) return { proposed: 0 }

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, buyer_contact_id, seller_contact_id, agent_id")
    .eq("listing_id", listingId).eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
  const t = txn as { id: string; buyer_contact_id: string | null; seller_contact_id: string | null; agent_id: string | null } | null
  if (!t) return { proposed: 0 }

  // Agent identity for the signature + brand voice (resolve the users.id once).
  let agentName = "Your Agent"
  let agentUserId: string | null = null
  if (t.agent_id) {
    const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
    agentUserId = await resolveAgentRecordToUserId(t.agent_id)
    if (agentUserId) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", agentUserId).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const parties: Array<{ audience: "buyer" | "seller"; contactId: string | null }> = [
    { audience: "buyer", contactId: t.buyer_contact_id },
    { audience: "seller", contactId: t.seller_contact_id },
  ]
  let proposed = 0
  for (const p of parties) {
    if (!p.contactId) continue
    // Idempotent — one testimonial request per (contact, listing).
    const { data: existing } = await supabase.from("agent_client_messages")
      .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "testimonial_request")
      .eq("entity_id", listingId).eq("recipient_contact_id", p.contactId)
      .in("status", ["proposed", "approved", "sent"]).maybeSingle()
    if (existing) continue
    const { data: rc } = await supabase.from("contacts").select("first_name").eq("id", p.contactId).maybeSingle()
    // AI-generated, brand-voiced copy (THEM-FIRST, compliance-gated); deterministic fallback only if the gateway is down.
    const msg = await generateClientMessage({
      brokerageId, agentUserId, audience: p.audience,
      purpose: `Warmly congratulate the ${p.audience} now that their deal has closed, and ask for a short review/testimonial while the experience is fresh.`,
      recipientFirstName: (rc as { first_name?: string | null } | null)?.first_name ?? null,
      ctas: ["Share a 60-second review", "Reply if you'd refer a friend or family member who's thinking of moving"],
      fallback: buildTestimonialMessage(p.audience, agentName),
    })
    const r = await proposeClientMessage({
      brokerageId, agentKind: "deal_coordinator", entityType: "testimonial_request", entityId: listingId,
      recipientContactId: p.contactId, audience: p.audience, subject: msg.subject, body: msg.body,
      rationale: "Deal closed — request a review/testimonial while the experience is fresh.", channel: "email",
    }, supabase)
    if (r.ok) proposed++
  }
  return { proposed }
}
