import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { respondToReview } from "@/lib/kernel/reputation"
import { collectError } from "@/lib/errors/collect-error"

/**
 * REVIEW RESPONSE AUTO-PUBLISH — the "review" half of
 * app/actions/settings/reputation-preferences.ts::autoRespondMode.
 *
 * Wave 60 wired "auto" (aiGenerateReviewResponse publishes an AI-drafted
 * review response immediately). "review" was a hidden wire: the setting was
 * saved, read back for display, and never consulted for anything downstream
 * — an agent who chose "draft it, but let me approve for N hours" got the
 * exact same permanent-draft behavior as "off".
 *
 * aiGenerateReviewResponse (app/actions/ai-review-automation.ts) now stamps
 * agent_reviews.auto_publish_at (m625, WRITTEN NOT APPLIED — the integrator
 * applies it) at draft time when the mode is "review": now() +
 * reputation-preferences.autoRespondApprovalHours. This sweep is the clock:
 * every 30 minutes it finds drafts whose window has elapsed and publishes
 * them through the SAME tenant-checked lib/kernel/reputation.ts::respondToReview
 * command the manual Publish button and "auto" mode use — never a raw
 * agent_reviews UPDATE, so ownership + brokerage are re-verified here exactly
 * as they are for a human click.
 *
 * THE REJECT PATH IS respondToReview ITSELF: editing a draft (Save, without
 * Publish) or manually publishing it both go through respondToReview, which
 * clears auto_publish_at on every response it writes. So an agent who touches
 * a draft before this sweep runs has already taken it out of this query's
 * WHERE clause — there is no separate "reject" button or column; touching the
 * draft IS the reject.
 *
 * Degrades to a no-op tick, not a cron failure, until m625 is applied: the
 * SELECT itself names auto_publish_at, which PGRST204-refuses ENTIRELY on a
 * schema that does not have the column yet (§3) — caught and reported as
 * zero-due rather than thrown.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

const BATCH_LIMIT = 100

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "review-response-auto-publish",
    cron_path: "/app/api/cron/review-response-auto-publish/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const supabase = createServiceClient()
  let published = 0
  let failed = 0
  const errors: string[] = []

  try {
    const nowIso = new Date().toISOString()

    const { data: due, error: readError } = await supabase
      .from("agent_reviews")
      .select("id, agent_id, brokerage_id, response_text, auto_publish_at")
      .eq("is_published", false)
      .not("auto_publish_at", "is", null)
      .lte("auto_publish_at", nowIso)
      .not("response_text", "is", null)
      .limit(BATCH_LIMIT)

    if (readError) {
      // m625 not applied yet on this environment — auto_publish_at is not a
      // live column, so the whole SELECT is refused (PGRST204/42703), not
      // partially answered. That is "nothing is due", not a cron failure.
      if (/PGRST204|does not exist|42703|auto_publish_at/i.test(readError.message)) {
        await recordCronSuccessAction({
          context_id: contextId,
          records_processed: 0,
          output_count: 0,
          metadata: { published: 0, failed: 0, note: "auto_publish_at not live yet (m625 unapplied)" },
        })
        return NextResponse.json({ success: true, published: 0, failed: 0, note: "m625 not applied yet" })
      }
      throw new Error(readError.message)
    }

    for (const row of (due ?? []) as Array<{
      id: string; agent_id: string | null; brokerage_id: string | null
      response_text: string | null
    }>) {
      if (!row.agent_id || !row.brokerage_id || !row.response_text) {
        failed++
        errors.push(`${row.id}: missing agent_id/brokerage_id/response_text`)
        continue
      }
      // The SAME tenant-checked kernel command a human Publish click runs —
      // ownership (agent_id + brokerage_id) is re-verified inside respondToReview,
      // not assumed from this row. publishNow: true both raises is_published and
      // clears auto_publish_at (respondToReview clears it on every response).
      const result = await respondToReview({
        reviewId:     row.id,
        agentId:      row.agent_id,
        brokerageId:  row.brokerage_id,
        responseText: row.response_text,
        publishNow:   true,
      })
      if (result.success) {
        published++
      } else {
        failed++
        errors.push(`${row.id}: ${result.error ?? "unknown error"}`)
        await collectError({
          workflowName: "review_response_auto_publish",
          errorMessage: `auto-publish refused for agent_reviews ${row.id}: ${result.error ?? "unknown error"}`,
          severity:     "low",
          brokerageId:  row.brokerage_id,
          context:      { reviewId: row.id, agentId: row.agent_id },
        })
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: published + failed,
      output_count: published,
      metadata: { published, failed, errors: errors.slice(0, 20) },
    })
    return NextResponse.json({ success: true, published, failed })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[ReviewResponseAutoPublish] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
