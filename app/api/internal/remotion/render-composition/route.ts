/**
 * app/api/internal/remotion/render-composition/route.ts
 *
 * Wave 39 m172 — the GENERIC Remotion render endpoint. Renders ANY
 * composition registered in remotion_compositions, keyed only by a
 * queued remotion_composition_renders row. This is the "last mile" that
 * makes the Asset Manager's start_render / restart_failed_render actions
 * (m171) actually produce a video — previously only JustListedReel
 * (render-just-listed) and the newsletter video had render paths, so a
 * queued MarketUpdateReel / JustSoldReelSquare row sat forever.
 *
 * Unlike render-just-listed (which is bespoke: loads listing facts,
 * drafts a script, runs compliance, synthesizes ElevenLabs TTS, submits
 * hybrid D-ID), this endpoint is intentionally GENERIC: the caller (Asset
 * Manager / W40 ad creator) supplies the composition props up front and
 * persists them on the render row (m172 input_props). We:
 *
 *   1. Claim the queued row atomically (queued → rendering).
 *   2. Resolve the brokerage's tier + the composition registry row.
 *   3. Bundle Remotion, selectComposition({ id, inputProps }).
 *   4. STILL composition (duration_frames<=1: thumbnail / postcard /
 *      lead-magnet / newsletter-thumb)  → renderStill → PNG → blob.
 *      MOVING composition → renderMedia → MP4 buffer → the existing
 *      render-coordinator finalize (bookends + music + audit + upload).
 *   5. On any failure mark the row 'failed' so the Asset Manager
 *      surfaces it next cycle (and can propose restart_failed_render).
 *
 * Auth: CRON_SECRET — invoked by the composition-render-queue cron,
 * never by a user directly.
 *
 * Chromium: same @sparticuz/chromium-min pattern as render-just-listed.
 * maxDuration=300 for the bundle + render headroom.
 */
import "server-only"
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolvePlanTier } from "@/lib/billing/plan-tier"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { getComposition, recordRenderCompleted, canAccessComposition, type CompositionTier } from "@/lib/remotion/registry"
import { finalizeCoordinatedRender } from "@/lib/remotion/render-coordinator"
import { NO_FINISH } from "@/lib/remotion/composition-cache"
import {
  predictFinishInputs, probeRenderCache, serveFromCache, stampRenderKeys,
} from "@/lib/remotion/render-cache"
import {
  isStillComposition,
  buildRenderIntent,
  resolveInputProps,
  needsThumbnailPass,
  resolveThumbnailProps,
  type QueuedRenderRow,
} from "@/lib/remotion/render-decision"
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface ReqBody {
  render_id: string
}

const VALID_TIERS: CompositionTier[] = ["solo_agent", "team", "brokerage", "multi_location", "platform"]

export async function POST(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  if (process.env.CRON_SECRET && headerSecret !== process.env.CRON_SECRET) {
    return unauthorized()
  }

  let body: ReqBody
  try { body = (await req.json()) as ReqBody } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }) }
  if (!body.render_id) return NextResponse.json({ error: "render_id required" }, { status: 400 })

  const svc = createServiceClient()

  // 1. Claim the row atomically (queued → rendering) so a concurrent
  //    cron tick can't double-render the same row.
  const claim = await svc.from("remotion_composition_renders")
    .update({ render_status: "rendering" })
    .eq("id", body.render_id)
    .eq("render_status", "queued")
    .select("id, brokerage_id, composition_id, agent_user_id, entity_type, entity_id, scope_type, scope_id, input_props")
    .maybeSingle()
  const row = claim.data as (QueuedRenderRow & { id: string }) | null
  if (!row) {
    return NextResponse.json({ skipped: "render row not in queued state or not found" }, { status: 200 })
  }

  try {
    // 2. Resolve the composition registry row + the brokerage tier.
    const composition = await getComposition(row.composition_id)
    if (!composition) throw new Error("composition_not_registered")
    if (!composition.is_active) {
      await recordRenderCompleted({
        renderId: row.id, compositionId: row.composition_id,
        status: "cancelled", errorMessage: "composition_inactive",
      })
      return NextResponse.json({ skipped: "composition_inactive", render_id: row.id }, { status: 200 })
    }
    const callerTier = await resolveBrokerageTier(svc, row.brokerage_id)

    // 2b. TIER GATE — enforced here because this is the only place it can
    //     refuse. canAccessComposition existed but was called ONLY from
    //     beginCoordinatedRender, which had zero callers, so tier_access was
    //     collected and never honoured: a solo_agent brokerage could queue
    //     ProductPromoReel (tier_access = {platform}, the platform's own
    //     product marketing) and it would render. Cancelled rather than failed
    //     — nothing went wrong, the render was simply not theirs to have.
    if (!canAccessComposition(callerTier, composition)) {
      await recordRenderCompleted({
        renderId: row.id, compositionId: row.composition_id,
        status: "cancelled",
        errorMessage: `composition_not_reachable_at_tier:${callerTier}`,
      })
      return NextResponse.json({
        skipped: "composition_not_reachable_at_tier",
        render_id: row.id, caller_tier: callerTier, tier_access: composition.tier_access,
      }, { status: 200 })
    }

    const inputProps = resolveInputProps(row.input_props)
    const isStill = isStillComposition(composition.duration_frames)

    // 2c. CACHE PROBE — before the bundle, before Chromium, before any spend.
    //     Identity is (composition + deploy code revision + geometry + canonical
    //     props) for the frames, plus the finish inputs the coordinator will mux
    //     over them. A still has no finish pass, so its finish is the empty one.
    //     We look up on the PREDICTED finish and stamp on the ACTUAL one, so a
    //     misprediction costs a wasted render, never a wrong artifact.
    const cacheScope = {
      brokerageId: row.brokerage_id,
      scopeType: (row.scope_type ?? "brokerage") as "agent" | "team" | "brokerage",
      scopeId: row.scope_id ?? row.brokerage_id,
    }
    const predictedFinish = isStill
      ? NO_FINISH
      : await predictFinishInputs(svc, cacheScope, composition, {
          musicMood: ((row.input_props as { music_mood?: unknown } | null)?.music_mood as string | undefined) ?? null,
          voiceoverUrl: ((row.input_props as { voiceover_url?: unknown } | null)?.voiceover_url as string | undefined) ?? null,
        })
    const probe = await probeRenderCache(svc, {
      brokerageId: row.brokerage_id,
      composition,
      props: row.input_props,
      finish: predictedFinish,
    })

    if (probe.hit) {
      const served = await serveFromCache(svc, row.id, probe)
      if (served.ok) {
        // Downstream coordination still runs: the reel is genuinely ready, it
        // just did not need re-rendering. The marketing_assets capture is the
        // ONE thing skipped — the origin render already filed this exact file,
        // and the capture dedupes on render id, not on url.
        await runPostRenderCoordination(svc, row, served.outputUrl!, probe.hit.thumbnailUrl)
        return NextResponse.json({
          ok: true, render_id: row.id, kind: isStill ? "still" : "video",
          output_url: served.outputUrl, thumbnail_url: probe.hit.thumbnailUrl,
          cache_hit: true, served_from_render_id: probe.hit.renderId,
          artifact_key: probe.artifactKey,
        })
      }
      // The serve write was REFUSED. Fall through and render: leaving the row
      // 'rendering' while reporting a hit is exactly the silent failure this
      // build exists to remove.
      console.warn("[render-composition] cache serve refused; rendering instead:", served.reason)
    }

    // Identity stamped before the heavy work so a concurrent sibling can see
    // what is already in flight for this key.
    await stampRenderKeys(svc, row.id, { frameKey: probe.frameKey, artifactKey: probe.artifactKey })

    // 3. Bundle once (module-cached) + resolve Chromium.
    const entryPoint = path.join(process.cwd(), "remotion", "index.ts")
    const bundleLocation = await getBundle(entryPoint)
    const executablePath = await resolveChromium()

    if (isStill) {
      // 4a. STILL — renderStill → PNG → blob. No coordinator (stills
      //     have no audio to mix or bookends to concat).
      const bytes = await renderStillToBuffer(bundleLocation, row.composition_id, inputProps, executablePath, row.id)
      const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
      const uploaded = { url: await hostRenderedMedia(svc, `compositions/${row.brokerage_id}/${row.composition_id}/${row.id}.png`, bytes, "image/png") }
      await recordRenderCompleted({
        renderId: row.id, compositionId: row.composition_id,
        status: "succeeded", outputUrl: uploaded.url, thumbnailUrl: uploaded.url,
      })
      // Stills join the reusable marketing_assets library too (flyers,
      // hangers, carousel slides) — the ads media resolver and the asset
      // library must see every finished deliverable, not just videos.
      try {
        const { captureRenderAsMarketingAsset } = await import("@/lib/marketing/capture-render-asset")
        await captureRenderAsMarketingAsset(row.id, svc)
      } catch { /* capture is best-effort — the render itself succeeded */ }
      return NextResponse.json({ ok: true, render_id: row.id, kind: "still", output_url: uploaded.url })
    }

    // 4b. MOVING — renderMedia → MP4 buffer → coordinator finalize
    //     (bookends + music + audit + blob upload).
    const selected = await selectComposition({
      serveUrl: bundleLocation,
      id:       row.composition_id,
      inputProps: inputProps ?? {},
    })
    const outPath = path.join(tmpdir(), `composition-${row.id}.mp4`)
    await renderMedia({
      composition: selected,
      serveUrl:    bundleLocation,
      codec:       "h264",
      outputLocation: outPath,
      inputProps:  inputProps ?? {},
      concurrency: 1,
      chromiumOptions: { headless: true, gl: "swangle" },
      ...(executablePath ? { browserExecutable: executablePath } : {}),
    })
    const buffer = await fs.readFile(outPath)
    await fs.unlink(outPath).catch(() => {})

    const intent = buildRenderIntent(row, callerTier)
    // The frame key travels into finalize so the artifact key persisted is
    // computed from the finish inputs that ACTUALLY landed (a bookend whose
    // ffmpeg concat failed did not change the video and must not change its
    // key), overwriting the prediction stamped above.
    const result = await finalizeCoordinatedRender(intent, row.id, buffer, probe.frameKey)
    if (!result.ok) {
      // finalize already marked the row failed.
      return NextResponse.json({ ok: false, render_id: row.id, error: result.error }, { status: 500 })
    }

    // 4c. Companion thumbnail — every moving composition declares a
    //     thumbnail_composition_id (VideoCoverThumb / NewsletterDigestThumb)
    //     so the video is share-card + og:image + AI-search discoverable
    //     (ChatGPT browse / Perplexity / Google AI Overviews read the card
    //     since they don't index video). Best-effort: the video already
    //     succeeded, so a thumbnail failure must NOT fail the render.
    let thumbnailUrl: string | null = null
    if (needsThumbnailPass(composition)) {
      try {
        const thumbProps = resolveThumbnailProps(row.input_props)
        const thumbBytes = await renderStillToBuffer(
          bundleLocation, composition.thumbnail_composition_id!, thumbProps, executablePath, `${row.id}-thumb`,
        )
        const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
        thumbnailUrl = await hostRenderedMedia(svc, `compositions/${row.brokerage_id}/${row.composition_id}/${row.id}-thumb.png`, thumbBytes, "image/png")
        await svc.from("remotion_composition_renders")
          .update({ thumbnail_url: thumbnailUrl })
          .eq("id", row.id)
      } catch (e) {
        console.warn("[render-composition] thumbnail pass failed; video kept:", (e as Error).message)
      }
    }

    await runPostRenderCoordination(svc, row, result.outputUrl ?? null, thumbnailUrl)

    return NextResponse.json({
      ok: true, render_id: row.id, kind: "video", output_url: result.outputUrl,
      thumbnail_url: thumbnailUrl,
      used_intro_asset_id: result.introAssetId,
      used_outro_asset_id: result.outroAssetId,
      used_music_asset_id: result.musicAssetId,
      cache_hit: false,
      frame_key: probe.frameKey,
      artifact_key: result.artifactKey,
    })
  } catch (err) {
    const msg = (err as Error).message
    await recordRenderCompleted({
      renderId: row.id, compositionId: row.composition_id,
      status: "failed", errorMessage: msg.slice(0, 800),
    })
    return NextResponse.json({ ok: false, render_id: row.id, error: msg }, { status: 500 })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Director reel completion → hand the finished COMPOSITE to the Campaign
 * Orchestrator.
 *
 * When this render is the final composite for a Director-commissioned reel
 * (entity_type='video_project'), flip the linked ai_video_projects to completed
 * with the BRANDED composite URL, then publish the coordination signal so the
 * Asset Manager → Campaign Orchestrator 1:1 delivery (contact_outreach_ready)
 * fires on the branded cut. This closes the autonomous loop that previously
 * died at staging (commissionVideo staged but nothing rendered/announced it).
 *
 * Extracted so a CACHE HIT runs the identical loop: the reel is genuinely ready
 * whether or not this particular request had to render it, and a cached reel
 * that never reached the Campaign Orchestrator would be a delivery the client
 * silently never got — a caching "win" that loses the actual outcome.
 */
async function runPostRenderCoordination(
  svc: ReturnType<typeof createServiceClient>,
  row: { id: string; entity_type: string | null; entity_id: string | null },
  outputUrl: string | null,
  thumbnailUrl: string | null,
): Promise<void> {
  if (row.entity_type !== "video_project" || !row.entity_id) return
  try {
    await svc.from("ai_video_projects")
      .update({
        status: "completed",
        video_url: outputUrl,
        thumbnail_url: thumbnailUrl ?? undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.entity_id)
    const { publishVideoCoordinationSignals } = await import("@/lib/kernel/video-coordination")
    await publishVideoCoordinationSignals(row.entity_id, svc)
  } catch (e) {
    console.error("[render-composition] director-reel coordination publish failed:", (e as Error).message)
  }
}

/** Select a still composition by id + render it to a PNG Buffer. Shared by
 *  the still branch (the composition itself) and the moving branch's
 *  companion-thumbnail pass (the registry thumbnail_composition_id). */
async function renderStillToBuffer(
  bundleLocation: string,
  compositionId:  string,
  props:          Record<string, unknown> | undefined,
  executablePath: string | undefined,
  tag:            string,
): Promise<Buffer> {
  const selected = await selectComposition({
    serveUrl: bundleLocation,
    id:       compositionId,
    inputProps: props ?? {},
  })
  const outPath = path.join(tmpdir(), `composition-${tag}.png`)
  await renderStill({
    composition: selected,
    serveUrl:    bundleLocation,
    output:      outPath,
    inputProps:  props ?? {},
    chromiumOptions: { headless: true, gl: "swangle" },
    ...(executablePath ? { browserExecutable: executablePath } : {}),
  })
  const bytes = await fs.readFile(outPath)
  await fs.unlink(outPath).catch(() => {})
  return bytes
}

async function resolveBrokerageTier(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
): Promise<CompositionTier> {
  // plan_tier — the column with writers. This read brokerages.subscription_tier,
  // which nothing maintained, so the tier gating a RENDER came from a stale value
  // (m306 dropped it). resolvePlanTier falls to the tightest tier when absent.
  const t = await resolvePlanTier(svc, brokerageId)
  return (VALID_TIERS as string[]).includes(t) ? (t as CompositionTier) : "solo_agent"
}

async function resolveChromium(): Promise<string | undefined> {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chromium = (await import("@sparticuz/chromium-min")).default
    return await chromium.executablePath(
      process.env.CHROMIUM_PACK_URL || "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.tar",
    )
  }
  return undefined
}
