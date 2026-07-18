// lib/platform/tenant-webhooks.ts
//
// TENANT OUTBOUND WEBHOOKS — the server half. Two verbs the cron worker runs
// every cycle, plus the real signed POST both the worker and the UI test-ping
// share:
//
//   enqueueTenantWebhookDeliveries — per active subscription, scan the
//     lifecycle_events ledger (the SINGLE tap — see tenant-webhooks-core.ts)
//     since that subscription's cursor, map ledger rows → catalog events, and
//     insert pending tenant_webhook_deliveries rows idempotently (dedupe key:
//     subscription + external event + payload.id = the ledger row id).
//
//   drainTenantWebhookDeliveries — POST due pending/failed rows to the
//     subscriber URL with the Stripe-style HMAC signature and a 5s timeout;
//     record the honest response. Success → delivered (+ last_success_at).
//     Failure → attempts++ / next_attempt_at per the backoff ladder; the 5th
//     failure marks the row dead and bumps the subscription's failure_count.
//
// Cursor design: a subscription's cursor is the occurred_at of its most
// recently ENQUEUED delivery (deliveries are inserted in ledger order, so the
// latest row's payload.occurred_at is the high-water mark), falling back to
// the subscription's own created_at — new endpoints start from "now", they are
// never flooded with history.

import "server-only"

import { createServiceClient } from "@/lib/supabase/service"
import {
  MAX_DELIVERY_ATTEMPTS,
  WebhookLedgerRow,
  WebhookPayload,
  buildWebhookPayload,
  externalEventsForLedgerRow,
  internalTypesForEvents,
  nextAttemptDelayMs,
  signWebhookPayload,
  subscriptionMatchesEvent,
} from "@/lib/platform/tenant-webhooks-core"

type Svc = ReturnType<typeof createServiceClient>

const LEDGER_SCAN_LIMIT = 100 // per subscription per enqueue cycle
const DRAIN_BATCH_LIMIT = 50  // deliveries POSTed per drain cycle
const POST_TIMEOUT_MS = 5_000

// ─── The real POST ────────────────────────────────────────────────────────────

export interface WebhookPostResult {
  ok: boolean
  /** HTTP status when the endpoint answered; null on network error / timeout. */
  status: number | null
  error: string | null
  durationMs: number
}

/** POST a signed webhook payload. Real fetch, 5s timeout, honest error capture. */
export async function postSignedWebhook(params: {
  url: string
  secret: string
  event: string
  deliveryId: string
  payload: WebhookPayload
}): Promise<WebhookPostResult> {
  const rawBody = JSON.stringify(params.payload)
  const signature = signWebhookPayload(params.secret, rawBody, Math.floor(Date.now() / 1000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const res = await fetch(params.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "VIP-RE-OS-Webhooks/1.0",
        "X-Webhook-Signature": signature,
        "X-Webhook-Event": params.event,
        "X-Webhook-Delivery": params.deliveryId,
      },
      body: rawBody,
      signal: controller.signal,
      redirect: "error", // a webhook endpoint must answer directly, not bounce the signed body elsewhere
    })
    const durationMs = Date.now() - startedAt
    // Drain the body (bounded) so the connection is released; keep a snippet for error detail.
    let snippet = ""
    try { snippet = (await res.text()).slice(0, 300) } catch { /* body unreadable — status is what matters */ }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, error: null, durationMs }
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`, durationMs }
  } catch (e: unknown) {
    const durationMs = Date.now() - startedAt
    const aborted = e instanceof Error && e.name === "AbortError"
    const msg = aborted ? `timeout after ${POST_TIMEOUT_MS}ms` : e instanceof Error ? e.message : String(e)
    return { ok: false, status: null, error: msg.slice(0, 500), durationMs }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

interface SubscriptionRow {
  id: string
  brokerage_id: string
  url: string
  secret: string
  events: string[]
  active: boolean
  created_at: string
}

export interface EnqueueResult {
  subscriptions: number
  scanned: number
  enqueued: number
  errors: string[]
}

/** Scan the lifecycle_events ledger per active subscription and stage pending deliveries. */
export async function enqueueTenantWebhookDeliveries(client?: Svc): Promise<EnqueueResult> {
  const svc = client ?? createServiceClient()
  const result: EnqueueResult = { subscriptions: 0, scanned: 0, enqueued: 0, errors: [] }

  const { data: subs, error: subsError } = await svc
    .from("tenant_webhook_subscriptions")
    .select("id, brokerage_id, url, secret, events, active, created_at")
    .eq("active", true)
    .limit(500)
  if (subsError) {
    result.errors.push(`subscriptions: ${subsError.message}`)
    return result
  }

  for (const sub of (subs ?? []) as SubscriptionRow[]) {
    result.subscriptions += 1
    try {
      const internalTypes = internalTypesForEvents(sub.events)
      if (internalTypes.length === 0) continue

      // Cursor: occurred_at of the most recently enqueued delivery, else the
      // subscription's birth — a new endpoint starts from now, not from history.
      let cursor = sub.created_at
      const { data: lastDelivery } = await svc
        .from("tenant_webhook_deliveries")
        .select("payload, created_at")
        .eq("subscription_id", sub.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      const lastOccurred = (lastDelivery?.payload as WebhookPayload | null)?.occurred_at
      if (lastOccurred && lastOccurred > cursor) cursor = lastOccurred

      const { data: rows, error: ledgerError } = await svc
        .from("lifecycle_events")
        .select("id, brokerage_id, entity_type, entity_id, event_type, metadata, created_at")
        .eq("brokerage_id", sub.brokerage_id)
        .in("event_type", internalTypes)
        .gt("created_at", cursor)
        .order("created_at", { ascending: true })
        .limit(LEDGER_SCAN_LIMIT)
      if (ledgerError) {
        result.errors.push(`${sub.id} ledger: ${ledgerError.message}`)
        continue
      }
      const ledger = (rows ?? []) as WebhookLedgerRow[]
      result.scanned += ledger.length
      if (ledger.length === 0) continue

      // Ledger row → external catalog events → this subscription's filter.
      const candidates: Array<{ event: string; payload: WebhookPayload }> = []
      for (const row of ledger) {
        for (const event of externalEventsForLedgerRow(row)) {
          if (subscriptionMatchesEvent(sub.events, event)) {
            candidates.push({ event, payload: buildWebhookPayload(event, row) })
          }
        }
      }
      if (candidates.length === 0) continue

      // Idempotency: (subscription, external event, payload.id = ledger row id).
      const candidateIds = Array.from(new Set(candidates.map((c) => c.payload.id)))
      const { data: existing, error: dupError } = await svc
        .from("tenant_webhook_deliveries")
        .select("event_type, payload")
        .eq("subscription_id", sub.id)
        .in("payload->>id", candidateIds)
      if (dupError) {
        result.errors.push(`${sub.id} dedupe: ${dupError.message}`)
        continue
      }
      const seen = new Set(
        ((existing ?? []) as Array<{ event_type: string; payload: WebhookPayload | null }>).map(
          (d) => `${d.event_type}:${d.payload?.id ?? ""}`,
        ),
      )
      const nowIso = new Date().toISOString()
      const inserts = candidates
        .filter((c) => !seen.has(`${c.event}:${c.payload.id}`))
        .map((c) => ({
          subscription_id: sub.id,
          brokerage_id: sub.brokerage_id,
          event_type: c.event,
          payload: c.payload,
          status: "pending",
          attempts: 0,
          next_attempt_at: nowIso,
        }))
      if (inserts.length === 0) continue

      const { error: insertError } = await svc.from("tenant_webhook_deliveries").insert(inserts)
      if (insertError) {
        result.errors.push(`${sub.id} insert: ${insertError.message}`)
        continue
      }
      result.enqueued += inserts.length
    } catch (e: unknown) {
      result.errors.push(`${sub.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

// ─── Rail outcomes → the governed bus + the self-heal ledger ─────────────────

/**
 * Best-effort: ledger one failed delivery attempt onto self_heal_events
 * (flow 'webhook_delivery') so the repair digest ranks flaky subscriber
 * endpoints — a delivery that fails weekly is a root cause, not noise. A dead
 * row ledgers as 'escalated' (the human is routed in via the bus signal below),
 * a retryable failure as 'failed'. A ledger write never affects the drain.
 */
async function ledgerWebhookDeliveryFailure(svc: Svc, params: {
  brokerageId: string | null
  subscriptionId: string
  deliveryId: string
  event: string
  attempts: number
  responseStatus: number | null
  error: string | null
  dead: boolean
}): Promise<void> {
  try {
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    await recordSelfHeal(svc, {
      brokerageId: params.brokerageId,
      domain: "data_flow",
      subject: `webhook_delivery:${params.subscriptionId}`,
      action: "deliver_webhook",
      outcome: params.dead ? "escalated" : "failed",
      detail: {
        flow: "webhook_delivery",
        delivery_id: params.deliveryId,
        event: params.event,
        attempts: params.attempts,
        response_status: params.responseStatus,
        error: (params.error ?? "").slice(0, 300),
      },
    })
  } catch { /* the ledger is additive — never fail the drain on it */ }
}

/**
 * A subscription's delivery just went DEAD (5th failure) — put the outcome on the
 * governed manager bus so the human SEES it on the Command Center feed: "your
 * endpoint at X is dead — fix and re-test". Registered feed_only in
 * SIGNAL_REGISTRY: the only real fix is on the subscriber's OWN server, so no
 * governed in-OS deliverable exists for a manager to propose (a handler would be
 * a dead promise). Data Steward (webhook-table owner) → Cron Manager (loop-health
 * owner). Idempotent per open (subscription) via the bus dedupe. Best-effort.
 */
async function announceDeadWebhookEndpoint(svc: Svc, params: {
  brokerageId: string
  subscriptionId: string
  url: string
  event: string
  failureCount: number
  responseStatus: number | null
  error: string | null
}): Promise<void> {
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId: params.brokerageId,
      fromManager: "data_steward",
      toManager: "cron_manager",
      signalType: "webhook_endpoint_dead",
      message:
        `Outbound webhook endpoint ${params.url} is DEAD — a "${params.event}" delivery exhausted all ` +
        `${MAX_DELIVERY_ATTEMPTS} attempts (${params.error ?? "no response"}). Fix the endpoint, then send a ` +
        `test ping from Settings → API & Webhooks; new events will keep failing until it answers 2xx.`,
      entityType: "webhook_subscription",
      entityId: params.subscriptionId,
      payload: {
        url: params.url,
        event: params.event,
        failure_count: params.failureCount,
        response_status: params.responseStatus,
        error: (params.error ?? "").slice(0, 300),
      },
    }, svc)
  } catch { /* visibility is best-effort — the honest delivery record already landed */ }
}

// ─── Drain ───────────────────────────────────────────────────────────────────

interface DueDeliveryRow {
  id: string
  subscription_id: string
  brokerage_id: string | null
  event_type: string
  payload: WebhookPayload
  attempts: number
  tenant_webhook_subscriptions: {
    id: string
    url: string
    secret: string
    active: boolean
    failure_count: number
  }
}

export interface DrainResult {
  due: number
  delivered: number
  retried: number
  dead: number
  errors: string[]
}

/** POST due pending/failed deliveries; record honest outcomes + schedule retries. */
export async function drainTenantWebhookDeliveries(client?: Svc): Promise<DrainResult> {
  const svc = client ?? createServiceClient()
  const result: DrainResult = { due: 0, delivered: 0, retried: 0, dead: 0, errors: [] }
  const nowIso = new Date().toISOString()

  const { data: dueRows, error: dueError } = await svc
    .from("tenant_webhook_deliveries")
    .select(
      "id, subscription_id, brokerage_id, event_type, payload, attempts, tenant_webhook_subscriptions!inner(id, url, secret, active, failure_count)",
    )
    .in("status", ["pending", "failed"])
    .lte("next_attempt_at", nowIso)
    .eq("tenant_webhook_subscriptions.active", true)
    .order("next_attempt_at", { ascending: true })
    .limit(DRAIN_BATCH_LIMIT)
  if (dueError) {
    result.errors.push(`due query: ${dueError.message}`)
    return result
  }

  for (const raw of (dueRows ?? []) as unknown as DueDeliveryRow[]) {
    result.due += 1
    const sub = raw.tenant_webhook_subscriptions
    try {
      const post = await postSignedWebhook({
        url: sub.url,
        secret: sub.secret,
        event: raw.event_type,
        deliveryId: raw.id,
        payload: raw.payload,
      })
      const attemptedAt = new Date().toISOString()

      if (post.ok) {
        await svc
          .from("tenant_webhook_deliveries")
          .update({ status: "delivered", delivered_at: attemptedAt, response_status: post.status, error_detail: null })
          .eq("id", raw.id)
        await svc
          .from("tenant_webhook_subscriptions")
          .update({ last_success_at: attemptedAt, updated_at: attemptedAt })
          .eq("id", sub.id)
        result.delivered += 1
        continue
      }

      const attempts = (raw.attempts ?? 0) + 1
      const delayMs = nextAttemptDelayMs(attempts)
      if (delayMs === null) {
        // MAX_DELIVERY_ATTEMPTS reached — the row is dead; the subscription wears it.
        await svc
          .from("tenant_webhook_deliveries")
          .update({
            status: "dead",
            attempts,
            response_status: post.status,
            error_detail: `dead after ${MAX_DELIVERY_ATTEMPTS} attempts — ${post.error ?? "unknown error"}`.slice(0, 2000),
          })
          .eq("id", raw.id)
        await svc
          .from("tenant_webhook_subscriptions")
          .update({ failure_count: (sub.failure_count ?? 0) + 1, last_failure_at: attemptedAt, updated_at: attemptedAt })
          .eq("id", sub.id)
        result.dead += 1
        // Rail outcome onto the governed bus + ledger — the managers (and the human
        // on the Command Center feed) see the endpoint death, not just a status column.
        await ledgerWebhookDeliveryFailure(svc, {
          brokerageId: raw.brokerage_id ?? null, subscriptionId: sub.id, deliveryId: raw.id,
          event: raw.event_type, attempts, responseStatus: post.status, error: post.error, dead: true,
        })
        if (raw.brokerage_id) {
          await announceDeadWebhookEndpoint(svc, {
            brokerageId: raw.brokerage_id, subscriptionId: sub.id, url: sub.url,
            event: raw.event_type, failureCount: (sub.failure_count ?? 0) + 1,
            responseStatus: post.status, error: post.error,
          })
        }
      } else {
        await svc
          .from("tenant_webhook_deliveries")
          .update({
            status: "failed",
            attempts,
            next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
            response_status: post.status,
            error_detail: (post.error ?? "unknown error").slice(0, 2000),
          })
          .eq("id", raw.id)
        await svc
          .from("tenant_webhook_subscriptions")
          .update({ last_failure_at: attemptedAt, updated_at: attemptedAt })
          .eq("id", sub.id)
        result.retried += 1
        // Per-delivery failure onto the self-heal ledger (flow 'webhook_delivery') —
        // the repair digest ranks endpoints that fail weekly as root causes.
        await ledgerWebhookDeliveryFailure(svc, {
          brokerageId: raw.brokerage_id ?? null, subscriptionId: sub.id, deliveryId: raw.id,
          event: raw.event_type, attempts, responseStatus: post.status, error: post.error, dead: false,
        })
      }
    } catch (e: unknown) {
      result.errors.push(`${raw.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}
