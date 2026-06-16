// lib/intelligence/inbound-seller-intent-runner.ts
//
// Live side of INBOUND SELLER-INTENT — when a home-value / valuation capture creates a contact, hand
// the seller intent to the Listing Concierge over the bus so it responds like a human listing lead
// (a gated CMA-offer follow-up), instead of leaving the lead in the agent's inbox. Idempotent per
// contact. Best-effort; never throws (never blocks the capture).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { classifyInboundSellerIntent } from "./inbound-seller-intent"

type Svc = ReturnType<typeof createServiceClient>

export interface InboundSellerIntentArgs {
  brokerageId: string
  contactId: string
  source: string
  property?: { address?: string | null; city?: string | null; state?: string | null; estimatedValue?: number | null } | null
}

export async function publishInboundSellerIntent(args: InboundSellerIntentArgs, client?: Svc): Promise<{ engaged: boolean }> {
  const svc = client ?? createServiceClient()
  const intent = classifyInboundSellerIntent({
    source: args.source,
    hasPropertyAddress: !!args.property?.address,
    estimatedValue: args.property?.estimatedValue ?? null,
    consent: true,
  })
  if (!intent.engage) return { engaged: false }

  // Idempotent — one engagement per contact.
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId)
    .eq("signal_type", "home_value_seller_intent").eq("contact_id", args.contactId).limit(1).maybeSingle()
  if (prior) return { engaged: false }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const addr = [args.property?.address, args.property?.city, args.property?.state].filter(Boolean).join(", ")
    const r = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "ai_isa", toManager: "listing_concierge",
      signalType: "home_value_seller_intent",
      message: `Inbound seller intent (${intent.intentStrength}) — a homeowner requested a value${addr ? ` for ${addr}` : ""}. ${intent.reason}.`,
      entityType: "contact", entityId: args.contactId, contactId: args.contactId,
      payload: {
        intent_strength: intent.intentStrength,
        property_address: addr || null,
        estimated_value: args.property?.estimatedValue ?? null,
        source: args.source,
      },
    }, svc)
    return { engaged: !!(r as any).ok }
  } catch {
    return { engaged: false }
  }
}
