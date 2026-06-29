// lib/video/video-pipeline-reaper.ts
// ─────────────────────────────────────────────────────────────────────────────
// STALE VIDEO-WORKFLOW REAPER (Asset Manager domain). No commissioned reel should sit forever in a
// non-terminal state — if the render worker never picked it up, D-ID never finished, or the composite
// died, a manager must OWN it instead of letting the workflow fall through the cracks. This sweeps the
// Director reel pipeline, marks genuinely-stalled rows failed (so they surface + stop being re-scanned),
// and notifies the responsible agent. Idempotent (marking failed removes it from the scan). Never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { classifyStaleVideo, VIDEO_STALE_HOURS } from "./video-pipeline-reaper-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface VideoReaperResult { scanned: number; escalated: number }

export async function reapStaleVideoWorkflows(
  brokerageId: string, client?: Svc, opts?: { now?: Date; limit?: number },
): Promise<VideoReaperResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: VideoReaperResult = { scanned: 0, escalated: 0 }
  if (!brokerageId) return result

  const { data: rows } = await svc.from("ai_video_projects")
    .select("id, agent_id, status, updated_at, title")
    .eq("brokerage_id", brokerageId)
    .in("status", Object.keys(VIDEO_STALE_HOURS))
    .limit(opts?.limit ?? 100)

  for (const r of (rows ?? []) as Array<{ id: string; agent_id: string | null; status: string; updated_at: string | null; title: string | null }>) {
    result.scanned++
    const ageHours = (now.getTime() - new Date(r.updated_at ?? now.toISOString()).getTime()) / 3_600_000
    if (classifyStaleVideo({ status: r.status, ageHours }) !== "escalate") continue
    try {
      await svc.from("ai_video_projects")
        .update({ status: "failed", error_message: `stalled in '${r.status}' for ${Math.round(ageHours)}h — reaped by the Asset Manager`, updated_at: now.toISOString() })
        .eq("id", r.id)
      // ai_video_projects.agent_id is the agent's USER id (FK users) — notify them directly.
      if (r.agent_id) {
        await svc.from("notifications").insert({
          user_id: r.agent_id, brokerage_id: brokerageId, type: "video_stalled",
          title: "A video stalled and was flagged",
          body: `${r.title ?? "A commissioned video"} got stuck in rendering and your AI team flagged it. You can re-request it from the listing's video tools.`,
          entity_type: "video_project", entity_id: r.id, priority: "medium", is_read: false,
        })
      }
      result.escalated++
    } catch { /* best-effort per row */ }
  }
  return result
}
