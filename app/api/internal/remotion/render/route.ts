/**
 * app/api/internal/remotion/render/route.ts
 *
 * Wave 39 — generic Remotion render endpoint. Renders ANY composition
 * registered in remotion_compositions (m168), then runs the output
 * through the coordinator's bookend + music + upload + audit flow.
 * Replaces the need for one dedicated endpoint per composition — the
 * two existing per-composition endpoints (render-just-listed +
 * render-newsletter-video) stay for backwards compatibility with the
 * crons that call them by name; new render paths use this endpoint.
 *
 * Contract:
 *   POST { compositionId, renderId, inputProps, applyBookends?,
 *          applyMusic? }
 *   The caller has already called beginCoordinatedRender (via
 *   lib/remotion/render-coordinator or via the Asset Manager's
 *   start_render action handler) which claimed the renderId. This
 *   endpoint is the "actually render the pixels" step; it hands the
 *   buffer to finalizeCoordinatedRender to do the last-mile
 *   stitching + upload.
 *
 * Auth: CRON_SECRET dual-scheme. This is an internal endpoint hit
 * server-to-server from the render coordinator + the Asset Manager
 * executor. Never user-facing.
 *
 * Runtime: nodejs (Chromium via @sparticuz/chromium-min).
 * maxDuration: 300s covers the ~60-90s bundle + Remotion render for
 * the longest formats (20s @ 30fps ≈ 600 frames).
 *
 * Cost note: the Remotion render step itself is ~$0.005 per second
 * of output (Vercel Lambda compute). Bookend concat + music mix run
 * inside finalizeCoordinatedRender via ffmpeg-static — negligible
 * additional cost. D-ID + ElevenLabs costs are UPSTREAM of this
 * endpoint (the caller has already synthesized the voiceover + queued
 * the D-ID job if the composition requires them); this endpoint only
 * consumes their URLs via inputProps.
 */
import "server-only"
import { NextResponse, type NextRequest } from "next/server"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { selectComposition, renderMedia } from "@remotion/renderer"
import { finalizeCoordinatedRender } from "@/lib/remotion/render-coordinator"
import { getComposition, recordRenderCompleted } from "@/lib/remotion/registry"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface RenderRequestBody {
  compositionId:   string
  renderId:        string
  /** Props passed to the composition. Shape depends on the composition. */
  inputProps:      Record<string, unknown>
  /** Optional overrides for the coordinator's bookend / music step. */
  applyBookends?:  boolean
  applyMusic?:     boolean
  /** Scope context for stock-asset lookup. */
  brokerageId:     string
  callerTier:      "solo_agent" | "team" | "brokerage" | "multi_location" | "platform"
  scopeType:       "agent" | "team" | "brokerage"
  scopeId:         string
  agentUserId?:    string | null
  entityType?:     string | null
  entityId?:       string | null
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function POST(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 })
  if (auth !== expected) return unauthorized()

  const body = (await req.json()) as RenderRequestBody
  if (!body.compositionId || !body.renderId || !body.brokerageId) {
    return NextResponse.json({ error: "compositionId + renderId + brokerageId required" }, { status: 400 })
  }

  const composition = await getComposition(body.compositionId)
  if (!composition) {
    return NextResponse.json({ error: "composition_not_registered" }, { status: 404 })
  }

  const entryPoint = path.join(process.cwd(), "remotion", "index.ts")

  try {
    const bundleLocation = await getBundle(entryPoint)

    const selected = await selectComposition({
      serveUrl:   bundleLocation,
      id:         body.compositionId,
      inputProps: body.inputProps,
    })

    // Chromium resolver — same pattern as render-just-listed. Locally
    // Remotion uses its bundled Chromium; on Vercel we point at the
    // Sparticuz binary.
    let executablePath: string | undefined
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      const chromium = (await import("@sparticuz/chromium-min")).default
      executablePath = await chromium.executablePath(
        process.env.CHROMIUM_PACK_URL
          || "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.tar",
      )
    }

    const outPath = path.join(tmpdir(), `remotion-${body.compositionId}-${body.renderId}.mp4`)

    // Static compositions (durationInFrames=1) render as a still image,
    // but @remotion/renderer's renderMedia handles both when we pass
    // codec='h264' — a 1-frame render emits a 1-frame mp4 that the
    // downstream renderStill-style consumers can still frame-extract
    // if needed. For OG-card thumbnails we use renderStill via a
    // separate endpoint (deferred; see thumbnail_composition_id path).
    await renderMedia({
      composition:    selected,
      serveUrl:       bundleLocation,
      codec:          "h264",
      outputLocation: outPath,
      inputProps:     body.inputProps,
      concurrency:    1,
      chromiumOptions: { headless: true, gl: "swangle" },
      ...(executablePath ? { browserExecutable: executablePath } : {}),
    })

    const buffer = await fs.readFile(outPath)
    await fs.rm(outPath).catch(() => {})

    // Hand off to the coordinator for bookend + music + upload + audit.
    const finalized = await finalizeCoordinatedRender({
      brokerageId:  body.brokerageId,
      callerTier:   body.callerTier,
      compositionId: body.compositionId,
      scopeType:    body.scopeType,
      scopeId:      body.scopeId,
      agentUserId:  body.agentUserId,
      entityType:   body.entityType,
      entityId:     body.entityId,
      applyBookends: body.applyBookends,
      applyMusic:    body.applyMusic,
    }, body.renderId, buffer)

    if (!finalized.ok) {
      return NextResponse.json({
        error: "finalize_failed",
        detail: finalized.error,
      }, { status: 500 })
    }

    return NextResponse.json({
      ok:            true,
      renderId:      body.renderId,
      compositionId: body.compositionId,
      outputUrl:     finalized.outputUrl,
      introAssetId:  finalized.introAssetId,
      outroAssetId:  finalized.outroAssetId,
      musicAssetId:  finalized.musicAssetId,
    })
  } catch (e) {
    // Mark the render row failed so the Asset Manager can propose
    // restart_failed_render on the next weekly cycle.
    try {
      await recordRenderCompleted({
        renderId:      body.renderId,
        compositionId: body.compositionId,
        status:        "failed",
        errorMessage:  (e as Error).message,
      })
    } catch { /* audit best-effort */ }
    console.error(`[remotion/render] ${body.compositionId} render failed:`, (e as Error).message)
    return NextResponse.json({
      error:  "render_failed",
      detail: (e as Error).message,
    }, { status: 500 })
  }
}

