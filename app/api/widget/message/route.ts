// POST /api/widget/message
// Streaming AI chat for the embedded widget.
// Validates widget_session_token, loads identity + history, streams response,
// persists both user and assistant turns to chat_messages.
// No auth required — rate-limited by session token.

import { NextRequest } from 'next/server'
import { convertToModelMessages, UIMessage } from 'ai'
import { streamTextRouted, AIFairUseError } from '@/lib/ai/models'
import { createServiceClient } from '@/lib/supabase/service'
import { checkPublicRateLimit } from '@/lib/security/public-rate-limit'

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

    // Public-surface throttle — every message burns LLM tokens, so cap the
    // per-session cadence. Per-instance (see lib/security/public-rate-limit.ts).
    const verdict = checkPublicRateLimit('widget-message', session_token, { limit: 20, windowMs: 60_000 })
    if (!verdict.allowed) {
      return new Response(JSON.stringify({ error: 'Slow down a moment — too many messages at once.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(verdict.retryAfterSeconds) },
      })
    }

    const supabase = createServiceClient()

    // ── Validate session ──────────────────────────────────────────────────
    // The token is the ONLY identity this route accepts: opaque, server-issued
    // by /api/widget/session, and unique (chat_sessions_widget_token_idx). The
    // tenant and the agent are read OFF THE ROW, never off the body — a body
    // that named a brokerage next to this token would reopen the hole the
    // session mint just closed.
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('id, brokerage_id, agent_id, status, capture_state')
      .eq('widget_session_token', session_token)
      .maybeSingle()

    // supabase-js resolves a failed query, so a bare `!session` reported a
    // read failure as "invalid session" and told the visitor their chat was
    // closed when the database was simply unreachable.
    if (sessionError) {
      console.error('[Widget/message] session lookup failed:', sessionError.message)
      return new Response(JSON.stringify({ error: 'Chat is temporarily unavailable.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }

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

    // Ledger identity for this anonymous lane: the visitor has no account, so
    // the usage bills to the ASSIGNED AGENT's user — resolved off the session
    // row (the only identity this route accepts), never off the body. No
    // assigned agent → the cap still pre-flights on the tenant, but the ledger
    // row is skipped (same userId&&brokerageId contract as generateTextRouted).
    let ledgerUserId: string | null = null
    if (session.agent_id) {
      const { data: agentRow, error: agentErr } = await supabase
        .from('agents')
        .select('user_id')
        .eq('id', session.agent_id)
        .maybeSingle()
      if (agentErr) {
        // A refused read only costs us the ledger row — never the visitor's chat.
        console.error('[Widget/message] agent user lookup failed:', agentErr.message)
      }
      ledgerUserId = agentRow?.user_id ?? null
    }

    // Routed streaming entry: routing table model, tenant fair-use cap checked
    // BEFORE the first byte, cost ledger written on finish.
    let result: Awaited<ReturnType<typeof streamTextRouted>>
    try {
      result = await streamTextRouted({
        feature: 'widget_visitor_chat',
        system,
        messages: await convertToModelMessages(recentMessages),
        temperature: 0.7,
        maxTokens: 512,
        userId: ledgerUserId,
        brokerageId: session.brokerage_id,
        agentId: session.agent_id,
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
    } catch (err) {
      // Tenant hit its monthly AI cap — refuse cleanly instead of streaming.
      if (err instanceof AIFairUseError) {
        return new Response(JSON.stringify({ error: 'Chat is temporarily unavailable.' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw err
    }

    return result.toUIMessageStreamResponse()
  } catch (err: any) {
    console.error('[Widget/message] Unhandled error:', err?.message)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
