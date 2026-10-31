// workflows/completion-watch-workflow.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DURABLE TIMER BEHIND CONTRACT C14 (wave 147, lane 147G; owner ruling 13 — "the managers need to make sure that
// arbiter completes not relying on crons to do so").
//
// One run per completion, started by the EVENT that opened (or advanced) it — lib/kernel/completion-tracking.ts
// openCompletion / recordCompletionEvidence → `start(completionWatchWorkflow, …)`. The run sleeps until the completion is
// due (Vercel Workflow `sleep` — a timer in the event log, survives restarts and deploys), then the owning manager's check
// runs as a STEP (lib/kernel/completion-tracking.ts superviseCompletion, trigger "workflow" — per-step retry is the
// durable retry), and the run sleeps again only if the check asks for a later look. Bounded: MAX_CHECKS looks, then the
// row is left to the cron net (reconcileOpenCompletions), which stamps recovered_by = "cron" on anything it recovers.
//
// The second Workflow DevKit lane in the repo (the first: workflows/market-insight-workflow.ts) — the same pattern:
// a step resolves its survivors by dynamic import, so the workflow bundle stays a leaf.

import { sleep } from "workflow"

/** The most checks one run makes (decision → delivery → a late report) before the cron net takes over. */
const MAX_CHECKS = 4

export interface CompletionWatchInput {
  brokerageId: string
  completionId: string
  /** ISO time of the first check (the completion's due_at). */
  firstCheckAt: string
}

export interface CompletionWatchResult {
  brokerageId: string
  completionId: string
  checks: number
  verdict: string
  reason: string
}

async function superviseStep(brokerageId: string, completionId: string): Promise<{ verdict: string; nextCheckAt: string | null; reason: string }> {
  "use step"
  const [{ superviseCompletion }, { createServiceClient }] = await Promise.all([import("@/lib/kernel/completion-tracking"), import("@/lib/supabase/service")])
  const r = await superviseCompletion(createServiceClient() as never, { brokerageId, completionId, trigger: "workflow" })
  return { verdict: r.verdict, nextCheckAt: r.nextCheckAt ?? null, reason: r.reason.slice(0, 300) }
}

export async function completionWatchWorkflow(input: CompletionWatchInput): Promise<CompletionWatchResult> {
  "use workflow"
  let at = input.firstCheckAt
  let last = { verdict: "waiting", nextCheckAt: at as string | null, reason: "not checked yet" }
  let checks = 0
  while (checks < MAX_CHECKS) {
    const when = new Date(at)
    if (!Number.isNaN(when.getTime()) && when.getTime() > Date.now()) await sleep(when)
    last = await superviseStep(input.brokerageId, input.completionId)
    checks++
    // closed / escalated / refused end the watch; advanced / waiting / remediated look again at the next due time.
    if (!last.nextCheckAt || last.verdict === "closed" || last.verdict === "escalated" || last.verdict === "refused") break
    at = last.nextCheckAt
  }
  return { brokerageId: input.brokerageId, completionId: input.completionId, checks, verdict: last.verdict, reason: last.reason }
}
