'use server'
// POST /api/widget/session
// Creates or resumes a chat_session for an embedded widget.
// Returns session token + resolved AI identity (assistant name, persona, tone).
// No authentication required — widget is public-facing.
//
// PUBLIC ≠ UNGOVERNED. This route used to take `brokerage_id` and `agent_id`
// straight off the POST body and hand them to the service client, so anyone who
// knew a brokerage uuid could mint a session token against that tenant, spend
// its AI budget through /api/widget/message and attribute the conversation to
// any agent at all. The tenant is now resolved SERVER-SIDE from the brokerage's
// public slug — see lib/widget/resolve-widget-tenant.ts for why that handle and
// not embed_widgets — and the body no longer carries an identity the server
// trusts. Same shape as /api/embed/session, the other public session mint.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { randomUUID } from 'crypto'
import { checkPublicRateLimit } from '@/lib/security/public-rate-limit'
import { resolveWidgetTenant, widgetCallOriginAllowed } from '@/lib/widget/resolve-widget-tenant'

export async function POST(req: NextRequest) {
  try {
    // Public-surface throttle — session mints insert rows with the service
    // client. Per-IP, per-instance (see lib/security/public-rate-limit.ts).
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown'
    const verdict = checkPublicRateLimit('widget-session', ip, { limit: 10, windowMs: 60_000 })
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: 'Too many sessions from this connection — try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } },
      )
    }

    // A browser that tells us where it is calling from has to be us — both
    // widget entry points are iframes served from this app.
    if (!widgetCallOriginAllowed(req)) {
      return NextResponse.json({ error: 'This chat cannot be started from here.' }, { status: 403 })
    }

    const body = await req.json()
    const {
      brokerage_slug,
      agent_id,
      source = 'website_widget',
      visitor_fingerprint,
      resume_token,
    }: {
      brokerage_slug: string
      agent_id?: string | null
      source?: string
      visitor_fingerprint?: string | null
      resume_token?: string | null
    } = body

    const supabase = createServiceClient()

    // The ONLY place brokerage_id and agent_id come from. `agent_id` is checked
    // against the resolved brokerage in there, so a foreign agents.id refuses
    // rather than being written into this tenant's session.
    const resolution = await resolveWidgetTenant(supabase, {
      brokerageSlug: brokerage_slug,
      agentId: agent_id ?? null,
    })
    if (!resolution.ok) {
      return NextResponse.json({ error: resolution.error }, { status: resolution.status })
    }
    const { brokerageId, agentId } = resolution.tenant

    // ── Resume existing session if token provided ─────────────────────────
    if (resume_token) {
      const { data: existing } = await supabase
        .from('chat_sessions')
        .select('id, widget_session_token, capture_state, status, brokerage_id, agent_id')
        .eq('widget_session_token', resume_token)
        .eq('brokerage_id', brokerageId)
        .maybeSingle()

      if (existing && existing.status !== 'closed') {
        const identity = await resolveIdentity(supabase, brokerageId, agentId)
        return NextResponse.json({
          session_token: existing.widget_session_token,
          session_id: existing.id,
          capture_state: existing.capture_state,
          identity,
        })
      }
    }

    // ── Resume by visitor fingerprint — THE RETURNING VISITOR ─────────────
    //
    // THE READER visitor_fingerprint NEVER HAD (§1.2). The resume_token above
    // lives in the widget's sessionStorage, which dies with the tab — so every
    // returning visitor (new tab, next day) silently lost their thread, and the
    // fingerprint the client has computed since day one was written to this row
    // and read by nothing. The opposite-missing census caught it as a
    // write-no-read the moment a dead module's phantom embed stopped
    // camouflaging it.
    //
    // THE FINGERPRINT IS COARSE AND THE RULES BELOW ARE LOAD-BEARING. It is a
    // 32-bit hash of userAgent + screen dims + timezone (widget-chat-client
    // getFingerprint) — two iPhones in one city collide easily. So a
    // fingerprint may resume ONLY a thread that is still anonymous:
    //   · status 'active'            — never a closed conversation
    //   · capture_state 'none'       — the moment a visitor identifies
    //                                  themselves (signals_captured/captured)
    //                                  the thread is about a PERSON, and a
    //                                  collision would hand it to a stranger
    //   · contact_id IS NULL         — belt to the same braces
    //   · same brokerage AND same agent — resolved server-side above
    //   · touched in the last 24h    — bounds collision exposure
    // A read error falls through to a fresh session (this is a public door —
    // fail toward service, not refusal), but is logged rather than swallowed
    // (§3: supabase-js resolves refusals).
    if (!resume_token && visitor_fingerprint?.trim()) {
      const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000
      let q = supabase
        .from('chat_sessions')
        .select('id, widget_session_token, capture_state, status, contact_id, updated_at')
        .eq('brokerage_id', brokerageId)
        .eq('visitor_fingerprint', visitor_fingerprint.trim())
        .eq('status', 'active')
        .eq('capture_state', 'none')
        .is('contact_id', null)
        .gte('updated_at', new Date(Date.now() - RESUME_WINDOW_MS).toISOString())
        .order('updated_at', { ascending: false })
        .limit(1)
      q = agentId ? q.eq('agent_id', agentId) : q.is('agent_id', null)
      const { data: prior, error: priorErr } = await q.maybeSingle()
      if (priorErr) {
        console.error('[Widget/session] fingerprint-resume read refused:', priorErr.message)
      } else if (prior) {
        const identity = await resolveIdentity(supabase, brokerageId, agentId)
        return NextResponse.json({
          session_token: prior.widget_session_token,
          session_id: prior.id,
          capture_state: prior.capture_state,
          identity,
        })
      }
    }

    // ── Create new session ────────────────────────────────────────────────
    const token = randomUUID()

    const { data: session, error } = await supabase
      .from('chat_sessions')
      .insert({
        brokerage_id: brokerageId,
        agent_id: agentId,
        source,
        visitor_fingerprint: visitor_fingerprint ?? null,
        widget_session_token: token,
        capture_state: 'none',
        status: 'active',
        session_type: 'website_widget',
      })
      .select('id, widget_session_token, capture_state')
      .maybeSingle()

    if (error || !session) {
      console.error('[Widget/session] Insert failed:', error?.message)
      return NextResponse.json({ error: 'Could not create session' }, { status: 500 })
    }

    const identity = await resolveIdentity(supabase, brokerageId, agentId)

    return NextResponse.json({
      session_token: session.widget_session_token,
      session_id: session.id,
      capture_state: session.capture_state,
      identity,
    })
  } catch (err: any) {
    console.error('[Widget/session] Unhandled error:', err?.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// ── Identity resolution: agent → brokerage fallback ──────────────────────────
async function resolveIdentity(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  agentId: string | null
) {
  let profile: any = null

  if (agentId) {
    const { data } = await supabase
      .from('ai_identity_profiles')
      .select('assistant_name, persona_label, tone, faq_knowledge, objection_library, followup_style')
      .eq('scope_type', 'agent')
      .eq('scope_id', agentId)
      .eq('active', true)
      .maybeSingle()
    if (data) profile = data
  }

  if (!profile) {
    const { data } = await supabase
      .from('ai_identity_profiles')
      .select('assistant_name, persona_label, tone, faq_knowledge, objection_library, followup_style')
      .eq('scope_type', 'brokerage')
      .eq('scope_id', brokerageId)
      .eq('active', true)
      .maybeSingle()
    if (data) profile = data
  }

  // Display info. agent_has_did_avatar used to be computed here from
  // agent_voice_profiles and returned to the widget — its ONLY consumer was the
  // "Live Agent" button, retired in m336 because the lane behind it could never
  // have worked. A computed field with no reader is the same dead weight this
  // pass is burning, so it went with the button; the live/voice agent lives on
  // the embed widget, which asks the session route for the real presenter
  // family instead of guessing from a column.
  let displayName = profile?.assistant_name ?? 'Your Real Estate Assistant'
  let brokerageName = ''

  const [agentUserRes, brokerageRes] = await Promise.all([
    // THE AGENT'S NAME, VIA THEIR USERS ROW. agentId here is an AGENTS id — the
    // widget URL is built from agents.id in Settings → Widget, and the
    // ai_identity_profiles (scope_id) and agent_voice_profiles (agent_id)
    // lookups above and below both key on it correctly. This one did not: it
    // queried users.id with an agents.id, which never matches, so displayName
    // silently stayed at the generic assistant name and every website visitor
    // was greeted by "Your Real Estate Assistant" instead of the agent whose
    // widget they were on. Same identity-class confusion that made the retired
    // /api/widget/avatar-session 404 on every call (m336).
    agentId
      ? supabase
          .from('agents')
          .select('users!inner(first_name, last_name)')
          .eq('id', agentId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('brokerages')
      .select('name')
      .eq('id', brokerageId)
      .maybeSingle(),
  ])

  if (agentUserRes.data) {
    const u = (agentUserRes.data as { users?: { first_name?: string | null; last_name?: string | null } }).users
    const agentName = `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim()
    if (agentName) displayName = agentName
  }
  brokerageName = brokerageRes.data?.name ?? ''

  return {
    assistant_name: profile?.assistant_name ?? 'Your Real Estate Assistant',
    persona_label: profile?.persona_label ?? 'AI Real Estate Specialist',
    tone: profile?.tone ?? 'conversational',
    faq_knowledge: profile?.faq_knowledge ?? [],
    followup_style: profile?.followup_style ?? 'warm_persistent',
    display_name: displayName,
    brokerage_name: brokerageName,
  }
}
