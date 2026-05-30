/**
 * POST /api/workflow/trigger
 *
 * Universal webhook entry point for the Workflow OS trigger fabric.
 * Accepts trigger events from external systems (GHL, IDX, Zapier, QR scans,
 * email provider open/click webhooks) and fires sequence auto-enrollment.
 *
 * Auth: Bearer token via WORKFLOW_WEBHOOK_SECRET env var (or
 * brokerage-level webhook secret stored in brokerage_integrations.config.webhook_secret).
 *
 * Body (JSON):
 * {
 *   event:       string          // trigger event value from WORKFLOW_TRIGGERS
 *   brokerageId: string          // required
 *   contactId?:  string          // if known
 *   contactEmail?: string        // used to look up contactId if not provided
 *   metadata?:   Record<string,any>
 *   source?:     string          // "ghl" | "idx" | "qr" | "email_provider" | etc.
 * }
 *
 * Response: { received: true, enrollments: number }
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? ""
  const token = authHeader.replace(/^Bearer\s+/i, "")

  const globalSecret = process.env.WORKFLOW_WEBHOOK_SECRET
  if (!globalSecret) {
    return NextResponse.json({ error: "WORKFLOW_WEBHOOK_SECRET not configured" }, { status: 500 })
  }
  if (token !== globalSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ── Parse body ────────────────────────────────────────────────────────────
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
      payload:      { ...metadata },
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
