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

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

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
  /** lifecycle_events.event_type values this external event fans out from. */
  internalTypes: string[]
  /** Optional lifecycle_events.entity_type restriction. */
  entityTypes?: string[]
  /** Optional extra pure predicate on the ledger row. */
  matches?: (row: WebhookLedgerRow) => boolean
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
    internalTypes: ["lead_captured"],
  },
  {
    event: "lead.converted",
    description: "A lead was converted into a CRM contact.",
    // lib/kernel/lead-acquisition-handlers.ts (both conversion paths).
    internalTypes: ["lead_converted_to_contact"],
  },
  {
    event: "contact.created",
    description: "A contact record was created (manual, capture pipeline, import, open house).",
    // lib/kernel/crm.ts (contact_created) + lib/contact-pipeline/contact-capture.ts (contact_captured).
    internalTypes: ["contact_created", "contact_captured"],
  },
  {
    event: "appointment.scheduled",
    description: "The AI ISA booked an appointment with a lead or contact.",
    // lib/ai-isa/appointment-scheduler.ts.
    internalTypes: ["isa_appointment_scheduled"],
  },
  {
    event: "listing.created",
    description: "A listing record was created after compliance approval.",
    // lib/kernel/listings.ts + lib/workflow-orchestrator/chains/compliance-listing-auto-create.ts.
    internalTypes: ["listing_created"],
  },
  {
    event: "contract.signed",
    description: "A purchase contract was signed — the listing moved under contract.",
    // app/actions/seller-listing/execution-engine.ts via transitionLifecycle
    // (eventType contract_signed → ledger row 'lifecycle.contract_signed').
    internalTypes: ["lifecycle.contract_signed"],
    entityTypes: ["listing_stage_machine"],
  },
  {
    event: "deal.stage_changed",
    description: "A transaction advanced to a new stage (metadata carries from_state / to_state).",
    // lib/transactions/stage-progression.ts via transitionLifecycle (eventType 'stage.advanced').
    internalTypes: ["lifecycle.stage.advanced"],
    entityTypes: ["transaction"],
  },
  {
    event: "deal.closed",
    description: "A transaction closed.",
    // lib/kernel/transactions.ts (transaction_closed) + the stage machine advancing to CLOSED.
    internalTypes: ["transaction_closed", "lifecycle.stage.advanced"],
    entityTypes: ["transaction"],
    matches: (row) =>
      row.event_type === "transaction_closed" ||
      String((row.metadata as Record<string, unknown> | null)?.to_state ?? "") === "CLOSED",
  },
  {
    event: "offer.accepted",
    description: "An offer was accepted and bridged into a transaction.",
    // lib/transactions/offer-bridge.ts via emitTransactionEvent(OFFER_ACCEPTED).
    internalTypes: ["offer_accepted"],
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
    if (subscribed.includes(def.event)) def.internalTypes.forEach((t) => out.add(t))
  }
  return Array.from(out)
}

/** Pure: which external catalog events does one ledger row represent? (Possibly several.) */
export function externalEventsForLedgerRow(row: WebhookLedgerRow): string[] {
  const out: string[] = []
  for (const def of WEBHOOK_EVENT_CATALOG) {
    if (!def.internalTypes.includes(row.event_type)) continue
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

/** Pure: canonical payload for one (external event, ledger row) pair. */
export function buildWebhookPayload(event: string, row: WebhookLedgerRow): WebhookPayload {
  return {
    id: row.id,
    event,
    occurred_at: row.created_at,
    brokerage_id: row.brokerage_id,
    entity: { type: row.entity_type, id: row.entity_id },
    data: (row.metadata ?? {}) as Record<string, unknown>,
  }
}

/** The exact payload shape shown verbatim in the Developers docs block. */
export const SAMPLE_WEBHOOK_PAYLOAD: WebhookPayload = {
  id: "5e0f2c1a-9b1d-4e6a-8f3c-2d7b9a4c1e00",
  event: "deal.stage_changed",
  occurred_at: "2026-07-18T16:45:12.000Z",
  brokerage_id: "1f7d2b30-0a4e-4c11-b8d9-6a5e3c9f2ab1",
  entity: { type: "transaction", id: "9c8b7a65-4321-4fed-cba9-876543210fed" },
  data: { from_state: "UNDER_CONTRACT", to_state: "CLEAR_TO_CLOSE", reason: null },
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

/** Pure: build the X-Webhook-Signature header value for a raw JSON body. */
export function signWebhookPayload(secret: string, rawBody: string, timestampSec: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex")
  return `t=${timestampSec},v1=${v1}`
}

/**
 * Pure: verify an X-Webhook-Signature header against a raw body. Constant-time
 * compare + timestamp tolerance (default 5 minutes). What a receiver runs.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  opts?: { toleranceSec?: number; nowSec?: number },
): boolean {
  if (!header) return false
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header.trim())
  if (!m) return false
  const ts = Number(m[1])
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000)
  const tolerance = opts?.toleranceSec ?? 300
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > tolerance) return false
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(m[2], "hex"))
  } catch {
    return false
  }
}

// ─── Retry backoff ────────────────────────────────────────────────────────────
//
// Exponential-ish ladder: 1m → 5m → 30m → 2h → 12h, then 'dead'. A delivery is
// marked dead when its 5th attempt fails (MAX_DELIVERY_ATTEMPTS), so with the
// default cap the waits actually used are 1m/5m/30m/2h; the 12h rung applies if
// the cap is ever raised.

export const WEBHOOK_BACKOFF_SCHEDULE_MS: readonly number[] = [
  60_000,        // 1m
  300_000,       // 5m
  1_800_000,     // 30m
  7_200_000,     // 2h
  43_200_000,    // 12h
]

export const MAX_DELIVERY_ATTEMPTS = 5

/**
 * Pure: given the attempt count AFTER a failure (1-based), the delay before the
 * next try — or null when the delivery is dead (attempt count hit the cap).
 */
export function nextAttemptDelayMs(failedAttempts: number): number | null {
  if (failedAttempts >= MAX_DELIVERY_ATTEMPTS) return null
  return WEBHOOK_BACKOFF_SCHEDULE_MS[failedAttempts - 1] ?? WEBHOOK_BACKOFF_SCHEDULE_MS[WEBHOOK_BACKOFF_SCHEDULE_MS.length - 1]
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
]

/** Pure: validate a requested scope list against the tenant-mintable set. */
export function validateTenantScopes(requested: readonly string[] | null | undefined): { ok: true; scopes: string[] } | { ok: false; error: string } {
  if (!requested || requested.length === 0) return { ok: false, error: "at least one scope is required" }
  const allowed = new Set(TENANT_MINTABLE_SCOPES.map((s) => s.scope))
  const bad = requested.filter((s) => !allowed.has(s))
  if (bad.length > 0) return { ok: false, error: `scope not self-serve mintable: ${bad.join(", ")}` }
  return { ok: true, scopes: Array.from(new Set(requested)) }
}

/** Tiers whose principals may self-serve mint API tokens. */
export const TOKEN_SELF_SERVE_TIERS: ReadonlySet<string> = new Set(["brokerage", "multi_location"])
