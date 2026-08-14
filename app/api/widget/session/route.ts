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
import { createClient } from '@/lib/supabase/server'
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
