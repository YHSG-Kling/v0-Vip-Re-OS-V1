// ROUTED, was raw — see lib/ai/models.ts:conversation_insight_extraction. The
// key is pinned to claude-sonnet, the model this call site already passed, so
// only the ledger changes.
import { generateObjectRouted } from '@/lib/ai/models'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'

export interface ContactMemory {
  contactId: string
  recentTopics: string[]
  objections: string[]
  buyingSignals: string[]
  painPoints: string[]
  unresolvedQuestions: string[]
  overallSentiment: string
  lastConversationSummary: string
}

interface ConversationInsight {
  id: string
  conversation_id: string
  contact_id: string
  agent_id: string
  key_topics: string[] | null
  pain_points: string[] | null
  objections_raised: string[] | null
  buying_signals: string[] | null
  unresolved_questions: string[] | null
  context_summary: string | null
  overall_sentiment: string | null
  last_updated_at: string | null
}

/**
 * Retrieves aggregated memory for a contact based on recent conversation insights
 *
 * ── `brokerageId` WAS ACCEPTED AND NEVER READ ───────────────────────────────
 *
 * The tenant is resolved from the SESSION by the only live caller
 * (app/actions/ai-auto-response.ts:122 `getAgentContext()`, through
 * buildContextWindow) and was then dropped on the floor here, while the read
 * runs on `createServiceClient()` — RLS bypassed. So the only thing standing
 * between one brokerage's contact memory and another's was the caller happening
 * to pass a contactId/agentId pair it owned: the IDOR shape §4 names, on a
 * table that carries verbatim client objections, pain points and buying
 * signals.
 *
 * `conversation_insights.brokerage_id` is a live column (scripts/schema-snapshot.ts:254),
 * and `updateConversationMemory` below already STAMPS it on every insert, so the
 * predicate matches rows this writer produces. The gate is now the tenant, not
 * the caller's good manners.
 */
export async function getContactMemory(
  contactId: string,
  agentId: string,
  brokerageId: string
): Promise<ContactMemory> {
  const supabase = createServiceClient()

  // Query conversation_insights for this contact, most recent first
  const { data: insights, error } = await supabase
    .from('conversation_insights')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .eq('contact_id', contactId)
    .eq('agent_id', agentId)
    .order('last_updated_at', { ascending: false, nullsFirst: false })
    .limit(8)

  if (error) {
    console.error('Error fetching contact memory:', error.message)
    return {
      contactId,
      recentTopics: [],
      objections: [],
      buyingSignals: [],
      painPoints: [],
      unresolvedQuestions: [],
      overallSentiment: 'neutral',
      lastConversationSummary: '',
    }
  }

  const typedInsights = (insights || []) as ConversationInsight[]

  // Aggregate across all insights
  const topicsFrequency = new Map<string, number>()
  const objectionsSet = new Set<string>()
  const signalsSet = new Set<string>()
  const painPointsSet = new Set<string>()

  for (const insight of typedInsights) {
    // Count topic frequency
    for (const topic of insight.key_topics || []) {
      topicsFrequency.set(topic, (topicsFrequency.get(topic) || 0) + 1)
    }
    // Collect unique objections
    for (const obj of insight.objections_raised || []) {
      objectionsSet.add(obj)
    }
    // Collect unique signals
    for (const sig of insight.buying_signals || []) {
      signalsSet.add(sig)
    }
    // Collect unique pain points
    for (const pp of insight.pain_points || []) {
      painPointsSet.add(pp)
    }
  }

  // Sort topics by frequency and take top 10
  const recentTopics = Array.from(topicsFrequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic]) => topic)

  // Most recent insight for unresolved questions, sentiment, and summary
  const mostRecent = typedInsights[0]

  return {
    contactId,
    recentTopics,
    objections: Array.from(objectionsSet).slice(0, 5),
    buyingSignals: Array.from(signalsSet).slice(0, 5),
    painPoints: Array.from(painPointsSet).slice(0, 5),
    unresolvedQuestions: mostRecent?.unresolved_questions || [],
    overallSentiment: mostRecent?.overall_sentiment || 'neutral',
    lastConversationSummary: mostRecent?.context_summary || '',
  }
}

/**
 * Builds a compact context window string (~400 tokens) for injection into AI prompts
 */
export async function buildContextWindow(
  contactId: string,
  agentId: string,
  brokerageId: string
): Promise<string> {
  const memory = await getContactMemory(contactId, agentId, brokerageId)

  // Format as compact context string
  const parts: string[] = [`Contact Memory for ${contactId}:`]

  if (memory.recentTopics.length > 0) {
    parts.push(`Recent Topics: ${memory.recentTopics.join(', ')}`)
  }

  if (memory.objections.length > 0) {
    parts.push(`Known Objections: ${memory.objections.join('; ')}`)
  }

  if (memory.buyingSignals.length > 0) {
    parts.push(`Buying Signals: ${memory.buyingSignals.join('; ')}`)
  }

  if (memory.painPoints.length > 0) {
    parts.push(`Pain Points: ${memory.painPoints.join('; ')}`)
  }

  if (memory.unresolvedQuestions.length > 0) {
    parts.push(`Open Questions: ${memory.unresolvedQuestions.join('; ')}`)
  }

  parts.push(`Sentiment: ${memory.overallSentiment}`)

  if (memory.lastConversationSummary) {
    // Truncate summary to ~150 words to stay within token budget
    const truncatedSummary = memory.lastConversationSummary
      .split(' ')
      .slice(0, 150)
      .join(' ')
    parts.push(`Last Summary: ${truncatedSummary}`)
  }

  return parts.join('\n')
}

// Zod schema for AI extraction
const insightSchema = z.object({
  key_topics: z.array(z.string()).describe('Main topics discussed in the conversation'),
  pain_points: z.array(z.string()).describe('Customer pain points or concerns mentioned'),
  objections_raised: z.array(z.string()).describe('Objections or hesitations expressed'),
  buying_signals: z.array(z.string()).describe('Positive signals indicating interest or intent'),
  unresolved_questions: z.array(z.string()).describe('Questions that remain unanswered'),
  context_summary: z.string().describe('Brief summary of conversation context and key takeaways'),
  overall_sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']).describe('Overall sentiment of the contact'),
})

// ─────────────────────────────────────────────────────────────────────────────
// DERIVED CONVERSATION ANALYTICS — the columns the communications-intelligence
// dashboard reads (app/dashboard/communications/intelligence/page.tsx), the
// AI-quality panel counts (app/dashboard/system/components/os/ai-quality-panel.tsx
// requires_human_review) and the buyer-search intent merge consumes
// (app/actions/buyer-property-search.ts escalation_urgency / health_score).
//
// Before this, every one of these columns was READ BY CODE AND WRITTEN BY
// NOBODY (opposite-missing census, category 1b) — the health/KPI tabs rendered
// empty forever because updateConversationMemory below wrote only the memory
// columns. Everything here is DERIVED from facts this writer already holds:
// the message timestamps it loaded, the extraction it just ran, and the
// previous row's stored sentiment. Nothing is fabricated: a metric whose
// input is absent stays null.
//
// The voice-only siblings (voice_quality_score / interruption_count /
// silence_duration_seconds / call_completion_status / is_voice_conversation=true)
// are DELIBERATELY not derived here — this writer analyzes a text/message
// thread, so it stamps is_voice_conversation=false and leaves the voice
// metrics NULL. There is currently no honest source for them anywhere: the
// voice pipeline stores a flat transcript with no per-utterance timestamps
// (call_transcriptions.speaker_turns is written as [] —
// app/actions/ai-voice-transcription.ts:545), so silence/interruption/quality
// cannot be computed without inventing numbers.
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of a messages row the derivation needs, in CHRONOLOGICAL order. */
export interface AnalyticsMessage {
  sender_type: string | null
  created_at: string
}

export interface DerivedConversationAnalytics {
  /** overall_sentiment as the DATABASE accepts it. The live CHECK admits only
   *  positive/neutral/negative (verified against hrvaqgvukzxfskkcrwbt,
   *  conversation_insights_overall_sentiment_check) — the model may honestly
   *  judge 'mixed', and before this mapping a 'mixed' verdict was REFUSED
   *  ENTIRELY (23514: not "most of the row" — nothing, the §3 trap), so every
   *  mixed-sentiment conversation silently kept its stale memory. 'mixed'
   *  lands as neutral here and is preserved verbatim in sentiment_trajectory,
   *  whose CHECK does admit it. */
  dbSentiment: 'positive' | 'neutral' | 'negative'
  sentimentTrajectory: 'improving' | 'declining' | 'stable' | 'mixed'
  responseTimeAvgSeconds: number | null
  unansweredQuestionsCount: number
  /** 0..1 — the scale every reader assumes (KPIBar/HealthTab multiply by 100),
   *  enforced by the live CHECK health_score >= 0 AND <= 1. */
  healthScore: number
  escalationRecommended: boolean
  escalationUrgency: 'low' | 'medium' | 'high' | 'critical' | null
  requiresHumanReview: boolean
}

/** Message senders that are the AGENT side of the thread; everything else
 *  (contact, client, lead, vendor, unknown) is the contact side. */
const AGENT_SIDE = new Set(['agent', 'ai_assistant', 'system'])

const SENTIMENT_RANK: Record<string, number> = { negative: -1, neutral: 0, positive: 1 }

/**
 * PURE derivation — exported so a simulator can drive it without a database.
 *
 * @param messages       chronological thread slice (what updateConversationMemory loaded)
 * @param extraction     the AI extraction that just ran
 * @param previousSentiment  overall_sentiment stored on the existing insight row, if any
 */
export function deriveConversationAnalytics(
  messages: AnalyticsMessage[],
  extraction: {
    objections_raised: string[]
    buying_signals: string[]
    unresolved_questions: string[]
    overall_sentiment: 'positive' | 'neutral' | 'negative' | 'mixed'
  },
  previousSentiment: string | null,
): DerivedConversationAnalytics {
  const raw = extraction.overall_sentiment
  const dbSentiment: DerivedConversationAnalytics['dbSentiment'] =
    raw === 'mixed' ? 'neutral' : raw

  // ── Trajectory: this reading vs the previous stored reading ───────────────
  let sentimentTrajectory: DerivedConversationAnalytics['sentimentTrajectory']
  if (raw === 'mixed') {
    sentimentTrajectory = 'mixed'
  } else if (previousSentiment == null || !(previousSentiment in SENTIMENT_RANK)) {
    sentimentTrajectory = 'stable' // first reading — no history to compare against
  } else {
    const delta = SENTIMENT_RANK[dbSentiment] - SENTIMENT_RANK[previousSentiment]
    sentimentTrajectory = delta > 0 ? 'improving' : delta < 0 ? 'declining' : 'stable'
  }

  // ── Average reply gap: contact-side message → next agent-side message ─────
  // Measured at each contact→agent transition in the chronological thread. A
  // thread with no such transition has no measurement, so the metric stays
  // null rather than pretending 0 seconds.
  const gaps: number[] = []
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]
    const cur = messages[i]
    const prevIsContact = !AGENT_SIDE.has(prev.sender_type ?? '')
    const curIsAgent = AGENT_SIDE.has(cur.sender_type ?? '')
    if (!prevIsContact || !curIsAgent) continue
    const seconds = (new Date(cur.created_at).getTime() - new Date(prev.created_at).getTime()) / 1000
    if (Number.isFinite(seconds) && seconds >= 0) gaps.push(seconds)
  }
  const responseTimeAvgSeconds =
    gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null

  const unansweredQuestionsCount = extraction.unresolved_questions.length
  const objections = extraction.objections_raised.length
  const signals = extraction.buying_signals.length

  // ── Health score, 0..1 — a documented composite of the facts above ────────
  const SENTIMENT_BASE: Record<string, number> = { positive: 0.8, neutral: 0.55, mixed: 0.45, negative: 0.3 }
  let score = SENTIMENT_BASE[raw]
  score += Math.min(signals, 3) * 0.05          // interest raises health
  score -= Math.min(objections, 3) * 0.05       // friction lowers it
  score -= Math.min(unansweredQuestionsCount, 4) * 0.03 // dropped questions lower it
  if (responseTimeAvgSeconds != null) {
    if (responseTimeAvgSeconds <= 900) score += 0.05        // replies within 15 min
    else if (responseTimeAvgSeconds >= 14_400) score -= 0.05 // replies slower than 4 h
  }
  const healthScore = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100

  // ── Escalation: how many independent warning signs are lit ────────────────
  const warningSigns = [
    dbSentiment === 'negative',
    sentimentTrajectory === 'declining',
    objections >= 2,
    unansweredQuestionsCount >= 3,
  ].filter(Boolean).length

  const escalationRecommended = warningSigns >= 2
  const escalationUrgency: DerivedConversationAnalytics['escalationUrgency'] =
    !escalationRecommended ? null
    : warningSigns >= 4 ? 'critical'
    : warningSigns === 3 ? 'high'
    : 'medium'
  // The human-review queue (ai-quality-panel's "review pressure" count) takes
  // only the conversations where two-signal caution has hardened into a
  // high/critical escalation — a medium escalation stays with the AI loop.
  const requiresHumanReview = escalationUrgency === 'high' || escalationUrgency === 'critical'

  return {
    dbSentiment,
    sentimentTrajectory,
    responseTimeAvgSeconds,
    unansweredQuestionsCount,
    healthScore,
    escalationRecommended,
    escalationUrgency,
    requiresHumanReview,
  }
}

/**
 * Updates conversation memory by extracting insights from recent messages using AI
 */
export async function updateConversationMemory(
  conversationId: string,
  brokerageId: string
): Promise<void> {
  const supabase = createServiceClient()

  // Step 1: Load last 20 messages for this conversation
  const { data: messages, error: msgError } = await supabase
    .from('messages')
    .select('id, body, sender_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(20)

  if (msgError) {
    throw new Error(`Failed to load messages: ${msgError.message}`)
  }

  if (!messages || messages.length === 0) {
    return // No messages to analyze
  }

  // Get conversation details for contact_id and agent_id
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id, contact_id, agent_id')
    .eq('id', conversationId)
    .single()

  if (convError || !conversation) {
    throw new Error(`Failed to load conversation: ${convError?.message}`)
  }

  // Format messages for AI analysis (reverse to chronological order)
  const formattedMessages = messages
    .reverse()
    .map((m) => `[${m.sender_type}]: ${m.body}`)
    .join('\n')

  // Step 2: Check for existing insight record. overall_sentiment rides along so
  // sentiment_trajectory can compare this reading against the last one.
  const { data: existingInsight } = await supabase
    .from('conversation_insights')
    .select('id, overall_sentiment')
    .eq('conversation_id', conversationId)
    .maybeSingle()

  // Step 3: Call Claude to extract structured insights
  const { object: insights } = await generateObjectRouted({
    feature: 'conversation_insight_extraction',
    brokerageId,
    schema: insightSchema,
    system: `You are an expert conversation analyst. Extract structured insights from the following conversation between an agent and a contact. Focus on identifying key information that would help the agent in future interactions. Be concise but thorough. Return valid JSON only.`,
    prompt: `Analyze this conversation and extract insights:\n\n${formattedMessages}`,
    maxTokens: 500,
  })

  // Estimate token count for context window tracking
  const estimatedTokens = Math.ceil(formattedMessages.length / 4)

  // Step 3b: derive the analytics columns the intelligence dashboard, the
  // AI-quality panel and the buyer-search intent merge read. `messages` is
  // chronological here — the .reverse() above mutated it in place.
  const analytics = deriveConversationAnalytics(
    messages as AnalyticsMessage[],
    insights,
    (existingInsight as { overall_sentiment?: string | null } | null)?.overall_sentiment ?? null,
  )

  const nowIso = new Date().toISOString()

  // Step 4: UPSERT conversation_insights. Both branches name every column
  // LITERALLY (no shared spread) so a static scan can attribute each write.
  if (existingInsight) {
    const { error: updateError } = await supabase
      .from('conversation_insights')
      .update({
        key_topics: insights.key_topics,
        pain_points: insights.pain_points,
        objections_raised: insights.objections_raised,
        buying_signals: insights.buying_signals,
        unresolved_questions: insights.unresolved_questions,
        context_summary: insights.context_summary,
        // The DB-safe value — the live CHECK refuses 'mixed' (see deriveConversationAnalytics).
        overall_sentiment: analytics.dbSentiment,
        sentiment_trajectory: analytics.sentimentTrajectory,
        health_score: analytics.healthScore,
        response_time_avg_seconds: analytics.responseTimeAvgSeconds,
        unanswered_questions_count: analytics.unansweredQuestionsCount,
        escalation_recommended: analytics.escalationRecommended,
        escalation_urgency: analytics.escalationUrgency,
        requires_human_review: analytics.requiresHumanReview,
        // This writer analyzes a TEXT thread. The voice metrics have no honest
        // source yet (no per-utterance timestamps anywhere) and stay NULL.
        is_voice_conversation: false,
        last_updated_at: nowIso,
        // Readers filter and order on updated_at (the dashboard's 7/30-day
        // windows); the DB default only fires on INSERT, so the update path
        // must stamp it.
        updated_at: nowIso,
      })
      .eq('id', existingInsight.id)

    if (updateError) {
      throw new Error(`Failed to update insights: ${updateError.message}`)
    }
  } else {
    const { error: insertError } = await supabase
      .from('conversation_insights')
      .insert({
        conversation_id: conversationId,
        contact_id: conversation.contact_id,
        agent_id: conversation.agent_id,
        brokerage_id: brokerageId,
        key_topics: insights.key_topics,
        pain_points: insights.pain_points,
        objections_raised: insights.objections_raised,
        buying_signals: insights.buying_signals,
        unresolved_questions: insights.unresolved_questions,
        context_summary: insights.context_summary,
        overall_sentiment: analytics.dbSentiment,
        sentiment_trajectory: analytics.sentimentTrajectory,
        health_score: analytics.healthScore,
        response_time_avg_seconds: analytics.responseTimeAvgSeconds,
        unanswered_questions_count: analytics.unansweredQuestionsCount,
        escalation_recommended: analytics.escalationRecommended,
        escalation_urgency: analytics.escalationUrgency,
        requires_human_review: analytics.requiresHumanReview,
        is_voice_conversation: false,
        last_updated_at: nowIso,
      })

    if (insertError) {
      throw new Error(`Failed to insert insights: ${insertError.message}`)
    }
  }

  // Step 5: Update conversations table with summary and token count
  await supabase
    .from('conversations')
    .update({
      last_ai_context_summary: insights.context_summary,
      context_window_tokens: estimatedTokens,
    })
    .eq('id', conversationId)

  // Step 6: Log kernel event
  await supabase.from('lifecycle_events').insert({
    event_type: KernelEvent.MEMORY_CONTEXT_UPDATED,
    agent_id: conversation.agent_id,
    brokerage_id: brokerageId,
    entity_type: 'conversation',
    entity_id: conversationId,
    payload: {
      contact_id: conversation.contact_id,
      topics_count: insights.key_topics.length,
      sentiment: insights.overall_sentiment,
    },
    created_at: new Date().toISOString(),
  })
}
