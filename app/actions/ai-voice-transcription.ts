"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

/**
 * AI Voice Transcription & Call Analysis System
 * Transcribes calls, extracts insights, and generates follow-up actions
 */

const CallAnalysisSchema = z.object({
  summary: z.string(),
  duration: z.string(),
  sentiment: z.enum(["very_positive", "positive", "neutral", "negative", "very_negative"]),
  keyTopics: z.array(z.string()),
  clientConcerns: z.array(z.string()),
  agentCommitments: z.array(z.object({
    commitment: z.string(),
    deadline: z.string().optional(),
  })),
  clientCommitments: z.array(z.object({
    commitment: z.string(),
    deadline: z.string().optional(),
  })),
  actionItems: z.array(z.object({
    action: z.string(),
    assignedTo: z.enum(["agent", "client", "vendor", "other"]),
    priority: z.enum(["high", "medium", "low"]),
    dueDate: z.string().optional(),
  })),
  nextSteps: z.array(z.string()),
  propertyMentions: z.array(z.object({
    address: z.string().optional(),
    mlsNumber: z.string().optional(),
    context: z.string(),
  })),
  financialDiscussions: z.array(z.object({
    topic: z.string(),
    amount: z.string().optional(),
    context: z.string(),
  })),
  scheduledFollowUp: z.object({
    scheduled: z.boolean(),
    dateTime: z.string().optional(),
    purpose: z.string().optional(),
  }),
  complianceFlags: z.array(z.object({
    flag: z.string(),
    severity: z.enum(["info", "warning", "critical"]),
    context: z.string(),
  })),
  coachingOpportunities: z.array(z.string()),
})

// Analyze a call transcript
export async function analyzeCallTranscript(params: {
  transcriptId?: string
  transcript: string
  contactId: string
  agentId: string
  callDuration?: number
  callType?: "inbound" | "outbound"
}) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid contact or agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get contact context
    const { data: contact } = await supabase
      .from("contacts")
      .select("*, transactions(*)")
      .eq("id", params.contactId)
      .single()

    const { object: analysis } = await generateObject({
      model: "openai/gpt-4o",
      schema: CallAnalysisSchema,
      prompt: `Analyze this real estate phone call transcript:

CALL DETAILS:
- Type: ${params.callType || "Unknown"}
- Duration: ${params.callDuration ? `${Math.round(params.callDuration / 60)} minutes` : "Unknown"}

CLIENT INFO:
- Name: ${contact?.first_name} ${contact?.last_name}
- Type: ${contact?.contact_type || "Unknown"}
- Stage: ${contact?.pipeline_stage || "Unknown"}
- Active Deals: ${contact?.transactions?.filter((t: any) => t.status === "active").length || 0}

TRANSCRIPT:
${params.transcript}

Extract:
1. Concise summary of the call
2. Key topics discussed
3. Any concerns the client expressed
4. Commitments made by the agent (things they promised to do)
5. Commitments made by the client
6. Clear action items with priorities
7. Any properties mentioned
8. Financial discussions (prices, budgets, offers, etc.)
9. Scheduled follow-ups
10. Any compliance concerns (fair housing, discrimination, unauthorized promises)
11. Coaching opportunities for agent improvement`,
    })

    // Save analysis
    const { data: savedAnalysis } = await supabase
      .from("call_analyses")
      .insert({
        transcript_id: params.transcriptId,
        contact_id: params.contactId,
        agent_id: params.agentId,
        transcript: params.transcript,
        call_type: params.callType,
        call_duration: params.callDuration,
        summary: analysis.summary,
        sentiment: analysis.sentiment,
        key_topics: analysis.keyTopics,
        client_concerns: analysis.clientConcerns,
        agent_commitments: analysis.agentCommitments,
        client_commitments: analysis.clientCommitments,
        action_items: analysis.actionItems,
        next_steps: analysis.nextSteps,
        property_mentions: analysis.propertyMentions,
        financial_discussions: analysis.financialDiscussions,
        scheduled_follow_up: analysis.scheduledFollowUp,
        compliance_flags: analysis.complianceFlags,
        coaching_opportunities: analysis.coachingOpportunities,
        analyzed_at: new Date().toISOString(),
      })
      .select()
      .single()

    // Create tasks from action items
    const agentTasks = analysis.actionItems.filter(a => a.assignedTo === "agent")
    if (agentTasks.length > 0) {
      const tasks = agentTasks.map(item => ({
        agent_id: params.agentId,
        contact_id: params.contactId,
        title: item.action,
        priority: item.priority,
        status: "pending",
        due_date: item.dueDate || null,
        source: "call_analysis",
        source_id: savedAnalysis?.id,
      }))

      await supabase.from("tasks").insert(tasks)
    }

    // Log compliance flags if any
    if (analysis.complianceFlags.length > 0) {
      await supabase.from("compliance_events").insert({
        agent_id: params.agentId,
        contact_id: params.contactId,
        event_type: "call_compliance_flags",
        severity: analysis.complianceFlags.some(f => f.severity === "critical") ? "high" : "medium",
        details: {
          call_analysis_id: savedAnalysis?.id,
          flags: analysis.complianceFlags,
        },
      })
    }

    // Log interaction
    await supabase.from("interactions").insert({
      contact_id: params.contactId,
      agent_id: params.agentId,
      interaction_type: "call",
      interaction_date: new Date().toISOString(),
      notes: analysis.summary,
      outcome: analysis.sentiment === "very_positive" || analysis.sentiment === "positive" ? "positive" : "neutral",
      metadata: {
        call_analysis_id: savedAnalysis?.id,
        duration: params.callDuration,
        action_items_count: analysis.actionItems.length,
      },
    })

    revalidatePath(`/contacts/${params.contactId}`)

    return {
      success: true,
      analysis: savedAnalysis,
      summary: {
        sentiment: analysis.sentiment,
        actionItemsCount: analysis.actionItems.length,
        complianceFlagsCount: analysis.complianceFlags.length,
        hasFollowUp: analysis.scheduledFollowUp.scheduled,
      },
    }
  } catch (error) {
    console.error("[AI Call Analysis Error]:", error)
    return handleError(error, "analyzeCallTranscript")
  }
}

// Generate call summary email
export async function generateCallSummaryEmail(params: {
  analysisId: string
  recipientType: "client" | "agent" | "both"
  agentId: string
}) {
  const supabase = await createClient()

  try {
    const { data: analysis } = await supabase
      .from("call_analyses")
      .select("*, contacts(*)")
      .eq("id", params.analysisId)
      .single()

    if (!analysis) {
      return { success: false, error: "Analysis not found" }
    }

    const { text: email } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate a professional follow-up email after a real estate phone call.

CALL SUMMARY: ${analysis.summary}

KEY POINTS DISCUSSED:
${analysis.key_topics?.join("\n- ")}

COMMITMENTS MADE:
Agent: ${analysis.agent_commitments?.map((c: any) => c.commitment).join(", ") || "None"}
Client: ${analysis.client_commitments?.map((c: any) => c.commitment).join(", ") || "None"}

NEXT STEPS:
${analysis.next_steps?.join("\n- ")}

Generate a warm, professional email to the ${params.recipientType === "client" ? "client" : "agent"} summarizing the call and next steps. Keep it concise but thorough.`,
    })

    return { success: true, email }
  } catch (error) {
    return handleError(error, "generateCallSummaryEmail")
  }
}

// Get call insights for agent performance
export async function getAgentCallInsights(params: {
  agentId: string
  timeframe: "week" | "month" | "quarter"
}) {
  const supabase = await createClient()

  try {
    const days = params.timeframe === "week" ? 7 : params.timeframe === "month" ? 30 : 90
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const { data: analyses } = await supabase
      .from("call_analyses")
      .select("*")
      .eq("agent_id", params.agentId)
      .gte("analyzed_at", startDate)

    if (!analyses || analyses.length === 0) {
      return { success: true, insights: null, message: "No calls analyzed in this timeframe" }
    }

    const { object: insights } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        totalCalls: z.number(),
        avgCallDuration: z.number(),
        sentimentDistribution: z.object({
          positive: z.number(),
          neutral: z.number(),
          negative: z.number(),
        }),
        topTopics: z.array(z.string()),
        commonConcerns: z.array(z.string()),
        strengthAreas: z.array(z.string()),
        improvementAreas: z.array(z.string()),
        complianceScore: z.number(),
        conversionIndicators: z.string(),
        recommendations: z.array(z.string()),
      }),
      prompt: `Analyze this agent's call performance over ${days} days:

CALL DATA (${analyses.length} calls):
${analyses.map(a => `
- Sentiment: ${a.sentiment}
- Topics: ${a.key_topics?.join(", ")}
- Concerns: ${a.client_concerns?.join(", ")}
- Compliance flags: ${a.compliance_flags?.length || 0}
- Coaching notes: ${a.coaching_opportunities?.join("; ")}
`).join("\n")}

Provide:
1. Overall performance metrics
2. Sentiment distribution
3. Most discussed topics
4. Common client concerns
5. Agent strengths
6. Areas for improvement
7. Compliance score (0-100)
8. Conversion indicators
9. Specific recommendations for improvement`,
    })

    return { success: true, insights }
  } catch (error) {
    return handleError(error, "getAgentCallInsights")
  }
}

// Transcribe audio (mock - would integrate with actual transcription service)
export async function transcribeAudio(params: {
  audioUrl: string
  contactId: string
  agentId: string
  callType: "inbound" | "outbound"
}) {
  // In production, this would call a transcription API like Deepgram, AssemblyAI, or Whisper
  // For now, we'll simulate the process
  
  const supabase = await createClient()

  try {
    // Create pending transcription record
    const { data: transcription } = await supabase
      .from("call_transcriptions")
      .insert({
        audio_url: params.audioUrl,
        contact_id: params.contactId,
        agent_id: params.agentId,
        call_type: params.callType,
        status: "processing",
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    // In production: Call transcription API here
    // const transcript = await deepgram.transcribe(params.audioUrl)

    return {
      success: true,
      transcriptionId: transcription?.id,
      status: "processing",
      message: "Transcription started. You will be notified when complete.",
    }
  } catch (error) {
    return handleError(error, "transcribeAudio")
  }
}
