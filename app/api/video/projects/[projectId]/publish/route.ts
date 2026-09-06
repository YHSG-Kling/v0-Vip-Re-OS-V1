import { NextRequest, NextResponse } from "next/server"
import {
  distributeVideoProjectAction,
  repurposeVideoOutputAction,
} from "@/app/actions/video"
import { videoActionResponse } from "../video-action-http"
import type { DistributeVideoProjectInput, RepurposeVideoOutputInput } from "@/lib/kernel/video"

/**
 * POST /api/video/projects/:projectId/publish — distribute or repurpose.
 *
 * HTTP door onto app/actions/video.ts, which owns the tenant check for both
 * branches. These calls touch external accounts and billable AI, so the gate
 * matters; it exists once, in the action. Status codes unchanged (see
 * ../video-action-http.ts) — including the 400 for an unrecognised action.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const body = await request.json().catch(() => ({} as Record<string, unknown>))

  if (body.action === "distribute") {
    const input: DistributeVideoProjectInput = {
      projectId,
      channels: body.channels,
      title: body.title,
      description: body.description,
      tags: body.tags,
    }
    return videoActionResponse(await distributeVideoProjectAction(input), "distribution")
  }

  if (body.action === "repurpose") {
    const input: RepurposeVideoOutputInput = {
      projectId,
      formats: body.formats,
    }
    return videoActionResponse(await repurposeVideoOutputAction(input), "artifacts")
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 })
}
