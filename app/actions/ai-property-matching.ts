"use server"

import { createClient } from "@/lib/supabase/server"
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
  agentId: string
  maxResults?: number
  includeOffMarket?: boolean
}) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid contact or agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get buyer preferences
    const { data: contact } = await supabase
      .from("contacts")
      .select("*, buyer_preferences:contact_preferences(*)")
      .eq("id", params.contactId)
      .single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Get buyer's viewing history and saved properties
    const { data: viewHistory } = await supabase
      .from("property_views")
      .select("property_id, view_count, last_viewed_at, time_spent_seconds")
      .eq("contact_id", params.contactId)
      .order("last_viewed_at", { ascending: false })
      .limit(50)

    const { data: savedProperties } = await supabase
      .from("saved_properties")
      .select("property_id, saved_at, notes")
      .eq("contact_id", params.contactId)

    // Get available listings matching basic criteria
    const preferences = contact.buyer_preferences?.[0] || {}
    let listingsQuery = supabase
      .from("listings")
      .select("*")
      .eq("status", "active")

    if (preferences.min_price) {
      listingsQuery = listingsQuery.gte("price", preferences.min_price)
    }
    if (preferences.max_price) {
      listingsQuery = listingsQuery.lte("price", preferences.max_price)
    }
    if (preferences.min_beds) {
      listingsQuery = listingsQuery.gte("bedrooms", preferences.min_beds)
    }
    if (preferences.cities?.length > 0) {
      listingsQuery = listingsQuery.in("city", preferences.cities)
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
- Budget: $${preferences.min_price || 0} - $${preferences.max_price || "No max"}
- Bedrooms: ${preferences.min_beds || "Any"}+
- Bathrooms: ${preferences.min_baths || "Any"}+
- Preferred Areas: ${preferences.cities?.join(", ") || "Any"}
- Property Types: ${preferences.property_types?.join(", ") || "Any"}
- Must-Have Features: ${preferences.must_haves?.join(", ") || "None specified"}
- Nice-to-Have Features: ${preferences.nice_to_haves?.join(", ") || "None specified"}
- Deal Breakers: ${preferences.deal_breakers?.join(", ") || "None specified"}
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
  agentId: string
}) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.propertyId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const [{ data: contact }, { data: property }] = await Promise.all([
      supabase.from("contacts").select("*, buyer_preferences:contact_preferences(*)").eq("id", params.contactId).single(),
      supabase.from("listings").select("*").eq("id", params.propertyId).single(),
    ])

    if (!contact || !property) {
      return { success: false, error: "Contact or property not found" }
    }

    const { text: analysis } = await generateText({
      model: resolveModel("openai/gpt-4o"),
      prompt: `Analyze this property for the buyer and provide a comprehensive assessment:

BUYER: ${contact.first_name} ${contact.last_name}
- Budget: $${contact.buyer_preferences?.[0]?.max_price || "Not set"}
- Must-haves: ${contact.buyer_preferences?.[0]?.must_haves?.join(", ") || "None"}
- Deal breakers: ${contact.buyer_preferences?.[0]?.deal_breakers?.join(", ") || "None"}

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
  agentId: string
  threshold?: number
}) {
  const threshold = params.threshold || 85

  const supabase = await createClient()

  try {
    // Get high-score matches from today
    const today = new Date().toISOString().split("T")[0]
    const { data: newMatches } = await supabase
      .from("property_matches")
      .select("*, listings(*)")
      .eq("contact_id", params.contactId)
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
      agent_id: params.agentId,
      type: "property_match",
      title: "New Property Matches",
      message: notification,
      metadata: { match_count: newMatches.length, threshold },
    })

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
  agentId: string
}) {
  const supabase = await createClient()

  try {
    // Save feedback
    await supabase.from("property_feedback").insert({
      contact_id: params.contactId,
      property_id: params.propertyId,
      feedback: params.feedback,
      reasons: params.reasons,
      created_at: new Date().toISOString(),
    })

    // Update preferences based on feedback patterns
    const { data: allFeedback } = await supabase
      .from("property_feedback")
      .select("*, listings(*)")
      .eq("contact_id", params.contactId)

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
        
${allFeedback.map(f => `- ${f.feedback}: ${f.listings?.address} (${f.reasons?.join(", ") || "no reasons"})`).join("\n")}

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
