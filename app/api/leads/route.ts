import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)
  
  const brokerageId = searchParams.get('brokerageId')
  const leadStage = searchParams.get('leadStage')
  const motivationType = searchParams.get('motivationType')
  const agentId = searchParams.get('agentId')
  const limit = parseInt(searchParams.get('limit') || '50')

  if (!brokerageId) {
    return NextResponse.json(
      { error: 'brokerageId is required' },
      { status: 400 }
    )
  }

  let query = supabase
    .from('leads')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (leadStage) query = query.eq('lead_stage', leadStage)
  if (motivationType) query = query.eq('motivation_type', motivationType)
  if (agentId) query = query.eq('agent_id', agentId)

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
