"use server"

import { createClient } from "@/lib/supabase/server"

// =====================================================
// CONVERSATION ANALYTICS & SENTIMENT TRACKING
// =====================================================

export async function logConversationMetadata(params: {
  contactId: string
  agentId?: string
  conversationHistory: Array<{
    role: string
    content: string
    timestamp: string
    confidence?: number
  }>
  channel?: string
  conversationType?: string
}) {
  try {
    const supabase = await createClient()

    if (!params.conversationHistory || params.conversationHistory.length === 0) {
      return { success: false, error: "No conversation history provided" }
    }

    // Calculate duration
    const startTime = new Date(params.conversationHistory[0].timestamp)
    const endTime = new Date(params.conversationHistory[params.conversationHistory.length - 1].timestamp)
    const durationMin = Math.floor((endTime.getTime() - startTime.getTime()) / 60000)

    // Calculate average AI confidence
    const confidenceScores = params.conversationHistory
      .filter((msg) => msg.confidence !== undefined)
      .map((msg) => msg.confidence as number)
    const avgConfidence =
      confidenceScores.length > 0
        ? confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length
        : null

    // AI analyzes conversation for sentiment and topics
    const analysis = await analyzeConversationSentiment(params.conversationHistory)

    // Save conversation log
    const { data: log, error } = await supabase
      .from("conversation_logs")
      .insert({
        contact_id: params.contactId,
        agent_id: params.agentId,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        message_count: params.conversationHistory.length,
        duration_minutes: durationMin,
        ai_confidence_avg: avgConfidence,
        sentiment_start: analysis.sentiment_start,
        sentiment_end: analysis.sentiment_end,
        sentiment_journey: determineSentimentJourney(analysis.sentiment_start, analysis.sentiment_end),
        topics_discussed: analysis.topics,
        key_insights: analysis.insights,
        channel: params.channel || "ai_assistant",
        conversation_type: params.conversationType || "general_inquiry",
      })
      .select()
      .single()

    if (error) {
      console.error("[conversation-analytics] Failed to log conversation:", error)
      return { success: false, error: error.message }
    }

    // Run compliance checks
    const complianceFlags = await checkConversationCompliance(log.id, params.conversationHistory)

    if (complianceFlags.length > 0) {
      await supabase.from("conversation_audit_flags").insert(
        complianceFlags.map((flag) => ({
          conversation_id: log.id,
          risk_type: flag.type,
          risk_score: flag.score,
          explanation: flag.explanation,
          flagged_text: flag.text,
          recommended_action: flag.recommendation,
        }))
      )
    }

    return {
      success: true,
      log_id: log.id,
      sentiment_journey: log.sentiment_journey,
      compliance_flags: complianceFlags.length,
    }
  } catch (error: any) {
    console.error("[conversation-analytics] Error:", error)
    return { success: false, error: error.message }
  }
}

// =====================================================
// AI SENTIMENT ANALYSIS
// =====================================================

async function analyzeConversationSentiment(conversationHistory: Array<{ role: string; content: string }>) {
  try {
    // Extract first 3 and last 3 messages for sentiment analysis
    const startMessages = conversationHistory.slice(0, 3).map((m) => m.content)
    const endMessages = conversationHistory.slice(-3).map((m) => m.content)

    // Analyze sentiment using AI
    const startSentiment = await analyzeSentiment(startMessages.join(" "))
    const endSentiment = await analyzeSentiment(endMessages.join(" "))

    // Extract topics from conversation
    const fullText = conversationHistory.map((m) => m.content).join(" ")
    const topics = await extractTopics(fullText)

    // Generate key insights
    const insights = await generateInsights(conversationHistory)

    return {
      sentiment_start: startSentiment,
      sentiment_end: endSentiment,
      topics: topics,
      insights: insights,
    }
  } catch (error) {
    console.error("[conversation-analytics] Sentiment analysis failed:", error)
    return {
      sentiment_start: "neutral",
      sentiment_end: "neutral",
      topics: [],
      insights: "Analysis unavailable",
    }
  }
}

async function analyzeSentiment(text: string): Promise<"positive" | "neutral" | "negative"> {
  // Simple sentiment analysis using keyword matching
  // In production, use OpenAI or specialized sentiment API
  const lowerText = text.toLowerCase()

  const positiveKeywords = [
    "great",
    "excellent",
    "love",
    "perfect",
    "amazing",
    "wonderful",
    "excited",
    "interested",
    "yes",
    "definitely",
  ]
  const negativeKeywords = [
    "no",
    "not interested",
    "concerned",
    "worried",
    "problem",
    "issue",
    "disappointed",
    "frustrated",
  ]

  const positiveCount = positiveKeywords.filter((kw) => lowerText.includes(kw)).length
  const negativeCount = negativeKeywords.filter((kw) => lowerText.includes(kw)).length

  if (positiveCount > negativeCount + 1) return "positive"
  if (negativeCount > positiveCount + 1) return "negative"
  return "neutral"
}

async function extractTopics(text: string): Promise<string[]> {
  const topics: string[] = []
  const lowerText = text.toLowerCase()

  // Topic detection using keywords
  const topicMap = {
    pricing: ["price", "cost", "budget", "afford", "expensive", "payment"],
    schools: ["school", "education", "district", "elementary", "kindergarten"],
    timeline: ["when", "timeline", "soon", "urgent", "closing", "move"],
    location: ["neighborhood", "area", "location", "commute", "near"],
    features: ["bedroom", "bathroom", "garage", "yard", "pool", "kitchen"],
    financing: ["mortgage", "loan", "pre-approval", "lender", "interest rate"],
    inspection: ["inspection", "repair", "condition", "maintenance"],
  }

  for (const [topic, keywords] of Object.entries(topicMap)) {
    if (keywords.some((kw) => lowerText.includes(kw))) {
      topics.push(topic)
    }
  }

  return topics
}

async function generateInsights(conversationHistory: Array<{ role: string; content: string }>): Promise<string> {
  const messageCount = conversationHistory.length
  const userMessages = conversationHistory.filter((m) => m.role === "user")
  const avgLength = userMessages.reduce((sum, m) => sum + m.content.length, 0) / userMessages.length

  let insights = `${messageCount} messages exchanged. `

  if (avgLength > 200) {
    insights += "Client provided detailed responses. "
  } else if (avgLength < 50) {
    insights += "Client responses were brief. "
  }

  return insights
}

function determineSentimentJourney(
  start: string,
  end: string
): "improved" | "declined" | "stable" {
  const scoreMap = { negative: 1, neutral: 2, positive: 3 }
  const startScore = scoreMap[start as keyof typeof scoreMap] || 2
  const endScore = scoreMap[end as keyof typeof scoreMap] || 2

  if (endScore > startScore) return "improved"
  if (endScore < startScore) return "declined"
  return "stable"
}

// =====================================================
// COMPLIANCE CHECKING
// =====================================================

async function checkConversationCompliance(
  conversationId: string,
  conversationHistory: Array<{ role: string; content: string }>
): Promise<
  Array<{
    type: string
    score: number
    explanation: string
    text: string
    recommendation: string
  }>
> {
  const flags: Array<{
    type: string
    score: number
    explanation: string
    text: string
    recommendation: string
  }> = []

  const fullText = conversationHistory.map((m) => m.content).join(" ").toLowerCase()

  // Fair Housing violations
  const fairHousingKeywords = [
    "family status",
    "kids",
    "children",
    "religion",
    "church",
    "disability",
    "handicap",
    "race",
    "ethnicity",
    "national origin",
    "age",
    "senior",
  ]

  for (const keyword of fairHousingKeywords) {
    if (fullText.includes(keyword)) {
      flags.push({
        type: "fair_housing",
        score: 7,
        explanation: `Potential fair housing concern: Mentioned "${keyword}"`,
        text: keyword,
        recommendation: "Review conversation for protected class discussion. Ensure compliance with Fair Housing Act.",
      })
    }
  }

  // Data leak detection
  if (fullText.match(/\b\d{3}-\d{2}-\d{4}\b/)) {
    flags.push({
      type: "data_leak",
      score: 9,
      explanation: "Potential SSN shared in conversation",
      text: "SSN pattern detected",
      recommendation: "Immediate review required. Ensure PII is handled securely.",
    })
  }

  // Hallucination detection (AI making false promises)
  const hallucinations = [
    "guarantee",
    "definitely will",
    "promise",
    "100% certain",
    "no risk",
    "always increases",
  ]

  for (const phrase of hallucinations) {
    if (fullText.includes(phrase)) {
      flags.push({
        type: "hallucination",
        score: 6,
        explanation: `AI may have made unverifiable claim: "${phrase}"`,
        text: phrase,
        recommendation: "Review AI response accuracy. Train model to avoid absolute statements.",
      })
    }
  }

  return flags
}

// =====================================================
// WEEKLY AI COMPLIANCE AUDIT
// =====================================================

export async function runWeeklyAIAudit() {
  try {
    const supabase = await createClient()

    // Get last week's conversations
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: conversations, error } = await supabase
      .from("conversation_logs")
      .select("id, contact_id, agent_id, created_at")
      .gte("created_at", weekAgo)
      .order("created_at", { ascending: false })

    if (error) {
      console.error("[conversation-analytics] Failed to fetch conversations:", error)
      return { success: false, error: error.message }
    }

    let flaggedCount = 0

    // Re-analyze each conversation for compliance
    for (const conv of conversations || []) {
      // Get conversation messages from communications table
      const { data: messages } = await supabase
        .from("messages")
        .select("message, created_at, direction")
        .eq("contact_id", conv.contact_id)
        .gte("created_at", weekAgo)
        .order("created_at", { ascending: true })

      if (!messages || messages.length === 0) continue

      // Convert to conversation format
      const conversationHistory = messages.map((msg) => ({
        role: msg.direction === "outbound" ? "assistant" : "user",
        content: msg.message || "",
        timestamp: msg.created_at,
      }))

      // Run compliance check
      const flags = await checkConversationCompliance(conv.id, conversationHistory)

      if (flags.length > 0) {
        flaggedCount += flags.length

        // Insert new flags
        await supabase.from("conversation_audit_flags").insert(
          flags.map((flag) => ({
            conversation_id: conv.id,
            risk_type: flag.type,
            risk_score: flag.score,
            explanation: flag.explanation,
            flagged_text: flag.text,
            recommended_action: flag.recommendation,
          }))
        )
      }
    }

    return {
      success: true,
      conversations_audited: conversations?.length || 0,
      flags_created: flaggedCount,
    }
  } catch (error: any) {
    console.error("[conversation-analytics] Weekly audit failed:", error)
    return { success: false, error: error.message }
  }
}

// =====================================================
// GET CONVERSATION ANALYTICS
// =====================================================

export async function getConversationAnalytics(params: {
  agentId?: string
  contactId?: string
  startDate?: string
  endDate?: string
}) {
  try {
    const supabase = await createClient()

    let query = supabase.from("conversation_logs").select("*")

    if (params.agentId) query = query.eq("agent_id", params.agentId)
    if (params.contactId) query = query.eq("contact_id", params.contactId)
    if (params.startDate) query = query.gte("created_at", params.startDate)
    if (params.endDate) query = query.lte("created_at", params.endDate)

    const { data, error } = await query.order("created_at", { ascending: false })

    if (error) {
      console.error("[conversation-analytics] Failed to fetch analytics:", error)
      return { success: false, error: error.message }
    }

    // Calculate aggregates
    const totalConversations = data?.length || 0
    const avgDuration =
      data && data.length > 0
        ? data.reduce((sum, c) => sum + (c.duration_minutes || 0), 0) / data.length
        : 0
    const sentimentBreakdown = {
      improved: data?.filter((c) => c.sentiment_journey === "improved").length || 0,
      declined: data?.filter((c) => c.sentiment_journey === "declined").length || 0,
      stable: data?.filter((c) => c.sentiment_journey === "stable").length || 0,
    }

    return {
      success: true,
      conversations: data,
      analytics: {
        total_conversations: totalConversations,
        avg_duration_minutes: Math.round(avgDuration * 10) / 10,
        sentiment_breakdown: sentimentBreakdown,
      },
    }
  } catch (error: any) {
    console.error("[conversation-analytics] Error fetching analytics:", error)
    return { success: false, error: error.message }
  }
}

export async function getAuditFlags(params: { status?: string; riskType?: string; limit?: number }) {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("conversation_audit_flags")
      .select(
        `
        *,
        conversation:conversation_logs(
          contact_id,
          agent_id,
          start_time,
          topics_discussed
        )
      `
      )

    if (params.status) query = query.eq("review_status", params.status)
    if (params.riskType) query = query.eq("risk_type", params.riskType)

    const { data, error } = await query
      .order("risk_score", { ascending: false })
      .limit(params.limit || 50)

    if (error) {
      console.error("[conversation-analytics] Failed to fetch audit flags:", error)
      return { success: false, error: error.message }
    }

    return {
      success: true,
      flags: data,
      total_pending: data?.filter((f) => f.review_status === "pending").length || 0,
    }
  } catch (error: any) {
    console.error("[conversation-analytics] Error fetching audit flags:", error)
    return { success: false, error: error.message }
  }
}

export async function reviewAuditFlag(params: {
  flagId: string
  reviewerId: string
  status: "reviewed" | "dismissed" | "escalated"
  resolutionNotes?: string
}) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("conversation_audit_flags")
      .update({
        review_status: params.status,
        reviewed_by: params.reviewerId,
        reviewed_at: new Date().toISOString(),
        resolution_notes: params.resolutionNotes,
      })
      .eq("id", params.flagId)
      .select()
      .single()

    if (error) {
      console.error("[conversation-analytics] Failed to review flag:", error)
      return { success: false, error: error.message }
    }

    return { success: true, flag: data }
  } catch (error: any) {
    console.error("[conversation-analytics] Error reviewing flag:", error)
    return { success: false, error: error.message }
  }
}
