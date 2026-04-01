"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "ai"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================================================
// AI TRAINING & COACHING SYSTEM
// Agent performance analysis, personalized learning paths, and coaching
// ============================================================================

/**
 * Analyze agent performance and generate coaching insights
 */
export async function analyzeAgentPerformance(params: {
  agentId: string
  brokerId?: string
  timeframe?: "30_days" | "90_days" | "6_months" | "1_year"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent's transactions
    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("agent_id", params.agentId)
      .order("created_at", { ascending: false })
      .limit(100)

    // Get agent's contacts and lead conversion
    const { data: contacts } = await supabase
      .from("contacts")
      .select("*, interactions(*)")
      .eq("agent_id", params.agentId)
      .limit(200)

    // Get agent's activities
    const { data: activities } = await supabase
      .from("activities")
      .select("*")
      .eq("agent_id", params.agentId)
      .order("created_at", { ascending: false })
      .limit(200)

    const { text: analysis } = await generateText(
      `Analyze this agent's performance and provide coaching insights:

Transactions: ${transactions?.length || 0}
Contacts: ${contacts?.length || 0}
Recent Activities: ${activities?.length || 0}

Provide insights on:
1. Performance strengths
2. Areas for improvement
3. Recommended training areas
4. Commission optimization opportunities`
    )

    return {
      success: true,
      analysis,
      metrics: {
        transactionCount: transactions?.length || 0,
        contactCount: contacts?.length || 0,
        activityCount: activities?.length || 0
      }
    }
  } catch (error) {
    console.error("[v0] Analyze agent performance error:", error)
    return handleError(error, "analyzeAgentPerformance")
  }
}

/**
 * Generate realistic coaching scenarios for agent training
 */
export async function generateCoachingScenario(params: {
  agentId: string
  brokerageId: string
  scenarioType: "listing_presentation" | "buyer_consultation" | "negotiation" | "objection_handling" | "cold_calling" | "fsbo_conversion"
  difficulty?: "easy" | "medium" | "hard"
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid agent or brokerage ID" }
  }

  const supabase = await createClient()

  try {
    // Get brokerage's brand voice profile for consistency
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("brokerage_id", params.brokerageId)
      .eq("agent_id", null) // Get brokerage-level profile
      .maybeSingle()

    const { object: scenario } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        title: z.string(),
        setup: z.string(),
        clientProfile: z.object({
          name: z.string(),
          background: z.string(),
          personality: z.string(),
          concerns: z.array(z.string()),
          motivations: z.array(z.string()),
          objections: z.array(z.string())
        }),
        objectives: z.array(z.string()),
        keyPoints: z.array(z.object({
          point: z.string(),
          importance: z.enum(["critical", "important", "nice_to_have"]),
          suggestedApproach: z.string()
        })),
        dialogueStarters: z.array(z.object({
          clientSays: z.string(),
          suggestedResponses: z.array(z.string()),
          commonMistakes: z.array(z.string())
        })),
        evaluationCriteria: z.array(z.object({
          criterion: z.string(),
          weight: z.number(),
          excellentExample: z.string(),
          poorExample: z.string()
        })),
        debrief: z.object({
          keyTakeaways: z.array(z.string()),
          commonPitfalls: z.array(z.string()),
          advancedTips: z.array(z.string())
        })
      }),
      prompt: `Create a realistic coaching scenario for a real estate agent:

Scenario Type: ${params.scenarioType}
Difficulty Level: ${params.difficulty || "medium"}
${brandVoice ? `Brokerage Brand Voice: ${brandVoice.communication_style || "professional"}` : ""}

Generate a detailed role-play scenario including:
1. Realistic setup and context
2. Client profile with personality, concerns, and motivations
3. Clear objectives for the agent
4. Key points to cover (critical, important, nice-to-have)
5. Dialogue starters with multiple suggested responses and common mistakes
6. Evaluation criteria with weights and examples
7. Debrief materials with takeaways, pitfalls, and advanced tips`
    })

    // Log scenario generation for audit trail
    await supabase
      .from("audit_log")
      .insert({
        action: "coaching_scenario_generated",
        entity_type: "training_scenario",
        entity_id: params.agentId,
        brokerage_id: params.brokerageId,
        user_id: params.agentId,
        after: {
          scenario_type: params.scenarioType,
          difficulty: params.difficulty || "medium"
        }
      })
      .catch((err) => {
        console.error("[v0] Failed to log scenario generation:", err)
      })

    return {
      success: true,
      scenario
    }
  } catch (error) {
    console.error("[v0] Generate coaching scenario error:", error)
    return handleError(error, "generateCoachingScenario")
  }
}

/**
 * Generate personalized learning path for agent
 */
export async function generateLearningPath(params: {
  agentId: string
  brokerageId?: string
  focusAreas?: string[]
  experienceLevel?: "beginner" | "intermediate" | "advanced"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent's profile for personalization
    const { data: agent } = await supabase
      .from("users")
      .select("*, profile:user_profile(*)")
      .eq("id", params.agentId)
      .maybeSingle()

    const { text: learningPath } = await generateText(
      `Create a personalized learning path for a real estate agent:

Experience Level: ${params.experienceLevel || "intermediate"}
Focus Areas: ${params.focusAreas?.join(", ") || "general real estate skills"}
${agent?.profile ? `Agent Profile: ${JSON.stringify(agent.profile)}` : ""}

Generate a structured learning path including:
1. Week-by-week schedule
2. Specific topics to cover
3. Practical exercises and roleplay scenarios
4. Milestones and checkpoints
5. Key performance indicators to track
6. Recommended resources and certifications`
    )

    return {
      success: true,
      learningPath
    }
  } catch (error) {
    console.error("[v0] Generate learning path error:", error)
    return handleError(error, "generateLearningPath")
  }
}


export async function evaluatePracticeSession(params: {
  agentId: string
  brokerageId: string
  scenarioId?: string
  response: string
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid agent or brokerage ID" }
  }

  const supabase = await createClient()

  try {
    // Get brokerage's evaluation standards
    const { data: evaluationStandards } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("brokerage_id", params.brokerageId)
      .eq("agent_id", null)
      .maybeSingle()

    const { object: evaluation } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        score: z.number().min(0).max(100),
        feedback: z.string(),
        improvements: z.array(z.string()),
        strengths: z.array(z.string()),
        nextSteps: z.array(z.string())
      }),
      prompt: `Evaluate this practice session response:

Response:
${params.response}

Provide evaluation including:
1. Overall score (0-100)
2. Constructive feedback
3. Areas for improvement (list 3-5)
4. Strengths demonstrated (list 2-3)
5. Next steps for skill development (list 3-5)`
    })

    // Log evaluation for audit trail
    await supabase
      .from("audit_log")
      .insert({
        action: "practice_session_evaluated",
        entity_type: "training_evaluation",
        entity_id: params.agentId,
        brokerage_id: params.brokerageId,
        user_id: params.agentId,
        after: {
          score: evaluation.score
        }
      })
      .catch((err) => {
        console.error("[v0] Failed to log evaluation:", err)
      })

    return {
      success: true,
      score: evaluation.score,
      feedback: evaluation.feedback,
      improvements: evaluation.improvements,
      strengths: evaluation.strengths,
      nextSteps: evaluation.nextSteps
    }
  } catch (error) {
    console.error("[v0] Evaluate practice session error:", error)
    return handleError(error, "evaluatePracticeSession")
  }
}
