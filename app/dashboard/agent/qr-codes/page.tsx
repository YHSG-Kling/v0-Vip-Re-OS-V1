import { notFound, redirect } from 'next/navigation'
import { toCanonicalRoleOrDefault } from '@/lib/security'
import { createClient } from '@/lib/supabase/server'
import { ensureAgentContextInPlace } from '@/lib/identity/ensure-agent-context'
import QRCodesClient from './QRCodesClient'

export default async function AgentQRCodesPage() {
  // Kernel OS identity, self-healing an incomplete account IN PLACE so a
  // brokerage-less agent never hits the old "Qr codes-404" and is never bounced
  // off the page to /dashboard — the records get provisioned right here.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect('/login')

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  if (!['agent', 'team_lead', 'admin', 'broker', 'superadmin'].includes(userRole)) notFound()

  // Heal genuinely couldn't complete (pending invite / non-agent) — honest in-place
  // notice, not a 404 or a bounce.
  if (!ctx.brokerageId || !ctx.agentId) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Finishing your account setup — refresh in a moment to manage your QR codes.
      </div>
    )
  }

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
