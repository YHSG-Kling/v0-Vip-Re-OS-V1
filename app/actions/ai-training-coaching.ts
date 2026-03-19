"use server"

import { createClient } from "@/lib/supabase/server"
import { generateText, generateObject } from "ai"
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
      .limit(100)

    // Get agent profile
    const { data: agent } = await supabase
      .from("agents")
      .select("*")
      .eq("id", params.agentId)
      .single()

    const { object: analysis } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        overallScore: z.number(),
        performanceGrade: z.enum(["A", "B", "C", "D", "F"]),
        summary: z.string(),
        strengths: z.array(z.object({
          area: z.string(),
          score: z.number(),
          evidence: z.string(),
          recommendation: z.string()
        })),
        improvementAreas: z.array(z.object({
          area: z.string(),
          currentScore: z.number(),
          targetScore: z.number(),
          gap: z.string(),
          priority: z.enum(["high", "medium", "low"]),
          actionPlan: z.string()
        })),
        metrics: z.object({
          closedTransactions: z.number(),
          totalVolume: z.number(),
          avgDaysToClose: z.number(),
          leadConversionRate: z.number(),
          avgCommission: z.number(),
          clientSatisfaction: z.number(),
          responseTime: z.string(),
          followUpRate: z.number()
        }),
        skillsAssessment: z.object({
          prospecting: z.number(),
          negotiation: z.number(),
          marketing: z.number(),
          clientRelations: z.number(),
          marketKnowledge: z.number(),
          technology: z.number(),
          timeManagement: z.number(),
          communication: z.number()
        }),
        comparisonToPeers: z.object({
          percentile: z.number(),
          areasAboveAverage: z.array(z.string()),
          areasBelowAverage: z.array(z.string())
        }),
        coachingPriorities: z.array(z.object({
          priority: z.number(),
          skill: z.string(),
          currentLevel: z.string(),
          targetLevel: z.string(),
          suggestedResources: z.array(z.string()),
          estimatedTimeToImprove: z.string()
        })),
        weeklyGoals: z.array(z.object({
          goal: z.string(),
          metric: z.string(),
          target: z.number(),
          currentValue: z.number()
        }))
      }),
      prompt: `Analyze this real estate agent's performance:

Agent Profile:
${JSON.stringify(agent || {}, null, 2)}

Transactions (${transactions?.length || 0} total):
${JSON.stringify(transactions?.slice(0, 20) || [], null, 2)}

Contacts and Interactions:
${JSON.stringify(contacts?.slice(0, 20)?.map(c => ({
  status: c.status,
  source: c.source,
  interactions: c.interactions?.length || 0
})) || [], null, 2)}

Recent Activities:
${JSON.stringify(activities?.slice(0, 20) || [], null, 2)}

Provide comprehensive performance analysis:
1. Overall performance score and grade
2. Key strengths with evidence
3. Areas for improvement with action plans
4. Skills assessment across 8 core areas
5. Comparison to industry averages
6. Coaching priorities
7. Weekly goals to focus on`
    })

    // Save analysis
    const { data: report, error } = await supabase
      .from("agent_performance_reports")
      .insert({
        agent_id: params.agentId,
        broker_id: params.brokerId,
        analysis: analysis,
        timeframe: params.timeframe || "90_days",
        generated_at: new Date().toISOString()
      })
      .select()
      .single()

    return {
      success: true,
      analysis,
      reportId: report?.id
    }
  } catch (error) {
    console.error("[v0] Analyze agent performance error:", error)
    return handleError(error, "analyzeAgentPerformance")
  }
}

/**
 * Generate personalized learning path for an agent
 */
export async function generateLearningPath(params: {
  agentId: string
  focusAreas?: string[]
  experienceLevel?: "new" | "intermediate" | "experienced"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent's completed courses
    const { data: completedCourses } = await supabase
      .from("agent_courses")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("status", "completed")

    // Get available courses
    const { data: availableCourses } = await supabase
      .from("training_courses")
      .select("*")
      .eq("status", "active")

    // Get recent performance analysis
    const { data: performanceReport } = await supabase
      .from("agent_performance_reports")
      .select("analysis")
      .eq("agent_id", params.agentId)
      .order("generated_at", { ascending: false })
      .limit(1)
      .single()

    const { object: learningPath } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        overview: z.string(),
        estimatedDuration: z.string(),
        modules: z.array(z.object({
          order: z.number(),
          title: z.string(),
          description: z.string(),
          skillsTargeted: z.array(z.string()),
          estimatedTime: z.string(),
          format: z.enum(["video", "reading", "interactive", "practice", "quiz"]),
          resources: z.array(z.object({
            type: z.string(),
            title: z.string(),
            url: z.string().optional(),
            duration: z.string().optional()
          })),
          assessmentCriteria: z.string(),
          prerequisite: z.string().optional()
        })),
        milestones: z.array(z.object({
          milestone: z.string(),
          targetDate: z.string(),
          reward: z.string().optional()
        })),
        practiceScenarios: z.array(z.object({
          scenario: z.string(),
          skillsPracticed: z.array(z.string()),
          difficulty: z.enum(["beginner", "intermediate", "advanced"]),
          expectedOutcome: z.string()
        })),
        mentorshipSuggestions: z.object({
          recommendedMentorType: z.string(),
          meetingFrequency: z.string(),
          discussionTopics: z.array(z.string())
        }),
        successMetrics: z.array(z.object({
          metric: z.string(),
          baseline: z.string(),
          target: z.string(),
          measurementMethod: z.string()
        }))
      }),
      prompt: `Create a personalized learning path:

Experience Level: ${params.experienceLevel || "intermediate"}
Focus Areas: ${params.focusAreas?.join(", ") || "General improvement"}

Completed Courses:
${JSON.stringify(completedCourses?.map(c => c.course_name) || [], null, 2)}

Available Courses:
${JSON.stringify(availableCourses?.map(c => ({
  name: c.name,
  category: c.category,
  difficulty: c.difficulty,
  duration: c.duration
})) || [], null, 2)}

Recent Performance Analysis:
${JSON.stringify(performanceReport?.analysis || {}, null, 2)}

Create:
1. Customized learning modules in order
2. Milestone checkpoints
3. Practice scenarios
4. Mentorship suggestions
5. Success metrics to track progress`
    })

    // Save learning path
    const { data: path, error } = await supabase
      .from("agent_learning_paths")
      .insert({
        agent_id: params.agentId,
        learning_path: learningPath,
        focus_areas: params.focusAreas,
        status: "active",
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    return {
      success: true,
      learningPath,
      pathId: path?.id
    }
  } catch (error) {
    console.error("[v0] Generate learning path error:", error)
    return handleError(error, "generateLearningPath")
  }
}

/**
 * Generate role-play coaching scenario
 */
export async function generateCoachingScenario(params: {
  agentId: string
  scenarioType: "listing_presentation" | "buyer_consultation" | "negotiation" | "objection_handling" | "cold_calling" | "fsbo_conversion"
  difficulty?: "easy" | "medium" | "hard"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
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
      prompt: `Create a realistic coaching scenario:

Scenario Type: ${params.scenarioType}
Difficulty: ${params.difficulty || "medium"}

Generate a detailed role-play scenario including:
1. Setup and context
2. Client profile with personality and concerns
3. Clear objectives for the agent
4. Key points to cover
5. Dialogue starters with suggested responses
6. Evaluation criteria
7. Debrief materials`
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
 * Evaluate agent's practice session and provide feedback
 */
export async function evaluatePracticeSession(params: {
  agentId: string
  scenarioType: string
  transcript: string
  audioUrl?: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { object: evaluation } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        overallScore: z.number(),
        grade: z.enum(["A", "B", "C", "D", "F"]),
        summary: z.string(),
        strengths: z.array(z.object({
          area: z.string(),
          example: z.string(),
          impact: z.string()
        })),
        improvementAreas: z.array(z.object({
          area: z.string(),
          example: z.string(),
          suggestion: z.string(),
          priority: z.enum(["high", "medium", "low"])
        })),
        skillScores: z.object({
          rapport: z.number(),
          questioning: z.number(),
          listening: z.number(),
          valueProposition: z.number(),
          objectionHandling: z.number(),
          closing: z.number()
        }),
        keyMoments: z.array(z.object({
          timestamp: z.string().optional(),
          quote: z.string(),
          analysis: z.string(),
          suggestion: z.string()
        })),
        languageAnalysis: z.object({
          powerWords: z.array(z.string()),
          fillerWords: z.array(z.string()),
          confidenceLevel: z.enum(["high", "medium", "low"]),
          toneAssessment: z.string()
        }),
        nextSteps: z.array(z.object({
          action: z.string(),
          timeframe: z.string(),
          resource: z.string().optional()
        }))
      }),
      prompt: `Evaluate this practice session:

Scenario Type: ${params.scenarioType}

Transcript:
${params.transcript}

Provide detailed feedback:
1. Overall score and grade
2. Specific strengths with examples
3. Areas for improvement with suggestions
4. Skill-by-skill scores
5. Key moments analysis
6. Language and tone analysis
7. Specific next steps for improvement`
    })

    // Save evaluation
    const { data: saved, error } = await supabase
      .from("practice_evaluations")
      .insert({
        agent_id: params.agentId,
        scenario_type: params.scenarioType,
        transcript: params.transcript,
        evaluation: evaluation,
        overall_score: evaluation.overallScore,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    return {
      success: true,
      evaluation,
      evaluationId: saved?.id
    }
  } catch (error) {
    console.error("[v0] Evaluate practice session error:", error)
    return handleError(error, "evaluatePracticeSession")
  }
}
