// lib/agents/seller-handler-copy.ts
// ─────────────────────────────────────────────────────────────────────────────
// Route a listing_concierge signal handler's OUTBOUND SELLER message through the AI gateway
// (generateClientMessage — brand-voiced, them-first, Fair-Housing redrafted), with the handler's
// existing copy as the deterministic FALLBACK floor. The app's rule: client-facing messages are
// AI-generated in the agent's voice, never canned scripts; the floor only ships if the gateway is
// down. This wraps the boilerplate so each handler is one call. Best-effort — failure → the fallback.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export async function generateSellerHandlerCopy(
  args: {
    brokerageId: string
    contactId: string | null
    /** Plain-language goal the model writes toward. */
    purpose: string
    facts?: Array<{ label: string; value: string }>
    ctas?: string[]
    /** The handler's existing copy — the deterministic floor. */
    fallback: { subject: string; body: string }
  },
  svc: Svc,
): Promise<{ subject: string; body: string }> {
  let firstName: string | null = null
  try {
    if (args.contactId) {
      const { data } = await svc.from("contacts").select("first_name").eq("id", args.contactId).maybeSingle()
      firstName = (data as { first_name: string | null } | null)?.first_name ?? null
    }
  } catch { /* the name is optional — the gateway still brand-voices without it */ }

  try {
    const { generateClientMessage } = await import("./generate-client-message")
    const m = await generateClientMessage({
      brokerageId: args.brokerageId, audience: "seller", purpose: args.purpose,
      recipientFirstName: firstName, facts: args.facts, ctas: args.ctas, fallback: args.fallback,
    })
    return { subject: m.subject, body: m.body }
  } catch {
    return args.fallback
  }
}
