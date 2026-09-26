/**
 * POST /api/workflow/trigger
 *
 * Universal webhook entry point for the Workflow OS trigger fabric.
 * Accepts trigger events from external systems (GHL, IDX, Zapier, QR scans,
 * email provider open/click webhooks) and fires sequence auto-enrollment.
 *
 * ── AUTH: which secret authorises which tenant reach ────────────────────────
 * `Authorization: Bearer <secret>`, compared timing-safe. Two secrets, two reaches:
 *
 *   1. PLATFORM path — WORKFLOW_WEBHOOK_SECRET (env). A CROSS-TENANT master key:
 *      the body's `brokerageId` is trusted as given, so whoever holds this value
 *      can enroll contacts in ANY brokerage's sequences. Platform-operated
 *      integrations only. See docs/SERVICE-SECRETS.md.
 *
 *   2. TENANT path — the signing secret of one of the brokerage's own ACTIVE
 *      outbound webhook subscriptions (tenant_webhook_subscriptions.secret, the
 *      `whsec_…` value the tenancy principal minted on /settings/developers and
 *      was shown once — app/actions/tenant-webhooks.ts). The secret is looked up
 *      BY the body's brokerageId and must match one of THAT brokerage's rows, so
 *      the tenant is bound to the credential: a tenant secret cannot name another
 *      brokerage, and a body-supplied brokerageId on this path is a lookup key,
 *      not a trusted claim (CLAUDE.md §4).
 *
 *   The header used to promise "brokerage_integrations.config.webhook_secret".
 *   No such column exists — brokerage_integrations has no `config` (live columns:
 *   scripts/schema-snapshot.ts:145) — and nothing in the tree ever minted a
 *   per-brokerage inbound secret, so that path was documentation for a gate that
 *   did not run. tenant_webhook_subscriptions.secret is the survivor: it has a
 *   writer, a rotation path (delete + re-create the subscription) and a UI.
 *   Trade-off, stated: the same value signs our deliveries TO the tenant, so the
 *   host that receives them can also fire triggers INTO that tenant — and only
 *   that tenant.
 *
 * Body (JSON):
 * {
 *   event:       string          // trigger event value from WORKFLOW_TRIGGERS
 *   brokerageId: string          // required — trusted on path 1, a lookup key on path 2
 *   contactId?:  string          // if known
 *   contactEmail?: string        // used to look up contactId if not provided
 *   metadata?:   Record<string,any>
 *   source?:     string          // "ghl" | "idx" | "qr" | "email_provider" | etc.
 * }
 *
 * Response: { received: true, enrollments: number }
 */

import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Constant-time equality; unequal lengths are a mismatch, never an exception. */
function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("Authorization") ?? ""
  const token = authHeader.replace(/^Bearer\s+/i, "")
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  // Parsed before the tenant path can run: that path needs brokerageId as its
  // lookup key. Nothing is written or enrolled until one of the two paths
  // has authorised.
  let body: {
    event: string
    brokerageId: string
    contactId?: string
    contactEmail?: string
    metadata?: Record<string, unknown>
    source?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { event, brokerageId, contactEmail, metadata, source } = body
  let { contactId } = body

  if (!event || !brokerageId) {
    return NextResponse.json({ error: "event and brokerageId are required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── Auth ──────────────────────────────────────────────────────────────────
  let authorisedVia: "platform" | "tenant" | null = null

  // Path 1 — platform master key. An unset env var disables THIS path only; it
  // never widens into "accept anything" (fail closed).
  const globalSecret = process.env.WORKFLOW_WEBHOOK_SECRET
  if (globalSecret && secretsMatch(token, globalSecret)) {
    authorisedVia = "platform"
  }

  // Path 2 — the brokerage's own subscription secret, bound to the body's
  // brokerageId by the query predicate. A malformed id cannot match a row.
  if (!authorisedVia && UUID_SHAPE.test(brokerageId)) {
    const { data: subscriptions, error } = await supabase
      .from("tenant_webhook_subscriptions")
      .select("secret")
      .eq("brokerage_id", brokerageId)
      .eq("active", true)
    if (error) {
      // A gate that cannot run must refuse, not pass.
      console.error("[workflow/trigger] tenant secret lookup refused:", error.message)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // Every candidate is compared — no early exit — so timing does not reveal
    // WHICH row (if any) matched.
    let matched = false
    for (const row of subscriptions ?? []) {
      if (typeof row.secret === "string" && secretsMatch(token, row.secret)) matched = true
    }
    if (matched) authorisedVia = "tenant"
  }

  if (!authorisedVia) {
    if (!globalSecret) console.error("[workflow/trigger] WORKFLOW_WEBHOOK_SECRET is not configured; platform path disabled")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ── Resolve contactId from email if not provided ───────────────────────────
  if (!contactId && contactEmail) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .ilike("email", contactEmail)
      .maybeSingle()
    contactId = contact?.id
  }

  if (!contactId) {
    return NextResponse.json({ error: "contactId could not be resolved" }, { status: 422 })
  }

  // ── Log the webhook event for audit ───────────────────────────────────────
  void Promise.resolve(
    supabase.from("workflow_webhook_events").insert({
      brokerage_id: brokerageId,
      contact_id:   contactId,
      event_type:   event,
      source:       source ?? "webhook",
      payload:      { ...metadata, authorised_via: authorisedVia },
      received_at:  new Date().toISOString(),
    })
  ).catch(() => {})

  // ── Find matching active sequences ────────────────────────────────────────
  const { data: sequences } = await supabase
    .from("campaign_sequences")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("trigger_event", event)
    .eq("is_active", true)

  if (!sequences || sequences.length === 0) {
    return NextResponse.json({ received: true, enrollments: 0 })
  }

  // ── Enroll contact into matching sequences (idempotent) ───────────────────
  let enrollments = 0
  for (const seq of sequences) {
    // Skip if already actively enrolled
    const { data: existing } = await supabase
      .from("sequence_enrollments")
      .select("id")
      .eq("sequence_id", seq.id)
      .eq("contact_id", contactId)
      .eq("status", "active")
      .maybeSingle()
    if (existing) continue

    const { error } = await supabase.from("sequence_enrollments").insert({
      sequence_id:  seq.id,
      contact_id:   contactId,
      brokerage_id: brokerageId,
      enrolled_by:  null,
      current_step: 0,
      status:       "active",
      enrolled_at:  new Date().toISOString(),
      next_step_at: new Date().toISOString(),
      trigger_metadata: { event, source: source ?? "webhook", ...metadata },
    })
    if (!error) enrollments++
  }

  return NextResponse.json({ received: true, enrollments })
}
