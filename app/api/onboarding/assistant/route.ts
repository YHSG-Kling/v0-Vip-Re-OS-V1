import { streamText, convertToModelMessages } from 'ai'
import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import { fireAssistantEvent } from '@/app/actions/onboarding/assistant'
import { buildRAGContext, searchKnowledge } from '@/app/actions/knowledge/search'

export async function POST(request: Request) {
  try {
    const { messages, currentStep, agentOnboardingId } = await request.json()

    const supabase = await createClient()
    const { agentId, brokerageId } = await getAgentContext()

    // Extract the user's latest query for semantic search
    const userMessages = messages.filter((m: { role: string }) => m.role === 'user')
    const latestQuery = userMessages.length > 0
      ? userMessages[userMessages.length - 1].content
      : currentStep

    // Use semantic search to find relevant knowledge
    const ragContext = await buildRAGContext(latestQuery, {
      maxTokens: 3000,
      maxResults: 5,
      category: mapStepToCategory(currentStep),
    })

    // Fire query made event
    await fireAssistantEvent(agentId, 'query_made', currentStep)

    // Build system prompt with agent context and help topics
    const systemPrompt = `You are an AI Setup Assistant for the VIP Real Estate AI OS - a comprehensive platform for real estate agents.

Your role is to provide friendly, helpful guidance during agent onboarding. You help agents:
- Upload and verify their real estate license
- Configure their brand (colors, logo, voice, tone)
- Connect required integrations (email, SMS, CRM, calendar)
- Complete training videos and certifications
- Understand platform features and best practices

Current Onboarding Step: ${currentStep}

Relevant Knowledge (found via semantic search):
${ragContext || 'No specific knowledge found for this query.'}

Guidelines:
1. Be conversational and encouraging - agents are often new to the platform
2. Provide step-by-step guidance when explaining processes
3. Anticipate common questions related to the current step
4. If asked something outside your knowledge, offer to escalate to a human
5. Always maintain brand voice: Professional, warm, and helpful
6. Suggest next steps to help agents make progress through onboarding

Important: If an agent mentions they want to escalate, suggest using the "Escalate to Support" button for complex issues.`

    // Stream response
    const result = streamText({
      model: 'openai/gpt-4o-mini',
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
      temperature: 0.7,
      maxTokens: 1024,
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

/**
 * Map onboarding step to knowledge category for better semantic search
 */
function mapStepToCategory(step: string): string | undefined {
  const stepCategoryMap: Record<string, string> = {
    'license-upload': 'license',
    'license-verification': 'license',
    'brand-setup': 'brand',
    'brand-colors': 'brand',
    'brand-voice': 'brand',
    'integrations': 'tech_stack',
    'email-setup': 'tech_stack',
    'calendar-setup': 'tech_stack',
    'crm-setup': 'tech_stack',
    'training-videos': 'training',
    'certification': 'certification',
  }

  return stepCategoryMap[step] || undefined
}
