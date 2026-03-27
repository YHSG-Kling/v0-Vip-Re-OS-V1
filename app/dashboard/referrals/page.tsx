import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ReferralsClient } from './referrals-client'

export const metadata = {
  title: 'Referrals & Reviews | Kernel OS',
  description: 'Track your referral pipeline, manage gifting, and follow up on review requests.',
}

export default async function ReferralsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Resolve brokerage_id from user_role_assignments
  const { data: roleRow } = await supabase
    .from('user_role_assignments')
    .select('brokerage_id')
    .eq('user_id', user.id)
    .maybeSingle()

  const brokerageId = roleRow?.brokerage_id

  const [referralsRes, giftingRes, reviewRes] = await Promise.all([
    supabase
      .from('referrals')
      .select(`
        id, referral_name, status, value_estimate, commission_potential,
        source_contact_id, source_contact_name, referred_by,
        created_at, converted_at, gift_sent, thank_you_sent
      `)
      .eq('agent_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50),

    supabase
      .from('referrals')
      .select('id, referral_name, source_contact_id, source_contact_name, converted_at')
      .eq('agent_id', user.id)
      .eq('status', 'converted')
      .eq('gift_sent', false)
      .limit(20),

    brokerageId
      ? supabase
          .from('review_requests')
          .select('id, contact_id, contact_name, status, created_at')
          .eq('agent_id', user.id)
          .eq('status', 'pending')
          .limit(20)
      : Promise.resolve({ data: [] }),
  ])

  const referrals = referralsRes.data ?? []
  const giftingItems = giftingRes.data ?? []
  const reviewRequests = reviewRes.data ?? []

  const converted = referrals.filter(r => r.status === 'converted').length
  const totalValue = referrals.reduce((sum, r) => sum + (r.value_estimate ?? 0), 0)

  return (
    <ReferralsClient
      referrals={referrals as any}
      giftingItems={giftingItems as any}
      reviewRequests={reviewRequests as any}
      roiSummary={{
        totalReferrals: referrals.length,
        converted,
        conversionRate: referrals.length > 0 ? Math.round((converted / referrals.length) * 100) : 0,
        totalValue,
      }}
      agentId={user.id}
    />
  )
}
