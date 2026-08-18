import { notFound, redirect } from 'next/navigation'
import { toCanonicalRoleOrDefault } from '@/lib/security'
import { ensureAgentContextInPlace } from '@/lib/identity/ensure-agent-context'
import { loadQrCodesForCaller } from '@/app/actions/qr-management'
// The live qr_codes.purpose CHECK vocabulary, passed down rather than re-typed
// in the client — the minter is server-only, so a hard-coded copy in the form
// would be a second vocabulary that drifts the first time the CHECK changes.
import { QR_PURPOSES } from '@/lib/marketing/tracked-qr'
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
  // notice, not a 404 or a bounce. Only the BROKERAGE is required to render the
  // board: a broker or admin has no agents row and still owns every code in it.
  if (!ctx.brokerageId) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Finishing your account setup — refresh in a moment to manage your QR codes.
      </div>
    )
  }

  // The scope decision (own codes / team / brokerage) lives in the action, next
  // to the queries it narrows — see app/actions/qr-management.ts.
  const data = await loadQrCodesForCaller()
  if (!data.ok) {
    return (
      <div className="p-8 text-center text-sm text-destructive" role="alert">
        {data.error}
      </div>
    )
  }

  return (
    <QRCodesClient
      qrCodes={data.codes}
      campaigns={data.campaigns}
      linkableCampaigns={data.linkableCampaigns}
      purposes={[...QR_PURPOSES]}
      scope={data.scope}
      scopeLabel={data.scopeLabel}
      agentUserId={ctx.agentId}
      brokerageId={ctx.brokerageId}
    />
  )
}
