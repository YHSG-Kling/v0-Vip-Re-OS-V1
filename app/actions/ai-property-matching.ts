"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

/**
 * AI Property Matching System
 * Intelligently matches buyers with properties based on preferences, behavior, and market data
 */

// Match score schema
const PropertyMatchSchema = z.object({
  propertyId: z.string(),
  matchScore: z.number().min(0).max(100),
  matchReasons: z.array(z.string()),
  priorityFactors: z.array(z.object({
    factor: z.string(),
    weight: z.number(),
    matched: z.boolean(),
  })),
  potentialConcerns: z.array(z.string()),
  recommendedActions: z.array(z.string()),
})

// Generate AI-powered property matches for a buyer
export async function generatePropertyMatches(params: {
  contactId: string
  agentId?: string // ignored — derived from session
  maxResults?: number
  includeOffMarket?: boolean
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  if (!isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const supabase = createServiceClient()

  try {
    // Verify the contact belongs to caller's brokerage before any AI work
    const { data: contactGuard } = await supabase
      .from("contacts")
      .select("brokerage_id")
      .eq("id", params.contactId)
      .maybeSingle()

    if (!contactGuard || contactGuard.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Criteria via the single normalized reader (consolidated — no per-consumer column drift).
    const { loadBuyerCriteria } = await import("@/lib/buyer-search/buyer-criteria")
    const [{ data: contact }, criteria] = await Promise.all([
      supabase
        .from("contacts")
        .select("*")
        .eq("id", params.contactId)
        .eq("brokerage_id", ctx.brokerageId)
        .single(),
      loadBuyerCriteria(supabase, params.contactId),
    ])

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    const prefs = {
      min_price:      criteria?.minPrice ?? null,
      max_price:      criteria?.maxPrice ?? null,
      min_beds:       criteria?.minBeds ?? null,
      min_baths:      criteria?.minBaths ?? null,
      cities:         criteria?.cities ?? [],
      property_types: criteria?.propertyTypes ?? [],
      features:       criteria?.mustHaveFeatures ?? [],
    }

    // Get buyer's viewing history and saved properties
    const { data: viewHistory } = await supabase
      .from("property_views")
      .select("property_id, view_count, last_viewed_at, time_spent_seconds")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", ctx.brokerageId)
      .order("last_viewed_at", { ascending: false })
      .limit(50)

    const { data: savedProperties } = await supabase
      .from("saved_properties")
      .select("listing_id, saved_at, notes")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", ctx.brokerageId)

    // Get available listings matching basic criteria
    let listingsQuery = supabase
      .from("listings")
      .select("*")
      .eq("status", "active")
      .eq("brokerage_id", ctx.brokerageId)

    // Live column is list_price (not price) — the old `price` filter errored the query,
    // silently returning zero matches for any buyer with a budget.
    if (prefs.min_price) {
      listingsQuery = listingsQuery.gte("list_price", prefs.min_price)
    }
    if (prefs.max_price) {
      listingsQuery = listingsQuery.lte("list_price", prefs.max_price)
    }
    if (prefs.min_beds) {
      listingsQuery = listingsQuery.gte("bedrooms", prefs.min_beds)
    }
    if (prefs.cities?.length > 0) {
      listingsQuery = listingsQuery.in("city", prefs.cities)
    }

    const { data: listings } = await listingsQuery.limit(100)

    if (!listings || listings.length === 0) {
      return { success: true, matches: [], message: "No properties match current criteria" }
    }

    // Use AI to score and rank matches
    const { object: matchAnalysis } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        matches: z.array(PropertyMatchSchema),
        overallInsights: z.string(),
        suggestedPreferenceAdjustments: z.array(z.string()),
      }),
      prompt: `You are an expert real estate AI matchmaker. Analyze the following buyer profile and available properties to generate intelligent matches.

BUYER PROFILE:
- Name: ${contact.first_name} ${contact.last_name}
- Budget: $${prefs.min_price || 0} - $${prefs.max_price || "No max"}
- Bedrooms: ${prefs.min_beds || "Any"}+
- Bathrooms: ${prefs.min_baths || "Any"}+
- Preferred Areas: ${prefs.cities?.join(", ") || "Any"}
- Property Types: ${prefs.property_types?.join(", ") || "Any"}
- Preferred Features: ${prefs.features?.join(", ") || "None specified"}
- Timeline: ${contact.timeline || "Not specified"}
- Notes: ${contact.notes || "None"}

VIEWING BEHAVIOR:
- Properties viewed: ${viewHistory?.length || 0}
- Most viewed property types: ${analyzeViewingPatterns(viewHistory)}
- Saved properties: ${savedProperties?.length || 0}

AVAILABLE PROPERTIES (${listings.length} total):
${listings.slice(0, 20).map(l => `
- ID: ${l.id}
- Address: ${l.address}, ${l.city}
- Price: $${l.price?.toLocaleString()}
- Beds: ${l.bedrooms}, Baths: ${l.bathrooms}
- Sqft: ${l.square_feet}
- Features: ${l.features?.join(", ") || "None listed"}
- Days on Market: ${l.days_on_market || 0}
`).join("")}

Score each property 0-100 based on how well it matches the buyer's explicit preferences AND implicit behavior patterns. Provide specific reasons for each match score.`,
    })

    // Save matches to database
    const matchInserts = matchAnalysis.matches.map(match => ({
      contact_id: params.contactId,
      property_id: match.propertyId,
      brokerage_id: ctx.brokerageId,
      match_score: match.matchScore,
      match_reasons: match.matchReasons,
      priority_factors: match.priorityFactors,
      potential_concerns: match.potentialConcerns,
      recommended_actions: match.recommendedActions,
      ai_generated: true,
      generated_at: new Date().toISOString(),
    }))

    await supabase.from("property_matches").upsert(matchInserts, {
      onConflict: "contact_id,property_id",
    })

    revalidatePath(`/portal/${params.contactId}/matches`)

    return {
      success: true,
      matches: matchAnalysis.matches.sort((a, b) => b.matchScore - a.matchScore),
      insights: matchAnalysis.overallInsights,
      suggestedAdjustments: matchAnalysis.suggestedPreferenceAdjustments,
    }
  } catch (error) {
    console.error("[AI Property Matching Error]:", error)
    return handleError(error, "generatePropertyMatches")
  }
}

// Analyze a single property for a specific buyer
export async function analyzePropertyForBuyer(params: {
  contactId: string
  propertyId: string
  agentId?: string // ignored — derived from session
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  if (!isValidUUID(params.contactId) || !isValidUUID(params.propertyId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  try {
    // Verify contact and listing both belong to caller's brokerage BEFORE AI work
    const [{ data: contactGuard }, { data: listingGuard }] = await Promise.all([
      supabase.from("contacts").select("brokerage_id").eq("id", params.contactId).maybeSingle(),
      supabase.from("listings").select("brokerage_id").eq("id", params.propertyId).maybeSingle(),
    ])

    if (!contactGuard || contactGuard.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (!listingGuard || listingGuard.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Criteria via the single normalized reader (fixes the legacy `preferred_features` /
    // `preferred_price_max`-only read that selected a non-existent column and errored).
    const { loadBuyerCriteria } = await import("@/lib/buyer-search/buyer-criteria")
    const [{ data: contact }, { data: property }, criteria] = await Promise.all([
      supabase.from("contacts").select("*").eq("id", params.contactId).eq("brokerage_id", ctx.brokerageId).single(),
      supabase.from("listings").select("*").eq("id", params.propertyId).eq("brokerage_id", ctx.brokerageId).single(),
      loadBuyerCriteria(supabase, params.contactId),
    ])

    if (!contact || !property) {
      return { success: false, error: "Contact or property not found" }
    }

    const maxBudget = criteria?.maxPrice ?? null
    const preferredFeatures = criteria?.mustHaveFeatures ?? []

    const { text: analysis } = await generateText({
      model: resolveModel("openai/gpt-4o"),
      prompt: `Analyze this property for the buyer and provide a comprehensive assessment:

BUYER: ${contact.first_name} ${contact.last_name}
- Budget: $${maxBudget || "Not set"}
- Preferred Features: ${preferredFeatures.join(", ") || "None"}

PROPERTY: ${property.address}
- Price: $${property.price?.toLocaleString()}
- Beds/Baths: ${property.bedrooms}/${property.bathrooms}
- Sqft: ${property.square_feet}
- Features: ${property.features?.join(", ")}

Provide:
1. Overall match assessment (score 0-100)
2. Key pros for this buyer
3. Key cons or concerns
4. Questions the buyer should ask
5. Negotiation insights based on days on market and price history
6. Comparable properties to consider`,
    })

    return { success: true, analysis }
  } catch (error) {
    return handleError(error, "analyzePropertyForBuyer")
  }
}

// Smart notification for new matches
export async function notifyNewMatches(params: {
  contactId: string
  agentId?: string // ignored — derived from session
  threshold?: number
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  if (!isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const threshold = params.threshold || 85

  const supabase = createServiceClient()

  try {
    // Verify contact belongs to caller's brokerage BEFORE AI work
    const { data: contactGuard } = await supabase
      .from("contacts")
      .select("brokerage_id")
      .eq("id", params.contactId)
      .maybeSingle()

    if (!contactGuard || contactGuard.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Get high-score matches from today
    const today = new Date().toISOString().split("T")[0]
    const { data: newMatches } = await supabase
      .from("property_matches")
      .select("*, listings(*)")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", ctx.brokerageId)
      .gte("match_score", threshold)
      .gte("generated_at", today)

    if (!newMatches || newMatches.length === 0) {
      return { success: true, notified: false, message: "No high-score matches today" }
    }

    // Generate personalized notification
    const { text: notification } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `Generate a brief, exciting notification message for a buyer about ${newMatches.length} new property matches with scores of ${threshold}%+. Keep it under 160 characters for SMS. Be warm and professional.`,
    })

    // Log the notification
    await supabase.from("notifications").insert({
      contact_id: params.contactId,
      user_id: ctx.userId, // notifications targets users.id (no agent_id column)
      brokerage_id: ctx.brokerageId,
      type: "property_match",
      title: "New Property Matches",
      body: notification,
      entity_type: "contact",
      entity_id: params.contactId,
    })

    // Wave 59 — buyer property-match reel AUTO-handoff (deliverable-gated): produce a
    // personalized "homes matching your search" video into the render queue. Best-effort
    // + idempotent (one reel per buyer per week); the finished reel is captured to the
    // marketing library for the agent to send.
    try {
      const { produceBuyerMatchReel } = await import("@/lib/agents/buyer-match-reel-producer")
      void produceBuyerMatchReel(ctx.brokerageId, params.contactId, supabase)
    } catch { /* auto-producer is best-effort */ }

    return { success: true, notified: true, matchCount: newMatches.length, notification }
  } catch (error) {
    return handleError(error, "notifyNewMatches")
  }
}

// Helper function to analyze viewing patterns
function analyzeViewingPatterns(viewHistory: any[] | null): string {
  if (!viewHistory || viewHistory.length === 0) return "No viewing history"

  const avgTimeSpent = viewHistory.reduce((sum, v) => sum + (v.time_spent_seconds || 0), 0) / viewHistory.length
  return `${viewHistory.length} properties viewed, avg ${Math.round(avgTimeSpent / 60)} min per property`
}

// Learn from buyer feedback to improve matching
export async function learnFromBuyerFeedback(params: {
  contactId: string
  propertyId: string
  feedback: "loved" | "liked" | "neutral" | "disliked" | "hated"
  reasons?: string[]
  agentId?: string // ignored — derived from session
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  if (!isValidUUID(params.contactId) || !isValidUUID(params.propertyId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  try {
    // Verify contact and listing both belong to caller's brokerage BEFORE AI work
    const [{ data: contactGuard }, { data: listingGuard }] = await Promise.all([
      supabase.from("contacts").select("brokerage_id").eq("id", params.contactId).maybeSingle(),
      supabase.from("listings").select("brokerage_id").eq("id", params.propertyId).maybeSingle(),
    ])

    if (!contactGuard || contactGuard.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (!listingGuard || listingGuard.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Save feedback
    // property_feedback real columns: feedback_type (not feedback), disliked_features (not reasons)
    await supabase.from("property_feedback").insert({
      contact_id: params.contactId,
      property_id: params.propertyId,
      brokerage_id: ctx.brokerageId,
      feedback_type: params.feedback,
      disliked_features: params.reasons,
      created_at: new Date().toISOString(),
    })

    // Update preferences based on feedback patterns
    const { data: allFeedback } = await supabase
      .from("property_feedback")
      .select("*, listings(*)")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", ctx.brokerageId)

    if (allFeedback && allFeedback.length >= 5) {
      const { object: preferenceUpdates } = await generateObject({
        model: resolveModel("openai/gpt-4o-mini"),
        schema: z.object({
          suggestedUpdates: z.array(z.object({
            field: z.string(),
            currentValue: z.string().optional(),
            suggestedValue: z.string(),
            confidence: z.number(),
            reason: z.string(),
          })),
        }),
        prompt: `Based on this buyer's property feedback history, suggest preference updates:

${allFeedback.map(f => `- ${f.feedback_type}: ${f.listings?.address} (${f.disliked_features?.join(", ") || "no reasons"})`).join("\n")}

Analyze patterns in what they love vs hate and suggest specific preference field updates.`,
      })

      return {
        success: true,
        feedbackSaved: true,
        preferenceInsights: preferenceUpdates.suggestedUpdates,
      }
    }

    return { success: true, feedbackSaved: true }
  } catch (error) {
    return handleError(error, "learnFromBuyerFeedback")
  }
}
