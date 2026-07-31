/**
 * Cron: poll-did-avatars
 *
 * THE FALLBACK, NOT THE MECHANISM. Completions now arrive on the D-ID webhook
 * (/api/webhooks/did) within seconds of the job finishing. This cron stays
 * because a webhook is not a guarantee — DID_WEBHOOK_SECRET may be unset, the
 * public origin may not be reachable from D-ID, a delivery can be dropped, and
 * avatars submitted before the webhook existed carry no callback at all. It
 * runs every 3 minutes and finds whatever the webhook did not.
 *
 * It shares ONE completion implementation with the webhook —
 * lib/did/avatar-completion.ts — so the two can never drift into disagreeing
 * about what "done" means. That module also re-reads the row and refuses to act
 * on one already ready/failed, which is what makes a cron tick racing a webhook
 * delivery a no-op instead of a duplicate notification.
 *
 * What is still THIS route's own job: deciding what a failed *poll* means.
 *   · 404 → TERMINAL. D-ID has no such job; no tick will ever resolve it.
 *   · 402 / 451 / 400 → terminal via classifyDidError; retrying burns quota and
 *     hides the real answer from the agent waiting on their avatar.
 *   · 429 / 5xx → transient; leave the row alone and try next tick.
 */

import { type NextRequest, NextResponse } from "next/server"
import { classifyDidError } from "@/lib/did/contract"
import { applyAvatarOutcome } from "@/lib/did/avatar-completion"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

const DID_API_BASE = "https://api.d-id.com"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "poll-did-avatars",
    cron_path: "/app/api/cron/poll-did-avatars/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const supabase = createServiceClient()
    const didApiKey = process.env.DID_API_KEY

    if (!didApiKey) {
      await recordCronSuccessAction({
        context_id: contextId,
        records_processed: 0,
        output_count: 0,
        metadata: { skipped: "DID_API_KEY not configured" },
      })
      return NextResponse.json({ success: false, message: "DID_API_KEY not configured", processed: 0 })
    }

    const { data: pending, error: fetchError } = await supabase
      .from("agent_avatar_assets")
      .select("id, did_avatar_id")
      .in("status", ["pending", "processing"])
      .not("did_avatar_id", "is", null)
      .limit(20)

    if (fetchError) throw fetchError

    const results = { processed: 0, ready: 0, failed: 0, still_processing: 0, already_settled: 0 }
    const auth = `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`

    for (const asset of pending ?? []) {
      results.processed++

      try {
        const statusRes = await fetch(`${DID_API_BASE}/scenes/avatars/${asset.did_avatar_id}`, {
          headers: { Authorization: auth, Accept: "application/json" },
        })

        // A 404 is TERMINAL, not a blip: the job does not exist (submitted to
        // the wrong path, deleted, or created under another account). Treating
        // it the same as a transient error is what let broken avatars sit at
        // 'pending' forever with nothing to show the agent.
        if (statusRes.status === 404) {
          await supabase.from("agent_avatar_assets").update({
            status: "failed",
            error_message: "D-ID has no record of this avatar job — it was never accepted. Re-record the avatar.",
            updated_at: new Date().toISOString(),
          }).eq("id", asset.id)
          results.failed++
          continue
        }
        // Everything else goes through the ONE classifier. Not all non-404
        // failures are transient: a 402 (out of credits) or a 451 (moderation /
        // celebrity recognition) will NEVER succeed on a later tick, and
        // retrying them forever hides the real answer from the agent waiting on
        // their avatar while burning cron ticks against the provider.
        if (!statusRes.ok) {
          const body = await statusRes.json().catch(() => ({}))
          const failure = classifyDidError(statusRes.status, body)
          if (failure.retryable) continue
          await supabase.from("agent_avatar_assets").update({
            status: "failed",
            error_message: failure.userMessage,
            updated_at: new Date().toISOString(),
          }).eq("id", asset.id)
          console.error(`[poll-did-avatars] terminal for ${asset.id}: ${failure.operatorMessage}`)
          results.failed++
          continue
        }

        const data = await statusRes.json()

        // The shared applier. Everything the old inline block did — high-res
        // image preference, re-host into our bucket, profile mirror for the
        // default twin, the agent notification, and the creation_notes check
        // that catches a silently-failed voice clone — now lives in one module
        // that the webhook calls too.
        const outcome = await applyAvatarOutcome(supabase, asset.id as string, data)
        if (outcome.operatorMessage) {
          console.error(`[poll-did-avatars] ${asset.id}: ${outcome.operatorMessage}`)
        }
        if (!outcome.applied) results.already_settled++
        else if (outcome.outcome === "ready") results.ready++
        else if (outcome.outcome === "failed") results.failed++
        else results.still_processing++
      } catch (err: any) {
        console.error(`[poll-did-avatars] Error processing asset ${asset.id}:`, err)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.processed,
      output_count: results.ready,
      metadata: results,
    })

    return NextResponse.json({ success: true, timestamp: new Date().toISOString(), results })
  } catch (error: any) {
    console.error("[poll-did-avatars] Cron error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json(
      { error: "Polling failed", details: error.message, context_id: contextId },
      { status: 500 }
    )
  }
}
