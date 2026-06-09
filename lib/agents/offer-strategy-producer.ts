/**
 * lib/agents/offer-strategy-producer.ts
 *
 * Wave 57 — buyer-side AUTO-handoff (mirrors the tour-completed follow-up). When a buyer
 * reaches the `offer_strategy` journey stage (KernelEvent.OFFER_STRATEGY_RECOMMENDED) —
 * the "ready to write an offer" moment — nothing reacted before. This auto-proposes a
 * concrete offer-strategy brief to the buyer into the client_message deliverable gate
 * (Shopping Agent owns it; the human reviews/edits before it sends). Zero agent effort;
 * idempotent per buyer journey. No protected-class language, no fabricated numbers — the
 * agent fills in the comps/price in review.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

export interface OfferStrategyResult { proposed: number }

/** Pure: the buyer-safe "you're ready to make an offer — here's the plan" copy. */
export function buildOfferStrategyMessage(agentName: string): { subject: string; body: string } {
  const safeName = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  return {
    subject: "You're ready to make an offer — let's build your strategy",
    body: `You're in a strong spot to write an offer. Before we do, let's line up the essentials: I'll pull recent comparable sales so your number is grounded, we'll set your price and terms (timeline, contingencies, earnest money), and map how we respond if it's competitive. When you spot the home, we move fast and from a position of strength. Reply and we'll set a time to finalize your plan. — ${safeName}`,
  }
}

/**
 * Propose an offer-strategy brief to the buyer into the client_message gate.
 * Idempotent per (contact) — `offer_strategy` is a once-per-journey stage milestone.
 */
export async function produceOfferStrategyBrief(
  brokerageId: string, contactId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<OfferStrategyResult> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !contactId) return { proposed: 0 }

  const { data: c } = await supabase
    .from("contacts").select("id, brokerage_id, agent_id").eq("id", contactId).maybeSingle()
  const contact = c as { id: string; brokerage_id: string | null; agent_id: string | null } | null
  if (!contact || contact.brokerage_id !== brokerageId) return { proposed: 0 }

  let agentName = "Your Agent"
  if (contact.agent_id) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    const uid = (a as { user_id: string | null } | null)?.user_id ?? null
    if (uid) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", uid).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }

  // Idempotent — one offer-strategy brief per buyer journey.
  const { data: existing } = await supabase.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "offer_strategy_brief")
    .eq("entity_id", contactId).eq("recipient_contact_id", contactId)
    .in("status", ["proposed", "approved", "sent"]).maybeSingle()
  if (existing) return { proposed: 0 }

  const msg = buildOfferStrategyMessage(agentName)
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const r = await proposeClientMessage({
    brokerageId, agentKind: "shopping_agent", entityType: "offer_strategy_brief", entityId: contactId,
    recipientContactId: contactId, audience: "buyer", subject: msg.subject, body: msg.body,
    rationale: "Buyer reached offer-strategy stage — propose the offer game plan before they write.", channel: "portal",
  }, supabase)
  return { proposed: r.ok ? 1 : 0 }
}
