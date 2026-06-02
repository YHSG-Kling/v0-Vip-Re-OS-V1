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
  project:          {
    video_url:      string | null
    thumbnail_url:  string | null
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
      id, brokerage_id, listing_id, agent_id, video_project_id, event_type,
      project:ai_video_projects!listing_promo_videos_video_project_id_fkey(video_url, thumbnail_url),
      listing:listings!listing_promo_videos_listing_id_fkey(address, city, state, list_price)
    `)
    .eq("status", "rendering")
    .not("video_project_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(25)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ id: string; outcome: string; reason?: string; post_count?: number }> = []

  for (const r of (rows ?? []) as unknown as PromoRow[]) {
    if (!r.project?.video_url) continue // still rendering — wait next tick

    const usd = (n: number | null | undefined) =>
      n != null
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
        : ""
    const address  = r.listing?.address ?? ""
    const cityState = [r.listing?.city, r.listing?.state].filter(Boolean).join(", ")
    const price    = usd(r.listing?.list_price)
    const hookByEvent: Record<string, string> = {
      just_listed:   "Just Listed",
      just_sold:     "Just Sold",
      price_changed: "Price Update",
    }
    const hook = hookByEvent[r.event_type] ?? "New Listing"

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

    // FK gotcha: listing_promo_videos.agent_id stores users.id (m124), but
    // social_posts.agent_id FKs to agents.id (the legacy column convention).
    // Resolve via agents.user_id.
    const { data: agentRecord } = await svc
      .from("agents")
      .select("id")
      .eq("user_id", r.agent_id)
      .eq("brokerage_id", r.brokerage_id)
      .maybeSingle()
    const socialAgentId = (agentRecord?.id as string | null) ?? null
    if (!socialAgentId) {
      await svc.from("listing_promo_videos").update({
        status:        "failed",
        error_message: "social-publish: agents.id lookup failed for users.id " + r.agent_id,
      }).eq("id", r.id)
      results.push({ id: r.id, outcome: "failed", reason: "agents_id_lookup_failed" })
      continue
    }

    for (const platform of PLATFORMS) {
      const caption = captionFor(platform, { hook, address, cityState, price })
      try {
        const { data: post } = await svc
          .from("social_posts")
          .insert({
            brokerage_id:     r.brokerage_id,
            agent_id:         socialAgentId, // agents.id (resolved above)
            user_id:          r.agent_id,    // users.id (legacy column on social_posts)
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
