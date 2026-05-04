/**
 * Cron: poll-did-avatars
 * Runs every 3 minutes to check D-ID avatar creation status for all
 * agent_avatar_assets rows in 'pending' or 'processing' state.
 *
 * D-ID /avatars flow:
 *   1. POST /avatars submits job → status='created'
 *   2. D-ID processes the source video (1–5 min)
 *   3. GET /avatars/{id} returns status: 'created'|'training'|'done'|'error'
 *   4. On done: store avatar_id as ready, update agent_voice_profiles.did_avatar_id
 *      for default avatars so generate-video picks it up immediately
 *   5. On error: mark failed with D-ID error message
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

const DID_API_BASE = "https://api.d-id.com"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

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
    const supabase = await createClient()
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
      .select("id, agent_id, brokerage_id, did_avatar_id, is_default, label")
      .in("status", ["pending", "processing"])
      .not("did_avatar_id", "is", null)
      .limit(20)

    if (fetchError) throw fetchError

    const results = { processed: 0, ready: 0, failed: 0, still_processing: 0 }
    const auth = `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`

    for (const asset of pending ?? []) {
      results.processed++

      try {
        const statusRes = await fetch(`${DID_API_BASE}/avatars/${asset.did_avatar_id}`, {
          headers: { Authorization: auth, Accept: "application/json" },
        })

        if (!statusRes.ok) continue

        const data = await statusRes.json()
        const didStatus: string = data.status

        if (didStatus === "done" || didStatus === "ready") {
          const thumbnailUrl: string | null = data.thumbnail_url ?? data.preview_url ?? null

          await supabase
            .from("agent_avatar_assets")
            .update({
              status: "ready",
              thumbnail_url: thumbnailUrl,
              error_message: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", asset.id)

          // Mirror the avatar_id onto agent_voice_profiles for default avatars
          // so generate-video and chat-widget lookups get it on a single join
          if (asset.is_default && asset.agent_id) {
            await supabase
              .from("agent_voice_profiles")
              .update({ did_avatar_id: asset.did_avatar_id })
              .eq("agent_id", asset.agent_id)
          }

          // In-app notification to the agent
          if (asset.agent_id) {
            await supabase.from("notifications").insert({
              user_id: asset.agent_id,
              brokerage_id: asset.brokerage_id,
              type: "avatar_ready",
              title: "Avatar Ready",
              body: `Your avatar "${asset.label}" is ready. Create a video to see it in action.`,
              entity_type: "agent_avatar_asset",
              entity_id: asset.id,
              priority: "normal",
              channel: "in_app",
            })
          }

          results.ready++
        } else if (didStatus === "error" || didStatus === "rejected") {
          const errorMsg: string = data.error?.description ?? data.error ?? "D-ID avatar creation failed"

          await supabase
            .from("agent_avatar_assets")
            .update({
              status: "failed",
              error_message: errorMsg,
              updated_at: new Date().toISOString(),
            })
            .eq("id", asset.id)

          if (asset.agent_id) {
            await supabase.from("notifications").insert({
              user_id: asset.agent_id,
              brokerage_id: asset.brokerage_id,
              type: "avatar_failed",
              title: "Avatar Processing Failed",
              body: `Your avatar "${asset.label}" could not be processed: ${errorMsg}. Try uploading a different video clip.`,
              entity_type: "agent_avatar_asset",
              entity_id: asset.id,
              priority: "high",
              channel: "in_app",
            })
          }

          results.failed++
        } else {
          // status: created | training | processing — still working
          await supabase
            .from("agent_avatar_assets")
            .update({ status: "processing", updated_at: new Date().toISOString() })
            .eq("id", asset.id)
            .eq("status", "pending")
          results.still_processing++
        }
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
