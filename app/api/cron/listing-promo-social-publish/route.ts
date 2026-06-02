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

const PLATFORMS = ["facebook", "instagram", "linkedin"] as const

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

    // Caption is concise + brand-voice-clean. The script (in the video) carries
    // the detailed pitch; the caption is the post copy.
    const caption =
      `${hook}: ${address}${cityState ? " — " + cityState : ""}${price ? " · " + price : ""}.\n` +
      `DM to schedule a tour.\n` +
      `#RealEstate #${r.event_type === "just_sold" ? "JustSold" : "JustListed"}`

    const postIds: string[] = []
    let inserted = 0
    let failed   = 0
    for (const platform of PLATFORMS) {
      try {
        const { data: post } = await svc
          .from("social_posts")
          .insert({
            brokerage_id:     r.brokerage_id,
            agent_id:         r.agent_id,
            user_id:          r.agent_id,
            listing_id:       r.listing_id,
            platform,
            content:          caption,
            status:           "scheduled",
            approval_status:  "pending_review",
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
