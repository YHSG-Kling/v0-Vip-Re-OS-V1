import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Video Plays Cron (daily) — the autonomous video moments no competitor runs
 * (survey 2026-07: testimonial→video and lifecycle walkthrough premieres are
 * unstitched across 3 tool categories everywhere else):
 *   · TESTIMONIAL ENGINE — five-star agent_reviews become TestimonialReels,
 *     idempotent per review, staged through the Director's compliance gate.
 *   · WALKTHROUGH PREMIERE — photo-rich listings in their marketing window
 *     get the Ken Burns day-one asset, idempotent per listing.
 * (The third play — market-moment reels — rides refresh-market-rates so it
 * fires in the same tick the rate snapshot lands.)
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "video-plays",
    cron_path: "/app/api/cron/video-plays/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const { runTestimonialReels, runWalkthroughPremieres, runListingFlyers, runDoorHangers } = await import("@/lib/video/video-plays")
    const { runListingCarousels } = await import("@/lib/marketing/social-carousel")
    const { runListingBrochures } = await import("@/lib/documents/listing-brochure")
    const [testimonials, walkthroughs, flyers, hangers, carousels, brochures] = await Promise.all([
      runTestimonialReels(svc),
      runWalkthroughPremieres(svc),
      runListingFlyers(svc),
      runDoorHangers(svc),
      runListingCarousels(svc),
      runListingBrochures(svc),
    ])
    const summary = { ...testimonials, ...walkthroughs, ...flyers, ...hangers, ...carousels, ...brochures }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: testimonials.testimonialReels + walkthroughs.walkthroughs,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Video plays complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Video plays failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
