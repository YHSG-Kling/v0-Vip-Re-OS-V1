import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { convertToModelMessages } from 'ai'
import { streamTextRouted, AIFairUseError } from '@/lib/ai/models'
import type { UIMessage } from 'ai'
import { NextResponse } from 'next/server'
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'

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
      .select('id, first_name, last_name, brokerage_id, agent_id, contact_type, buyer_stage, contact_persona, email')
      .eq('id', contactId)
      .maybeSingle()

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Accept if any of:
    //   1. The contact's own email (client self-service)
    //   2. The assigned agent (agents table — agents.user_id = auth user.id AND agents.id = contact.agent_id)
    //   3. Admin/broker of same brokerage (users table)
    const isOwnContact = user.email?.toLowerCase() === contact.email?.toLowerCase()
    let hasAccess = isOwnContact

    if (!hasAccess && contact.agent_id) {
      // Rule 2: assigned agent via agents table (kernel identity pattern)
      const { data: ag } = await supabase
        .from('agents')
        .select('id')
        .eq('user_id', user.id)
        .eq('id', contact.agent_id)
        .maybeSingle()
      if (ag) hasAccess = true
    }

    if (!hasAccess) {
      // Rule 3: brokerage admin/broker
      const { data: ur } = await supabase
        .from('users')
        .select('user_type, brokerage_id')
        .eq('id', user.id)
        .maybeSingle()
      if (
        ur?.brokerage_id === contact.brokerage_id &&
        ['admin', 'broker', 'superadmin', 'agent'].includes(ur?.user_type ?? '')
      ) {
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
            session_type: 'portal_widget',
            status:       'open',
            metadata:     { initiated_by_contact: true },
          })
          .select('id')
          .maybeSingle()
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

    let visibleMilestones: { title: string; status: string; target_date: string | null; description: string | null }[] = []
    if (activeTransaction?.id) {
      const { data: milestones } = await supabase
        .from('transaction_milestones')
        .select('title, status, target_date, description')
        .eq('transaction_id', activeTransaction.id)
        .eq('is_client_visible', true)        // GATE: never expose hidden milestones
        .order('target_date', { ascending: true })

      visibleMilestones = milestones ?? []
    }

    // Active listing if seller
    const { data: activeListing } = await supabase
      .from('listings')
      .select('id, address, city, state, status, current_stage:lifecycle_stage, list_price')
      .or(`seller_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
      .not('status', 'in', '(cancelled,expired)')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // ── CHAT IDENTITY (owner rule: the contact's portal shows THEIR AGENT —
    // the licensed human they hired — with the named assistant disclosed as
    // the AI doing the typing, reviewed by the agent). ──
    let agentName: string | null = null
    let agentPhotoUrl: string | null = null
    if (contact.agent_id) {
      const { data: ag } = await supabase.from('agents')
        .select('user_id, photo_url, profile_image_url').eq('id', contact.agent_id).maybeSingle()
      agentPhotoUrl = (ag as any)?.photo_url ?? (ag as any)?.profile_image_url ?? null
      if ((ag as any)?.user_id) {
        const { data: u } = await supabase.from('users')
          .select('first_name, last_name').eq('id', (ag as any).user_id).maybeSingle()
        agentName = u ? [(u as any).first_name, (u as any).last_name].filter(Boolean).join(' ') || null : null
      }
    }

    // ── CONTINUITY — the context spine (one shared memory across phone, video,
    // and chat): what the team already discussed, referenced naturally. ──
    let contextSpine: string | null = null
    try {
      const { data: cmeta } = await supabase.from('contacts')
        .select('metadata').eq('id', contactId).maybeSingle()
      const spine = (cmeta as any)?.metadata?.context_spine
      if (spine?.summary) contextSpine = String(spine.summary).slice(0, 1200)
    } catch { /* continuity is additive */ }

    // ── Load AI identity profile ────────────────────────────────────────────────
    // ONE brand-voice cascade (CLAUDE.md §1/§6) — survivor
    // lib/ai-isa/brand-voice-prompt.ts loadBrandVoicePrompt. This route used to
    // hand-roll its own agent-scope → brokerage-scope read straight off
    // ai_identity_profiles, duplicating the cascade's first two tiers while
    // never reaching its team tier, its brand_voice_profile blend (tone/
    // formality/prohibited-preferred words/tagline), its FAQ knowledge or
    // objection library, or its chartered-AI-teammate naming — this route had
    // NO FAQ/objection support at all (the missing half, built below).
    // `welcome_message` was read but never rendered anywhere in this file
    // (grepped: no other reference) — dropped rather than carried forward as a
    // second unused copy.
    const brand = await loadBrandVoicePrompt({
      brokerageId: contact.brokerage_id,
      agentId: contact.agent_id ?? null,
    })
    const aiIdentity: {
      assistant_name: string
      persona_label: string
      tone: string
      formality_level: string
    } = {
      assistant_name: brand.assistantName,
      persona_label: brand.personaLabel ?? 'Real Estate Assistant',
      tone: brand.tone ?? 'warm',
      formality_level: brand.formalityLevel ?? 'conversational',
    }

    // ── Build system prompt ────────────────────────────────────────────────────
    const contactName = contact.first_name || 'there'
    const portalView = contact.buyer_stage === 'BUYER_LIFETIME'
      ? 'lifetime'
      : contact.contact_type === 'seller'
      ? 'seller'
      : 'buyer'

    // LIVE INVENTORY (additive — the same block the voice receptionist uses):
    // a BUYER asking "what do you have near…" gets real for-sale facts from
    // the brokerage's own listings (public information, no-invention rule
    // scoped to the list). Sellers/data gates untouched; a read failure never
    // breaks the chat. One brain's facts, every surface.
    let inventoryBlock = ''
    if (portalView !== 'seller' && contact.brokerage_id) {
      try {
        const { loadInventoryContext } = await import('@/lib/voice/reception-inventory')
        const lastUser = [...messages].reverse().find(m => m.role === 'user')
        const lastText = lastUser?.parts
          ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map(p => p.text).join('') ?? ''
        inventoryBlock = await loadInventoryContext(serviceClient, contact.brokerage_id, lastText)
      } catch { /* inventory is an enhancement, never a dependency */ }
    }

    // Identity-only handshake: the panel header fetches WHO it is talking to
    // before any model spend (agent face + name, assistant name disclosed).
    if ((body as any).identityOnly) {
      return NextResponse.json({
        identity: {
          agentName, agentPhotoUrl,
          assistantName: aiIdentity.assistant_name,
        },
      })
    }

    // ── LOCAL LIFESTYLE (concierge #30) — REAL nearby places for the property
    // they're focused on (Geoapify/OpenStreetMap, provider-gated: no key or a
    // slow provider = clean skip; the assistant NEVER invents an amenity). ──
    let nearbyLifeBlock: string | null = null
    try {
      const { geoapifyConfigured, fetchNearbyPlaces } = await import('@/lib/external/geoapify-client')
      const focusAddress = activeTransaction?.property_address
        ?? (activeListing ? [activeListing.address, activeListing.city, activeListing.state].filter(Boolean).join(', ') : null)
      if (geoapifyConfigured() && focusAddress) {
        const nearby = await fetchNearbyPlaces(focusAddress)
        if (nearby.ok) {
          const { composeLocalLifestyle } = await import('@/lib/kernel/local-lifestyle')
          nearbyLifeBlock = composeLocalLifestyle(nearby.places)
        }
      }
    } catch { /* nearby life is additive */ }

    // ── CONCERN-MATCHED SOCIAL PROOF (concierge #25) — when the client voices
    // a specific worry (timing, pricing, schools, resale, first-time nerves),
    // hand the model ONE real published review that speaks to it. Never a
    // fabricated quote; zero matches = zero proof (honest silence). ──
    let socialProofLine: string | null = null
    try {
      const { mineClientConcern, pickSocialProof } = await import('@/lib/kernel/social-proof')
      const earlyUserText = [...messages].reverse().find(m => m.role === 'user')?.parts
        ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text).join('') ?? ''
      const concern = mineClientConcern(earlyUserText)
      if (concern) {
        const { data: reviews } = await supabase.from('agent_reviews')
          .select('review_text, rating, reviewer_name')
          .eq('brokerage_id', contact.brokerage_id)
          .eq('is_published', true)
          .gte('rating', 4)
          .order('created_at', { ascending: false })
          .limit(10)
        socialProofLine = pickSocialProof(concern, ((reviews ?? []) as any[]).map(r => ({
          reviewText: r.review_text, rating: r.rating, reviewerName: r.reviewer_name,
        })))
      }
    } catch { /* social proof is additive */ }

    const systemPrompt = [
      `You are ${aiIdentity.assistant_name}, a ${aiIdentity.persona_label} for ${contactName}'s real estate client portal.`,
      `Tone: ${aiIdentity.tone}. Formality: ${aiIdentity.formality_level}.`,
      `You are helping ${contactName} with their ${portalView} journey.`,
      agentName ? `You work FOR ${contactName}'s agent, ${agentName} — you are the assistant, ${agentName} is their agent. Speak as the team.` : '',
      // Persona signal (contacts.contact_persona — DB-sourced, never the client's
      // own claim, same discipline `portalView` above already applies). Additive
      // tone guidance only; never a fact invented about this specific client.
      contact.contact_persona ? `Client persona: ${String(contact.contact_persona).replace(/_/g, ' ')}. Let this inform tone and the kinds of examples you reach for, without assuming facts about them you have not been given.` : '',
      contextSpine ? `\nWHAT THE TEAM ALREADY KNOWS (shared memory across calls, videos, and chat — reference naturally, NEVER contradict, never invent beyond it):\n${contextSpine}\n` : '',
      // Brand-voice cascade fields the old hand-rolled identity lookup never
      // reached (the built missing half — see the loadBrandVoicePrompt note above).
      brand.preferredWords.length ? `Preferred vocabulary: ${brand.preferredWords.join(', ')}.` : '',
      brand.prohibitedWords.length ? `NEVER use these words or phrases: ${brand.prohibitedWords.join(', ')}.` : '',
      brand.faqKnowledge.length
        ? `When relevant, use these FAQ answers:\n${brand.faqKnowledge.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}`
        : '',
      brand.objectionLibrary.length
        ? `Handle these objections with the prepared responses:\n${brand.objectionLibrary.map(o => `Objection (${o.category}): "${o.objection}" → Response: "${o.response}"`).join('\n')}`
        : '',
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
              `  - ${m.title}: ${m.status}${m.target_date ? ' (' + m.target_date + ')' : ''}${m.description ? ' — ' + m.description : ''}`
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
      inventoryBlock ? `\n${inventoryBlock}\n(These listings are public facts you may share freely — an exception to the context-only rule above. For any OTHER property, the agent confirms.)` : '',
      socialProofLine ? `\nREAL CLIENT PROOF (a published review relevant to their concern — you may reference it naturally, quote VERBATIM only, never alter or invent reviews):\n  ${socialProofLine}` : '',
      nearbyLifeBlock ? `\nNEARBY LIFE around their property (REAL places from OpenStreetMap — you may share these; never invent amenities beyond this list, and never characterize school QUALITY):\n${nearbyLifeBlock}` : '',
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
            }).then(() => {}, () => {})
          }
        })
        .then(() => {}, () => {})

      // Warm handoff: compose the FULL brief (portal transcript + context spine + 11-manager team
      // brief + ISA background) onto the contact + a warm_handoff notification, so the agent walks
      // in informed and the client never repeats themselves. Best-effort, fire-and-forget.
      import("@/lib/kernel/warm-handoff-runner")
        .then(({ runWarmHandoff }) => runWarmHandoff(contactId, { triggerMessage: latestText }, serviceClient))
        .then(() => {}, () => {})
    }

    // ── Persist incoming user message ──────────────────────────────────────────
    if (sessionId && latestText) {
      serviceClient.from('chat_messages').insert({
        session_id: sessionId,
        role:       'user',
        content:    latestText,
        metadata:   { source: 'portal', contact_id: contactId },
      }).then(() => {}, () => {})
    }

    // ── Stream response ────────────────────────────────────────────────────────
    // Through the routed entry: routing table model, tenant fair-use cap
    // checked BEFORE the first byte, cost ledger written on finish. Identity
    // is the authenticated caller + the ACCESS-CHECKED contact's tenant
    // (proven above) — never the raw body.
    const result = await streamTextRouted({
      feature:  'portal_chat_stream',
      system:   systemPrompt,
      messages: await convertToModelMessages(messages),
      userId:      user.id,
      brokerageId: contact.brokerage_id,
      agentId:     contact.agent_id ?? null,
      onFinish: async ({ text }) => {
        // Persist AI reply for CRM history
        if (sessionId && text) {
          await serviceClient.from('chat_messages').insert({
            session_id: sessionId,
            role:       'assistant',
            content:    text,
            metadata:   { source: 'portal', contact_id: contactId },
          }).then(() => {}, () => {})
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
    // Fair-use refusal fires pre-stream — tell the client it is the cap, not an outage.
    if (err instanceof AIFairUseError) {
      return NextResponse.json({ error: err.message }, { status: 429 })
    }
    console.error('[portal/ai-chat] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
