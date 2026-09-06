import { NextRequest } from "next/server"
import {
  submitVideoGenerationJobAction,
  loadVideoGenerationStateAction,
} from "@/app/actions/video"
import { videoActionResponse } from "../video-action-http"
import type { SubmitVideoGenerationJobInput } from "@/lib/kernel/video"

/**
 * POST /api/video/projects/:projectId/generate — submit the render job.
 * GET  /api/video/projects/:projectId/generate — read the generation state.
 *
 * The local `authorize()` gate that used to live here is gone, not weakened:
 * the same check now runs once inside app/actions/video.ts, which is what the
 * Video Studio calls directly and what these handlers delegate to. Status codes
 * are unchanged (see ../video-action-http.ts).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const body = await request.json().catch(() => ({} as Record<string, unknown>))

  const input: SubmitVideoGenerationJobInput = {
    projectId,
    scriptText: body.scriptText,
    voiceProfileId: body.voiceProfileId,
    avatarStyle: body.avatarStyle,
    avatarId: body.avatarId,
    estimatedDurationSeconds: body.estimatedDurationSeconds,
  }

  return videoActionResponse(await submitVideoGenerationJobAction(input), "job")
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  return videoActionResponse(await loadVideoGenerationStateAction({ projectId }), "state")
}
