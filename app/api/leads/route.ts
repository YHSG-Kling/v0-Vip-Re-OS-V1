import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/kernel/api-auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Auth guard — agentId and brokerageId always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(request.url)
  const leadStage = searchParams.get('leadStage')
  const motivationType = searchParams.get('motivationType')
  const limit = parseInt(searchParams.get('limit') || '50')

  // ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY. Agents do not
  // have direct visibility on `leads` — lead lineage reaches them via the
  // `contacts` row and the `contact_lead_history` view. team_lead / TC /
  // compliance_officer are ALSO excluded (they work contacts, not the lead
  // desk). Reject here so we don't return a misleading empty array.
  const leadVisibleRoles = ['broker', 'broker_owner', 'broker_admin', 'admin', 'superadmin', 'support']
  if (!leadVisibleRoles.includes(auth.userType)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let query = supabase
    .from('leads')
    .select('*')
    .eq('brokerage_id', auth.brokerageId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (leadStage) query = query.eq('lead_stage', leadStage)
  if (motivationType) query = query.eq('motivation_type', motivationType)

  const { data: leads, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    leads: leads || [],
    count: leads?.length || 0,
  })
}
