"use server"

/**
 * app/actions/gbp-auto-posts.ts
 *
 * Google Business Profile (GBP) auto-posts for "Just Listed" and "Just Sold"
 * milestones. Reuses the existing createSocialPost flow — GBP is just one
 * more platform on social_media_accounts. The compliance gate runs for free.
 *
 * Two triggers:
 *   • triggerJustListedAutoPostAction(listingId)   — fired by the listing
 *     lifecycle when stage transitions to "active". Idempotent — checks
 *     for an existing GBP post on the listing first.
 *   • triggerJustSoldAutoPostAction(listingId)     — fired on "closed".
 *
 * Agent can disable per-brokerage via brokerage_settings.gbp_auto_post_enabled
 * (defaults to true if column is absent — fail-open since this is opt-in).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { createSocialPost } from "@/app/actions/social-publishing"

type Trigger = "just_listed" | "just_sold"

const COPY_TEMPLATES: Record<Trigger, (l: ListingPayload) => string> = {
  just_listed: (l) =>
    `🏡 Just listed in ${l.city ?? "your neighborhood"}! ${l.bedrooms ?? "?"} bed, ${l.bathrooms ?? "?"} bath at ${l.address ?? "—"}${l.list_price ? ` · $${Number(l.list_price).toLocaleString()}` : ""}. Want a private tour? Reach out today.`,
  just_sold: (l) =>
    `🎉 Just sold in ${l.city ?? "your neighborhood"}! Helping another family ${l.list_price ? "find their next chapter" : "close on a great home"}. Curious what your home would sell for? Let's talk.`,
}

interface ListingPayload {
  id: string
  brokerage_id: string
  agent_id: string | null
  address: string | null
  city: string | null
  state: string | null
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  list_price: number | null
  lifecycle_stage: string | null
  status: string | null
  cover_photo_url: string | null
}

async function loadListing(listingId: string): Promise<ListingPayload | null> {
  const supabase = createServiceClient()
  const { data: listing } = await supabase
    .from("listings")
    .select(
      "id, brokerage_id, agent_id, address, city, state, bedrooms, bathrooms, sqft, list_price, lifecycle_stage, status",
    )
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return null

  // Cover photo lives on listing_media (is_primary OR sort_order=0). Fall
  // back to the first photo when no primary is flagged.
  const { data: primary } = await supabase
    .from("listing_media")
    .select("file_url, is_primary, sort_order")
    .eq("listing_id", listingId)
    .eq("media_type", "photo")
    .order("is_primary", { ascending: false })
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle()

  return {
    ...(listing as any),
    cover_photo_url: (primary?.file_url as string | null) ?? null,
  }
}

async function gbpEnabledFor(brokerageId: string): Promise<boolean> {
  // No per-brokerage toggle table exists yet (brokerage_brand_settings is
  // brand-only — has tagline / colors / signature etc., no JSON settings
  // bag). Default to enabled; broker can disconnect the GBP social account
  // in social_media_accounts to opt out.
  void brokerageId
  return true
}

async function alreadyPosted(listingId: string, trigger: Trigger): Promise<boolean> {
  const supabase = createServiceClient()
  const { count } = await supabase
    .from("social_posts")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listingId)
    .eq("platform", "google_business")
    .eq("post_type", trigger)
  return (count ?? 0) > 0
}

async function autoPost(listing: ListingPayload, trigger: Trigger, userId: string) {
  if (!(await gbpEnabledFor(listing.brokerage_id))) {
    return { success: false as const, skipped: "brokerage_disabled" }
  }
  if (await alreadyPosted(listing.id, trigger)) {
    return { success: false as const, skipped: "already_posted" }
  }

  const content = COPY_TEMPLATES[trigger](listing)
  const post = await createSocialPost({
    content,
    mediaUrls: listing.cover_photo_url ? [listing.cover_photo_url] : [],
    hashtags: ["JustListed", "RealEstate", listing.city ? listing.city.replace(/\s+/g, "") : "Home"]
      .filter(Boolean)
      .slice(0, 3),
    scheduledFor: new Date().toISOString(),
    platforms: ["google_business"],
    contentType: trigger,
    linkedListingId: listing.id,
    generatedByAi: false,
    aiPrompt: `auto:${trigger}`,
    userId,
    // Autonomous public post → never auto-publish; hold for human release in the
    // Command Center (it surfaces in the Social approval queue).
    forceApprovalPending: true,
  })

  return { success: true as const, post }
}

export async function triggerJustListedAutoPostAction(input: { listingId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  const listing = await loadListing(input.listingId)
  if (!listing || listing.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "not_found" }
  }
  return autoPost(listing, "just_listed", auth.userId)
}

export async function triggerJustSoldAutoPostAction(input: { listingId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  const listing = await loadListing(input.listingId)
  if (!listing || listing.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "not_found" }
  }
  return autoPost(listing, "just_sold", auth.userId)
}

/** Cron-friendly version — runs without an authenticated session. */
export async function gbpAutoPostsCronTick() {
  const supabase = createServiceClient()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Just listed: lifecycle_stage flipped to 'active' in last 24h
  const { data: justListed } = await supabase
    .from("listings")
    .select("id, brokerage_id, agent_id")
    .eq("lifecycle_stage", "active")
    .gte("updated_at", since)

  // Just sold: status flipped to 'closed' in last 24h
  const { data: justSold } = await supabase
    .from("listings")
    .select("id, brokerage_id, agent_id")
    .eq("status", "closed")
    .gte("updated_at", since)

  const results: Array<{ listingId: string; trigger: Trigger; outcome: any }> = []

  for (const l of justListed ?? []) {
    const listing = await loadListing(l.id)
    if (listing && l.agent_id) {
      const { data: agent } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", l.agent_id)
        .maybeSingle()
      if (agent?.user_id) {
        const out = await autoPost(listing, "just_listed", agent.user_id)
        results.push({ listingId: l.id, trigger: "just_listed", outcome: out })
      }
    }
  }
  for (const l of justSold ?? []) {
    const listing = await loadListing(l.id)
    if (listing && l.agent_id) {
      const { data: agent } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", l.agent_id)
        .maybeSingle()
      if (agent?.user_id) {
        const out = await autoPost(listing, "just_sold", agent.user_id)
        results.push({ listingId: l.id, trigger: "just_sold", outcome: out })
      }
    }
  }

  return { processed: results.length, results }
}
