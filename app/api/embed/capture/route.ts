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
import { checkPublicRateLimit } from "@/lib/security/public-rate-limit"
import { captureConsentedContact, resolveCapturedLanguage } from "@/lib/contact-pipeline/contact-capture"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

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
  // PUBLIC-WRITE THROTTLE (lane 138F readiness audit, P1): unauthenticated
  // contact capture from a third-party page. Idiom: app/api/track/visitor/route.ts.
  const rateIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown"
  const rateVerdict = checkPublicRateLimit("embed-capture", rateIp, { limit: 20, windowMs: 10 * 60_000 })
  if (!rateVerdict.allowed) {
    return NextResponse.json({ error: "Too many submissions from this connection — try again shortly." }, { status: 429, headers: { "Retry-After": String(rateVerdict.retryAfterSeconds) } })
  }
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
    .select("id, brokerage_id, agent_id, is_active, routing_mode, last_routed_agent_id")
    .eq("public_id", body.publicId)
    .maybeSingle()

  if (!widget || !widget.is_active) {
    return NextResponse.json({ error: "Embed not found" }, { status: 404 })
  }

  // ── Resolve the assigned agent's user_id (captureContact takes users.id) ──
  // For brokerage-wide embeds (agent_id IS NULL), apply the configured routing
  // strategy. 'primary' = first active agent (original behaviour). 'round_robin'
  // = advances through active agents in created_at order, wrapping around.
  let resolvedAgentId: string | null = widget.agent_id

  if (!resolvedAgentId) {
    const { data: activeAgents } = await supabase
      .from("agents")
      .select("id")
      .eq("brokerage_id", widget.brokerage_id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
    const pool = (activeAgents ?? []).map((a: any) => a.id)

    if (pool.length > 0) {
      if (widget.routing_mode === "round_robin" && widget.last_routed_agent_id) {
        const lastIdx = pool.indexOf(widget.last_routed_agent_id)
        resolvedAgentId = pool[(lastIdx + 1) % pool.length]
      } else {
        resolvedAgentId = pool[0]
      }
      // Advance the cursor so the next capture gets a different agent.
      await sentinelWrite(supabase, supabase
        .from("embed_widgets")
        .update({ last_routed_agent_id: resolvedAgentId })
        .eq("id", widget.id), { table: "embed_widgets", flow: "embed_widgets_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
    }
  }

  // resolvedAgentId is agents.id (embed_widgets.agent_id FK → agents). Pass
  // it through directly; captureContact handles agents.id correctly.

  // ── Capture — C8 (wave 147, lane 147A — owner ruling 1) ─────────────────
  // CONSENT IS WHAT THE PERSON SAW, NOT WHAT THE DOOR ASSUMES. This door used to stamp tcpa_consent = true on every capture
  // ("visitors providing info on an embed are explicitly opting in"), but the embed form (app/embed/[publicId]/embed-widget.tsx
  // leadCaptureFields) shows NO consent box and NO disclosure wording — a TCPA consent with no wording behind it is a false
  // record. The person is identifiable, so they still land on the canonical CONTACT; no consent row is written and the tcpa_*
  // columns are not claimed (fail closed). The consent box + wording on the embed form is listed Still-open in the 147A notes.
  let result: Awaited<ReturnType<typeof captureConsentedContact>>
  try {
    result = await captureConsentedContact({
      brokerageId: widget.brokerage_id,
      ownerAgentId: resolvedAgentId ?? null,
      source: "widget",
      first_name: body.first_name?.trim() ?? null,
      last_name: body.last_name?.trim() ?? null,
      email: body.email?.trim()?.toLowerCase() ?? null,
      phone: body.phone?.trim() ?? null,
      preferred_channel: "email",
      // TIER 3 OF resolveContactLanguage — THE ONE resolver (§6).
      language: resolveCapturedLanguage(null, request.headers.get("accept-language")),
      consents: [{ family: "phone", given: false, text: null, textVersion: "embed:no_disclosure_shown" }],
      intake: {
        channel: "embed", sourceUrl: `/embed/${body.publicId}`,
        evidence: { embed_widget_id: widget.id, session_id: body.sessionId, ip: rateIp, user_agent: request.headers.get("user-agent") ?? null },
        formOwner: { table: "embed_widgets", id: widget.id },
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Capture failed" }, { status: 500 })
  }
  if (!result.ok || !result.contactId) {
    return NextResponse.json({ error: result.reason ?? "Capture failed" }, { status: result.refused === "not_identifiable" ? 400 : 500 })
  }

  // ── Stamp embed attribution + link to the visitor session ───────────────
  // contacts.embed_widget_id ties the contact back to the originating embed
  // so the broker can see "leads from this embed". embed_sessions.contact_id
  // links the conversation history.
  await sentinelWrite(
    supabase,
    supabase
      .from("contacts")
      .update({ embed_widget_id: widget.id })
      .eq("id", result.contactId),
    {
      table: "contacts",
      flow: "embed_capture_attribution_stamp",
      brokerageId: widget.brokerage_id,
      reason:
        "attribution stamp tying the contact back to the embed it came from; the contact itself (and its consent columns) was already created and error-checked above, so a lost stamp costs a 'leads from this embed' rollup, not the lead",
    },
  )

  await sentinelWrite(supabase, supabase
    .from("embed_sessions")
    .update({ contact_id: result.contactId })
    .eq("id", body.sessionId), { table: "embed_sessions", flow: "embed_sessions_write", reason: "session→contact link; the contact is already captured" })

  return NextResponse.json({ contactId: result.contactId })
}
