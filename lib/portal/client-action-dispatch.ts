// lib/portal/client-action-dispatch.ts
//
// Executes a routed client request against the REAL primitives — reusing requestShowing (BBA gate
// internal) and proposeClientMessage (the gated approval path). Nothing here sends to a client
// autonomously: a seller action becomes a PROPOSAL in the agent's queue; a showing that lacks a
// signed BBA becomes a PROPOSED signing-link nudge to the agent (the request is never silently
// dropped). Search stays open. Honest conservatism: ambiguous → ask, never half-execute.

import "server-only"
import { classifyClientIntent, routeClientIntent } from "./client-action-router"
import { generatePersonaCopy, loadContactPersona, type CopyGenerator } from "@/lib/kernel/ai-copy"
import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface ClientActionInput {
  brokerageId: string
  contactId: string
  contactType: string | null
  message: string
  /** Structured params the portal/AI layer extracts (kept out of the pure classifier). */
  propertyAddress?: string
  preferredDates?: { date: string; time: string }[]
  newPrice?: number
  /** Injectable copy generator (tests pass a deterministic one; prod uses the AI gateway). */
  copyGenerator?: CopyGenerator
}

export interface ClientActionResult {
  ok: boolean
  outcome: "showing_requested" | "bba_required_proposed" | "proposed_to_agent" | "search" | "advisory" | "needs_detail"
  /** What the concierge says back to the client. */
  spoken: string
  proposalId?: string
  showingId?: string
}

export async function dispatchClientAction(input: ClientActionInput, client?: Svc): Promise<ClientActionResult> {
  const intent = classifyClientIntent(input.message, input.contactType)
  const route = routeClientIntent(intent, input.contactType)

  // Persona-aware copy — NEVER hardcoded. The AI gateway personalizes; the deterministic fallback
  // guarantees real copy. The generator is injectable so proofs run without a live model.
  const persona = client ? await loadContactPersona(client, input.contactId) : { audience: input.contactType ?? "audience" }
  const gen = (goal: string, facts: string[], fallback: string, words = 40) =>
    generatePersonaCopy({ goal, facts, channel: "portal", persona, words }, { body: fallback }, { generator: input.copyGenerator })

  switch (route.kind) {
    case "create_showing": {
      if (!input.propertyAddress) {
        return { ok: true, outcome: "needs_detail", spoken: "Which property would you like to see? Tell me the address and a couple of times that work." }
      }
      const { requestShowing } = await import("@/app/actions/showings")
      const r = await requestShowing({
        contactId:       input.contactId,
        propertyAddress: input.propertyAddress,
        source:          "message",
        preferredDates:  input.preferredDates ?? [],
        clientNotes:     `Requested via portal concierge: "${input.message}"`,
      })
      if (r.success) {
        const say = await gen("a one-sentence concierge reply confirming the showing request was placed and the agent will confirm a time",
          [`Property: ${input.propertyAddress}`], "Done — I've put in that showing request and your agent will confirm the time.")
        return { ok: true, outcome: "showing_requested", spoken: say.body, showingId: (r as { showing?: { id?: string } }).showing?.id }
      }
      // BBA gate blocked it (NAR 2024) — propose a signing-link nudge to the agent, don't drop it.
      if ((r as { errorCode?: string }).errorCode === "bba_required") {
        const note = await gen("a short note to the AGENT that the buyer asked to tour this property and needs the representation agreement sent so it can be scheduled",
          [`Buyer wants to tour ${input.propertyAddress}`, `Client said: "${input.message}"`], `Your buyer asked to tour ${input.propertyAddress}. Send the Buyer Representation Agreement so we can schedule it.`)
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        const p = await proposeClientMessage({
          brokerageId:        input.brokerageId,
          agentKind:          "shopping_agent",
          entityType:         "contact",
          entityId:           input.contactId,
          recipientContactId: input.contactId,
          audience:           "buyer",
          subject:            note.subject ?? "Buyer wants a showing — agreement needed",
          body:               note.body,
          rationale:          `Client portal request: "${input.message}" — showing blocked, BBA not on file (NAR 2024)`,
          channel:            "portal",
        }, client)
        const say = await gen("a warm one-sentence reply telling the client a quick representation agreement is needed before touring and their agent has been notified",
          [], "Before we tour, there's a quick representation agreement to sign — I've flagged it for your agent to send over.")
        return { ok: true, outcome: "bba_required_proposed", spoken: say.body, proposalId: p.id }
      }
      return { ok: false, outcome: "needs_detail", spoken: "I couldn't put that showing in just yet — your agent will follow up." }
    }

    case "propose_to_agent": {
      const facts = [`Client request: "${input.message}"`, ...(input.newPrice ? [`Requested new price: $${input.newPrice.toLocaleString()}`] : [])]
      const note = await gen("a short note to the AGENT summarizing the seller's request so they can review and approve it",
        facts, `Your seller requested: "${input.message}"${input.newPrice ? ` (new price $${input.newPrice.toLocaleString()})` : ""}. Review and approve to action it.`)
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const p = await proposeClientMessage({
        brokerageId:        input.brokerageId,
        agentKind:          "listing_concierge",
        entityType:         "contact",
        entityId:           input.contactId,
        recipientContactId: input.contactId,
        audience:           "agent",
        subject:            note.subject ?? "Seller request from the portal",
        body:               note.body,
        rationale:          `Client portal request: "${input.message}" — seller action, awaiting agent approval`,
        channel:            "portal",
      }, client)
      const say = await gen("a warm one-sentence reply telling the seller their request was passed to their agent to review and confirm",
        [], "I've passed that to your agent to review — they'll confirm with you shortly.")
      return { ok: p.ok, outcome: "proposed_to_agent", spoken: say.body, proposalId: p.id }
    }

    case "open_search":
      // Search is open (no BBA, no gate). The portal surface runs smartSearch; the concierge acks.
      return { ok: true, outcome: "search", spoken: "On it — pulling up homes that match what you described." }

    case "advisory":
    default:
      return { ok: true, outcome: "advisory", spoken: "" }
  }
}
