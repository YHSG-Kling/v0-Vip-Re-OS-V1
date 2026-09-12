import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

/**
 * TASK_OVERDUE sweep — hourly (lib/kernel/cron-dispatch.ts, "20 * * * *").
 *
 * WHY (integrator, wave 26, 2026-09-03). notification_rules holds live
 * `task_overdue` rows and lib/kernel/notification-engine.ts carries the label,
 * but NOTHING in the tree ever emitted KernelEvent.TASK_OVERDUE: app/actions/
 * overdue.ts is a reader, and the admin task board's `status = 'overdue'`
 * filter matched nothing because no writer sets that status. This sweep is the
 * emitter. It does not change the task row (status vocabulary stays
 * pending | in_progress | completed | cancelled — lane G3's ruling); it fires
 * the event once per task per calendar day through emitKernelEvent, whose
 * dedupe_key column (indexed) makes the hourly cadence idempotent.
 *
 * Tenant: the service client reads across tenants ON PURPOSE — this is a
 * platform cron gated by the cron secret, and every row it touches is written
 * back under the row's own brokerage_id (CLAUDE.md §4 — the tenant is never
 * taken from a request).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 500

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "task-overdue",
    cron_path: "/app/api/cron/task-overdue/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[TaskOverdue] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const nowIso = new Date().toISOString()
    const day = nowIso.slice(0, 10)

    // Due in the past, not in a terminal status. `due_date` is nullable; a task
    // with no due date is never overdue. Ordered oldest-first so the batch cap
    // favours the tasks that have waited longest.
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("id, brokerage_id, assigned_to_agent_id, title, due_date, status, contact_id, transaction_id, listing_id")
      .lt("due_date", nowIso)
      .not("status", "in", "(completed,cancelled)")
      .order("due_date", { ascending: true })
      .limit(BATCH)
    if (error) throw new Error(`tasks read refused: ${error.message}`)

    let emitted = 0
    let deduped = 0
    let refused = 0
    const refusals: Array<{ task_id: string; error: string }> = []

    for (const t of tasks ?? []) {
      if (!t.brokerage_id) continue
      const result = await emitKernelEvent({
        event:        KernelEvent.TASK_OVERDUE,
        brokerageId:  t.brokerage_id,
        entityType:   "task",
        entityId:     t.id,
        contactId:    t.contact_id ?? undefined,
        transactionId: t.transaction_id ?? undefined,
        listingId:    t.listing_id ?? undefined,
        source:       "cron",
        dedupeKey:    `task_overdue:${t.id}:${day}`,
        // The key is day-grained and the cadence is hourly, so the window must
        // cover the day — emit's default (60s) would have re-fired every hour.
        dedupeWindowSec: 86_400,
        metadata: {
          assigned_to_agent_id: t.assigned_to_agent_id,
          title: t.title,
          due_date: t.due_date,
          status: t.status,
        },
      })
      if (result.error) {
        refused += 1
        if (refusals.length < 20) refusals.push({ task_id: t.id, error: result.error })
        continue
      }
      if (result.inserted) emitted += 1
      else deduped += 1
    }

    const payload = {
      scanned: tasks?.length ?? 0,
      batch_cap: BATCH,
      capped: (tasks?.length ?? 0) >= BATCH,
      emitted,
      deduped_today: deduped,
      refused,
      refusals,
      day,
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: payload.scanned,
      output_count: emitted,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[TaskOverdue] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
