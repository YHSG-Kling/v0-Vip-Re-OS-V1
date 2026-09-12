/**
 * POST /api/embed/session
 *
 * Public, anon-friendly route — the embed iframe calls this to get a D-ID
 * client_key and start a conversation. NOT authenticated by Supabase session.
 *
 * Authorization is enforced via:
 *   - publicId must resolve to an active embed_widgets row
 *   - origin (when widget.allowed_domains is non-empty) must match
 *   - cap check on live_avatar_sessions before issuing the key
 *
 * Returns: { didAgentId, clientKey, sessionId }
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ensureDIDAgent, issueClientKey } from "@/lib/did/agents"
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"
import { startLiveAgentSession, recordLiveAgentInitFailure, type LiveAgentSurface } from "@/lib/did/live-session-metering"

export const runtime = "nodejs"

interface Body {
  publicId: string
  visitorId: string
  origin?: string | null
  referrer?: string | null
  pageUrl?: string | null
}

/**
 * SITE vs WIDGET (wave 60, m624's `surface` CHECK). Both doors mint through
 * this same route (§6 — one session-mint path, never a second per surface).
 * SiteChatLauncher's iframe is served from OUR OWN app origin
 * (app/embed/[publicId] under NEXT_PUBLIC_APP_URL/SITE_URL); a third-party
 * embed's iframe is same-origin with the visitor's OWN page, so `body.origin`
 * (the visitor's page, stamped by the embed loader script) is a foreign host.
 * A visitor page with no stated origin (rare, non-browser caller) defaults to
 * 'widget' — the more common real-world case for an anonymous public door.
 */
function deriveEmbedSurface(origin: string | null | undefined): LiveAgentSurface {
  if (!origin) return "widget"
  let host: string
  try { host = new URL(origin).host } catch { return "widget" }
  for (const raw of [process.env.NEXT_PUBLIC_APP_URL, process.env.NEXT_PUBLIC_SITE_URL]) {
    if (!raw) continue
    try { if (new URL(raw).host === host) return "site" } catch { /* malformed env */ }
  }
  return "widget"
}

// recordLiveAgentInitFailure MERGED onto lib/did/live-session-metering.ts (one helper for both session doors, routed through lib/errors/collect-error.ts) — wave 60.

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Body | null
  if (!body?.publicId || !body?.visitorId) {
    return NextResponse.json({ error: "publicId + visitorId required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── Resolve embed config ────────────────────────────────────────────────
  const { data: widget } = await supabase
    .from("embed_widgets")
    .select("id, brokerage_id, agent_id, default_twin_id, allowed_domains, is_active")
    .eq("public_id", body.publicId)
    .maybeSingle()

  if (!widget || !widget.is_active) {
    return NextResponse.json({ error: "Embed not found" }, { status: 404 })
  }

  // Origin check — when configured, must match the calling page's origin.
  const allowed = (widget.allowed_domains ?? []) as string[]
  if (allowed.length > 0 && body.origin && !allowed.includes(body.origin)) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 })
  }

  const surface = deriveEmbedSurface(body.origin)

  // ── Text-chat FAILOVER handle (wave 60 §3.3) ────────────────────────────
  // The brokerage's public slug, so the client can mint a /api/widget/session
  // token and fall back to the EXISTING text chat (/api/widget/message) the
  // moment the D-ID leg fails — never a dead avatar bubble. Best-effort: a
  // brokerage row that can't be read still lets the D-ID attempt proceed,
  // it just has no text door to fall back to if D-ID fails too.
  const { data: brokerageRow } = await supabase
    .from("brokerages").select("slug").eq("id", widget.brokerage_id).maybeSingle()
  const fallback = { brokerageSlug: brokerageRow?.slug ?? null, agentId: widget.agent_id ?? null }

  // ── Cap check ───────────────────────────────────────────────────────────
  const cap = await checkUsageCap({
    brokerageId: widget.brokerage_id,
    metric: "live_avatar_sessions",
    addQuantity: 1,
  })
  if (!cap.allowed) {
    return NextResponse.json(
      { error: "This chat is temporarily unavailable. Please try again later.", fallback },
      { status: 429 },
    )
  }

  // ── Resolve the twin ────────────────────────────────────────────────────
  // Two sources, both an explicit choice someone made: the twin pinned on the
  // embed, or — for a PERSONAL embed, which is owned by one agent — that
  // agent's own default twin.
  //
  // WHAT THIS NO LONGER DOES. A brokerage-wide embed (agent_id NULL) with no
  // pinned twin used to select "the brokerage's primary agent", defined as the
  // first active agent by created_at, and put THEIR face and THEIR cloned voice
  // on a public website. Nobody chose that. The longest-tenured agent in the
  // brokerage became the company's public spokesperson because of a row's
  // timestamp, and they were never asked — an agent's likeness and voice clone
  // are not brokerage property to reassign. It also contradicted the create
  // dialog, which tells the admin brokerage-wide means "pick a twin from any
  // agent"; the picker existed, the pick was simply never required, and the
  // silent fallback covered for it.
  //
  // Now an unpinned brokerage-wide embed refuses and says what to do. The
  // create dialog collects the twin up front, so this is the state of an embed
  // whose twin was later deleted or unapproved — a real condition worth a real
  // message, not a stranger's face.
  let twinId: string | null = widget.default_twin_id

  if (!twinId) {
    if (!widget.agent_id) {
      return NextResponse.json(
        {
          error: "This chat isn't finished being set up yet.",
          operator_hint:
            "This brokerage-wide embed has no twin assigned. Pick one in Settings → Website Embeds — " +
            "a brokerage-wide embed never borrows an agent's twin automatically.",
        },
        { status: 409 },
      )
    }
    const { data: defaultTwin } = await supabase
      .from("agent_avatar_assets")
      .select("id")
      .eq("agent_id", widget.agent_id)
      .eq("is_default", true)
      .maybeSingle()
    twinId = defaultTwin?.id ?? null
  }

  if (!twinId) {
    return NextResponse.json(
      {
        error: "This chat isn't finished being set up yet.",
        operator_hint:
          "The agent who owns this embed has no default twin. Set one up in Settings → Voice & Avatar.",
      },
      { status: 409 },
    )
  }

  // Load the twin's full config for ensureDIDAgent
  const { data: twin } = await supabase
    .from("agent_avatar_assets")
    .select("agent_id, did_avatar_id, voice_id, personality, status, approval_status, label, greeting")
    .eq("id", twinId)
    .maybeSingle()

  if (!twin) {
    return NextResponse.json({ error: "Twin not found" }, { status: 404 })
  }
  if (twin.status !== "ready" || twin.approval_status !== "approved") {
    return NextResponse.json(
      { error: "Twin is still being prepared — try again in a moment", fallback },
      { status: 409 },
    )
  }
  if (!twin.did_avatar_id) {
    return NextResponse.json({ error: "Twin avatar not ready", fallback }, { status: 409 })
  }

  // ── Ensure D-ID Agent + issue client key ────────────────────────────────
  // WALL-CLOCK + OUTCOME (wave 60 §3.2) — same instrumentation as the portal
  // session route, so both live-agent doors feed the same measurement.
  const initStartedAt = Date.now()
  const ensured = await ensureDIDAgent({
    agentId: twin.agent_id,
    twinId,
    presenterId: twin.did_avatar_id,
    elevenLabsVoiceId: twin.voice_id,
    personality: twin.personality,
    greeting: twin.greeting,
    agentName: twin.label ?? "Agent",
  })
  if (!ensured.ok) {
    void recordLiveAgentInitFailure({
      brokerageId: widget.brokerage_id, surface, reason: ensured.error, latencyMs: Date.now() - initStartedAt,
    })
    return NextResponse.json({ error: ensured.error, fallback }, { status: 502 })
  }
  if (ensured.realismWarnings?.length) {
    console.warn(`[embed/session] AI-tell findings on twin ${twinId} greeting:`, ensured.realismWarnings)
  }

  // The embed runs cross-origin; client_key needs allowed_origins to include
  // the visitor's site origin so the SDK can connect.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    return NextResponse.json({ error: "App URL not configured", fallback }, { status: 503 })
  }
  // Allowed origins on the D-ID side: our app (where the iframe is hosted)
  // is the only origin the SDK contacts D-ID from (the iframe is same-origin
  // with our app). The embed's allowed_domains list is enforced at our
  // session route + script loader, not at D-ID.
  const allowedOrigins = [appUrl, ...(process.env.DID_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean)]
  const keyResult = await issueClientKey({
    didAgentId: ensured.didAgentId,
    allowedOrigins: Array.from(new Set(allowedOrigins)),
  })
  if (!keyResult.ok) {
    void recordLiveAgentInitFailure({
      brokerageId: widget.brokerage_id, surface, reason: keyResult.error, latencyMs: Date.now() - initStartedAt,
    })
    return NextResponse.json({ error: keyResult.error, fallback }, { status: 502 })
  }

  // ── Create / refresh the visitor session row ────────────────────────────
  // Upsert by (embed_widget_id, visitor_id) — same visitor returning to the
  // bubble shouldn't create a new session row each time.
  const { data: session } = await supabase
    .from("embed_sessions")
    .insert({
      embed_widget_id: widget.id,
      brokerage_id: widget.brokerage_id,
      visitor_id: body.visitorId,
      origin: body.origin ?? null,
      referrer: body.referrer ?? null,
      // embed_sessions has no page_url column — keep the full URL in metadata.
      metadata: { page_url: body.pageUrl ?? null },
      user_agent: request.headers.get("user-agent") ?? null,
      did_session_ref: ensured.didAgentId,
    })
    .select("id")
    .single()

  // ── Log usage ───────────────────────────────────────────────────────────
  logMediaUsage({
    brokerageId: widget.brokerage_id,
    metric: "live_avatar_sessions",
    quantity: 1,
    agentId: twin.agent_id,
    sessionRef: session?.id ?? ensured.didAgentId,
    feature: "embed_widget",
    metadata: { public_id: body.publicId, visitor_id: body.visitorId, init_success: true, init_latency_ms: Date.now() - initStartedAt },
  }).catch(() => {})

  // THE METERING ROW (m624) — embed had NO minute-level metering at all
  // before this pass (only the per-session counter above). Opened here so
  // the client's heartbeat/end beacons (app/embed/[publicId]/embed-widget.tsx)
  // and the sweeper have a row to keep alive / close.
  const liveSession = await startLiveAgentSession({
    brokerageId: widget.brokerage_id,
    agentId: twin.agent_id,
    contactId: null, // no contact yet at mint — /api/embed/capture links one later on embed_sessions, not here
    surface,
    didAgentId: ensured.didAgentId,
  }, supabase).catch((e) => { console.warn("[embed/session] live_agent_sessions insert threw", e); return { ok: false as const, error: String(e) } })

  return NextResponse.json({
    didAgentId: ensured.didAgentId,
    clientKey: keyResult.clientKey,
    // The presenter FAMILY, so the browser knows what it may offer before it
    // connects. The live widget's microphone and sentiment are Expressive (V4)
    // only, and streamOptions are v2/v3 only — sending the client a capability
    // it cannot use is how a dead button gets shipped.
    presenterType: ensured.presenterType,
    sessionId: session?.id ?? null,
    liveSessionId: liveSession.ok ? liveSession.id : null,
    // Text-failover handle — present on SUCCESS too, so a later mid-session
    // drop (onConnectionStateChange Fail/Closed, onError) can still fall back
    // without a second round-trip.
    fallback,
  })
}
