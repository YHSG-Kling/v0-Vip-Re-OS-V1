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

import {
type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

const DID_API_BASE = "https://api.d-id.com"
// Same bucket the Twin wizard uses for the uploaded source photo/video.
const AVATAR_BUCKET = "twin-avatars"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Download the finished D-ID avatar image and re-host it in our own Supabase
 * bucket, returning the stable public URL. The owner's contract: we do not
 * hot-link the D-ID CDN (its URLs expire) — once the avatar is ready we pull
 * the bytes and serve the avatar from our bucket, and it's THAT url (not the
 * D-ID id) the profile stores. Best-effort: returns null on any failure so the
 * caller can fall back to the D-ID url and never break the poll.
 */
async function rehostAvatarImage(
  supabase: ReturnType<typeof createServiceClient>,
  assetId: string,
  sourceUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl)
    if (!res.ok) return null
    const contentType = res.headers.get("content-type") ?? "image/jpeg"
    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("mp4")
          ? "mp4"
          : "jpg"
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0) return null
    const path = `rehosted/${assetId}.${ext}`
    const { error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(path, bytes, { contentType, upsert: true })
    if (error) return null
    const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path)
    return data?.publicUrl ?? null
  } catch {
    return null
  }
}

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
      .select("id, agent_id, brokerage_id, did_avatar_id, is_default, label")
      .in("status", ["pending", "processing"])
      .not("did_avatar_id", "is", null)
      .limit(20)

    if (fetchError) throw fetchError

    const results = { processed: 0, ready: 0, failed: 0, still_processing: 0 }
    const auth = `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`

    // Resolve agent_id → user_id once per cron tick so notifications go to
    // the right inbox. notifications.user_id references users.id, but
    // agent_avatar_assets.agent_id is agents.id — the two are different.
    const agentIds = Array.from(new Set((pending ?? []).map((a: any) => a.agent_id).filter(Boolean)))
    const userByAgent = new Map<string, string>()
    if (agentIds.length) {
      const { data: agentRows } = await supabase
        .from("agents")
        .select("id, user_id")
        .in("id", agentIds)
      for (const a of agentRows ?? []) {
        if (a.user_id) userByAgent.set(a.id as string, a.user_id as string)
      }
    }

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
        // Anything else non-ok IS transient — leave the row alone and retry.
        if (!statusRes.ok) continue

        const data = await statusRes.json()
        const didStatus: string = data.status
        const notifyUserId = asset.agent_id ? userByAgent.get(asset.agent_id) ?? null : null

        // D-ID's scene-avatar vocabulary is:
        //   draft | validating | created | started | training-started | done | error | rejected
        // "ready" was tested here and is not in that set — a dead branch.
        if (didStatus === "done") {
          // HIGH RES FIRST. This preferred thumbnail_url ("a low resolution
          // image") and then preview_url — which is documented as a short GIF —
          // over image_url, the actual high-resolution avatar. So the profile
          // picture an agent saw could be a low-res still or an animated GIF
          // while the good asset went unused.
          const didAssetUrl: string | null =
            data.image_url ?? data.thumbnail_url ?? data.preview_url ?? null

          // Download the finished avatar and re-host it in our bucket so the
          // profile URL is stable (D-ID CDN links expire). Fall back to the
          // D-ID url if the re-host fails so the avatar is never left blank.
          const rehostedUrl = didAssetUrl
            ? await rehostAvatarImage(supabase, asset.id as string, didAssetUrl)
            : null
          const avatarUrl = rehostedUrl ?? didAssetUrl

          await supabase
            .from("agent_avatar_assets")
            .update({
              status: "ready",
              thumbnail_url: avatarUrl,
              avatar_url: avatarUrl, // the profile-facing, self-hosted avatar URL
              error_message: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", asset.id)

          // Mirror onto agent_voice_profiles for default avatars so
          // generate-video and chat-widget lookups get it on a single join.
          // The PROFILE stores the bucket URL (avatar_url); did_avatar_id is
          // kept only because clip generation still references the D-ID id.
          if (asset.is_default && asset.agent_id) {
            await supabase
              .from("agent_voice_profiles")
              .update({ did_avatar_id: asset.did_avatar_id, avatar_url: avatarUrl })
              .eq("agent_id", asset.agent_id)
          }

          // In-app notification to the agent (uses users.id, not agents.id)
          if (notifyUserId) {
            await supabase.from("notifications").insert({
              user_id: notifyUserId,
              brokerage_id: asset.brokerage_id,
              type: "avatar_ready",
              title: "Avatar Ready",
              body: `Your avatar "${asset.label}" is ready. Create a video to see it in action.`,
              entity_type: "agent_avatar_asset",
              entity_id: asset.id,
              priority: "medium",
              channel: "in_app",
            })
          }

          // A voice clone can fail on an avatar that otherwise finished. D-ID
          // reports it in creation_notes, and nothing read it — so the agent
          // got a working face with a silently missing voice.
          const cloneFailed = data.creation_notes?.is_clone_voice_failed === true
          const workerErrors: string[] = Array.isArray(data.creation_notes?.worker_errors)
            ? data.creation_notes.worker_errors : []
          if (cloneFailed || workerErrors.length > 0) {
            await supabase.from("agent_avatar_assets").update({
              error_message: cloneFailed
                ? "The avatar is ready, but its voice clone failed — record a voice sample in Twin Studio."
                : `The avatar is ready with warnings: ${workerErrors.slice(0, 3).join("; ")}`,
              updated_at: new Date().toISOString(),
            }).eq("id", asset.id)
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

          if (notifyUserId) {
            await supabase.from("notifications").insert({
              user_id: notifyUserId,
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
          // draft | validating | created | started | training-started — still working
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
