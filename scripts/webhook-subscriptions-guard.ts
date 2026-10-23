/**
 * scripts/webhook-subscriptions-guard.ts — test:webhook-subscriptions (wave 137B).
 *
 * TENANT WEBHOOK / EVENT SUBSCRIPTIONS, proven in memory (no network, no database). The survivor is
 * lib/platform/tenant-webhooks-core.ts (pure) + lib/platform/tenant-webhooks.ts (enqueue + drain) +
 * app/actions/tenant-webhooks.ts (the tenant-admin door); this proof drives the REAL enqueue and
 * drain over an in-memory supabase stand-in with an injected POST that records every request.
 *
 *   A. SIGNATURE   — HMAC-SHA256 over `${t}.${body}` verifies; a tampered body, an old timestamp
 *                    (outside the replay window) and a wrong secret fail (positive control inside).
 *   B. IDEMPOTENCY — one deterministic key per (subscription, event, event id); a duplicate enqueue
 *                    is REFUSED; every retry of a delivery carries the SAME key on the wire.
 *   C. RETRY       — exponential ladder + ±20% jitter, bounded, null (dead) at the max (control below).
 *   D. AUTO-DISABLE— N consecutive dead deliveries + no success in the quiet window → switched off with
 *                    an evidence row (agent_action_ledger), a kernel event (lifecycle_events) and a
 *                    tenant-admin notification; below N (positive control) it stays on.
 *   E. ROTATION    — during the overlap old AND new both verify; after it only new does.
 *   F. CROSS-TENANT— an event of tenant B never stages for / delivers to tenant A's subscription.
 *   G. PROJECTION  — an internal-only field (listing.created's agent_id) never appears in a delivered
 *                    body (positive control: it IS on the internal event; an allowed field DOES pass).
 *   H. CATALOGUE   — every internal type is a CURRENT canonical name (KernelEvent value or a
 *                    transitionLifecycle `lifecycle.*` row); filters accept only catalogue events.
 *   I. WIRING      — stripped-source checks: the drain, the door, the inbound trigger, the UI, m736,
 *                    the MAINTENANCE_DOMAINS entry and the guard-chain membership.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  WEBHOOK_EVENT_CATALOG, WEBHOOK_AUTO_DISABLE_CONSECUTIVE_DEAD, WEBHOOK_SECRET_ROTATION_OVERLAP_MS, MAX_DELIVERY_ATTEMPTS,
  signWebhookPayload, verifyWebhookSignature, webhookIdempotencyKey, planWebhookEnqueue, nextAttemptDelayMs,
  shouldAutoDisableWebhook, activeWebhookSecrets, ledgerRowDeliverableTo, buildWebhookPayload,
  validateWebhookEventFilter, appendWebhookAttempt, type WebhookLedgerRow,
} from "../lib/platform/tenant-webhooks-core"
import { enqueueTenantWebhookDeliveries, drainTenantWebhookDeliveries } from "../lib/platform/tenant-webhooks"
import { KernelEvent } from "../lib/kernel/events"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const root = process.cwd()
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(read(p))

// ── in-memory supabase-js stand-in (records every query; resolves embeds + json paths) ─────────
type Row = Record<string, any>
function fakeClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  let idSeq = 0
  const get = (r: Row, col: string): unknown => {
    if (col.includes("->>")) { const [a, b] = col.split("->>"); return r[a]?.[b] }
    if (col.includes(".")) { const [a, b] = col.split("."); return r[a]?.[b] }
    return r[col]
  }
  const from = (table: string) => {
    const filters: Array<[string, string, unknown]> = []
    let mode: "select" | "insert" | "update" | "delete" = "select"
    let payload: any = null, single: "one" | "maybe" | null = null, limitN: number | null = null, returning = false, cols = ""
    const match = (r: Row) => filters.every(([op, col, v]) => {
      const x = get(r, col)
      switch (op) {
        case "eq": return x === v
        case "in": return (v as unknown[]).includes(x)
        case "gt": return x != null && String(x) > String(v)
        case "gte": return x != null && String(x) >= String(v)
        case "lte": return x != null && String(x) <= String(v)
        default: return true
      }
    })
    const embed = (r: Row): Row => {
      if (table === "tenant_webhook_deliveries" && cols.includes("tenant_webhook_subscriptions!inner")) {
        return { ...r, tenant_webhook_subscriptions: (tables.tenant_webhook_subscriptions ?? []).find((s) => s.id === r.subscription_id) }
      }
      return r
    }
    const run = () => {
      const t = (tables[table] ??= [])
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: r.id ?? `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`, created_at: r.created_at ?? new Date().toISOString(), ...r }))
        t.push(...rows)
        return { data: returning ? (single ? rows[0] : rows) : null, error: null }
      }
      const hit = t.filter((r) => match(embed(r)))
      if (mode === "update") { hit.forEach((r) => Object.assign(r, payload)); return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null } }
      if (mode === "delete") { tables[table] = t.filter((r) => !hit.includes(r)); return { data: returning ? hit : null, error: null } }
      let out = t.map(embed).filter(match)
      if (limitN != null) out = out.slice(0, limitN)
      if (single) return { data: out[0] ?? null, error: single === "one" && !out[0] ? { message: "no rows" } : null }
      return { data: out, error: null }
    }
    const b: any = {
      select: (c?: string) => { if (mode !== "select") returning = true; else cols = c ?? ""; return b },
      insert: (p: any) => { mode = "insert"; payload = p; return b },
      update: (p: any) => { mode = "update"; payload = p; return b },
      upsert: (p: any) => { mode = "insert"; payload = p; return b },
      delete: () => { mode = "delete"; return b },
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return b },
      in: (c: string, v: unknown[]) => { filters.push(["in", c, v]); return b },
      gt: (c: string, v: unknown) => { filters.push(["gt", c, v]); return b },
      gte: (c: string, v: unknown) => { filters.push(["gte", c, v]); return b },
      lte: (c: string, v: unknown) => { filters.push(["lte", c, v]); return b },
      neq: () => b, is: () => b, lt: () => b, like: () => b, not: () => b, or: () => b, contains: () => b,
      order: () => b,
      limit: (n: number) => { limitN = n; return b },
      maybeSingle: () => { single = "maybe"; return b },
      single: () => { single = "one"; return b },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from, rpc: async () => ({ data: null, error: null }), tables: () => tables }
}

/** An injected POST that records each request and answers with the scripted status. */
function recorder(status: number) {
  const sent: Array<{ url: string; secret: string | readonly string[]; idempotencyKey?: string; body: string; header: string }> = []
  const post = async (p: { url: string; secret: string | readonly string[]; event: string; deliveryId: string; payload: any; idempotencyKey?: string }) => {
    const body = JSON.stringify(p.payload)
    sent.push({ url: p.url, secret: p.secret, idempotencyKey: p.idempotencyKey, body, header: signWebhookPayload(p.secret, body, Math.floor(Date.now() / 1000)) })
    return status >= 200 && status < 300
      ? { ok: true, status, error: null, durationMs: 3 }
      : { ok: false, status, error: `HTTP ${status}`, durationMs: 3 }
  }
  return { post, sent }
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SUB_A = "a0000000-0000-4000-8000-00000000000a"
const SUB_B = "b0000000-0000-4000-8000-00000000000b"
const hAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

async function main() {
  // ── A. SIGNATURE ─────────────────────────────────────────────────────────────────────────────
  console.log("\n[A · HMAC-SHA256 signature + replay window]")
  const body = JSON.stringify({ id: "e1", event: "lead.captured", data: { source: "qr" } })
  const t = 1_800_000_000
  const header = signWebhookPayload("whsec_test_secret", body, t)
  check("header grammar is t=<unix>,v1=<64 hex>", /^t=\d+,v1=[0-9a-f]{64}$/.test(header), header)
  check("POSITIVE CONTROL: the untouched body inside the window verifies", verifyWebhookSignature("whsec_test_secret", body, header, { nowSec: t + 10 }))
  check("a TAMPERED body fails", !verifyWebhookSignature("whsec_test_secret", body.replace("qr", "QR"), header, { nowSec: t + 10 }))
  check("an OLD timestamp (outside the 300s replay window) fails", !verifyWebhookSignature("whsec_test_secret", body, header, { nowSec: t + 301 }))
  check("a FUTURE timestamp outside the window fails too", !verifyWebhookSignature("whsec_test_secret", body, header, { nowSec: t - 301 }))
  check("a WRONG secret fails", !verifyWebhookSignature("whsec_other", body, header, { nowSec: t + 10 }))
  check("a missing / malformed header fails", !verifyWebhookSignature("whsec_test_secret", body, null) && !verifyWebhookSignature("whsec_test_secret", body, `t=${t},v1=zz`, { nowSec: t }))

  // ── B. IDEMPOTENCY ───────────────────────────────────────────────────────────────────────────
  console.log("\n[B · idempotency key per (subscription, event id)]")
  const k1 = webhookIdempotencyKey(SUB_A, "lead.captured", "ev-1")
  check("the key is deterministic (same inputs → same key)", k1 === webhookIdempotencyKey(SUB_A, "lead.captured", "ev-1"))
  check("POSITIVE CONTROL: another subscription / event id → another key",
    k1 !== webhookIdempotencyKey(SUB_B, "lead.captured", "ev-1") && k1 !== webhookIdempotencyKey(SUB_A, "lead.captured", "ev-2"))
  const cands = [{ event: "lead.captured", payload: { id: "ev-1" } }, { event: "lead.captured", payload: { id: "ev-2" } }, { event: "lead.captured", payload: { id: "ev-2" } }]
  const plan = planWebhookEnqueue(SUB_A, cands, new Set([k1]))
  check("a candidate whose key is already enqueued is REFUSED, and an in-batch repeat is REFUSED",
    plan.refused === 2 && plan.accept.length === 1 && plan.accept[0].payload.id === "ev-2", JSON.stringify({ refused: plan.refused, accept: plan.accept.map((a) => a.payload.id) }))

  // ── B/F/G end to end over the REAL enqueue ─────────────────────────────────────────────────
  console.log("\n[B·F·G · the real enqueue: duplicate refused, tenant-pinned, projected]")
  const lifecycle: Row[] = [
    { id: "ev-a1", brokerage_id: A, entity_type: "listing", entity_id: "L-a", event_type: KernelEvent.LISTING_CREATED, metadata: { stage: "LISTING_AGREEMENT_INITIATED", agent_id: "AGENT-SECRET-ID-a", nested: { email: "x@y.z" } }, created_at: hAgo(1) },
    { id: "ev-a2", brokerage_id: A, entity_type: "lead", entity_id: "lead-a", event_type: KernelEvent.LEAD_CAPTURED, metadata: { source: "qr", email: "lead@private.test", phone: "+15555550100" }, created_at: hAgo(0.9) },
    { id: "ev-b1", brokerage_id: B, entity_type: "listing", entity_id: "L-b", event_type: KernelEvent.LISTING_CREATED, metadata: { stage: "LISTING_AGREEMENT_INITIATED", agent_id: "AGENT-B" }, created_at: hAgo(1) },
  ]
  const enqSvc = fakeClient({
    tenant_webhook_subscriptions: [
      { id: SUB_A, brokerage_id: A, url: "https://a.example/hook", secret: "whsec_A", events: ["listing.created", "lead.captured"], active: true, created_at: hAgo(48), failure_count: 0 },
      { id: SUB_B, brokerage_id: B, url: "https://b.example/hook", secret: "whsec_B", events: ["listing.created"], active: true, created_at: hAgo(48), failure_count: 0 },
    ],
    // ev-a2 is ALREADY enqueued for SUB_A (an earlier cycle) — its payload carries an older occurred_at so
    // the cursor still re-scans it: the duplicate must be refused by the key, not by luck of the cursor.
    tenant_webhook_deliveries: [
      { id: "d-old", subscription_id: SUB_A, brokerage_id: A, event_type: "lead.captured", status: "delivered", attempts: 1, created_at: hAgo(2), payload: { id: "ev-a2", event: "lead.captured", occurred_at: hAgo(3) } },
    ],
    lifecycle_events: lifecycle,
  })
  const enq = await enqueueTenantWebhookDeliveries(enqSvc as any)
  const staged = enqSvc.tables().tenant_webhook_deliveries.filter((d) => d.id !== "d-old")
  const stagedA = staged.filter((d) => d.subscription_id === SUB_A)
  const stagedB = staged.filter((d) => d.subscription_id === SUB_B)
  check("the duplicate (SUB_A, lead.captured, ev-a2) is REFUSED, never staged twice",
    enq.refusedDuplicates === 1 && staged.filter((d) => d.payload?.id === "ev-a2").length === 0, JSON.stringify(enq))
  check("CROSS-TENANT: nothing of tenant B stages for tenant A's subscription", stagedA.every((d) => d.brokerage_id === A && String(d.payload?.id).startsWith("ev-a")) && !stagedA.some((d) => d.payload?.id === "ev-b1"))
  check("POSITIVE CONTROL: tenant B's own event DOES stage for tenant B", stagedB.length === 1 && stagedB[0].payload?.id === "ev-b1")
  check("CROSS-TENANT (pure, defense in depth): a tenant-B row is not deliverable to A; a tenantless row to nobody",
    !ledgerRowDeliverableTo({ brokerage_id: A }, lifecycle[2] as WebhookLedgerRow)
      && ledgerRowDeliverableTo({ brokerage_id: A }, lifecycle[0] as WebhookLedgerRow)
      && !ledgerRowDeliverableTo({ brokerage_id: A }, { ...(lifecycle[0] as WebhookLedgerRow), brokerage_id: null }))

  // ── G. PROJECTION ──────────────────────────────────────────────────────────────────────────
  console.log("\n[G · allow-list projection — internal fields never leave]")
  check("POSITIVE CONTROL: agent_id IS on the internal listing_created event", lifecycle[0].metadata.agent_id === "AGENT-SECRET-ID-a")
  const listingPayload = stagedA.find((d) => d.payload?.id === "ev-a1")?.payload
  check("the staged listing.created payload carries the ALLOWED field (stage)", listingPayload?.data?.stage === "LISTING_AGREEMENT_INITIATED", JSON.stringify(listingPayload?.data))
  check("...and NOT agent_id, NOT a nested object", listingPayload && !("agent_id" in listingPayload.data) && !("nested" in listingPayload.data))
  const leadPayload = buildWebhookPayload("lead.captured", lifecycle[1] as WebhookLedgerRow)
  check("PII on a lead event (email, phone) is not projected; source is", leadPayload.data.source === "qr" && !("email" in leadPayload.data) && !("phone" in leadPayload.data))
  check("an event with no catalogue entry projects to {} (fail closed, never raw metadata)",
    Object.keys(buildWebhookPayload("not.an.event", lifecycle[0] as WebhookLedgerRow).data).length === 0)

  // ── C/E/G end to end over the REAL drain ───────────────────────────────────────────────────
  console.log("\n[C·E·G · the real drain: retry with jitter, same key on retry, rotation overlap, body has no internal field]")
  const rotatedAt = Date.now() - 3600_000
  const drainSeed = {
    tenant_webhook_subscriptions: [
      { id: SUB_A, brokerage_id: A, url: "https://a.example/hook", secret: "whsec_NEW", previous_secret: "whsec_OLD",
        previous_secret_expires_at: new Date(rotatedAt + WEBHOOK_SECRET_ROTATION_OVERLAP_MS).toISOString(),
        events: ["listing.created"], active: true, created_at: hAgo(72), failure_count: 0, consecutive_failures: 0, last_success_at: hAgo(1) },
    ],
    tenant_webhook_deliveries: [
      { id: "d-1", subscription_id: SUB_A, brokerage_id: A, event_type: "listing.created", status: "pending", attempts: 0, next_attempt_at: hAgo(0.1), created_at: hAgo(0.2), attempt_log: [], payload: listingPayload },
    ],
  }
  const svcC = fakeClient(drainSeed)
  const fail = recorder(503)
  const r1 = await drainTenantWebhookDeliveries(svcC as any, { post: fail.post as any, random: () => 0.5 })
  const d1 = svcC.tables().tenant_webhook_deliveries[0]
  const wait1 = Date.parse(d1.next_attempt_at) - Date.now()
  check("a failed attempt is RETRIED (status failed, attempts 1) on the first rung (~1m, jitter-centred)",
    r1.retried === 1 && d1.status === "failed" && d1.attempts === 1 && wait1 > 55_000 && wait1 <= 61_000, `wait=${wait1}`)
  check("the attempt landed on the per-attempt ledger (attempt_log)", Array.isArray(d1.attempt_log) && d1.attempt_log.length === 1 && d1.attempt_log[0].outcome === "failed" && d1.attempt_log[0].http_status === 503)
  d1.next_attempt_at = hAgo(0.01)
  await drainTenantWebhookDeliveries(svcC as any, { post: fail.post as any, random: () => 0.5 })
  check("a REDELIVERY carries the SAME idempotency key as the first attempt",
    fail.sent.length === 2 && !!fail.sent[0].idempotencyKey && fail.sent[0].idempotencyKey === fail.sent[1].idempotencyKey
      && fail.sent[0].idempotencyKey === webhookIdempotencyKey(SUB_A, "listing.created", "ev-a1"))
  check("ROTATION OVERLAP on the wire: the drain signs with [new, old]", Array.isArray(fail.sent[0].secret) && (fail.sent[0].secret as string[]).join(",") === "whsec_NEW,whsec_OLD")
  const wireT = Number(fail.sent[0].header.slice(2, fail.sent[0].header.indexOf(",")))
  check("...a receiver holding ONLY the old secret verifies the delivered body", verifyWebhookSignature("whsec_OLD", fail.sent[0].body, fail.sent[0].header, { nowSec: wireT }))
  check("...and one holding ONLY the new secret verifies it too", verifyWebhookSignature("whsec_NEW", fail.sent[0].body, fail.sent[0].header, { nowSec: wireT }))
  check("G on the wire: the DELIVERED body never contains the internal agent_id", !fail.sent.some((s) => s.body.includes("AGENT-SECRET-ID-a") || s.body.includes("agent_id")))
  check("G POSITIVE CONTROL: the delivered body DOES contain the allowed field", fail.sent[0].body.includes("LISTING_AGREEMENT_INITIATED"))

  // ── C. RETRY schedule (pure) ───────────────────────────────────────────────────────────────
  console.log("\n[C · backoff schedule + jitter + max]")
  const rungs = [1, 2, 3, 4].map((n) => nextAttemptDelayMs(n, () => 0.5) as number)
  check("the base ladder is exponential-ish and strictly increasing (1m → 5m → 30m → 2h)", rungs.join(",") === "60000,300000,1800000,7200000", rungs.join(","))
  const lo = nextAttemptDelayMs(1, () => 0) as number, hi = nextAttemptDelayMs(1, () => 1) as number
  check("jitter bounds the first rung to [48s, 72s] (±20%)", lo === 48_000 && hi === 72_000, `${lo}/${hi}`)
  check("jitter actually varies the delay (two draws differ)", nextAttemptDelayMs(2, () => 0.1) !== nextAttemptDelayMs(2, () => 0.9))
  check(`the ${MAX_DELIVERY_ATTEMPTS}th failure is DEAD (no further retry)`, nextAttemptDelayMs(MAX_DELIVERY_ATTEMPTS) === null)
  check("POSITIVE CONTROL: one below the max still retries", nextAttemptDelayMs(MAX_DELIVERY_ATTEMPTS - 1) !== null)
  check("the attempt log is capped (newest kept)", appendWebhookAttempt(Array.from({ length: 25 }, (_, i) => ({ attempt: i } as any)), { attempt: 99, at: "", outcome: "failed", http_status: 500, duration_ms: 1, error: "x", idempotency_key: "k" }).at(-1)?.attempt === 99
    && appendWebhookAttempt(Array.from({ length: 25 }, () => ({} as any)), { attempt: 1, at: "", outcome: "failed", http_status: 500, duration_ms: 1, error: null, idempotency_key: "k" }).length === 20)

  // ── D. AUTO-DISABLE ────────────────────────────────────────────────────────────────────────
  console.log("\n[D · auto-disable after N consecutive dead deliveries]")
  const N = WEBHOOK_AUTO_DISABLE_CONSECUTIVE_DEAD
  check(`POSITIVE CONTROL (pure): ${N - 1} consecutive dead → stays on`, !shouldAutoDisableWebhook({ consecutiveDead: N - 1, lastSuccessAt: null, createdAt: hAgo(72), nowMs: Date.now() }))
  check(`${N} consecutive dead but a success 2h ago → stays on (quiet window)`, !shouldAutoDisableWebhook({ consecutiveDead: N, lastSuccessAt: hAgo(2), createdAt: hAgo(72), nowMs: Date.now() }))
  check(`${N} consecutive dead and no success for 25h → disable`, shouldAutoDisableWebhook({ consecutiveDead: N, lastSuccessAt: hAgo(25), createdAt: hAgo(72), nowMs: Date.now() }))
  const dSeed = (streak: number) => ({
    users: [{ id: "u-admin-a", brokerage_id: A, user_type: "broker" }, { id: "u-admin-b", brokerage_id: B, user_type: "broker" }],
    tenant_webhook_subscriptions: [
      { id: SUB_A, brokerage_id: A, url: "https://a.example/hook", secret: "whsec_A", events: ["listing.created"], active: true,
        created_at: hAgo(72), failure_count: streak, consecutive_failures: streak, last_success_at: null },
    ],
    tenant_webhook_deliveries: [
      { id: `d-dead-${streak}`, subscription_id: SUB_A, brokerage_id: A, event_type: "listing.created", status: "failed", attempts: MAX_DELIVERY_ATTEMPTS - 1,
        next_attempt_at: hAgo(0.1), created_at: hAgo(3), attempt_log: [], payload: listingPayload },
    ],
    agent_action_ledger: [], lifecycle_events: [], notifications: [],
  })
  const svcD = fakeClient(dSeed(N - 1))
  const rD = await drainTenantWebhookDeliveries(svcD as any, { post: recorder(500).post as any })
  const subD = svcD.tables().tenant_webhook_subscriptions[0]
  check(`the ${N}th consecutive dead delivery AUTO-DISABLES the subscription`, rD.dead === 1 && rD.autoDisabled === 1 && subD.active === false && subD.consecutive_failures === N, JSON.stringify({ rD, active: subD.active, streak: subD.consecutive_failures }))
  check("...with an EVIDENCE row (agent_action_ledger, executed, OS_HEALTH_RECOVERY)",
    svcD.tables().agent_action_ledger.some((l) => l.action === "webhook.subscription.auto_disable" && l.status === "executed" && l.reason_code === "OS_HEALTH_RECOVERY" && l.brokerage_id === A),
    JSON.stringify(svcD.tables().agent_action_ledger.map((l) => ({ a: l.action, s: l.status, r: l.reason_code }))))
  check("...a KERNEL EVENT (lifecycle_events webhook_subscription_auto_disabled, tenant A)",
    svcD.tables().lifecycle_events.some((e) => e.event_type === KernelEvent.WEBHOOK_SUBSCRIPTION_AUTO_DISABLED && e.brokerage_id === A && e.entity_id === SUB_A))
  check("...and a TENANT-ADMIN notification (tenant A's admin only)",
    svcD.tables().notifications.some((n) => n.user_id === "u-admin-a" && n.type === "webhook_subscription_auto_disabled") && !svcD.tables().notifications.some((n) => n.user_id === "u-admin-b"))
  check("...stamped with the reason (m736 disabled_reason)", String(subD.disabled_reason ?? "").startsWith("auto:"))
  const svcD2 = fakeClient(dSeed(N - 3))
  const rD2 = await drainTenantWebhookDeliveries(svcD2 as any, { post: recorder(500).post as any })
  check(`POSITIVE CONTROL (end to end): a streak below ${N} goes dead but stays ON, no evidence row`,
    rD2.dead === 1 && rD2.autoDisabled === 0 && svcD2.tables().tenant_webhook_subscriptions[0].active === true && svcD2.tables().agent_action_ledger.length === 0)
  const svcD3 = fakeClient(dSeed(N - 1))
  svcD3.tables().tenant_webhook_deliveries[0].status = "failed"
  await drainTenantWebhookDeliveries(svcD3 as any, { post: recorder(200).post as any })
  check("a 2xx RESETS the streak to 0", svcD3.tables().tenant_webhook_subscriptions[0].consecutive_failures === 0 && svcD3.tables().tenant_webhook_subscriptions[0].active === true)

  // ── E. ROTATION overlap (pure) ─────────────────────────────────────────────────────────────
  console.log("\n[E · secret rotation overlap]")
  const now = Date.now()
  const inWindow = { secret: "whsec_NEW", previous_secret: "whsec_OLD", previous_secret_expires_at: new Date(now + 3600_000).toISOString() }
  const expired = { ...inWindow, previous_secret_expires_at: new Date(now - 1000).toISOString() }
  check("inside the overlap both secrets are live (new first)", activeWebhookSecrets(inWindow, now).join(",") === "whsec_NEW,whsec_OLD")
  check("after the overlap only the new secret is live", activeWebhookSecrets(expired, now).join(",") === "whsec_NEW")
  const ts = Math.floor(now / 1000)
  const dual = signWebhookPayload(activeWebhookSecrets(inWindow, now), body, ts)
  const single = signWebhookPayload(activeWebhookSecrets(expired, now), body, ts)
  check("during the overlap OLD verifies and NEW verifies", verifyWebhookSignature("whsec_OLD", body, dual, { nowSec: ts }) && verifyWebhookSignature("whsec_NEW", body, dual, { nowSec: ts }))
  check("after the overlap OLD no longer verifies (NEW still does)", !verifyWebhookSignature("whsec_OLD", body, single, { nowSec: ts }) && verifyWebhookSignature("whsec_NEW", body, single, { nowSec: ts }))
  check("a receiver holding BOTH secrets verifies either header", verifyWebhookSignature(["whsec_NEW", "whsec_OLD"], body, single, { nowSec: ts }))

  // ── H. CATALOGUE ───────────────────────────────────────────────────────────────────────────
  console.log("\n[H · approved catalogue derived from CURRENT canonical names]")
  const canonical = new Set<string>(Object.values(KernelEvent))
  const bad = WEBHOOK_EVENT_CATALOG.flatMap((d) => (d.internalTypes as readonly string[]).filter((t) => !canonical.has(t) && !t.startsWith("lifecycle.")).map((t) => `${d.event}←${t}`))
  check(`every catalogue internal type is a KernelEvent value or a lifecycle.* transition row (${WEBHOOK_EVENT_CATALOG.length} events)`, bad.length === 0, bad.join(", "))
  check("POSITIVE CONTROL: the finder flags an invented name", !canonical.has("lead_capturd") && !"lead_capturd".startsWith("lifecycle."))
  check("every catalogue event declares an allow-list (payloadFields)", WEBHOOK_EVENT_CATALOG.every((d) => Array.isArray(d.payloadFields)))
  const PII = /email|phone|name|address|ssn|dob|agent_id|user_id|amount|price|commission|notes?$|reason/i
  const leaky = WEBHOOK_EVENT_CATALOG.flatMap((d) => d.payloadFields.filter((f) => PII.test(f)).map((f) => `${d.event}.${f}`))
  check("no allow-list names a PII / internal / financial-amount field", leaky.length === 0, leaky.join(", "))
  check("POSITIVE CONTROL: the PII pattern catches agent_id and email", PII.test("agent_id") && PII.test("contact_email"))
  check("a filter accepts catalogue events", validateWebhookEventFilter(["lead.captured", "deal.closed"]).ok)
  check("a filter REFUSES an internal kernel name, a wildcard, and an empty list",
    !validateWebhookEventFilter(["lead_captured"]).ok && !validateWebhookEventFilter(["*"]).ok && !validateWebhookEventFilter([]).ok)

  // ── I. WIRING (stripped source) ────────────────────────────────────────────────────────────
  console.log("\n[I · wiring]")
  const drainSrc = stripped("lib/platform/tenant-webhooks.ts")
  check("the drain signs with activeWebhookSecrets and sends X-Webhook-Idempotency-Key", /activeWebhookSecrets\(/.test(drainSrc) && /"X-Webhook-Idempotency-Key"/.test(drainSrc))
  check("the drain auto-disables through withActionLedger + emitKernelEvent + notifyBrokerageAdmins",
    /withActionLedger\(/.test(drainSrc) && /emitKernelEvent\(/.test(drainSrc) && /notifyBrokerageAdmins\(/.test(drainSrc) && /shouldAutoDisableWebhook\(/.test(drainSrc))
  check("the enqueue plans through planWebhookEnqueue and pins the tenant (ledgerRowDeliverableTo)", /planWebhookEnqueue\(/.test(drainSrc) && /ledgerRowDeliverableTo\(/.test(drainSrc))
  const actionsSrc = stripped("app/actions/tenant-webhooks.ts")
  check("the door exports rotateWebhookSecret, session-gated (principalGate) and ledgered",
    /export async function rotateWebhookSecret\(/.test(actionsSrc) && /rotateWebhookSecret[\s\S]{0,400}principalGate\(\)/.test(actionsSrc) && /webhook\.subscription\.rotate_secret/.test(actionsSrc))
  check("both filter doors run validateWebhookEventFilter (no inline second validator)", (actionsSrc.match(/validateWebhookEventFilter\(/g) ?? []).length >= 2 && !/isKnownWebhookEvent\(/.test(actionsSrc))
  check("POSITIVE CONTROL: the stripper keeps live code and drops a comment mention", /validateWebhookEventFilter\(/.test(stripComments("const x = validateWebhookEventFilter([])")) && !/rotateWebhookSecret\(/.test(stripComments("// rotateWebhookSecret(id)")))
  check("the developers UI wires Rotate secret", /rotateWebhookSecret/.test(stripped("app/settings/developers/developers-client.tsx")) && /Rotate secret/.test(read("app/settings/developers/developers-client.tsx")))
  check("the inbound trigger door honours the rotation overlap", /activeWebhookSecrets\(/.test(stripped("app/api/workflow/trigger/route.ts")))
  const mig = readdirSync(join(root, "supabase/migrations")).find((f) => /^m736-/.test(f))
  const migSrc = mig ? read(`supabase/migrations/${mig}`) : ""
  const cols = ["consecutive_failures", "previous_secret", "previous_secret_expires_at", "secret_rotated_at", "disabled_at", "disabled_reason", "attempt_log"]
  check("m736 declares every column the code writes + the unique idempotency index", !!mig && cols.every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`).test(migSrc)) && /CREATE UNIQUE INDEX[\s\S]*payload->>'id'/.test(migSrc))
  // The stamp is read as a RULE (either header form), never pinned to the waypoint — and the label names no
  // migration number beside the not-applied wording (migration-claim reads string literals as claims).
  const stampRe = new RegExp("^-- ── (WRITTEN, NOT " + "APPLIED|APPLIED LIVE \\d{4}-\\d{2}-\\d{2})")
  check("the webhook migration carries a stamp (the lane stamp | APPLIED LIVE <date>)", stampRe.test(migSrc))
  const dom = Object.values(MAINTENANCE_DOMAINS as Record<string, { proof?: string }>).find((d) => d.proof === "test:webhook-subscriptions")
  check("a MAINTENANCE_DOMAINS entry owns this proof", !!dom)
  const pkg = read("package.json")
  check("package.json registers test:webhook-subscriptions and the guard chain runs it",
    /"test:webhook-subscriptions":\s*"tsx [^"]*scripts\/webhook-subscriptions-guard\.ts"/.test(pkg) && new RegExp("npm run test:webhook-subscriptions(\\s|&|\")").test(pkg))

  console.log(`\n  denominators: ${WEBHOOK_EVENT_CATALOG.length} catalogue events · ${lifecycle.length} ledger rows (2 tenants) · ${cols.length} m736 columns · N=${N} · max attempts ${MAX_DELIVERY_ATTEMPTS}`)
  console.log("  blind spots: the fake client does not model the m736 unique index (the 23505 path is read, not driven); real HTTP is never sent (the POST is injected); pre-m736 degradation is asserted by code shape, not executed")
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
