// POST /api/widget/message
// Streaming AI chat for the embedded widget.
// Validates widget_session_token, loads identity + history, streams response,
// persists both user and assistant turns to chat_messages.
// No auth required — rate-limited by session token.

import { NextRequest } from 'next/server'
import { streamText, convertToModelMessages, UIMessage } from 'ai'
import { openai } from '@ai-sdk/openai'
import { createServiceClient } from '@/lib/supabase/service'

const MAX_HISTORY = 20 // keep last 20 messages for context window

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      session_token,
      messages,
    }: {
      session_token: string
      messages: UIMessage[]
    } = body

    if (!session_token || !messages?.length) {
      return new Response(JSON.stringify({ error: 'session_token and messages required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const supabase = createServiceClient()

    // ── Validate session ──────────────────────────────────────────────────
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id, brokerage_id, agent_id, status, capture_state')
      .eq('widget_session_token', session_token)
      .single()

    if (!session || session.status === 'closed') {
      return new Response(JSON.stringify({ error: 'Invalid or closed session' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── Load identity ─────────────────────────────────────────────────────
    let profile: any = null
    if (session.agent_id) {
      const { data } = await supabase
        .from('ai_identity_profiles')
        .select('assistant_name, persona_label, tone, faq_knowledge, objection_library, followup_style')
        .eq('scope_type', 'agent')
        .eq('scope_id', session.agent_id)
        .eq('active', true)
        .maybeSingle()
      if (data) profile = data
    }
    if (!profile) {
      const { data } = await supabase
        .from('ai_identity_profiles')
        .select('assistant_name, persona_label, tone, faq_knowledge, objection_library, followup_style')
        .eq('scope_type', 'brokerage')
        .eq('scope_id', session.brokerage_id)
        .eq('active', true)
        .maybeSingle()
      if (data) profile = data
    }

    const assistantName = profile?.assistant_name ?? 'Your Real Estate Assistant'
    const personaLabel = profile?.persona_label ?? 'AI Real Estate Specialist'
    const tone = profile?.tone ?? 'conversational'
    const faqKnowledge: Array<{ question: string; answer: string }> = profile?.faq_knowledge ?? []
    const objectionLibrary: Array<{ objection: string; response: string }> = profile?.objection_library ?? []

    // ── Build system prompt ───────────────────────────────────────────────
    const faqBlock = faqKnowledge.length
      ? `\n\nFREQUENTLY ASKED QUESTIONS (answer these from memory):\n` +
        faqKnowledge.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
      : ''

    const objectionBlock = objectionLibrary.length
      ? `\n\nOBJECTION HANDLING:\n` +
        objectionLibrary.map((o) => `Objection: ${o.objection}\nResponse: ${o.response}`).join('\n\n')
      : ''

    const system = `You are ${assistantName}, a ${personaLabel} for a real estate brokerage.
Tone: ${tone}. Be helpful, concise, and focused on real estate.
Your job is to help prospects with their questions, qualify their intent (buying or selling),
and naturally collect their name, email, and phone number when appropriate — never pushy.
If you have collected enough to identify them (name + email OR phone), say:
"I have your info and someone from the team will follow up shortly!"
Do NOT make up property listings. Do NOT discuss competitor brokerages.${faqBlock}${objectionBlock}`

    // ── Persist user message ──────────────────────────────────────────────
    const lastMsg = messages[messages.length - 1]
    const userText = lastMsg?.parts
      ?.filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('') ?? ''

    await supabase.from('chat_messages').insert({
      session_id: session.id,
      role: 'user',
      content: userText,
      metadata: { widget: true },
    })

    // ── Stream response ───────────────────────────────────────────────────
    const recentMessages = messages.slice(-MAX_HISTORY)

    const result = streamText({
      model: openai('gpt-4o-mini'),
      system,
      messages: await convertToModelMessages(recentMessages),
      temperature: 0.7,
      maxOutputTokens: 512,
      onFinish: async ({ text }) => {
        // Persist assistant turn
        await supabase.from('chat_messages').insert({
          session_id: session.id,
          role: 'assistant',
          content: text,
          metadata: { widget: true, assistant_name: assistantName },
        })

        // Detect lead capture keywords in assistant reply
        const captureHit = /your info|follow up|reach out|team will contact/i.test(text)
        if (captureHit && session.capture_state !== 'captured') {
          await supabase
            .from('chat_sessions')
            .update({ capture_state: 'signals_captured', updated_at: new Date().toISOString() })
            .eq('id', session.id)
        }
      },
    })

    return result.toUIMessageStreamResponse()
  } catch (err: any) {
    console.error('[Widget/message] Unhandled error:', err?.message)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
