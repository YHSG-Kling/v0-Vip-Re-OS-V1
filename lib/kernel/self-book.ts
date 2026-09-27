// lib/kernel/self-book.ts
// ─────────────────────────────────────────────────────────────────────────────
// CLIENT SELF-BOOKING — the tour-automation hole closed. The availability
// engine (computeFreeSlots over the agent's own synced Google/Outlook calendar)
// existed and was never shown to a buyer: portal "requests" sat as pending
// items an agent had to manually action, and no buyer confirmation ever
// auto-sent. Now a buyer picks a REAL open slot on the portal property page and
// the showing books itself: request row (approved) + scheduled showing +
// calendar event on the agent's own calendar + portal confirmation — the
// Zillow-grade "book a tour" flow, on the agent's true availability.
//
// GOVERNANCE: opt-in per brokerage (brokerage_settings.settings.self_booking
// {enabled} — default OFF, requests stay human-confirmed until the broker
// flips it). The NAR-settlement BBA gate is enforced on the booking exactly as
// on the request path. Slots are re-verified at booking time (never trust the
// browser's stale list). Double-book protection = calendar busy ∪ already-
// scheduled showings.

import { type FreeSlot } from "@/lib/providers/calendar/free-slots"

export const SELF_BOOK_DEFAULTS = {
  durationMinutes: 45,
  leadTimeHours: 3,
  windowDays: 7,
  maxPerDay: 3,
  maxTotal: 12,
}

/** PURE: is self-booking on for this brokerage's settings jsonb? Default OFF. */
export function selfBookingEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  return (settings as any)?.self_booking?.enabled === true
}

/** PURE: trim raw free slots to what a buyer may book — respects lead time,
 *  caps per day (an agent shouldn't be bookable wall-to-wall), caps total. */
export function filterBookableSlots(
  slots: FreeSlot[],
  opts: { nowMs: number; leadTimeHours?: number; maxPerDay?: number; maxTotal?: number } ,
): FreeSlot[] {
  const leadMs = (opts.leadTimeHours ?? SELF_BOOK_DEFAULTS.leadTimeHours) * 3_600_000
  const maxPerDay = opts.maxPerDay ?? SELF_BOOK_DEFAULTS.maxPerDay
  const maxTotal = opts.maxTotal ?? SELF_BOOK_DEFAULTS.maxTotal
  const byDay = new Map<string, number>()
  const out: FreeSlot[] = []
  for (const s of slots) {
    if (new Date(s.startTime).getTime() < opts.nowMs + leadMs) continue
    const day = s.startTime.slice(0, 10)
    const used = byDay.get(day) ?? 0
    if (used >= maxPerDay) continue
    byDay.set(day, used + 1)
    out.push(s)
    if (out.length >= maxTotal) break
  }
  return out
}

/** PURE: drop slots that collide with already-scheduled showings. */
export function excludeShowingConflicts(
  slots: FreeSlot[],
  showings: Array<{ scheduled_at: string | null; duration_minutes: number | null }>,
): FreeSlot[] {
  const busy = showings
    .filter((s) => s.scheduled_at)
    .map((s) => {
      const start = new Date(s.scheduled_at!).getTime()
      return { start, end: start + (s.duration_minutes ?? 45) * 60_000 }
    })
  return slots.filter((slot) => {
    const s = new Date(slot.startTime).getTime()
    const e = new Date(slot.endTime).getTime()
    return !busy.some((b) => s < b.end && e > b.start)
  })
}

export interface BookableSlotsResult {
  ok: boolean
  enabled: boolean
  slots: FreeSlot[]
  reason?: string
  agentUserId?: string
  agentRowId?: string
}

/** Load a listing's REAL bookable slots: the listing agent's calendar free/busy
 *  ∪ their scheduled showings, trimmed to buyer-bookable. Honest when the agent
 *  has no connected calendar (enabled:false with the reason). */
export async function loadBookableSlots(svc: any, listingId: string): Promise<BookableSlotsResult> {
  const { data: listing } = await svc.from("listings")
    .select("id, brokerage_id, agent_id, address").eq("id", listingId).maybeSingle()
  if (!listing) return { ok: false, enabled: false, slots: [], reason: "Listing not found" }
  const l = listing as any

  const { data: bs } = await svc.from("brokerage_settings")
    .select("settings").eq("brokerage_id", l.brokerage_id).maybeSingle()
  if (!selfBookingEnabled((bs as any)?.settings)) {
    return { ok: true, enabled: false, slots: [], reason: "Self-booking not enabled — requests go to the agent to confirm" }
  }

  const { data: agent } = await svc.from("agents").select("id, user_id").eq("id", l.agent_id).maybeSingle()
  const agentUserId = (agent as any)?.user_id
  if (!agentUserId) return { ok: true, enabled: false, slots: [], reason: "No listing agent on file" }

  const now = new Date()
  const end = new Date(now.getTime() + SELF_BOOK_DEFAULTS.windowDays * 86_400_000)
  const { getAvailabilityViaPersonal } = await import("@/lib/providers/calendar/personal-calendar")
  const avail = await getAvailabilityViaPersonal(agentUserId, {
    startDate: now.toISOString(), endDate: end.toISOString(),
    durationMinutes: SELF_BOOK_DEFAULTS.durationMinutes,
  }).catch(() => null)
  if (!avail?.slots) {
    return { ok: true, enabled: false, slots: [], reason: "The agent's calendar isn't connected — requests go to the agent to confirm" }
  }

  const { data: existing } = await svc.from("showings")
    .select("scheduled_at, duration_minutes")
    .eq("agent_id", l.agent_id)
    .gte("scheduled_at", now.toISOString()).lte("scheduled_at", end.toISOString())
    .in("status", ["scheduled", "confirmed"]).limit(200)

  const slots = filterBookableSlots(
    excludeShowingConflicts(avail.slots as FreeSlot[], (existing ?? []) as any[]),
    { nowMs: now.getTime() },
  )
  return { ok: true, enabled: true, slots, agentUserId, agentRowId: (agent as any).id }
}

export interface BookResult { ok: boolean; showingId?: string; error?: string; errorCode?: string }

/**
 * WHERE A SELF-BOOKING CAME FROM (lane 86D). The portal property page was the
 * only door; the AI agents' request_showing tool (lib/ai-isa/customer-context-
 * tools.ts — chat, email, widget, portal assistant, D-ID avatar, voice tool
 * round) now books through THIS SAME function when the brokerage has opted in,
 * so the attribution rides the row in the live vocabularies
 * (showing_requests.source 'message' = booked inside a conversation;
 * showings.sync_source 'ai_scheduler'), never a second booking writer.
 */
type ShowingBookingChannel = "portal" | "ai_agent"

const BOOKING_CHANNEL_COPY: Record<ShowingBookingChannel, {
  requestSource: string; requestMessage: string; syncSource: string | null; showingNote: string; notifyTitle: string; bookedBy: string
}> = {
  portal: {
    requestSource: "buyer_portal",
    requestMessage: "Self-booked from the portal against the agent's live availability.",
    syncSource: null,
    showingNote: "Booked by the client from the portal (live availability).",
    notifyTitle: "A client booked a showing on your calendar",
    bookedBy: "from the portal",
  },
  ai_agent: {
    requestSource: "message",
    requestMessage: "Booked in conversation by the AI assistant against the agent's live availability.",
    syncSource: "ai_scheduler",
    showingNote: "Booked by the AI assistant in conversation (live availability).",
    notifyTitle: "The AI assistant booked a showing on your calendar",
    bookedBy: "with the AI assistant",
  },
}

/** Book one verified slot: BBA gate → re-verify the slot is still open →
 *  approved request + scheduled showing + agent-calendar event (best-effort) +
 *  portal confirmation + agent notification. */
export async function bookShowingSlot(
  svc: any,
  params: { listingId: string; contactId: string; slotStartIso: string; via?: ShowingBookingChannel },
): Promise<BookResult> {
  const copy = BOOKING_CHANNEL_COPY[params.via ?? "portal"]
  const avail = await loadBookableSlots(svc, params.listingId)
  if (!avail.enabled) return { ok: false, error: avail.reason ?? "Self-booking unavailable", errorCode: "not_enabled" }
  const slot = avail.slots.find((s) => s.startTime === params.slotStartIso)
  if (!slot) return { ok: false, error: "That time was just taken — pick another slot", errorCode: "slot_gone" }

  const { data: listing } = await svc.from("listings")
    .select("id, brokerage_id, agent_id, address, city").eq("id", params.listingId).maybeSingle()
  const l = listing as any
  const { data: contact } = await svc.from("contacts")
    .select("id, brokerage_id, agent_id, first_name, last_name").eq("id", params.contactId).maybeSingle()
  if (!contact || (contact as any).brokerage_id !== l.brokerage_id) {
    return { ok: false, error: "Contact not found", errorCode: "not_found" }
  }

  // NAR settlement: the BBA gate applies to a self-booked showing exactly as to
  // a requested one (skip only pre-representation contacts with no agent).
  if ((contact as any).agent_id) {
    const { requireActiveBBA } = await import("@/lib/buyer-broker/gate")
    const gate = await requireActiveBBA({
      buyerContactId: params.contactId,
      agentId: (contact as any).agent_id,
      brokerageId: l.brokerage_id,
    })
    if (!gate.allowed) return { ok: false, error: gate.reason ?? "A signed buyer agreement is needed first", errorCode: "bba_required" }
  }

  const when = new Date(slot.startTime)
  const { data: request } = await svc.from("showing_requests").insert({
    listing_id: l.id, contact_id: params.contactId, brokerage_id: l.brokerage_id,
    property_address: l.address, status: "approved",
    requested_date: slot.startTime.slice(0, 10),
    requested_start_time: slot.startTime.slice(11, 19),
    requested_end_time: slot.endTime.slice(11, 19),
    message: copy.requestMessage,
    source: copy.requestSource,
  }).select("id").maybeSingle()

  const { data: showing, error: sErr } = await svc.from("showings").insert({
    listing_id: l.id, contact_id: params.contactId, brokerage_id: l.brokerage_id,
    agent_id: l.agent_id, scheduled_at: slot.startTime,
    scheduled_date: slot.startTime.slice(0, 10), scheduled_time: slot.startTime.slice(11, 19),
    duration_minutes: SELF_BOOK_DEFAULTS.durationMinutes,
    status: "scheduled", is_confirmed: true, confirmed_at: new Date().toISOString(),
    scheduling_method: "self_book", notes: copy.showingNote,
    ...(copy.syncSource ? { sync_source: copy.syncSource } : {}),
  }).select("id").single()
  if (sErr || !showing) return { ok: false, error: sErr?.message ?? "Booking failed" }
  const showingId = (showing as any).id as string
  if (request) {
    await svc.from("showing_requests").update({ converted_showing_id: showingId }).eq("id", (request as any).id).then(undefined, () => {})
  }

  // The agent's own calendar gets the event (best-effort — booking stands regardless).
  try {
    const { createEventViaPersonal } = await import("@/lib/providers/calendar/personal-calendar")
    await createEventViaPersonal(avail.agentUserId!, {
      title: `Showing — ${l.address}`,
      description: `Self-booked by ${(contact as any).first_name ?? "your client"} ${(contact as any).last_name ?? ""} ${copy.bookedBy}.`,
      location: l.address,
      startTime: slot.startTime, endTime: slot.endTime,
    } as any)
  } catch { /* calendar is a mirror, not the source of truth */ }

  // Confirmation the buyer actually SEES + the agent's heads-up.
  // direction CHECK is agent_to_client; agent_id is a NOT NULL FK to agents.id
  // (the listing agent — guaranteed non-null by loadBookableSlots).
  await svc.from("client_portal_messages").insert({
    contact_id: params.contactId, brokerage_id: l.brokerage_id, agent_id: l.agent_id,
    direction: "agent_to_client", channel: "portal",
    body: `Your showing is booked ✓ You're confirmed for ${l.address} on ${when.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} at ${when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. Your agent's calendar is updated — reply here if anything changes.`,
  }).then(undefined, () => {})
  if (avail.agentUserId) {
    const { error: notifyError } = await svc.from("notifications").insert({
      user_id: avail.agentUserId, brokerage_id: l.brokerage_id, type: "showing_self_booked",
      title: copy.notifyTitle,
      body: `${(contact as any).first_name ?? "A client"} booked ${l.address} — ${when.toLocaleString()}. It's on your calendar.`,
      entity_type: "showing", entity_id: showingId, priority: "high", channel: "in_app", is_read: false,
    }).then(undefined, () => {})
    if (notifyError) console.warn("[self-book.ts] notifications insert refused — the bell will not ring:", notifyError.message)
  }
  return { ok: true, showingId }
}

// ─── A CALLER-NAMED TIME, JUDGED AGAINST THE AGENT'S REAL CALENDAR (lane 86D) ──
//
// The phone receptionist's `book` action (lib/voice/reception-brain.ts) takes
// the date/time the CALLER says out loud, and lib/voice/twilio-voice.ts
// bookShowingFromCall used to write it straight in as a CONFIRMED showing and
// text "You're booked" — never looking at the agent's calendar or their
// already-scheduled showings. Two callers could take the same 3pm; an agent in
// a closing got a showing on top of it. Competitors book on the agent's REAL
// availability (lane86D notes, Exa 2026); this engine already did for the
// portal (loadBookableSlots), the voice door just never asked.
//
// The hourly free-slot grid cannot judge a spoken "2:30", so the voice door
// reads the calendar's BUSY windows for the exact requested window and asks
// this pure rule. Anything short of "provably open" is NOT booked as
// confirmed: the agent gets the request to confirm, the caller is told it is
// pending — "nobody checked" never renders as "checked and fine" (§4).

type RequestedShowingVerdict =
  | { confirm: true; reason: "calendar_open" }
  | { confirm: false; reason: "no_calendar" | "calendar_unreadable" | "calendar_busy" | "showing_conflict" | "too_soon" }

/** PURE: may a caller-named window be booked as CONFIRMED on this agent? */
export function decideRequestedShowing(input: {
  startMs: number
  durationMinutes: number
  nowMs: number
  /** null = no personal calendar connected; "error" = the read failed. */
  busy: Array<{ start: number; end: number }> | null | "error"
  showings: Array<{ scheduled_at: string | null; duration_minutes: number | null }>
  leadTimeHours?: number
}): RequestedShowingVerdict {
  const endMs = input.startMs + input.durationMinutes * 60_000
  if (input.startMs < input.nowMs + (input.leadTimeHours ?? SELF_BOOK_DEFAULTS.leadTimeHours) * 3_600_000) return { confirm: false, reason: "too_soon" }
  if (input.busy === null) return { confirm: false, reason: "no_calendar" }
  if (input.busy === "error") return { confirm: false, reason: "calendar_unreadable" }
  if (input.busy.some((b) => input.startMs < b.end && endMs > b.start)) return { confirm: false, reason: "calendar_busy" }
  const slot: FreeSlot = { startTime: new Date(input.startMs).toISOString(), endTime: new Date(endMs).toISOString() }
  if (excludeShowingConflicts([slot], input.showings).length === 0) return { confirm: false, reason: "showing_conflict" }
  return { confirm: true, reason: "calendar_open" }
}

/** I/O: read what decideRequestedShowing needs for one agent (agents.id) and
 *  one requested window, then decide. Never throws — a failed read is a
 *  verdict ("calendar_unreadable"), not an exception on a live call. */
export async function checkRequestedShowingWindow(
  svc: any,
  params: { agentId: string; startIso: string; durationMinutes: number; now?: Date },
): Promise<RequestedShowingVerdict & { agentUserId: string | null }> {
  const now = params.now ?? new Date()
  const startMs = new Date(params.startIso).getTime()
  const endIso = new Date(startMs + params.durationMinutes * 60_000).toISOString()
  const { data: agent } = await svc.from("agents").select("id, user_id").eq("id", params.agentId).maybeSingle()
  const agentUserId = ((agent as any)?.user_id as string | undefined) ?? null
  let busy: Array<{ start: number; end: number }> | null | "error" = null
  if (agentUserId) {
    try {
      const { getBusyViaPersonal } = await import("@/lib/providers/calendar/personal-calendar")
      const read = await getBusyViaPersonal(agentUserId, { startDate: params.startIso, endDate: endIso })
      busy = read === null ? null : read.success ? read.busy : "error"
    } catch { busy = "error" }
  }
  // A showing that STARTED up to a day before the window can still overlap it.
  const { data: existing, error: showingsError } = await svc.from("showings")
    .select("scheduled_at, duration_minutes")
    .eq("agent_id", params.agentId)
    .gte("scheduled_at", new Date(startMs - 86_400_000).toISOString()).lte("scheduled_at", endIso)
    .in("status", ["scheduled", "confirmed"]).limit(200)
  if (showingsError) return { confirm: false, reason: "calendar_unreadable", agentUserId }
  const verdict = decideRequestedShowing({
    startMs, durationMinutes: params.durationMinutes, nowMs: now.getTime(), busy,
    showings: (existing ?? []) as Array<{ scheduled_at: string | null; duration_minutes: number | null }>,
  })
  return { ...verdict, agentUserId }
}
