import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const VALID_STATUSES = ['identified', 'asked', 'received', 'converting', 'converted', 'lost'] as const
type ReferralStatus = typeof VALID_STATUSES[number]

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { referralId, status } = await req.json() as { referralId: string; status: ReferralStatus }

  if (!referralId || !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Invalid referralId or status' }, { status: 400 })
  }

  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }

  if (status === 'converted') {
    updates.converted_at = new Date().toISOString()
  }

  const { error } = await supabase
    .from('referrals')
    .update(updates)
    .eq('id', referralId)
    .eq('agent_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
