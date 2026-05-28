import { notFound, redirect } from 'next/navigation'
import { getAgentContext } from '@/lib/identity'
import { toCanonicalRoleOrDefault } from '@/lib/security'
import { createClient } from '@/lib/supabase/server'
import QRCodesClient from './QRCodesClient'

export default async function AgentQRCodesPage() {
  // Kernel OS: getAgentContext — canonical identity
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) notFound()

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  if (!['agent', 'admin', 'broker', 'superadmin'].includes(userRole)) notFound()
  if (!ctx.brokerageId) notFound()

  // Agent record is required to create/view QR codes — redirect to setup if missing
  if (!ctx.agentId) redirect('/dashboard/agent/setup')

  const supabase = await createClient()

  const { data: qrCodes } = await supabase
    .from('qr_codes')
    .select('id, slug, label, purpose, scan_count, lead_count, is_active, created_at')
    .eq('agent_id', ctx.agentId)
    .order('created_at', { ascending: false })

  return (
    <QRCodesClient
      qrCodes={qrCodes ?? []}
      agentUserId={ctx.agentId}
      brokerageId={ctx.brokerageId}
    />
  )
}
