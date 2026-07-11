/**
 * lib/ads/listing-ad-producer.ts
 *
 * Wave 49 — AUTO cross-manager handoff (deliverable-gated, NOT proposal-gated).
 * When a listing goes live (or closes), the system AUTO-produces a draft paid-ad
 * campaign + creative for it — zero agent effort. The finished creative lands in
 * the ad_creative approval queue, so the ONLY human gate is the deliverable before
 * it can run. Media comes from the Asset Manager's library; copy is Fair-Housing
 * clean by construction. Idempotent (one campaign per listing per kind).
 *
 * buildListingCreative() is pure (unit-tested); the producer uses the service client.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

export type ListingAdKind = "just_listed" | "just_sold" | "price_reduction"

export interface ListingFacts {
  address?: string | null; city?: string | null; state?: string | null
  list_price?: number | null; bedrooms?: number | null; bathrooms?: number | null; property_type?: string | null
}

export interface ListingCreative { variationName: string; headline: string; primaryText: string; description: string; callToAction: string }

/**
 * Pure: a Fair-Housing-clean ad creative from listing facts. NO language about who
 * "should" live somewhere or any protected class — only the home + the market.
 */
export function buildListingCreative(facts: ListingFacts, kind: ListingAdKind): ListingCreative {
  // Sanitize the one untrusted field we weave in: city can be scraped/typo'd/poisoned,
  // so a steering term or injected directive in it must never reach client copy.
  const safeCity = sanitizeProperNoun(facts.city, 48)
  const where = safeCity ? `in ${safeCity}` : "in your area"
  const specs = [facts.bedrooms ? `${facts.bedrooms} bed` : null, facts.bathrooms ? `${facts.bathrooms} bath` : null].filter(Boolean).join(", ")
  if (kind === "just_sold") {
    return {
      variationName: "Just Sold — auto",
      headline:      "Just Sold!",
      primaryText:   `Another home ${where} just sold${specs ? ` (${specs})` : ""}. Curious what yours could sell for? Let's talk.`,
      description:   "Local results",
      callToAction:  "LEARN_MORE",
    }
  }
  if (kind === "price_reduction") {
    // Positive, industry-standard framing ("improved" not "reduced/desperate");
    // no protected-class language, no suggested value — just the new opportunity.
    return {
      variationName: "Price Improved — agent-initiated",
      headline:      "Price Improved!",
      primaryText:   `New price on this home ${where}${specs ? ` — ${specs}` : ""}. A fresh opportunity to tour or make it yours. Ask for details today.`,
      description:   "New price",
      callToAction:  "LEARN_MORE",
    }
  }
  return {
    variationName: "Just Listed — auto",
    headline:      "Just Listed!",
    primaryText:   `New on the market ${where}${specs ? ` — ${specs}` : ""}. Book a tour or ask for details today.`,
    description:   "See this home",
    callToAction:  "LEARN_MORE",
  }
}

export interface ProduceResult { produced: boolean; campaignId?: string; creativeId?: string; reason?: string }

/** Find the best Asset-Manager media to back the listing ad. Video first
 *  (avatar/listing reel), then the image library — the still rail now feeds
 *  ads too (carousel hooks, twilight/staged photos, flyer art), so a tenant
 *  with no finished video still runs image ads instead of nothing. */
async function resolveMedia(brokerageId: string, agentUserId: string | null, supabase: ReturnType<typeof createServiceClient>): Promise<{ assetId: string; url: string } | null> {
  const pickFrom = (rows: Array<{ id: string; asset_url: string | null; agent_user_id: string | null; tags: string[] | null }>) => {
    if (rows.length === 0) return null
    const isAdWorthy = (t: string[] | null) => Array.isArray(t) && t.some((x) =>
      x === "avatar" || x === "reusable" || x === "listing" || x === "twilight" || x === "virtually_staged" || x === "CarouselSlide")
    const pick = rows.find((r) => r.agent_user_id === agentUserId && isAdWorthy(r.tags)) ?? rows.find((r) => isAdWorthy(r.tags)) ?? rows[0]
    return pick.asset_url ? { assetId: pick.id, url: pick.asset_url } : null
  }
  for (const assetType of ["video", "image"] as const) {
    const { data } = await supabase.from("marketing_assets")
      .select("id, asset_url, agent_user_id, tags")
      .eq("brokerage_id", brokerageId).eq("asset_type", assetType).eq("approval_status", "approved").not("asset_url", "is", null)
      .order("created_at", { ascending: false }).limit(20)
    const picked = pickFrom((data ?? []) as Array<{ id: string; asset_url: string | null; agent_user_id: string | null; tags: string[] | null }>)
    if (picked) return picked
  }
  return null
}

/**
 * AUTO-produce the listing's paid-ad draft + creative. Idempotent per (listing, kind).
 * The creative is created as a DRAFT → it surfaces in the ad_creative approval queue,
 * the one human gate. No spend, no autonomous publish.
 */
export async function produceListingAdCampaign(
  brokerageId: string, listingId: string, kind: ListingAdKind, client?: ReturnType<typeof createServiceClient>,
): Promise<ProduceResult> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !listingId) return { produced: false, reason: "missing ids" }

  // Idempotent — one auto campaign per listing per kind.
  const { data: existing } = await supabase.from("ad_campaigns")
    .select("id").eq("brokerage_id", brokerageId)
    .contains("targeting_config", { listing_id: listingId, auto_kind: kind }).maybeSingle()
  if (existing) return { produced: false, campaignId: (existing as { id: string }).id, reason: "already produced" }

  const { data: l } = await supabase.from("listings")
    .select("address, city, state, agent_id, list_price, bedrooms, bathrooms, property_type").eq("id", listingId).maybeSingle()
  const listing = l as (ListingFacts & { agent_id: string | null }) | null
  if (!listing) return { produced: false, reason: "listing not found" }

  let agentUserId: string | null = null
  if (listing.agent_id) {
    const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
    agentUserId = await resolveAgentRecordToUserId(listing.agent_id)
  }

  const kindLabel = kind === "just_sold" ? "Just Sold" : kind === "price_reduction" ? "Price Improved" : "Just Listed"
  const campaignName = `${kindLabel} — ${listing.address ?? listing.city ?? "Listing"}`
  const { data: campaign, error: cErr } = await supabase.from("ad_campaigns").insert({
    brokerage_id: brokerageId, agent_user_id: agentUserId, campaign_name: campaignName,
    platform: "facebook", objective: "leads", status: "draft", daily_budget: 0,
    targeting_config: {
      listing_id: listingId, auto_kind: kind,
      locations: [{ city: listing.city ?? undefined, state: listing.state ?? undefined }].filter((x) => x.city || x.state),
    },
  }).select("id").single()
  if (cErr || !campaign) return { produced: false, reason: cErr?.message ?? "campaign insert failed" }
  const campaignId = (campaign as { id: string }).id

  const creative = buildListingCreative(listing, kind)

  // FEEDBACK-CONDITIONED GENERATION (the outcome loop): when this
  // brokerage's own ad ledger has a PROVEN winning variation (experiment-
  // gated: real impressions/spend per arm, >25% lift), the new creative
  // leads with the winner's hook instead of regenerating from first
  // principles — and generated_from records the decision so the flywheel
  // is auditable ('learned:<arm>' vs the norm path).
  let generatedFrom = "listing_handoff"
  try {
    const { learnedCreativeEmphasis } = await import("./ad-outcome-loop")
    // Scope ladder: this agent's own evidence first, then their team's,
    // then the brokerage blend — every tier learns from ITS OWN results.
    let teamId: string | null = null
    if (listing.agent_id) {
      const { data: agentRow } = await supabase.from("agents").select("team_id").eq("id", listing.agent_id).maybeSingle()
      teamId = (agentRow as { team_id: string | null } | null)?.team_id ?? null
    }
    const learned = await learnedCreativeEmphasis(supabase, brokerageId, { agentUserId, teamId })
    // Only the winner's HEADLINE hook is adoptable, and only when it is
    // generic (no digits/addresses — a past listing's facts must never leak
    // into this listing's ad). The primary text ALWAYS stays fact-built
    // from THIS listing.
    const genericHeadline = learned?.headline && learned.headline.length <= 40 && !/\d/.test(learned.headline)
    if (learned && genericHeadline && learned.arm !== creative.variationName) {
      creative.headline = learned.headline as string
      generatedFrom = `learned:${learned.arm}@${learned.scope}`
    }
  } catch { /* the deterministic FH-clean creative stands */ }

  const media = await resolveMedia(brokerageId, agentUserId, supabase)
  const { data: cr, error: crErr } = await supabase.from("ad_creative_variations").insert({
    brokerage_id: brokerageId, ad_campaign_id: campaignId, variation_name: creative.variationName,
    headline: creative.headline, primary_text: creative.primaryText, description: creative.description, call_to_action: creative.callToAction,
    media_asset_url: media?.url ?? null, source_marketing_asset_id: media?.assetId ?? null,
    generated_from: generatedFrom, approval_status: "draft",
  }).select("id").single()
  if (crErr || !cr) return { produced: false, campaignId, reason: crErr?.message ?? "creative insert failed" }

  return { produced: true, campaignId, creativeId: (cr as { id: string }).id }
}
