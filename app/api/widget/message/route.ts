// POST /api/widget/message
// AI chat for the embedded widget.
// Validates widget_session_token, loads identity + history, decides the answer, SCREENS any model draft before a byte
// reaches the visitor (wave 155, lane 155F2), streams the screened text, persists both user and assistant turns to chat_messages.
// No auth required — rate-limited by session token.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextRequest } from 'next/server'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, UIMessage } from 'ai'
import { streamTextRouted, AIFairUseError } from '@/lib/ai/models'
import { createServiceClient } from '@/lib/supabase/service'
import { checkPublicRateLimit } from '@/lib/security/public-rate-limit'
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'
import { batchDataIsaTools } from '@/lib/ai-isa/batchdata-isa-tools'
import { resolveToolPersona, filterRentCastToolsForPersona, selectToolsForPersona } from '@/lib/ai-isa/persona-tool-policy'
import { rentCastMcpTools } from '@/lib/external/rentcast-ai-tools'
import { buildCustomerFreeTools } from '@/lib/ai-isa/customer-context-tools'
import { buildQualificationPrompt } from '@/lib/ai-isa/qualification-playbook'
import { loadBrandPlaybookContext } from '@/lib/ai-isa/brand-playbook-context'

const MAX_HISTORY = 20 // keep last 20 messages for context window

/** The longest a visitor waits for a screened model answer (lane 155F2). Past it the held answer goes out (what is on file + who
 *  follows up) and the late draft is discarded, never sent. A CHOSEN ceiling, not a measured one (owner decision, lane 155F2 notes):
 *  long enough for a 512-token draft with a tool step, short enough that a hung provider never leaves the visitor in silence. */
const WIDGET_ANSWER_DEADLINE_MS = 12_000

/** The screened text as the widget's UI-message stream, sentence by sentence (the client renders it exactly as it rendered tokens). */
function screenedStream(text: string): Response {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'text-start', id: 'answer' })
        parts.forEach((p, i) => writer.write({ type: 'text-delta', id: 'answer', delta: i === 0 ? p : ` ${p}` }))
        writer.write({ type: 'text-end', id: 'answer' })
      },
    }),
  })
}

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
      .select('id, brokerage_id, agent_id, status, capture_state, contact_id')
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
    // ONE brand-voice cascade (CLAUDE.md §1/§6) — was a hand-rolled two-tier
    // (agent → brokerage) read straight off ai_identity_profiles, duplicating
    // lib/ai-isa/brand-voice-prompt.ts's loadBrandVoicePrompt cascade
    // (brand_voice_profile → brokerage/team/agent ai_identity_profiles →
    // chartered AI teammates) while missing its tone/formality/prohibited-word
    // rules and team tier entirely. Survivor: loadBrandVoicePrompt. This is
    // the anonymous-widget lane the doc's §3 cascade note calls out — no
    // contactId exists pre-capture, so it runs the brokerage/agent cascade
    // without contact coverage.
    const brand = await loadBrandVoicePrompt({
      brokerageId: session.brokerage_id,
      agentId: session.agent_id ?? null,
    })

    // Persona is DERIVED (resolveToolPersona) from the session's OWN linked
    // contact when capture already happened this session — resolved HERE,
    // before the system prompt, so buildQualificationPrompt can flavor its
    // goal list (lane 74B). A still-anonymous visitor has no contact_type/
    // contact_persona/home_owner_status to read and resolves to the 'buyer'
    // default (the SAME default posture lib/campaigns/contact-sources.ts
    // already documents).
    let widgetContactType: string | null = null
    let widgetContactPersona: string | null = null
    let widgetHomeOwnerStatus: string | null = null
    if (session.contact_id) {
      const { data: widgetContact } = await supabase
        .from('contacts')
        .select('contact_type, contact_persona, home_owner_status')
        .eq('id', session.contact_id)
        .maybeSingle()
      widgetContactType = widgetContact?.contact_type ?? null
      widgetContactPersona = widgetContact?.contact_persona ?? null
      widgetHomeOwnerStatus = widgetContact?.home_owner_status ?? null
    }
    const widgetPersona = resolveToolPersona({
      contactType: widgetContactType,
      contactPersona: widgetContactPersona,
      homeOwnerStatus: widgetHomeOwnerStatus,
    })

    // ── Build system prompt ───────────────────────────────────────────────
    // TOMBSTONE (lane 74B) — the inline "qualify their intent (buying or
    // selling), and naturally collect their name, email, and phone number…"
    // paragraph stood here. SURVIVOR: lib/ai-isa/qualification-playbook.ts
    // ::buildQualificationPrompt (CLAUDE.md §6).
    // Wave 75 — business processes/SOPs, brand KB, office hours, service
    // areas. `preloadedVoice: brand` + `omitVoiceBlock: true` because
    // `brand.systemBlock` is already rendered on the line above — the
    // brand-voice cascade is not re-queried and not restated twice.
    const lastMsgForKb = messages[messages.length - 1]
    const brandPlaybook = await loadBrandPlaybookContext({
      brokerageId: session.brokerage_id,
      agentId: session.agent_id ?? null,
      contactId: session.contact_id ?? null,
      preloadedVoice: brand,
      omitVoiceBlock: true,
      knowledgeQuery: lastMsgForKb?.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') ?? null,
    })

    const system = `${brand.systemBlock}

${buildQualificationPrompt({ surface: 'widget', persona: widgetPersona, brand: brandPlaybook })}

If you have collected enough to identify them (name + email OR phone), say:
"I have your info and someone from the team will follow up shortly!"
Do NOT make up property listings. Do NOT discuss competitor brokerages.`

    // ── Persist user message ──────────────────────────────────────────────
    const lastMsg = messages[messages.length - 1]
    const userText = lastMsg?.parts
      ?.filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('') ?? ''

    await sentinelWrite(supabase, supabase.from('chat_messages').insert({
      session_id: session.id,
      role: 'user',
      content: userText,
      metadata: { widget: true },
    }), { table: "chat_messages", flow: "chat_messages_write", reason: "chat history persistence; never blocks the streamed answer" })

    // ── A question several visitors asked → one anonymized local FAQ topic (wave 154, lane 154I, directive I4/I1) ──
    // The tenant's own website questions, counted by DISTINCT session against the first-party floor, become ONE reworded
    // topic in the canonical pool — never a visitor's words, never a person, never a persona field. An unclassifiable
    // question costs nothing; a refusal is said and never blocks the answer. Dynamic import: off this route's hot graph.
    try {
      const { considerCustomerQuestion } = await import('@/lib/customer-intelligence/website-question-topics')
      const topic = await considerCustomerQuestion(supabase, { brokerageId: session.brokerage_id ?? null, text: userText })
      if (topic.status === 'refused') console.error('[widget/message] website question topic not recorded:', topic.reason)
    } catch (e) {
      console.error('[widget/message] website question topic step failed (non-blocking):', e instanceof Error ? e.message : e)
    }

    // ── THE ANSWER DECISION (wave 155, lane 155F — directive F1, owner R10) ──
    // A guarded question (an instruction to the assistant, a neighborhood-character question, a rate / price forecast) or one
    // about a specific deal, lender, title, insurance, a legal / financial judgment or a request for a human is answered
    // DETERMINISTICALLY here — no model, no tools. The visitor token is never a portal sign-in, so no deal fact is read or
    // stated on this door (contactId null); the session's assigned agent gets ONE task / bell for it (deduplicated), and the
    // tenant stays the session row's (INJECT-001 — nothing in the message or the body can name another). General questions
    // are SCREENED before delivery below (lane 155F2).
    let qad: typeof import('@/lib/portal/question-answer-decision') | null = null
    try {
      qad = await import('@/lib/portal/question-answer-decision')
      const cls = qad.classifyPortalQuestion(userText)
      if (cls.guard || cls.urgency === 'critical' || !(cls.kind === 'general_education' || cls.kind === 'tenant_procedure')) {
        const decision = await qad.decidePortalAnswer(supabase, { brokerageId: session.brokerage_id, contactId: null, question: userText, agentName: null })
        const text = decision.text.replace(/your agent/g, 'someone from the team')
        await sentinelWrite(supabase, supabase.from('chat_messages').insert({
          session_id: session.id, role: 'assistant', content: text,
          metadata: { widget: true, assistant_name: brand.assistantName, portal_answer: { kind: cls.kind, fact: cls.fact, guard: cls.guard, answered: decision.answered, model_calls: 0 } },
        }), { table: "chat_messages", flow: "chat_messages_write", reason: "chat history persistence; never blocks the answer" })
        const ding = await qad.fileQuestionDing(supabase, { brokerageId: session.brokerage_id, contactId: session.contact_id ?? null, sessionId: session.id, agentId: session.agent_id ?? null, question: userText, decision, surface: 'website_widget' })
        if (decision.plan.notify && !ding.filed && !ding.deduped && ding.notified === 0) console.error('[widget/message] question ding not filed:', ding.reason)
        const { createUIMessageStream, createUIMessageStreamResponse } = await import('ai')
        return createUIMessageStreamResponse({
          stream: createUIMessageStream({
            execute: ({ writer }) => {
              writer.write({ type: 'text-start', id: 'answer' })
              writer.write({ type: 'text-delta', id: 'answer', delta: text })
              writer.write({ type: 'text-end', id: 'answer' })
            },
          }),
        })
      }
    } catch (e) {
      console.error('[widget/message] answer decision failed on the deterministic branch:', e instanceof Error ? e.message : e)
    }

    // FAIL CLOSED (CLAUDE.md §4): without the claim screen no model text may reach an anonymous visitor. The visitor is still
    // answered — what we can say and who follows up — never silence.
    if (!qad) {
      const text = "Thanks for your question — I can't answer it reliably right now, so someone from the team will follow up with you."
      await sentinelWrite(supabase, supabase.from('chat_messages').insert({
        session_id: session.id, role: 'assistant', content: text,
        metadata: { widget: true, assistant_name: brand.assistantName, portal_answer: { answered: 'held', reason: 'claim screen unavailable — model not asked', model_calls: 0 } },
      }), { table: "chat_messages", flow: "chat_messages_write", reason: "chat history persistence; never blocks the answer" })
      return screenedStream(text)
    }

    // ── Screened general answer (wave 155, lane 155F2 — owner R10, eval HALLUC-006) ──
    const recentMessages = messages.slice(-MAX_HISTORY)

    // Ledger identity for this anonymous lane: the cost lands on the TENANT
    // (the session row's brokerage — the only identity this route accepts,
    // never the body), attributed to the ASSIGNED AGENT's user when one
    // exists. No assigned agent → the row still lands, with a null user =
    // anonymous tenant traffic (#187). Metered and capped either way.
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

    // ── BatchData/RentCast property-intelligence tools (lane 72B, widened 73B) ──
    // The anonymous pre-lead lane. conversationKey = the session row's id
    // (stable across this visitor's whole chat, survives capture) — never
    // the request body. contactId is the session's own linked contact when
    // capture already happened this session, else null (the tool still
    // runs, it just has nothing tenant-scoped to persist a verify/DNC
    // verdict to yet). Gated: {} when BatchData's MCP is unconfigured, so a
    // deployment with no BatchData token streams exactly as before this
    // change. widgetPersona is resolved above (before the system prompt).
    const batchDataTools = await batchDataIsaTools({
      brokerageId: session.brokerage_id,
      userId: ledgerUserId,
      agentId: session.agent_id,
      persona: widgetPersona,
      conversationKey: session.id,
      contactId: session.contact_id ?? null,
    })
    const rentCastTools = filterRentCastToolsForPersona(
      await rentCastMcpTools({ brokerageId: session.brokerage_id, userId: ledgerUserId }),
      widgetPersona,
    )
    const freeTools = await buildCustomerFreeTools({
      brokerageId: session.brokerage_id,
      contactId: session.contact_id ?? null,
      agentId: session.agent_id,
      persona: widgetPersona,
    })

    // SCREEN BEFORE DELIVERY (lane 155F2). This public, anonymous door used to stream the model's tokens straight to the visitor,
    // so an unsourced figure, date or status reached them before anything judged it. Now ONE decision (decidePortalAnswer — the
    // SAME claim screen the tutor and the home assistant use) runs first:
    //   · the ONE ranker CONFIDENT in a help row → that row answers at once (no model call, no wait);
    //   · otherwise the routed model drafts in full SERVER-SIDE (same routing, fair-use pre-flight, tools and cost ledger), every
    //     figure / date / status sentence it adds that the help base, the tenant's own prompt context or its tools' results do
    //     not carry is stripped, and only then is the screened text streamed;
    //   · a draft the screen empties, a model failure or a draft over WIDGET_ANSWER_DEADLINE_MS is HELD: the visitor still gets
    //     what is on file (the help row when there is one) and who follows up, and the session's agent gets ONE task.
    // THE COST, measured: the first visible byte waits for the whole draft (generation, bounded by maxTokens 512 and the deadline)
    // instead of its first token; the screen itself is sub-millisecond (scripts/portal-answer-guard.ts measures it). Every turn
    // records model_ms / screen_ms in chat_messages.metadata.portal_answer.latency so the live cost is readable, not guessed.
    let fairUse: AIFairUseError | null = null
    let timedOut = false
    const toolsForTurn = selectToolsForPersona({ ...freeTools, ...batchDataTools, ...rentCastTools }, {
      // Lane 74B — cost-ranked order + need-dedup; wave 98 (98C): narrowed by the tenant's AUTHORITY LADDER rung.
      authorityLevel: await (await import("@/lib/managers/autonomy-gate")).resolveAgentAuthorityLevel(session.brokerage_id, "ai_isa"),
    })
    const modelMessages = await convertToModelMessages(recentMessages)
    const decision = await qad.decidePortalAnswer(supabase, {
      brokerageId: session.brokerage_id, contactId: null, question: userText, agentName: 'someone from the team',
      deterministicWhenConfident: true, conversational: true,
      // The tenant's own prompt context (brand voice, office hours, service areas, knowledge) is what the model was given — its
      // facts may be repeated. The visitor's own words are NOT a source: echoing a figure they typed would affirm it.
      extraSourceText: system,
      generalAnswer: async ({ sources }) => {
        let result: Awaited<ReturnType<typeof streamTextRouted>>
        try {
          // Routed streaming entry: routing table model, tenant fair-use cap checked BEFORE any token, cost ledger written on
          // finish (inside streamTextRouted). Consumed here, never piped to the visitor.
          result = await streamTextRouted({
            feature: 'widget_visitor_chat',
            system: sources.length > 0 ? `${system}\n\nVERIFIED SOURCES — answer ONLY from these; never add a figure, date or deadline they do not contain:\n${sources.map((s) => `- ${s.title}: ${s.excerpt}`).join('\n')}` : system,
            messages: modelMessages,
            temperature: 0.7,
            maxTokens: 512,
            tools: toolsForTurn,
            maxSteps: 5,
            userId: ledgerUserId,
            brokerageId: session.brokerage_id,
            agentId: session.agent_id,
            manager: 'ai_isa',
          })
        } catch (err) {
          if (err instanceof AIFairUseError) { fairUse = err; return null }
          throw err
        }
        const drafted = (async () => {
          const steps = await result.steps
          const draft = steps.map((s) => s.text).filter(Boolean).join('\n').trim() || (await result.text)
          // What the tools retrieved this turn (RentCast / BatchData / the free tools) is a retrieved source the screen allows.
          const sourceText = steps.flatMap((s) => (s.toolResults ?? []).map((r) => { try { return JSON.stringify((r as { output?: unknown }).output ?? null) } catch { return '' } })).join('\n')
          return { draft, sourceText }
        })()
        const raced = await qad!.withinDeadline(drafted, WIDGET_ANSWER_DEADLINE_MS)
        if ('timedOut' in raced) { timedOut = true; return null }
        return raced.value
      },
    })
    // Tenant hit its monthly AI cap — refuse cleanly, as before (nothing was generated).
    if (fairUse) {
      return new Response(JSON.stringify({ error: 'Chat is temporarily unavailable.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const text = decision.text.replace(/your agent/g, 'someone from the team')
    await sentinelWrite(supabase, supabase.from('chat_messages').insert({
      session_id: session.id, role: 'assistant', content: text,
      metadata: {
        widget: true, assistant_name: brand.assistantName,
        portal_answer: {
          kind: decision.cls.kind, answered: decision.answered, sources: decision.sources.slice(0, 6), stripped_sentences: decision.stripped.length, model_calls: decision.modelCalls,
          latency: { model_ms: decision.timing?.modelMs ?? null, screen_ms: decision.timing?.screenMs ?? null, deadline_ms: WIDGET_ANSWER_DEADLINE_MS, timed_out: timedOut },
        },
      },
    }), { table: "chat_messages", flow: "chat_messages_write", reason: "chat history persistence (the SCREENED text — never the raw draft); never blocks the answer" })

    // A HELD answer is a question nobody answered: ONE task / bell for the session's agent (deduplicated per session + question).
    // A conversation turn that survived the screen is not escalated (that would page the agent for every "what area?").
    if (decision.answered === 'held') {
      const ding = await qad.fileQuestionDing(supabase, { brokerageId: session.brokerage_id, contactId: session.contact_id ?? null, sessionId: session.id, agentId: session.agent_id ?? null, question: userText, decision, surface: 'website_widget' })
      if (decision.plan.notify && !ding.filed && !ding.deduped && ding.notified === 0) console.error('[widget/message] held-answer ding not filed:', ding.reason)
    }

    // Detect lead capture keywords in the reply the visitor actually got.
    const captureHit = /your info|follow up|reach out|team will contact/i.test(text)
    if (captureHit && session.capture_state !== 'captured') {
      await sentinelWrite(supabase, supabase
        .from('chat_sessions')
        .update({ capture_state: 'signals_captured', updated_at: new Date().toISOString() })
        .eq('id', session.id), { table: "chat_sessions", flow: "chat_sessions_write", reason: "capture-signal stamp on the session" })
    }

    return screenedStream(text)
  } catch (err: any) {
    console.error('[Widget/message] Unhandled error:', err?.message)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
