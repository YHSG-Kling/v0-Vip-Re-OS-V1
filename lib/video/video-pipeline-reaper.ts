// lib/video/video-pipeline-reaper.ts
// ─────────────────────────────────────────────────────────────────────────────
// STALE VIDEO-WORKFLOW REAPER (Asset Manager domain). No commissioned reel should sit forever in a
// non-terminal state — if the render worker never picked it up, D-ID never finished, or the composite
// died, a manager must OWN it instead of letting the workflow fall through the cracks. This sweeps the
// Director reel pipeline, marks genuinely-stalled rows failed (so they surface + stop being re-scanned),
// and notifies the responsible agent. Idempotent (marking failed removes it from the scan). Never throws.
//
// WAVE 87 (lane 87D) — THE WATCHDOG CADENCE AND THE WRITE.
//   · This ran only from the DAILY proactive lane of the reaper net
//     (lib/intelligence/reaper-net.ts, cron 22 7 * * *), so a row stalled in
//     'generating' (a 3 h threshold) could sit ~27 h before anyone owned it. An
//     approved script that renders autonomously (lib/video/render-from-
//     approval.ts) must never read "in progress" for a day. sweepStuckVideoRenders
//     below drives THIS reaper — not a second one — from every
//     director-reel-render tick (every 5 min) for exactly the tenants that have
//     a row past a threshold.
//   · The failed stamp was `.eq("id")` alone with no error read: a refused
//     write resolved, the row stayed 'generating', and the agent was told it
//     was flagged. It is now tenant-pinned, guarded on the status it was read
//     in (a row the poller completed a moment ago is never clobbered),
//     `.select()`-counted, and only a stamp that landed escalates or notifies.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { classifyStaleVideo, VIDEO_STALE_HOURS } from "./video-pipeline-reaper-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface VideoReaperResult { scanned: number; escalated: number; refused?: number }

export async function reapStaleVideoWorkflows(
  brokerageId: string, client?: Svc, opts?: { now?: Date; limit?: number },
): Promise<VideoReaperResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: VideoReaperResult = { scanned: 0, escalated: 0, refused: 0 }
  if (!brokerageId) return result

  const { data: rows, error: readErr } = await svc.from("ai_video_projects")
    .select("id, agent_id, status, updated_at, title")
    .eq("brokerage_id", brokerageId)
    .in("status", Object.keys(VIDEO_STALE_HOURS))
    .limit(opts?.limit ?? 100)
  if (readErr) {
    console.error(`[video-pipeline-reaper] stalled-row read refused for brokerage ${brokerageId}: ${readErr.message}`)
    result.refused = (result.refused ?? 0) + 1
    return result
  }

  for (const r of (rows ?? []) as Array<{ id: string; agent_id: string | null; status: string; updated_at: string | null; title: string | null }>) {
    result.scanned++
    const ageHours = (now.getTime() - new Date(r.updated_at ?? now.toISOString()).getTime()) / 3_600_000
    if (classifyStaleVideo({ status: r.status, ageHours }) !== "escalate") continue
    try {
      const { data: stamped, error: stampErr } = await svc.from("ai_video_projects")
        .update({ status: "failed", error_message: `stalled in '${r.status}' for ${Math.round(ageHours)}h — reaped by the Asset Manager`, updated_at: now.toISOString() })
        .eq("id", r.id)
        .eq("brokerage_id", brokerageId)
        .eq("status", r.status)
        .select("id")
      if (stampErr || !stamped || stamped.length === 0) {
        // Refused, or the row moved on since the read (the poller finished it) —
        // either way nothing was reaped, so nobody is told it was.
        if (stampErr) {
          console.error(`[video-pipeline-reaper] failed-stamp refused for project ${r.id}: ${stampErr.message}`)
          result.refused = (result.refused ?? 0) + 1
        }
        continue
      }
      // ai_video_projects.agent_id is agents-class since m366 while
      // notifications.user_id FKs users — resolve across. Null ⇒ the row is still
      // marked failed (that part is the point), but the notify is skipped with a
      // line naming it rather than FK-rejected into silence.
      const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
      const ownerUserId = r.agent_id ? await resolveAgentRecordToUserId(r.agent_id) : null
      if (r.agent_id && !ownerUserId) {
        console.warn(`[video-pipeline-reaper] no users row behind agents.id=${r.agent_id} (project ${r.id}) — stall notice skipped`)
      }
      if (ownerUserId) {
        await sentinelWrite(svc, svc.from("notifications").insert({
          user_id: ownerUserId, brokerage_id: brokerageId, type: "video_stalled",
          title: "A video stalled and was flagged",
          body: `${r.title ?? "A commissioned video"} got stuck in rendering and your AI team flagged it. You can re-request it from the listing's video tools.`,
          entity_type: "video_project", entity_id: r.id, priority: "medium", is_read: false,
        }), { table: "notifications", flow: "video_pipeline_reaper_notify", brokerageId: brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
      }
      result.escalated++
    } catch { /* best-effort per row */ }
  }
  return result
}

export interface StuckRenderSweepResult { tenants: number; scanned: number; escalated: number; refused: number; error?: string }

/**
 * THE WATCHDOG DRIVER (wave 87). Finds the tenants holding a video row older
 * than the SHORTEST stale threshold in a reapable state, and runs the ONE
 * reaper above for each (its own policy decides per row). Cheap by
 * construction: one indexed read, bounded tenants per tick. Never throws.
 */
export async function sweepStuckVideoRenders(
  client?: Svc, opts?: { now?: Date; maxTenants?: number },
): Promise<StuckRenderSweepResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const out: StuckRenderSweepResult = { tenants: 0, scanned: 0, escalated: 0, refused: 0 }
  const minHours = Math.min(...Object.values(VIDEO_STALE_HOURS))
  const cutoff = new Date(now.getTime() - minHours * 3_600_000).toISOString()
  try {
    const { data, error } = await svc.from("ai_video_projects")
      .select("brokerage_id")
      .in("status", Object.keys(VIDEO_STALE_HOURS))
      .lt("updated_at", cutoff)
      .not("brokerage_id", "is", null)
      .limit(200)
    if (error) return { ...out, error: `stuck-render read refused: ${error.message}` }
    const tenants = Array.from(new Set(((data ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id))).slice(0, opts?.maxTenants ?? 10)
    for (const b of tenants) {
      const r = await reapStaleVideoWorkflows(b, svc, { now })
      out.tenants++
      out.scanned += r.scanned
      out.escalated += r.escalated
      out.refused += r.refused ?? 0
    }
    return out
  } catch (e) {
    return { ...out, error: (e as Error).message }
  }
}
