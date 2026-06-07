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
import { put } from "@vercel/blob"
import { createServiceClient } from "@/lib/supabase/service"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { getComposition, recordRenderCompleted, type CompositionTier } from "@/lib/remotion/registry"
import { finalizeCoordinatedRender } from "@/lib/remotion/render-coordinator"
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

    // 3. Bundle once (module-cached) + resolve Chromium.
    const entryPoint = path.join(process.cwd(), "remotion", "index.ts")
    const bundleLocation = await getBundle(entryPoint)
    const inputProps = resolveInputProps(row.input_props)
    const executablePath = await resolveChromium()
    const isStill = isStillComposition(composition.duration_frames)

    if (isStill) {
      // 4a. STILL — renderStill → PNG → blob. No coordinator (stills
      //     have no audio to mix or bookends to concat).
      const bytes = await renderStillToBuffer(bundleLocation, row.composition_id, inputProps, executablePath, row.id)
      const uploaded = await put(
        `compositions/${row.brokerage_id}/${row.composition_id}/${row.id}.png`,
        bytes,
        { access: "public", contentType: "image/png" },
      )
      await recordRenderCompleted({
        renderId: row.id, compositionId: row.composition_id,
        status: "succeeded", outputUrl: uploaded.url, thumbnailUrl: uploaded.url,
      })
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
    const result = await finalizeCoordinatedRender(intent, row.id, buffer)
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
        const up = await put(
          `compositions/${row.brokerage_id}/${row.composition_id}/${row.id}-thumb.png`,
          thumbBytes,
          { access: "public", contentType: "image/png" },
        )
        thumbnailUrl = up.url
        await svc.from("remotion_composition_renders")
          .update({ thumbnail_url: thumbnailUrl })
          .eq("id", row.id)
      } catch (e) {
        console.warn("[render-composition] thumbnail pass failed; video kept:", (e as Error).message)
      }
    }

    return NextResponse.json({
      ok: true, render_id: row.id, kind: "video", output_url: result.outputUrl,
      thumbnail_url: thumbnailUrl,
      used_intro_asset_id: result.introAssetId,
      used_outro_asset_id: result.outroAssetId,
      used_music_asset_id: result.musicAssetId,
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
  const { data } = await svc.from("brokerages")
    .select("subscription_tier")
    .eq("id", brokerageId)
    .maybeSingle()
  const t = (data as { subscription_tier: string | null } | null)?.subscription_tier
  return (t && (VALID_TIERS as string[]).includes(t)) ? (t as CompositionTier) : "solo_agent"
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
