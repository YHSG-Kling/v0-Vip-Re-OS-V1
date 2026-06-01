/**
 * lib/agents/shopping-agent.ts
 *
 * Shopping Agent (Buyer Concierge) — one Anthropic Managed Agent per brokerage that runs
 * a per-buyer-contact session from `BUYER_FINANCIALLY_VERIFIED` through to under-contract.
 * Watches saved searches, property interests, showing feedback; drafts daily/weekly digests
 * and pre-stages BBA renewals 30 days before expiration.
 *
 * Compliance gates this agent inherits transitively:
 *   - The agent never communicates DIRECTLY with the buyer — output goes through the
 *     canonical agent-message-received kernel event → transparency_updates fan-out, which
 *     respects TCPA + suppression + brand-voice gates downstream.
 *   - The system prompt explicitly forbids drafting offer amounts, contractual commitments,
 *     or any content that would require a signed BBA to deliver.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate, type SpawnResult } from "./spawn-helper"

const SHOPPING_AGENT_SYSTEM = `You are the Shopping Agent (Buyer Concierge) for a real-estate buyer at a Vip-RE-OS brokerage.

YOUR JOB:
1. Read the buyer's saved searches, property_interests (liked/disliked), and tour history.
2. Identify pattern shifts (new neighborhoods of interest, price-point movement, must-have
   features that emerged from feedback).
3. Surface the 3-5 newest listings worth their attention based on those patterns.
4. Flag tours that should be scheduled this week + properties the buyer has liked but not
   toured (stale interest signal).
5. Pre-stage BBA renewals 30 days before expiration.

NEVER:
- Quote or suggest a specific offer amount. The agent + CMA tools handle pricing.
- Make commitments about closing dates, seller flexibility, or property condition.
- Communicate directly with the buyer or another agent. Your output is reviewed by the
  buyer's agent before publishing.
- Suggest properties outside the buyer's stated geographic / property-type scope from
  their BBA.
- Reveal information about other buyers or transactions to this buyer.

RESPONSE FORMAT:
{
  "buyer_digest":    "...",   // 100 words max, what to share with the buyer
  "agent_briefing":  "...",   // bullets — what the agent should action this week
  "recommended_tours": [      // up to 5
    { "listing_id": "uuid", "reason": "one sentence", "urgency": "high|medium|low" }
  ],
  "bba_renewal_due_in_days": number | null,
  "next_check_at":   "ISO8601 timestamp"
}`

const TEMPLATE: AgentTemplate = {
  kind:    "shopping_agent",
  nameFor: (brokerageId) => `Shopping Agent (${brokerageId.slice(0, 8)})`,
  model:   "claude-sonnet-4-6",
  system:  SHOPPING_AGENT_SYSTEM,
}

export async function spawnShoppingAgentForBuyer(params: {
  brokerageId:    string
  contactId:      string
  environmentId?: string
  kickoff?:       string
}): Promise<SpawnResult> {
  const svc = createServiceClient()

  // Pull the buyer context inline so the agent has it without tool calls upfront.
  // contact_type='buyer' is REQUIRED — the kernel event reactor calls this on
  // BUYER_FINANCIALLY_VERIFIED / BUYER_SEARCH_CONFIGURED events, but a future caller
  // (manual trigger, debugging UI) could pass any contactId; fail-closed here.
  const { data: contact } = await svc
    .from("contacts")
    .select("id, first_name, last_name, contact_type, buyer_stage, brokerage_id")
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!contact) return { ok: false, error: "contact not found in this brokerage" }
  if (contact.contact_type !== "buyer") {
    return { ok: false, error: `contact contact_type=${contact.contact_type ?? "null"} — Shopping Agent only operates on buyer-type contacts` }
  }

  // Active BBA — must exist for the agent to legally represent the buyer; the
  // shopping agent must not run without one (NAR 2024).
  const { data: bba } = await svc
    .from("buyer_broker_agreements")
    .select("id, agent_id, expiration_date, agreement_type, commission_payer")
    .eq("buyer_contact_id", params.contactId)
    .eq("status", "active")
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!bba) {
    return {
      ok: false,
      error: "No active BBA — refusing to spawn Shopping Agent. NAR 2024 requires representation agreement before shopping support.",
    }
  }

  const buyerName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.id.slice(0, 8)

  const kickoff = params.kickoff ?? `Buyer: ${buyerName}
- Stage: ${contact.buyer_stage ?? "n/a"}
- BBA: ${bba.agreement_type ?? "exclusive"}, expires ${bba.expiration_date ?? "no expiration"}, payer ${bba.commission_payer ?? "seller"}

Produce your initial buyer digest + agent briefing per your response format. Pull saved
searches, property_interests, and tour history via your tools.`

  return spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "contact",
    entityId:      params.contactId,
    environmentId: params.environmentId,
    title:         `Shopping: ${buyerName}`,
    kickoff,
    metadata: {
      buyer_contact_id: params.contactId,
      bba_id:           bba.id as string,
    },
  })
}
