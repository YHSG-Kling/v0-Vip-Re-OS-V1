import { generateObject } from 'ai'
import { resolveModel } from '@/lib/ai/resolve-model'
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
    .select('id, content, sender_type, created_at')
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
    .map((m) => `[${m.sender_type}]: ${m.content}`)
    .join('\n')

  // Step 2: Check for existing insight record
  const { data: existingInsight } = await supabase
    .from('conversation_insights')
    .select('id')
    .eq('conversation_id', conversationId)
    .maybeSingle()

  // Step 3: Call Claude to extract structured insights
  const { object: insights } = await generateObject({
    model: resolveModel('anthropic/claude-sonnet-4-20250514'),
    schema: insightSchema,
    system: `You are an expert conversation analyst. Extract structured insights from the following conversation between an agent and a contact. Focus on identifying key information that would help the agent in future interactions. Be concise but thorough. Return valid JSON only.`,
    prompt: `Analyze this conversation and extract insights:\n\n${formattedMessages}`,
    maxOutputTokens: 500,
  })

  // Estimate token count for context window tracking
  const estimatedTokens = Math.ceil(formattedMessages.length / 4)

  // Step 4: UPSERT conversation_insights
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
        overall_sentiment: insights.overall_sentiment,
        last_updated_at: new Date().toISOString(),
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
        overall_sentiment: insights.overall_sentiment,
        last_updated_at: new Date().toISOString(),
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
