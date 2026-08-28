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

    // Tenant comes from the CONTACT the conversation is with
    // (contacts.brokerage_id). params.agentId is an agents.id — a user-space
    // id, not a tenant, and the id spaces are disjoint. conversation_logs
    // holds transcript-derived sentiment, topics and insights about a client;
    // unstamped, the row is readable AND writable by every brokerage on the
    // platform, because the policy is
    // `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`.
    const { data: contactRow, error: contactErr } = await supabase
      .from("contacts")
      .select("brokerage_id")
      .eq("id", params.contactId)
      .maybeSingle()

    if (contactErr) {
      console.error("[conversation-analytics] Failed to resolve tenant from contact:", contactErr)
      return { success: false, error: contactErr.message }
    }
    if (!contactRow?.brokerage_id) {
      console.error(
        "[conversation-analytics] No tenant resolvable from contact " +
          `${params.contactId} — refusing to write a conversation log every brokerage could read and write.`,
      )
      return { success: false, error: "Could not resolve brokerage for contact" }
    }

    // Save conversation log
    const { data: log, error } = await supabase
      .from("conversation_logs")
      .insert({
        brokerage_id: contactRow.brokerage_id,
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
    const complianceFlags = await checkConversationCompliance(params.conversationHistory)

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

/**
 * Pure text scan over one conversation's messages. No id, by design.
 *
 * TOMBSTONE — the `conversationId` parameter is deleted. It was accepted by
 * both call sites and read by neither: the identity is applied by the CALLERS,
 * which stamp `conversation_id` onto every `conversation_audit_flags` row they
 * insert from these flags (this file, in `analyzeConversation` and in
 * `runWeeklyAIAudit`). Threading the id through a function that only reads text
 * gave a second, silent place for the two to disagree about which conversation
 * a flag belongs to.
 */
async function checkConversationCompliance(
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
        .select("body, created_at, direction")
        .eq("contact_id", conv.contact_id)
        .gte("created_at", weekAgo)
        .order("created_at", { ascending: true })

      if (!messages || messages.length === 0) continue

      // Convert to conversation format
      const conversationHistory = messages.map((msg) => ({
        role: msg.direction === "outbound" ? "assistant" : "user",
        content: msg.body || "",
        timestamp: msg.created_at,
      }))

      // Run compliance check
      const flags = await checkConversationCompliance(conversationHistory)

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

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `getConversationAnalytics`
// deleted. SURVIVOR: the Communication Intelligence dashboard's server-side
// aggregation at app/dashboard/communications/intelligence/page.tsx (KPI +
// chart + per-agent rollups over conversation_insights, tenant-pinned to the
// session's brokerage). This twin aggregated the same subject (conversation
// health/sentiment) from conversation_logs with caller-supplied agent filters
// and no tenant anchor of its own, and a stripped-source census found zero
// callers outside the the actions barrel (app/actions/index, deleted this wave) barrel, which itself has zero
// importers. Nothing was merged: the survivor's conversation_insights rollup
// is the richer read of the same capability.

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `getAuditFlags` deleted.
// SURVIVOR: the direct conversation_audit_flags read (same
// `conversation:conversation_logs(...)` embed, same risk_score ordering) at
// app/dashboard/communications/intelligence/page.tsx:115-135, rendered by
// AuditFlagsTab/ComplianceTab, where reviewAuditFlag (below) closes the loop.
// A stripped-source census found zero callers outside the
// the actions barrel (app/actions/index, deleted this wave) barrel, which itself has zero importers.

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
