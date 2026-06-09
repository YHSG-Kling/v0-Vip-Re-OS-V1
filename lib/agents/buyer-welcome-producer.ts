/**
 * lib/agents/buyer-welcome-producer.ts
 *
 * Wave 58 — buyer-side AUTO-handoff at the "go-live" moment: when the buyer-broker
 * agreement is signed, the buyer is officially represented. Auto-propose a warm,
 * AI-generated welcome + next-steps message into the client_message gate (Shopping
 * Agent owns it). Copy is brand-voiced + compliance-gated via generateClientMessage —
 * NOT a canned script. Idempotent per buyer. Called at the authoritative source
 * (esign finalize) because BBA-signed flows the orchestrator path, not the kernel reactor.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

export interface BuyerWelcomeResult { proposed: number }

/** Resilience fallback only — the primary copy is AI-generated + brand-voiced. */
export function buildBuyerWelcomeFallback(agentName: string): { subject: string; body: string } {
  const safeName = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  return {
    subject: "Welcome — let's find your home",
    body: `It's official — I'm honored to represent you on your home search. Here's how we'll get moving: we'll lock in your search criteria, line up your financing so you're ready to act, and start touring homes that fit. I'll keep you a step ahead the whole way. Reply any time with questions — I'm here for you. — ${safeName}`,
  }
}

/**
 * Propose an AI-generated buyer welcome into the client_message gate. Idempotent per buyer.
 */
export async function produceBuyerWelcome(
  brokerageId: string, contactId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<BuyerWelcomeResult> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !contactId) return { proposed: 0 }

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

  // Idempotent — one welcome per buyer.
  const { data: existing } = await supabase.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "buyer_welcome")
    .eq("entity_id", contactId).eq("recipient_contact_id", contactId)
    .in("status", ["proposed", "approved", "sent"]).maybeSingle()
  if (existing) return { proposed: 0 }

  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const msg = await generateClientMessage({
    brokerageId, agentUserId, audience: "buyer",
    purpose: "Warmly welcome the buyer now that they've signed the buyer representation agreement, and orient them to the first next steps of working together.",
    recipientFirstName: contact.first_name,
    ctas: ["Confirm your search criteria", "Get your financing/pre-approval lined up", "Start touring homes that fit"],
    fallback: buildBuyerWelcomeFallback(agentName),
  })
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const r = await proposeClientMessage({
    brokerageId, agentKind: "shopping_agent", entityType: "buyer_welcome", entityId: contactId,
    recipientContactId: contactId, audience: "buyer", subject: msg.subject, body: msg.body,
    rationale: "Buyer-broker agreement signed — welcome the buyer and orient them to next steps.", channel: "portal",
  }, supabase)
  return { proposed: r.ok ? 1 : 0 }
}
