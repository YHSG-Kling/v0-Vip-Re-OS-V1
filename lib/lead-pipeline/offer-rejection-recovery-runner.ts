// lib/lead-pipeline/offer-rejection-recovery-runner.ts
//
// Live side of OFFER-REJECTION RECOVERY (Shopping Agent). Finds OUR buyers whose offer was
// recently rejected and, within the recovery window, proposes ONE gated buyer regroup message
// (persona-aware, human-approved before it sends) + routes the acute cases to the AI ISA for a
// same-day "still searching?" call via the bus. Idempotent per (offer, contact). Read-mostly;
// the only writes are the gated proposal + bus signal. Never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { planRejectionRecovery, FOLLOWUP_WINDOW_HOURS, type RecoveryPlan } from "./offer-rejection-recovery"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface RejectionRecoveryRunInput {
  brokerageId: string
  now?: string
  copyGenerator?: CopyGenerator
  escalate?: boolean
}

export interface RejectionRecoveryRunResult {
  scanned: number
  recovered: number
  callsRouted: number
}

const REJECTED_STATUSES = ["rejected", "declined", "lost"]

export async function runOfferRejectionRecovery(input: RejectionRecoveryRunInput, client?: Svc): Promise<RejectionRecoveryRunResult> {
  const svc = client ?? createServiceClient()
  const now = input.now ?? new Date().toISOString()
  const out: RejectionRecoveryRunResult = { scanned: 0, recovered: 0, callsRouted: 0 }

  const windowStart = new Date(new Date(now).getTime() - FOLLOWUP_WINDOW_HOURS * 3_600_000).toISOString()

  // OUR buyers' recently-rejected offers (must have a buyer contact + agent to recover).
  const { data: offers } = await svc
    .from("offers")
    .select("id, contact_id, agent_id, listing_id, property_address, status, seller_response_type, has_counter, seller_response_received_at, responded_at, updated_at")
    .eq("brokerage_id", input.brokerageId)
    .in("status", REJECTED_STATUSES)
    .not("contact_id", "is", null)
    .gte("updated_at", windowStart)
    .limit(300)

  for (const o of (offers ?? []) as any[]) {
    out.scanned++
    const rejectedAt = o.seller_response_received_at ?? o.responded_at ?? o.updated_at ?? null

    // Resolve buyer name (best-effort).
    let buyerName: string | null = null
    if (o.contact_id) {
      const { data: c } = await svc.from("contacts").select("first_name, last_name").eq("id", o.contact_id).maybeSingle()
      if (c) buyerName = `${(c as any).first_name ?? ""} ${(c as any).last_name ?? ""}`.trim() || null
    }

    const plan = planRejectionRecovery({
      rejectedAt, now,
      sellerResponseType: o.seller_response_type ?? null,
      hadCounter: o.has_counter === true,
      buyerName,
      propertyAddress: o.property_address ?? null,
    })
    if (!plan.eligible || input.escalate === false) continue

    const recovered = await recover(svc, {
      brokerageId: input.brokerageId,
      offerId: o.id,
      contactId: o.contact_id,
      listingId: o.listing_id ?? null,
      agentUserId: o.agent_id ?? null,
      plan,
      copyGenerator: input.copyGenerator,
    })
    if (recovered.proposed) out.recovered++
    if (recovered.callRouted) out.callsRouted++
  }

  return out
}

async function recover(
  svc: Svc,
  args: {
    brokerageId: string; offerId: string; contactId: string; listingId: string | null
    agentUserId: string | null; plan: RecoveryPlan; copyGenerator?: CopyGenerator
  },
): Promise<{ proposed: boolean; callRouted: boolean }> {
  const { plan } = args
  // IDEMPOTENCY: one recovery per offer (keyed in the proposal rationale).
  const dedupeKey = `OFFER REJECTION RECOVERY — offer:${args.offerId}`
  const { data: prior } = await svc
    .from("agent_client_messages")
    .select("id")
    .eq("brokerage_id", args.brokerageId)
    .eq("entity_id", args.offerId)
    .ilike("rationale", `${dedupeKey}%`)
    .limit(1)
    .maybeSingle()
  if (prior) return { proposed: false, callRouted: false }

  // PERSONA-AWARE buyer regroup (deterministic fallback = plan.buyerRegroup).
  const { loadContactPersona } = await import("@/lib/kernel/ai-copy")
  const persona = await loadContactPersona(svc, args.contactId).catch(() => ({ audience: "buyer" as const }))
  const draft = await generatePersonaCopy(
    {
      goal: "a warm, brief, no-pressure message to a buyer whose offer was just rejected — acknowledge the disappointment, reassure them you're in their corner, and offer to regroup on strategy + fresh listings",
      facts: [plan.buyerRegroup],
      channel: "portal",
      persona: { ...persona, audience: "buyer", situation: "buyer's offer was rejected" },
      words: 90,
    },
    { body: plan.buyerRegroup },
    { generator: args.copyGenerator },
  )

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const proposed = await proposeClientMessage(
    {
      brokerageId: args.brokerageId,
      agentKind: "shopping_agent",
      entityType: "offer",
      entityId: args.offerId,
      recipientContactId: args.contactId,
      audience: "buyer",
      subject: "Let's regroup — the right home is still out there",
      body: draft.body,
      rationale: `${dedupeKey} — ${plan.urgency} window (${plan.hoursSince?.toFixed(0)}h since rejection). ${plan.agentBrief}`,
      channel: "portal",
      outreachReason: "recovery",
    },
    svc,
  )

  // ACUTE cases → route the AI ISA for a same-day regroup call (re-engage entry point).
  let callRouted = false
  if (plan.recommendCall) {
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const sig = await publishManagerSignal({
        brokerageId: args.brokerageId, fromManager: "shopping_agent", toManager: "ai_isa",
        signalType: "offer_rejection_recovery",
        message: `${plan.agentBrief} Recommend a same-day regroup call.`,
        entityType: "contact", entityId: args.contactId,
        payload: { offerId: args.offerId, urgency: plan.urgency, hoursSince: plan.hoursSince },
      }, svc)
      callRouted = sig.ok
    } catch { /* best-effort */ }
  }

  return { proposed: proposed.ok, callRouted }
}
