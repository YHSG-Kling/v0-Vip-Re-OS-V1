/**
 * app/api/cron/listing-promo-social-publish/route.ts
 *
 * Downstream cron for the Just Listed auto-promo flow. Runs every 2 minutes.
 *
 * For every listing_promo_videos row where:
 *   - status = 'rendering'
 *   - the linked ai_video_projects.video_url is populated (the
 *     poll-did-videos cron has downloaded the finished render to OUR
 *     Supabase storage and written the canonical URL)
 *
 * Insert three social_posts rows — one per platform (facebook, instagram,
 * linkedin) — referencing the canonical video_url + a caption built from
 * the same listing facts the script used. The existing publish-social-posts
 * cron (hourly) sends them once approval_status='approved'.
 *
 * The reactor already ran pre-flight compliance, so the script + caption
 * are pre-cleared. The dispatch-layer compliance runs again on send via the
 * publish-social-posts cron.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
// ONE SPELLING FOR THE PUBLIC EVENT LABEL (§6) — the caption's hook and the
// reel's cover frame are the same words seen by the same audience.
import { promoEventLabel } from "@/lib/video/promo-composition"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

const PLATFORMS = ["facebook", "instagram", "linkedin", "tiktok", "youtube", "pinterest", "twitter", "google_business"] as const

/** Per-platform caption — tailored to each network's voice + char limits.
 *  All variants are compliance-pre-cleared by the reactor's gate (Brand
 *  voice + Fair Housing + Them-First); the platform-specific wrapping is
 *  presentational only (hashtag mix, length, CTA shape). */
function captionFor(platform: typeof PLATFORMS[number], parts: {
  hook: string; address: string; cityState: string; price: string
}): string {
  const { hook, address, cityState, price } = parts
  const head = `${hook}: ${address}${cityState ? " — " + cityState : ""}${price ? " · " + price : ""}.`
  switch (platform) {
    case "facebook":
      return `${head}\nDM to schedule a tour.\n#RealEstate #JustListed`
    case "linkedin":
      return `${head}\nReach out to schedule a tour or learn more about the local market.\n#RealEstate`
    case "instagram":
      return `${head}\n.\nDM to tour 🏡\n.\n#RealEstate #JustListed #DreamHome #PropertyOfTheDay #HomeSweetHome`
    case "tiktok":
      return `${head} 🏡\nDM to tour.\n#RealEstate #JustListed #HouseTour #PropertyOfTheDay #RealEstateAgent`
    case "youtube":
      // YouTube Shorts — SEO-rich, links to landing page when wired
      return `${head}\nDM to schedule a tour.\n\n#Shorts #RealEstate #JustListed #HouseTour`
    case "pinterest":
      // Pinterest — aspirational, longer description encouraged
      return `${head}\nA new property has come to market — tap to explore the photos and arrange a tour.\n#RealEstate #JustListed #DreamHome #HomeInspiration`
    case "twitter":
      // 280-char ceiling — keep it tight
      return `${head} DM to tour. #RealEstate`
    case "google_business":
      // Google Business Profile updates render under the listing's local
      // knowledge panel; lean local + actionable.
      return `${head}\nDM to schedule a tour today.`
  }
}

interface PromoRow {
  id:               string
  brokerage_id:     string
  listing_id:       string
  agent_id:         string
  video_project_id: string | null
  event_type:       string
  created_at:       string | null
  project:          {
    video_url:      string | null
    thumbnail_url:  string | null
    status:         string | null
  } | null
  listing:          {
    address:        string | null
    city:           string | null
    state:          string | null
    list_price:     number | null
  } | null
}

export async function GET(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  const querySecret  = new URL(req.url).searchParams.get("secret")
  const expected     = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (headerSecret !== expected && querySecret !== expected) return unauthorized()

  const svc = createServiceClient()

  const { data: rows, error } = await svc
    .from("listing_promo_videos")
    .select(`
      id, brokerage_id, listing_id, agent_id, video_project_id, event_type, created_at,
      project:ai_video_projects!listing_promo_videos_video_project_id_fkey(video_url, thumbnail_url, status),
      listing:listings!listing_promo_videos_listing_id_fkey(address, city, state, list_price)
    `)
    .eq("status", "rendering")
    .not("video_project_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(25)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ id: string; outcome: string; reason?: string; post_count?: number }> = []

  for (const r of (rows ?? []) as unknown as PromoRow[]) {
    // Wave 28 — readiness branch. Three states:
    //   1. project.status='failed' → mark the listing_promo_videos row
    //      'failed' so the cron stops looping on it; agent sees it in the
    //      degraded-renders observability surface
    //   2. project.video_url unset, project.status NOT failed → still
    //      rendering, wait next tick (existing behavior)
    //   3. project.video_url set → proceed to social draft (existing)
    //
    // Beyond a generous grace window (24h from the listing_promo_videos
    // row creation) we also defer — a stuck render at that point needs
    // human intervention, not silent waiting.
    const projectStatus = r.project?.status ?? null
    if (projectStatus === "failed") {
      await svc.from("listing_promo_videos")
        .update({ status: "failed", error_message: "render failed (ai_video_projects.status='failed')" })
        .eq("id", r.id)
      results.push({ id: r.id, outcome: "deferred", reason: "render_failed" })
      continue
    }
    if (!r.project?.video_url) {
      const createdMs = r.created_at ? Date.parse(r.created_at) : null
      const stuckPastGrace = createdMs !== null && (Date.now() - createdMs > 24 * 60 * 60 * 1000)
      if (stuckPastGrace) {
        await svc.from("listing_promo_videos")
          .update({ status: "failed", error_message: "render did not complete within 24h grace window" })
          .eq("id", r.id)
        results.push({ id: r.id, outcome: "deferred", reason: "render_stuck_past_grace_window" })
      }
      continue // otherwise still rendering — wait next tick
    }

    const usd = (n: number | null | undefined) =>
      n != null
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
        : ""
    const address  = r.listing?.address ?? ""
    const cityState = [r.listing?.city, r.listing?.state].filter(Boolean).join(", ")
    const price    = usd(r.listing?.list_price)
    // TOMBSTONE (§1/§6): the private `hookByEvent` map that stood here — three
    // entries plus a "New Listing" default — was a SECOND spelling of
    // lib/video/promo-composition.ts:promoEventLabel, which already carries the
    // same three events, the same default, and the rest of the lifecycle set.
    // Both write PUBLIC copy (that one the reel's cover frame, this one the
    // social caption), so they could not be allowed to disagree; the local one
    // still said "Price Update" after the owner ruled the public word is a price
    // improvement. SURVIVOR: lib/video/promo-composition.ts:162 promoEventLabel.
    const hook = promoEventLabel(r.event_type)

    const postIds: string[] = []
    let inserted = 0
    let failed   = 0
    // Map our listing_promo_videos.event_type to social_posts.post_type
    // (its check constraint covers new_listing | coming_soon | open_house_* |
    // price_reduction | just_sold | open_house_recap | market_update | custom).
    const postType =
      r.event_type === "just_listed"   ? "new_listing"
      : r.event_type === "just_sold"   ? "just_sold"
      : r.event_type === "price_changed" ? "price_reduction"
      : "custom"

    // Since m366 listing_promo_videos.agent_id is agents-class — the SAME class
    // social_posts.agent_id FKs, so that one is a straight carry. The users→agents
    // resolve that used to sit here would now convert an agents id a second time
    // and come back empty. social_posts.user_id is the column that still needs the
    // other direction, so resolve agents→users once, here.
    const socialAgentId = r.agent_id
    const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
    const socialUserId = await resolveAgentRecordToUserId(r.agent_id)
    if (!socialUserId) {
      await svc.from("listing_promo_videos").update({
        status:        "failed",
        error_message: "social-publish: users.id lookup failed for agents.id " + r.agent_id,
      }).eq("id", r.id)
      results.push({ id: r.id, outcome: "failed", reason: "users_id_lookup_failed" })
      continue
    }

    for (const platform of PLATFORMS) {
      const caption = captionFor(platform, { hook, address, cityState, price })
      try {
        const { data: post } = await svc
          .from("social_posts")
          .insert({
            brokerage_id:     r.brokerage_id,
            agent_id:         socialAgentId,  // agents.id (carried from the promo row)
            user_id:          socialUserId,   // users.id (legacy column on social_posts)
            listing_id:       r.listing_id,
            platform,
            post_type:        postType,
            content:          caption,
            status:           "scheduled",
            approval_status:  "pending",
            scheduled_for:    new Date(Date.now() + 60 * 60_000).toISOString(),
          })
          .select("id")
          .maybeSingle()
        if (post?.id) {
          postIds.push(post.id as string)
          inserted++
        } else {
          failed++
        }
      } catch {
        failed++
      }
    }

    await svc.from("listing_promo_videos")
      .update({
        status:          inserted > 0 ? "social_drafted" : "failed",
        social_post_ids: postIds,
        drafted_at:      inserted > 0 ? new Date().toISOString() : null,
        error_message:   inserted === 0 ? "social_posts insert failed for all platforms" : null,
      })
      .eq("id", r.id)

    results.push({
      id:        r.id,
      outcome:   inserted > 0 ? "social_drafted" : "failed",
      post_count: inserted,
      reason:    failed > 0 && inserted === 0 ? "all_platforms_failed" : undefined,
    })
  }

  return NextResponse.json({
    ran_at:    new Date().toISOString(),
    processed: results.length,
    results,
  })
}
