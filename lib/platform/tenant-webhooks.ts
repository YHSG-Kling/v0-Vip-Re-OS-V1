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
// WAVE 137B (extended on this survivor — no second rail): every attempt carries the
// deterministic X-Webhook-Idempotency-Key and lands on the row's attempt_log; the
// backoff rungs are jittered; during a secret-rotation overlap the signature header
// carries BOTH secrets' v1; a subscription whose deliveries keep going dead with no
// success in the quiet window is AUTO-DISABLED (withActionLedger evidence row +
// emitKernelEvent WEBHOOK_SUBSCRIPTION_AUTO_DISABLED + notifyBrokerageAdmins). The
// m736 columns (consecutive_failures, previous_secret*, disabled_*, attempt_log) are
// read and written in SEPARATE, error-read queries, so the rail keeps delivering
// (degraded: single-secret, no attempt log, no auto-disable) before m736 is applied.
//
// Cursor design: a subscription's cursor is the occurred_at of its most
// recently ENQUEUED delivery (deliveries are inserted in ledger order, so the
// latest row's payload.occurred_at is the high-water mark), falling back to
// the subscription's own created_at — new endpoints start from "now", they are
// never flooded with history.

import "server-only"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

import { createServiceClient } from "@/lib/supabase/service"
import {
  MAX_DELIVERY_ATTEMPTS,
  WEBHOOK_AUTO_DISABLE_CONSECUTIVE_DEAD,
  WebhookLedgerRow,
  WebhookPayload,
  activeWebhookSecrets,
  appendWebhookAttempt,
  buildWebhookPayload,
  externalEventsForLedgerRow,
  internalTypesForEvents,
  ledgerRowDeliverableTo,
  nextAttemptDelayMs,
  planWebhookEnqueue,
  shouldAutoDisableWebhook,
  signWebhookPayload,
  subscriptionMatchesEvent,
  webhookIdempotencyKey,
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

/**
 * POST a signed webhook payload. Real fetch, 5s timeout, honest error capture. `secret` may be
 * the rotation-overlap pair (new first); `idempotencyKey` rides X-Webhook-Idempotency-Key and is
 * the same on every attempt of one delivery.
 */
export async function postSignedWebhook(params: {
  url: string
  secret: string | readonly string[]
  event: string
  deliveryId: string
  payload: WebhookPayload
  idempotencyKey?: string
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
        "X-Webhook-Idempotency-Key": params.idempotencyKey ?? params.deliveryId,
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
  /** Candidates refused as duplicates of an already-enqueued (subscription, event, event id). */
  refusedDuplicates: number
  errors: string[]
}

/** Scan the lifecycle_events ledger per active subscription and stage pending deliveries. */
export async function enqueueTenantWebhookDeliveries(client?: Svc): Promise<EnqueueResult> {
  const svc = client ?? createServiceClient()
  const result: EnqueueResult = { subscriptions: 0, scanned: 0, enqueued: 0, refusedDuplicates: 0, errors: [] }

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
        // Defense in depth: the query is brokerage-pinned; a row of another tenant never stages.
        if (!ledgerRowDeliverableTo(sub, row)) continue
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
      // One idempotency key per (subscription, event, event id) — a duplicate enqueue is REFUSED.
      const existingKeys = new Set(
        ((existing ?? []) as Array<{ event_type: string; payload: WebhookPayload | null }>).map(
          (d) => webhookIdempotencyKey(sub.id, d.event_type, d.payload?.id ?? ""),
        ),
      )
      const plan = planWebhookEnqueue(sub.id, candidates, existingKeys)
      result.refusedDuplicates += plan.refused
      const nowIso = new Date().toISOString()
      const inserts = plan.accept.map((c) => ({
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
      if (insertError?.code === "23505") {
        // A concurrent enqueue won the race on m736's unique (subscription, event, payload id)
        // index — the batch was refused whole, so stage row by row and count each refusal.
        for (const row of inserts) {
          const { error: oneErr } = await svc.from("tenant_webhook_deliveries").insert(row)
          if (!oneErr) result.enqueued += 1
          else if (oneErr.code === "23505") result.refusedDuplicates += 1
          else result.errors.push(`${sub.id} insert: ${oneErr.message}`)
        }
        continue
      }
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
  autoDisabled: number
  errors: string[]
}

// ─── m736 sidecar state (read/written apart from the hot path) ───────────────

interface SubscriptionSidecar {
  previous_secret: string | null
  previous_secret_expires_at: string | null
  consecutive_failures: number
  last_success_at: string | null
  created_at: string | null
}

/**
 * The m736 columns for the subscriptions + deliveries one drain cycle touches. Read in their OWN
 * queries and error-read: before m736 is applied the select is refused, `available` is false and
 * the drain still delivers — single-secret, no attempt log, no auto-disable — never stops.
 */
async function loadWebhookSidecar(svc: Svc, subIds: string[], deliveryIds: string[]): Promise<{
  available: boolean
  subs: Map<string, SubscriptionSidecar>
  attemptLogs: Map<string, unknown>
  error: string | null
}> {
  const subs = new Map<string, SubscriptionSidecar>()
  const attemptLogs = new Map<string, unknown>()
  if (subIds.length === 0) return { available: true, subs, attemptLogs, error: null }
  const { data: subRows, error: subErr } = await svc
    .from("tenant_webhook_subscriptions")
    .select("id, previous_secret, previous_secret_expires_at, consecutive_failures, last_success_at, created_at")
    .in("id", subIds)
  if (subErr) return { available: false, subs, attemptLogs, error: `sidecar (m736 applied?): ${subErr.message}` }
  for (const r of (subRows ?? []) as Array<Record<string, unknown>>) {
    subs.set(String(r.id), {
      previous_secret: (r.previous_secret as string | null) ?? null,
      previous_secret_expires_at: (r.previous_secret_expires_at as string | null) ?? null,
      consecutive_failures: Number(r.consecutive_failures ?? 0),
      last_success_at: (r.last_success_at as string | null) ?? null,
      created_at: (r.created_at as string | null) ?? null,
    })
  }
  if (deliveryIds.length > 0) {
    const { data: logRows, error: logErr } = await svc
      .from("tenant_webhook_deliveries")
      .select("id, attempt_log")
      .in("id", deliveryIds)
    if (logErr) return { available: false, subs, attemptLogs, error: `attempt_log (m736 applied?): ${logErr.message}` }
    for (const r of (logRows ?? []) as Array<{ id: string; attempt_log: unknown }>) attemptLogs.set(r.id, r.attempt_log)
  }
  return { available: true, subs, attemptLogs, error: null }
}

/**
 * AUTO-DISABLE (wave 137B). Switch the subscription off — only while it is still active in THIS
 * tenant — under withActionLedger (the evidence row: actor data_steward, reason OS_HEALTH_RECOVERY
 * + the streak, keyed per tripping delivery so a re-drain never double-acts), then the audit event
 * on the canonical emitter and the tenant admins' in-app notification. Returns whether it disabled.
 */
async function autoDisableWebhookSubscription(svc: Svc, p: {
  brokerageId: string
  subscriptionId: string
  deliveryId: string
  url: string
  consecutiveDead: number
  lastSuccessAt: string | null
}): Promise<boolean> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const atIso = new Date().toISOString()
  const reason = `${p.consecutiveDead} consecutive dead deliveries (threshold ${WEBHOOK_AUTO_DISABLE_CONSECUTIVE_DEAD}), last success ${p.lastSuccessAt ?? "never"}`
  const outcome = await withActionLedger(
    {
      brokerageId: p.brokerageId,
      action: "webhook.subscription.auto_disable",
      actor: { type: "manager", managerKey: "data_steward" },
      subject: { type: "tenant_webhook_subscription", id: p.subscriptionId },
      reasonCode: "OS_HEALTH_RECOVERY",
      reasonDetail: reason,
      idempotencyKey: `webhook_auto_disable:${p.deliveryId}`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "tenant-webhooks",
      detail: { url: p.url, consecutive_dead: p.consecutiveDead, last_success_at: p.lastSuccessAt, tripped_by_delivery: p.deliveryId },
    },
    async () => {
      const { data, error } = await svc
        .from("tenant_webhook_subscriptions")
        .update({ active: false, updated_at: atIso })
        .eq("id", p.subscriptionId)
        .eq("brokerage_id", p.brokerageId)
        .eq("active", true)
        .select("id")
      return { disabled: !error && (data ?? []).length > 0, error: error?.message ?? null }
    },
    {
      settle: (r) => ({ status: r.disabled ? "executed" : "failed", outcome: r.disabled ? "auto_disabled" : "not_disabled", error: r.error }),
      replay: () => ({ disabled: false, error: "replay" }),
    },
    { client: svc },
  )
  if (!outcome.disabled) return false

  // m736 stamp — its own error-read write, so a missing column never undoes the disable above.
  const { error: stampErr } = await svc
    .from("tenant_webhook_subscriptions")
    .update({ disabled_at: atIso, disabled_reason: `auto: ${reason}`.slice(0, 500) })
    .eq("id", p.subscriptionId)
    .eq("brokerage_id", p.brokerageId)
  if (stampErr) console.error(`[tenant-webhooks] auto-disable stamp NOT saved (m736 applied?): ${stampErr.message}`)

  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const { KernelEvent } = await import("@/lib/kernel/events")
    const ev = await emitKernelEvent({
      event: KernelEvent.WEBHOOK_SUBSCRIPTION_AUTO_DISABLED,
      brokerageId: p.brokerageId,
      entityType: "tenant_webhook_subscription",
      entityId: p.subscriptionId,
      metadata: { consecutive_dead: p.consecutiveDead, last_success_at: p.lastSuccessAt, tripped_by_delivery: p.deliveryId },
      source: "cron",
      auditOnly: true,
      client: svc,
    })
    if (ev.error) console.error(`[tenant-webhooks] auto-disable event NOT recorded: ${ev.error}`)
  } catch (e) { console.error("[tenant-webhooks] auto-disable event threw:", e instanceof Error ? e.message : e) }

  try {
    const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
    const notified = await notifyBrokerageAdmins(svc as never, p.brokerageId, {
      type: "webhook_subscription_auto_disabled",
      title: "Webhook endpoint switched off",
      body: `Outbound webhook ${p.url} was switched off after ${reason}. Fix the endpoint, send a test ping from Settings → Developers, then Resume it.`,
      entityType: "tenant_webhook_subscription",
      entityId: p.subscriptionId,
      priority: "high",
    })
    if (notified === 0) console.error(`[tenant-webhooks] auto-disable reached NO tenant admin for ${p.brokerageId}`)
  } catch (e) { console.error("[tenant-webhooks] auto-disable notification threw:", e instanceof Error ? e.message : e) }
  return true
}

/** Seams the in-memory proof injects; production runs the defaults (real POST, real clock, Math.random). */
interface DrainDeps {
  post?: typeof postSignedWebhook
  random?: () => number
  nowMs?: () => number
}

/** POST due pending/failed deliveries; record honest outcomes + schedule retries. */
export async function drainTenantWebhookDeliveries(client?: Svc, deps: DrainDeps = {}): Promise<DrainResult> {
  const svc = client ?? createServiceClient()
  const postFn = deps.post ?? postSignedWebhook
  const random = deps.random ?? Math.random
  const nowMs = deps.nowMs ?? (() => Date.now())
  const result: DrainResult = { due: 0, delivered: 0, retried: 0, dead: 0, autoDisabled: 0, errors: [] }
  const nowIso = new Date(nowMs()).toISOString()

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

  const due = (dueRows ?? []) as unknown as DueDeliveryRow[]
  const sidecar = await loadWebhookSidecar(svc, Array.from(new Set(due.map((d) => d.subscription_id))), due.map((d) => d.id))
  if (sidecar.error) result.errors.push(sidecar.error)
  const disabledThisCycle = new Set<string>()

  /** Append this attempt to the row's attempt_log (m736) — its own error-read write. */
  const logAttempt = async (deliveryId: string, entry: Parameters<typeof appendWebhookAttempt>[1]) => {
    if (!sidecar.available) return
    const next = appendWebhookAttempt(sidecar.attemptLogs.get(deliveryId), entry)
    sidecar.attemptLogs.set(deliveryId, next)
    const { error } = await svc.from("tenant_webhook_deliveries").update({ attempt_log: next }).eq("id", deliveryId)
    if (error) console.error(`[tenant-webhooks] attempt_log NOT saved: ${error.message}`)
  }
  /** Move the subscription's consecutive-dead streak (m736) — its own error-read write. */
  const setStreak = async (subId: string, value: number) => {
    const side = sidecar.subs.get(subId)
    if (!sidecar.available || !side || side.consecutive_failures === value) return
    side.consecutive_failures = value
    const { error } = await svc.from("tenant_webhook_subscriptions").update({ consecutive_failures: value }).eq("id", subId)
    if (error) console.error(`[tenant-webhooks] consecutive_failures NOT saved: ${error.message}`)
  }

  for (const raw of due) {
    result.due += 1
    const sub = raw.tenant_webhook_subscriptions
    if (disabledThisCycle.has(sub.id)) continue // switched off earlier this cycle — stop POSTing to it
    const side = sidecar.subs.get(sub.id)
    const idempotencyKey = webhookIdempotencyKey(sub.id, raw.event_type, raw.payload?.id ?? raw.id)
    try {
      const post = await postFn({
        url: sub.url,
        // Rotation overlap: the new secret first, the previous one while its window is still open.
        secret: activeWebhookSecrets({ secret: sub.secret, ...(side ?? {}) }, nowMs()),
        event: raw.event_type,
        deliveryId: raw.id,
        payload: raw.payload,
        idempotencyKey,
      })
      const attemptedAt = new Date(nowMs()).toISOString()
      const attempts = (raw.attempts ?? 0) + 1
      const attemptEntry = {
        attempt: attempts, at: attemptedAt, http_status: post.status, duration_ms: post.durationMs,
        error: post.error, idempotency_key: idempotencyKey,
      }

      if (post.ok) {
        const { error: deliveredErr } = await svc
          .from("tenant_webhook_deliveries")
          .update({ status: "delivered", delivered_at: attemptedAt, response_status: post.status, error_detail: null })
          .eq("id", raw.id)
        if (deliveredErr) console.error(`[tenant-webhooks] delivered webhook NOT marked delivered (it may be re-sent): ${deliveredErr.message}`)
        await sentinelWrite(svc, svc
          .from("tenant_webhook_subscriptions")
          .update({ last_success_at: attemptedAt, updated_at: attemptedAt })
          .eq("id", sub.id), { table: "tenant_webhook_subscriptions", flow: "tenant_webhook_subscriptions_write", reason: "subscription health stamp" })
        await logAttempt(raw.id, { ...attemptEntry, outcome: "delivered" })
        if (side) side.last_success_at = attemptedAt
        await setStreak(sub.id, 0) // a 2xx ends the streak
        result.delivered += 1
        continue
      }

      const delayMs = nextAttemptDelayMs(attempts, random)
      if (delayMs === null) {
        // MAX_DELIVERY_ATTEMPTS reached — the row is dead; the subscription wears it.
        const { error: deadErr } = await svc
          .from("tenant_webhook_deliveries")
          .update({
            status: "dead",
            attempts,
            response_status: post.status,
            error_detail: `dead after ${MAX_DELIVERY_ATTEMPTS} attempts — ${post.error ?? "unknown error"}`.slice(0, 2000),
          })
          .eq("id", raw.id)
        if (deadErr) console.error(`[tenant-webhooks] dead delivery NOT marked dead (it may be retried): ${deadErr.message}`)
        await sentinelWrite(svc, svc
          .from("tenant_webhook_subscriptions")
          .update({ failure_count: (sub.failure_count ?? 0) + 1, last_failure_at: attemptedAt, updated_at: attemptedAt })
          .eq("id", sub.id), { table: "tenant_webhook_subscriptions", flow: "tenant_webhook_subscriptions_write", reason: "subscription failure counter" })
        sub.failure_count = (sub.failure_count ?? 0) + 1
        await logAttempt(raw.id, { ...attemptEntry, outcome: "dead" })
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
            event: raw.event_type, failureCount: sub.failure_count,
            responseStatus: post.status, error: post.error,
          })
        }
        // Consecutive-dead streak → AUTO-DISABLE when it crosses the threshold with no success
        // in the quiet window (m736; skipped — never guessed — when the sidecar is unavailable).
        if (side && raw.brokerage_id) {
          const streak = side.consecutive_failures + 1
          await setStreak(sub.id, streak)
          if (shouldAutoDisableWebhook({ consecutiveDead: streak, lastSuccessAt: side.last_success_at, createdAt: side.created_at, nowMs: nowMs() })) {
            const disabled = await autoDisableWebhookSubscription(svc, {
              brokerageId: raw.brokerage_id, subscriptionId: sub.id, deliveryId: raw.id,
              url: sub.url, consecutiveDead: streak, lastSuccessAt: side.last_success_at,
            })
            if (disabled) { disabledThisCycle.add(sub.id); result.autoDisabled += 1 }
          }
        }
      } else {
        const { error: retryErr } = await svc
          .from("tenant_webhook_deliveries")
          .update({
            status: "failed",
            attempts,
            next_attempt_at: new Date(nowMs() + delayMs).toISOString(),
            response_status: post.status,
            error_detail: (post.error ?? "unknown error").slice(0, 2000),
          })
          .eq("id", raw.id)
        if (retryErr) console.error(`[tenant-webhooks] retry schedule NOT saved on the delivery: ${retryErr.message}`)
        await sentinelWrite(svc, svc
          .from("tenant_webhook_subscriptions")
          .update({ last_failure_at: attemptedAt, updated_at: attemptedAt })
          .eq("id", sub.id), { table: "tenant_webhook_subscriptions", flow: "tenant_webhook_subscriptions_write", reason: "subscription health stamp" })
        await logAttempt(raw.id, { ...attemptEntry, outcome: "failed" })
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
