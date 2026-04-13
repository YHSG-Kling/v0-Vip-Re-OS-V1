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

  let query = supabase
    .from('leads')
    .select('*')
    .eq('brokerage_id', auth.brokerageId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  // For agent-type users, scope to their own leads.
  // Brokers/admins see all leads within the brokerage.
  if (auth.agentId && !['broker', 'admin', 'superadmin'].includes(auth.userType)) {
    query = query.eq('agent_id', auth.agentId)
  }

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
