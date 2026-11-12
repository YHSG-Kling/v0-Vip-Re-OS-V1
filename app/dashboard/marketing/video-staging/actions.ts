"use server"

// app/dashboard/marketing/video-staging/actions.ts — the Video Staging screen's doors (wave 146, lane 146F — owner rulings 4 + 9).
// Every export is a public endpoint: the tenant comes from the SESSION, the video is re-read in that tenant by the lib, and the
// approver is the SESSION user — the lib refuses anyone the authority hierarchy did not assign (lib/video/video-staging.ts).

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { revalidatePath } from "next/cache"

/** This tenant's non-listing broadcast videos and their stage (the admin roster sees the tenant's; an agent their own). */
export async function listStagedVideosAction() {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.userId) return { success: false as const, error: "Not authenticated" }
    const svc = createServiceClient()
    const { listStagedVideos } = await import("@/lib/video/video-staging")
    const res = await listStagedVideos(svc, { brokerageId: ctx.brokerageId })
    if (res.error) return { success: false as const, error: res.error }
    let videos = res.videos
    if (!isAdminOrBroker({ user_type: ctx.role })) {
      if (!ctx.agentId) return { success: true as const, videos: videos.filter((v) => v.approverUserIds.includes(ctx.userId)), userId: ctx.userId }
      const { data: own, error: ownErr } = await svc.from("ai_video_projects").select("id").eq("brokerage_id", ctx.brokerageId).eq("agent_id", ctx.agentId)
      if (ownErr) return { success: false as const, error: `videos unreadable: ${ownErr.message}` }
      const mine = new Set(((own ?? []) as Array<{ id: string }>).map((r) => r.id))
      videos = videos.filter((v) => mine.has(v.id) || v.approverUserIds.includes(ctx.userId))
    }
    return { success: true as const, videos, userId: ctx.userId }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to list staged videos" }
  }
}

/** (Re-)stage one video — rights, branding, audience, channels, approver. */
export async function stageVideoAction(videoId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.userId) return { success: false as const, error: "Not authenticated" }
    const svc = createServiceClient()
    if (!isAdminOrBroker({ user_type: ctx.role })) {
      const { data, error } = await svc.from("ai_video_projects").select("agent_id").eq("id", videoId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
      if (error) return { success: false as const, error: `video unreadable: ${error.message}` }
      if (!data || !ctx.agentId || (data as { agent_id?: string | null }).agent_id !== ctx.agentId) return { success: false as const, error: "Forbidden" }
    }
    const { stageVideoForPublication } = await import("@/lib/video/video-staging")
    const r = await stageVideoForPublication(svc, { brokerageId: ctx.brokerageId, videoId })
    if (!r.ok) return { success: false as const, error: r.error }
    revalidatePath("/dashboard/marketing/video-staging")
    return r.staged
      ? { success: true as const, stage: r.stage, blockers: [...r.blockers, ...r.waitingOn], notified: r.notified }
      : { success: true as const, stage: null, blockers: [r.reason], notified: 0 }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to stage the video" }
  }
}

/** The ASSIGNED approver approves — the session user must be one the authority hierarchy assigned. */
export async function approveStagedVideoAction(videoId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.userId) return { success: false as const, error: "Not authenticated" }
    const { approveStagedVideo } = await import("@/lib/video/video-staging")
    const r = await approveStagedVideo(createServiceClient(), { brokerageId: ctx.brokerageId, videoId, approverUserId: ctx.userId })
    if (!r.ok) return { success: false as const, error: r.error }
    revalidatePath("/dashboard/marketing/video-staging")
    return { success: true as const, stage: r.stage }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to approve the video" }
  }
}
