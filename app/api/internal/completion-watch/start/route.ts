/**
 * POST /api/internal/completion-watch/start
 *
 * THE COMPOSITION ROOT OF THE DURABLE COMPLETION TIMER (wave 153). lib/kernel/completion-tracking.ts used to import
 * workflows/completion-watch-workflow.ts itself to start a run; that one edge pulled the whole inbound-reply chain
 * (inbound-record → responder → unattended answerer) into every page graph that reaches the supervisor. The supervisor now
 * asks THIS route to start the run — the same same-origin, CRON_SECRET-authenticated self-call the render queue uses for
 * app/api/internal/remotion/render-composition — so only this function bundles the workflow.
 *
 * Auth: CRON_SECRET (verifyCronAuth). The tenant is not trusted from the body: the completion row is re-read pinned to the
 * named brokerage, and a row that is not there starts nothing. A refusal here is never a lost completion — the caller
 * records "not scheduled" and the cron net (app/api/cron/manager-signals) reconciles the row by its due_at.
 */
import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  const denied = verifyCronAuth(request)
  if (denied) return denied

  const body = (await request.json().catch(() => null)) as { brokerageId?: unknown; completionId?: unknown; checkAt?: unknown } | null
  const brokerageId = typeof body?.brokerageId === "string" ? body.brokerageId : ""
  const completionId = typeof body?.completionId === "string" ? body.completionId : ""
  const checkAt = typeof body?.checkAt === "string" ? body.checkAt : ""
  if (!UUID.test(brokerageId) || !UUID.test(completionId) || Number.isNaN(Date.parse(checkAt))) {
    return NextResponse.json({ scheduled: false, reason: "a brokerage id, a completion id and a check time are required" }, { status: 400 })
  }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: row, error } = await svc.from("manager_completions").select("id").eq("id", completionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return NextResponse.json({ scheduled: false, reason: `the completion could not be read: ${error.message}` }, { status: 503 })
  if (!row) return NextResponse.json({ scheduled: false, reason: "no such completion in this account" }, { status: 404 })

  try {
    const [{ start }, { completionWatchWorkflow }] = await Promise.all([import("workflow/api"), import("@/workflows/completion-watch-workflow")])
    await start(completionWatchWorkflow, [{ brokerageId, completionId, firstCheckAt: checkAt }])
    return NextResponse.json({ scheduled: true })
  } catch (e) {
    return NextResponse.json({ scheduled: false, reason: `the durable timer could not be started: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 })
  }
}
