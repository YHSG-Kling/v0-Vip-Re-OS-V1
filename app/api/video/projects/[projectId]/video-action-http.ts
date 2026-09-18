import { NextResponse } from "next/server"
import type { VideoActionDenialCode, VideoActionResult } from "@/app/actions/video"

/**
 * THE SECOND DOOR onto the video generation lane.
 *
 * app/actions/video.ts is the one implementation: it resolves the caller from
 * the session, checks the project belongs to the caller's brokerage, and
 * delegates to lib/kernel/video.ts. The routes under this directory parse HTTP,
 * call that implementation, and translate its verdict back into the status
 * codes they already answered with. They do NOT repeat the tenant check — one
 * copy of a security gate is the whole point.
 *
 * The status/message table below reproduces what these routes returned when
 * they carried their own requireAuth + authorize gate, so any external consumer
 * sees no change:
 *
 *   401 Unauthorized                          — no session
 *   403 Brokerage not configured for this user — session, but no brokerage
 *   403 Forbidden                              — project belongs to another tenant
 *   404 Project not found                      — no such project
 *   400 Invalid project id                     — malformed id (previously a 500)
 *   500 <kernel error message>                 — the command itself failed
 *
 * Note the deliberate asymmetry with the server-action door: the action
 * reports a cross-tenant project as "Video project not found" so a browser
 * cannot enumerate ids, while this door keeps its historical 403.
 */
const HTTP: Record<VideoActionDenialCode, { status: number; message?: string }> = {
  unauthenticated:    { status: 401, message: "Unauthorized" },
  no_brokerage:       { status: 403, message: "Brokerage not configured for this user" },
  forbidden:          { status: 403, message: "Forbidden" },
  project_not_found:  { status: 404, message: "Project not found" },
  invalid_project_id: { status: 400, message: "Invalid project id" },
  failed:             { status: 500 },
}

/**
 * Render a server-action result as the HTTP response this route has always
 * returned. `key` is the property the payload was published under
 * (`script`, `job`, `state`, `preview`, `distribution`, `artifacts`).
 */
export function videoActionResponse<T>(result: VideoActionResult<T>, key: string): NextResponse {
  if (result.success) {
    return NextResponse.json({ [key]: result.data }, { status: 200 })
  }
  const mapped = HTTP[result.code] ?? { status: 500 }
  return NextResponse.json({ error: mapped.message ?? result.error }, { status: mapped.status })
}
