"use server"

/**
 * app/actions/open-house.ts
 * System 4.7 — Open House Engine server actions.
 *
 * All queries use getAgentContext() for identity and createServiceClient() for
 * service-role reads/writes. Falls back gracefully if open_house_events table
 * does not exist (it should — see scripts/526-create-open-house-system-v2.sql).
 */

import { createHash } from "node:crypto"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { EVENT_PRODUCER_REGISTRY, isOnlineEvent, isVirtualProvider, type VirtualProvider } from "@/lib/open-house/event-registry"
import { eventWindow } from "@/lib/open-house/event-attendance"

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenHouseEvent {
  id: string
  listing_id: string | null
  brokerage_id: string | null
  agent_id: string | null
  event_date: string
  start_time: string
  end_time: string
  status: string
  description: string | null  // public-facing event description
  notes: string | null        // agent private notes
  max_attendees: number | null
  created_at: string
  // C22 (wave 148, lane 148H): the kind, its title (webinars / education sessions have no listing), its online host, and the
  // registration page's approval state + recording — read by the schedule dialog and the Actions tab.
  event_type?: string | null
  title?: string | null
  virtual_provider?: string | null
  is_published?: boolean | null
  marketing_assets?: Record<string, unknown> | null
  replay_url?: string | null
  // Joined
  listing?: {
    id: string
    address: string | null
    city: string | null
    state: string | null
    zip: string | null
    list_price: number | null
  } | null
  attendee_count?: number
  avg_feedback?: number | null
}

export interface OpenHouseAttendee {
  id: string
  event_id: string
  name: string | null
  email: string | null
  phone: string | null
  contact_id: string | null
  working_with_agent: boolean | null
  interest_level: string | null
  ai_lead_score: number | null
  check_in_time: string | null
  notes: string | null
  feedback_rating: number | null
  feedback_comments: string | null
}

export interface OpenHouseFeedback {
  id: string
  attendee_id: string
  event_id: string
  rating: number | null
  liked_most: string | null
  concerns: string | null
  price_opinion: string | null
  interested_in_offer: boolean | null
  submitted_at: string
  // from attendee join
  attendee_name?: string | null
  attendee_email?: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE OPEN HOUSE
// ─────────────────────────────────────────────────────────────────────────────

export async function createOpenHouse(params: {
  /** Required for every listing-anchored kind; a webinar / education session is not about one listing (m924). */
  listingId?: string | null
  date: string          // ISO date string "YYYY-MM-DD"
  startTime: string     // "HH:MM"
  endTime: string       // "HH:MM"
  maxAttendees?: number
  agentNotes?: string
  publicDescription?: string
  sendInvites?: boolean
  /**
   * WAVE 147 (lane 147Z — lane 147F "Still open": the live CHECK admits broker_open and virtual_open_house and NOTHING produced
   * them; orphan doctrine §1.2 — build the missing half). ONE scheduling door for all three kinds (no twin):
   *   · open_house (default) — the public kiosk captures consumers as consented contacts (C8);
   *   · broker_open — a cooperating-AGENT preview: the kiosk records the agent as an attendee and creates NO consumer contact,
   *     claims no consumer consent and sends no consumer greeting (app/api/open-house/attend/route.ts);
   *   · virtual_open_house — attended online: `joinUrl` (https) is the event's check-in URL; the join door
   *     (app/open-house/[eventId]/join/route.ts) records an invited contact's attendance before it forwards them.
   */
  eventType?: string
  joinUrl?: string
  /**
   * WAVE 148 (lane 148H — C22, owner rulings 14 + 20). The ONE door now produces all FIVE kinds the registry declares
   * (lib/open-house/event-registry.ts): + webinar and education_session (m924 — no listing). An ONLINE event names its host:
   *   · zoom (the default for a virtual open house / webinar) — a REAL Zoom meeting with registration, routed through
   *     routeCapability("virtual_event_hosting") and created on the tenant's own connected account (agent → team → brokerage);
   *     every registrant gets a personal link and the participant webhook VERIFIES attendance;
   *   · youtube — the agent's own YouTube Live URL (registration-gated watch link; attendance is never claimed — YouTube exposes
   *     no per-viewer identity; creating the broadcast through the API is WAITING_EXTERNAL: the channel connection holds only the
   *     youtube.upload scope);
   *   · external_link — any other https meeting link; attendance honestly unverifiable.
   * The registration page and invitation copy are drafted by AI and held for APPROVAL (approveEventMarketing) — nothing is
   * published until a permitted approver says so.
   */
  title?: string
  virtualProvider?: string
  timezone?: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    // The live open_house_events.event_type CHECK after m924 (scripts/check-vocabularies.ts) = the C22 registry's EVENT_KINDS — one
    // spelling, validated before any write (scripts/event-producer-registry-guard.ts holds CHECK = registry = this list).
    // Wave 148Z: + client_event (the sixth kind — m926 widens the CHECK; WRITTEN, NOT APPLIED until the integrator applies it).
    const OPEN_HOUSE_EVENT_TYPES = ["open_house", "broker_open", "virtual_open_house", "webinar", "education_session", "client_event"] as const
    const eventType = (params.eventType ?? "open_house") as (typeof OPEN_HOUSE_EVENT_TYPES)[number]
    if (!(OPEN_HOUSE_EVENT_TYPES as readonly string[]).includes(eventType)) return { success: false, error: `Unknown event type "${params.eventType}"` }
    const spec = EVENT_PRODUCER_REGISTRY[eventType]
    const listingId = (params.listingId ?? "").trim() || null
    if (spec.listing === "required" && !listingId) return { success: false, error: `A ${spec.label.toLowerCase()} is held at one of your listings — choose the listing` }
    const title = (params.title ?? "").trim().slice(0, 200) || null
    if (spec.listing === "none" && !title) return { success: false, error: `A ${spec.label.toLowerCase()} needs a title` }

    // The host of an ONLINE event (education sessions are online only when a host is named).
    const requested = (params.virtualProvider ?? "").trim()
    const provider: VirtualProvider | null = spec.venue === "in_person" ? null
      : isVirtualProvider(requested) ? requested
      : spec.venue === "online" ? (params.joinUrl ? "external_link" : "zoom") : null
    if (requested && !isVirtualProvider(requested)) return { success: false, error: `Unknown host "${requested}"` }
    let joinUrl: string | null = null
    if (provider === "external_link" || provider === "youtube") {
      try { const u = new URL(String(params.joinUrl ?? "")); if (u.protocol === "https:") joinUrl = u.toString() } catch { joinUrl = null }
      if (!joinUrl) return { success: false, error: provider === "youtube" ? "A YouTube Live event needs its https watch link" : "An online event needs its https join link" }
      if (provider === "youtube" && !/^(www\.|m\.)?(youtube\.com|youtu\.be)$/i.test(new URL(joinUrl).hostname)) return { success: false, error: "That is not a YouTube link" }
    }

    const service = createServiceClient()

    // Verify listing belongs to caller's brokerage
    let propertyAddress: string | null = null
    if (listingId) {
      const { data: listing, error: listingErr } = await service
        .from("listings")
        .select("brokerage_id, address, city, state")
        .eq("id", listingId)
        .maybeSingle()
      if (listingErr) return { success: false, error: `Could not read the listing: ${listingErr.message}` }
      if (!listing || listing.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Listing not found or not authorized" }
      }
      propertyAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ") || null
    }

    const { data: event, error } = await service
      .from("open_house_events")
      .insert({
        listing_id: listingId,
        brokerage_id: ctx.brokerageId,
        agent_id: ctx.agentId ?? null,
        created_by: ctx.userId,
        event_date: params.date,
        start_time: params.startTime,
        end_time: params.endTime,
        max_attendees: params.maxAttendees ?? null,
        notes: params.agentNotes ?? null,
        description: params.publicDescription ?? null,
        status: "scheduled",
        registration_required: spec.registration.required,
        event_type: eventType,
        ...(title ? { title } : {}),
        ...(propertyAddress ? { property_address: propertyAddress } : {}),
        ...(params.timezone ? { timezone: params.timezone } : {}),
        ...(provider ? { virtual_provider: provider, allow_walkins: false } : {}),
        ...(joinUrl ? { check_in_url: joinUrl } : {}),
      })
      .select()
      .maybeSingle()

    if (error) {
      console.error("[createOpenHouse] insert error:", error.message)
      return { success: false, error: error.message }
    }
    if (!event) return { success: false, error: "Failed to create open house" }

    const warnings: string[] = []
    // ── ZOOM: capability → router → provider (law 3), a REAL meeting with registration, ledgered (law 5) ──
    if (provider === "zoom") {
      const hosted = await hostEventOnZoom(service, { event: event as Record<string, any>, userId: ctx.userId ?? null, brokerageId: ctx.brokerageId })
      if (!hosted.ok) {
        // Honest: the event exists (it can still take a pasted link), but no fabricated Zoom link stands in.
        warnings.push(hosted.detail)
      } else if (!hosted.registrationEnabled) {
        warnings.push("Zoom created the meeting WITHOUT registration (the account cannot register attendees — Zoom answered approval_type 2). Registrants will join on the shared link and attendance can be verified only for people signed in to Zoom with the email they registered with.")
      }
    }

    // ── The registration page + invitations: drafted by AI, held for approval (never published here) ──
    if (spec.registration.required) {
      const { draftEventMarketing } = await import("@/lib/open-house/event-marketing")
      const drafted = await draftEventMarketing(service, (event as { id: string }).id)
      if (!drafted.ok) warnings.push(`registration page copy not drafted: ${drafted.error}`)
      else if (drafted.status === "needs_revision") warnings.push("the drafted copy needs your edits before it can be approved (see the fair-housing / missing-field notes)")
    }

    // Send invites synchronously — fire-and-forget loses the request-scoped cookie context. An event that requires registration
    // waits for its approved copy (approveEventMarketing) — no invitation leaves before a person approves the words.
    if (params.sendInvites && event.id && !spec.registration.required) {
      await sendOpenHouseInvites(event.id).catch((err) => {
        console.warn("[createOpenHouse] invite send failed (non-blocking):", err instanceof Error ? err.message : err)
      })
    }

    revalidatePath("/dashboard/open-houses")
    return { success: true, event, warnings }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

/**
 * Host one event on Zoom: routeCapability("virtual_event_hosting") (a Zoom in a failing cool-down is routed around — the event
 * stays, honestly without a Zoom link), then the REAL meeting with registration on the tenant's own account, ledgered once per
 * event. Never exported: a "use server" export is a public endpoint, and this is a step of createOpenHouse.
 */
async function hostEventOnZoom(
  service: ReturnType<typeof createServiceClient>,
  a: { event: Record<string, any>; userId: string | null; brokerageId: string },
): Promise<{ ok: true; registrationEnabled: boolean } | { ok: false; detail: string }> {
  const { routeCapability } = await import("@/lib/ai-isa/property-lookup-rail")
  const { loadProviderHealth } = await import("@/lib/agentic-os/connector-gateway")
  const route = routeCapability("virtual_event_hosting", { zoom: await loadProviderHealth("zoom") })
  if (!route.providers.includes("zoom")) {
    return { ok: false, detail: `Zoom is unavailable right now (${route.skipped.map((s) => s.reason).join("; ")}) — paste a meeting link instead, or retry later` }
  }
  const { data: me } = await service.from("users").select("team_id").eq("id", a.userId ?? "").maybeSingle()
  const { start, end } = eventWindow(a.event as never)
  if (!start) return { ok: false, detail: "the event has no start time Zoom can schedule" }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const { ensureZoomMeetingForAppointment } = await import("@/lib/connections/zoom")
  const outcome = await withActionLedger(
    {
      brokerageId: a.brokerageId, action: "open_house.virtual_meeting.create", actor: { type: "user", userId: a.userId },
      subject: { type: "open_house_event", id: a.event.id }, cycle: "zoom_meeting", channel: "zoom",
      reasonCode: "HUMAN_REQUESTED", reasonDetail: `the agent scheduled a ${a.event.event_type} hosted on Zoom`, systemSource: "open_house_scheduler",
      detail: { capability: "virtual_event_hosting", provider: "zoom" },
    },
    () => ensureZoomMeetingForAppointment(service, {
      // A TENANT event hosts on the tenant cascade (agent → team → brokerage) — never the platform's own account.
      host: { scope: "agent", agentUserId: a.userId, teamId: (me as { team_id?: string | null } | null)?.team_id ?? null, brokerageId: a.brokerageId },
      topic: String(a.event.title ?? a.event.property_address ?? "Virtual open house").slice(0, 200),
      startAt: start, endAt: end, timezoneName: a.event.timezone ?? null, registration: true,
    }),
    {
      settle: (r) => (r.created ? { status: "executed", outcome: "zoom_meeting_created", provider: "zoom", providerRef: r.meetingId } : { status: "failed", outcome: r.reason, provider: "zoom", error: r.detail }),
      replay: (claim) => ({ created: false as const, reason: "api_error" as const, detail: claim.kind === "refused" ? `the action ledger refused: ${claim.error}` : "a Zoom meeting was already requested for this event" }),
    },
  )
  if (!outcome.created) return { ok: false, detail: outcome.detail }
  const registrationEnabled = outcome.registrationEnabled === true
  const { data: upd, error: updErr } = await service.from("open_house_events").update({
    provider_meeting_id: outcome.meetingId,
    check_in_url: outcome.joinUrl,
    provider_meta: { host_owner_type: outcome.hostOwnerType, host_owner_id: outcome.hostOwnerId, registration_enabled: registrationEnabled, provider_join_url: outcome.joinUrl },
  }).eq("id", a.event.id).eq("brokerage_id", a.brokerageId).select("id")
  if (updErr || !Array.isArray(upd) || upd.length !== 1) return { ok: false, detail: `the Zoom meeting was created but not stored on the event: ${updErr?.message ?? "matched no row"}` }
  return { ok: true, registrationEnabled }
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROVE THE EVENT'S PAGE + INVITATIONS (C22 + C5) — the human's publication decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A permitted approver (lib/kernel/approval-authority.ts approverFor, asset kind "publication", scoped to the event's agent)
 * approves the AI-drafted copy — optionally with their own edits, re-scanned for fair housing and the placeholders a send needs.
 * Approval publishes the registration page (is_published). Refused with a reason; ledgered once per approval.
 */
export async function approveEventMarketing(eventId: string, edits?: Record<string, unknown>): Promise<{ success: boolean; error?: string; findings?: unknown[] }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { success: false, error: "Not authenticated" }
    const service = createServiceClient()
    const { data: ev, error } = await service.from("open_house_events").select("id, brokerage_id, agent_id, event_type, virtual_provider, marketing_assets").eq("id", eventId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (error) return { success: false, error: `Could not read the event: ${error.message}` }
    if (!ev) return { success: false, error: "Event not found" }
    const { approverFor } = await import("@/lib/kernel/approval-authority")
    const decision = await approverFor({ brokerageId: ctx.brokerageId, assetKind: "publication", scope: { agentId: ev.agent_id ?? null }, client: service })
    if (!decision.ok) return { success: false, error: decision.reason }
    if (!decision.permittedUserIds.includes(ctx.userId)) return { success: false, error: `You are not an approver of this event's page: ${decision.reason}` }
    const assets = (ev.marketing_assets ?? {}) as Record<string, any>
    const { PUBLISHED_COPY_FIELDS, scanEventCopy } = await import("@/lib/open-house/event-marketing")
    const base = (assets.draft ?? {}) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...base }
    for (const f of [...PUBLISHED_COPY_FIELDS, "what_you_will_learn"] as const) if (edits && f in edits) merged[f] = edits[f]
    const scan = scanEventCopy(merged, { online: isOnlineEvent(ev.event_type, ev.virtual_provider) })
    if (scan.blocking) return { success: false, error: `Not approvable yet: ${[...scan.findings.filter((x) => x.severity === "high").map((x) => `fair housing — "${x.phrase}" in ${x.field} (${x.fix})`), ...scan.missing.map((m) => `missing ${m}`)].join("; ")}`, findings: scan.findings }
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const now = new Date().toISOString()
    const r = await withActionLedger(
      {
        brokerageId: ctx.brokerageId, action: "open_house.event_marketing.approve", actor: { type: "user", userId: ctx.userId },
        subject: { type: "open_house_event", id: ev.id }, idempotencyKey: `open_house.event_marketing.approve:${ev.id}:${createHash("sha256").update(JSON.stringify(merged)).digest("hex").slice(0, 24)}`,
        reasonCode: "HUMAN_REQUESTED", reasonDetail: `approved as ${decision.tier}`, systemSource: "open_house_scheduler", detail: { warnings: scan.findings.length },
      },
      async () => {
        // marketing_assets.status is the COPY's approval state (awaiting_approval | needs_revision | approved), not the event's
        // open_house_events.status (which this update leaves alone) — built outside the update so the two are never confused.
        const approvedAssets: Record<string, unknown> = { ...assets, approved: merged, fair_housing: scan.findings, approved_by: ctx.userId, approved_at: now }
        approvedAssets.status = "approved"
        const { data: upd, error: uErr } = await service.from("open_house_events").update({
          marketing_assets: approvedAssets,
          is_published: true, published_at: now,
        }).eq("id", ev.id).eq("brokerage_id", ctx.brokerageId).select("id")
        return uErr || !Array.isArray(upd) || upd.length !== 1 ? { ok: false as const, error: uErr?.message ?? "matched no row" } : { ok: true as const }
      },
      {
        settle: (x) => (x.ok ? { status: "executed", outcome: "event_marketing_approved" } : { status: "failed", outcome: "approval_not_stored", error: x.error }),
        replay: (claim) => (claim.kind === "refused" ? { ok: false as const, error: `the action ledger refused: ${claim.error}` } : { ok: true as const }),
      },
    )
    if (!r.ok) return { success: false, error: r.error }
    revalidatePath("/dashboard/open-houses")
    return { success: true, findings: scan.findings }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

/**
 * Record the event's recording (https) and deliver the promised replay to every registration, once each — only now that the asset
 * exists (C22 deliverables; never "delivered" without it). Tenant from the session; the event must be the caller's brokerage's.
 */
export async function setEventReplay(eventId: string, replayUrl: string): Promise<{ success: boolean; error?: string; delivered?: number; skipped?: number }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }
    let url: string | null = null
    try { const u = new URL(String(replayUrl ?? "")); if (u.protocol === "https:") url = u.toString() } catch { url = null }
    if (!url) return { success: false, error: "The recording needs an https link" }
    const service = createServiceClient()
    // The cancelOpenHouse scope: a broker / admin may act on any of the brokerage's events; an agent only on their own.
    // No `superadmin` user_type here: platform staff live in platform_role (CLAUDE.md §4; the one discriminator is
    // lib/platform/platform-staff-roster.ts isPlatformSuperadminIdentity) and act on a tenant's event through impersonation.
    const isBrokerOrAdmin = ctx.userType === "broker" || ctx.userType === "admin"
    if (!isBrokerOrAdmin && !ctx.agentId) return { success: false, error: "Unauthorized" }
    let q = service.from("open_house_events").update({ replay_url: url }).eq("id", eventId).eq("brokerage_id", ctx.brokerageId)
    if (!isBrokerOrAdmin) q = q.eq("agent_id", ctx.agentId as string)
    const { data: upd, error } = await q.select("id")
    if (error) return { success: false, error: error.message }
    if (!Array.isArray(upd) || upd.length !== 1) return { success: false, error: "Event not found" }
    const { deliverEventReplay } = await import("@/lib/open-house/event-attendance")
    const r = await deliverEventReplay(service, eventId)
    return { success: true, delivered: r.delivered, skipped: r.skipped }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET OPEN HOUSES (agent-scoped, with attendee counts)
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouses(): Promise<{
  success: boolean
  events?: OpenHouseEvent[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    // Build base query — agent sees their own events; broker sees all brokerage events
    let query = service
      .from("open_house_events")
      .select(`
        id,
        listing_id,
        brokerage_id,
        agent_id,
        event_date,
        start_time,
        end_time,
        status,
        description,
        notes,
        max_attendees,
        created_at,
        event_type,
        title,
        virtual_provider,
        is_published,
        marketing_assets,
        replay_url,
        listings (
          id,
          address,
          city,
          state,
          zip,
          list_price
        )
      `)
      .order("event_date", { ascending: true })
      .order("start_time", { ascending: true })

    if (ctx.userType === "agent" && !ctx.agentId) {
      return { success: false, error: "Agent identity required" }
    } else if (ctx.userType === "agent" && ctx.agentId) {
      query = query.eq("agent_id", ctx.agentId)
    } else if (ctx.brokerageId) {
      query = query.eq("brokerage_id", ctx.brokerageId)
    } else {
      // Non-agent with no brokerageId — deny rather than expose all events (service client has no RLS)
      return { success: false, error: "Brokerage context required" }
    }

    const { data: events, error } = await query

    if (error) {
      console.error("[getOpenHouses] query error:", error.message)
      return { success: false, error: error.message }
    }

    const eventList = events ?? []
    if (eventList.length === 0) return { success: true, events: [] }

    // Fetch attendee counts
    const eventIds = eventList.map((e) => e.id)
    const { data: attendees } = await service
      .from("open_house_attendees")
      .select("event_id")
      .in("event_id", eventIds)

    // Fetch avg feedback per event from attendees (feedback_rating column)
    const { data: feedbackRows } = await service
      .from("open_house_attendees")
      .select("event_id, feedback_rating")
      .in("event_id", eventIds)
      .not("feedback_rating", "is", null)

    // Build lookup maps
    const attendeeCountMap: Record<string, number> = {}
    for (const a of attendees ?? []) {
      attendeeCountMap[a.event_id] = (attendeeCountMap[a.event_id] ?? 0) + 1
    }

    const feedbackSumMap: Record<string, { sum: number; count: number }> = {}
    for (const f of feedbackRows ?? []) {
      if (f.feedback_rating != null) {
        const cur = feedbackSumMap[f.event_id] ?? { sum: 0, count: 0 }
        feedbackSumMap[f.event_id] = { sum: cur.sum + f.feedback_rating, count: cur.count + 1 }
      }
    }

    const enriched: OpenHouseEvent[] = eventList.map((e) => ({
      id: e.id,
      listing_id: e.listing_id,
      brokerage_id: e.brokerage_id,
      agent_id: e.agent_id,
      event_date: e.event_date,
      start_time: e.start_time,
      end_time: e.end_time,
      status: e.status ?? "scheduled",
      description: e.description,
      notes: e.notes,
      max_attendees: e.max_attendees,
      created_at: e.created_at,
      listing: Array.isArray(e.listings) ? (e.listings[0] ?? null) : (e.listings as OpenHouseEvent["listing"] ?? null),
      attendee_count: attendeeCountMap[e.id] ?? 0,
      avg_feedback: feedbackSumMap[e.id]
        ? Math.round((feedbackSumMap[e.id].sum / feedbackSumMap[e.id].count) * 10) / 10
        : null,
    }))

    return { success: true, events: enriched }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDEES FOR AN EVENT
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouseAttendees(openHouseId: string): Promise<{
  success: boolean
  attendees?: OpenHouseAttendee[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    // Verify the event belongs to the caller's brokerage
    const { data: eventCheck } = await service
      .from("open_house_events")
      .select("brokerage_id, agent_id")
      .eq("id", openHouseId)
      .maybeSingle()

    if (!eventCheck) return { success: false, error: "Event not found" }
    if (!ctx.brokerageId || eventCheck.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    if (ctx.userType === "agent") {
      if (!ctx.agentId || eventCheck.agent_id !== ctx.agentId) {
        return { success: false, error: "Unauthorized" }
      }
    }

    const { data, error } = await service
      .from("open_house_attendees")
      .select(
        "id, event_id, name, email, phone, contact_id, working_with_agent, interest_level, ai_lead_score, check_in_time, notes, feedback_rating, feedback_comments"
      )
      .eq("event_id", openHouseId)
      .order("check_in_time", { ascending: false })

    if (error) return { success: false, error: error.message }

    return { success: true, attendees: (data ?? []) as OpenHouseAttendee[] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET FEEDBACK FOR AN EVENT
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouseFeedback(openHouseId: string): Promise<{
  success: boolean
  feedback?: OpenHouseFeedback[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    // Verify the event belongs to the caller's brokerage
    const { data: eventCheck } = await service
      .from("open_house_events")
      .select("brokerage_id, agent_id")
      .eq("id", openHouseId)
      .maybeSingle()

    if (!eventCheck) return { success: false, error: "Event not found" }
    if (!ctx.brokerageId || eventCheck.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    if (ctx.userType === "agent" && !ctx.agentId) {
      return { success: false, error: "Agent identity required" }
    }
    if (ctx.userType === "agent" && ctx.agentId && eventCheck.agent_id !== ctx.agentId) {
      return { success: false, error: "Unauthorized" }
    }

    // Try open_house_feedback table first (may exist), else fall back to
    // feedback_rating/feedback_comments columns on open_house_attendees
    const { data: fbRows, error: fbError } = await service
      .from("open_house_feedback")
      .select("id, attendee_id, event_id, rating, liked_most, concerns, price_opinion, interested_in_offer, submitted_at:created_at")
      .eq("event_id", openHouseId)
      .order("created_at", { ascending: false })

    if (!fbError && fbRows) {
      // Enrich with attendee name/email
      const attendeeIds = fbRows.map((f) => f.attendee_id).filter(Boolean)
      let attendeeMap: Record<string, { name: string | null; email: string | null }> = {}
      if (attendeeIds.length > 0) {
        const { data: attendeeRows } = await service
          .from("open_house_attendees")
          .select("id, name, email")
          .in("id", attendeeIds)
        for (const a of attendeeRows ?? []) {
          attendeeMap[a.id] = { name: a.name, email: a.email }
        }
      }

      const feedback: OpenHouseFeedback[] = fbRows.map((f) => ({
        id: f.id,
        attendee_id: f.attendee_id,
        event_id: f.event_id,
        rating: f.rating,
        liked_most: f.liked_most,
        concerns: f.concerns,
        price_opinion: f.price_opinion,
        interested_in_offer: f.interested_in_offer,
        submitted_at: f.submitted_at,
        attendee_name: attendeeMap[f.attendee_id]?.name ?? null,
        attendee_email: attendeeMap[f.attendee_id]?.email ?? null,
      }))
      return { success: true, feedback }
    }

    // Fallback: read from attendees table
    const { data: attendees, error: attError } = await service
      .from("open_house_attendees")
      .select("id, event_id, name, email, feedback_rating, feedback_comments, check_in_time")
      .eq("event_id", openHouseId)
      .not("feedback_rating", "is", null)

    if (attError) return { success: false, error: attError.message }

    const feedback: OpenHouseFeedback[] = (attendees ?? []).map((a) => ({
      id: a.id,
      attendee_id: a.id,
      event_id: a.event_id,
      rating: a.feedback_rating,
      liked_most: null,
      concerns: a.feedback_comments,
      price_opinion: null,
      interested_in_offer: null,
      submitted_at: a.check_in_time ?? new Date().toISOString(),
      attendee_name: a.name,
      attendee_email: a.email,
    }))

    return { success: true, feedback }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND INVITES (fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────

export async function sendOpenHouseInvites(openHouseId: string): Promise<{
  success: boolean
  sent?: number
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }

    const service = createServiceClient()

    // Fetch the event to get listing_id.
    //
    // DESTRUCTURED: supabase-js RESOLVES a refused read, so `const { data:
    // event }` alone reports "permission denied" as `event === null`, which the
    // next line renders as "Event not found" — an authorization failure wearing
    // a missing-record message, sending the operator to look for a row that is
    // sitting right there.
    const { data: event, error: eventError } = await service
      .from("open_house_events")
      .select("id, listing_id, brokerage_id, event_date")
      .eq("id", openHouseId)
      .maybeSingle()

    if (eventError) {
      return { success: false, error: `Could not read the open house: ${eventError.message}` }
    }
    if (!event) return { success: false, error: "Event not found" }

    if (event.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    // Find buyer contacts with active searches in brokerage
    // When caller is an agent, scope to their own contacts only
    if (ctx.userType === "agent" && !ctx.agentId) {
      return { success: false, error: "Agent identity required" }
    }

    let contactsQuery = service
      .from("contacts")
      .select("id, first_name, last_name, email")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("contact_type", "buyer")
      .not("email", "is", null)
      .limit(100)

    if (ctx.agentId) {
      contactsQuery = contactsQuery.eq("agent_id", ctx.agentId)
    }

    const { data: contacts } = await contactsQuery

    if (!contacts || contacts.length === 0) return { success: true, sent: 0 }

    // Insert invitations (skip duplicates via on-conflict)
    //
    // THE TENANT IS THE EVENT'S, RESOLVED THROUGH THE RECORD — not the caller's.
    // An invitation is filed against `event_id`, so the row belongs to whichever
    // brokerage owns that open house. The two values are provably equal HERE,
    // because the guard 25 lines above returns "Unauthorized" unless
    // `event.brokerage_id === ctx.brokerageId` — so this is not a live
    // cross-tenant write today. It is stamped from the record anyway for the
    // reason settled in wave 26: of the 28 brokerage-equality readers in this
    // class, 26 compare the CALLER's `users.brokerage_id` and 2 compare the
    // RECORD's own, they coincide only under the tenancy invariant, and the
    // record-based answer is also what the DB-side triggers compute. Resolving
    // through the record satisfies both families, and it keeps this insert
    // correct if the guard above is ever loosened (e.g. to let a platform admin
    // send invites for a brokerage that is not their own) — at which point
    // `ctx.brokerageId` would start filing rows across the boundary silently.
    //
    // `agent_id` stays the CALLER's: it records who sent the invitation, which
    // is a different question from which tenant owns it, and `agents.id` and
    // `brokerages.id` are disjoint id spaces that must never be bridged.
    const invitations = contacts.map((c) => ({
      event_id: openHouseId,
      contact_id: c.id,
      brokerage_id: event.brokerage_id,
      agent_id: ctx.agentId,
      channel: "email",
      status: "pending",
      sent_at: new Date().toISOString(),
    }))

    const { error: upsertError } = await service
      .from("open_house_invitations")
      .upsert(invitations, { onConflict: "event_id,contact_id,channel", ignoreDuplicates: true })
    if (upsertError) {
      console.error("[sendOpenHouseInvites] upsert failed:", upsertError.message)
      return { success: false, error: upsertError.message }
    }

    // Update event status
    const { error: statusError } = await service
      .from("open_house_events")
      .update({ status: "marketing" })
      .eq("id", openHouseId)
    if (statusError) {
      // Non-fatal — invites were sent, just status flag failed
      console.warn("[sendOpenHouseInvites] status update failed:", statusError.message)
    }

    revalidatePath("/dashboard/open-houses")
    return { success: true, sent: contacts.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECORD ATTENDEE — REMOVED. Both of its branches have named, working homes.
//
// It could never insert an attendee at all: its payload omits contact_id, and
// open_house_attendees.contact_id is NOT NULL — probed live with the exact
// insert shape and refused with SQLSTATE 23502. The table holds zero rows.
//
//   authenticated agent walk-in  ->  lib/kernel/open-house.ts
//                                    resolveOrCreateOpenHouseContact +
//                                    createOpenHouseAttendeeFromContact,
//                                    wired to /dashboard/open-houses. Supplies
//                                    contact_id and the tenant stamp this one
//                                    omitted.
//   public QR / kiosk check-in   ->  app/api/open-house/attend/route.ts, which
//                                    resolves the contact, upserts on
//                                    (event_id, contact_id) and writes the
//                                    lifecycle event. It REQUIRES tcpaConsent
//                                    and answers 400 without it.
//
// The one thing this function did that the kernel did not was gate phone
// storage on TCPA consent. That was MOVED onto createOpenHouseAttendeeFromContact
// (and surfaced as a consent checkbox on the walk-in form) BEFORE this was
// removed — otherwise retiring it would have started storing walk-in mobile
// numbers with consent recorded as false.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GET AGENT LISTINGS (for the schedule dialog dropdown)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAgentListings(): Promise<{
  success: boolean
  listings?: Array<{ id: string; address: string; city: string | null; state: string | null; status: string }>
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    let query = service
      .from("listings")
      .select("id, address, city, state, status")
      .in("status", ["active", "coming_soon", "pending"])
      .order("created_at", { ascending: false })
      .limit(50)

    if (ctx.agentId) {
      query = query.eq("agent_id", ctx.agentId)
    } else if (ctx.brokerageId) {
      query = query.eq("brokerage_id", ctx.brokerageId)
    } else {
      // No scoping context — deny rather than expose all listings via service client
      return { success: false, error: "No scoping context available" }
    }

    const { data, error } = await query

    if (error) return { success: false, error: error.message }
    return { success: true, listings: data ?? [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL OPEN HOUSE
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelOpenHouse(
  openHouseId: string,
  /** C23 (wave 148, lane 148I — owner ruling 13): cancelling is a manual status change — the person says why. */
  change?: { reason?: string | null },
): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
    const brokerageId = ctx.brokerageId

    const service = createServiceClient()

    // Scope update to the user's brokerage; non-broker agents are further
    // scoped to only their own events so they cannot cancel others' events.
    const isBrokerOrAdmin = ctx.userType === "broker" || ctx.userType === "admin" || ctx.userType === "superadmin"
    if (!isBrokerOrAdmin && !ctx.agentId) return { success: false, error: "Unauthorized" }

    // The event as it stands, through the SAME scope the write uses — its status is the C23 `from`, its updated_at the
    // ledger's row version (the same click twice replays; a later cancel of a re-scheduled event is a new action).
    let read = service.from("open_house_events").select("id, status, updated_at").eq("id", openHouseId).eq("brokerage_id", brokerageId)
    if (!isBrokerOrAdmin) read = read.eq("agent_id", ctx.agentId as string)
    const { data: current, error: readErr } = await read.maybeSingle()
    if (readErr) return { success: false, error: readErr.message }
    if (!current) return { success: false, error: "Event not found or not cancellable" }

    const [{ overrideStatus }, { withActionLedger }] = await Promise.all([import("@/lib/kernel/status-override"), import("@/lib/kernel/action-ledger")])
    const r = await overrideStatus(
      { entity: "open_house_event", from: (current as { status: string | null }).status, to: "cancelled", reason: change?.reason ?? null, actor: { userId: ctx.userId ?? null, userType: ctx.userType ?? null } },
      {
        brokerageId, subject: { type: "open_house_event", id: openHouseId }, rowVersion: (current as { updated_at?: string | null }).updated_at ?? null,
        systemSource: "open-house", action: "open_house.event.cancel",
        apply: async () => {
          let query = service
            .from("open_house_events")
            .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancellation_reason: (change?.reason ?? "").trim().slice(0, 500) })
            .eq("id", openHouseId)
            .eq("brokerage_id", brokerageId)
          if (!isBrokerOrAdmin) query = query.eq("agent_id", ctx.agentId as string)
          const { data: updated, error } = await query.select("id")
          if (error) return { ok: false, error: error.message }
          if (!updated?.length) return { ok: false, error: "Event not found or not cancellable" }
          return { ok: true }
        },
      },
      { ledger: withActionLedger, client: service },
    )
    if (!r.ok) return { success: false, error: r.message }

    revalidatePath("/dashboard/open-houses")
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}
