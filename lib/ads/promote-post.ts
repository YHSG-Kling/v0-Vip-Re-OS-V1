/**
 * lib/ads/promote-post.ts
 *
 * THE READER FOR A `content_winner` PROPOSAL. lib/kernel/manager-signals.ts
 * turns the signal into a launch_ad_campaign proposal whose action_input carries
 * `source: "content_winner"` + the signal payload (post_id …) and NO campaign_id
 * — so the executor (lib/ads/ad-manager.ts) failed it with "campaign_id
 * required" every time, exactly as the video_ready proposal did before wave 35.
 * On approval the proposal now STAGES the paid campaign from the winning post:
 *   • ad_campaigns draft on the post's own platform (facebook / instagram /
 *     linkedin — the connectable ones; anything else → facebook), objective
 *     leads, the lane's autonomous daily budget;
 *   • the creative from the post's words and first media, SCANNED FIRST
 *     (compliance_officer's rail — a hard Fair-Housing / guarantee / PII flag
 *     refuses; the organic post may have shipped under a different gate), in
 *     the ONE ad-creative approval queue as a draft;
 *   • destination through the one resolver (the post's listing page, else the
 *     brand site).
 * Idempotent per post. The Meta/Google launch path then applies its own gates
 * (approved creative, connected account, spend cap) — nothing here spends.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateContentSafety } from "@/lib/compliance/content-safety-checks"
import { CONNECTABLE_AD_PLATFORMS } from "@/lib/integrations/ad-campaign-vocabulary"

type Svc = ReturnType<typeof createServiceClient>

/** Autonomous default for a promoted post; clamped by MAX_AD_DAILY_BUDGET_USD at execution. */
const PROMOTE_POST_DAILY_BUDGET_USD = 25

/** Pure: a headline + primary text from a post's words, inside Meta's practical limits. */
export function creativeFromPost(content: string): { headline: string; primaryText: string } {
  const text = content.replace(/\s+/g, " ").trim()
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text
  const headline = (firstSentence.length <= 40 ? firstSentence : `${firstSentence.slice(0, 37).trimEnd()}…`) || "See this post"
  const primaryText = text.length <= 300 ? text : `${text.slice(0, 297).trimEnd()}…`
  return { headline, primaryText }
}

export interface PromotePostResult { ok: boolean; campaignId?: string; creativeId?: string; alreadyStaged?: boolean; reason?: string }

export async function stageCampaignFromSocialPost(input: { brokerageId: string; postId: string; client?: Svc }): Promise<PromotePostResult> {
  const svc = input.client ?? createServiceClient()
  if (!input.brokerageId || !input.postId) return { ok: false, reason: "brokerageId and postId required" }

  const { data: existing, error: exErr } = await svc.from("ad_campaigns").select("id")
    .eq("brokerage_id", input.brokerageId).contains("targeting_config", { source_social_post_id: input.postId }).limit(1).maybeSingle()
  if (exErr) return { ok: false, reason: `ad_campaigns read refused: ${exErr.message}` }
  if (existing) return { ok: true, campaignId: (existing as { id: string }).id, alreadyStaged: true }

  const { data: p, error: pErr } = await svc.from("social_posts")
    .select("id, platform, post_type, content, media_urls, listing_id, user_id, agent_id")
    .eq("id", input.postId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (pErr) return { ok: false, reason: `social_posts read refused: ${pErr.message}` }
  const post = p as { id: string; platform: string; post_type: string | null; content: string | null; media_urls: unknown; listing_id: string | null; user_id: string | null; agent_id: string | null } | null
  if (!post) return { ok: false, reason: "post not found in this brokerage" }
  if (!post.content?.trim()) return { ok: false, reason: "post has no text to promote" }

  // Compliance-first: the paid creative is scanned BEFORE any row exists.
  const hard = evaluateContentSafety(post.content).filter((v) => v.severity === "high")
  if (hard.length) return { ok: false, reason: `post copy refused for paid promotion: ${hard.map((v) => `${v.category}: "${v.phrase}"`).join("; ")}` }

  const platform = (CONNECTABLE_AD_PLATFORMS as readonly string[]).includes(post.platform) ? post.platform : "facebook"
  const media = Array.isArray(post.media_urls) ? (post.media_urls as unknown[]).map((m) => typeof m === "string" ? m : (m as { url?: string })?.url).find((u): u is string => !!u) ?? null : null
  const { headline, primaryText } = creativeFromPost(post.content)

  // agents.id and users.id are DISJOINT (§3); a post may carry either.
  let agentUserId: string | null = post.user_id ?? null
  if (!agentUserId && post.agent_id) {
    const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
    agentUserId = await resolveAgentRecordToUserId(post.agent_id)
  }
  let teamId: string | null = null
  if (post.agent_id) {
    const { data: agentRow } = await svc.from("agents").select("team_id").eq("id", post.agent_id).maybeSingle()
    teamId = (agentRow as { team_id: string | null } | null)?.team_id ?? null
  }
  const { resolveAdDestination } = await import("./ad-destination")
  const destinationUrl = await resolveAdDestination(svc, { brokerageId: input.brokerageId, listingId: post.listing_id, teamId })

  const { data: campaign, error: cErr } = await svc.from("ad_campaigns").insert({
    brokerage_id: input.brokerageId, agent_user_id: agentUserId, created_by: agentUserId,
    campaign_name: `Promoted post — ${headline}`.slice(0, 120), platform, objective: "leads", status: "draft",
    daily_budget: PROMOTE_POST_DAILY_BUDGET_USD, visibility_scope: "agent",
    targeting_config: { play: "promote_post", source_social_post_id: post.id, listing_id: post.listing_id, post_type: post.post_type, source_platform: post.platform },
  }).select("id").single()
  if (cErr || !campaign) return { ok: false, reason: `campaign insert refused: ${cErr?.message ?? "no row"}` }
  const campaignId = (campaign as { id: string }).id

  const { data: cr, error: crErr } = await svc.from("ad_creative_variations").insert({
    brokerage_id: input.brokerageId, ad_campaign_id: campaignId, variation_name: "Organic winner — auto",
    headline, primary_text: primaryText, description: "See more", call_to_action: "LEARN_MORE",
    media_asset_url: media, destination_url: destinationUrl, generated_from: `content_winner:${post.id}`, approval_status: "draft",
  }).select("id").single()
  if (crErr || !cr) return { ok: false, campaignId, reason: `creative insert refused: ${crErr?.message ?? "no row"}` }
  return { ok: true, campaignId, creativeId: (cr as { id: string }).id }
}
