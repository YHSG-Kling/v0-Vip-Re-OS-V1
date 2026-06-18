"use server"

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"
import { generateTextRouted as generateText } from "@/lib/ai/models"

/**
 * LAYER 2 — AI Scoring (nuance refinement of conversational/behavioral signals).
 *
 * Refines the AI-nuanced score columns (`engagement_score`, `intent_score`,
 * `qualification_score`, `motivation_score`, `readiness_level`). When called
 * via explicit agent UI action ("Run AI Score" button on the CRM), this also
 * overrides `lead_score` — that's the documented agent-driven override.
 *
 * Background / cron callers should NOT overwrite `lead_score` (Layer 1 owns
 * the deterministic baseline). A future commit will add a `mode: 'override'
 * | 'refine'` parameter so background callers can opt into refine-only.
 *
 * See `lib/lead-scoring/LAYERING.md` for full layering rules and the four
 * scoring systems that touch these columns.
 */
export async function scoreLeadWithAI(params: {
  contactId: string
  agentId: string
  /**
   * Write mode (default 'refine'):
   *   - 'refine'   — write only AI-nuanced columns (engagement_score,
   *                  intent_score, qualification_score, motivation_score,
   *                  readiness_level). DOES NOT touch lead_score baseline.
   *                  Use for background/cron callers.
   *   - 'override' — same as refine PLUS overwrite lead_score with the AI
   *                  overall score. Use ONLY when an agent explicitly
   *                  triggers this from the UI ("Run AI Score" button on
   *                  the CRM contact card). Never from background work.
   */
  mode?: "refine" | "override"
}) {
  try {
    const supabase = await createClient()

    // Get contact data (simple select — embedded relation tables may not exist)
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .maybeSingle()

    if (contactError) throw contactError
    if (!contact) throw new Error("Contact not found")

    // Get interaction history
    const { data: interactions } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", params.contactId)
      .order("created_at", { ascending: false })
      .limit(20)

    // AI scoring analysis
    const { text: analysis } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are an AI real estate lead scoring expert. Analyze this lead comprehensively.

Contact Details:
- Name: ${contact.first_name} ${contact.last_name}
- Email: ${contact.email}
- Phone: ${contact.phone || "Not provided"}
- Current Stage: ${contact.lifecycle_state || "New"}
- Source: ${contact.source || "Unknown"}
- Budget: ${contact.budget_min ? `$${contact.budget_min} - $${contact.budget_max}` : "Not specified"}
- Preferred Areas: ${contact.preferred_areas?.join(", ") || "Not specified"}
- Timeline: ${contact.buying_timeline || "Unknown"}

Behavioral Data:
- Recent Interactions: ${interactions?.length || 0}
- Last Contact: ${contact.last_contacted_at || "Never"}

Provide a JSON response with:
{
  "overallScore": 0-100,
  "engagement": 0-100,
  "intent": 0-100,
  "qualification": 0-100,
  "motivation": 0-100,
  "readiness": "cold" | "warm" | "hot",
  "nextBestAction": "specific recommendation",
  "reasoning": "brief explanation",
  "priorities": ["priority1", "priority2", "priority3"]
}`,
    })

    // Extract JSON robustly — the AI may wrap output in markdown code blocks
    const jsonMatch = analysis.match(/```(?:json)?\s*([\s\S]*?)```/) ?? analysis.match(/(\{[\s\S]*\})/)
    const jsonText = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : analysis
    const scores = JSON.parse(jsonText.trim())

    // Update contact with scores. Write boundaries per layering rules:
    //   - 'override' mode (explicit agent action): writes lead_score baseline
    //   - 'refine' mode (background, default): only AI-nuanced columns
    const mode = params.mode ?? "refine"
    const updates: Record<string, unknown> = {
      engagement_score: scores.engagement,
      intent_score: scores.intent,
      qualification_score: scores.qualification,
      motivation_score: scores.motivation,
      readiness_level: scores.readiness,
    }
    if (mode === "override") {
      updates.lead_score = scores.overallScore
    }
    await supabase
      .from("contacts")
      .update(updates)
      .eq("id", params.contactId)

    // Log scoring event
    await supabase.from("lead_score_history").insert({
      contact_id: params.contactId,
      overall_score: scores.overallScore,
      engagement_score: scores.engagement,
      intent_score: scores.intent,
      qualification_score: scores.qualification,
      motivation_score: scores.motivation,
      factors: scores.reasoning,
      ai_recommendations: scores.priorities,
    })

    return {
      success: true,
      scores,
    }
  } catch (error) {
    return handleError(error, "scoreLeadWithAI")
  }
}

/**
 * Get lead insights and score breakdown
 */
export async function getLeadInsights(contactId: string) {
  try {
    const supabase = await createClient()

    const { data: rawContact, error: contactError } = await supabase
      .from("contacts")
      .select(`
        *,
        lead_score_history(* order by scored_at desc limit 5)
      `)
      .eq("id", contactId)
      .single()
    const contact = rawContact as any

    if (contactError) throw contactError

    return {
      success: true,
      currentScore: {
        overall: contact?.lead_score || 0,
        engagement: contact?.engagement_score || 0,
        intent: contact?.intent_score || 0,
        qualification: contact?.qualification_score || 0,
        motivation: contact?.motivation_score || 0,
        readiness: contact?.readiness_level || "cold",
      },
      history: contact?.lead_score_history || [],
      contact,
    }
  } catch (error) {
    return handleError(error, "getLeadInsights")
  }
}

/**
 * Bulk score multiple leads
 */
export async function bulkScoreLeads(params: {
  agentId: string
  contactIds?: string[]
  leadStage?: string
}) {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .eq("agent_id", params.agentId)

    if (params.contactIds) {
      query = query.in("id", params.contactIds)
    } else if (params.leadStage) {
      query = query.eq("lifecycle_state", params.leadStage)
    } else {
      // Score all active leads by default
      query = query.in("lifecycle_state", ["new", "nurturing", "qualified"])
    }

    const { data: contacts, error } = await query.limit(50)

    if (error) throw error

    const results = []
    for (const contact of contacts || []) {
      const result = await scoreLeadWithAI({
        contactId: contact.id,
        agentId: params.agentId,
      })
      results.push({
        contactId: contact.id,
        name: `${contact.first_name} ${contact.last_name}`,
        ...result,
      })
    }

    return {
      success: true,
      totalScored: results.length,
      results,
    }
  } catch (error) {
    return handleError(error, "bulkScoreLeads")
  }
}
