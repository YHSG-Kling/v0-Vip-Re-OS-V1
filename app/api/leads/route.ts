import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)
  
  const leadStage = searchParams.get('leadStage')
  const motivationType = searchParams.get('motivationType')
  const limit = parseInt(searchParams.get('limit') || '50')

  let query = supabase
    .from('leads')
    .select('*')
    .eq('agent_id', agentId)
    .eq('brokerage_id', brokerageId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (leadStage) query = query.eq('lead_stage', leadStage)
  if (motivationType) query = query.eq('motivation_type', motivationType)

  const { data: leads, error } = await query

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    leads: leads || [],
    count: leads?.length || 0
  })
}
