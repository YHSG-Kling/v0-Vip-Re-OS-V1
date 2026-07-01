// lib/listings/relist-recovery-runner.ts
//
// Live side of EXPIRED/WITHDRAWN LISTING RE-LIST RECOVERY (Listing Concierge). Finds OUR
// listings that recently came off the market without selling and, within the recovery window,
// proposes ONE gated "let's reposition and re-list" seller message (human-approved before
// send) + routes acute cases to the AI ISA for a re-list call via the bus. Idempotent per
// listing. Read-mostly; never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { planRelistRecovery, FOLLOWUP_WINDOW_DAYS, type RelistPlan } from "./relist-recovery"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface RelistRecoveryRunInput {
  brokerageId: string
  now?: string
  copyGenerator?: CopyGenerator
  escalate?: boolean
}

export interface RelistRecoveryRunResult {
  scanned: number
  recovered: number
  callsRouted: number
  /** Listings for which a cash-buyer disposition option was auto-prepared (non-sending). */
  cashBuyersPrepared: number
}

const RELIST_STATUSES = ["expired", "withdrawn", "cancelled", "canceled"]

export async function runRelistRecovery(input: RelistRecoveryRunInput, client?: Svc): Promise<RelistRecoveryRunResult> {
  const svc = client ?? createServiceClient()
  const now = input.now ?? new Date().toISOString()
  const out: RelistRecoveryRunResult = { scanned: 0, recovered: 0, callsRouted: 0, cashBuyersPrepared: 0 }

  const windowStart = new Date(new Date(now).getTime() - FOLLOWUP_WINDOW_DAYS * 86_400_000).toISOString()

  // OUR off-market listings: a seller contact (has a portal) AND a listing agent to recover.
  // The property facts (city/beds/sqft/year) feed the cash-buyer disposition prep below.
  const { data: listings } = await svc
    .from("listings")
    .select("id, address, city, state, zip, bedrooms, bathrooms, sqft, year_built, property_type, status, seller_contact_id, agent_id, stage_updated_at, updated_at")
    .eq("brokerage_id", input.brokerageId)
    .in("status", RELIST_STATUSES)
    .not("seller_contact_id", "is", null)
    .not("agent_id", "is", null)
    .gte("updated_at", windowStart)
    .limit(300)

  for (const l of (listings ?? []) as any[]) {
    out.scanned++
    const transitionAt = l.stage_updated_at ?? l.updated_at ?? null
    const plan = planRelistRecovery({ status: l.status ?? null, transitionAt, now, address: l.address ?? null })
    if (!plan.eligible || input.escalate === false) continue

    const r = await recover(svc, {
      brokerageId: input.brokerageId,
      listingId: l.id,
      sellerContactId: l.seller_contact_id,
      agentUserId: l.agent_id ?? null,
      plan,
      copyGenerator: input.copyGenerator,
    })
    if (r.callRouted) out.callsRouted++
    if (r.proposed) {
      out.recovered++
      // AUTONOMOUS, WITHIN-DOMAIN: the seller couldn't move this listing retail. The moment recovery is
      // first proposed, the Listing Concierge ALSO prepares a fast-sale option — a ranked list of nearby
      // CASH INVESTORS — so the agent can offer "or I have cash buyers who'd take it as-is" in the same
      // re-launch conversation. Fires ONCE per listing (gated on the first proposal, so the cron doesn't
      // re-spend), NON-SENDING (just intelligence), PROVIDER-GATED (BatchData unset/error → honest skip),
      // idempotent (cash_buyer_matches is unique per listing). No cross-manager trigger — this is the
      // Concierge working its own listing.
      try {
        const { runCashBuyerMatch } = await import("@/lib/disposition/cash-buyer-match-runner")
        const m = await runCashBuyerMatch(svc as any, {
          brokerageId: input.brokerageId,
          listingId: l.id,
          subject: {
            street: l.address ?? "",
            city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null,
            bedrooms: l.bedrooms ?? null, bathrooms: l.bathrooms ?? null,
            livingAreaSqft: l.sqft ?? null, yearBuilt: l.year_built ?? null,
            propertyTypeDetail: l.property_type ?? null,
          },
        })
        if (m.ok) out.cashBuyersPrepared++
      } catch { /* best-effort — the relist recovery still went out */ }
    }
  }

  return out
}

async function recover(
  svc: Svc,
  args: {
    brokerageId: string; listingId: string; sellerContactId: string; agentUserId: string | null
    plan: RelistPlan; copyGenerator?: CopyGenerator
  },
): Promise<{ proposed: boolean; callRouted: boolean }> {
  const { plan } = args
  // IDEMPOTENCY: one re-list recovery per listing (keyed in the proposal rationale).
  const dedupeKey = `RELIST RECOVERY — listing:${args.listingId}`
  const { data: prior } = await svc
    .from("agent_client_messages")
    .select("id")
    .eq("brokerage_id", args.brokerageId)
    .eq("entity_id", args.listingId)
    .ilike("rationale", `${dedupeKey}%`)
    .limit(1)
    .maybeSingle()
  if (prior) return { proposed: false, callRouted: false }

  const { loadContactPersona } = await import("@/lib/kernel/ai-copy")
  const persona = await loadContactPersona(svc, args.sellerContactId).catch(() => ({ audience: "seller" as const }))
  const draft = await generatePersonaCopy(
    {
      goal: "a warm, brief, no-pressure message to a seller whose listing came off the market without selling — acknowledge the frustration, reassure them it usually needs a sharper strategy not a worse market, and offer to map a re-launch",
      facts: [plan.sellerOutreach],
      channel: "portal",
      persona: { ...persona, audience: "seller", situation: "listing expired/withdrawn without selling" },
      words: 95,
    },
    { body: plan.sellerOutreach },
    { generator: args.copyGenerator },
  )

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const proposed = await proposeClientMessage(
    {
      brokerageId: args.brokerageId,
      agentKind: "listing_concierge",
      entityType: "listing",
      entityId: args.listingId,
      recipientContactId: args.sellerContactId,
      audience: "seller",
      subject: "Let's get your home sold — a fresh re-launch plan",
      body: draft.body,
      rationale: `${dedupeKey} — ${plan.urgency} window (${plan.daysSince?.toFixed(0)}d since off-market). ${plan.agentBrief}`,
      channel: "portal",
    },
    svc,
  )

  // CONSENSUS MEMORY — the listing went off-market WITHOUT selling: the strategic plays on this
  // listing (a price drop's "a cut will move buyers" read) were proven WRONG. Resolve any open
  // second-opinion huddles for this listing as a LOSS so the consulted manager's track record sees
  // the failure, not just the wins. Idempotent; keyed by the listing entity (not the seller huddle
  // below, which is keyed by the seller contact). Best-effort.
  try {
    const { resolveConsultOutcomes } = await import("@/lib/kernel/consult-outcome-resolver")
    await resolveConsultOutcomes({ brokerageId: args.brokerageId, entityId: args.listingId, success: false }, svc)
  } catch { /* best-effort — the recovery outreach still went out */ }

  let callRouted = false
  if (plan.recommendCall) {
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const sig = await publishManagerSignal({
        brokerageId: args.brokerageId, fromManager: "listing_concierge", toManager: "ai_isa",
        signalType: "relist_recovery",
        message: `${plan.agentBrief} Recommend a re-list call.`,
        entityType: "contact", entityId: args.sellerContactId,
        payload: { listingId: args.listingId, urgency: plan.urgency, daysSince: plan.daysSince },
      }, svc)
      callRouted = sig.ok
    } catch { /* best-effort */ }
  }

  return { proposed: proposed.ok, callRouted }
}
