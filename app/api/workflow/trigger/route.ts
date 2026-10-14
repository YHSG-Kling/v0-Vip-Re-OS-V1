/**
 * POST /api/workflow/trigger
 *
 * Universal webhook entry point for the Workflow OS trigger fabric.
 * Accepts trigger events from external systems (GHL, IDX, QR scans, email
 * provider open/click webhooks) and fires sequence auto-enrollment.
 *
 * NOT ZAPIER (wave 87, lane 87A — owner: "zapier zaps are only allowed out from
 * this platform, never to the platform."). A request that identifies itself as a
 * Zap (User-Agent or `source`) is refused 403 before any auth or write —
 * lib/integrations/zapier-direction.ts isZapierInbound. Zaps are reached OUTBOUND
 * through the tenant's webhook subscriptions (lib/platform/tenant-webhooks.ts).
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
 *   writer, a rotation path (rotateWebhookSecret — wave 137B; the previous secret
 *   still authorises here until its overlap window closes) and a UI.
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

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { isZapierInbound, ZAPIER_INBOUND_REFUSAL } from "@/lib/integrations/zapier-direction"
import { activeWebhookSecrets } from "@/lib/platform/tenant-webhooks-core"

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

  // Zapier is outbound-only (wave 87) — refused before auth, lookup or write.
  if (isZapierInbound({ userAgent: req.headers.get("user-agent"), source })) {
    return NextResponse.json({ error: ZAPIER_INBOUND_REFUSAL }, { status: 403 })
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
    // ROTATION OVERLAP (wave 137B): a secret rotated on /settings/developers keeps authorising
    // until its previous_secret_expires_at, so the tenant can swap their sender without a dropped
    // trigger. m736 columns, read only when the current secrets did not match — an unreadable
    // read (m736 not applied) leaves `matched` false: refuse, never pass.
    if (!matched) {
      const { data: overlap, error: overlapErr } = await supabase
        .from("tenant_webhook_subscriptions")
        .select("secret, previous_secret, previous_secret_expires_at")
        .eq("brokerage_id", brokerageId)
        .eq("active", true)
      if (overlapErr) console.error("[workflow/trigger] rotation-overlap lookup refused (m736 applied?):", overlapErr.message)
      for (const row of (overlap ?? []) as Array<{ secret: string; previous_secret: string | null; previous_secret_expires_at: string | null }>) {
        for (const s of activeWebhookSecrets(row)) if (secretsMatch(token, s)) matched = true
      }
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
  void sentinelWrite(supabase,
    supabase.from("workflow_webhook_events").insert({
      brokerage_id: brokerageId,
      contact_id:   contactId,
      event_type:   event,
      source:       source ?? "webhook",
      payload:      { ...metadata, authorised_via: authorisedVia },
      received_at:  new Date().toISOString(),
    }),
    { table: "workflow_webhook_events", flow: "workflow_trigger_audit", brokerageId, reason: "audit row of an inbound trigger; the enrollment below proceeds regardless" },
  )

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
