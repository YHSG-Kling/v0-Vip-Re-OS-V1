"use server"

// app/actions/tv-spot.ts — the DOOR for "make this approved video TV-ready" (wave 143, lane 143F).
// The work is lib/video/tv-spot-produce.ts (classification, fair-housing, master, captions, measured evaluation, record).
// Every export is a public endpoint: the tenant and the actor come from the SESSION, never an argument, and the
// project is read tenant-pinned inside the producer.

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function makeTvSpotAction(videoId: string): Promise<
  | { success: true; ready: boolean; url: string; failed: Array<{ id: string; required: string; measured: string }>; warnings: string[]; captionTiming: "alignment" | "even" | "none"; authority: string }
  | { success: false; error: string }
> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { success: false, error: "Not authenticated" }
    if (typeof videoId !== "string" || !/^[0-9a-f-]{36}$/i.test(videoId)) return { success: false, error: "Invalid video id" }
    const { produceTvSpotMaster } = await import("@/lib/video/tv-spot-produce")
    const r = await produceTvSpotMaster(createServiceClient(), { brokerageId: ctx.brokerageId, videoId, actorUserId: ctx.userId })
    if (!r.ok) return { success: false, error: r.error }
    return {
      success: true, ready: r.ready, url: r.url, warnings: r.record.warnings, captionTiming: r.record.captions.timing, authority: r.record.authority,
      failed: r.evaluation.failed.map((c) => ({ id: c.id, required: c.required, measured: c.measured })),
    }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to make the TV master" }
  }
}

/** The recorded TV result for a video (tenant-pinned read; null when none was made). */
export async function getTvSpotAction(videoId: string): Promise<{ success: true; tvSpot: import("@/lib/video/tv-spot-produce").TvSpotRecord | null } | { success: false; error: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }
    if (typeof videoId !== "string" || !/^[0-9a-f-]{36}$/i.test(videoId)) return { success: false, error: "Invalid video id" }
    const { data, error } = await createServiceClient().from("ai_video_projects").select("video_metadata").eq("id", videoId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (error) return { success: false, error: error.message }
    const { tvSpotOf } = await import("@/lib/video/tv-spot-produce")
    return { success: true, tvSpot: tvSpotOf((data as { video_metadata?: unknown } | null)?.video_metadata) }
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? "Failed to read the TV master" }
  }
}
