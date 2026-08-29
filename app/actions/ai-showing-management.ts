"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { revalidatePath } from "next/cache"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { bestEffort } from "@/lib/db/best-effort"

// ============================================================================
// AI SHOWING MANAGEMENT SYSTEM
// Smart route optimization, confirmations, feedback collection, and scheduling
// ============================================================================

// ============================================================================
// TOUR MANAGEMENT
// ============================================================================

/**
 * MERGE from the dashboard-data lane (wave 13): the tenant anchor.
 *
 * `hooks/use-dashboard-data.ts` names this as the survivor for the `tours` type,
 * and the endpoint it replaces applied a brokerage filter that this did not —
 * the agent id came from the caller and nothing else narrowed the read.
 *
 * FOUND WHILE MERGING, and worth more than the merge: the RLS policy on `tours`
 * is `tours_agent_own: (agent_id = auth.uid())`. `tours.agent_id` is a FOREIGN
 * KEY TO `agents` (verified against the live schema) and `auth.uid()` is a
 * `users.id` — DISJOINT id spaces, so that policy can never match a single row.
 * Only `tours_broker_admin` grants anything, which means an ordinary agent
 * cannot read their OWN tours at all. That is a database-side fix and is
 * recorded in docs/wave13-outcome.md rather than papered over here; the app-side
 * anchor below is correct either way and does not depend on it.
 */
/**
 * ABSORBED from the retired /api/dashboard/data `tours` branch: the tenant
 * filter and the session gate landed in wave 15; wave 16 finished the pair by
 * resolving the AGENT from the session too.
 *
 * The tenant filter alone bounded the id to one brokerage but did not stop a
 * colleague reading it: any agent could pass any other agent's id and get their
 * tour book back. The id is now the caller's own agents.id unless the caller
 * administers the brokerage, in which case it may only NARROW inside the tenant
 * the filter above already pinned.
 */
export async function getTours(
  agentId?: string,
  /**
   * tour_date window (YYYY-MM-DD, inclusive) — MERGED from the calendar
   * shell's inline tours read when that duplicate was rewired onto this
   * survivor (lane E6 2026-08-28,
   * app/dashboard/calendar/components/os/calendar-shell.tsx). Narrowing only;
   * the session-derived tenant + agent scope below still applies first.
   */
  range?: { from?: string; to?: string },
) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated", tours: [] }
    if (!ctx.brokerageId) return { success: false, error: "Your account is not linked to a brokerage yet.", tours: [] }

    if (agentId && !isValidUUID(agentId)) {
      return { success: false, error: "Invalid agent ID", tours: [] }
    }

    // agents.id, from the session. Never a users.id, never a caller's claim.
    let agentFilter: string | undefined
    if (isAdminOrBroker({ user_type: ctx.userType })) {
      agentFilter = agentId
    } else {
      if (!ctx.agentId) return { success: false, error: "Agent profile not found", tours: [] }
      agentFilter = ctx.agentId
    }

    const supabase = await createClient()
    // The contacts embed rode in from the calendar shell's read (its agenda
    // rows show who the tour is with). tours→contacts is a single FK
    // (contact_id), so the bare embed is unambiguous.
    let query = supabase
      .from("tours")
      .select("*, showings(*), contacts(first_name, last_name)")
      .eq("brokerage_id", ctx.brokerageId)
      .order("tour_date", { ascending: false })

    if (agentFilter) query = query.eq("agent_id", agentFilter)
    if (range?.from) query = query.gte("tour_date", range.from)
    if (range?.to) query = query.lte("tour_date", range.to)

    const { data, error } = await query

    if (error) throw error
    return { success: true, tours: data || [] }
  } catch (error) {
    return handleError(error, "getTours")
  }
}

export async function createTour(params: { agentId: string; tourDate: string; notes?: string }) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("tours")
      .insert({
        agent_id: params.agentId,
        tour_date: params.tourDate,
        notes: params.notes || `Tour ${new Date(params.tourDate).toLocaleDateString()}`,
        status: "planned",
      })
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard")
    return { success: true, tour: data }
  } catch (error) {
    return handleError(error, "createTour")
  }
}

export async function updateTour(tourId: string, updates: any) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("tours")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", tourId)
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard")
    return { success: true, tour: data }
  } catch (error) {
    return handleError(error, "updateTour")
  }
}

/**
 * REWIRED to the canonical Tour Day Optimizer kernel (lib/kernel/tour-optimizer.ts)
 * — the SAME optimizer the cron sweep (app/api/cron/tour-optimizer) and the voice
 * lane (lib/kernel/voice-delegation.ts) already run.
 *
 * The previous body was a parallel implementation: it asked an LLM to guess a
 * stop order from the address strings and then FABRICATED the drive time as
 * `stops.length * 8` minutes. The kernel does the honest version of both jobs —
 * nearest-neighbor sequencing over real geocoded coordinates (free Nominatim,
 * cached), per-leg drive ESTIMATES derived only from real coordinates (30mph
 * straight-line, labeled as an estimate, NULL when a stop can't be geocoded),
 * recomputed per-stop suggested times, tours.total_drive_time_minutes, and a
 * showing_routes audit row with an optimization score. Nothing was merged
 * forward from the old body: every line of it was the less-honest duplicate of
 * a kernel line.
 *
 * Auth: the old body ran on the RLS client with no explicit gate. The kernel
 * needs the service client (it writes showing_routes), so the gate is now
 * explicit — session-resolved caller, tour pinned to the caller's brokerage.
 */
export async function optimizeTourRoute(tourId: string) {
  try {
    if (!isValidUUID(tourId)) return { success: false, error: "Invalid tour ID" }

    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "Your account is not linked to a brokerage yet." }

    const svc = createServiceClient()
    const { data: tour, error: tourError } = await svc
      .from("tours")
      .select("id, brokerage_id")
      .eq("id", tourId)
      .maybeSingle()
    if (tourError) return { success: false, error: tourError.message }
    if (!tour || tour.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Tour not found" }
    }

    const { optimizeTourRoute: runKernelOptimizer } = await import("@/lib/kernel/tour-optimizer")
    const result = await runKernelOptimizer(tourId, svc)

    if (!result.ok) {
      return {
        success: false,
        error:
          result.reason === "no_stops"
            ? "This tour has no stops to optimize."
            : `Route optimization refused: ${result.reason ?? "unknown"}`,
      }
    }

    if (result.reason === "already_optimized") {
      return {
        success: true,
        tourId,
        summary: "Route already optimized — the stop order and drive estimates are unchanged.",
        estimatedDriveMins: undefined,
      }
    }

    // Honest wording: the total is a straight-line ESTIMATE, and stops the
    // geocoder could not place keep their entered order with no invented drive.
    const summary =
      result.stopsSequenced === result.stopsTotal
        ? `Stops reordered by drive time (${result.stopsSequenced}/${result.stopsTotal} geocoded). ~${result.totalDriveMinutes} min total drive (est., straight-line — not traffic-aware).`
        : `${result.stopsSequenced}/${result.stopsTotal} stops geocoded and reordered by drive time; the rest kept their entered order (no address match — no invented drive times). ~${result.totalDriveMinutes} min total drive (est.).`

    return { success: true, tourId, summary, estimatedDriveMins: result.totalDriveMinutes }
  } catch (error) {
    return handleError(error, "optimizeTourRoute")
  }
}

// aiOptimizeTourRoute was REMOVED here. It was a pure alias —
// `return optimizeTourRoute(...args)`, nothing else — kept "for backward
// compatibility" with a caller that no longer exists anywhere in the tree.
//
// Survivor: optimizeTourRoute directly above, which is what everything actually
// calls (app/crm/contacts/[contactId]/tours/components/tour-confirm-tab.tsx,
// tour-plan-tab.tsx, and the app/actions/index.ts barrel).
//
// Compared both bodies before deleting, per the rule: the alias forwarded every
// argument and the whole return value and added nothing — no auth, no
// validation, no reshaping. There was genuinely nothing to merge. It was also a
// second public HTTP endpoint onto a paid model call, for no benefit.

interface ShowingRequest {
  propertyId: string
  contactId: string
  agentId: string
  // Accept either a single date/time or an array of preferred dates (first is used)
  requestedDate?: string
  requestedTime?: string
  preferredDates?: string[]
  notes?: string
  buyerPreQualified?: boolean
}

interface ShowingRoute {
  id: string
  date: string
  showings: Array<{
    propertyId: string
    address: string
    time: string
    duration: number
    travelTime: number
    contactName: string
    notes?: string
  }>
  totalDuration: number
  totalMiles: number
  optimizationScore: number
}

/**
 * AI-Powered Showing Scheduler
 * Intelligently schedules showings based on buyer preferences, property availability,
 * and optimal routing
 */
export async function aiScheduleShowing(params: ShowingRequest) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.propertyId)) {
    return { success: false, error: "Invalid agent or property ID" }
  }

  // Normalize date/time — support both single-date and preferredDates[] call signatures
  const resolvedDate = params.requestedDate
    ?? params.preferredDates?.[0]
    ?? new Date().toISOString().split("T")[0]
  const resolvedTime = params.requestedTime ?? "10:00"
  // Rebuild params with resolved values so the rest of the function uses consistent fields
  params = { ...params, requestedDate: resolvedDate, requestedTime: resolvedTime }

  // Tenant for the AI cost ledger — SESSION, never `params.agentId` (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    // Determine if propertyId is a UUID (agent seller listing) or an MLS number (buyer MLS search).
    // For MLS properties, skip the listings table lookup — it will not match.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const propertyIsUuid = uuidRe.test(params.propertyId)

    const [listingResult, contactResult] = await Promise.all([
      propertyIsUuid
        ? supabase.from("listings").select("address, city, state, list_price, bedrooms, bathrooms").eq("id", params.propertyId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from("contacts").select("first_name, last_name, contact_persona, city, state").eq("id", params.contactId).maybeSingle(),
    ])

    const listing = listingResult.data
    const contact = contactResult.data

    // For MLS buyer properties the address comes in via showing_instructions / external source —
    // we just need the contact to exist.
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Check for scheduling conflicts on the same date
    const { data: existingShowings } = await supabase
      .from("showings")
      .select("scheduled_date, status")
      .eq("agent_id", params.agentId)
      .eq("scheduled_date", params.requestedDate)
      .neq("status", "cancelled")

    // AI Analysis for optimal scheduling
    const { text: aiAnalysis } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `You are a real estate showing scheduling assistant. Analyze and recommend.

PROPERTY: ${listing ? `${listing.address}, ${listing.city} — $${listing.list_price?.toLocaleString() ?? "N/A"}, ${listing.bedrooms}bd/${listing.bathrooms}ba` : `MLS # ${params.propertyId}`}
BUYER: ${contact.first_name} ${contact.last_name} (${contact.contact_persona ?? "buyer"})
REQUESTED TIME: ${params.requestedDate} at ${params.requestedTime}
PRE-QUALIFIED: ${params.buyerPreQualified ? "Yes" : "No/Unknown"}
AGENT SHOWINGS THAT DAY: ${existingShowings?.length ?? 0}

Return JSON only:
{
  "recommendedTime": "HH:MM",
  "alternativeTimes": ["HH:MM"],
  "conflictRisk": "low|medium|high",
  "preparationTips": ["tip1"],
  "talkingPoints": ["point1"],
  "followUpStrategy": "string"
}`,
    })

    let aiRecommendations
    try {
      const jsonMatch = aiAnalysis.match(/\{[\s\S]*\}/)
      aiRecommendations = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      aiRecommendations = { recommendedTime: params.requestedTime }
    }

    // Resolve brokerage_id from the agent's user record. params.agentId is a
    // USERS id — the caller (tour-confirm-tab) passes agentUserId — so this
    // lookup is the correct half.
    const { data: agentUser } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", params.agentId)
      .maybeSingle()

    // IDENTITY CLASS. showings.agent_id and activities.agent_id both FK AGENTS,
    // not users — so writing params.agentId straight into them is a foreign-key
    // violation and every AI-scheduled showing failed at the insert. The same
    // value was being used as BOTH classes inside this one function, which is
    // the self-contradiction test:identity-class now fails on.
    const agentRecordId = agentUser?.brokerage_id
      ? await resolveUserIdToAgentRecord(params.agentId, agentUser.brokerage_id)
      : null
    if (!agentRecordId) {
      return { success: false, error: "No agent record for this user — can't book the showing to them." }
    }

    const recommendedTime = aiRecommendations.recommendedTime || params.requestedTime
    const scheduledAt = params.requestedDate && recommendedTime
      ? `${params.requestedDate}T${recommendedTime}:00`
      : null

    // listing_id is a UUID FK — only set it when the propertyId is actually a UUID.
    // For MLS buyer properties, propertyId is an MLS number string; store it in notes instead.
    const notesText = [
      params.notes,
      !propertyIsUuid ? `MLS: ${params.propertyId}` : null,
    ].filter(Boolean).join(' | ') || null

    // Create the showing using verified live schema columns
    const { data: showing, error } = await supabase
      .from("showings")
      .insert({
        listing_id:     propertyIsUuid ? params.propertyId : null,
        contact_id:     params.contactId,
        agent_id:       agentRecordId,
        brokerage_id:   agentUser?.brokerage_id ?? null,
        scheduled_date: params.requestedDate,
        scheduled_at:   scheduledAt,
        status:         "scheduled",
        notes:          notesText,
        sync_source:    "ai_scheduler",
        is_confirmed:   false,
        created_at:     new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    // Write an activities row so the showing appears on the agent's activity feed as pending.
    // No calendar_event yet — that is written only when the agent confirms the showing time.
    await bestEffort(
      supabase.from("activities").insert({
        brokerage_id:  agentUser?.brokerage_id ?? null,
        agent_id:      agentRecordId,
        contact_id:    params.contactId,
        activity_type: "showing",
        title:         `Showing scheduled — ${params.requestedDate} at ${resolvedTime}`,
        description:   notesText ?? undefined,
        scheduled_at:  scheduledAt,
        status:        "pending",
        priority:      "high",
      }),
      "the showings row above is the booking and its error is already checked; this feed row only surfaces the booking to the agent and must not fail a showing that is already scheduled",
    )

    revalidatePath("/showings")
    revalidatePath("/dashboard")

    return {
      success: true,
      showing,
      aiRecommendations,
    }
  } catch (error) {
    return handleError(error, "aiScheduleShowing")
  }
}

/**
 * THE AGENT'S WHOLE SHOWING DAY, SEQUENCED BY THE ONE ROUTE ENGINE.
 *
 * SCOPE — why this is not a duplicate of optimizeTourRoute above: that one
 * orders the stops of ONE buyer's tour; this one orders every showing on an
 * agent's calendar for a date, which may span several buyers and several tours.
 * Same fact (order + drive time), different SET of stops.
 *
 * REWIRED onto lib/kernel/tour-optimizer.ts (this wave). The previous body was
 * the third parallel implementation of drive time in the tree: it asked
 * gpt-4o to invent `travelTimeFromPrevious`, `estimatedMiles` and an
 * `optimizationScore`, then wrote those invented numbers into `showing_routes`
 * and PUSHED THEM ONTO `showings.scheduled_time` — real appointments moved by a
 * guess. The kernel does the honest version: nearest-neighbor over coordinates
 * the free Nominatim geocoder actually resolved, per-leg estimates at a
 * documented assumed speed labeled as ESTIMATES, and NO number at all for a
 * showing whose address could not be placed.
 *
 * TWO DEFECTS FIXED WITH IT:
 *   · IDENTITY CLASS. It filtered `showings.agent_id` — an agents.id — with the
 *     users.id its only caller had (the CRM day-of tab). Disjoint spaces (§3),
 *     so the read matched NOTHING and every click answered "No showings found
 *     for this date". The agent is resolved from the SESSION now; the parameter
 *     survives only as an admin's narrowing claim, exactly as in getTours.
 *   · TENANT. The `showing_routes` insert omitted `brokerage_id`, so the audit
 *     row it wrote was unreadable by every tenant-scoped policy, and the read
 *     was not tenant-pinned either.
 *
 * A SHOWING IS ONLY MOVED WHEN THE MOVE IS MEASURED. Un-geocoded showings keep
 * their booked time untouched — a confirmed appointment must never be rewritten
 * on the strength of a stop we could not place.
 */
export async function aiOptimizeShowingRoute(params: {
  /**
   * OPTIONAL narrowing claim, honored only for an admin/broker seat — never the
   * authority. An ordinary agent is scoped to their own agents.id from session.
   */
  agentId?: string
  date: string
  showingIds?: string[]
}) {
  if (params.agentId && !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "Your account is not linked to a brokerage yet." }

    // agents.id, from the session. Never a users.id, never a caller's claim.
    let agentFilter: string | undefined
    if (isAdminOrBroker({ user_type: ctx.userType })) {
      agentFilter = params.agentId
    } else {
      if (!ctx.agentId) return { success: false, error: "Agent profile not found" }
      agentFilter = ctx.agentId
    }

    // The route write needs the service client (showing_routes); the tenant and
    // agent scope above are the gate, applied to every statement below.
    const supabase = createServiceClient()

    // showings→listings is a SINGLE foreign key (listing_id), so this embed is
    // unambiguous — no PGRST201 risk, and the columns are named so the schema
    // guard can see drift.
    let query = supabase
      .from("showings")
      .select("id, scheduled_time, scheduled_date, duration_minutes, listing_id, listings(address, city, state, zip)")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("scheduled_date", params.date)
      .in("status", ["scheduled", "confirmed"])

    if (agentFilter) query = query.eq("agent_id", agentFilter)
    if (params.showingIds?.length) query = query.in("id", params.showingIds)

    // THE ERROR IS READ. A refused read and an empty day are byte-identical if
    // only `data` is destructured, and telling an agent they have no showings
    // when we simply could not look is the failure this whole guard family
    // exists to prevent.
    const { data: showings, error: showingsError } = await query
    if (showingsError) {
      return { success: false, error: `Could not read the day's showings: ${showingsError.message}` }
    }
    if (!showings || showings.length === 0) {
      return { success: false, error: "No showings found for this date" }
    }

    const kernel = await import("@/lib/kernel/tour-optimizer")
    const geocode = (await import("@/lib/external/nominatim-geocode")).createCachedGeocoder()

    const rows = showings as unknown as Array<{
      id: string
      scheduled_time: string | null
      duration_minutes: number | null
      listings: { address: string | null; city: string | null; state: string | null; zip: string | null } | null
    }>

    // Original order = the booked clock, so the optimization score compares the
    // new sequence against the day as it actually stands.
    const byClock = [...rows].sort((a, b) => String(a.scheduled_time ?? "").localeCompare(String(b.scheduled_time ?? "")))

    const geoStops = []
    for (let i = 0; i < byClock.length; i++) {
      const s = byClock[i]
      const point = s.listings?.address
        ? await geocode({
            address: s.listings.address,
            city: s.listings.city,
            state: s.listings.state,
            zip: s.listings.zip,
          })
        : null
      geoStops.push({
        id: s.id,
        order_index: i,
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
        address: s.listings?.address ?? null,
      })
    }

    // ORIGIN — the brokerage's own city/state, the only address the schema
    // carries for an agent's day (users has no address columns). Un-geocodable →
    // the sequence anchors on the first booked showing instead.
    const { data: brokerage } = await supabase
      .from("brokerages")
      .select("name, city, state")
      .eq("id", ctx.brokerageId)
      .maybeSingle()
    const office = brokerage as { name?: string | null; city?: string | null; state?: string | null } | null
    const origin = office?.city
      ? await geocode({ address: office.name ?? null, city: office.city, state: office.state })
      : null

    const sequenced = kernel.sequenceStopsByDriveTime(geoStops, origin)
    const stopsSequenced = sequenced.filter((s) => s.sequenced).length
    const measuredLegs = sequenced.filter((s) => s.driveMinutes != null).length
    const totalDriveMinutes = measuredLegs > 0 ? kernel.totalEstimatedDriveMinutes(sequenced) : null
    const score = kernel.optimizationScore(geoStops, sequenced, origin)
    const estimatedMiles = sequenced.reduce((sum, s) => sum + (s.haversineMiles ?? 0), 0)

    // The day starts at the earliest time already on the books — we re-order the
    // day, we do not decide when the agent starts working.
    const dayStart = byClock.find((s) => s.scheduled_time)?.scheduled_time ?? null
    const durations = new Map(
      byClock.map((s) => [s.id, Number(s.duration_minutes ?? 30)] as [string, number]),
    )
    const newTimes = kernel.recomputeStopTimes(sequenced, dayStart, durations)

    const optimizedOrder = sequenced.map((s) => ({
      showingId: s.id,
      order: s.order_index,
      address: (s as { address?: string | null }).address ?? null,
      recommendedTime: s.sequenced ? (newTimes.get(s.id) ?? null) : null,
      estimatedDuration: durations.get(s.id) ?? 30,
      travelTimeFromPrevious: s.driveMinutes,
      milesFromPrevious: s.haversineMiles != null ? Number(s.haversineMiles.toFixed(2)) : null,
      placedByGeocoder: s.sequenced,
    }))

    const { data: route, error: routeError } = await supabase
      .from("showing_routes")
      .insert({
        agent_id: agentFilter ?? ctx.agentId,
        // Without this the audit row is unreadable by every tenant-scoped policy.
        brokerage_id: ctx.brokerageId,
        route_date: params.date,
        showings: rows.map((s) => s.id),
        optimized_order: optimizedOrder,
        total_duration: totalDriveMinutes,
        estimated_miles: Number(estimatedMiles.toFixed(2)),
        optimization_score: score,
        route_notes: `Agent day route — nearest-neighbor over geocoded addresses. Drive times are ESTIMATES at ${kernel.ASSUMED_AVG_MPH}mph straight-line (haversine), not traffic-aware. ${stopsSequenced}/${rows.length} showings had a placeable address; the rest kept their booked time.`,
      })
      .select("id")
      .maybeSingle()
    if (routeError) {
      return { success: false, error: `The route could not be saved: ${routeError.message}` }
    }

    // ONLY MEASURED MOVES ARE WRITTEN BACK.
    let moved = 0
    for (const item of optimizedOrder) {
      if (!item.placedByGeocoder || !item.recommendedTime) continue
      const { error: moveError } = await supabase
        .from("showings")
        .update({ scheduled_time: item.recommendedTime })
        .eq("id", item.showingId)
        .eq("brokerage_id", ctx.brokerageId)
      if (!moveError) moved += 1
    }

    revalidatePath("/showings")

    const summary =
      stopsSequenced === rows.length
        ? `${rows.length} showings reordered by drive time${
            totalDriveMinutes != null ? ` (~${totalDriveMinutes} min total drive, est., straight-line)` : ""
          }.`
        : `${stopsSequenced}/${rows.length} showings had a placeable address and were reordered; the rest kept their booked time (no drive invented).`

    return {
      success: true,
      route,
      summary,
      moved,
      stopsSequenced,
      stopsTotal: rows.length,
      totalDriveMinutes,
      optimizedOrder,
    }
  } catch (error) {
    return handleError(error, "aiOptimizeShowingRoute")
  }
}

/**
 * AI Showing Confirmation System
 * Sends smart confirmations via preferred channel
 */
export async function aiSendShowingConfirmation(showingId: string) {
  if (!isValidUUID(showingId)) {
    return { success: false, error: "Invalid showing ID" }
  }

  // Tenant for the AI cost ledger — SESSION (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: showing } = await supabase
      .from("showings")
      .select(`
        *,
        listings(*),
        contacts(*),
        users(first_name, last_name, phone, email)
      `)
      .eq("id", showingId)
      .single()

    if (!showing) {
      return { success: false, error: "Showing not found" }
    }

    // Generate personalized confirmation message
    const { text: confirmationContent } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `Create a friendly, professional showing confirmation message.

SHOWING DETAILS:
- Property: ${showing.listings?.address}, ${showing.listings?.city}, ${showing.listings?.state}
- Date: ${new Date(showing.scheduled_date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
- Time: ${showing.scheduled_time}
- Agent: ${showing.users?.first_name} ${showing.users?.last_name}

BUYER DETAILS:
- Name: ${showing.contacts?.first_name}
- Persona: ${showing.contacts?.contact_persona || "buyer"}

Create JSON with both email and SMS versions:
{
  "emailSubject": "subject line",
  "emailBody": "full email body with property details and what to expect",
  "smsMessage": "brief SMS under 160 chars",
  "preparationTips": ["tip1", "tip2"]
}`,
    })

    let confirmationMessages
    try {
      const jsonMatch = confirmationContent.match(/\{[\s\S]*\}/)
      confirmationMessages = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      confirmationMessages = {
        emailSubject: `Showing Confirmation - ${showing.listings?.address}`,
        smsMessage: `Your showing at ${showing.listings?.address} is confirmed for ${showing.scheduled_date} at ${showing.scheduled_time}`,
      }
    }

    // Log the confirmation
    await supabase.from("showing_communications").insert({
      showing_id: showingId,
      communication_type: "confirmation",
      email_content: confirmationMessages,
      sms_content: confirmationMessages.smsMessage,
      sent_at: new Date().toISOString(),
      status: "sent",
    })

    // Update showing status
    await supabase.from("showings").update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", showingId)

    revalidatePath("/showings")

    return {
      success: true,
      confirmationMessages,
    }
  } catch (error) {
    return handleError(error, "aiSendShowingConfirmation")
  }
}

/**
 * AI Showing Feedback Collection
 * Generates personalized feedback requests and analyzes responses
 */
export async function aiCollectShowingFeedback(showingId: string) {
  if (!isValidUUID(showingId)) {
    return { success: false, error: "Invalid showing ID" }
  }

  // Tenant for the AI cost ledger — SESSION (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: showing } = await supabase
      .from("showings")
      .select(`
        *,
        listings(*),
        contacts(*)
      `)
      .eq("id", showingId)
      .single()

    if (!showing) {
      return { success: false, error: "Showing not found" }
    }

    // Generate personalized feedback request
    const { text: feedbackRequest } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `Create a personalized showing feedback request.

PROPERTY SHOWN:
- Address: ${showing.listings?.address}
- Price: $${showing.listings?.price?.toLocaleString()}
- Features: ${showing.listings?.bedrooms} bed, ${showing.listings?.bathrooms} bath

BUYER:
- Name: ${showing.contacts?.first_name}
- Looking for: ${showing.contacts?.contact_persona || "home"}

Create a warm, conversational feedback request that asks about:
1. Overall impression (1-10 scale)
2. Likes and dislikes
3. Interest level
4. Questions or concerns
5. Would they like to see it again or make an offer

JSON response:
{
  "subject": "email subject",
  "message": "personalized message",
  "questions": [
    {"id": "q1", "text": "question", "type": "rating|text|multiple_choice", "options": ["opt1"]}
  ]
}`,
    })

    let feedbackForm
    try {
      const jsonMatch = feedbackRequest.match(/\{[\s\S]*\}/)
      feedbackForm = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      feedbackForm = { subject: "How was your showing?", questions: [] }
    }

    // Create feedback request record
    // Live schema: showing_id, brokerage_id, sent_at, ai_analysis. The generated
    // form has no dedicated column → store under ai_analysis.feedback_form.
    const { data: feedback, error } = await supabase
      .from("showing_feedback_requests")
      .insert({
        showing_id: showingId,
        brokerage_id: (showing as any).brokerage_id ?? null,
        ai_analysis: { feedback_form: feedbackForm },
        sent_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/showings")

    return {
      success: true,
      feedbackForm,
      feedbackId: feedback.id,
    }
  } catch (error) {
    return handleError(error, "aiCollectShowingFeedback")
  }
}

/**
 * AI Analyze Showing Feedback
 * Analyzes collected feedback to determine buyer interest and next steps
 */
export async function aiAnalyzeShowingFeedback(feedbackId: string) {
  if (!isValidUUID(feedbackId)) {
    return { success: false, error: "Invalid feedback ID" }
  }

  // Tenant for the AI cost ledger — SESSION (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: feedback } = await supabase
      .from("showing_feedback_requests")
      .select(`
        *,
        showings(*, listings(*), contacts(*), showing_feedback(*))
      `)
      .eq("id", feedbackId)
      .single()

    // Feedback content lives on showing_feedback (joined via showing_id).
    const responses = (feedback as any)?.showings?.showing_feedback?.[0] ?? null
    if (!feedback || !responses) {
      return { success: false, error: "No feedback responses found" }
    }

    // AI Analysis of feedback
    const { text: analysis } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o",
      prompt: `Analyze this showing feedback and recommend next steps.

PROPERTY: ${feedback.showings?.listings?.address}
PRICE: $${feedback.showings?.listings?.list_price?.toLocaleString()}

BUYER FEEDBACK:
${JSON.stringify(responses, null, 2)}

Analyze and provide:
{
  "interestLevel": "high|medium|low|none",
  "interestScore": 0-100,
  "keyLikes": ["like1", "like2"],
  "keyConcerns": ["concern1", "concern2"],
  "buyerSentiment": "positive|neutral|negative",
  "recommendedActions": [
    {"action": "description", "priority": "high|medium|low", "timeline": "immediate|this_week|later"}
  ],
  "followUpMessage": "personalized follow-up message",
  "offerLikelihood": 0-100,
  "nextPropertySuggestions": ["criteria for similar properties"]
}`,
    })

    let analysisResult
    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/)
      analysisResult = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      analysisResult = { interestLevel: "medium" }
    }

    // Update feedback with analysis
    await supabase
      .from("showing_feedback_requests")
      .update({
        ai_analysis: { ...analysisResult, analyzed_at: new Date().toISOString() },
        interest_score: analysisResult.interestScore,
      })
      .eq("id", feedbackId)

    // Update contact's lead score based on showing feedback
    const feedbackContactId = (feedback as any).showings?.contacts?.id ?? (feedback as any).showings?.contact_id
    if (analysisResult.interestScore && feedbackContactId) {
      const scoreAdjustment = Math.round((analysisResult.interestScore - 50) / 5)
      await supabase.rpc("adjust_lead_score", {
        p_contact_id: feedbackContactId,
        p_adjustment: scoreAdjustment,
        p_reason: "showing_feedback",
      })
    }

    revalidatePath("/showings")

    return {
      success: true,
      analysis: analysisResult,
    }
  } catch (error) {
    return handleError(error, "aiAnalyzeShowingFeedback")
  }
}

/**
 * Get AI-Powered Showing Insights
 * Dashboard analytics for showing performance
 */
export async function getAIShowingInsights(agentId: string, dateRange?: { start: string; end: string }) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // Tenant for the AI cost ledger — SESSION, never `agentId` (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    let query = supabase
      .from("showings")
      .select(`
        *,
        showing_feedback_requests(interest_score, ai_analysis)
      `)
      .eq("agent_id", agentId)

    if (dateRange) {
      query = query.gte("scheduled_date", dateRange.start).lte("scheduled_date", dateRange.end)
    }

    const { data: showings } = await query

    if (!showings || showings.length === 0) {
      return { success: true, insights: { totalShowings: 0 } }
    }

    // Calculate metrics
    const totalShowings = showings.length
    const completedShowings = showings.filter((s: any) => s.status === "completed").length
    const cancelledShowings = showings.filter((s: any) => s.status === "cancelled").length
    const feedbackReceived = showings.filter((s: any) => s.showing_feedback_requests?.length > 0).length

    const avgInterestScore =
      showings
        .filter((s: any) => s.showing_feedback_requests?.[0]?.interest_score)
        .reduce((sum: number, s: any) => sum + (s.showing_feedback_requests[0].interest_score || 0), 0) /
        (feedbackReceived || 1)

    // AI Generate insights
    const { text: aiInsights } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `Analyze showing performance and provide insights.

METRICS:
- Total Showings: ${totalShowings}
- Completed: ${completedShowings}
- Cancelled: ${cancelledShowings}
- Feedback Rate: ${((feedbackReceived / totalShowings) * 100).toFixed(1)}%
- Average Interest Score: ${avgInterestScore.toFixed(1)}

Provide brief, actionable insights:
{
  "performanceSummary": "one sentence summary",
  "strengths": ["strength1"],
  "improvements": ["improvement1"],
  "recommendations": ["recommendation1"],
  "predictedConversions": number
}`,
    })

    let insights
    try {
      const jsonMatch = aiInsights.match(/\{[\s\S]*\}/)
      insights = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      insights = {}
    }

    return {
      success: true,
      insights: {
        totalShowings,
        completedShowings,
        cancelledShowings,
        feedbackReceived,
        avgInterestScore,
        conversionRate: completedShowings > 0 ? ((feedbackReceived / completedShowings) * 100).toFixed(1) : 0,
        ...insights,
      },
    }
  } catch (error) {
    return handleError(error, "getAIShowingInsights")
  }
}
