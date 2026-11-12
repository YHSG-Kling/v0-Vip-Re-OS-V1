"use server"

// app/actions/youtube-backfill.ts — the DOOR for "send my approved videos to the connected YouTube channel now" (wave 143, lane 143F; closes
// the 142K "YouTube connect backfill" item beside the cron net, which is the backup).
// The work is lib/video/youtube-publish.ts backfillYouTubeAutoPublish: the tenant's approved, non-personal public-marketing videos that were
// finished before the channel was connected are queued as YouTube posts (the publish-social-posts cron sends them; privacy is decided at SEND
// time from the file's classification). Every export is a public endpoint: the tenant comes from the SESSION, the caller must be on the tenant
// admin roster (queuing public posts for the brokerage's channel is a brokerage act), and the tenant's own video_auto_publish policy still
// governs — an off or unreadable policy queues nothing and says so.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"

export async function queueApprovedVideosToYouTubeAction(): Promise<
  | { success: true; examined: number; queued: number; alreadyQueued: number; skipped: Array<{ id: string; reason: string }>; note: string | null }
  | { success: false; error: string }
> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { success: false, error: "Not authenticated" }
    const supabase = await createClient()
    const admin = await resolveTenantAdmin(supabase, ctx.userId, { user_type: ctx.userType, brokerage_id: ctx.brokerageId })
    if (!admin.ok) return { success: false, error: `Could not resolve your permissions: ${admin.error}` }
    if (!admin.isTenantAdmin) return { success: false, error: "Only a broker, an admin, a team lead or a compliance officer can queue the brokerage's videos for YouTube." }
    const { backfillYouTubeAutoPublish } = await import("@/lib/video/youtube-publish")
    const r = await backfillYouTubeAutoPublish(createServiceClient(), ctx.brokerageId, { limit: 10 })
    return { success: true, examined: r.examined, queued: r.queued, alreadyQueued: r.alreadyQueued, skipped: r.skipped, note: r.note ?? null }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to queue the videos for YouTube" }
  }
}
