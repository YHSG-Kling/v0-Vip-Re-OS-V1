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

export interface ListingHealthBoard {
  rows: ListingHealthRow[]
  summary: { healthy: number; watch: number; at_risk: number; critical: number }
}

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
  if (listingIds.length === 0) {
    return { rows: [], summary: { healthy: 0, watch: 0, at_risk: 0, critical: 0 } }
  }

  // 2. Latest score per listing — cron writes a row every 12h; we use the most
  //    recent scored_at per listing_id.
  const { data: scores } = await svc
    .from("listing_health_scores")
    .select("id, listing_id, overall_score, previous_score, score_delta, risk_level, days_on_market, flags, ai_narrative, recommended_actions, scored_at")
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

  return { rows, summary }
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
  const { error } = await svc
    .from("listing_health_interventions")
    .update({
      resolved:        true,
      resolved_at:     new Date().toISOString(),
      resolved_by:     user.id,
      resolution_note: note,
    })
    .eq("id", interventionId)
    .eq("resolved", false)
  if (error) return { success: false, error: error.message }
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
