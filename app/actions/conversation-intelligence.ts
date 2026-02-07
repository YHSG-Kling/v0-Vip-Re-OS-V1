"use server"

/**
 * System 3.4 - Conversation Intelligence & Escalation Signal Engine
 * Server actions for analyzing conversations, detecting escalation signals, and validating AI ISA outcomes
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { 
  analyzeMessageSentiment, 
  analyzeConversationSentiment,
  SentimentScore 
} from "@/lib/conversation-intelligence/sentiment-engine"
import { 
  calculateHealthScore,
  ConversationMetrics,
  HealthScore
} from "@/lib/conversation-intelligence/health-scorer"
import { 
  generateEscalationSignal,
  countEscalationKeywords,
  calculateFrustrationLevel,
  EscalationContext
} from "@/lib/conversation-intelligence/escalation-engine"
import { 
  validateISAConversation,
  ISATranscript
} from "@/lib/conversation-intelligence/isa-validator"
import { 
  enrichWithVoiceIntelligence,
  analyzeVoiceConversation,
  VoiceTranscript
} from "@/lib/conversation-intelligence/voice-intelligence"

/**
 * Analyze a conversation and generate insights
 */
export async function analyzeConversation(conversationId: string, loginId: string) {
  if (!isValidUUID(conversationId) || !isValidUUID(loginId)) {
    return { success: false, error: "Invalid conversation or login ID" }
  }

  const supabase = await createClient()

  try {
    // Get conversation details
    const { data: conversation } = await supabase
      .from("conversations")
      .select("*, contact:contacts(id, first_name, last_name, is_vip, lifetime_value)")
      .eq("id", conversationId)
      .single()

    if (!conversation) {
      return { success: false, error: "Conversation not found" }
    }

    // Get all messages
    const { data: messages } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })

    if (!messages || messages.length === 0) {
      return { success: false, error: "No messages found" }
    }

    // Analyze sentiment across messages
    const message_analyses = messages
      .filter(m => m.content)
      .map(m => ({
        content: m.content,
        direction: m.direction as 'inbound' | 'outbound'
      }))

    const sentiment_analysis = analyzeConversationSentiment(message_analyses)

    // Calculate conversation metrics
    const customer_messages = messages.filter(m => m.direction === 'inbound')
    const agent_messages = messages.filter(m => m.direction === 'outbound')
    
    // Calculate average response time
    let total_response_time = 0
    let response_count = 0
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].direction === 'outbound' && messages[i - 1].direction === 'inbound') {
        const response_time = new Date(messages[i].created_at).getTime() - 
                             new Date(messages[i - 1].created_at).getTime()
        total_response_time += response_time / 1000 // Convert to seconds
        response_count++
      }
    }
    const avg_response_time = response_count > 0 ? total_response_time / response_count : 0

    // Count unresolved questions
    const question_messages = customer_messages.filter(m => m.content?.includes('?'))
    const unresolved_questions = question_messages.length // Simplified; could be more sophisticated

    // Calculate duration
    const first_message = messages[0]
    const last_message = messages[messages.length - 1]
    const duration_minutes = (new Date(last_message.created_at).getTime() - 
                             new Date(first_message.created_at).getTime()) / 60000

    const last_message_age_minutes = (Date.now() - new Date(last_message.created_at).getTime()) / 60000

    // Count escalation keywords in customer messages
    const customer_content = customer_messages.map(m => m.content || '')
    const keyword_counts = countEscalationKeywords(customer_content)

    // Calculate frustration level
    const caps_usage = customer_content.join(' ').split('').filter(c => c === c.toUpperCase() && /[A-Z]/.test(c)).length
    const total_chars = customer_content.join(' ').length
    const caps_percent = total_chars > 0 ? (caps_usage / total_chars) * 100 : 0
    const exclamation_count = customer_content.join(' ').split('!').length - 1

    const frustration_level = calculateFrustrationLevel(
      sentiment_analysis.sentiment_shifts,
      unresolved_questions,
      caps_percent,
      exclamation_count
    )

    const metrics: ConversationMetrics = {
      total_messages: messages.length,
      customer_messages: customer_messages.length,
      agent_messages: agent_messages.length,
      avg_response_time_seconds: avg_response_time,
      sentiment: sentiment_analysis.overall_sentiment,
      sentiment_shifts: sentiment_analysis.sentiment_shifts,
      urgency_level: sentiment_analysis.message_analyses[sentiment_analysis.message_analyses.length - 1]?.urgency_level || 0,
      unresolved_questions,
      duration_minutes,
      last_message_age_minutes
    }

    // Calculate health score
    const health_score = calculateHealthScore(metrics)

    // Generate escalation signal
    const latest_sentiment = sentiment_analysis.message_analyses[sentiment_analysis.message_analyses.length - 1]
    
    const escalation_context: EscalationContext = {
      sentiment: latest_sentiment,
      health: health_score,
      conversation_metrics: {
        duration_minutes,
        message_count: messages.length,
        unresolved_questions,
        escalation_keywords_count: keyword_counts.total_count,
        last_response_minutes_ago: last_message_age_minutes,
        customer_frustration_level: frustration_level
      },
      contact_context: conversation.contact ? {
        is_vip: conversation.contact.is_vip || false,
        lifetime_value: conversation.contact.lifetime_value || 0,
        previous_escalations: 0, // Could query from history
        satisfaction_history: 75 // Could calculate from past conversations
      } : undefined
    }

    const escalation_signal = generateEscalationSignal(escalation_context)

    // Store insights in database
    const { data: insight, error: insightError } = await supabase
      .from("conversation_insights")
      .upsert({
        conversation_id: conversationId,
        overall_sentiment: sentiment_analysis.overall_sentiment,
        sentiment_trend: sentiment_analysis.sentiment_trend,
        sentiment_shifts: sentiment_analysis.sentiment_shifts,
        customer_satisfaction_score: sentiment_analysis.customer_satisfaction_score,
        health_score: health_score.overall_score,
        health_status: health_score.status,
        engagement_score: health_score.factors.engagement_health,
        escalation_level: escalation_signal.level,
        escalation_confidence: escalation_signal.confidence,
        escalation_reasons: escalation_signal.reasons,
        priority_score: escalation_signal.priority_score,
        requires_human_review: escalation_signal.level !== 'none',
        insights_metadata: {
          health_factors: health_score.factors,
          warnings: health_score.warnings,
          recommendations: health_score.recommendations,
          escalation_action: escalation_signal.recommended_action,
          escalation_assignee: escalation_signal.recommended_assignee,
          urgency_multiplier: escalation_signal.urgency_multiplier
        },
        analyzed_at: new Date().toISOString()
      }, {
        onConflict: 'conversation_id'
      })
      .select()
      .single()

    if (insightError) {
      console.error("[v0] Error storing conversation insights:", insightError)
    }

    // Update conversation table with latest sentiment and urgency
    await supabase
      .from("conversations")
      .update({
        sentiment: sentiment_analysis.overall_sentiment,
        urgency_score: escalation_signal.priority_score
      })
      .eq("id", conversationId)

    // Update individual messages with sentiment
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const analysis = sentiment_analysis.message_analyses[i]
      
      if (analysis && msg.content) {
        await supabase
          .from("messages")
          .update({
            sentiment: analysis.score,
            sentiment_confidence: analysis.confidence,
            emotion_detected: analysis.emotion,
            tone_detected: analysis.tone,
            urgency_level: analysis.urgency_level
          })
          .eq("id", msg.id)
      }
    }

    return {
      success: true,
      insights: {
        conversation_id: conversationId,
        sentiment_analysis,
        health_score,
        escalation_signal,
        metrics
      }
    }
  } catch (error: any) {
    console.error("[v0] Conversation analysis failed:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Validate AI ISA call outcome
 */
export async function validateAIISACall(callId: string, loginId: string) {
  if (!isValidUUID(callId) || !isValidUUID(loginId)) {
    return { success: false, error: "Invalid call or login ID" }
  }

  const supabase = await createClient()

  try {
    // Get call details
    const { data: call } = await supabase
      .from("ai_isa_calls")
      .select("*")
      .eq("id", callId)
      .eq("login_id", loginId)
      .single()

    if (!call) {
      return { success: false, error: "Call not found" }
    }

    // Prepare ISA transcript
    const isa_transcript: ISATranscript = {
      transcript_text: call.conversation_transcript || '',
      duration_seconds: call.call_duration_seconds || 0,
      outcome: call.outcome as any,
      qualification_data: call.qualification_result,
      appointment_data: call.appointment_scheduled_id ? {
        scheduled_time: call.created_at // Simplified
      } : undefined
    }

    // Validate conversation
    const validation_result = validateISAConversation(
      isa_transcript,
      call.outcome as any
    )

    // Store validation results
    await supabase
      .from("ai_isa_calls")
      .update({
        validation_status: validation_result.is_valid ? 'validated' : 'failed',
        validation_confidence: validation_result.confidence_score,
        validation_issues: validation_result.issues_detected,
        requires_human_review: validation_result.should_human_review,
        validation_summary: validation_result.validation_summary
      })
      .eq("id", callId)

    // Create task for human review if needed
    if (validation_result.should_human_review) {
      await supabase
        .from("tasks")
        .insert({
          assigned_to: loginId,
          contact_id: call.contact_id,
          title: "Review AI ISA Call - Validation Required",
          description: validation_result.validation_summary,
          due_date: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
          priority: validation_result.confidence_score < 40 ? 'urgent' : 'high'
        })
    }

    return {
      success: true,
      validation: validation_result
    }
  } catch (error: any) {
    console.error("[v0] ISA validation failed:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Get conversation insights
 */
export async function getConversationInsights(conversationId: string, loginId: string) {
  if (!isValidUUID(conversationId) || !isValidUUID(loginId)) {
    return null
  }

  const supabase = await createClient()

  const { data: insights } = await supabase
    .from("conversation_insights")
    .select("*")
    .eq("conversation_id", conversationId)
    .single()

  return insights
}

/**
 * Get conversations requiring escalation
 */
export async function getEscalationQueue(loginId: string) {
  if (!isValidUUID(loginId)) {
    return []
  }

  const supabase = await createClient()

  const { data: insights } = await supabase
    .from("conversation_insights")
    .select(`
      *,
      conversation:conversations(
        *,
        contact:contacts(first_name, last_name, phone, email)
      )
    `)
    .in('escalation_level', ['high', 'critical'])
    .eq('requires_human_review', true)
    .order('priority_score', { ascending: false })
    .limit(50)

  return insights || []
}

/**
 * Analyze voice conversation with enriched intelligence
 */
export async function analyzeVoiceConversation(conversationId: string, loginId: string) {
  if (!isValidUUID(conversationId) || !isValidUUID(loginId)) {
    return { success: false, error: "Invalid conversation or login ID" }
  }

  const supabase = await createClient()

  try {
    // Get conversation with voice transcripts
    const { data: conversation } = await supabase
      .from("conversations")
      .select("*, voice_transcripts")
      .eq("id", conversationId)
      .single()

    if (!conversation) {
      return { success: false, error: "Conversation not found" }
    }

    // If no voice transcripts, fall back to text analysis
    if (!conversation.voice_transcripts) {
      return analyzeConversation(conversationId, loginId)
    }

    // Parse voice transcripts
    const voice_transcripts: VoiceTranscript[] = conversation.voice_transcripts as any

    // Analyze voice conversation
    const voice_analysis = analyzeVoiceConversation(voice_transcripts)

    // Store voice-enriched insights
    await supabase
      .from("conversation_insights")
      .update({
        insights_metadata: supabase.raw(`
          jsonb_set(
            COALESCE(insights_metadata, '{}'::jsonb),
            '{voice_analysis}',
            ?::jsonb
          )
        `, [JSON.stringify(voice_analysis)])
      })
      .eq("conversation_id", conversationId)

    return {
      success: true,
      voice_analysis
    }
  } catch (error: any) {
    console.error("[v0] Voice conversation analysis failed:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Real-time conversation monitoring (called periodically or on message send)
 */
export async function monitorConversationRealtime(conversationId: string, loginId: string) {
  if (!isValidUUID(conversationId) || !isValidUUID(loginId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Analyze conversation
    const result = await analyzeConversation(conversationId, loginId)

    if (!result.success || !result.insights) {
      return result
    }

    const { escalation_signal, health_score } = result.insights

    // Check if immediate action needed
    if (escalation_signal.level === 'critical' || health_score.status === 'critical') {
      // Create urgent notification
      await supabase
        .from("notifications")
        .insert({
          recipient_id: loginId,
          notification_type: "conversation_escalation",
          title: "Critical Conversation Alert",
          message: `Conversation requires immediate attention: ${escalation_signal.recommended_action}`,
          priority: "urgent",
          metadata: {
            conversation_id: conversationId,
            escalation_level: escalation_signal.level,
            health_status: health_score.status
          }
        })

      // Create escalation task
      const { data: conversation } = await supabase
        .from("conversations")
        .select("contact_id")
        .eq("id", conversationId)
        .single()

      if (conversation) {
        await supabase
          .from("tasks")
          .insert({
            assigned_to: loginId,
            contact_id: conversation.contact_id,
            title: "Urgent: Conversation Escalation",
            description: escalation_signal.recommended_action,
            due_date: new Date(Date.now() + escalation_signal.metadata.time_to_escalate_minutes * 60 * 1000).toISOString(),
            priority: "urgent"
          })
      }
    }

    return {
      success: true,
      alerts: {
        is_critical: escalation_signal.level === 'critical' || health_score.status === 'critical',
        escalation_level: escalation_signal.level,
        health_status: health_score.status,
        recommended_action: escalation_signal.recommended_action
      }
    }
  } catch (error: any) {
    console.error("[v0] Real-time monitoring failed:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Batch analyze multiple conversations
 */
export async function batchAnalyzeConversations(conversationIds: string[], loginId: string) {
  if (!isValidUUID(loginId)) {
    return { success: false, error: "Invalid login ID" }
  }

  const results = []
  for (const conversationId of conversationIds) {
    if (isValidUUID(conversationId)) {
      const result = await analyzeConversation(conversationId, loginId)
      results.push({ conversationId, result })
    }
  }

  return {
    success: true,
    results,
    analyzed_count: results.filter(r => r.result.success).length,
    failed_count: results.filter(r => !r.result.success).length
  }
}
