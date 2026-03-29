import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { streamText, convertToModelMessages } from 'ai'
import { gateway } from '@ai-sdk/gateway'
import type { UIMessage } from 'ai'
import { NextResponse } from 'next/server'

// Portal AI chat — authenticated contacts only.
// Business rules enforced here:
//   1. Auth gate: must be a valid authenticated session with access to this contactId
//   2. Data gate: only client-visible milestone data is injected into context
//   3. No internal notes, tasks, agent commentary, or hidden milestones exposed
//   4. Escalation: urgency keywords → notify agent via notifications table
//   5. Session persistence: upsert chat_session by contactId + source='portal'
//   6. Every exchange is persisted in chat_messages for CRM history

// Escalation trigger keywords (case-insensitive)
const ESCALATION_KEYWORDS = [
  'urgent', 'emergency', 'need agent', 'call me', 'speak to someone',
  'scared', 'worried', 'panicking', 'deal is falling', 'losing the house',
  'pulling out', 'back out', 'cancel', 'sue', 'lawsuit',
]

function detectsEscalation(text: string): boolean {
  const lower = text.toLowerCase()
  return ESCALATION_KEYWORDS.some(k => lower.includes(k))
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    // ── Auth gate ──────────────────────────────────────────────────────────────
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { messages, contactId, sessionId: clientSessionId } = body as {
      messages: UIMessage[]
      contactId: string
      sessionId?: string
    }

    if (!contactId || !messages?.length) {
      return NextResponse.json({ error: 'contactId and messages are required' }, { status: 400 })
    }

    // ── Verify caller has access to this contactId ─────────────────────────────
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, brokerage_id, agent_id, contact_type, buyer_stage, email')
      .eq('id', contactId)
      .single()

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Accept if: contact's own email, or agent/admin of the brokerage
    const isOwnContact = user.email?.toLowerCase() === contact.email?.toLowerCase()
    let hasAccess = isOwnContact

    if (!hasAccess) {
      const { data: ur } = await supabase
        .from('users')
        .select('user_type, brokerage_id')
        .eq('id', user.id)
        .maybeSingle()
      if (ur?.brokerage_id === contact.brokerage_id &&
        ['admin', 'broker', 'superadmin', 'agent'].includes(ur.user_type ?? '')) {
        hasAccess = true
      }
    }

    if (!hasAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ── Resolve or create portal chat session ──────────────────────────────────
    const serviceClient = createServiceClient()
    let sessionId = clientSessionId

    if (!sessionId) {
      // Try to find existing open portal session for this contact
      const { data: existing } = await serviceClient
        .from('chat_sessions')
        .select('id')
        .eq('contact_id', contactId)
        .eq('source', 'portal')
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (existing) {
        sessionId = existing.id
      } else {
        // Create new portal session
        const { data: newSession } = await serviceClient
          .from('chat_sessions')
          .insert({
            contact_id:   contactId,
            brokerage_id: contact.brokerage_id,
            agent_id:     contact.agent_id ?? null,
            source:       'portal',
            session_type: 'portal_ai',
            status:       'open',
            metadata:     { initiated_by_contact: true },
          })
          .select('id')
          .single()
        sessionId = newSession?.id ?? null
      }
    }

    // ── Load CLIENT-VISIBLE context only ───────────────────────────────────────
    // Milestones: only where is_client_visible = true
    const { data: activeTransaction } = await supabase
      .from('transactions')
      .select('id, property_address, status, stage, close_date, purchase_price, deal_type')
      .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
      .not('status', 'in', '(cancelled,lost)')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let visibleMilestones: { title: string; status: string; milestone_date: string | null; description: string | null }[] = []
    if (activeTransaction?.id) {
      const { data: milestones } = await supabase
        .from('transaction_milestones')
        .select('title, status, milestone_date, description')
        .eq('transaction_id', activeTransaction.id)
        .eq('is_client_visible', true)        // GATE: never expose hidden milestones
        .order('milestone_date', { ascending: true })

      visibleMilestones = milestones ?? []
    }

    // Active listing if seller
    const { data: activeListing } = await supabase
      .from('listings')
      .select('id, address, city, state, status, current_stage, list_price')
      .or(`seller_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
      .not('status', 'in', '(cancelled,expired)')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // ── Build system prompt ────────────────────────────────────────────────────
    const contactName = contact.first_name || 'there'
    const portalView = contact.buyer_stage === 'BUYER_LIFETIME'
      ? 'lifetime'
      : contact.contact_type === 'seller'
      ? 'seller'
      : 'buyer'

    const systemPrompt = [
      `You are a helpful AI assistant for ${contactName}'s real estate client portal.`,
      `You work for the real estate team helping ${contactName} with their ${portalView} journey.`,
      '',
      'YOUR RULES:',
      '- You may ONLY discuss information from the context below.',
      '- You must NEVER reveal: internal agent notes, hidden milestones, compliance items, agent-only tasks, or any data not in this context.',
      '- If asked about something not in your context, say: "Your agent can clarify that for you."',
      '- Do NOT give legal, tax, or financial advice. Recommend consulting a professional.',
      '- Do NOT promise specific closing dates or guaranteed outcomes.',
      '- If the contact seems urgent or distressed, reassure them and offer to escalate to their agent.',
      '',
      activeTransaction ? [
        'ACTIVE TRANSACTION:',
        `  Property: ${activeTransaction.property_address ?? 'your property'}`,
        `  Status: ${activeTransaction.status}`,
        `  Stage: ${activeTransaction.stage ?? 'in progress'}`,
        `  Type: ${activeTransaction.deal_type ?? 'purchase'}`,
        activeTransaction.close_date ? `  Target close: ${activeTransaction.close_date}` : '',
        '',
        'VISIBLE MILESTONES (these are the only milestones you know about):',
        visibleMilestones.length
          ? visibleMilestones.map(m =>
              `  - ${m.title}: ${m.status}${m.milestone_date ? ' (' + m.milestone_date + ')' : ''}${m.description ? ' — ' + m.description : ''}`
            ).join('\n')
          : '  No milestones available yet.',
      ].filter(Boolean).join('\n') : 'No active transaction found.',
      '',
      activeListing ? [
        'ACTIVE LISTING:',
        `  Address: ${activeListing.address}, ${activeListing.city}, ${activeListing.state}`,
        `  Status: ${activeListing.status}`,
        `  Stage: ${activeListing.current_stage ?? 'listed'}`,
        `  List price: $${activeListing.list_price?.toLocaleString() ?? 'TBD'}`,
      ].join('\n') : '',
      '',
      'TONE: Warm, clear, reassuring. Plain English. No jargon unless you explain it.',
      'ESCALATION: If the contact asks to speak to a human, says this is urgent, or seems very stressed, tell them their agent will be notified right away.',
    ].filter(Boolean).join('\n')

    // ── Detect escalation in latest user message ───────────────────────────────
    const latestUserMessage = [...messages].reverse().find(m => m.role === 'user')
    const latestText = latestUserMessage?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text)
      .join('') ?? ''

    if (detectsEscalation(latestText) && contact.agent_id) {
      // Fire-and-forget: notify agent
      serviceClient
        .from('agents')
        .select('user_id')
        .eq('id', contact.agent_id)
        .maybeSingle()
        .then(({ data: agent }) => {
          if (agent?.user_id) {
            serviceClient.from('notifications').insert({
              user_id:     agent.user_id,
              brokerage_id: contact.brokerage_id,
              type:        'portal_ai_escalation',
              title:       `${contactName} needs immediate attention`,
              body:        `Portal AI escalation triggered. Message: "${latestText.slice(0, 200)}"`,
              entity_type: 'contact',
              entity_id:   contactId,
              priority:    'high',
            }).catch(() => {})
          }
        })
        .catch(() => {})
    }

    // ── Persist incoming user message ──────────────────────────────────────────
    if (sessionId && latestText) {
      serviceClient.from('chat_messages').insert({
        session_id: sessionId,
        role:       'user',
        content:    latestText,
        metadata:   { source: 'portal', contact_id: contactId },
      }).catch(() => {})
    }

    // ── Stream response ────────────────────────────────────────────────────────
    const result = streamText({
      model:    gateway('openai/gpt-4o-mini'),
      system:   systemPrompt,
      messages: await convertToModelMessages(messages),
      onFinish: async ({ text }) => {
        // Persist AI reply for CRM history
        if (sessionId && text) {
          await serviceClient.from('chat_messages').insert({
            session_id: sessionId,
            role:       'assistant',
            content:    text,
            metadata:   { source: 'portal', contact_id: contactId },
          }).catch(() => {})
        }
      },
    })

    // Return sessionId in headers so the client can persist it
    const response = result.toUIMessageStreamResponse()
    const headers = new Headers(response.headers)
    if (sessionId) headers.set('x-portal-session-id', sessionId)

    return new Response(response.body, {
      status:  response.status,
      headers,
    })

  } catch (err) {
    console.error('[portal/ai-chat] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
