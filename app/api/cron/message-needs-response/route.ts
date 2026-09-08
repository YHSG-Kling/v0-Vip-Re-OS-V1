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
 * MESSAGE_NEEDS_RESPONSE sweep — hourly (lib/kernel/cron-dispatch.ts).
 *
 * WHY (lane CB, 2026-09-08). notification_rules holds a live
 * `message_needs_response` row and MESSAGE_FROM_CONTACT already fires the
 * instant a client's message lands, but that is "a message arrived", not
 * "a message is still waiting" — nothing ever swept for the second fact.
 * client_portal_messages carries no explicit "responded" flag, so the read
 * signal already on every row IS the answer: `direction = 'client_to_agent'
 * AND read = false` older than the response-SLA window means no agent has
 * opened it yet, which is the honest floor for "needs a response" (an agent
 * reply in the same thread also flips a client message `read` via the portal
 * read-receipt path — this sweep does not need to know that to be correct,
 * only to not re-fire once it happens).
 *
 * Does not touch the message row; fires once per message per calendar day via
 * emitKernelEvent's dedupe_key column so the hourly cadence is idempotent.
 *
 * Tenant: service client reads across tenants ON PURPOSE — a platform cron
 * gated by the cron secret, every row written back under its own
 * brokerage_id (CLAUDE.md §4).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 500
/** How long an unread inbound client message waits before it "needs a response". */
const SLA_HOURS = 2

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "message-needs-response",
    cron_path: "/app/api/cron/message-needs-response/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[MessageNeedsResponse] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const nowIso = new Date().toISOString()
    const slaThreshold = new Date(Date.now() - SLA_HOURS * 60 * 60 * 1000).toISOString()
    const day = nowIso.slice(0, 10)

    const { data: messages, error } = await supabase
      .from("client_portal_messages")
      .select("id, brokerage_id, contact_id, transaction_id, agent_id, created_at")
      .eq("direction", "client_to_agent")
      .eq("read", false)
      .lte("created_at", slaThreshold)
      .order("created_at", { ascending: true })
      .limit(BATCH)
    if (error) throw new Error(`client_portal_messages read refused: ${error.message}`)

    let emitted = 0
    let deduped = 0
    let refused = 0
    const refusals: Array<{ message_id: string; error: string }> = []

    for (const m of messages ?? []) {
      if (!m.brokerage_id) continue
      const result = await emitKernelEvent({
        event:         KernelEvent.MESSAGE_NEEDS_RESPONSE,
        brokerageId:   m.brokerage_id,
        entityType:    "message",
        entityId:      m.id,
        contactId:     m.contact_id ?? undefined,
        transactionId: m.transaction_id ?? undefined,
        source:        "cron",
        dedupeKey:     `message_needs_response:${m.id}:${day}`,
        dedupeWindowSec: 86_400,
        metadata: {
          agent_id:   m.agent_id,
          created_at: m.created_at,
          sla_hours:  SLA_HOURS,
        },
      })
      if (result.error) {
        refused += 1
        if (refusals.length < 20) refusals.push({ message_id: m.id, error: result.error })
        continue
      }
      if (result.inserted) emitted += 1
      else deduped += 1
    }

    const payload = {
      scanned: messages?.length ?? 0,
      batch_cap: BATCH,
      capped: (messages?.length ?? 0) >= BATCH,
      emitted,
      deduped_today: deduped,
      refused,
      refusals,
      sla_hours: SLA_HOURS,
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
    console.error("[MessageNeedsResponse] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
