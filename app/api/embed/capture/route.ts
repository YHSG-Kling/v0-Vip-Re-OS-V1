/**
 * POST /api/embed/capture
 *
 * Public, anon-friendly route — embed iframe submits visitor info, we create
 * (or merge with) a contact in the brokerage's CRM.
 *
 * Body: {
 *   publicId, sessionId, visitorId,
 *   first_name?, last_name?, email?, phone?
 * }
 *
 * Returns: { contactId }
 *
 * Uses lib/contact-pipeline/contact-capture which dedupes against existing
 * contacts, handles enrichment, and emits CONTACT_CAPTURED kernel events
 * (which fan out to notifications / sequences / portal updates per kernel-OS).
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"

export const runtime = "nodejs"

interface Body {
  publicId: string
  sessionId: string
  visitorId: string
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Body | null
  if (!body?.publicId || !body?.sessionId) {
    return NextResponse.json({ error: "publicId + sessionId required" }, { status: 400 })
  }

  const hasName = !!body.first_name?.trim()
  const hasContactMethod = !!(body.email?.trim() || body.phone?.trim())
  if (!hasName || !hasContactMethod) {
    return NextResponse.json({ error: "Name + email or phone required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── Resolve embed config for the owner brokerage + agent ────────────────
  const { data: widget } = await supabase
    .from("embed_widgets")
    .select("id, brokerage_id, agent_id, is_active")
    .eq("public_id", body.publicId)
    .maybeSingle()

  if (!widget || !widget.is_active) {
    return NextResponse.json({ error: "Embed not found" }, { status: 404 })
  }

  // ── Resolve the assigned agent's user_id (captureContact takes users.id) ──
  let agentUserId: string | null = null
  if (widget.agent_id) {
    const { data: agent } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", widget.agent_id)
      .maybeSingle()
    agentUserId = agent?.user_id ?? null
  }

  // ── Capture (dedupe + create + score + enrich + emit kernel event) ──────
  // Visitors providing info on an embed are explicitly opting in — that's
  // the TCPA consent boundary for any later SMS / call follow-up.
  let result
  try {
    result = await captureContact({
      brokerageId: widget.brokerage_id,
      agentUserId,
      source: "widget",
      first_name: body.first_name?.trim() ?? null,
      last_name: body.last_name?.trim() ?? null,
      email: body.email?.trim()?.toLowerCase() ?? null,
      phone: body.phone?.trim() ?? null,
      preferred_channel: body.email ? "email" : "sms",
      tcpa_consent: true,
      tcpa_consent_date: new Date().toISOString(),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Capture failed" }, { status: 500 })
  }

  // ── Stamp embed attribution + link to the visitor session ───────────────
  // contacts.embed_widget_id ties the contact back to the originating embed
  // so the broker can see "leads from this embed". embed_sessions.contact_id
  // links the conversation history.
  await supabase
    .from("contacts")
    .update({ embed_widget_id: widget.id })
    .eq("id", result.contactId)

  await supabase
    .from("embed_sessions")
    .update({ contact_id: result.contactId })
    .eq("id", body.sessionId)

  return NextResponse.json({ contactId: result.contactId })
}
