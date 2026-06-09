/**
 * lib/agents/tour-followup-producer.ts
 *
 * Wave 55 — buyer-side AUTO-handoff (mirrors the deal-closed testimonial producer).
 * When a buyer reaches the `tour_completed` journey stage (KernelEvent.TOUR_COMPLETED),
 * nothing reacted before — the shopping-agent spawn keys on BUYER_STATE_CHANGED, a
 * different event, so this milestone produced no proactive touch. This auto-proposes a
 * concrete "next steps after touring" message to the buyer into the client_message
 * deliverable gate (Shopping Agent owns it; the human reviews/edits before it sends,
 * consent-enforced per channel). Zero agent effort; idempotent per buyer.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

export interface TourFollowUpResult { proposed: number }

/** Pure: the buyer-safe "you've toured — here's what's next" copy. Fair-Housing clean. */
export function buildTourFollowUpMessage(agentName: string): { subject: string; body: string } {
  const safeName = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  return {
    subject: "Now that you've toured — your next steps",
    body: `Great seeing the homes with you! When you're ready, here's what we can do next: revisit a favorite, line up a few more tours, or pull comparable sales and talk strategy on an offer. Just reply with what feels right and I'll set it up. — ${safeName}`,
  }
}

/**
 * Propose a tour-completion follow-up to the buyer into the client_message gate.
 * Idempotent per (contact) — `tour_completed` is a once-per-journey stage milestone.
 */
export async function produceTourFollowUp(
  brokerageId: string, contactId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<TourFollowUpResult> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !contactId) return { proposed: 0 }

  // Confirm the contact belongs to this brokerage + resolve the agent identity + recipient name.
  const { data: c } = await supabase
    .from("contacts").select("id, brokerage_id, agent_id, first_name").eq("id", contactId).maybeSingle()
  const contact = c as { id: string; brokerage_id: string | null; agent_id: string | null; first_name: string | null } | null
  if (!contact || contact.brokerage_id !== brokerageId) return { proposed: 0 }

  let agentName = "Your Agent"
  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
    if (agentUserId) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", agentUserId).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }

  // Idempotent — one tour-completion follow-up per buyer journey.
  const { data: existing } = await supabase.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "tour_followup")
    .eq("entity_id", contactId).eq("recipient_contact_id", contactId)
    .in("status", ["proposed", "approved", "sent"]).maybeSingle()
  if (existing) return { proposed: 0 }

  // AI-generated, brand-voiced copy (THEM-FIRST, compliance-gated); deterministic fallback only if the gateway is down.
  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const msg = await generateClientMessage({
    brokerageId, agentUserId, audience: "buyer",
    purpose: "Follow up warmly after the buyer finished touring homes, and offer concrete next steps to keep their search moving.",
    recipientFirstName: contact.first_name,
    ctas: ["Revisit a favorite home", "Line up a few more tours", "Pull comparable sales and talk offer strategy"],
    fallback: buildTourFollowUpMessage(agentName),
  })
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const r = await proposeClientMessage({
    brokerageId, agentKind: "shopping_agent", entityType: "tour_followup", entityId: contactId,
    recipientContactId: contactId, audience: "buyer", subject: msg.subject, body: msg.body,
    rationale: "Buyer finished touring — propose concrete next steps while interest is fresh.", channel: "portal",
  }, supabase)
  return { proposed: r.ok ? 1 : 0 }
}
