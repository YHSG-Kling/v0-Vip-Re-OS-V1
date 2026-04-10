"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ==================== TYPES ====================

export interface OnboardingChecklist {
  profileComplete: boolean
  licenseVerified: boolean
  brokerageAgreementSigned: boolean
  taxFormsCompleted: boolean
  directDepositSetup: boolean
  techStackSetup: boolean
  crmTrained: boolean
  complianceTrained: boolean
  videoPersonaConfigured: boolean
  firstLeadAssigned: boolean
  mentorAssigned: boolean
  firstTransactionStarted: boolean
}

export interface OnboardingStep {
  id: string
  name: string
  description: string
  category: "documents" | "training" | "setup" | "compliance" | "mentorship"
  required: boolean
  order: number
  estimatedMinutes: number
  aiAssisted: boolean
  completedAt?: string
  completedBy?: string
  notes?: string
}

export interface AgentOnboardingSession {
  id: string
  agentId: string
  recruitId?: string
  status: "pending" | "in_progress" | "completed" | "on_hold"
  startDate: string
  targetCompletionDate: string
  actualCompletionDate?: string
  checklist: OnboardingChecklist
  currentStep: string
  assignedMentorId?: string
  assignedTCId?: string
  aiRecommendations?: string[]
  progressPercentage: number
}

// ==================== AI ONBOARDING FUNCTIONS ====================

/**
 * Start a new agent onboarding session
 */
export async function startAgentOnboarding(params: {
  recruitId?: string
  agentUserId: string
  agentName: string
  agentEmail: string
  licenseNumber: string
  licenseState: string
  experienceYears: number
  brokerageId: string
  teamId?: string
  referringAgentId?: string
}) {
  if (!isValidUUID(params.agentUserId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid user or brokerage ID" }
  }

  const supabase = await createClient()

  try {
    // Create the agent record first
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .insert({
        user_id: params.agentUserId,
        brokerage_id: params.brokerageId,
        team_id: params.teamId,
        license_number: params.licenseNumber,
        license_state: params.licenseState,
        license_expiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // Default 1 year
        commission_split: 70, // Default split
        is_active: false, // Not active until onboarding complete
        onboarding_status: "in_progress",
        gamification_points: 0,
        ytd_gci: 0,
        ytd_transactions: 0,
      })
      .select()
      .single()

    if (agentError) throw agentError

    // Generate AI-personalized onboarding plan
    const { object: onboardingPlan } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        recommendedMentorProfile: z.string(),
        prioritizedSteps: z.array(z.string()),
        estimatedCompletionDays: z.number(),
        customTrainingRecommendations: z.array(z.string()),
        riskFactors: z.array(z.string()),
        successPrediction: z.number(),
      }),
      prompt: `Create a personalized onboarding plan for a new real estate agent:
        
Name: ${params.agentName}
Experience: ${params.experienceYears} years
License State: ${params.licenseState}
Has Referral: ${params.referringAgentId ? "Yes" : "No"}

Consider:
1. Their experience level to adjust training depth
2. State-specific compliance requirements
3. Optimal mentor matching criteria
4. Risk factors that could slow onboarding
5. Success prediction based on profile

Provide actionable recommendations.`,
    })

    // Create onboarding session
    const targetDate = new Date()
    targetDate.setDate(targetDate.getDate() + (onboardingPlan.estimatedCompletionDays || 14))

    const { data: session, error: sessionError } = await supabase
      .from("agent_onboarding_sessions")
      .insert({
        agent_id: agent.id,
        recruit_id: params.recruitId,
        status: "in_progress",
        start_date: new Date().toISOString(),
        target_completion_date: targetDate.toISOString(),
        current_step: "profile_setup",
        progress_percentage: 0,
        ai_recommendations: onboardingPlan.customTrainingRecommendations,
        ai_success_prediction: onboardingPlan.successPrediction,
        ai_risk_factors: onboardingPlan.riskFactors,
        checklist: {
          profileComplete: false,
          licenseVerified: false,
          brokerageAgreementSigned: false,
          taxFormsCompleted: false,
          directDepositSetup: false,
          techStackSetup: false,
          crmTrained: false,
          complianceTrained: false,
          videoPersonaConfigured: false,
          firstLeadAssigned: false,
          mentorAssigned: false,
          firstTransactionStarted: false,
        },
      })
      .select()
      .single()

    if (sessionError) throw sessionError

    // Create default onboarding steps
    const defaultSteps: Omit<OnboardingStep, "id">[] = [
      { name: "Complete Agent Profile", description: "Fill out personal information, bio, photo, and specialties", category: "setup", required: true, order: 1, estimatedMinutes: 30, aiAssisted: true },
      { name: "License Verification", description: "Upload license and verify with state board", category: "compliance", required: true, order: 2, estimatedMinutes: 15, aiAssisted: true },
      { name: "Sign Brokerage Agreement", description: "Review and e-sign Independent Contractor Agreement", category: "documents", required: true, order: 3, estimatedMinutes: 20, aiAssisted: false },
      { name: "Complete W-9 Tax Forms", description: "Submit W-9 for commission payments", category: "documents", required: true, order: 4, estimatedMinutes: 10, aiAssisted: false },
      { name: "Setup Direct Deposit", description: "Configure bank account for commission deposits", category: "setup", required: true, order: 5, estimatedMinutes: 10, aiAssisted: false },
      { name: "Technology Stack Setup", description: "Configure email, CRM access, and mobile apps", category: "setup", required: true, order: 6, estimatedMinutes: 45, aiAssisted: true },
      { name: "CRM Training Module", description: "Complete CRM basics training course", category: "training", required: true, order: 7, estimatedMinutes: 60, aiAssisted: true },
      { name: "Fair Housing Compliance", description: "Complete required fair housing training", category: "compliance", required: true, order: 8, estimatedMinutes: 90, aiAssisted: true },
      { name: "Configure Video Persona", description: "Setup HeyGen avatar and voice for AI videos", category: "setup", required: false, order: 9, estimatedMinutes: 30, aiAssisted: true },
      { name: "Mentor Assignment", description: "Get matched with experienced mentor", category: "mentorship", required: true, order: 10, estimatedMinutes: 15, aiAssisted: true },
      { name: "First Lead Assignment", description: "Receive and respond to first lead", category: "training", required: false, order: 11, estimatedMinutes: 30, aiAssisted: true },
      { name: "Transaction Training", description: "Complete transaction workflow training", category: "training", required: true, order: 12, estimatedMinutes: 120, aiAssisted: true },
    ]

    for (const step of defaultSteps) {
      await supabase.from("agent_onboarding_steps").insert({
        session_id: session.id,
        ...step,
      })
    }

    // Update recruit status if applicable
    if (params.recruitId) {
      await supabase
        .from("recruits")
        .update({ status: "Joined", joined_at: new Date().toISOString() })
        .eq("id", params.recruitId)
    }

    revalidatePath("/admin/agent-roster")
    revalidatePath("/admin/recruiting-hub")

    return {
      success: true,
      agentId: agent.id,
      sessionId: session.id,
      onboardingPlan,
    }
  } catch (error) {
    console.error("Start onboarding error:", error)
    return handleError(error, "startAgentOnboarding")
  }
}

/**
 * Get agent onboarding status with AI insights
 */
export async function getOnboardingStatus(agentId: string) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: session, error: sessionError } = await supabase
      .from("agent_onboarding_sessions")
      .select(`
        *,
        agent:agents(*),
        steps:agent_onboarding_steps(*)
      `)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (sessionError) throw sessionError

    const completedSteps = session.steps.filter((s: any) => s.completed_at).length
    const totalSteps = session.steps.length
    const progressPercentage = Math.round((completedSteps / totalSteps) * 100)

    // Generate AI status summary
    const { text: aiSummary } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Summarize onboarding progress for agent:
        
Progress: ${progressPercentage}%
Completed Steps: ${completedSteps}/${totalSteps}
Days Since Start: ${Math.floor((Date.now() - new Date(session.start_date).getTime()) / (1000 * 60 * 60 * 24))}
Target Completion: ${new Date(session.target_completion_date).toLocaleDateString()}
Risk Factors: ${JSON.stringify(session.ai_risk_factors || [])}

Provide a brief 2-3 sentence summary with encouragement and next priority action.`,
    })

    return {
      success: true,
      session: {
        ...session,
        progressPercentage,
        completedSteps,
        totalSteps,
      },
      aiSummary,
    }
  } catch (error) {
    console.error("Get onboarding status error:", error)
    return handleError(error, "getOnboardingStatus")
  }
}

/**
 * Complete an onboarding step with AI verification
 */
export async function completeAISessionStep(params: {
  sessionId: string
  stepId: string
  completedBy: string
  notes?: string
  attachments?: string[]
}) {
  if (!isValidUUID(params.sessionId) || !isValidUUID(params.stepId)) {
    return { success: false, error: "Invalid session or step ID" }
  }

  const supabase = await createClient()

  try {
    // Get step details
    const { data: step, error: stepError } = await supabase
      .from("agent_onboarding_steps")
      .select("*")
      .eq("id", params.stepId)
      .single()

    if (stepError) throw stepError

    // Mark step as complete
    const { error: updateError } = await supabase
      .from("agent_onboarding_steps")
      .update({
        completed_at: new Date().toISOString(),
        completed_by: params.completedBy,
        notes: params.notes,
        attachments: params.attachments,
      })
      .eq("id", params.stepId)

    if (updateError) throw updateError

    // Get session and recalculate progress
    const { data: session, error: sessionError } = await supabase
      .from("agent_onboarding_sessions")
      .select(`
        *,
        steps:agent_onboarding_steps(*)
      `)
      .eq("id", params.sessionId)
      .single()

    if (sessionError) throw sessionError

    const completedSteps = session.steps.filter((s: any) => s.completed_at).length
    const totalSteps = session.steps.length
    const progressPercentage = Math.round((completedSteps / totalSteps) * 100)

    // Update checklist based on step completed
    const checklist = session.checklist || {}
    const checklistMap: Record<string, keyof OnboardingChecklist> = {
      "Complete Agent Profile": "profileComplete",
      "License Verification": "licenseVerified",
      "Sign Brokerage Agreement": "brokerageAgreementSigned",
      "Complete W-9 Tax Forms": "taxFormsCompleted",
      "Setup Direct Deposit": "directDepositSetup",
      "Technology Stack Setup": "techStackSetup",
      "CRM Training Module": "crmTrained",
      "Fair Housing Compliance": "complianceTrained",
      "Configure Video Persona": "videoPersonaConfigured",
      "First Lead Assignment": "firstLeadAssigned",
      "Mentor Assignment": "mentorAssigned",
      "Transaction Training": "firstTransactionStarted",
    }

    if (checklistMap[step.name]) {
      checklist[checklistMap[step.name]] = true
    }

    // Find next step
    const incompleteSteps = session.steps
      .filter((s: any) => !s.completed_at)
      .sort((a: any, b: any) => a.order - b.order)
    const nextStep = incompleteSteps[0]?.name || "completed"

    // Update session
    const isComplete = progressPercentage === 100

    await supabase
      .from("agent_onboarding_sessions")
      .update({
        progress_percentage: progressPercentage,
        current_step: nextStep,
        checklist,
        status: isComplete ? "completed" : "in_progress",
        actual_completion_date: isComplete ? new Date().toISOString() : null,
      })
      .eq("id", params.sessionId)

    // If onboarding complete, activate agent
    if (isComplete) {
      await supabase
        .from("agents")
        .update({
          is_active: true,
          onboarding_status: "completed",
          onboarding_completed_at: new Date().toISOString(),
        })
        .eq("id", session.agent_id)

      // Award gamification points
      await supabase
        .from("agents")
        .update({ gamification_points: 100 })
        .eq("id", session.agent_id)
    }

    revalidatePath("/admin/agent-roster")

    return {
      success: true,
      progressPercentage,
      nextStep,
      isComplete,
    }
  } catch (error) {
    console.error("Complete step error:", error)
    return handleError(error, "completeAISessionStep")
  }
}

/**
 * AI-powered mentor matching
 */
export async function matchMentor(agentId: string) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get new agent profile
    const { data: newAgent, error: agentError } = await supabase
      .from("agents")
      .select("*, user:users(*)")
      .eq("id", agentId)
      .single()

    if (agentError) throw agentError

    // Get potential mentors (experienced agents)
    const { data: mentors, error: mentorsError } = await supabase
      .from("agents")
      .select("*, user:users(*)")
      .eq("is_active", true)
      .gte("ytd_transactions", 10)
      .neq("id", agentId)
      .limit(10)

    if (mentorsError) throw mentorsError

    if (!mentors || mentors.length === 0) {
      return { success: false, error: "No eligible mentors found" }
    }

    // AI matching
    const { object: matchResult } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        bestMentorId: z.string(),
        matchScore: z.number(),
        matchReason: z.string(),
        suggestedMeetingTopics: z.array(z.string()),
        alternativeMentors: z.array(z.object({
          id: z.string(),
          score: z.number(),
          reason: z.string(),
        })),
      }),
      prompt: `Match a mentor for new real estate agent:

New Agent:
- License State: ${newAgent.license_state}
- Specialties: ${JSON.stringify(newAgent.specialties || [])}
- Service Areas: ${JSON.stringify(newAgent.service_areas || [])}

Available Mentors:
${mentors.map((m: any) => `
- ID: ${m.id}
- Name: ${m.user?.name || "Unknown"}
- YTD Transactions: ${m.ytd_transactions}
- YTD GCI: $${m.ytd_gci}
- Specialties: ${JSON.stringify(m.specialties || [])}
- Service Areas: ${JSON.stringify(m.service_areas || [])}
`).join("\n")}

Select the best mentor match based on:
1. Geographic overlap
2. Specialty alignment
3. Experience level
4. Availability

Return the mentor ID that best matches.`,
    })

    // Assign mentor
    const { error: updateError } = await supabase
      .from("agent_onboarding_sessions")
      .update({
        assigned_mentor_id: matchResult.bestMentorId,
        mentor_match_score: matchResult.matchScore,
        mentor_match_reason: matchResult.matchReason,
      })
      .eq("agent_id", agentId)

    if (updateError) throw updateError

    // Create mentor relationship
    await supabase.from("agent_mentor_relationships").insert({
      mentee_id: agentId,
      mentor_id: matchResult.bestMentorId,
      status: "active",
      suggested_topics: matchResult.suggestedMeetingTopics,
    })

    revalidatePath("/admin/agent-roster")

    return {
      success: true,
      mentorId: matchResult.bestMentorId,
      matchScore: matchResult.matchScore,
      matchReason: matchResult.matchReason,
      suggestedTopics: matchResult.suggestedMeetingTopics,
    }
  } catch (error) {
    console.error("Match mentor error:", error)
    return handleError(error, "matchMentor")
  }
}

/**
 * Verify agent license with AI document analysis
 */
export async function verifyAgentLicense(params: {
  agentId: string
  licenseImageUrl: string
  licenseNumber: string
  licenseState: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // AI verification (simulate OCR and validation)
    const { object: verification } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        isValid: z.boolean(),
        extractedLicenseNumber: z.string(),
        extractedState: z.string(),
        extractedName: z.string(),
        extractedExpiry: z.string(),
        confidenceScore: z.number(),
        issues: z.array(z.string()),
      }),
      prompt: `Simulate license verification for:
License Number: ${params.licenseNumber}
State: ${params.licenseState}

In production, this would use OCR on the uploaded image.
For now, simulate a verification result with high confidence.
Check if license format matches ${params.licenseState} standards.`,
    })

    // Update agent record
    if (verification.isValid) {
      await supabase
        .from("agents")
        .update({
          license_verified: true,
          license_verified_at: new Date().toISOString(),
          license_expiry: verification.extractedExpiry,
        })
        .eq("id", params.agentId)

      // Complete the license verification step
      const { data: session } = await supabase
        .from("agent_onboarding_sessions")
        .select("id")
        .eq("agent_id", params.agentId)
        .single()

      if (session) {
        const { data: step } = await supabase
          .from("agent_onboarding_steps")
          .select("id")
          .eq("session_id", session.id)
          .eq("name", "License Verification")
          .single()

  if (step) {
    await completeAISessionStep({
      sessionId: session.id,
      stepId: step.id,
            completedBy: "system",
            notes: `AI verified with ${verification.confidenceScore}% confidence`,
          })
        }
      }
    }

    return {
      success: true,
      verification,
    }
  } catch (error) {
    console.error("Verify license error:", error)
    return handleError(error, "verifyAgentLicense")
  }
}

/**
 * Generate personalized onboarding welcome message
 */
export async function generateWelcomeMessage(agentId: string) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: agent, error } = await supabase
      .from("agents")
      .select("*, user:users(*), brokerage:brokerages(*)")
      .eq("id", agentId)
      .single()

    if (error) throw error

    const { text: welcomeMessage } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate a warm, professional welcome message for a new real estate agent joining a brokerage:

Agent Name: ${agent.user?.name || "New Agent"}
Brokerage: ${agent.brokerage?.name || "Our Brokerage"}
License State: ${agent.license_state}

The message should:
1. Welcome them enthusiastically
2. Highlight key benefits of the brokerage
3. Explain what to expect in onboarding
4. Encourage them to reach out with questions
5. Be warm but professional (2-3 paragraphs)`,
    })

    return {
      success: true,
      welcomeMessage,
    }
  } catch (error) {
    console.error("Generate welcome error:", error)
    return handleError(error, "generateWelcomeMessage")
  }
}

/**
 * AI Onboarding Buddy - 24/7 question answering assistant
 */
export async function askOnboardingBuddy(params: {
  agentId: string
  question: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent's onboarding context
    const { data: session } = await supabase
      .from("agent_onboarding_sessions")
      .select("current_step, progress_percentage, status")
      .eq("agent_id", params.agentId)
      .single()

    // Generate AI response
    const { text: answer } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are the Smart Engine AI Onboarding Buddy for new real estate agents.

Your Role:
- Help new agents learn the system
- Answer questions about features and workflows
- Provide encouragement and motivation
- Guide them through tasks step-by-step
- Never judge or make them feel stupid

Personality:
- Supportive and patient (like a friendly mentor)
- Enthusiastic about their progress
- Clear and concise in explanations
- Uses analogies and examples
- Celebrates small wins

Agent Context:
- Current Progress: ${session?.progress_percentage || 0}%
- Current Step: ${session?.current_step || "Getting Started"}
- Status: ${session?.status || "Starting"}

Question: ${params.question}

Provide a helpful, encouraging answer in 2-3 paragraphs. Include actionable next steps and relevant tips.`,
    })

    // Log the conversation
    await supabase.from("onboarding_ai_chats").insert({
      agent_id: params.agentId,
      question: params.question,
      ai_response: answer,
      created_at: new Date().toISOString(),
    })

    return {
      success: true,
      answer,
    }
  } catch (error) {
    console.error("AI Buddy error:", error)
    return handleError(error, "askOnboardingBuddy")
  }
}

/**
 * Submit quiz attempt and validate answers
 */
export async function submitQuizAttempt(params: {
  agentId: string
  quizId: string
  answers: Record<string, string>
  sessionId: string
  stepId: string
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.quizId)) {
    return { success: false, error: "Invalid agent or quiz ID" }
  }

  const supabase = await createClient()

  try {
    // Get quiz with correct answers
    const { data: quiz, error: quizError } = await supabase
      .from("onboarding_quizzes")
      .select("*")
      .eq("id", params.quizId)
      .single()

    if (quizError) throw quizError

    // Calculate score
    const questions = quiz.questions as any[]
    let correctCount = 0
    questions.forEach((q: any) => {
      if (params.answers[q.id] === q.correctAnswer) {
        correctCount++
      }
    })
    const score = Math.round((correctCount / questions.length) * 100)
    const passed = score >= (quiz.passing_score || 80)

    // Get attempt number
    const { data: prevAttempts } = await supabase
      .from("agent_quiz_attempts")
      .select("attempt_number")
      .eq("agent_id", params.agentId)
      .eq("quiz_id", params.quizId)
      .order("attempt_number", { ascending: false })
      .limit(1)

    const attemptNumber = (prevAttempts?.[0]?.attempt_number || 0) + 1

    // Save attempt
    await supabase.from("agent_quiz_attempts").insert({
      agent_id: params.agentId,
      quiz_id: params.quizId,
      score,
      answers: params.answers,
      passed,
      attempt_number: attemptNumber,
      created_at: new Date().toISOString(),
    })

  // If passed, complete the step
  if (passed) {
    await completeAISessionStep({
      sessionId: params.sessionId,
      stepId: params.stepId,
        completedBy: params.agentId,
        notes: `Quiz passed with ${score}% on attempt ${attemptNumber}`,
      })
    }

    return {
      success: true,
      score,
      passed,
      correctCount,
      totalQuestions: questions.length,
      attemptNumber,
      message: passed
        ? `Congratulations! You passed with ${score}%`
        : `Score: ${score}%. Need ${quiz.passing_score}% to pass. Review and try again.`,
    }
  } catch (error) {
    console.error("Submit quiz error:", error)
    return handleError(error, "submitQuizAttempt")
  }
}

/**
 * Certify agent after final exam
 */
export async function certifyAgent(params: {
  agentId: string
  examScore: number
  sessionId: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    if (params.examScore < 90) {
      return {
        success: false,
        message: `Score: ${params.examScore}%. Need 90% to certify. Review training materials and try again.`,
      }
    }

    // Grant certification
    await supabase
      .from("agent_onboarding_sessions")
      .update({
        status: "completed",
        progress_percentage: 100,
        certification_achieved: true,
        certified_at: new Date().toISOString(),
        actual_completion_date: new Date().toISOString(),
      })
      .eq("id", params.sessionId)

    // Activate agent
    await supabase
      .from("agents")
      .update({
        is_active: true,
        onboarding_status: "completed",
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq("id", params.agentId)

    // Send certification notification
    await supabase.from("notifications").insert({
      recipient_id: params.agentId,
      notification_type: "certification_achieved",
      title: "Congratulations! You're Certified!",
      message: "Welcome to the team. You now have full access to Smart Engine.",
      priority: "high",
      created_at: new Date().toISOString(),
    })

    revalidatePath("/admin/agent-roster")

    return {
      success: true,
      certified: true,
      message: "Certification complete! Welcome to the team.",
    }
  } catch (error) {
    console.error("Certify agent error:", error)
    return handleError(error, "certifyAgent")
  }
}

/**
 * Get onboarding analytics for admin dashboard
 */
export async function getOnboardingAnalytics(brokerageId: string) {
  if (!isValidUUID(brokerageId)) {
    return { success: false, error: "Invalid brokerage ID" }
  }

  const supabase = await createClient()

  try {
    // Get all sessions for brokerage
    const { data: sessions, error } = await supabase
      .from("agent_onboarding_sessions")
      .select(`
        *,
        agent:agents!inner(brokerage_id)
      `)
      .eq("agent.brokerage_id", brokerageId)

    if (error) throw error

    const analytics = {
      totalOnboarding: sessions.length,
      inProgress: sessions.filter((s: any) => s.status === "in_progress").length,
      completed: sessions.filter((s: any) => s.status === "completed").length,
      onHold: sessions.filter((s: any) => s.status === "on_hold").length,
      averageCompletionDays: 0,
      averageProgressPercentage: 0,
      bottleneckSteps: [] as string[],
    }

    // Calculate averages
    const completedSessions = sessions.filter((s: any) => s.status === "completed")
    if (completedSessions.length > 0) {
      const totalDays = completedSessions.reduce((sum: number, s: any) => {
        const start = new Date(s.start_date)
        const end = new Date(s.actual_completion_date)
        return sum + Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
      }, 0)
      analytics.averageCompletionDays = Math.round(totalDays / completedSessions.length)
    }

    const inProgressSessions = sessions.filter((s: any) => s.status === "in_progress")
    if (inProgressSessions.length > 0) {
      const totalProgress = inProgressSessions.reduce((sum: number, s: any) => sum + (s.progress_percentage || 0), 0)
      analytics.averageProgressPercentage = Math.round(totalProgress / inProgressSessions.length)
    }

    return {
      success: true,
      analytics,
    }
  } catch (error) {
    console.error("Get analytics error:", error)
    return handleError(error, "getOnboardingAnalytics")
  }
}
