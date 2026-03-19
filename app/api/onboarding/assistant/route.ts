import { streamText, convertToModelMessages, type Message } from 'ai'
import { createClient } from '@/lib/supabase/server'
import { KernelEvent } from '@/lib/kernel/events'
import { searchKB } from '@/lib/intelligence/kb-search'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { messages, brokerageId, agentId } = body as {
      messages: Message[]
      brokerageId: string
      agentId: string
    }

    const supabase = await createClient()

    // Extract the user's latest query for KB search
    const userMessages = messages.filter((m) => m.role === 'user')
    const latestQuery = userMessages.length > 0
      ? String(userMessages[userMessages.length - 1].content)
      : ''

    // Knowledge base search using vector similarity (L12-P03 upgrade)
    const kbResults = await searchKB(latestQuery, brokerageId, 5)
    const uniqueResults = kbResults

    // Build context string from KB results (max 2000 chars)
    let kbContext = ''
    for (const topic of uniqueResults) {
      const entry = `## ${topic.title}\n${topic.content}\n\n`
      if ((kbContext + entry).length <= 2000) {
        kbContext += entry
      } else {
        break
      }
    }

    // Fire SETUP_ASSISTANT_QUERY_MADE kernel event
    await supabase.from('lifecycle_events').insert({
      brokerage_id: brokerageId,
      entity_type: 'agent',
      entity_id: agentId,
      event_type: KernelEvent.SETUP_ASSISTANT_QUERY_MADE,
      actor_user_id: agentId,
      metadata: {
        query: latestQuery,
        kb_results_count: uniqueResults.length,
        timestamp: new Date().toISOString(),
      },
    })

    // Build system prompt
    const systemPrompt = `You are a helpful setup assistant for a real estate platform called VIP Real Estate OS. Answer questions about platform setup, onboarding, and features. Use the provided knowledge base context. If you don't know, say so and escalate. Keep answers under 150 words.

Context:
${kbContext || 'No specific documentation found for this query.'}`

    // Stream response using anthropic/claude-sonnet-4-20250514
    const result = streamText({
      model: 'anthropic/claude-sonnet-4-20250514',
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
      temperature: 0.7,
      maxTokens: 500,
      onFinish: async ({ text: aiResponse }) => {
        // aiResponse is the final streamed text

        // INSERT onboarding_ai_chats
        await supabase.from('onboarding_ai_chats').insert({
          brokerage_id: brokerageId,
          agent_id: agentId,
          question: latestQuery,
          ai_response: aiResponse,
        })

        // Check if escalation needed
        const noKBResults = uniqueResults.length === 0
        const uncertainResponse =
          aiResponse.toLowerCase().includes("i don't know") ||
          aiResponse.toLowerCase().includes("i'm not sure") ||
          aiResponse.toLowerCase().includes('not certain')

        if (noKBResults || uncertainResponse) {
          // Fire SETUP_ASSISTANT_ESCALATED kernel event
          await supabase.from('lifecycle_events').insert({
            brokerage_id: brokerageId,
            entity_type: 'agent',
            entity_id: agentId,
            event_type: KernelEvent.SETUP_ASSISTANT_ESCALATED,
            actor_user_id: agentId,
            metadata: {
              query: latestQuery,
              reason: noKBResults ? 'no_kb_results' : 'uncertain_response',
              timestamp: new Date().toISOString(),
            },
          })

          // INSERT smart_assistant_suggestions for admin review
          await supabase.from('smart_assistant_suggestions').insert({
            agent_id: agentId,
            title: 'Setup question needs admin review',
            description: latestQuery,
            context_type: 'onboarding_setup',
            priority: 'medium',
            status: 'pending',
          })
        }
      },
    })

    return result.toUIMessageStreamResponse()
  } catch (error) {
    console.error('[v0] Assistant API error:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to process assistant request' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
