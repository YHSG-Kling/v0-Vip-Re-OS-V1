// POST /api/widget/capture-lead
// Called by the widget client when the visitor submits the capture form
// (name / email / phone / intent). Upserts a lead into public.leads and
// updates chat_session.capture_state → 'captured'.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      session_token,
      first_name,
      last_name,
      email,
      phone,
      intent_type,
      notes,
    }: {
      session_token: string
      first_name?: string | null
      last_name?: string | null
      email?: string | null
      phone?: string | null
      intent_type?: 'buyer' | 'seller' | 'unknown'
      notes?: string | null
    } = body

    if (!session_token) {
      return NextResponse.json({ error: 'session_token required' }, { status: 400 })
    }

    // Must have at minimum email or phone
    if (!email && !phone) {
      return NextResponse.json({ error: 'email or phone required' }, { status: 422 })
    }

    const supabase = createServiceClient()

    // ── Validate session ──────────────────────────────────────────────────
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('id, brokerage_id, agent_id, status')
      .eq('widget_session_token', session_token)
      .single()

    if (!session || session.status === 'closed') {
      return NextResponse.json({ error: 'Invalid or closed session' }, { status: 403 })
    }

    // ── Resolve assigned agent ────────────────────────────────────────────
    // If no agent on session, try to find the round-robin agent for the brokerage
    let assignedAgentId = session.agent_id
    if (!assignedAgentId) {
      const { data: brokerageUser } = await supabase
        .from('users')
        .select('id')
        .eq('brokerage_id', session.brokerage_id)
        .eq('role', 'agent')
        .eq('status', 'active')
        .limit(1)
        .maybeSingle()
      if (brokerageUser) assignedAgentId = brokerageUser.id
    }

    // ── Build identity key for dedup ──────────────────────────────────────
    const identityKey = [
      (first_name ?? '').toLowerCase().trim(),
      (last_name ?? '').toLowerCase().trim(),
      (email ?? '').toLowerCase().trim(),
    ]
      .filter(Boolean)
      .join('|')

    // ── Upsert lead ───────────────────────────────────────────────────────
    // Check for existing lead with same email in same brokerage first
    let leadId: string | null = null

    if (email) {
      const { data: existing } = await supabase
        .from('leads')
        .select('id')
        .eq('brokerage_id', session.brokerage_id)
        .eq('email', email)
        .maybeSingle()
      if (existing) leadId = existing.id
    }

    if (!leadId && phone) {
      const { data: existing } = await supabase
        .from('leads')
        .select('id')
        .eq('brokerage_id', session.brokerage_id)
        .eq('phone', phone)
        .maybeSingle()
      if (existing) leadId = existing.id
    }

    if (leadId) {
      // Update existing lead — don't overwrite already-set fields
      await supabase
        .from('leads')
        .update({
          ...(first_name && { first_name }),
          ...(last_name && { last_name }),
          ...(email && { email }),
          ...(phone && { phone }),
          ...(intent_type && { intent_type }),
          source: 'website_widget',
          lifecycle_state: 'unconsented',
          ai_isa_owner: true,
          minimum_viable_for_isa: true,
          assigned_owner: assignedAgentId ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', leadId)
    } else {
      // Insert new lead
      const { data: newLead, error: insertErr } = await supabase
        .from('leads')
        .insert({
          brokerage_id: session.brokerage_id,
          first_name: first_name ?? null,
          last_name: last_name ?? null,
          email: email ?? null,
          phone: phone ?? null,
          intent_type: intent_type ?? 'unknown',
          lead_source: 'website_widget',
          source: 'website_widget',
          notes: notes ?? null,
          identity_key: identityKey || null,
          lifecycle_state: 'unconsented',
          ai_isa_owner: true,
          minimum_viable_for_isa: true,
          assigned_owner: assignedAgentId ?? null,
          tcpa_consent: false,
          preferred_channel: email ? 'email' : 'sms',
        })
        .select('id')
        .single()

      if (insertErr) {
        console.error('[Widget/capture-lead] Lead insert error:', insertErr.message)
        return NextResponse.json({ error: 'Could not capture lead' }, { status: 500 })
      }
      leadId = newLead?.id ?? null
    }

    // ── Update session capture state ──────────────────────────────────────
    await supabase
      .from('chat_sessions')
      .update({
        capture_state: 'captured',
        lead_id: leadId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.id)

    return NextResponse.json({ success: true, lead_id: leadId })
  } catch (err: any) {
    console.error('[Widget/capture-lead] Unhandled error:', err?.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
