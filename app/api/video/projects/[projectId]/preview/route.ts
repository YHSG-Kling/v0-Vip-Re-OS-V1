import { NextRequest } from "next/server"
import { previewVideoProjectAction } from "@/app/actions/video"
import { videoActionResponse } from "../video-action-http"

/**
 * DOOR (census 6d, unresolved by design): second HTTP door onto
 * app/actions/video.ts:previewVideoProjectAction. AUTH MODEL: Supabase SESSION,
 * checked once inside the action — no non-session credential, so an external
 * caller can be neither proven nor disproved (§1).
 *
 * GET /api/video/projects/:projectId/preview — the rendered stream url.
 *
 * HTTP door onto app/actions/video.ts:previewVideoProjectAction, which owns the
 * tenant check. Status codes unchanged (see ../video-action-http.ts).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  return videoActionResponse(await previewVideoProjectAction({ projectId }), "preview")
}
