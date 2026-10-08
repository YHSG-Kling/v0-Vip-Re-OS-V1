// lib/platform/tenant-webhooks-core.ts
//
// TENANT OUTBOUND WEBHOOKS — the PURE half. Everything here is deterministic and
// unit-testable: the event catalog (external event names ← the lifecycle_events
// ledger rows they fan out from), Stripe-style HMAC signing/verification, the
// retry backoff schedule, subscription event matching, and payload construction.
//
// SINGLE-TAP DESIGN: the OS already records every interesting moment in ONE
// place — the lifecycle_events ledger (written only through emitKernelEvent /
// transitionLifecycle / the canonical kernel writers). The delivery worker FANS
// OUT from that ledger; there are ZERO new emit sites sprinkled through the app.
// Adding a webhook event = adding a catalog entry below, nothing else.
//
// Node-crypto only (same idiom as lib/agentic-os/agent-credentials.ts) — do NOT
// import from client components; the settings UI receives catalog/doc data as
// serialized props from its server page.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { KernelEvent } from "@/lib/kernel/events"

// ─── Ledger row shape (the subset of lifecycle_events the mapper needs) ───────

export interface WebhookLedgerRow {
  id: string
  brokerage_id: string | null
  entity_type: string
  entity_id: string
  event_type: string
  metadata: Record<string, unknown> | null
  created_at: string
}

// ─── Event catalog ────────────────────────────────────────────────────────────

export interface WebhookEventDef {
  /** External, dot-namespaced event name subscribers pick (e.g. "deal.closed"). */
  event: string
  /** Human description shown in the Developers UI + docs. */
  description: string
  /**
   * lifecycle_events.event_type values this external event fans out from. TYPED to the CURRENT
   * canonical names (wave 137B): a KernelEvent value (emitKernelEvent's vocabulary,
   * lib/kernel/events.ts) or a `lifecycle.<eventType>` row written by transitionLifecycle
   * (lib/kernel/lifecycle.ts:278). A renamed or invented internal name does not compile —
   * the APPROVED catalogue is derived from the kernel's names, never a parallel spelling.
   */
  internalTypes: ReadonlyArray<KernelEvent | `lifecycle.${string}`>
  /** Optional lifecycle_events.entity_type restriction. */
  entityTypes?: string[]
  /** Optional extra pure predicate on the ledger row. */
  matches?: (row: WebhookLedgerRow) => boolean
  /**
   * EXTERNAL PAYLOAD PROJECTION (wave 137B) — the ALLOW-LIST of metadata keys that may leave
   * the platform in `data`. Everything else on the internal row (agent ids, free-text reasons,
   * names, emails, phones, amounts) stays inside by default. Only primitive values pass —
   * a nested object or array under an allowed key is dropped, so PII cannot ride inside one.
   */
  payloadFields: readonly string[]
}

/**
 * THE catalog. Every entry maps to REAL, verified write sites in the
 * lifecycle_events ledger (source noted per entry) — no aspirational events.
 */
export const WEBHOOK_EVENT_CATALOG: WebhookEventDef[] = [
  {
    event: "lead.captured",
    description: "A new raw lead was captured (form, ad, QR scan, open-house sign-in, import).",
    // lib/kernel/lead-acquisition-handlers.ts — the canonical lead-intake writer.
    internalTypes: [KernelEvent.LEAD_CAPTURED],
    payloadFields: ["source"],
  },
  {
    event: "lead.converted",
    description: "A lead was converted into a CRM contact.",
    // lib/kernel/lead-acquisition-handlers.ts (both conversion paths).
    internalTypes: [KernelEvent.LEAD_CONVERTED_TO_CONTACT],
    payloadFields: ["contactId"],
  },
  {
    event: "contact.created",
    description: "A contact record was created (manual, capture pipeline, import, open house).",
    // lib/kernel/crm.ts (contact_created) + lib/contact-pipeline/contact-capture.ts (contact_captured).
    internalTypes: [KernelEvent.CONTACT_CREATED, KernelEvent.CONTACT_CAPTURED],
    payloadFields: ["source", "from_lead_id"],
  },
  {
    event: "appointment.scheduled",
    description: "The AI ISA booked an appointment with a lead or contact.",
    // lib/ai-isa/appointment-scheduler.ts.
    internalTypes: [KernelEvent.ISA_APPOINTMENT_SCHEDULED],
    payloadFields: ["calendarEventId", "startAt"],
  },
  {
    event: "listing.created",
    description: "A listing record was created after compliance approval.",
    // lib/kernel/listings.ts + lib/workflow-orchestrator/chains/compliance-listing-auto-create.ts.
    internalTypes: [KernelEvent.LISTING_CREATED],
    // agent_id is INTERNAL (the writer at lib/kernel/listings.ts records it) — never projected.
    payloadFields: ["stage"],
  },
  {
    event: "contract.signed",
    description: "A purchase contract was signed — the listing moved under contract.",
    // app/actions/seller-listing/execution-engine.ts via transitionLifecycle
    // (eventType contract_signed → ledger row 'lifecycle.contract_signed').
    internalTypes: ["lifecycle.contract_signed"],
    entityTypes: ["listing_stage_machine"],
    payloadFields: ["from_state", "to_state"],
  },
  {
    event: "deal.stage_changed",
    description: "A transaction advanced to a new stage (metadata carries from_state / to_state).",
    // lib/transactions/stage-progression.ts via transitionLifecycle (eventType 'stage.advanced').
    internalTypes: ["lifecycle.stage.advanced"],
    entityTypes: ["transaction"],
    // `reason` is free text a human typed — it can carry anything, so it never leaves.
    payloadFields: ["from_state", "to_state"],
  },
  {
    event: "deal.closed",
    description: "A transaction closed.",
    // lib/kernel/transactions.ts (transaction_closed) + the stage machine advancing to CLOSED.
    internalTypes: [KernelEvent.TRANSACTION_CLOSED, "lifecycle.stage.advanced"],
    entityTypes: ["transaction"],
    payloadFields: ["from_state", "to_state"],
    matches: (row) =>
      row.event_type === "transaction_closed" ||
      String((row.metadata as Record<string, unknown> | null)?.to_state ?? "") === "CLOSED",
  },
  {
    event: "offer.accepted",
    description: "An offer was accepted and bridged into a transaction.",
    // lib/transactions/offer-bridge.ts via emitTransactionEvent(OFFER_ACCEPTED).
    internalTypes: [KernelEvent.OFFER_ACCEPTED],
    // Dates + the source offer id only — no title company, no amounts.
    payloadFields: ["closing_date", "inspection_deadline", "earnest_money_due", "earnest_money_due_days", "created_from_offer"],
  },
]

/** All external event names, in catalog order. */
export const WEBHOOK_EVENT_NAMES: string[] = WEBHOOK_EVENT_CATALOG.map((d) => d.event)

/** Union of every internal lifecycle_events.event_type the catalog taps. */
export const WEBHOOK_INTERNAL_EVENT_TYPES: string[] = Array.from(
  new Set(WEBHOOK_EVENT_CATALOG.flatMap((d) => d.internalTypes)),
)

/** Pure: is this external event name in the catalog? */
export function isKnownWebhookEvent(event: string): boolean {
  return WEBHOOK_EVENT_NAMES.includes(event)
}

/**
 * Pure: the ONE event-filter validator both the create and the update door run (wave 137B).
 * A filter may name ONLY approved catalogue events — never an internal kernel name, never a
 * wildcard (a legacy "*" row still matches through subscriptionMatchesEvent, which is itself
 * catalogue-bounded, but no door mints a new one).
 */
export function validateWebhookEventFilter(
  requested: readonly string[] | null | undefined,
): { ok: true; events: string[] } | { ok: false; error: string } {
  const events = Array.from(new Set((requested ?? []).map((e) => String(e).trim()).filter(Boolean)))
  if (events.length === 0) return { ok: false, error: "pick at least one event" }
  const unknown = events.filter((e) => !isKnownWebhookEvent(e))
  if (unknown.length > 0) return { ok: false, error: `unknown event(s): ${unknown.join(", ")}` }
  return { ok: true, events }
}

/** Pure: does a subscription's events list cover this external event? ("*" = all). */
export function subscriptionMatchesEvent(subscribed: readonly string[] | null | undefined, event: string): boolean {
  if (!subscribed || subscribed.length === 0) return false
  return subscribed.includes("*") || subscribed.includes(event)
}

/** Pure: the internal ledger event_types needed to serve a subscription's events. */
export function internalTypesForEvents(subscribed: readonly string[] | null | undefined): string[] {
  if (!subscribed || subscribed.length === 0) return []
  if (subscribed.includes("*")) return WEBHOOK_INTERNAL_EVENT_TYPES
  const out = new Set<string>()
  for (const def of WEBHOOK_EVENT_CATALOG) {
    if (subscribed.includes(def.event)) def.internalTypes.forEach((t) => out.add(t as string))
  }
  return Array.from(out)
}

/** Pure: which external catalog events does one ledger row represent? (Possibly several.) */
export function externalEventsForLedgerRow(row: WebhookLedgerRow): string[] {
  const out: string[] = []
  for (const def of WEBHOOK_EVENT_CATALOG) {
    if (!(def.internalTypes as readonly string[]).includes(row.event_type)) continue
    if (def.entityTypes && !def.entityTypes.includes(row.entity_type)) continue
    if (def.matches && !def.matches(row)) continue
    out.push(def.event)
  }
  return out
}

// ─── Payload ──────────────────────────────────────────────────────────────────

export interface WebhookPayload {
  /** The lifecycle_events ledger row id — the delivery's idempotency key. */
  id: string
  event: string
  occurred_at: string
  brokerage_id: string | null
  entity: { type: string; id: string }
  data: Record<string, unknown>
}

/** The test ping's projection — the one non-catalogue event a door sends. */
const PING_PAYLOAD_FIELDS: readonly string[] = ["note"]

/**
 * Pure: the EXTERNAL projection of an internal row's metadata (wave 137B). Allow-list only:
 * a key not named in the event's `payloadFields` never leaves, and only primitive values pass.
 * An event with no catalogue entry projects to `{}` — fail closed, never the raw metadata.
 */
function projectWebhookData(event: string, metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const fields = event === "ping" ? PING_PAYLOAD_FIELDS : WEBHOOK_EVENT_CATALOG.find((d) => d.event === event)?.payloadFields
  const out: Record<string, unknown> = {}
  if (!fields || !metadata) return out
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue
    const v = metadata[key]
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v
  }
  return out
}

/** Pure: canonical payload for one (external event, ledger row) pair — `data` is the allow-list projection. */
export function buildWebhookPayload(event: string, row: WebhookLedgerRow): WebhookPayload {
  return {
    id: row.id,
    event,
    occurred_at: row.created_at,
    brokerage_id: row.brokerage_id,
    entity: { type: row.entity_type, id: row.entity_id },
    data: projectWebhookData(event, row.metadata),
  }
}

/**
 * Pure: may this ledger row be delivered to this subscription? (wave 137B, defense in depth —
 * the enqueue query is already brokerage-pinned.) A row of tenant B NEVER reaches tenant A's
 * subscription, and a row with no tenant reaches nobody.
 */
export function ledgerRowDeliverableTo(sub: { brokerage_id: string }, row: WebhookLedgerRow): boolean {
  return typeof row.brokerage_id === "string" && row.brokerage_id.length > 0 && row.brokerage_id === sub.brokerage_id
}

// ─── Idempotency (wave 137B) ────────────────────────────────────────────────
//
// ONE key per (subscription, external event, internal event id). Deterministic, so every retry of
// a delivery row and any re-enqueue of the same ledger row carry the SAME key — the receiver
// dedupes on X-Webhook-Idempotency-Key. Enforced at the database by the unique expression index
// m736 writes on tenant_webhook_deliveries (subscription_id, event_type, payload->>'id').

/** Pure: the idempotency key a delivery carries on every attempt. */
export function webhookIdempotencyKey(subscriptionId: string, event: string, eventId: string): string {
  return "whk_" + createHash("sha256").update(`${subscriptionId}|${event}|${eventId}`).digest("hex").slice(0, 40)
}

/**
 * Pure: the candidates a subscription may still enqueue — a candidate whose key is already on a
 * delivery row (or repeats inside the same batch) is REFUSED, never inserted twice.
 */
export function planWebhookEnqueue<T extends { event: string; payload: { id: string } }>(
  subscriptionId: string,
  candidates: readonly T[],
  existingKeys: ReadonlySet<string>,
): { accept: Array<T & { idempotencyKey: string }>; refused: number } {
  const seen = new Set(existingKeys)
  const accept: Array<T & { idempotencyKey: string }> = []
  let refused = 0
  for (const c of candidates) {
    const key = webhookIdempotencyKey(subscriptionId, c.event, c.payload.id)
    if (seen.has(key)) { refused += 1; continue }
    seen.add(key)
    accept.push({ ...c, idempotencyKey: key })
  }
  return { accept, refused }
}

/** The exact payload shape shown verbatim in the Developers docs block. */
export const SAMPLE_WEBHOOK_PAYLOAD: WebhookPayload = {
  id: "5e0f2c1a-9b1d-4e6a-8f3c-2d7b9a4c1e00",
  event: "deal.stage_changed",
  occurred_at: "2026-07-18T16:45:12.000Z",
  brokerage_id: "1f7d2b30-0a4e-4c11-b8d9-6a5e3c9f2ab1",
  entity: { type: "transaction", id: "9c8b7a65-4321-4fed-cba9-876543210fed" },
  data: { from_state: "UNDER_CONTRACT", to_state: "CLEAR_TO_CLOSE" },
}

// ─── Signing (Stripe-style) ───────────────────────────────────────────────────
//
//   X-Webhook-Signature: t=<unix-seconds>,v1=<hex hmac-sha256 over `${t}.${rawBody}`>

const SECRET_PREFIX = "whsec_"

/** Generate a new webhook signing secret (raw — shown to the operator exactly once). */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64url")
}

/** Pure: mask a secret for list surfaces (never the full value after mint). */
export function maskWebhookSecret(secret: string): string {
  return `${SECRET_PREFIX}…${secret.slice(-4)}`
}

/**
 * Pure: build the X-Webhook-Signature header value for a raw JSON body. During a secret-rotation
 * OVERLAP the sender passes BOTH secrets (new first) and the header carries one `v1=` per secret
 * (`t=…,v1=<new>,v1=<old>`), so a receiver still holding the old secret and one already on the
 * new secret both verify. Outside the overlap it is exactly one `v1=`.
 */
export function signWebhookPayload(secret: string | readonly string[], rawBody: string, timestampSec: number): string {
  const secrets = (typeof secret === "string" ? [secret] : Array.from(secret)).filter((s) => typeof s === "string" && s.length > 0)
  const sigs = secrets.map((s) => `v1=${createHmac("sha256", s).update(`${timestampSec}.${rawBody}`).digest("hex")}`)
  return `t=${timestampSec},${sigs.join(",")}`
}

/** Rotation overlap — how long the PREVIOUS secret keeps signing + verifying after a rotate. */
export const WEBHOOK_SECRET_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000

/**
 * Pure: the secrets that are live for a subscription at `nowMs` — the current one, plus the
 * previous one while its overlap window is still open. What the drain signs with and what the
 * inbound trigger door accepts.
 */
export function activeWebhookSecrets(
  sub: { secret: string; previous_secret?: string | null; previous_secret_expires_at?: string | null },
  nowMs: number = Date.now(),
): string[] {
  const out = [sub.secret].filter((s) => typeof s === "string" && s.length > 0)
  const prev = sub.previous_secret
  const until = sub.previous_secret_expires_at ? Date.parse(sub.previous_secret_expires_at) : NaN
  if (prev && prev !== sub.secret && Number.isFinite(until) && until > nowMs) out.push(prev)
  return out
}

/**
 * Pure: verify an X-Webhook-Signature header against a raw body. Constant-time
 * compare + timestamp tolerance (default 5 minutes). What a receiver runs.
 */
export function verifyWebhookSignature(
  secret: string | readonly string[],
  rawBody: string,
  header: string | null | undefined,
  opts?: { toleranceSec?: number; nowSec?: number },
): boolean {
  if (!header) return false
  // One timestamp, then one or more v1 signatures (several only during a rotation overlap).
  const m = /^t=(\d+)((?:,v1=[0-9a-f]{64}){1,4})$/.exec(header.trim())
  if (!m) return false
  const ts = Number(m[1])
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000)
  const tolerance = opts?.toleranceSec ?? 300
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > tolerance) return false
  const given = m[2].split(",v1=").filter(Boolean)
  const secrets = (typeof secret === "string" ? [secret] : Array.from(secret)).filter((s) => typeof s === "string" && s.length > 0)
  let ok = false
  for (const s of secrets) {
    const expected = Buffer.from(createHmac("sha256", s).update(`${ts}.${rawBody}`).digest("hex"), "hex")
    for (const g of given) {
      try { if (timingSafeEqual(expected, Buffer.from(g, "hex"))) ok = true } catch { /* length mismatch = no match */ }
    }
  }
  return ok
}

// ─── Retry backoff ────────────────────────────────────────────────────────────
//
// Exponential-ish ladder: 1m → 5m → 30m → 2h → 12h, then 'dead'. A delivery is
// marked dead when its 5th attempt fails (MAX_DELIVERY_ATTEMPTS), so with the
// default cap the waits actually used are 1m/5m/30m/2h; the 12h rung applies if
// the cap is ever raised.

// TOMBSTONE (orphan doctrine §1.3) — this name is no longer exported: WEBHOOK_BACKOFF_SCHEDULE_MS.
// Nothing in the product imported it, and no simulator did either; the
// value is live and unchanged, reached through this module's own exported
// functions, which is where callers already get its effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
const WEBHOOK_BACKOFF_SCHEDULE_MS: readonly number[] = [
  60_000,        // 1m
  300_000,       // 5m
  1_800_000,     // 30m
  7_200_000,     // 2h
  43_200_000,    // 12h
]

export const MAX_DELIVERY_ATTEMPTS = 5

/** ±20% jitter on every rung (wave 137B) — deliveries that failed together do not retry together. */
const WEBHOOK_BACKOFF_JITTER = 0.2

/**
 * Pure: given the attempt count AFTER a failure (1-based), the delay before the
 * next try — or null when the delivery is dead (attempt count hit the cap). The
 * rung is jittered by ±WEBHOOK_BACKOFF_JITTER; `random` is injectable for proofs.
 */
export function nextAttemptDelayMs(failedAttempts: number, random: () => number = Math.random): number | null {
  if (failedAttempts >= MAX_DELIVERY_ATTEMPTS) return null
  const base = WEBHOOK_BACKOFF_SCHEDULE_MS[failedAttempts - 1] ?? WEBHOOK_BACKOFF_SCHEDULE_MS[WEBHOOK_BACKOFF_SCHEDULE_MS.length - 1]
  const r = Math.min(1, Math.max(0, random()))
  return Math.round(base * (1 + WEBHOOK_BACKOFF_JITTER * (2 * r - 1)))
}

// ─── Per-attempt delivery ledger (wave 137B) ────────────────────────────────

interface WebhookAttemptEntry {
  attempt: number
  at: string
  outcome: "delivered" | "failed" | "dead"
  http_status: number | null
  duration_ms: number
  error: string | null
  idempotency_key: string
}

/** Retained per row — the newest attempts win; the count still lives in `attempts`. */
const ATTEMPT_LOG_CAP = 20

/** Pure: append one attempt to a delivery's attempt_log (m736), capped, errors trimmed. */
export function appendWebhookAttempt(log: unknown, entry: WebhookAttemptEntry): WebhookAttemptEntry[] {
  const prior = Array.isArray(log) ? (log as WebhookAttemptEntry[]) : []
  return [...prior, { ...entry, error: entry.error ? entry.error.slice(0, 300) : null }].slice(-ATTEMPT_LOG_CAP)
}

// ─── Auto-disable (wave 137B) ────────────────────────────────────────────────
//
// A subscription whose deliveries keep going DEAD (each one a fully exhausted backoff ladder) with
// no 2xx in between is switched off — the tenant admins are notified, the action is ledgered
// (withActionLedger) and evented (emitKernelEvent). Two conditions, both required, so one short
// outage that kills a backlog in one cycle cannot trip it: N consecutive dead deliveries AND no
// success for at least the quiet window.

export const WEBHOOK_AUTO_DISABLE_CONSECUTIVE_DEAD = 5
const WEBHOOK_AUTO_DISABLE_QUIET_MS = 24 * 60 * 60 * 1000

/** Pure: should this subscription be auto-disabled now? */
export function shouldAutoDisableWebhook(p: {
  consecutiveDead: number
  lastSuccessAt: string | null
  createdAt: string | null
  nowMs: number
}): boolean {
  if (p.consecutiveDead < WEBHOOK_AUTO_DISABLE_CONSECUTIVE_DEAD) return false
  const since = Date.parse(p.lastSuccessAt ?? p.createdAt ?? "")
  if (!Number.isFinite(since)) return true // no anchor at all — the streak alone decides
  return p.nowMs - since >= WEBHOOK_AUTO_DISABLE_QUIET_MS
}

// ─── Tenant-mintable API-token scopes ────────────────────────────────────────
//
// The self-serve subset of the AGIS scope vocabulary (lib/agentic-os/agent-scopes.ts
// + app-capability-registry.ts). Deliberately NO "*" and no platform scopes —
// a tenant token can only ever act inside its own brokerage.

export const TENANT_MINTABLE_SCOPES: ReadonlyArray<{ scope: string; description: string }> = [
  { scope: "contact:read",      description: "Read contacts" },
  { scope: "lead:read",         description: "Read leads" },
  { scope: "lead:write",        description: "Create / update leads" },
  { scope: "lead:qualify",      description: "Run lead qualification" },
  { scope: "listing:write",     description: "Create / update listings" },
  { scope: "transaction:write", description: "Create / advance transactions" },
  { scope: "calendar:write",    description: "Create calendar events" },
  { scope: "cma:write",         description: "Generate CMAs" },
  { scope: "reporting:read",    description: "Read reporting rollups" },
  { scope: "connectivity:read", description: "Read connector / integration status" },
  // Wave 137A — the versioned domain API (app/api/v1/[resource], lib/kernel/domain-api.ts
  // DOMAIN_API_RESOURCES). contact:read and lead:read above already cover contact and
  // opportunity; these are the remaining READ scopes plus the one capability REQUEST scope
  // (a request rides the manager-delegation service — never a provider).
  { scope: "property:read",      description: "Read property intelligence (v1 API)" },
  { scope: "listing:read",       description: "Read listings (v1 API)" },
  { scope: "transaction:read",   description: "Read transactions — no commission fields (v1 API)" },
  { scope: "mission:read",       description: "Read active missions (v1 API)" },
  { scope: "action:read",        description: "Read the action ledger (v1 API)" },
  { scope: "event:read",         description: "Read kernel events (v1 API)" },
  { scope: "capability:read",    description: "Read the capability catalogue (v1 API)" },
  { scope: "capability:request", description: "Request a capability through its owning manager (v1 API)" },
]

/** Pure: validate a requested scope list against the tenant-mintable set. */
export function validateTenantScopes(requested: readonly string[] | null | undefined): { ok: true; scopes: string[] } | { ok: false; error: string } {
  if (!requested || requested.length === 0) return { ok: false, error: "at least one scope is required" }
  const allowed = new Set(TENANT_MINTABLE_SCOPES.map((s) => s.scope))
  const bad = requested.filter((s) => !allowed.has(s))
  if (bad.length > 0) return { ok: false, error: `scope not self-serve mintable: ${bad.join(", ")}` }
  return { ok: true, scopes: Array.from(new Set(requested)) }
}

/**
 * Tiers whose principals may self-serve mint API tokens — ALL FOUR.
 *
 * OWNER, verbatim: "when we have the team and solo agent subscription tiers,
 * those subscriptions get the same level of features as brokerages." Tiers
 * differ by SEAT COUNT, not by feature set, so a token is not a thing a solo
 * tenant is too small to have; the scopes it may mint (TENANT_MINTABLE_SCOPES
 * above) and the brokerage it is pinned to are what keep it safe, and both are
 * identical on every tier.
 *
 * ── FLAGGED FOR PRICING, NOT WITHHELD ───────────────────────────────────────
 *
 * This is the third of the three parity items with a real operating cost rather
 * than a code gate: every self-serve token is an unattended API caller on the
 * platform's own rate limits and support surface, and the cheapest plans are
 * where the most of them will be minted. It ships open because the owner ruled
 * it open; the cost is reported so it can be priced (or capped per tenant,
 * which is a CAPACITY lever the ruling leaves available) rather than silently
 * absorbed.
 *
 * Kept as a set rather than deleted: it is still the ONE place the answer
 * lives, and a per-tier floor is one edit away if the owner prices it that way.
 */
export const TOKEN_SELF_SERVE_TIERS: ReadonlySet<string> =
  new Set(["solo_agent", "team", "brokerage", "multi_location"])
