import { NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runDidResultUrlRehostSweep } from "@/lib/did/result-url-rehost-sweep"

/**
 * D-ID RESULT URL REHOST SWEEP — wave 62, owner fact sheet (docs.d-id.com,
 * 2026-09-14): `/talks` and `/clips` `result_url` is a short-lived presigned
 * URL; D-ID does not promise indefinite storage. Both happy paths already
 * re-host the moment a render/avatar completes (poll-did-videos,
 * did-webhook → applyAvatarOutcome) and FAIL CLOSED rather than store the
 * vendor URL when that re-host itself fails — see lib/did/result-url-rehost-
 * sweep.ts's header for the full account. This is the SAFETY NET for what
 * those two paths do not cover: rows written before either fail-closed
 * contract existed, or a future regression in either.
 *
 * DAILY, not sub-5-minute (owner ruling, wave 62: "vercel cron usage and
 * billing should be considered … we don't want the charges outweighing the
 * build") — a slipped-through row has a multi-hour window before its D-ID
 * URL expires, so once a day catches it comfortably inside that window
 * without adding a per-minute invocation. See lib/kernel/cron-dispatch.ts.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "did-result-url-rehost-sweep",
    cron_path: "/app/api/cron/did-result-url-rehost-sweep/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const { videoProjects, avatarAssets } = await runDidResultUrlRehostSweep()
    const scanned = videoProjects.scanned + avatarAssets.scanned
    const rehosted = videoProjects.rehosted + avatarAssets.rehosted
    const failed = videoProjects.failed + avatarAssets.failed

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: scanned,
      output_count: rehosted,
      metadata: { videoProjects, avatarAssets },
    })
    return NextResponse.json({ success: true, scanned, rehosted, failed, videoProjects, avatarAssets })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[did-result-url-rehost-sweep] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
