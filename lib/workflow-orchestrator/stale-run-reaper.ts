// lib/workflow-orchestrator/stale-run-reaper.ts
// ─────────────────────────────────────────────────────────────────────────────
// STALE WORKFLOW-RUN REAPER (Campaign Orchestrator domain — owns workflow_runs). No chain run sits
// forever mid-execution. If a run is stuck in 'running'/'pending' past its threshold, the chain stalled
// (a step threw, the engine died, a render never returned) and the manager owns it: mark it failed (so
// it surfaces + stops re-scanning) and notify the responsible agent. Chains paused on a human are left
// alone. Idempotent; best-effort; never throws. The third reaper (signals, video, now chains) that
// guarantees every manager workflow has an owner.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { classifyStaleWorkflowRun, WORKFLOW_RUN_STALE_HOURS } from "./stale-run-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface WorkflowRunReaperResult { scanned: number; escalated: number }

export async function reapStaleWorkflowRuns(
  brokerageId: string, client?: Svc, opts?: { now?: Date; limit?: number },
): Promise<WorkflowRunReaperResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: WorkflowRunReaperResult = { scanned: 0, escalated: 0 }
  if (!brokerageId) return result

  const { data: rows } = await svc.from("workflow_runs")
    .select("id, chain_key, agent_user_id, status, started_at, updated_at")
    .eq("brokerage_id", brokerageId)
    .in("status", Object.keys(WORKFLOW_RUN_STALE_HOURS))
    .limit(opts?.limit ?? 100)

  for (const r of (rows ?? []) as Array<{ id: string; chain_key: string | null; agent_user_id: string | null; status: string; started_at: string | null; updated_at: string | null }>) {
    result.scanned++
    const anchor = r.updated_at ?? r.started_at ?? now.toISOString()
    const ageHours = (now.getTime() - new Date(anchor).getTime()) / 3_600_000
    if (classifyStaleWorkflowRun({ status: r.status, ageHours }) !== "escalate") continue
    try {
      await svc.from("workflow_runs")
        .update({ status: "failed", failed_at: now.toISOString(), error_message: `stalled in '${r.status}' for ${Math.round(ageHours)}h — reaped by the Campaign Orchestrator`, updated_at: now.toISOString() })
        .eq("id", r.id)
      if (r.agent_user_id) {
        await svc.from("notifications").insert({
          user_id: r.agent_user_id, brokerage_id: brokerageId, type: "workflow_stalled",
          title: "An automation stalled and was flagged",
          body: `The "${r.chain_key ?? "automation"}" workflow got stuck and your AI team flagged it so it doesn't sit unfinished. You can re-trigger it if it's still needed.`,
          entity_type: "workflow_run", entity_id: r.id, priority: "medium", is_read: false,
        })
      }
      result.escalated++
    } catch { /* best-effort per run */ }
  }
  return result
}
