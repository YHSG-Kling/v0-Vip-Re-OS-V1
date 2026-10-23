"use server"

/**
 * /dashboard/listings/health — server actions.
 *
 * Builds the agent's "every listing I have, sorted by how worried I should
 * be" board on top of data the listing-health-scan cron already populates:
 *
 *   listing_health_scores         12-hourly snapshot per listing with
 *                                 overall_score, risk_level, flags,
 *                                 ai_narrative, recommended_actions (jsonb)
 *   listing_health_interventions  auto-created when risk >= at_risk;
 *                                 carries severity, issue_detected,
 *                                 ai_recommendation, resolved/resolved_at
 *   listings                      the master listing row
 *
 * draftSellerPriceReductionEmail uses generateTextRouted to produce a
 * seller-facing email body that references the actual score flags + the
 * listing's price and days-on-market. The agent reviews + sends from
 * their own inbox — we never auto-send to a seller.
 */

import { createClient } from "@/lib/supabase/server"
import { computePriceDropRecommendation } from "@/lib/kernel/listing-price-advisor"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { RESOLVED_HISTORY_LIMIT, RESOLVED_HISTORY_WINDOW_DAYS } from "@/lib/listing-health/resolved-history-bounds"

export type RiskLevel = "healthy" | "watch" | "at_risk" | "critical"

export interface ListingHealthRow {
  listingId:         string
  address:           string | null
  listPrice:         number | null
  bedrooms:          number | null
  bathrooms:         number | null
  status:            string | null
  goLiveDate:        string | null
  scoreId:           string | null
  /**
   * listing_health_scores.agent_id — the agent who OWNED the listing at the moment
   * the score was written (lib/listing-health/health-scorer.ts:572 copies
   * listings.agent_id, so it is AGENTS class, not users). Nullable: an unassigned
   * listing is still scored.
   */
  scoredAgentId:     string | null
  /**
   * TRUE when this row's score was produced under a DIFFERENT agent than the one
   * reading the board. The board selects listings by their CURRENT agent_id, so a
   * reassigned listing arrives carrying the previous owner's snapshot — the score,
   * the flags and the narrative are all about somebody else's work on it. Until
   * agent_id was read, that row was presented as this agent's own. It stays on the
   * board (the listing is theirs now and the risk is real); it is LABELLED, not
   * hidden and not silently attributed.
   */
  scoredUnderPreviousAgent: boolean
  overallScore:      number | null
  previousScore:     number | null
  scoreDelta:        number | null
  riskLevel:         RiskLevel
  daysOnMarket:      number | null
  flags:             string[]
  aiNarrative:       string | null
  recommendedActions: Array<{ action: string; reasoning: string; impactEstimate?: string }>
  /** Recommended price move — null when the advisor honestly declines. */
  priceAdvice: {
    recommend:        boolean
    recommendedPrice: number | null
    dropAmount:       number | null
    dropPct:          number | null
    justification:    string[]
    confidence:       "low" | "medium" | "high"
    reason:           string
  } | null
  interventions: Array<{
    id:               string
    severity:         "low" | "medium" | "high" | "critical"
    category:         string | null
    issueDetected:    string | null
    aiRecommendation: string | null
    sellerImpacted:   boolean
    createdAt:        string
  }>
}

/** A CLEARED intervention across the board, with who cleared it. */
export interface RecentlyClearedIntervention {
  id:               string
  listingId:        string
  address:          string | null
  severity:         "low" | "medium" | "high" | "critical"
  category:         string | null
  issueDetected:    string | null
  sellerImpacted:   boolean
  createdAt:        string
  resolvedAt:       string | null
  /** users.id (scripts/schema-fk-map.ts:458 — resolved_by → users). */
  resolvedBy:       string | null
  /** Resolved tenant-scoped. Null with resolvedBy set = an account outside
   *  this brokerage; both null = nobody was recorded. */
  resolvedByName:   string | null
  resolutionNote:   string | null
}

/**
 * The cross-listing "recently cleared" audit. BOUNDS ARE STATED, not implied:
 * newest `limit`, resolved within `windowDays`. `error` is the refused read —
 * a refused audit read must render as "could not read", never as "nothing was
 * ever cleared" (§3: supabase-js RESOLVES refusals).
 */
export interface RecentlyClearedBoard {
  rows:       RecentlyClearedIntervention[]
  error:      string | null
  windowDays: number
  limit:      number
}

export interface ListingHealthBoard {
  rows: ListingHealthRow[]
  summary: { healthy: number; watch: number; at_risk: number; critical: number }
  recentlyCleared: RecentlyClearedBoard
}

// THE SAME BOUNDS AS THE PER-LISTING AUDIT (§6 — one spelling of "recent").
// RESOLVED_HISTORY_LIMIT / RESOLVED_HISTORY_WINDOW_DAYS are imported above from
// lib/listing-health/resolved-history-bounds.ts, which carries the rationale.
// TOMBSTONE (2026-09-03): the module-level restatement that stood here (the
// lifecycle page's copy was function-local and not importable) is the hoist
// its own comment named as the follow-up.

export async function loadListingHealthBoard(): Promise<ListingHealthBoard | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { error: "No agent profile" }

  // 1. All listings owned by this agent that are active/coming_soon/pending
  const { data: listings } = await svc
    .from("listings")
    .select("id, address, list_price, bedrooms, bathrooms, status, go_live_date")
    .eq("agent_id", agentRow.id)
    .in("status", ["active", "coming_soon", "pending"])
    .order("go_live_date", { ascending: false })
    .limit(100)

  const listingIds = (listings ?? []).map((l: { id: string }) => l.id)
  const emptyCleared: RecentlyClearedBoard = {
    rows: [], error: null, windowDays: RESOLVED_HISTORY_WINDOW_DAYS, limit: RESOLVED_HISTORY_LIMIT,
  }
  if (listingIds.length === 0) {
    return { rows: [], summary: { healthy: 0, watch: 0, at_risk: 0, critical: 0 }, recentlyCleared: emptyCleared }
  }

  // 2. Latest score per listing — cron writes a row every 12h; we use the most
  //    recent scored_at per listing_id.
  const { data: scores } = await svc
    .from("listing_health_scores")
    .select("id, listing_id, agent_id, overall_score, previous_score, score_delta, risk_level, days_on_market, flags, ai_narrative, recommended_actions, scored_at")
    .in("listing_id", listingIds)
    .order("scored_at", { ascending: false })
  const scoreByListing = new Map<string, any>()
  for (const s of scores ?? []) {
    if (!scoreByListing.has(s.listing_id)) scoreByListing.set(s.listing_id, s)
  }

  // 3. Open interventions per listing
  const { data: interventions } = await svc
    .from("listing_health_interventions")
    .select("id, listing_id, severity, category, issue_detected, ai_recommendation, seller_impacted, resolved, created_at")
    .in("listing_id", listingIds)
    .eq("resolved", false)
    .order("severity", { ascending: false })
    .order("created_at", { ascending: false })
  const interventionsByListing = new Map<string, any[]>()
  for (const i of interventions ?? []) {
    const list = interventionsByListing.get(i.listing_id) ?? []
    list.push(i)
    interventionsByListing.set(i.listing_id, list)
  }

  // 3b. RECENTLY CLEARED — the cross-listing audit (built 2026-09-02).
  //     The open-only read above is deliberately untouched; this is a SECOND,
  //     bounded read beside it, mirroring the per-listing history at
  //     app/dashboard/listings/[id]/lifecycle/page.tsx:265-318: resolved=true,
  //     resolved_at within the window, newest first, limit, error READ, and
  //     the clearer's name resolved tenant-scoped. Before this a broker
  //     sweeping ALL listings could see what was open on each and never who
  //     had cleared what — the resolution record (resolved_by / resolved_at /
  //     resolution_note, stamped by resolveIntervention below) existed only
  //     one listing at a time.
  //
  //     Service client, so the tenant predicate is EXPLICIT (§4): the listing
  //     ids are already this agent's, and brokerage_id is anchored to the
  //     session's agents row resolved at the top of this function.
  const resolvedSince = new Date(Date.now() - RESOLVED_HISTORY_WINDOW_DAYS * 86_400_000).toISOString()
  const { data: clearedRows, error: clearedError } = await svc
    .from("listing_health_interventions")
    .select("id, listing_id, severity, category, issue_detected, seller_impacted, created_at, resolved_at, resolved_by, resolution_note")
    .in("listing_id", listingIds)
    .eq("brokerage_id", agentRow.brokerage_id)
    .eq("resolved", true)
    .gte("resolved_at", resolvedSince)
    .order("resolved_at", { ascending: false })
    .limit(RESOLVED_HISTORY_LIMIT)
  if (clearedError) {
    // §3: a swallowed error here would render the audit as "nothing has ever
    // been cleared" — the opposite of what this section exists to tell.
    console.error("[listing health board] recently-cleared read failed:", clearedError.message)
  }

  // WHO CLEARED IT. resolved_by FKs users(id) (scripts/schema-fk-map.ts:458) —
  // USERS-class, disjoint from agents.id, so it is never resolved against
  // `agents`. One batched `.in()`, anchored to the session's brokerage, so a
  // foreign id stays unresolved rather than borrowing a name from another
  // tenant. Same lookup the lifecycle page makes at :300-314.
  const resolverNames = new Map<string, string>()
  const resolverIds = Array.from(new Set(
    (clearedRows ?? []).map((r: any) => r.resolved_by as string | null).filter((v): v is string => !!v),
  ))
  let resolverError: string | null = null
  if (resolverIds.length > 0) {
    const { data: resolvers, error: resolverErr } = await svc
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", resolverIds)
      .eq("brokerage_id", agentRow.brokerage_id)
    if (resolverErr) {
      console.error("[listing health board] resolver name lookup failed:", resolverErr.message)
      resolverError = resolverErr.message
    }
    for (const u of (resolvers ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
      const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
      resolverNames.set(u.id, full || u.email || "Teammate")
    }
  }
  const addressByListing = new Map<string, string | null>(
    (listings ?? []).map((l: any) => [l.id as string, (l.address ?? null) as string | null]),
  )
  const recentlyCleared: RecentlyClearedBoard = {
    rows: clearedError ? [] : (clearedRows ?? []).map((r: any) => ({
      id:             r.id,
      listingId:      r.listing_id,
      address:        addressByListing.get(r.listing_id) ?? null,
      severity:       r.severity,
      category:       r.category ?? null,
      issueDetected:  r.issue_detected ?? null,
      sellerImpacted: r.seller_impacted ?? false,
      createdAt:      r.created_at,
      resolvedAt:     r.resolved_at ?? null,
      resolvedBy:     r.resolved_by ?? null,
      resolvedByName: r.resolved_by ? (resolverNames.get(r.resolved_by) ?? null) : null,
      resolutionNote: r.resolution_note ?? null,
    })),
    // The rows are still shown when only the NAME lookup failed — the audit
    // is real, the names are the part that could not be read, and the client
    // says which.
    error: clearedError
      ? `Could not read the cleared-intervention history: ${clearedError.message}`
      : resolverError
      ? `Cleared history loaded, but resolver names could not be read: ${resolverError}`
      : null,
    windowDays: RESOLVED_HISTORY_WINDOW_DAYS,
    limit: RESOLVED_HISTORY_LIMIT,
  }

  // Price-advice inputs. Showing VELOCITY (last 14d vs the prior 14d) and the
  // comp median are what turn "this listing is stale" into "list it at $X".
  const showingsRecent = new Map<string, number>()
  const showingsPrior = new Map<string, number>()
  const compMedianByListing = new Map<string, number>()
  if (listingIds.length > 0) {
    const now = Date.now()
    const d14 = new Date(now - 14 * 86_400_000).toISOString()
    const d28 = new Date(now - 28 * 86_400_000).toISOString()
    const { data: showRows } = await svc
      .from("showings")
      .select("listing_id, scheduled_date")
      .in("listing_id", listingIds)
      .eq("brokerage_id", agentRow.brokerage_id)
      .gte("scheduled_date", d28)
    for (const r of (showRows ?? []) as any[]) {
      const when = String(r.scheduled_date ?? "")
      const bucket = when >= d14 ? showingsRecent : showingsPrior
      bucket.set(r.listing_id, (bucket.get(r.listing_id) ?? 0) + 1)
    }
    const { data: cmaRows } = await svc
      .from("cma_reports")
      .select("listing_id, recommended_price, created_at")
      .in("listing_id", listingIds)
      .eq("brokerage_id", agentRow.brokerage_id)
      .order("created_at", { ascending: false })
    for (const r of (cmaRows ?? []) as any[]) {
      if (r.recommended_price != null && !compMedianByListing.has(r.listing_id)) {
        compMedianByListing.set(r.listing_id, Number(r.recommended_price))
      }
    }
  }

  // Risk-level ordering for sorting: critical first, then at_risk, watch, healthy.
  const RISK_ORDER: Record<RiskLevel, number> = { critical: 0, at_risk: 1, watch: 2, healthy: 3 }

  const rows: ListingHealthRow[] = (listings ?? []).map((l: any) => {
    const s = scoreByListing.get(l.id) ?? {}
    const ivs = (interventionsByListing.get(l.id) ?? []) as any[]
    const riskLevel = (s.risk_level ?? "healthy") as RiskLevel
    return {
      listingId:    l.id,
      address:      l.address ?? null,
      listPrice:    l.list_price ?? null,
      bedrooms:     l.bedrooms ?? null,
      bathrooms:    l.bathrooms ?? null,
      status:       l.status ?? null,
      goLiveDate:   l.go_live_date ?? null,
      scoreId:      s.id ?? null,
      scoredAgentId: (s.agent_id ?? null) as string | null,
      // Only a score that EXISTS and names a DIFFERENT agent counts. A null
      // agent_id (unassigned when scored) is not evidence of a handover, and
      // neither is the absence of a score row.
      scoredUnderPreviousAgent: !!s.id && !!s.agent_id && s.agent_id !== agentRow.id,
      overallScore: s.overall_score != null ? Number(s.overall_score) : null,
      previousScore: s.previous_score != null ? Number(s.previous_score) : null,
      scoreDelta:   s.score_delta != null ? Number(s.score_delta) : null,
      riskLevel,
      daysOnMarket: s.days_on_market ?? null,
      flags:        Array.isArray(s.flags) ? (s.flags as string[]) : [],
      aiNarrative:  s.ai_narrative ?? null,
      recommendedActions: Array.isArray(s.recommended_actions)
        ? (s.recommended_actions as Array<{ action: string; reasoning: string; impactEstimate?: string }>)
        : [],
      priceAdvice:
        l.list_price != null && s.days_on_market != null
          ? computePriceDropRecommendation({
              listPrice: Number(l.list_price),
              daysOnMarket: Number(s.days_on_market),
              showingsRecent: showingsRecent.get(l.id) ?? 0,
              showingsPrior: showingsPrior.get(l.id) ?? 0,
              compMedian: compMedianByListing.get(l.id) ?? null,
            })
          : null,
      interventions: ivs.map((iv) => ({
        id:               iv.id,
        severity:         iv.severity,
        category:         iv.category ?? null,
        issueDetected:    iv.issue_detected ?? null,
        aiRecommendation: iv.ai_recommendation ?? null,
        sellerImpacted:   iv.seller_impacted ?? false,
        createdAt:        iv.created_at,
      })),
    }
  })

  rows.sort((a, b) => {
    const ra = RISK_ORDER[a.riskLevel]; const rb = RISK_ORDER[b.riskLevel]
    if (ra !== rb) return ra - rb
    // within same risk level, sort by overall score (lower = worse)
    return (a.overallScore ?? 100) - (b.overallScore ?? 100)
  })

  const summary = rows.reduce(
    (acc, r) => { acc[r.riskLevel] = (acc[r.riskLevel] ?? 0) + 1; return acc },
    { healthy: 0, watch: 0, at_risk: 0, critical: 0 } as Record<RiskLevel, number>
  )

  return { rows, summary, recentlyCleared }
}

/**
 * Mark an intervention resolved. Owner-or-broker only. The original assignee
 * (the agent who owns the listing) is the typical resolver.
 */
export async function resolveIntervention(
  interventionId: string,
  note: string | null
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()

  // GATE FIRST, THEN THE SERVICE CLIENT (§4). This update previously matched on
  // `interventionId` alone: service client, so RLS does not save it, and no
  // brokerage or agent predicate — a caller who knew (or guessed) an id could
  // resolve ANOTHER TENANT'S intervention, and §3 says an UPDATE matching
  // nothing also resolves, so the wrong-tenant attempt reported success. The
  // resolution is now auditable to a real person (resolved_by is read by the
  // listing lifecycle history), which makes a forged one worse than useless.
  //
  // Same anchor the read paths in this file use at :79 — the caller's own agents
  // row. A caller with no agents row cannot resolve anything.
  const { data: agentRow, error: agentErr } = await svc
    .from("agents")
    .select("brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()
  if (agentErr) return { success: false, error: "Could not verify your brokerage — nothing was resolved." }
  if (!agentRow?.brokerage_id) return { success: false, error: "Your account is not linked to a brokerage." }

  // COUNTED (§3): with the tenant predicate in place, zero matched rows is a
  // refusal — wrong tenant, unknown id, or already resolved — not a silent
  // success. All three are the same answer to the caller and none of them may
  // render as "resolved".
  const { data: updated, error } = await svc
    .from("listing_health_interventions")
    .update({
      resolved:        true,
      resolved_at:     new Date().toISOString(),
      resolved_by:     user.id,
      resolution_note: note,
    })
    .eq("id", interventionId)
    .eq("resolved", false)
    .eq("brokerage_id", agentRow.brokerage_id)
    .select("id")
  if (error) return { success: false, error: error.message }
  if (!updated || updated.length === 0) {
    return { success: false, error: "That intervention was not found in your brokerage, or it was already resolved." }
  }
  return { success: true }
}

/**
 * Draft a seller-facing email proposing the recommended action (price drop,
 * marketing push, etc). Uses AI to write the body in the agent's voice,
 * referencing the actual score flags and listing data. Returns the draft
 * for the agent to review and send — never auto-sends to a seller.
 */
export async function draftSellerActionEmail(
  listingId: string
): Promise<{ success: boolean; subject?: string; body?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: listing } = await svc
    .from("listings")
    .select("id, address, list_price, bedrooms, bathrooms, agent_id, brokerage_id, go_live_date, status")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { success: false, error: "Listing not found" }

  const { data: agentRow } = await svc
    .from("agents")
    .select("id, user_id")
    .eq("user_id", user.id)
    .maybeSingle()
  if (!agentRow || agentRow.id !== listing.agent_id) {
    return { success: false, error: "You don't own this listing" }
  }

  const { data: score } = await svc
    .from("listing_health_scores")
    .select("overall_score, risk_level, days_on_market, flags, ai_narrative, recommended_actions")
    .eq("listing_id", listingId)
    .order("scored_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: agentUser } = await svc
    .from("users")
    .select("first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()
  const agentDisplayName =
    [agentUser?.first_name, agentUser?.last_name].filter(Boolean).join(" ") || "your agent"

  const flagsList = Array.isArray(score?.flags) ? (score!.flags as string[]) : []
  const recActions = Array.isArray(score?.recommended_actions)
    ? (score!.recommended_actions as Array<{ action: string; reasoning: string }>)
    : []

  const propertyLabel = listing.address ?? `the property`
  const priceLabel = listing.list_price ? `$${Math.round(listing.list_price).toLocaleString()}` : ""
  const dom = score?.days_on_market ?? null

  const aiPrompt = `You are a residential real-estate agent named ${agentDisplayName}. Write a SHORT, warm, professional email to the seller about their listing. Be honest but reassuring — no panic. Use plain language, no jargon. End with a specific next-step proposal.

LISTING: ${propertyLabel}${priceLabel ? `, listed at ${priceLabel}` : ""}
${dom != null ? `DAYS ON MARKET: ${dom}` : ""}
HEALTH SCORE: ${score?.overall_score != null ? `${Number(score.overall_score).toFixed(0)}/100 (${score.risk_level})` : "n/a"}
CURRENT FLAGS the market is showing us:
${flagsList.length ? flagsList.map(f => `- ${f}`).join("\n") : "- (none — listing tracking healthy)"}
RECOMMENDED ACTIONS the data suggests:
${recActions.length ? recActions.map(a => `- ${a.action}: ${a.reasoning}`).join("\n") : "- (none — keep monitoring)"}

Write the email body only (no subject line). Maximum 180 words. Sign off with "— ${agentDisplayName}".`

  try {
    const result = await generateTextRouted({
      feature:     "listing_health_seller_email",
      brokerageId: listing.brokerage_id ?? undefined,
      system:      "You write empathetic, professional real-estate emails. Always pragmatic and warm. Never alarmist.",
      prompt:      aiPrompt,
      temperature: 0.5,
    })
    const body = result.text.trim()
    const subject = dom != null && dom > 30
      ? `Update on ${propertyLabel.split(",")[0]} — ${dom} days in and what I'm seeing`
      : `Quick update on ${propertyLabel.split(",")[0]}`
    return { success: true, subject, body }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "AI draft failed" }
  }
}
