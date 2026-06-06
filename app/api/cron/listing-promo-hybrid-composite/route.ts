/**
 * app/api/cron/listing-promo-hybrid-composite/route.ts
 *
 * Wave 14 Phase 2 — the hybrid composite cron.
 *
 * After the Remotion render endpoint produces the property reel + submits
 * two D-ID renders (intro hook + outro CTA, via dispatchVideo), this cron
 * sweeps every 2 minutes for ai_video_projects rows that have:
 *
 *   - video_type = 'listing_promo'
 *   - status = 'generating'
 *   - video_url populated (the Remotion middle is in our Supabase storage)
 *   - video_metadata.hybrid_pending = true
 *   - both hybrid_intro_job_id + hybrid_outro_job_id have landed in
 *     ai_video_projects rows (queryable by provider_job_id) with their own
 *     video_url populated by poll-did-videos
 *
 * For each such row:
 *   1. Download the Remotion middle MP4 from our storage.
 *   2. Resolve the intro + outro D-ID URLs.
 *   3. concatIntroOutro() in lib/video/composite-attribution.ts stitches
 *      intro → main → outro via ffmpeg-static (re-encodes audio + video
 *      to a common stream).
 *   4. Upload the final stitched MP4 to Supabase storage at a new path.
 *   5. Update ai_video_projects: video_url ← stitched URL, status='completed',
 *      video_metadata.hybrid_pending=false, hybrid_composited_at=now().
 *   6. Update listing_promo_videos.status='rendering' so the downstream
 *      listing-promo-social-publish cron drafts the social_posts rows.
 *   7. Emit VIDEO_GENERATION_COMPLETED.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { put } from "@vercel/blob"
import { createServiceClient } from "@/lib/supabase/service"
import { concatIntroOutro } from "@/lib/video/composite-attribution"
import { KernelEvent } from "@/lib/kernel/events"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface ProjectRow {
  id:              string
  brokerage_id:    string
  agent_id:        string
  listing_id:      string | null
  video_url:       string | null
  video_metadata:  Record<string, unknown> | null
}

export async function GET(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  const querySecret  = new URL(req.url).searchParams.get("secret")
  const expected     = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (headerSecret !== expected && querySecret !== expected) return unauthorized()

  const svc = createServiceClient()

  // Pull every listing_promo project that's hybrid_pending + has a Remotion mp4 ready.
  const { data: projects, error } = await svc.from("ai_video_projects")
    .select("id, brokerage_id, agent_id, listing_id, video_url, video_metadata")
    .eq("video_type", "listing_promo")
    .eq("status", "generating")
    .not("video_url", "is", null)
    .order("created_at", { ascending: true })
    .limit(20)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ id: string; outcome: string; reason?: string }> = []

  for (const p of (projects ?? []) as unknown as ProjectRow[]) {
    const meta = (p.video_metadata ?? {}) as Record<string, unknown>
    if (meta.hybrid_pending !== true) continue
    const introJobId = meta.hybrid_intro_job_id as string | null | undefined
    const outroJobId = meta.hybrid_outro_job_id as string | null | undefined
    if (!introJobId || !outroJobId) {
      results.push({ id: p.id, outcome: "skipped", reason: "missing hybrid_intro_job_id or hybrid_outro_job_id" })
      continue
    }

    // Resolve the D-ID render output URLs. poll-did-videos writes to
    // ai_video_projects.provider_job_id + video_url on completion. Look both
    // up by provider_job_id matching the talk_id we stored.
    const introProj = await findProjectByProviderJob(svc, introJobId)
    const outroProj = await findProjectByProviderJob(svc, outroJobId)
    if (!introProj?.video_url || !outroProj?.video_url) {
      // One of the D-ID renders hasn't landed yet — wait the next tick.
      continue
    }

    try {
      // Download the Remotion middle MP4 to a buffer (ffmpeg needs a local file).
      const mainResp = await fetch(p.video_url!)
      if (!mainResp.ok) throw new Error(`fetch middle failed: ${mainResp.status}`)
      const mainBuf = Buffer.from(await mainResp.arrayBuffer())

      // Stitch via the canonical ffmpeg helper.
      const stitch = await concatIntroOutro({
        mainVideoBuffer: mainBuf,
        introVideoUrl:   introProj.video_url,
        outroVideoUrl:   outroProj.video_url,
      })
      if (!stitch.overlayApplied) {
        // ffmpeg missing or no bookends — keep the Remotion middle as final.
        await svc.from("ai_video_projects").update({
          status: "completed",
          video_metadata: { ...meta, hybrid_pending: false, hybrid_composited_at: new Date().toISOString(), hybrid_skip_reason: stitch.skippedReason ?? "no_overlay" },
        }).eq("id", p.id)
        results.push({ id: p.id, outcome: "completed_no_hybrid", reason: stitch.skippedReason })
        continue
      }

      // Upload stitched mp4.
      const blob = await put(
        `listing-promo/hybrid/${p.id}.mp4`,
        stitch.outputBuffer,
        { access: "public", contentType: "video/mp4" },
      )

      await svc.from("ai_video_projects").update({
        status:    "completed",
        video_url: blob.url,
        video_metadata: { ...meta, hybrid_pending: false, hybrid_composited_at: new Date().toISOString(), hybrid_url: blob.url },
      }).eq("id", p.id)

      // Move the listing_promo_videos ledger to 'rendering' so the
      // social-publish cron picks it up.
      if (p.listing_id) {
        await svc.from("listing_promo_videos")
          .update({ status: "rendering" })
          .eq("video_project_id", p.id)

        // Wave 28 — fire the per-persona post-pass against the final
        // composite. Listing-promo's audience is the brokerage's entire
        // subscriber base (not asset-scoped like newsletter), so we let
        // the shared module resolve the top personas. Each persona gets
        // a thumbnail + ffmpeg overlay on the composite for inbox /
        // social-card preview personalization. Fire-and-forget — the
        // post-pass logs failures per-persona without blocking the
        // social-publish handoff.
        try {
          const { runPersonaVariantPostPass } = await import("@/lib/video/persona-variant-post-pass")
          // Pull listing + brokerage display data for the still composition.
          const { data: listingRow } = await svc.from("listings")
            .select("address, city, state")
            .eq("id", p.listing_id)
            .maybeSingle()
          const lr = listingRow as { address: string | null; city: string | null; state: string | null } | null
          const { data: brokerage } = await svc.from("brokerages")
            .select("name, logo_url, brand_primary_color, brand_accent_color")
            .eq("id", p.brokerage_id)
            .maybeSingle()
          const br = brokerage as { name: string | null; logo_url: string | null; brand_primary_color: string | null; brand_accent_color: string | null } | null
          const subject = [lr?.address, [lr?.city, lr?.state].filter(Boolean).join(", ")]
            .filter(Boolean).join(" — ") || "New listing"
          void runPersonaVariantPostPass({
            assetType:    "listing_promo",
            assetId:      p.listing_id,
            brokerageId:  p.brokerage_id,
            agentUserId:  p.agent_id,
            brand: {
              primaryColor:  br?.brand_primary_color ?? "#0F172A",
              accentColor:   br?.brand_accent_color  ?? "#F59E0B",
              logoUrl:       br?.logo_url            ?? undefined,
              brokerageName: br?.name                ?? "Your Brokerage",
            },
            mainVideoUrl:    blob.url,
            subject,
            // bundleLoc omitted — composite cron has no Remotion bundle.
            // The post-pass module skips the still thumbnail and only runs
            // the ffmpeg drawtext overlay. Each persona gets composite_video_url
            // set + thumbnail_url=null; the social-publish loop picks the
            // composite per recipient persona.
            hookContextHint: "a new listing that matches the recipient's search criteria",
          })
        } catch (postPassErr) {
          console.error("[listing-promo-hybrid-composite] persona post-pass dispatch failed:", (postPassErr as Error).message)
        }
      }

      await svc.from("lifecycle_events").insert({
        brokerage_id:  p.brokerage_id,
        actor_user_id: p.agent_id,
        event_type:    KernelEvent.VIDEO_GENERATION_COMPLETED,
        metadata: {
          ai_video_project_id: p.id,
          hybrid_composited:   true,
        },
        entity_id:   p.id,
        entity_type: "ai_video_project",
        source:      "system",
        processed:   false,
      })

      results.push({ id: p.id, outcome: "completed" })
    } catch (e) {
      const msg = (e as Error).message
      await svc.from("ai_video_projects").update({
        status:         "error",
        error_message:  msg.slice(0, 800),
        video_metadata: { ...meta, hybrid_pending: false, hybrid_error: msg.slice(0, 400) },
      }).eq("id", p.id)
      results.push({ id: p.id, outcome: "failed", reason: msg })
    }
  }

  return NextResponse.json({
    ran_at:    new Date().toISOString(),
    processed: results.length,
    results,
  })
}

async function findProjectByProviderJob(
  svc: ReturnType<typeof createServiceClient>,
  jobId: string,
): Promise<{ video_url: string | null } | null> {
  const { data } = await svc.from("ai_video_projects")
    .select("video_url")
    .eq("provider_job_id", jobId)
    .maybeSingle()
  return data as { video_url: string | null } | null
}
