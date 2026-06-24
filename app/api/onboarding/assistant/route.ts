import { streamText, convertToModelMessages } from 'ai'
import type { UIMessage } from 'ai'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAuth } from '@/lib/kernel/api-auth'
import { KernelEvent } from '@/lib/kernel/events'
import { searchKB } from '@/lib/intelligence/kb-search'

export async function POST(request: Request) {
  // Auth guard — brokerageId and agentId always from session, never from body
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const brokerageId = auth.brokerageId
  // For lifecycle events we need the agents.id; fall back to users.id if no agent row
  const agentId = auth.agentId ?? auth.userId

  try {
    const body = await request.json()
    const { messages } = body as { messages: UIMessage[] }

    // Extract the user's latest query for KB search
    const userMessages = messages.filter((m) => m.role === 'user')
    const latestQuery = userMessages.length > 0
      ? userMessages[userMessages.length - 1].parts
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join(' ')
      : ''

    // Knowledge base search using vector similarity
    const kbResults = await searchKB(latestQuery, brokerageId, 5)

    // Build context string from KB results (max 2000 chars)
    let kbContext = ''
    for (const topic of kbResults) {
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
      actor_user_id: auth.userId,
    })

    const systemPrompt = `You are a helpful setup assistant for a real estate platform called VIP Real Estate OS. Answer questions about platform setup, onboarding, and features. Use the provided knowledge base context. If you don't know, say so and escalate. Keep answers under 150 words.

Context:
${kbContext || 'No specific documentation found for this query.'}`

    const result = streamText({
      model: 'anthropic/claude-sonnet-4-20250514',
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
      temperature: 0.7,
      maxOutputTokens: 400,
      onFinish: async ({ text: aiResponse }) => {
        // INSERT onboarding_ai_chats
        await supabase.from('onboarding_ai_chats').insert({
          brokerage_id: brokerageId,
          agent_id: agentId,
          question: latestQuery,
          ai_response: aiResponse,
        })

        const noKBResults = kbResults.length === 0
        const uncertainResponse =
          aiResponse.toLowerCase().includes("i don't know") ||
          aiResponse.toLowerCase().includes("i'm not sure") ||
          aiResponse.toLowerCase().includes('not certain')

        if (noKBResults || uncertainResponse) {
          await supabase.from('lifecycle_events').insert({
            brokerage_id: brokerageId,
            entity_type: 'agent',
            entity_id: agentId,
            event_type: KernelEvent.SETUP_ASSISTANT_ESCALATED,
            actor_user_id: auth.userId,
            metadata: {
              query: latestQuery,
              reason: noKBResults ? 'no_kb_results' : 'uncertain_response',
              timestamp: new Date().toISOString(),
            },
          })

          // brokerage_id was missing — without it the escalation is invisible to every
          // brokerage-scoped admin view (smart_assistant_suggestions is a tenant table).
          await supabase.from('smart_assistant_suggestions').insert({
            agent_id: agentId,
            brokerage_id: brokerageId,
            title: 'Setup question needs admin review',
            description: latestQuery,
            context_type: 'onboarding_setup',
            priority: 'medium',
            status: 'pending',
          })

          // Tell the brokerage's admins — the escalation previously reached no human (the suggestion
          // sat unscoped with no notification). Mirrors the onboarding-health cron's admin alert.
          // Service client: cross-user notification inserts are privileged. Best-effort.
          try {
            const service = createServiceClient()
            const { data: admins } = await service
              .from('users')
              .select('id')
              .eq('brokerage_id', brokerageId)
              .in('user_type', ['admin', 'broker', 'broker_admin', 'superadmin'])
            for (const adm of admins ?? []) {
              await service.from('notifications').insert({
                user_id: adm.id,
                brokerage_id: brokerageId,
                type: 'onboarding_setup_escalation',
                title: 'Agent setup question needs review',
                body: `The setup assistant couldn't fully answer: "${latestQuery.slice(0, 180)}". Reason: ${noKBResults ? 'no documentation found' : 'uncertain answer'}.`,
                entity_type: 'agent',
                entity_id: agentId,
                priority: 'medium',
                channel: 'in_app',
              })
            }
          } catch (e) {
            console.error('[onboarding/assistant] failed to notify admins of escalation:', e)
          }
        }
      },
    })

    return result.toUIMessageStreamResponse()
  } catch (error) {
    console.error('[onboarding/assistant] API error:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to process assistant request' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
