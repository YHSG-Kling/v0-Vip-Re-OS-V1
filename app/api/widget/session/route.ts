'use server'
// POST /api/widget/session
// Creates or resumes a chat_session for an embedded widget.
// Returns session token + resolved AI identity (assistant name, persona, tone).
// No authentication required — widget is public-facing.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { randomUUID } from 'crypto'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      brokerage_id,
      agent_id,
      source = 'website_widget',
      visitor_fingerprint,
      resume_token,
    }: {
      brokerage_id: string
      agent_id?: string | null
      source?: string
      visitor_fingerprint?: string | null
      resume_token?: string | null
    } = body

    if (!brokerage_id) {
      return NextResponse.json({ error: 'brokerage_id required' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // ── Resume existing session if token provided ─────────────────────────
    if (resume_token) {
      const { data: existing } = await supabase
        .from('chat_sessions')
        .select('id, widget_session_token, capture_state, status, brokerage_id, agent_id')
        .eq('widget_session_token', resume_token)
        .eq('brokerage_id', brokerage_id)
        .maybeSingle()

      if (existing && existing.status !== 'closed') {
        const identity = await resolveIdentity(supabase, brokerage_id, agent_id ?? null)
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
        brokerage_id,
        agent_id: agent_id ?? null,
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

    const identity = await resolveIdentity(supabase, brokerage_id, agent_id ?? null)

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

  // Avatar + display info
  let agentHasDIDAvatar = false
  let displayName = profile?.assistant_name ?? 'Your Real Estate Assistant'
  let brokerageName = ''

  const [voiceRes, agentUserRes, brokerageRes] = await Promise.all([
    agentId
      ? supabase
          .from('agent_voice_profiles')
          .select('did_photo_url, did_video_url')
          .eq('agent_id', agentId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    agentId
      ? supabase
          .from('users')
          .select('first_name, last_name')
          .eq('id', agentId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('brokerages')
      .select('name')
      .eq('id', brokerageId)
      .maybeSingle(),
  ])

  if (voiceRes.data) {
    agentHasDIDAvatar = !!(voiceRes.data.did_photo_url || voiceRes.data.did_video_url)
  }
  if (agentUserRes.data) {
    const agentName = `${agentUserRes.data.first_name ?? ''} ${agentUserRes.data.last_name ?? ''}`.trim()
    if (agentName) displayName = agentName
  }
  brokerageName = brokerageRes.data?.name ?? ''

  return {
    assistant_name: profile?.assistant_name ?? 'Your Real Estate Assistant',
    persona_label: profile?.persona_label ?? 'AI Real Estate Specialist',
    tone: profile?.tone ?? 'conversational',
    faq_knowledge: profile?.faq_knowledge ?? [],
    followup_style: profile?.followup_style ?? 'warm_persistent',
    agent_has_did_avatar: agentHasDIDAvatar,
    display_name: displayName,
    brokerage_name: brokerageName,
  }
}
