/**
 * lib/ads/ad-creative-engine.ts
 *
 * Wave 41 — the AD CREATIVE ENGINE. Gives the agent a SECOND source of ad
 * creative (besides omnipresent-campaign content): high-performing COMPETITOR
 * ads in their market. A competitor ad that has run a long time is a proven
 * winner (advertisers kill losers fast), so we mine the existing competitor_ads
 * swipe file, take the winners, and auto-generate a NEW creative that exploits
 * the same angle — copy is freshly generated (never copied), and the VIDEO comes
 * from the ASSET MANAGER's library (the agent's avatar/listing reels).
 *
 * Output lands as a DRAFT ad creative in the ad_creative approval queue, so a
 * human reviews the headline/copy/CTA before it can ever run as a paid ad.
 *
 * rankCompetitorAds() + the fallback are pure (unit-tested); the proposer uses
 * the service client + the metered AI gateway. Not server-only.
 */
import { createServiceClient } from "@/lib/supabase/service"

export interface CompetitorAdRow {
  id:               string
  competitor_name:  string | null
  source_platform:  string | null
  ad_headline:      string | null
  ad_copy:          string | null
  engagement_score: number | null
  first_seen_at:    string | null
  last_seen_at:     string | null
  ad_delivery_start: string | null
  ad_delivery_stop:  string | null
}

export interface RankedCompetitorAd {
  id: string; competitorName: string | null; platform: string | null
  headline: string | null; copy: string | null
  longevityDays: number; engagementScore: number; score: number; isHighPerforming: boolean
}

// A winner has either run a long time OR earned strong engagement.
export const HIGH_PERF_MIN_LONGEVITY_DAYS = 14
export const HIGH_PERF_MIN_ENGAGEMENT     = 70

/**
 * Pure: rank competitor ads by proven performance. Longevity (days the ad has
 * been live — a strong signal, since losers are killed fast) plus engagement.
 * Vanity reach is NOT used. Returns descending by score.
 */
export function rankCompetitorAds(rows: CompetitorAdRow[], now: Date = new Date()): RankedCompetitorAd[] {
  const ranked = rows.map((r) => {
    const start = r.ad_delivery_start ?? r.first_seen_at
    const end   = r.ad_delivery_stop ?? r.last_seen_at ?? now.toISOString()
    const longevityDays = start ? Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000)) : 0
    const engagementScore = Math.max(0, Math.min(100, Number(r.engagement_score ?? 0)))
    const score = longevityDays + engagementScore * 0.5
    const isHighPerforming = longevityDays >= HIGH_PERF_MIN_LONGEVITY_DAYS || engagementScore >= HIGH_PERF_MIN_ENGAGEMENT
    return { id: r.id, competitorName: r.competitor_name, platform: r.source_platform, headline: r.ad_headline, copy: r.ad_copy, longevityDays, engagementScore, score, isHighPerforming }
  })
  return ranked.sort((a, b) => b.score - a.score)
}

export interface GeneratedCreative { variationName: string; headline: string; primaryText: string; description: string; callToAction: string }

/**
 * Pure deterministic fallback when the AI gateway is unavailable — seller-safe,
 * Fair-Housing-clean, and clearly NOT a copy of the competitor (generic angle).
 */
export function fallbackCreative(ad: RankedCompetitorAd, brokerageName: string): GeneratedCreative {
  return {
    variationName: `Inspired by a top ${ad.platform ?? "local"} ad`,
    headline:      "Thinking of Making a Move?",
    primaryText:   `See what's happening in your local market and what your home could mean for your next step. ${brokerageName} is here to help you plan — no pressure.`,
    description:   "Local market insights",
    callToAction:  "LEARN_MORE",
  }
}

/** Pure: the prompt that turns a winning competitor ANGLE into NEW, compliant copy. */
export function buildCreativePrompt(ad: RankedCompetitorAd, brokerageName: string): string {
  return [
    `You are a senior real-estate ad copywriter for the brokerage "${brokerageName}".`,
    `A competitor's ad has performed well (${ad.longevityDays} days live, engagement ${ad.engagementScore}/100). Use its ANGLE as inspiration only — DO NOT copy its wording.`,
    ad.headline ? `Competitor headline (for angle only): "${ad.headline}"` : "",
    ad.copy ? `Competitor body (for angle only): "${ad.copy.slice(0, 300)}"` : "",
    `Write ONE fresh, original ad creative that exploits the same intent but in our own voice.`,
    `HARD RULES: Fair Housing compliant (no language about protected classes or who "should" live somewhere); no fabricated claims/prices; concise.`,
    `Return STRICT JSON only: {"variationName":string,"headline":string<=40 chars,"primaryText":string<=125 chars,"description":string<=30 chars,"callToAction":one of LEARN_MORE|SIGN_UP|CONTACT_US|GET_OFFER}`,
  ].filter(Boolean).join("\n")
}

export interface ProposeCreativeResult { scanned: number; proposed: number; usedAssetManagerMedia: number }

/**
 * Find the best Asset-Manager output (an approved avatar/listing video) to back an
 * ad creative — "the content comes from the asset manager". Prefers the agent's
 * own reusable avatar reel; falls back to a brokerage-scoped one.
 */
async function resolveAdCreativeMedia(
  brokerageId: string, agentUserId: string | null, supabase: ReturnType<typeof createServiceClient>,
): Promise<{ assetId: string; url: string } | null> {
  let q = supabase.from("marketing_assets")
    .select("id, asset_url, agent_user_id, tags")
    .eq("brokerage_id", brokerageId).eq("asset_type", "video").eq("approval_status", "approved")
    .not("asset_url", "is", null)
    .order("created_at", { ascending: false }).limit(20)
  const { data } = await q
  const rows = (data ?? []) as Array<{ id: string; asset_url: string | null; agent_user_id: string | null; tags: string[] | null }>
  if (rows.length === 0) return null
  const isAvatar = (t: string[] | null) => Array.isArray(t) && t.some((x) => x === "avatar" || x === "reusable")
  // Prefer the agent's own avatar reel → any avatar reel → any approved video.
  const pick = rows.find((r) => r.agent_user_id === agentUserId && isAvatar(r.tags))
    ?? rows.find((r) => isAvatar(r.tags)) ?? rows[0]
  return pick.asset_url ? { assetId: pick.id, url: pick.asset_url } : null
}

/** Reuse/create the brokerage's draft "AI Creative Lab" campaign to hold AI ideas. */
async function ensureCreativeLabCampaign(brokerageId: string, supabase: ReturnType<typeof createServiceClient>): Promise<string | null> {
  const { data: existing } = await supabase.from("ad_campaigns")
    .select("id").eq("brokerage_id", brokerageId).eq("campaign_name", "AI Creative Lab").eq("status", "draft").maybeSingle()
  if (existing) return (existing as { id: string }).id
  const { data, error } = await supabase.from("ad_campaigns").insert({
    brokerage_id: brokerageId, campaign_name: "AI Creative Lab", platform: "facebook", objective: "leads", status: "draft", daily_budget: 0,
  }).select("id").maybeSingle()
  if (error || !data) return null
  return (data as { id: string }).id
}

/**
 * For a brokerage's high-performing competitor ads, auto-generate NEW ad creatives
 * (fresh copy + an Asset-Manager video) and drop them into the ad_creative approval
 * queue as drafts. Idempotent — one creative per competitor ad.
 */
export async function proposeCompetitorInspiredCreative(
  brokerageId: string,
  client?: ReturnType<typeof createServiceClient>,
  opts: { limit?: number } = {},
): Promise<ProposeCreativeResult> {
  const supabase = client ?? createServiceClient()
  const { data: ads } = await supabase
    .from("competitor_ads")
    .select("id, competitor_name, source_platform, ad_headline, ad_copy, engagement_score, first_seen_at, last_seen_at, ad_delivery_start, ad_delivery_stop")
    .eq("brokerage_id", brokerageId)
    .limit(100)
  const ranked = rankCompetitorAds((ads ?? []) as CompetitorAdRow[]).filter((a) => a.isHighPerforming).slice(0, opts.limit ?? 3)
  if (ranked.length === 0) return { scanned: 0, proposed: 0, usedAssetManagerMedia: 0 }

  const { data: brk } = await supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  const brokerageName = (brk as { name?: string } | null)?.name ?? "Your Brokerage"

  let proposed = 0, usedMedia = 0
  for (const ad of ranked) {
    // Idempotent — already generated a creative from this competitor ad.
    const { data: dupe } = await supabase.from("ad_creative_variations").select("id").eq("competitor_ad_id", ad.id).maybeSingle()
    if (dupe) continue

    const campaignId = await ensureCreativeLabCampaign(brokerageId, supabase)
    if (!campaignId) continue

    // Fresh copy (never a copy of the competitor) via the metered gateway.
    let creative: GeneratedCreative = fallbackCreative(ad, brokerageName)
    try {
      const { generateAIText } = await import("@/lib/ai/generate")
      const { text } = await generateAIText(buildCreativePrompt(ad, brokerageName), { feature: "ad_creative_competitor", temperature: 0.7, maxTokens: 400 })
      const parsed = JSON.parse((text.match(/\{[\s\S]*\}/)?.[0]) ?? "{}")
      if (parsed.headline && parsed.primaryText) {
        creative = {
          variationName: String(parsed.variationName ?? creative.variationName).slice(0, 80),
          headline:      String(parsed.headline).slice(0, 60),
          primaryText:   String(parsed.primaryText).slice(0, 300),
          description:   String(parsed.description ?? "").slice(0, 60),
          callToAction:  ["LEARN_MORE", "SIGN_UP", "CONTACT_US", "GET_OFFER"].includes(parsed.callToAction) ? parsed.callToAction : "LEARN_MORE",
        }
      }
    } catch { /* fall back to the deterministic creative */ }

    const media = await resolveAdCreativeMedia(brokerageId, null, supabase)
    if (media) usedMedia++

    const { error } = await supabase.from("ad_creative_variations").insert({
      brokerage_id: brokerageId, ad_campaign_id: campaignId, variation_name: creative.variationName,
      headline: creative.headline, primary_text: creative.primaryText, description: creative.description, call_to_action: creative.callToAction,
      media_asset_url: media?.url ?? null, source_marketing_asset_id: media?.assetId ?? null,
      competitor_ad_id: ad.id, generated_from: "competitor", approval_status: "draft",
    })
    if (!error) proposed++
  }
  return { scanned: ranked.length, proposed, usedAssetManagerMedia: usedMedia }
}
