/**
 * lib/agents/extract-client-messages.ts
 *
 * Wave 47 — pure extractor: given a managed agent's JSON output, pull EVERY
 * client-facing message it proposed, normalized to a common shape. The webhook
 * proposes each into the governed agent_client_messages ledger, so every
 * client-facing manager (listing concierge, deal coordinator, shopping agent,
 * sphere, campaign orchestrator) flows through the ONE Command Center gate —
 * regardless of the field names each manager uses.
 *
 *   listing_concierge   → seller_update
 *   deal_coordinator    → seller_update + buyer_update
 *   shopping_agent      → buyer_digest
 *   sphere_of_influence → opportunities[].{draft_message|draft|message|body}
 *   campaign_orchestrator → campaigns[].{draft_body|body}  (+ draft_subject, contact_id, channel)
 *
 * Pure + unit-tested. Only emits a draft when a non-empty body string is found.
 */
export type ClientAudience = "seller" | "buyer" | "lead" | "agent"

export interface ClientMessageDraft {
  audience:            ClientAudience
  body:                string
  subject?:            string | null
  recipientContactId?: string | null
  channel?:            string | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const isAudience = (v: unknown): v is ClientAudience => v === "seller" || v === "buyer" || v === "lead" || v === "agent"

/** Managers whose output reaches a client and must pass the human gate. */
export const GATED_CLIENT_MANAGERS = new Set<string>([
  "listing_concierge", "deal_coordinator", "shopping_agent", "sphere_of_influence", "campaign_orchestrator",
])

/** Pure: extract all client-facing message drafts from a manager's parsed output. */
export function extractClientMessages(parsed: any): ClientMessageDraft[] {
  const out: ClientMessageDraft[] = []
  if (!parsed || typeof parsed !== "object") return out

  const seller = str(parsed.seller_update)
  if (seller) out.push({ audience: "seller", body: seller })

  const buyer = str(parsed.buyer_update) ?? str(parsed.buyer_digest)
  if (buyer) out.push({ audience: "buyer", body: buyer })

  if (Array.isArray(parsed.opportunities)) {
    for (const o of parsed.opportunities) {
      const body = str(o?.draft_message) ?? str(o?.draft) ?? str(o?.message) ?? str(o?.body)
      if (body) out.push({ audience: "lead", body, subject: str(o?.subject), recipientContactId: str(o?.contact_id), channel: str(o?.channel) })
    }
  }

  if (Array.isArray(parsed.campaigns)) {
    for (const c of parsed.campaigns) {
      const body = str(c?.draft_body) ?? str(c?.body) ?? str(c?.message)
      if (body) out.push({
        audience: isAudience(c?.audience) ? c.audience : "lead",
        body, subject: str(c?.draft_subject) ?? str(c?.subject),
        recipientContactId: str(c?.contact_id), channel: str(c?.channel),
      })
    }
  }
  return out
}
