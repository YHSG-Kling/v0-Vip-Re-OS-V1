

import { createClient } from "@/lib/supabase/server"
import { isValidUUID, validateEmail, validatePhone } from "@/lib/validations"
import { LEAD_TEMPERATURES, LEAD_SOURCES } from "@/lib/constants"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"

// ============================================
// UNIFIED LEAD MANAGEMENT SERVICE
// Consolidates all lead operations across the app
// Replaces duplicates in: leads.ts, crm.ts, lead-intelligence.ts, ai-insights.ts
// ============================================

export interface LeadScoringParams {
  id: string // Can be contactId or leadId
  agentId: string
  recalculate?: boolean
  table?: "contacts" | "leads" // Which table to score
}

export interface LeadScoringResult {
  score: number
  temperature: string
  factors: {
    engagement: number
    recency: number
    intent: number
    fit: number
    responsiveness: number
  }
  recommendations: string[]
}

/**
 * CANONICAL LEAD SCORE ORCHESTRATOR — sole writer of `lead_score` column.
 *
 * Pipeline:
 *   1. Fetch record + relations from contacts/leads
 *   2. Run Layer 1 (multi-factor deterministic scorer) for the canonical
 *      baseline — `lib/lead-governance/multi-factor-scorer.ts`
 *   3. Layer in behavioral signals (engagement, recency, intent, fit,
 *      responsiveness) as a refinement on top of the baseline
 *   4. Persist the combined score to `lead_score` + temperature + history
 *
 * EVERY write to `contacts.lead_score` and `leads.lead_score` MUST go through
 * this function. Layer 2 (AI scoring) refines AI-nuanced columns only and
 * does not bypass this. Layer 3 (signal extensions) only pushes UP via
 * `applySignalDelta`. See `lib/lead-scoring/LAYERING.md`.
 *
 * Combination formula (deterministic):
 *   final_score = clamp(0, 100, multi_factor_baseline × 0.7 + behavioral × 0.3)
 *
 * The 70/30 split keeps the multi-factor baseline as the dominant signal —
 * static lead data is more reliable than behavioral inference. Behavioral
 * refinement bumps the score for high-engagement contacts and dampens for
 * stale ones, but cannot single-handedly invert the baseline.
 */
export async function calculateLeadScore(params: LeadScoringParams): Promise<LeadScoringResult> {
  try {
    if (!isValidUUID(params.id)) {
      throw new ValidationError("Invalid ID")
    }

    const table = params.table || "contacts"
    const supabase = await createClient()

    let record: any
    let error: any

    if (table === "contacts") {
      const result = await supabase
        .from("contacts")
        .select(`
          *,
          lead_intelligence(*),
          lead_behavioral_data(*),
          property_interactions(*),
          buyer_persona(*)
        `)
        .eq("id", params.id)
        .single()
      record = result.data
      error = result.error
    } else {
      const result = await supabase
        .from("leads")
        .select(`
          *,
          lead_intelligence(*),
          lead_behavioral_data(*),
          lead_idx_property_interactions(*),
          lead_motivated_seller_signals(*)
        `)
        .eq("id", params.id)
        .single()
      record = result.data
      error = result.error
    }

    if (error || !record) {
      throw new NotFoundError(`${table === "contacts" ? "Contact" : "Lead"} not found`)
    }

    // ── Layer 1: Multi-factor deterministic baseline ────────────────────
    // Single source of truth for the static-data score. Returns 0-100.
    const { calculateLeadScore: multiFactorScorer } = await import(
      "@/lib/lead-governance/multi-factor-scorer"
    )
    const multiFactorResult = multiFactorScorer(record)
    const baselineScore = multiFactorResult.finalScore

    // ── Behavioral refinement (additive layer on the baseline) ─────────
    // These factors capture in-app behavior that multi-factor doesn't see.
    const engagementScore = calculateEngagementScore(record, table)
    const recencyScore = calculateRecencyScore(record)
    const intentScore = calculateIntentScore(record, table)
    const fitScore = calculateFitScore(record, table)
    const responsivenessScore = calculateResponsivenessScore(record)
    const behavioralScore = Math.round(
      engagementScore * 0.25 + recencyScore * 0.2 + intentScore * 0.3 + fitScore * 0.15 + responsivenessScore * 0.1
    )

    // ── Combined final score (70% baseline + 30% behavioral refinement) ─
    const totalScore = Math.max(0, Math.min(100, Math.round(baselineScore * 0.7 + behavioralScore * 0.3)))

    const temperature = determineTemperature(totalScore)
    const recommendations = generateLeadRecommendations(record, {
      engagement: engagementScore,
      recency: recencyScore,
      intent: intentScore,
      fit: fitScore,
      responsiveness: responsivenessScore,
    })

    // Update appropriate database table
    if (table === "contacts") {
      await supabase
        .from("contacts")
        .update({
          lead_score: totalScore,
          lead_temperature: temperature,
          last_score_calculation: new Date().toISOString(),
        })
        .eq("id", params.id)

      // Store scoring history
      await supabase.from("lead_behavioral_data").upsert({
        contact_id: params.id,
        engagement_score: engagementScore,
        intent_signals: intentScore,
        last_engagement_date: new Date().toISOString(),
      })
    } else {
      // Update leads table
      await supabase
        .from("leads")
        .update({
          lead_score: totalScore,
          temperature,
          last_scored_at: new Date().toISOString(),
        })
        .eq("id", params.id)

      // Store scoring history in lead_engagement_scores
      await supabase.from("lead_engagement_scores").insert({
        lead_id: params.id,
        score_type: "composite",
        score_value: totalScore,
        factors: {
          engagement: engagementScore,
          recency: recencyScore,
          intent: intentScore,
          fit: fitScore,
          responsiveness: responsivenessScore,
        },
      })
    }

    return {
      score: totalScore,
      temperature,
      factors: {
        engagement: engagementScore,
        recency: recencyScore,
        intent: intentScore,
        fit: fitScore,
        responsiveness: responsivenessScore,
      },
      recommendations,
    }
  } catch (error) {
    handleError(error, "calculateLeadScore")
    return {
      score: 0,
      temperature: "cold",
      factors: { engagement: 0, recency: 0, intent: 0, fit: 0, responsiveness: 0 },
      recommendations: [],
    }
  }
}

/**
 * Calculate engagement score (0-100)
 * Works for both contacts and leads tables
 */
function calculateEngagementScore(record: any, table: string): number {
  let score = 0

  if (table === "contacts") {
    const interactions = record.property_interactions || []
    const behavioralData = record.lead_behavioral_data?.[0]

    // Property views
    const views = interactions.filter((i: any) => i.interaction_type === "view").length
    score += Math.min(views * 5, 30)

    // Saved properties
    const saves = interactions.filter((i: any) => i.interaction_type === "save").length
    score += Math.min(saves * 10, 25)

    // Email opens
    const emailOpens = behavioralData?.email_open_count || 0
    score += Math.min(emailOpens * 2, 20)

    // Website visits
    const siteVisits = behavioralData?.site_visit_count || 0
    score += Math.min(siteVisits * 3, 25)
  } else {
    // For leads table - use external behavior signals
    const interactions = record.lead_idx_property_interactions || []
    const behavioralData = record.lead_behavioral_data?.[0]
    const sellerSignals = record.lead_motivated_seller_signals || []

    // IDX property interactions
    const views = interactions.filter((i: any) => i.interaction_type === "view").length
    score += Math.min(views * 5, 30)

    // Motivated seller signals
    const strongSignals = sellerSignals.filter((s: any) => s.signal_strength > 0.7).length
    score += Math.min(strongSignals * 15, 30)

    // External behavioral events
    const eventCount = behavioralData?.event_type ? 1 : 0
    score += Math.min(eventCount * 10, 20)

    // Scraping recency (more recent = more engagement)
    if (record.scraped_at) {
      const daysSinceScrape = Math.floor(
        (Date.now() - new Date(record.scraped_at).getTime()) / (1000 * 60 * 60 * 24)
      )
      if (daysSinceScrape <= 7) score += 20
      else if (daysSinceScrape <= 30) score += 10
    }
  }

  return Math.min(score, 100)
}

/**
 * Calculate recency score (0-100)
 */
function calculateRecencyScore(contact: any): number {
  const lastContact = contact.last_contact_date || contact.created_at
  const daysSince = Math.floor((Date.now() - new Date(lastContact).getTime()) / (1000 * 60 * 60 * 24))

  if (daysSince <= 1) return 100
  if (daysSince <= 3) return 90
  if (daysSince <= 7) return 75
  if (daysSince <= 14) return 60
  if (daysSince <= 30) return 40
  if (daysSince <= 60) return 20
  return 10
}

/**
 * Calculate intent score (0-100)
 * Works for both contacts and leads tables
 */
function calculateIntentScore(record: any, table: string): number {
  let score = 0

  const intelligence = record.lead_intelligence?.[0]

  // Urgency signals
  if (intelligence?.timeline === "immediate") score += 40
  else if (intelligence?.timeline === "1-3_months") score += 30
  else if (intelligence?.timeline === "3-6_months") score += 20
  else if (intelligence?.timeline === "6-12_months") score += 10

  // Pre-approval status
  if (intelligence?.preapproval_status === "approved") score += 30
  else if (intelligence?.preapproval_status === "in_process") score += 20

  if (table === "contacts") {
    // Budget alignment
    const hasBudget = record.budget_min && record.budget_max
    if (hasBudget) score += 20

    // Viewing requests
    const viewingRequests = record.property_interactions?.filter((i: any) => i.interaction_type === "tour_request")
      .length
    score += Math.min(viewingRequests * 10, 10)
  } else {
    // For leads - use intent type and motivation score
    if (record.intent_type === "buyer") score += 20
    if (record.intent_type === "seller") score += 25
    if (record.motivation_score) score += Math.min(record.motivation_score * 0.2, 20)

    // Property interest signals
    if (record.property_interest && Object.keys(record.property_interest).length > 0) {
      score += 15
    }
  }

  return Math.min(score, 100)
}

/**
 * Calculate fit score (0-100)
 * Works for both contacts and leads tables
 */
function calculateFitScore(record: any, table: string): number {
  let score = 50 // Base score

  if (table === "contacts") {
    const persona = record.buyer_persona?.[0]

    // Has complete profile
    if (record.email && record.phone) score += 10
    if (record.budget_min && record.budget_max) score += 10

    // Persona match
    if (persona) {
      score += 15
      if (persona.confidence_score > 0.8) score += 15
    }

    // Location preferences
    if (record.preferred_cities?.length > 0) score += 10
  } else {
    // For leads - check data completeness
    if (record.email) score += 10
    if (record.phone) score += 10
    if (record.address && record.city && record.state) score += 15

    // Contact persona match
    if (record.contact_persona) score += 15

    // Property ownership signals (seller leads)
    const propertyOwnership = record.lead_property_ownership || []
    if (propertyOwnership.length > 0) {
      score += 10
      // High equity is good fit
      const hasHighEquity = propertyOwnership.some((p: any) => (p.equity_estimate || 0) > 100000)
      if (hasHighEquity) score += 10
    }
  }

  return Math.min(score, 100)
}

/**
 * Calculate responsiveness score (0-100)
 */
function calculateResponsivenessScore(contact: any): number {
  let score = 50 // Default neutral

  const behavioral = contact.lead_behavioral_data?.[0]

  // Email response rate
  const responseRate = behavioral?.response_rate || 0
  score += responseRate * 30

  // Average response time
  const avgResponseHours = behavioral?.avg_response_time_hours || 48
  if (avgResponseHours < 1) score += 20
  else if (avgResponseHours < 4) score += 15
  else if (avgResponseHours < 12) score += 10
  else if (avgResponseHours < 24) score += 5

  return Math.min(score, 100)
}

/**
 * Determine temperature based on score
 */
function determineTemperature(score: number): string {
  if (score >= 80) return "hot"
  if (score >= 60) return "warm"
  if (score >= 40) return "cool"
  return "cold"
}

/**
 * Generate actionable recommendations
 */
function generateLeadRecommendations(contact: any, factors: any): string[] {
  const recommendations: string[] = []

  // Engagement recommendations
  if (factors.engagement < 40) {
    recommendations.push("Send personalized property recommendations to increase engagement")
  }

  // Recency recommendations
  if (factors.recency < 50) {
    recommendations.push("Schedule a follow-up call or send a check-in email")
  }

  // Intent recommendations
  if (factors.intent > 70) {
    recommendations.push("High intent detected - schedule viewing or offer consultation")
  } else if (factors.intent < 30) {
    recommendations.push("Nurture with market updates and educational content")
  }

  // Fit recommendations
  if (factors.fit < 50) {
    recommendations.push("Complete contact profile to improve matching")
  }

  // Responsiveness recommendations
  if (factors.responsiveness < 40) {
    recommendations.push("Try alternative communication channels (text vs email)")
  }

  return recommendations
}

/**
 * Batch recalculate scores for contacts table
 */
export async function bulkRecalculateLeadScores(agentId: string): Promise<{ updated: number; failed: number }> {
  try {
    if (!isValidUUID(agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    const supabase = await createClient()

    const { data: contacts } = await supabase.from("contacts").select("id").eq("agent_id", agentId).eq("status", "active")

    let updated = 0
    let failed = 0

    for (const contact of contacts || []) {
      const result = await calculateLeadScore({
        id: contact.id,
        agentId,
        recalculate: true,
        table: "contacts",
      })

      if (result.score) {
        updated++
      } else {
        failed++
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    return { updated, failed }
  } catch (error) {
    console.error("[v0] Bulk recalculate error:", error)
    return { updated: 0, failed: 0 }
  }
}

/**
 * Batch recalculate scores for leads table (external scraped leads)
 */
export async function bulkRecalculateScrapedLeadScores(filters?: {
  lead_source?: string
  temperature?: string
  limit?: number
}): Promise<{ updated: number; failed: number }> {
  try {
    const supabase = await createClient()

    let query = supabase.from("leads").select("id, agent_id")

    if (filters?.lead_source) {
      query = query.eq("lead_source", filters.lead_source)
    }
    if (filters?.temperature) {
      query = query.eq("temperature", filters.temperature)
    }
    if (filters?.limit) {
      query = query.limit(filters.limit)
    }

    const { data: leads } = await query

    let updated = 0
    let failed = 0

    for (const lead of leads || []) {
      const result = await calculateLeadScore({
        id: lead.id,
        agentId: lead.agent_id || "system",
        recalculate: true,
        table: "leads",
      })

      if (result.score) {
        updated++
      } else {
        failed++
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    return { updated, failed }
  } catch (error) {
    console.error("[v0] Bulk recalculate scraped leads error:", error)
    return { updated: 0, failed: 0 }
  }
}

/**
 * Score both contacts AND leads tables for complete coverage
 */
export async function bulkRecalculateAllScores(agentId: string): Promise<{
  contacts: { updated: number; failed: number }
  leads: { updated: number; failed: number }
}> {
  console.log("[v0] Recalculating scores for both contacts and leads tables")

  const contactsResult = await bulkRecalculateLeadScores(agentId)
  const leadsResult = await bulkRecalculateScrapedLeadScores({ limit: 100 })

  return {
    contacts: contactsResult,
    leads: leadsResult,
  }
}

/**
 * Get top leads for an agent
 */
export async function getTopLeads(agentId: string, limit = 20) {
  try {
    if (!isValidUUID(agentId)) {
      return []
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("contacts")
      .select(`
        *,
        lead_intelligence(*),
        buyer_persona(*)
      `)
      .eq("agent_id", agentId)
      .eq("status", "active")
      .order("lead_score", { ascending: false })
      .limit(limit)

    if (error) throw error

    return data || []
  } catch (error) {
    console.error("[v0] Get top leads error:", error)
    return []
  }
}

/**
 * Get leads needing attention (low recency, high intent)
 */
export async function getLeadsNeedingAttention(agentId: string) {
  try {
    if (!isValidUUID(agentId)) {
      return []
    }

    const supabase = await createClient()

    // Get leads that haven't been contacted in 7+ days but have high scores
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", agentId)
      .eq("status", "active")
      .gte("lead_score", 60)
      .lt("last_contact_date", sevenDaysAgo)
      .order("lead_score", { ascending: false })
      .limit(10)

    if (error) throw error

    return data || []
  } catch (error) {
    console.error("[v0] Get leads needing attention error:", error)
    return []
  }
}
