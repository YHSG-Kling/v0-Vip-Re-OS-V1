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
 * TASK_DUE sweep — hourly (lib/kernel/cron-dispatch.ts).
 *
 * WHY (lane CB, 2026-09-08). notification_rules and campaign_sequences both
 * hold live `task_due` rows, and `lib/kernel/calendar-deadline-watcher.ts`
 * already carries a CalendarEventType.TASK_DUE → KernelEvent.TASK_DUE map
 * entry — but nothing in the tree ever creates a `calendar_events` row with
 * that event_type, so the wiring is dead: a configured trigger with an
 * emitter that never runs. `tasks.due_date` is the real due-date surface
 * (task-overdue already sweeps it for the PAST-due half); this is its
 * due-SOON twin — tasks due within the next 24h that are not yet overdue.
 *
 * Same shape as task-overdue: does not touch the task row (status vocabulary
 * stays pending | in_progress | completed | cancelled), fires once per task
 * per calendar day via emitKernelEvent's dedupe_key column so the hourly
 * cadence is idempotent.
 *
 * Tenant: the service client reads across tenants ON PURPOSE — a platform
 * cron gated by the cron secret, every row written back under its own
 * brokerage_id (CLAUDE.md §4).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 500

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "task-due",
    cron_path: "/app/api/cron/task-due/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[TaskDue] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const nowIso = new Date().toISOString()
    const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const day = nowIso.slice(0, 10)

    // Due within the next 24h, not already overdue (that's task-overdue's job),
    // not in a terminal status. `due_date` is nullable; a task with no due date
    // is never "due soon".
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("id, brokerage_id, assigned_to_agent_id, title, due_date, status, contact_id, transaction_id, listing_id")
      .gte("due_date", nowIso)
      .lte("due_date", in24h)
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
        event:        KernelEvent.TASK_DUE,
        brokerageId:  t.brokerage_id,
        entityType:   "task",
        entityId:     t.id,
        contactId:    t.contact_id ?? undefined,
        transactionId: t.transaction_id ?? undefined,
        listingId:    t.listing_id ?? undefined,
        source:       "cron",
        dedupeKey:    `task_due:${t.id}:${day}`,
        // Day-grained key on an hourly cadence — same reasoning as task-overdue.
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
    console.error("[TaskDue] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
