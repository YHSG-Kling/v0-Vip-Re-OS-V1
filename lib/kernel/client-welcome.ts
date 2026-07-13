/**
 * lib/kernel/client-welcome.ts
 *
 * CLIENT WELCOME SEQUENCE (client concierge list #1–2) — "as soon as a
 * client is added, a warm welcome plus a simple 'here's how we'll work
 * together' guide," with the short journey map so no one is dropped into
 * complexity. Fires when a contact ENTERS the book as a buyer or seller
 * client: ONE gated draft on the canonical agent_client_messages rail
 * (proposeClientMessage — the agent approves before anything sends),
 * side-aware journey steps, addressed via the addressing memory when
 * captured. Idempotent per contact via the rationale tag. Delivery is
 * owned by the concierges (buyer → Shopping Agent, seller → Listing
 * Concierge). PURE composer + a thin ensure; NOT server-only.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const WELCOME_RATIONALE_TAG = "client_welcome_v1"

const BUYER_JOURNEY = [
  "We get clear on what you want (and what you don't)",
  "You see curated homes with my reasoning — never a firehose",
  "We tour, we compare, we decide at YOUR pace",
  "When it's the one, I run the offer and the paperwork",
  "You get the keys — and I stay your resource for years",
]

const SELLER_JOURNEY = [
  "We walk your home and build the pricing story together",
  "Prep and staging get a plan, not a scramble",
  "Launch week runs on a schedule you'll see in advance",
  "Every showing and offer comes back to you with my read",
  "We close — and I keep watching your equity after",
]

/** PURE: the warm welcome + journey map, side-aware, addressed properly. */
export function composeClientWelcome(input: {
  side: "buyer" | "seller"
  addressAs: string
  agentName: string | null
}): { subject: string; body: string } {
  const steps = input.side === "buyer" ? BUYER_JOURNEY : SELLER_JOURNEY
  const who = input.agentName ? `I'm ${input.agentName}, and my` : `My`
  return {
    subject: input.side === "buyer" ? "Welcome — here's how we'll find your home" : "Welcome — here's how we'll sell your home",
    body: [
      `${input.addressAs}, welcome. ${who} whole team is now working for you — here's the map so you always know where we are:`,
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      `You'll never have to chase me for a status — updates come to you, and every one ends with "here's what's next." Questions at any hour go to your portal; a human reads everything.`,
    ].join("\n"),
  }
}

/** LIVE: propose the ONE gated welcome draft for a newly-added client.
 *  Best-effort (never fails contact creation); idempotent per contact. */
export async function ensureClientWelcome(svc: Svc, contact: {
  id: string
  brokerageId: string
  contactType: string | null
  firstName: string | null
  lastName: string | null
  preferredName?: string | null
}): Promise<{ proposed: boolean }> {
  const type = (contact.contactType ?? "").toLowerCase()
  const side: "buyer" | "seller" | null =
    type.includes("buyer") ? "buyer" : type.includes("seller") ? "seller" : null
  if (!side) return { proposed: false }

  const { data: prior } = await svc.from("agent_client_messages")
    .select("id")
    .eq("recipient_contact_id", contact.id)
    .ilike("rationale", `${WELCOME_RATIONALE_TAG}%`)
    .limit(1).maybeSingle()
  if (prior) return { proposed: false }

  const { resolveAddressing } = await import("@/lib/kernel/addressing")
  const addressing = resolveAddressing({
    firstName: contact.firstName, lastName: contact.lastName,
    preferredName: contact.preferredName ?? null,
    namePronunciation: null, salutationStyle: null,
  })
  const copy = composeClientWelcome({ side, addressAs: addressing.addressAs, agentName: null })

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const res = await proposeClientMessage({
    brokerageId: contact.brokerageId,
    agentKind: side === "buyer" ? "shopping_agent" : "listing_concierge",
    entityType: "contact",
    entityId: contact.id,
    recipientContactId: contact.id,
    audience: side,
    subject: copy.subject,
    body: copy.body,
    rationale: `${WELCOME_RATIONALE_TAG} — warm onboarding welcome + journey map for a new ${side} client (concierge methodology: no one is dropped into complexity).`,
    channel: "portal",
  }, svc)
  return { proposed: res.ok }
}
