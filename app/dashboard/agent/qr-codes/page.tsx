import { notFound, redirect } from 'next/navigation'
import { getAgentContext } from '@/lib/identity'
import { toCanonicalRoleOrDefault } from '@/lib/security'
import { createClient } from '@/lib/supabase/server'
import QRCodesClient from './QRCodesClient'

export default async function AgentQRCodesPage() {
  // Kernel OS: getAgentContext — canonical identity
  const ctx = await getAgentContext()
  // Signed out → login (not a hard 404 dead-end).
  if (!ctx.isAuthenticated) redirect('/login')

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  if (!['agent', 'team_lead', 'admin', 'broker', 'superadmin'].includes(userRole)) notFound()
  // A signed-in but brokerage-less account (fresh / seed / incomplete) must NOT hit a
  // hard 404 ("Qr codes-404" from the walkthrough) — send them to /dashboard, which
  // self-heals the missing domain records and re-routes.
  if (!ctx.brokerageId) redirect('/dashboard')

  // Agent record is required to create/view QR codes — redirect to setup if missing
  if (!ctx.agentId) redirect('/dashboard/agent/setup')

  const supabase = await createClient()

  const { data: qrCodes } = await supabase
    .from('qr_codes')
    .select('id, slug, label, purpose, target_url, destination_type, listing_id, scan_count, lead_count, is_active, created_at')
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
