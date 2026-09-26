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
 *   · TOPIC-POOL VIDEOS — a separate step (runTopicPoolStep below).
 */
/**
 * STEP 2 — TOPIC POOL → VIDEO (wave 82C; its own step since wave 83B). Each
 * tenant, on its own cadence days (brokerage_settings.settings.topic_video_cadence,
 * default three a week), gets a broadcast video built on a topic from the ONE pool
 * (content_topic_bank via pickTopics) for one CONTACT PERSONA, staged pending_review
 * through the Director — see lib/video/topic-video-runner.ts. Owner (wave 83): it
 * had been destructured into the listing plays' const beside runListingBrochures,
 * "which is run for listing brochure on a new listing and does not fit in for the
 * capability". Its own error handling and its own result key (`topicPool`): a
 * failure here is reported as { error } under that key and never fails, or is
 * failed by, the listing plays.
 */
async function runTopicPoolStep(svc: ReturnType<typeof createServiceClient>) {
  try {
    const { runTopicPoolVideos } = await import("@/lib/video/topic-video-runner")
    return await runTopicPoolVideos(svc)
  } catch (e) {
    const error = e instanceof Error ? e.message : "topic-pool videos failed"
    console.error("[cron/video-plays] topic-pool step failed:", error)
    return { error }
  }
}

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
    // STEP 2 starts beside the listing plays but is its OWN step (see runTopicPoolStep):
    // it is not a listing capability, it never fails the listing plays, and they never fail it.
    const topicPoolStep = runTopicPoolStep(svc)
    // STEP 1 — the review- and listing-driven plays (unchanged).
    const [testimonials, walkthroughs, flyers, hangers, carousels, brochures] = await Promise.all([
      runTestimonialReels(svc),
      runWalkthroughPremieres(svc),
      runListingFlyers(svc),
      runDoorHangers(svc),
      runListingCarousels(svc),
      runListingBrochures(svc),
    ])
    const topicPool = await topicPoolStep
    const summary = { ...testimonials, ...walkthroughs, ...flyers, ...hangers, ...carousels, ...brochures, topicPool }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: testimonials.testimonialReels + walkthroughs.walkthroughs + ("topicVideos" in topicPool ? topicPool.topicVideos : 0),
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Video plays complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Video plays failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
