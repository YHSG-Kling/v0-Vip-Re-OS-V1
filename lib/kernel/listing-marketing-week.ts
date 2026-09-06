// lib/kernel/listing-marketing-week.ts
//
// THE MARKETING RECEIPT — the seller's weekly "what did the marketing actually DO" card.
//
// The promo pipeline renders listing videos and the publish-social-posts cron actually
// POSTS approved social posts — but until this module, the SELLER never heard that any
// of it happened. This is the consolidated fix: ONE autonomous portal value card per
// listing per week ("This week's marketing for {address}: N posts published, video
// finished production"), pushed via the canonical pushPortalValueCard idiom
// (transparency_updates, is_visible_to_client, contactId-keyed) — batch, never per-post.
//
// Ridden by the weekly seller-updates cron (app/api/cron/seller-updates/route.ts), which
// already iterates active listings on a 7-day-per-listing bucket and resolves the
// seller contact linkage (seller_contact_id ?? contact_id). This module still carries its
// OWN listing-scoped weekly dedupe so cadence never depends on the caller's bucket.
//
// HONESTY OVER NOISE — only counts that are REAL rows are stated: social_posts with
// status='published' (the publish cron stamps published_at on actual sends) and
// listing_promo_videos whose render completed (drafted_at stamped when the finished
// video's social drafts were staged). No activity this week = no card.
//
// Dependency-light (supabase service-client TYPE only) — same contract as portal-value.

import type { createServiceClient } from "@/lib/supabase/service"
import { pushPortalValueCard, type PortalValueResult } from "@/lib/kernel/portal-value"

type Svc = ReturnType<typeof createServiceClient>

/** The card's update_type — half of every dedupe key on the portal feed. */
export const LISTING_MARKETING_WEEK_TYPE = "listing_marketing_week"

/** One weekly bucket. */
export const MARKETING_WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", tiktok: "TikTok",
  youtube: "YouTube", pinterest: "Pinterest", twitter: "X", google_business: "Google Business",
}

export interface MarketingWeekFacts {
  /** social_posts actually PUBLISHED for this listing in the window. */
  postsPublished: number
  /** Distinct platforms those posts went out on (raw platform keys). */
  platforms: string[]
  /** Listing promo videos whose render completed in the window. */
  videosCompleted: number
}

/**
 * Pure: "Facebook, Instagram and LinkedIn".
 *
 * MODULE-LOCAL (orphan burn-down, lane E): this was `export`ed with no importer
 * anywhere. Nothing is deleted — composeMarketingWeekCard below still calls it,
 * on the line that builds the "across …" clause — only the export keyword is
 * gone, so the function stops being reachable from outside the one card it
 * phrases. Keeping it private is also what stops a second surface from
 * re-wording the platform list independently of PLATFORM_LABELS.
 */
function listPlatforms(platforms: string[]): string {
  const labels = [...new Set(platforms)].map((p) => PLATFORM_LABELS[p] ?? p)
  if (labels.length === 0) return ""
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}

/**
 * Pure: the consolidated weekly card copy — null when there is NOTHING real to report
 * (no card beats an empty brag; honesty over noise).
 */
export function composeMarketingWeekCard(
  address: string,
  facts: MarketingWeekFacts,
): { title: string; summary: string } | null {
  if (facts.postsPublished <= 0 && facts.videosCompleted <= 0) return null
  const bits: string[] = []
  if (facts.postsPublished > 0) {
    const where = facts.platforms.length > 0 ? ` across ${listPlatforms(facts.platforms)}` : ""
    bits.push(`${facts.postsPublished} social post${facts.postsPublished === 1 ? "" : "s"} published${where}`)
  }
  if (facts.videosCompleted > 0) {
    bits.push(`your listing video${facts.videosCompleted === 1 ? "" : "s"} finished production and ${facts.videosCompleted === 1 ? "is" : "are"} fueling the push`)
  }
  return {
    title: `This week's marketing for ${address}`,
    summary: `Your team kept ${address} in front of buyers this week: ${bits.join("; ")}. It all runs continuously in the background — you don't have to do a thing.`,
  }
}

export interface WeeklyMarketingCardInput {
  brokerageId: string
  listingId: string
  /** The listing's linked seller (listings.seller_contact_id ?? listings.contact_id). */
  sellerContactId: string
  /** Display address for the card copy. */
  address: string
  now?: Date
}

/**
 * Push ONE consolidated marketing card for a listing's seller, at most once per listing
 * per week. Gathers REAL activity from the last 7 days (published social_posts +
 * completed listing_promo_videos), composes the receipt, and writes it through
 * pushPortalValueCard. Skips honestly when there's no activity or a card already went
 * out this week. Never throws — a receipt must never break the calling cron.
 */
export async function pushWeeklyMarketingCard(
  input: WeeklyMarketingCardInput,
  client?: Svc,
): Promise<PortalValueResult & { facts?: MarketingWeekFacts }> {
  if (!input.brokerageId || !input.listingId || !input.sellerContactId) {
    return { pushed: false, reason: "missing_required" }
  }
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = input.now ?? new Date()
  const since = new Date(now.getTime() - MARKETING_WEEK_WINDOW_MS).toISOString()

  try {
    // Weekly bucket dedupe — LISTING-scoped (pushPortalValueCard's own window is
    // contact-scoped and daily; this is the "one per listing per week" guarantee).
    const { data: already } = await supabase
      .from("transparency_updates")
      .select("id")
      .eq("contact_id", input.sellerContactId)
      .eq("listing_id", input.listingId)
      .eq("update_type", LISTING_MARKETING_WEEK_TYPE)
      .eq("is_visible_to_client", true)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle()
    if (already) return { pushed: false, reason: "already_this_week" }

    // REAL published posts — the publish-social-posts cron stamps status='published'
    // + published_at only on actual sends.
    const { data: posts } = await supabase
      .from("social_posts")
      .select("id, platform")
      .eq("brokerage_id", input.brokerageId)
      .eq("listing_id", input.listingId)
      .eq("status", "published")
      .gte("published_at", since)
      .limit(100)
    const postRows = (posts ?? []) as Array<{ id: string; platform: string | null }>

    // REAL completed promo videos — drafted_at is stamped when the finished render's
    // social drafts were staged (i.e. the video exists in our storage).
    const { data: videos } = await supabase
      .from("listing_promo_videos")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .eq("listing_id", input.listingId)
      .eq("status", "social_drafted")
      .gte("drafted_at", since)
      .limit(20)

    const facts: MarketingWeekFacts = {
      postsPublished: postRows.length,
      platforms: [...new Set(postRows.map((p) => p.platform).filter((p): p is string => !!p))],
      videosCompleted: (videos ?? []).length,
    }

    const copy = composeMarketingWeekCard(input.address, facts)
    if (!copy) return { pushed: false, reason: "no_marketing_activity", facts }

    const pushed = await pushPortalValueCard({
      brokerageId: input.brokerageId,
      contactId: input.sellerContactId,
      listingId: input.listingId,
      title: copy.title,
      summary: copy.summary,
      updateType: LISTING_MARKETING_WEEK_TYPE,
      now,
      metadata: {
        listing_id: input.listingId,
        posts_published: facts.postsPublished,
        platforms: facts.platforms,
        videos_completed: facts.videosCompleted,
        week_since: since,
        seller_safe: true,
        // "Share these" nudge — the portal feed deep-links this card to the
        // seller's Share My Home rail (portal home #share-my-home anchor),
        // where the week's PUBLISHED posts are one tap from the seller's own
        // social channels. Anchor id, not a URL — the portal owns the route.
        share_cta_anchor: "share-my-home",
      },
    }, supabase)
    return { ...pushed, facts }
  } catch {
    return { pushed: false, reason: "sweep_error" }
  }
}
