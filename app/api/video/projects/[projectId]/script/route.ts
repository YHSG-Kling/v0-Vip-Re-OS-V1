import { NextRequest } from "next/server"
import { generateVideoScriptAction } from "@/app/actions/video"
import { videoActionResponse } from "../video-action-http"
import type { GenerateVideoScriptInput } from "@/lib/kernel/video"

/**
 * POST /api/video/projects/:projectId/script — generate the AI script.
 *
 * The auth + project-ownership check that used to live here now lives once, in
 * app/actions/video.ts:generateVideoScriptAction, which the Video Studio calls
 * directly. This route is the HTTP door onto that same implementation; its
 * status codes are unchanged (see ../video-action-http.ts).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const body = await request.json().catch(() => ({} as Record<string, unknown>))

  const input: GenerateVideoScriptInput = {
    projectId,
    contentStrategy: body.contentStrategy,
    tone: body.tone,
    duration: body.duration,
  }

  return videoActionResponse(await generateVideoScriptAction(input), "script")
}
