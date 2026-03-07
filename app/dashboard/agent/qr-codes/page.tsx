import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import QRCodesClient from './QRCodesClient'

export default async function AgentQRCodesPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('brokerage_id, user_type')
    .eq('user_id', user.id)
    .single()

  if (!profile || !['agent', 'admin', 'broker'].includes(profile.user_type ?? '')) {
    notFound()
  }

  const { data: qrCodes } = await supabase
    .from('qr_codes')
    .select('id, slug, label, purpose, scan_count, lead_count, is_active, created_at')
    .eq('agent_user_id', user.id)
    .order('created_at', { ascending: false })

  return (
    <QRCodesClient
      qrCodes={qrCodes ?? []}
      agentUserId={user.id}
      brokerageId={profile.brokerage_id}
    />
  )
}
