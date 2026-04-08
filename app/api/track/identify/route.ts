// POST /api/track/identify
// Body: { sessionId, email?, phone?, brokerageId }
// RULE: No contact creation here. Only links existing lead/contact to session.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { processKernelEvent } from '@/lib/kernel'
import { KernelEvent } from '@/lib/kernel/events'

export const dynamic = 'force-dynamic'

type IdentifyBody = {
  sessionId:   string
  brokerageId: string
  email?:      string | null
  phone?:      string | null
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: IdentifyBody

  try {
    body = (await req.json()) as IdentifyBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { sessionId, brokerageId, email, phone } = body

  if (!sessionId || !brokerageId) {
    return NextResponse.json({ error: 'sessionId and brokerageId are required' }, { status: 400 })
  }

  if (!email && !phone) {
    return NextResponse.json({ identified: false, reason: 'no_identifiers' })
  }

  const supabase = createServiceClient()

  // Fetch the visitor row first
  const { data: visitor } = await supabase
    .from('website_visitors')
    .select('id, lead_id, contact_id')
    .eq('session_id', sessionId)
    .eq('brokerage_id', brokerageId)
    .maybeSingle()

  if (!visitor) {
    return NextResponse.json({ identified: false, reason: 'session_not_found' })
  }

  // Already identified — return early
  if (visitor.contact_id || visitor.lead_id) {
    return NextResponse.json({ identified: true, reason: 'already_identified' })
  }

  const now = new Date().toISOString()

  // ── Step 1: Try contacts match ──────────────────────────────────────────────
  let contactId: string | null = null
  let leadId: string | null = null

  if (email || phone) {
    const filters: string[] = []
    if (email) filters.push(`email.eq.${email}`)
    if (phone) filters.push(`phone.eq.${phone}`)

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('brokerage_id', brokerageId)
      .or(filters.join(','))
      .limit(1)
      .maybeSingle()

    if (contact) contactId = contact.id
  }

  // ── Step 2: Try leads match (is_active=true) ────────────────────────────────
  if (!contactId && (email || phone)) {
    const filters: string[] = []
    if (email) filters.push(`email.eq.${email}`)
    if (phone) filters.push(`phone.eq.${phone}`)

    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('brokerage_id', brokerageId)
      .eq('is_active', true)
      .or(filters.join(','))
      .limit(1)
      .maybeSingle()

    if (lead) leadId = lead.id
  }

  // ── Step 3: Update visitor row if matched ────────────────────────────────────
  if (!contactId && !leadId) {
    return NextResponse.json({ identified: false, reason: 'no_match' })
  }

  const updatePayload: Record<string, string> = { identified_at: now }
  if (contactId) updatePayload['contact_id'] = contactId
  if (leadId)    updatePayload['lead_id']    = leadId

  await supabase
    .from('website_visitors')
    .update(updatePayload)
    .eq('id', visitor.id)

  // ── Step 4: Emit lifecycle event ─────────────────────────────────────────────
  try {
    const entityId   = contactId ?? leadId!
    const entityType = contactId ? 'contact' : 'lead'

    await processKernelEvent({
      brokerageId,
      entityType,
      entityId,
      event:    KernelEvent.WEBSITE_VISITOR_IDENTIFIED,
      contextJson:  JSON.stringify({ sessionId, email: email ?? null, phone: phone ?? null }),
      triggeredBy:  'system',
    })
  } catch {
    // Non-fatal: identification is already recorded
  }

  return NextResponse.json({ identified: true })
}
