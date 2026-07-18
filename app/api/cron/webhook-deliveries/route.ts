import { NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  enqueueTenantWebhookDeliveries,
  drainTenantWebhookDeliveries,
} from "@/lib/platform/tenant-webhooks"

/**
 * TENANT OUTBOUND WEBHOOK DELIVERY WORKER (every 5 minutes, via the dispatcher).
 *
 * Two steps per cycle, both fed by the ONE ledger tap (lifecycle_events — see
 * lib/platform/tenant-webhooks-core.ts):
 *
 *   1. ENQUEUE — per active subscription, scan the ledger since that
 *      subscription's cursor for its subscribed catalog events and stage
 *      pending tenant_webhook_deliveries rows idempotently (dedupe key:
 *      subscription + event + ledger-row id carried in payload.id).
 *
 *   2. DRAIN — POST due pending/failed rows to the subscriber URL with the
 *      Stripe-style HMAC signature (X-Webhook-Signature) and a 5s timeout.
 *      Success → delivered (+ subscription last_success_at). Failure →
 *      attempts++ / next_attempt_at per the 1m→5m→30m→2h backoff ladder;
 *      the 5th failure marks the row dead and bumps failure_count.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "webhook-deliveries",
    cron_path: "/app/api/cron/webhook-deliveries/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  try {
    const enqueue = await enqueueTenantWebhookDeliveries()
    const drain = await drainTenantWebhookDeliveries()

    const errors = [...enqueue.errors, ...drain.errors]
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: enqueue.enqueued + drain.due,
      metadata: {
        subscriptions: enqueue.subscriptions,
        scanned: enqueue.scanned,
        enqueued: enqueue.enqueued,
        due: drain.due,
        delivered: drain.delivered,
        retried: drain.retried,
        dead: drain.dead,
        errors: errors.slice(0, 10),
      },
    }).catch(() => {})

    return NextResponse.json({
      ok: true,
      enqueue: { subscriptions: enqueue.subscriptions, scanned: enqueue.scanned, enqueued: enqueue.enqueued },
      drain: { due: drain.due, delivered: drain.delivered, retried: drain.retried, dead: drain.dead },
      errors: errors.slice(0, 10),
    })
  } catch (e: unknown) {
    await recordCronFailureAction({
      context_id: contextId,
      error: e instanceof Error ? e : String(e),
      stage: "main-processing",
    }).catch(() => {})
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
