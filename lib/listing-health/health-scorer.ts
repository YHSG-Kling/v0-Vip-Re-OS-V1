/**
 * Listing Health Scorer — the per-active-listing analogue of
 * lib/deal-health/health-scorer.ts. Mirrors that file's structure so the
 * scoring patterns the team is already familiar with carry across.
 *
 * Categories scored (weights sum to 1.0):
 *   - DOM            (0.30) Days on market vs comp-equivalent expectation
 *   - SHOWINGS       (0.20) Showing volume + trend last 14 days
 *   - FEEDBACK       (0.15) Aggregate buyer interest from showing.feedback +
 *                            interest_level
 *   - OPEN_HOUSE     (0.10) Open house attendance vs comp benchmark
 *   - PRICE          (0.15) List price gap vs recent comp sales
 *   - ACTIVITY       (0.10) Recent agent activity / freshness signals
 *
 * Risk thresholds (matches deal-health):
 *   >= 85 healthy   |   70-84 watch   |   40-69 at_risk   |   < 40 critical
 *
 * Persistence:
 *   - Writes a row to listing_health_scores per scan
 *   - When risk is at_risk/critical, inserts a row into
 *     listing_health_interventions if no unresolved one already exists for
 *     the same listing
 *   - Fires LISTING_HEALTH_SCORE_UPDATED + (when warranted)
 *     LISTING_AT_RISK_DETECTED kernel events via lifecycle_events
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { generateTextRouted } from "@/lib/ai/models"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

// ─── Types ────────────────────────────────────────────────────────────────────

export type ListingHealthCategory =
  | "DOM"
  | "SHOWINGS"
  | "FEEDBACK"
  | "OPEN_HOUSE"
  | "PRICE"
  | "ACTIVITY"

export interface ListingComponentScore {
  category: ListingHealthCategory
  score:    number            // 0-100
  weight:   number
  issues:   string[]
  data:     Record<string, unknown>
}

export type ListingRiskLevel = "healthy" | "watch" | "at_risk" | "critical"

export interface ListingHealthResult {
  listingId:        string
  overallScore:     number
  riskLevel:        ListingRiskLevel
  components:       ListingComponentScore[]
  aiNarrative:      string | null
  recommendedActions: Array<{ action: string; reasoning: string; impactEstimate?: string }>
  previousScore:    number | null
  scoreDelta:       number | null
  daysOnMarket:     number | null
}

export const CATEGORY_WEIGHTS: Record<ListingHealthCategory, number> = {
  DOM:        0.30,
  SHOWINGS:   0.20,
  FEEDBACK:   0.15,
  OPEN_HOUSE: 0.10,
  PRICE:      0.15,
  ACTIVITY:   0.10,
}

// ─── Component Scorers ──────────────────────────────────────────────────────

type Supa = ReturnType<typeof createServiceClient>

async function scoreDOM(supabase: Supa, listingId: string): Promise<ListingComponentScore> {
  const issues: string[] = []
  let score = 100
  let dom: number | null = null

  // DOM is computed from go_live_date (the public-active date). The pre-MLS
  // period (listing_date → go_live_date) doesn't count toward DOM.
  const { data: listing } = await supabase
    .from("listings")
    .select("go_live_date, list_price, city, state, status")
    .eq("id", listingId)
    .maybeSingle()

  dom = computeDaysOnMarket(listing?.go_live_date ?? null)
  if (dom !== null) {
    // DOM penalty curve — every market is different but these are common
    // industry-conservative thresholds.
    if (dom >= 90)      { score = 20; issues.push(`On market ${dom} days — well past typical absorption`) }
    else if (dom >= 60) { score = 40; issues.push(`On market ${dom} days — past comp-equivalent DOM`) }
    else if (dom >= 45) { score = 60; issues.push(`On market ${dom} days — approaching stale window`) }
    else if (dom >= 30) { score = 75; issues.push(`On market ${dom} days — watch for activity drop`) }
    else                { score = 95 }
  }

  return {
    category: "DOM",
    score,
    weight:   CATEGORY_WEIGHTS.DOM,
    issues,
    data:     { dom, go_live_date: listing?.go_live_date ?? null, status: listing?.status ?? null },
  }
}

async function scoreShowings(supabase: Supa, listingId: string): Promise<ListingComponentScore> {
  const issues: string[] = []
  let score = 100

  // Last 14 days vs prior 14 days for trend. Live schema uses
  // showings.scheduled_date (date), not showing_date.
  const fourteenDaysAgo  = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
  const twentyEightDaysAgo = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10)

  const { data: rows } = await supabase
    .from("showings")
    .select("id, scheduled_date, status, buyer_interest_level")
    .eq("listing_id", listingId)
    .gte("scheduled_date", twentyEightDaysAgo)

  const list = (rows ?? []) as Array<{ id: string; scheduled_date: string; status: string; buyer_interest_level: string | null }>
  const recent = list.filter((s) => s.scheduled_date >= fourteenDaysAgo)
  const prior  = list.filter((s) => s.scheduled_date <  fourteenDaysAgo)

  if (recent.length === 0) {
    score = 20
    issues.push("0 showings in last 14 days")
  } else if (recent.length === 1) {
    score = 55
    issues.push("Only 1 showing in last 14 days — interest is thin")
  } else if (recent.length < 3) {
    score = 75
    issues.push(`${recent.length} showings in last 14 days — below healthy cadence`)
  } else {
    score = 95
  }

  // Trend overlay — if recent <= 50% of prior, downgrade further
  if (prior.length >= 2 && recent.length <= Math.floor(prior.length / 2)) {
    score = Math.min(score, 50)
    issues.push(`Showings down ${prior.length} → ${recent.length} vs prior 14d window`)
  }

  return {
    category: "SHOWINGS",
    score,
    weight:   CATEGORY_WEIGHTS.SHOWINGS,
    issues,
    data:     { recent14: recent.length, prior14: prior.length, total28: list.length },
  }
}

async function scoreFeedback(supabase: Supa, listingId: string): Promise<ListingComponentScore> {
  const issues: string[] = []
  let score = 80   // neutral default if we have no feedback

  // Live schema: showings.buyer_interest_level (text), feedback (text), rating (int).
  const { data: rows } = await supabase
    .from("showings")
    .select("buyer_interest_level, rating")
    .eq("listing_id", listingId)
    .eq("status", "completed")
    .not("buyer_interest_level", "is", null)

  const list = (rows ?? []) as Array<{ buyer_interest_level: string | null; rating: number | null }>
  if (list.length === 0) {
    return {
      category: "FEEDBACK",
      score,
      weight:   CATEGORY_WEIGHTS.FEEDBACK,
      issues:   ["No buyer feedback captured yet"],
      data:     { sampleSize: 0 },
    }
  }

  const interested  = list.filter((r) => r.buyer_interest_level === "interested" || r.buyer_interest_level === "very_interested").length
  const notInterested = list.filter((r) => r.buyer_interest_level === "not_interested").length

  // Interest ratio (interested / total)
  const interestRatio = interested / list.length
  score = Math.round(interestRatio * 100)

  if (notInterested >= 3 && notInterested >= Math.floor(list.length * 0.4)) {
    issues.push(`${notInterested} buyers passed — repeated "not interested" feedback`)
    score = Math.min(score, 45)
  }
  if (interested === 0 && list.length >= 3) {
    issues.push("3+ showings, 0 interested buyers")
    score = Math.min(score, 35)
  }

  return {
    category: "FEEDBACK",
    score,
    weight:   CATEGORY_WEIGHTS.FEEDBACK,
    issues,
    data:     { sampleSize: list.length, interested, notInterested, interestRatio },
  }
}

/**
 * OPEN_HOUSE — scored off `open_house_events` + the ATTENDEE LEDGER, not off
 * `open_houses`' counter columns.
 *
 * WAS: `.from("open_houses").select("… total_check_ins, total_leads_generated,
 * total_rsvps …")`, and every one of those three counters is written by NOBODY.
 * They exist only as `integer DEFAULT 0` (scripts/994-create-open-houses-
 * canonical.sql:39-41, scripts/525-create-open-house-automation-system.sql:56-58)
 * and no TypeScript in the tree ever assigns them — verified by grep across
 * app/, lib/, services/ and every .sql: the only non-DDL hits were this file's
 * own read. So `avgCheckIns` was structurally 0, and this component returned
 * exactly one of two values forever: 80 when `open_houses` had no row for the
 * listing, and **30 with the issue "Open houses held with zero check-ins"** the
 * moment it had one — 10% of every listing's health score, and a false
 * accusation printed at the seller.
 *
 * The counters cannot be filled in where they are, either: `open_houses` has NO
 * child tables. Every open-house child in the live schema — `open_house_attendees`,
 * `open_house_rsvp_tracking`, `open_house_invitations`, `open_house_feedback`,
 * `open_house_analytics` — carries `event_id → open_house_events.id` (verified
 * against the live FK catalogue, project hrvaqgvukzxfskkcrwbt). There is no
 * attendance data hanging off `open_houses` and no way to derive any.
 *
 * SURVIVOR: `open_house_events` is the live open-house table — ~50 call sites
 * across the whole feature (app/actions/open-house-automation.ts,
 * app/actions/open-house.ts, app/actions/seller-open-house.ts, the check-in API
 * at app/api/open-house/attend/route.ts, both open-house crons, the RSVP and
 * feedback pages) against 4 for `open_houses`. Check-ins are real rows:
 * app/api/open-house/attend/route.ts:139 inserts an `open_house_attendees` row
 * stamped with `check_in_time`, and upserts `open_house_rsvp_tracking` to
 * `rsvp_status='attended'` at :180. Leads generated are the attendee rows that
 * resolved to a contact (`open_house_attendees.contact_id`).
 *
 * So the same three numbers this component always wanted are COUNTED from the
 * ledger that actually has writers, and the scoring tiers below are unchanged.
 * `open_houses` itself is left alone: lib/kernel/launch-war-room.ts still
 * inserts scheduling rows there and retiring the table is a migration, not a
 * scorer change.
 */
async function scoreOpenHouse(supabase: Supa, listingId: string): Promise<ListingComponentScore> {
  const issues: string[] = []
  let score = 80   // neutral default if no open house yet

  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  // `error` is destructured and read: supabase-js RESOLVES a refusal, so a
  // dropped read would otherwise render as "this listing held no open house"
  // and quietly hand back the neutral 80 — the same silence this rewrite exists
  // to end, one layer up.
  const { data: events, error: eventsError } = await supabase
    .from("open_house_events")
    .select("id, event_date, status")
    .eq("listing_id", listingId)
    .gte("event_date", ninetyDaysAgo)

  if (eventsError) {
    return {
      category: "OPEN_HOUSE",
      score,
      weight:   CATEGORY_WEIGHTS.OPEN_HOUSE,
      issues:   [`Open house data unavailable: ${eventsError.message}`],
      data:     { unavailable: true, error: eventsError.message },
    }
  }

  const list = (events ?? []) as Array<{
    id: string
    event_date: string | null
    status: string | null
  }>

  if (list.length === 0) {
    return {
      category: "OPEN_HOUSE",
      score,
      weight:   CATEGORY_WEIGHTS.OPEN_HOUSE,
      issues:   ["No open house held in last 90 days"],
      data:     { count: 0 },
    }
  }

  // "Completed" = event_date is in the past AND status not cancelled.
  const completed = list.filter(
    (o) => o.event_date && o.event_date < today && o.status !== "cancelled",
  )

  let totalCheckIns = 0
  let totalLeads = 0
  let totalRsvps = 0
  if (completed.length > 0) {
    const eventIds = completed.map((o) => o.id)
    const [attendeesRes, rsvpRes] = await Promise.all([
      supabase
        .from("open_house_attendees")
        .select("id, event_id, check_in_time, contact_id")
        .in("event_id", eventIds),
      supabase
        .from("open_house_rsvp_tracking")
        .select("id, event_id, rsvp_status")
        .in("event_id", eventIds),
    ])
    if (attendeesRes.error || rsvpRes.error) {
      const message = attendeesRes.error?.message ?? rsvpRes.error?.message ?? "unknown"
      return {
        category: "OPEN_HOUSE",
        score,
        weight:   CATEGORY_WEIGHTS.OPEN_HOUSE,
        issues:   [`Open house attendance unavailable: ${message}`],
        data:     { unavailable: true, error: message, count: list.length, completed: completed.length },
      }
    }
    const attendees = (attendeesRes.data ?? []) as Array<{
      check_in_time: string | null
      contact_id: string | null
    }>
    // A CHECK-IN is an attendee row with a check_in_time — the column
    // app/api/open-house/attend/route.ts:143 stamps. An attendee row without one
    // was pre-registered and never walked in, and counting it would restore the
    // same over-count the dead counters could never even reach.
    totalCheckIns = attendees.filter((a) => a.check_in_time).length
    totalLeads = attendees.filter((a) => a.check_in_time && a.contact_id).length
    totalRsvps = ((rsvpRes.data ?? []) as Array<{ rsvp_status: string | null }>)
      .filter((r) => r.rsvp_status && r.rsvp_status !== "no").length
  }

  const avgCheckIns = completed.length > 0 ? totalCheckIns / completed.length : 0

  // Avg-check-ins scoring tiers
  if (avgCheckIns >= 15)       score = 95
  else if (avgCheckIns >= 8)   score = 80
  else if (avgCheckIns >= 4)   score = 65
  else if (avgCheckIns >= 1)   { score = 45; issues.push(`Open house avg check-ins only ${avgCheckIns.toFixed(1)}`) }
  else if (completed.length > 0) { score = 30; issues.push("Open houses held with zero check-ins") }

  return {
    category: "OPEN_HOUSE",
    score,
    weight:   CATEGORY_WEIGHTS.OPEN_HOUSE,
    issues,
    data:     { count: list.length, completed: completed.length, totalCheckIns, totalLeads, totalRsvps, avgCheckIns },
  }
}

async function scorePrice(supabase: Supa, listingId: string): Promise<ListingComponentScore> {
  // Best-effort — we don't always have live comp data. Score the list price
  // against transactions.purchase_price for closed deals in the same city in
  // the last 90 days as a proxy.
  const issues: string[] = []
  let score = 80
  let medianComp: number | null = null
  let gapPct: number | null = null

  const { data: listing } = await supabase
    .from("listings")
    .select("list_price, city, state, bedrooms, sqft, brokerage_id")
    .eq("id", listingId)
    .maybeSingle()

  if (!listing?.list_price || !listing.city) {
    return {
      category: "PRICE",
      score,
      weight:   CATEGORY_WEIGHTS.PRICE,
      issues:   ["Insufficient comp data to score price"],
      data:     { reason: "missing list_price or city" },
    }
  }

  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
  // tenant anchor (scope burn-down): comps come from the SAME brokerage's closed
  // deals — one tenant's transaction rows are never read to score another's listing.
  let compsQuery = supabase
    .from("transactions")
    .select("purchase_price, property_city, contract_date, close_date")
    .eq("property_city", listing.city)
    .eq("status", "closed")
    .gte("close_date", ninetyDaysAgo)
    .not("purchase_price", "is", null)
    .limit(20)
  if ((listing as any).brokerage_id) compsQuery = compsQuery.eq("brokerage_id", (listing as any).brokerage_id)
  const { data: comps } = await compsQuery

  const list = (comps ?? []) as Array<{ purchase_price: number | null }>
  const prices = list.map((r) => Number(r.purchase_price ?? 0)).filter((n) => n > 0)
  if (prices.length >= 3) {
    const sorted = [...prices].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    medianComp = sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    if (medianComp && medianComp > 0) {
      gapPct = ((Number(listing.list_price) - medianComp) / medianComp) * 100
      if (gapPct > 12)       { score = 30; issues.push(`List ${gapPct.toFixed(1)}% above median comp $${Math.round(medianComp).toLocaleString()}`) }
      else if (gapPct > 6)   { score = 55; issues.push(`List ${gapPct.toFixed(1)}% above median comp`) }
      else if (gapPct > -2)  { score = 85 }   // priced reasonably to comps
      else if (gapPct > -8)  { score = 95 }   // priced under — good interest signal
      else                   { score = 75; issues.push(`List ${Math.abs(gapPct).toFixed(1)}% below median comp — may be under-priced`) }
    }
  }

  return {
    category: "PRICE",
    score,
    weight:   CATEGORY_WEIGHTS.PRICE,
    issues,
    data:     { list_price: listing.list_price, medianComp, gapPct, sampleSize: prices.length },
  }
}

async function scoreActivity(supabase: Supa, listingId: string): Promise<ListingComponentScore> {
  // Recent meaningful activity on the listing's contact (price change, new
  // photos, agent task, etc.). Best-effort via activities.listing_id.
  const issues: string[] = []
  let score = 100

  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { count } = await supabase
    .from("activities")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listingId)
    .gte("created_at", sevenDaysAgo)

  const recent = count ?? 0
  if (recent === 0) {
    score = 50
    issues.push("No agent activity logged in last 7 days")
  } else if (recent < 2) {
    score = 75
  }

  return {
    category: "ACTIVITY",
    score,
    weight:   CATEGORY_WEIGHTS.ACTIVITY,
    issues,
    data:     { activitiesLast7d: recent },
  }
}

// ─── Main scorer ────────────────────────────────────────────────────────────

export async function calculateListingHealth(params: {
  listingId: string
}): Promise<ListingHealthResult> {
  const supabase = createServiceClient()

  const { listingId } = params

  // Resolve listing meta upfront for the persistence write
  const { data: listing } = await supabase
    .from("listings")
    .select("id, brokerage_id, agent_id, listing_date, address, city, state, list_price, status")
    .eq("id", listingId)
    .maybeSingle()

  if (!listing) {
    throw new Error(`Listing ${listingId} not found`)
  }
  // listings.agent_id, listing_health_scores.agent_id and
  // listing_health_interventions.agent_id are now all the same class — agents(id) —
  // so the listing's own agent goes straight through. The users.id round-trip this
  // used to make existed only to satisfy the old FK and has no meaning left.
  // Both columns are nullable: an unassigned listing still gets scored, it just
  // carries no agent, which is what the data actually says.
  const healthAgentId = (listing.agent_id as string | null) ?? null
  if (!healthAgentId) {
    // Unattended scan — say it once, or an unassigned listing's missing agent
    // attribution is invisible forever.
    console.warn(`[listing-health] listing ${listingId} has no agent_id — score + interventions persist unattributed`)
  }

  // Score every component in parallel
  const [dom, showings, feedback, openHouse, price, activity] = await Promise.all([
    scoreDOM(supabase, listingId),
    scoreShowings(supabase, listingId),
    scoreFeedback(supabase, listingId),
    scoreOpenHouse(supabase, listingId),
    scorePrice(supabase, listingId),
    scoreActivity(supabase, listingId),
  ])

  const components = [dom, showings, feedback, openHouse, price, activity]

  // Weighted rollup
  let weightedSum = 0
  let totalWeight = 0
  for (const c of components) {
    weightedSum += c.score * c.weight
    totalWeight += c.weight
  }
  const overallScore = Math.round(weightedSum / Math.max(totalWeight, 0.001))

  // Risk tier
  let riskLevel: ListingRiskLevel = "healthy"
  if (overallScore < 40)      riskLevel = "critical"
  else if (overallScore < 70) riskLevel = "at_risk"
  else if (overallScore < 85) riskLevel = "watch"

  // Previous score for trend
  const { data: prev } = await supabase
    .from("listing_health_scores")
    .select("overall_score, risk_level")
    .eq("listing_id", listingId)
    .order("scored_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const previousScore = (prev?.overall_score as number | null | undefined) ?? null
  const scoreDelta    = previousScore != null ? overallScore - Number(previousScore) : null

  const flagsList = components.flatMap((c) => c.issues)

  // AI narrative + recommended actions (best-effort)
  let aiNarrative: string | null = null
  const recommendedActions: Array<{ action: string; reasoning: string; impactEstimate?: string }> = []
  if (riskLevel === "at_risk" || riskLevel === "critical") {
    try {
      const r = await generateDealHealthNarrative({
        propertyAddress: listing.address ?? "the listing",
        overallScore,
        riskLevel,
        components,
        // §4 — the listing row's own tenant, the same one every kernel event
        // emitted below is stamped with.
        brokerageId: listing.brokerage_id ?? null,
      })
      aiNarrative = r.narrative
      recommendedActions.push(...r.recommendedActions)
    } catch {
      // best effort
    }
  }

  // Persist score
  const daysOnMarket =
    (dom.data.dom as number | null | undefined) ?? null
  await supabase.from("listing_health_scores").insert({
    listing_id:         listingId,
    brokerage_id:       listing.brokerage_id ?? null,
    agent_id:           healthAgentId,
    overall_score:      overallScore,
    risk_level:         riskLevel,
    score_components:   components.map((c) => ({
      category:  c.category,
      weight:    c.weight,
      score:     c.score,
      severity:  c.score >= 85 ? "low" : c.score >= 70 ? "medium" : c.score >= 40 ? "high" : "critical",
      issues:    c.issues,
      data:      c.data,
    })),
    flags:              flagsList,
    ai_narrative:       aiNarrative,
    recommended_actions: recommendedActions,
    previous_score:     previousScore,
    score_delta:        scoreDelta,
    days_on_market:     daysOnMarket,
  })

  // Create intervention rows for critical issues, if none unresolved already
  if (riskLevel === "at_risk" || riskLevel === "critical") {
    const { data: openInt } = await supabase
      .from("listing_health_interventions")
      .select("id")
      .eq("listing_id", listingId)
      .eq("resolved", false)
      .limit(1)

    if (!openInt || openInt.length === 0) {
      // Open the top issue
      const topComponent = components
        .filter((c) => c.issues.length > 0)
        .sort((a, b) => a.score - b.score)[0]
      const issue = topComponent?.issues[0]
      if (issue) {
        await supabase.from("listing_health_interventions").insert({
          listing_id:        listingId,
          brokerage_id:      listing.brokerage_id ?? null,
          agent_id:          healthAgentId,
          issue_detected:    issue,
          severity:          riskLevel === "critical" ? "critical" : "high",
          ai_recommendation: aiNarrative ?? recommendedActions[0]?.action ?? null,
          category:          topComponent?.category.toLowerCase() ?? null,
          seller_impacted:   true,
          resolved:          false,
        })
      }
    }
  }

  // Fire kernel events through the canonical emitter (insert + reactor fan-out in one call).
  // Bare lifecycle_events inserts silently dropped notifications/sequences/portal — emit() fixes that.
  await emitKernelEvent({
    event:       KernelEvent.LISTING_HEALTH_SCORE_UPDATED,
    brokerageId: listing.brokerage_id ?? null,
    entityType:  "listing",
    entityId:    listingId,
    listingId,
    metadata: {
      overall_score: overallScore,
      risk_level:    riskLevel,
      score_delta:   scoreDelta,
      flags:         flagsList,
    },
  })
  if (riskLevel === "critical" || riskLevel === "at_risk") {
    await emitKernelEvent({
      event:       KernelEvent.LISTING_AT_RISK_DETECTED,
      brokerageId: listing.brokerage_id ?? null,
      entityType:  "listing",
      entityId:    listingId,
      listingId,
      metadata: {
        overall_score: overallScore,
        risk_level:    riskLevel,
        flags:         flagsList,
      },
    })
  }

  return {
    listingId,
    overallScore,
    riskLevel,
    components,
    aiNarrative,
    recommendedActions,
    previousScore,
    scoreDelta,
    daysOnMarket,
  }
}

// ─── AI narrative ───────────────────────────────────────────────────────────

async function generateDealHealthNarrative(input: {
  propertyAddress: string
  overallScore:    number
  riskLevel:       ListingRiskLevel
  components:      ListingComponentScore[]
  /** Tenant for the AI cost ledger — the LISTING row's own brokerage, which
   *  this file already uses as the tenant for every kernel event it emits.
   *  Never a caller argument (§4). */
  brokerageId:     string | null
}): Promise<{
  narrative: string
  recommendedActions: Array<{ action: string; reasoning: string; impactEstimate?: string }>
}> {
  const issuesByCategory = input.components
    .filter((c) => c.issues.length > 0)
    .map((c) => `- ${c.category} (${c.score}/100): ${c.issues.join("; ")}`)
    .join("\n")

  const prompt = `You are advising a real estate agent on an at-risk active listing.
Property: ${input.propertyAddress}
Overall health score: ${input.overallScore}/100 (${input.riskLevel.toUpperCase()})

Issues detected:
${issuesByCategory}

In 3-4 sentences write a direct narrative to the agent: what is wrong with this listing and the 2 most-impactful next moves. No jargon. Be specific.

Then on a new line, output a JSON array of 2-3 recommended actions in this exact format:
ACTIONS_JSON: [{"action": "...", "reasoning": "...", "impactEstimate": "..."}]`

  const result = await generateTextRouted({
    brokerageId: input.brokerageId,
    feature: "listing_health_narrative",
    messages: [{ role: "user", content: prompt }],
  })

  const text = result.text ?? ""
  const jsonMatch = text.match(/ACTIONS_JSON:\s*(\[[\s\S]*\])/)
  const narrative = (jsonMatch ? text.slice(0, jsonMatch.index) : text).trim()
  let recommendedActions: Array<{ action: string; reasoning: string; impactEstimate?: string }> = []
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as unknown
      if (Array.isArray(parsed)) {
        recommendedActions = parsed
          .filter((x): x is { action: string; reasoning: string; impactEstimate?: string } =>
            !!x && typeof x === "object" && "action" in x && typeof (x as { action: unknown }).action === "string",
          )
          .slice(0, 3)
      }
    } catch {
      // ignore
    }
  }

  return { narrative, recommendedActions }
}
