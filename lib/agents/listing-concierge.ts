/**
 * lib/agents/listing-concierge.ts
 *
 * Listing Concierge (Seller Concierge) — one Anthropic Managed Agent per brokerage that
 * runs a per-listing session from LISTING_PUBLISHED through under-contract / expired.
 * Monitors showing feedback, listing-health scores, market shifts; drafts seller updates;
 * recommends price reductions or marketing pivots when listing-health drops.
 *
 * Gates this agent inherits:
 *   - Spawn refuses without a fully-signed listing_agreement (analog to BBA on the buyer
 *     side — agent cannot operate without representation contract).
 *   - System prompt forbids price recommendations without supporting CMA data, and
 *     forbids speculation about specific buyers' motivations or financials.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate, type SpawnResult } from "./spawn-helper"

const LISTING_CONCIERGE_SYSTEM = `You are the Listing Concierge (Seller Concierge) for an active real-estate listing at a Vip-RE-OS brokerage.

YOUR JOB:
1. Read the listing state (DOM, showings, showing feedback, listing-health score, CMA
   when available).
2. Identify trends: feedback themes (e.g. "buyers say bedrooms feel small"), pricing
   pressure (DOM > comp benchmark), low showing velocity.
3. Draft a weekly seller update — what's happened, what feedback says, what we recommend.
4. When listing-health crosses watch/at_risk/critical, flag specific actions: price
   reduction range (with supporting comps), staging change, photography refresh, marketing
   channel expansion.
5. Pre-stage listing-agreement renewals 30 days before expiration.

NEVER:
- Recommend a specific price change without supporting comps from the CMA tools.
- Speculate about specific buyers' financials, motivations, or competing offers.
- Communicate directly with the seller. Output is reviewed by the listing agent.
- Reveal showings, feedback, or offers from one source to a different audience.

RESPONSE FORMAT:
{
  "seller_update":   "...",   // 120 words max, weekly recap for the seller
  "agent_briefing":  "...",   // bullets — what the agent should action this week
  "price_recommendation": {   // null when DOM/feedback don't justify a change
    "direction": "reduce|hold|raise" | null,
    "range_low":  number | null,
    "range_high": number | null,
    "supporting_comp_count": number,
    "rationale": "one sentence"
  } | null,
  "listing_health_trend": "improving|stable|declining",
  "agreement_renewal_due_in_days": number | null,
  "next_check_at":   "ISO8601 timestamp"
}`

const TEMPLATE: AgentTemplate = {
  kind:    "listing_concierge",
  nameFor: (brokerageId) => `Listing Concierge (${brokerageId.slice(0, 8)})`,
  model:   "claude-sonnet-4-6",
  system:  LISTING_CONCIERGE_SYSTEM,
}

export async function spawnListingConciergeForListing(params: {
  brokerageId:    string
  listingId:      string
  environmentId?: string
  kickoff?:       string
}): Promise<SpawnResult> {
  const svc = createServiceClient()

  const { data: listing } = await svc
    .from("listings")
    .select("id, address, city, state, list_price, status, lifecycle_stage, brokerage_id, seller_contact_id")
    .eq("id", params.listingId)
    .maybeSingle()
  if (!listing) return { ok: false, error: "listing not found" }
  if (listing.brokerage_id !== params.brokerageId) {
    return { ok: false, error: "listing brokerage mismatch" }
  }

  // Listing agreement must be fully signed AND owned by the calling brokerage.
  // Analog to BBA on the buyer side — without it the brokerage doesn't legally
  // represent the seller and the concierge agent must not operate. The
  // brokerage_id filter blocks a cross-brokerage spawn that would otherwise
  // pass through if the foreign listing had any fully-signed agreement.
  const { data: agreement } = await svc
    .from("listing_agreements")
    .select("id, esign_status")
    .eq("listing_id", params.listingId)
    .eq("brokerage_id", params.brokerageId)
    .eq("esign_status", "fully_signed")
    .limit(1)
    .maybeSingle()
  if (!agreement) {
    return {
      ok: false,
      error: "No fully-signed listing agreement — refusing to spawn Listing Concierge. The brokerage must have an active representation contract.",
    }
  }

  const propertyAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ") || listing.id.slice(0, 8)

  const kickoff = params.kickoff ?? `Listing: ${propertyAddress}
- List price: ${listing.list_price ?? "n/a"}
- Stage: ${listing.lifecycle_stage ?? "n/a"}
- Status: ${listing.status ?? "n/a"}

Produce your initial seller weekly update + agent briefing per your response format.
Pull showings, showing feedback, listing-health scores via your tools. Do NOT recommend
a price change yet — wait for the next check-in after you've observed the data.`

  return spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "listing",
    entityId:      params.listingId,
    environmentId: params.environmentId,
    title:         `Listing: ${propertyAddress}`,
    kickoff,
    metadata: {
      listing_id:        params.listingId,
      listing_agreement_id: agreement.id as string,
    },
  })
}
