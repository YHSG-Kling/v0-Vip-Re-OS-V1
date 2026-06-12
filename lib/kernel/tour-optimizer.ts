// lib/kernel/tour-optimizer.ts
//
// BUYER TOUR DAY OPTIMIZER — the Shopping Agent's two missing buyer-tour moves.
//
// The existing tour-planner (app/actions/tour-planner.ts) builds tours + tour_stops +
// showings, but it NEVER invokes a real optimizer (suggested times come from a rough
// count×duration guess) and it NEVER pushes a same-day recap to the buyer's portal after
// a tour completes. This module adds exactly those two capabilities — by EXTENDING the
// existing rows (tours, tour_stops, showing_routes, transparency_updates). No new tables,
// no new columns.
//
//   (1) ROUTE SEQUENCING — order a planned tour's stops by drive time (nearest-neighbor
//       over (lat,lng) using haversine), write the real sequence back to
//       tour_stops.order_index + drive_time_from_prev_minutes, set
//       tours.total_drive_time_minutes, and persist the route to showing_routes (the table
//       that already exists for exactly this).
//   (2) SAME-DAY RECAP CARD — after a tour completes, push ONE buyer-portal value card
//       (transparency_updates, update_type "tour_recap") summarizing the day (loved/liked
//       counts + per-home feedback + a warm next step), and stamp tours.report_sent_at +
//       report_url with the portal deep-link.
//
// NO FABRICATION (the hard rule): drive-time estimates are derived ONLY from real
// coordinates. The estimate is haversine miles / 30mph * 60 — an HONEST straight-line
// approximation, explicitly documented as an ESTIMATE, never a claim of real traffic.
// If a stop has NO coordinates, the runner leaves its order_index unchanged and writes
// drive_time_from_prev_minutes = NULL rather than inventing a number. The recap is
// rating-based and works regardless of coordinates.
//
// Today NO listing/tour_stop row in this schema carries latitude/longitude, so the live
// runner degrades honestly for every stop (order preserved, null drives) until a real
// coordinate source exists — and the moment one does, the same pure core sequences it.
// The pure core is fully unit-testable with synthetic coordinates (no DB).
//
// Dependency-light + NOT server-only (cron + simulator + client all import it), exactly
// like offer-net-sheet.ts and portal-value.ts.

import type { createServiceClient } from "@/lib/supabase/service"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

/** Coordinate resolver seam. Sync (the simulator injects fixed coords) OR async (production
 *  geocodes via Nominatim). Callers `await` it, so both shapes work. Returns null when a
 *  stop has no resolvable coordinates — that stop degrades honestly (kept in place, null
 *  drive), never fabricated. */
export type ResolveCoords = (
  stop: { property_address?: string | null; city?: string | null; state?: string | null; zip?: string | null },
) => Promise<{ lat: number; lng: number } | null> | { lat: number; lng: number } | null

// ─── The driving-speed assumption (documented as an ESTIMATE, not a claim) ──────
//
// We translate straight-line haversine miles into minutes at a flat assumed average
// speed. This is a STARTING ESTIMATE for sequencing + agent review — it is NOT a
// traffic-aware drive time and must never be presented as one. Surfaces that show it
// label it "est." and the metadata carries estimate_basis so it is auditable.
export const ASSUMED_AVG_MPH = 30

// ─── Types ──────────────────────────────────────────────────────────────────────

export type InterestLevel = "love_it" | "like_it" | "maybe" | "no"

/** A point on the tour. lat/lng are OPTIONAL — a stop without them cannot be
 *  drive-time sequenced and degrades honestly (kept in place, null drive). */
export interface GeoStop {
  id: string
  /** Stable position in the input list — used to preserve order for un-geocoded stops. */
  order_index: number
  lat?: number | null
  lng?: number | null
  /** Carried through untouched so callers keep their row context. */
  [extra: string]: unknown
}

export interface SequencedStop {
  id: string
  /** New optimized position (0-based). */
  order_index: number
  /** Estimated drive minutes from the PREVIOUS stop in the sequence. NULL when this
   *  stop or its predecessor lacks coordinates — honesty over a fabricated number. */
  driveMinutes: number | null
  /** Straight-line miles from the previous stop, when both points are known. */
  haversineMiles: number | null
  /** Whether this stop was placed by real-coordinate sequencing (true) or left in
   *  its original order because it had no coordinates (false). */
  sequenced: boolean
  lat?: number | null
  lng?: number | null
  [extra: string]: unknown
}

export interface RecapStopRating {
  propertyAddress: string
  interestLevel: InterestLevel | null
  note?: string | null
}

export interface TourRecap {
  loved: number
  liked: number
  maybe: number
  no: number
  rated: number
  total: number
  /** Plain-language recap body built ONLY from the real ratings (no fabrication). */
  body: string
  /** Per-home feedback lines (address → interest), real ratings only. */
  perHome: string[]
  /** A warm, Fair-Housing-safe next-step sentence (deterministic fallback). */
  nextStep: string
}

// ─── Pure geo helpers ─────────────────────────────────────────────────────────────

const EARTH_RADIUS_MILES = 3958.8

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Great-circle distance in miles between two (lat,lng) points. Pure. */
export function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Convert straight-line miles → an ESTIMATED drive time in whole minutes at the
 *  assumed average speed. This is an approximation for sequencing/review only. */
export function estimateDriveMinutes(miles: number, mph: number = ASSUMED_AVG_MPH): number {
  if (mph <= 0) return 0
  return Math.round((miles / mph) * 60)
}

function hasCoords(s: { lat?: number | null; lng?: number | null }): boolean {
  return typeof s.lat === "number" && typeof s.lng === "number" && Number.isFinite(s.lat) && Number.isFinite(s.lng)
}

// ─── PURE: nearest-neighbor route sequencing ──────────────────────────────────────

/**
 * Order stops by drive time using a nearest-neighbor heuristic over (lat,lng) points,
 * starting from `origin` (the tour's start address coordinates) when provided, else from
 * the first geocoded stop.
 *
 * HONEST DEGRADATION: stops WITHOUT coordinates cannot be sequenced. They are NOT given a
 * fabricated drive time — they keep their original relative order and are appended after
 * the geocoded, sequenced stops with driveMinutes = null. Geocoded stops are ordered
 * nearest-neighbor; each carries the ESTIMATED drive minutes from its predecessor in the
 * resulting sequence (the first sequenced stop's drive is measured from `origin` when an
 * origin is supplied, else null).
 *
 * Returns the FULL stop list, re-indexed 0..n-1 in the new order.
 */
export function sequenceStopsByDriveTime(
  stops: GeoStop[],
  origin?: { lat: number; lng: number } | null,
): SequencedStop[] {
  const geocoded = stops.filter(hasCoords)
  const ungeocoded = stops
    .filter((s) => !hasCoords(s))
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))

  // Nearest-neighbor over the geocoded stops.
  const remaining = [...geocoded]
  const ordered: GeoStop[] = []
  let cursor: { lat: number; lng: number } | null = origin ?? null

  while (remaining.length > 0) {
    let bestIdx = 0
    if (cursor) {
      let bestDist = Infinity
      for (let i = 0; i < remaining.length; i++) {
        const d = haversineMiles(cursor, { lat: remaining[i].lat as number, lng: remaining[i].lng as number })
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
        }
      }
    } else {
      // No origin: anchor on the stop with the lowest original order_index so the
      // sequence is deterministic.
      bestIdx = remaining.reduce(
        (best, s, i) => ((s.order_index ?? 0) < (remaining[best].order_index ?? 0) ? i : best),
        0,
      )
    }
    const next = remaining.splice(bestIdx, 1)[0]
    ordered.push(next)
    cursor = { lat: next.lat as number, lng: next.lng as number }
  }

  // Build sequenced results with per-leg estimates.
  const result: SequencedStop[] = []
  let prev: { lat: number; lng: number } | null = origin ?? null
  let idx = 0
  for (const s of ordered) {
    const here = { lat: s.lat as number, lng: s.lng as number }
    let miles: number | null = null
    let drive: number | null = null
    if (prev) {
      miles = haversineMiles(prev, here)
      drive = estimateDriveMinutes(miles)
    }
    result.push({ ...s, order_index: idx, driveMinutes: drive, haversineMiles: miles, sequenced: true })
    prev = here
    idx += 1
  }

  // Append un-geocoded stops untouched — null drive, marked not-sequenced.
  for (const s of ungeocoded) {
    result.push({ ...s, order_index: idx, driveMinutes: null, haversineMiles: null, sequenced: false })
    idx += 1
  }

  return result
}

/** Sum of the per-leg ESTIMATED drive minutes (nulls skipped). */
export function totalEstimatedDriveMinutes(seq: SequencedStop[]): number {
  return seq.reduce((sum, s) => sum + (s.driveMinutes ?? 0), 0)
}

/** PURE. Add minutes to an "HH:MM"(:SS) clock string, wrapping at midnight. Returns
 *  "HH:MM". Invalid input → null (never fabricate a time). */
export function addMinutesToClock(hhmm: string | null | undefined, minutes: number): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((hhmm ?? "").trim())
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return null
  const total = ((h * 60 + min + Math.round(minutes)) % 1440 + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

/**
 * PURE. Walk the clock through the SEQUENCED order and produce each stop's new suggested
 * arrival time — the same walk createTourPlan does on creation (start_time, then per stop:
 * + drive when known, arrive, + visit duration). Re-sequencing without this would leave the
 * original-order times stale. Unknown drives (un-geocoded legs) add 0 — the time is then
 * "drive not included," matching createTourPlan's own falsy-skip behavior; we never invent
 * a drive. Returns a map stopId → "HH:MM"; empty when start time is unparseable (times left
 * untouched rather than fabricated).
 */
export function recomputeStopTimes(
  sequenced: SequencedStop[],
  startTime: string | null | undefined,
  durationsByStopId: Map<string, number>,
): Map<string, string> {
  const out = new Map<string, string>()
  let cursor = addMinutesToClock(startTime, 0)
  if (!cursor) return out
  const ordered = [...sequenced].sort((a, b) => a.order_index - b.order_index)
  for (const s of ordered) {
    cursor = addMinutesToClock(cursor, s.driveMinutes ?? 0)
    if (!cursor) return out
    out.set(s.id, cursor)
    cursor = addMinutesToClock(cursor, durationsByStopId.get(s.id) ?? 30)
    if (!cursor) return out
  }
  return out
}

/**
 * A 0..1 optimization score: how much shorter the nearest-neighbor straight-line total is
 * vs the original input order's straight-line total (both over geocoded stops only). 1.0 =
 * the optimized route adds zero distance over a single point; lower numbers mean the
 * optimizer saved more vs the as-entered order. Honest: when fewer than 2 stops are
 * geocoded there is nothing to optimize, so the score is 1.0 (no claim of savings).
 */
export function optimizationScore(
  original: GeoStop[],
  sequenced: SequencedStop[],
  origin?: { lat: number; lng: number } | null,
): number {
  const origGeo = original.filter(hasCoords)
  if (origGeo.length < 2) return 1

  const legSum = (pts: Array<{ lat: number; lng: number }>): number => {
    let total = 0
    let prev = origin ?? null
    for (const p of pts) {
      if (prev) total += haversineMiles(prev, p)
      prev = p
    }
    return total
  }

  const originalMiles = legSum(
    [...origGeo]
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
      .map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
  )
  const optimizedMiles = legSum(
    sequenced.filter((s) => s.sequenced).map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
  )
  if (originalMiles <= 0) return 1
  // ratio of optimized to original; clamp to [0,1]. Lower optimized → score closer to the
  // savings; identical → 1.0.
  const ratio = optimizedMiles / originalMiles
  return Math.max(0, Math.min(1, Number(ratio.toFixed(4))))
}

// ─── PURE: same-day recap from REAL ratings ───────────────────────────────────────

const INTEREST_LABEL: Record<InterestLevel, string> = {
  love_it: "Loved",
  like_it: "Liked",
  maybe: "Maybe",
  no: "Not for us",
}

/**
 * Build the recap purely from the real per-stop ratings. Counts loved/liked/maybe/no,
 * produces per-home feedback lines and a deterministic, Fair-Housing-safe next step. No
 * fabrication — every line is drawn from a rating the buyer actually gave.
 */
export function composeTourRecap(
  stops: RecapStopRating[],
  opts: { buyerFirstName?: string | null } = {},
): TourRecap {
  const total = stops.length
  const loved = stops.filter((s) => s.interestLevel === "love_it").length
  const liked = stops.filter((s) => s.interestLevel === "like_it").length
  const maybe = stops.filter((s) => s.interestLevel === "maybe").length
  const no = stops.filter((s) => s.interestLevel === "no").length
  const rated = stops.filter((s) => s.interestLevel != null).length

  const perHome = stops
    .filter((s) => s.interestLevel != null)
    .map((s) => {
      const label = INTEREST_LABEL[s.interestLevel as InterestLevel]
      const note = s.note?.trim() ? ` — "${s.note.trim()}"` : ""
      return `${label}: ${s.propertyAddress}${note}`
    })

  // Deterministic, neutral count sentence (no protected-class / steering language).
  const name = opts.buyerFirstName?.trim()
  const greeting = name ? `${name}, ` : ""
  const countParts: string[] = []
  if (loved > 0) countParts.push(`${loved} you loved`)
  if (liked > 0) countParts.push(`${liked} you liked`)
  if (maybe > 0) countParts.push(`${maybe} maybe`)
  const countSummary =
    countParts.length > 0
      ? `Out of ${total} ${total === 1 ? "home" : "homes"} on today's tour, ${countParts.join(", ")}.`
      : `You toured ${total} ${total === 1 ? "home" : "homes"} today.`

  // Warm, neutral next step — deterministic fallback (the runner may regenerate via
  // generatePersonaCopy with this as its fallback).
  const nextStep =
    loved > 0
      ? `When you're ready, let's talk through the ${loved === 1 ? "one you loved" : "ones you loved"} and look at next steps.`
      : liked > 0
        ? `Let's keep the momentum going — reply here and we'll line up the next round on the homes that stood out.`
        : `Thanks for touring today — tell me what mattered most and I'll tune the next set to match.`

  const body = [`${greeting}${countSummary}`, ...perHome, nextStep].join("\n")

  return { loved, liked, maybe, no, rated, total, perHome, nextStep, body }
}

/** Stable idempotency signature for a tour's recap (used in card metadata + audits). */
export function tourRecapSignature(tourId: string): string {
  return `tour_recap:${tourId}`
}

// ─── LIVE entrypoints ─────────────────────────────────────────────────────────────

export interface OptimizeRouteResult {
  ok: boolean
  reason?: string
  tourId: string
  stopsTotal: number
  stopsSequenced: number
  totalDriveMinutes: number
  optimizationScore: number
  routeId?: string
}

/**
 * Sequence a PLANNED tour. Loads its stops, geocodes each address via the FREE Nominatim
 * geocoder (default resolver) — any stop the geocoder can't place stays un-geocoded (kept
 * in place, null drive: honest degradation, never fabricated). Reorders the placeable
 * stops by drive time, writes tour_stops.order_index + drive_time_from_prev_minutes, sets
 * tours.total_drive_time_minutes, and persists the route to showing_routes.
 *
 * Idempotent: skips if tours.total_drive_time_minutes is already set by the optimizer
 * (the showing_routes row is the audit trail). Never throws.
 */
export async function optimizeTourRoute(
  tourId: string,
  client?: Svc,
  opts: { now?: Date; resolveCoords?: ResolveCoords } = {},
): Promise<OptimizeRouteResult> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = opts.now ?? new Date()
  const base: OptimizeRouteResult = {
    ok: false,
    tourId,
    stopsTotal: 0,
    stopsSequenced: 0,
    totalDriveMinutes: 0,
    optimizationScore: 1,
  }

  const { data: tour } = await supabase
    .from("tours")
    .select("id, brokerage_id, agent_id, contact_id, tour_date, start_time, start_address, status, total_drive_time_minutes")
    .eq("id", tourId)
    .maybeSingle()
  if (!tour) return { ...base, reason: "tour_not_found" }

  // IDEMPOTENCY — the optimizer already ran (it set total_drive_time_minutes). Skip.
  if ((tour as any).total_drive_time_minutes != null) {
    return { ...base, ok: true, reason: "already_optimized" }
  }

  // Select the address parts the geocoder needs (no coordinate columns exist on this
  // schema, so coordinates come from the resolveCoords seam — the real Nominatim geocoder
  // in production, fixed coords from the simulator).
  const { data: rows } = await supabase
    .from("tour_stops")
    .select("id, order_index, property_address, city, state, zip, listing_id, suggested_duration_minutes")
    .eq("tour_id", tourId)
    .order("order_index", { ascending: true })

  const stopRows = (rows ?? []) as any[]
  if (stopRows.length === 0) return { ...base, reason: "no_stops" }
  base.stopsTotal = stopRows.length

  // Default resolver: the real FREE Nominatim geocoder (cached + rate-respecting), so an
  // address actually becomes coordinates in production. The simulator injects its own
  // resolver (no network in tests). No fabrication: a stop the geocoder can't place stays
  // un-geocoded (kept in place, null drive).
  const resolve: ResolveCoords =
    opts.resolveCoords ?? (await import("@/lib/external/nominatim-geocode")).createCachedGeocoder()

  const geoStops: GeoStop[] = []
  for (const r of stopRows) {
    const resolved = await resolve(r)
    geoStops.push({
      id: r.id,
      order_index: r.order_index ?? 0,
      lat: resolved?.lat ?? null,
      lng: resolved?.lng ?? null,
      property_address: r.property_address,
    })
  }

  // ORIGIN = the agent's meeting point (tours.start_address) — the designed flow: the
  // agent says where the tour STARTS, and the sequence is computed from there. Geocoded
  // through the same resolver (cached). Null when un-geocodable → the sequence anchors on
  // the first entered stop instead (honest fallback, documented in sequenceStopsByDriveTime).
  const startAddress = ((tour as any).start_address ?? "").toString().trim()
  const origin = startAddress ? await resolve({ property_address: startAddress }) : null

  const sequenced = sequenceStopsByDriveTime(geoStops, origin)
  const score = optimizationScore(geoStops, sequenced, origin)
  const totalDrive = totalEstimatedDriveMinutes(sequenced)
  const sequencedCount = sequenced.filter((s) => s.sequenced).length
  base.stopsSequenced = sequencedCount
  base.totalDriveMinutes = totalDrive
  base.optimizationScore = score

  // Recompute each stop's suggested arrival time for the NEW order — same clock walk
  // createTourPlan uses (start_time, + drive when known, + visit duration). Without this,
  // re-sequencing would leave the original-order times stale.
  const durations = new Map<string, number>(
    stopRows.map((r: any) => [r.id as string, Number(r.suggested_duration_minutes ?? 30)]),
  )
  const times = recomputeStopTimes(sequenced, (tour as any).start_time ?? null, durations)

  // Persist the new order + per-leg ESTIMATED drives + recomputed times. Un-geocoded
  // stops keep their (re-indexed, original-relative) order with null drive.
  for (const s of sequenced) {
    await supabase
      .from("tour_stops")
      .update({
        order_index: s.order_index,
        drive_time_from_prev_minutes: s.driveMinutes, // null when un-geocoded — no fabrication
        ...(times.has(s.id) ? { suggested_time: times.get(s.id) } : {}),
      })
      .eq("id", s.id)
      .eq("tour_id", tourId)
  }

  // tours.total_drive_time_minutes — the idempotency stamp + the agent-review number.
  await supabase
    .from("tours")
    .update({ total_drive_time_minutes: totalDrive, updated_at: now.toISOString() })
    .eq("id", tourId)

  // Persist the route to showing_routes (the table that exists for exactly this).
  // agent_id on showing_routes FKs agents.id; tours.agent_id is the agent's users.id, so
  // resolve the agents row. If we can't, we still optimized tour_stops + tours — the
  // showing_routes row is the audit trail, best-effort.
  let routeId: string | undefined
  let agentRowId: string | null = null
  if ((tour as any).agent_id) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", (tour as any).agent_id)
      .eq("brokerage_id", (tour as any).brokerage_id)
      .maybeSingle()
    agentRowId = (agentRow as any)?.id ?? null
  }
  if (agentRowId) {
    const orderedPayload = sequenced.map((s) => ({
      tour_stop_id: s.id,
      order_index: s.order_index,
      drive_minutes_est: s.driveMinutes,
      haversine_miles: s.haversineMiles,
      sequenced: s.sequenced,
      property_address: (s as any).property_address ?? null,
    }))
    const estMiles = sequenced.reduce((sum, s) => sum + (s.haversineMiles ?? 0), 0)
    const { data: route } = await supabase
      .from("showing_routes")
      .insert({
        agent_id: agentRowId,
        brokerage_id: (tour as any).brokerage_id,
        route_date: (tour as any).tour_date ?? now.toISOString().slice(0, 10),
        showings: { tour_id: tourId, stop_count: stopRows.length },
        optimized_order: orderedPayload,
        total_duration: totalDrive,
        estimated_miles: Number(estMiles.toFixed(2)),
        optimization_score: score,
        route_notes: `Tour ${tourId} — nearest-neighbor route. Drive times are ESTIMATES at ${ASSUMED_AVG_MPH}mph straight-line (haversine), not traffic-aware. ${sequencedCount}/${stopRows.length} stops had coordinates; the rest kept their entered order.`,
      })
      .select("id")
      .maybeSingle()
    routeId = (route as any)?.id
  }

  return { ...base, ok: true, routeId }
}

export interface PushRecapResult {
  ok: boolean
  reason?: string
  tourId: string
  pushed: boolean
  cardId?: string
  loved: number
  liked: number
  total: number
}

/**
 * After a tour COMPLETES, build the recap from the stops' real ratings, push ONE buyer-
 * portal value card (transparency_updates, update_type "tour_recap"), and stamp
 * tours.report_sent_at + report_url IF NOT ALREADY SET.
 *
 * Idempotent on the CARD, not on report_sent_at: finalizeTour() stamps report_sent_at at
 * LOCK-IN when it sends the buyer the confirmed itinerary report — keying the recap on
 * that column would silently skip every tour that went through the designed flow. So we
 * key on the recap card itself (transparency_updates, update_type "tour_recap",
 * metadata.tour_id) and never clobber finalizeTour's stamp. Never throws.
 */
export async function pushTourRecap(
  tourId: string,
  client?: Svc,
  opts: { now?: Date; copyGenerator?: CopyGenerator } = {},
): Promise<PushRecapResult> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = opts.now ?? new Date()
  const base: PushRecapResult = { ok: false, tourId, pushed: false, loved: 0, liked: 0, total: 0 }

  const { data: tour } = await supabase
    .from("tours")
    .select("id, brokerage_id, contact_id, status, report_sent_at, report_url")
    .eq("id", tourId)
    .maybeSingle()
  if (!tour) return { ...base, reason: "tour_not_found" }
  if (!(tour as any).contact_id || !(tour as any).brokerage_id) return { ...base, reason: "missing_owner" }

  // IDEMPOTENCY — a recap card for THIS tour already exists (any day). Skip.
  const { data: existingCard } = await supabase
    .from("transparency_updates")
    .select("id")
    .eq("contact_id", (tour as any).contact_id)
    .eq("update_type", "tour_recap")
    .contains("metadata", { tour_id: tourId })
    .limit(1)
    .maybeSingle()
  if (existingCard) {
    return { ...base, ok: true, reason: "already_recapped" }
  }

  const { data: stopRows } = await supabase
    .from("tour_stops")
    .select("property_address, buyer_interest_level, buyer_note, order_index")
    .eq("tour_id", tourId)
    .order("order_index", { ascending: true })

  const ratings: RecapStopRating[] = (stopRows ?? []).map((r: any) => ({
    propertyAddress: r.property_address ?? "a home on your tour",
    interestLevel: (r.buyer_interest_level ?? null) as InterestLevel | null,
    note: r.buyer_note ?? null,
  }))

  // Resolve buyer first name for warmth (best-effort).
  let buyerFirstName: string | null = null
  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name")
    .eq("id", (tour as any).contact_id)
    .maybeSingle()
  buyerFirstName = (contact as any)?.first_name ?? null

  const recap = composeTourRecap(ratings, { buyerFirstName })
  base.loved = recap.loved
  base.liked = recap.liked
  base.total = recap.total

  // PERSONA-AWARE next step — deterministic fallback = recap.nextStep. Fair-Housing safe.
  const { generatePersonaCopy, loadContactPersona } = await import("@/lib/kernel/ai-copy")
  const persona = await loadContactPersona(supabase, (tour as any).contact_id).catch(() => ({ audience: "buyer" as const }))
  const facts = [
    `The buyer toured ${recap.total} ${recap.total === 1 ? "home" : "homes"} today`,
    recap.loved > 0 ? `They loved ${recap.loved}` : "They are still weighing options",
    recap.liked > 0 ? `They liked ${recap.liked}` : "No clear favorites yet",
    "This is a friendly recap with a low-pressure next step",
  ]
  const warmNextStep = (
    await generatePersonaCopy(
      {
        goal: "a short, warm one-sentence next step closing out a same-day tour recap for the buyer (no pressure, no protected-class or lifestyle language)",
        facts,
        channel: "portal",
        persona: { ...persona, audience: "buyer", situation: "buyer who just finished a home tour" },
        words: 30,
      },
      { body: recap.nextStep },
      { generator: opts.copyGenerator },
    )
  ).body

  const summary = [
    recap.body.split("\n")[0], // the count sentence
    ...recap.perHome,
    warmNextStep,
  ].join("\n")

  const title =
    recap.loved > 0
      ? `Your tour recap — ${recap.loved} home${recap.loved === 1 ? "" : "s"} you loved`
      : `Your tour recap — ${recap.total} home${recap.total === 1 ? "" : "s"} today`

  const portalUrl = `/portal/${(tour as any).contact_id}/showings`

  const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")
  const pushed = await pushPortalValueCard(
    {
      brokerageId: (tour as any).brokerage_id,
      contactId: (tour as any).contact_id,
      title,
      summary,
      updateType: "tour_recap",
      now,
      metadata: {
        tour_id: tourId,
        signature: tourRecapSignature(tourId),
        loved: recap.loved,
        liked: recap.liked,
        maybe: recap.maybe,
        no: recap.no,
        rated: recap.rated,
        total: recap.total,
        per_home: recap.perHome,
        portal_url: portalUrl,
        buyer_safe: true,
      },
    },
    supabase,
  )

  // Stamp tours.report_sent_at + report_url ONLY when unset — finalizeTour() already
  // stamps them at lock-in for the itinerary report, and that record must not be
  // overwritten. (The recap's own idempotency is the card above, not this column.)
  if ((tour as any).report_sent_at == null) {
    await supabase
      .from("tours")
      .update({ report_sent_at: now.toISOString(), report_url: (tour as any).report_url ?? portalUrl })
      .eq("id", tourId)
  }

  return { ...base, ok: true, pushed: pushed.pushed, cardId: pushed.id }
}

// ─── RUNNER (brokerage sweep — used by the cron) ──────────────────────────────────

export interface TourOptimizerResult {
  toursOptimized: number
  recapsPushed: number
  routesPersisted: number
}

/**
 * Sweep a brokerage: (a) optimize routes for tours in status 'planned' not yet optimized,
 * and (b) push recaps for recently completed tours that have no recap card yet (card-keyed
 * idempotency — report_sent_at belongs to finalizeTour's lock-in itinerary report).
 * Idempotent at the per-tour level. Never throws on a single tour.
 */
export async function runTourOptimizer(
  brokerageId: string,
  opts: { now?: Date; copyGenerator?: CopyGenerator; resolveCoords?: ResolveCoords } = {},
  client?: Svc,
): Promise<TourOptimizerResult> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = opts.now ?? new Date()
  const result: TourOptimizerResult = { toursOptimized: 0, recapsPushed: 0, routesPersisted: 0 }

  // (a) Planned tours not yet optimized.
  const { data: planned } = await supabase
    .from("tours")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "planned")
    .is("total_drive_time_minutes", null)
    .limit(200)
  for (const t of (planned ?? []) as any[]) {
    try {
      const r = await optimizeTourRoute(t.id, supabase, { now, resolveCoords: opts.resolveCoords })
      if (r.ok && r.reason !== "already_optimized") {
        result.toursOptimized += 1
        if (r.routeId) result.routesPersisted += 1
      }
    } catch {
      /* per-tour failure must not break the sweep */
    }
  }

  // (b) RECENT completed tours — the recap window. NOT keyed on report_sent_at
  // (finalizeTour stamps that at lock-in for the itinerary report); pushTourRecap's own
  // card-existence check is the idempotency, so re-sweeping a recapped tour is a no-op.
  // 14-day lookback bounds the sweep: a same-day recap has no business landing weeks late.
  const recapSince = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { data: completed } = await supabase
    .from("tours")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "completed")
    .gte("tour_date", recapSince)
    .limit(200)
  for (const t of (completed ?? []) as any[]) {
    try {
      const r = await pushTourRecap(t.id, supabase, { now, copyGenerator: opts.copyGenerator })
      if (r.ok && r.reason !== "already_recapped") result.recapsPushed += 1
    } catch {
      /* per-tour failure must not break the sweep */
    }
  }

  return result
}
