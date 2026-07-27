import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Users, ArrowLeft, DollarSign, CheckCircle2, Clock } from 'lucide-react'
import Link from 'next/link'
import {
  PayoutReadinessPanel,
  FinancialActionStack,
  type FinancialAction,
} from '../components/os'
import { loadCommissionQueueAction } from '@/app/actions/financial-kernel'
import { CommissionDisputeQueue } from '../components/commission-dispute-queue'
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = 'force-dynamic'

export default async function PayoutsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // user_type not role
  const { data: profile } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect('/dashboard')

  const allowedRoles = ['broker', 'admin', 'superadmin', 'team_lead']
  if (!allowedRoles.includes(profile.user_type ?? '')) {
    redirect('/dashboard/financials/agent')
  }

  // Load commission queue via kernel command
  const commissionQueueResult = await loadCommissionQueueAction({
    brokerageId: profile.brokerage_id,
  })

  if (!commissionQueueResult.success) {
    redirect('/dashboard')
  }

  const queueData = commissionQueueResult.data as any

  // Extract data from kernel result
  const commissionsData = queueData?.commissions ?? (Array.isArray(commissionQueueResult.data) ? commissionQueueResult.data : [])
  const agentNameMap: Record<string, string> = queueData?.agentNameMap ?? {}
  const totalAgentPayouts: number = queueData?.totalAgentPayouts ?? 0
  const totalBrokerageNet: number = queueData?.totalBrokerageNet ?? 0
  const pendingPayouts: any[] = queueData?.pendingPayouts ?? (commissionsData as any[]).filter((c: any) => c.status !== 'paid')
  const paidPayouts: any[] = queueData?.paidPayouts ?? (commissionsData as any[]).filter((c: any) => c.status === 'paid')
  const agentCount: number = queueData?.agentCount ?? 0

  function agentName(c: any) {
    return agentNameMap[c.agent_id] || `Agent ${(c.agent_id ?? '').slice(0, 8)}`
  }

  // Build payout action stack
  const payoutActions: FinancialAction[] = []

  if (pendingPayouts.length > 0) {
    const pendingAmount = pendingPayouts.reduce((s: number, c: any) => s + (c.agent_commission ?? 0), 0)
    payoutActions.push({
      id: 'process-payouts',
      title: `Process ${pendingPayouts.length} Pending Payout${pendingPayouts.length !== 1 ? 's' : ''}`,
      description: `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(pendingAmount)} ready to pay`,
      priority: pendingPayouts.length > 5 ? 'urgent' : 'high',
      type: 'payout',
      value: pendingAmount,
    })
  }

  payoutActions.push({
    id: 'view-agent-earnings',
    title: 'View Agent Earnings',
    description: `Detailed breakdown for ${agentCount} agents`,
    priority: 'medium',
    type: 'review',
    href: '/dashboard/financials/team',
  })

  payoutActions.push({
    id: 'configure-caps',
    title: 'Configure Cap Structure',
    description: 'Manage commission caps and splits',
    priority: 'low',
    type: 'budget',
    href: '/dashboard/financials/commissions',
  })

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

  const currentYear = new Date().getFullYear()

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/dashboard/financials/brokerage">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Users className="w-7 h-7 text-purple-600" />
            Agent Payouts — {currentYear}
          </h1>
          <p className="text-muted-foreground">
            {commissionsData.length} commission records &bull; {agentCount} agents &bull; {pendingPayouts.length} pending
          </p>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Agent Payouts</p>
            <p className="text-2xl font-bold text-purple-600 mt-1">{fmt(totalAgentPayouts)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Brokerage Net</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{fmt(totalBrokerageNet)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Pending</p>
            <p className="text-2xl font-bold text-yellow-600 mt-1">{pendingPayouts.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Paid</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{paidPayouts.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Payout Readiness Panel */}
      <PayoutReadinessPanel
        files={[]}
        summary={{
          ready: 0,
          blocked: 0,
          pendingReview: pendingPayouts.length,
          processing: 0,
          totalReady: totalAgentPayouts,
          totalBlocked: 0,
        }}
      />

      {/* Disputed commissions awaiting broker resolution (uphold / correct / reopen). */}
      <CommissionDisputeQueue brokerageId={profile.brokerage_id} />

      {/* Commission Records */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-purple-600" />
            All Commission Records
          </CardTitle>
          <CardDescription>Sorted by agent commission (highest first)</CardDescription>
        </CardHeader>
        <CardContent>
          {commissionsData.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No commission records for {currentYear}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-2 px-2 font-semibold">Agent</th>
                    <th className="text-left py-2 px-2 font-semibold">Close Date</th>
                    <th className="text-right py-2 px-2 font-semibold">GCI</th>
                    <th className="text-right py-2 px-2 font-semibold">Agent</th>
                    <th className="text-right py-2 px-2 font-semibold">Brokerage</th>
                    <th className="text-center py-2 px-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {commissionsData.map((c: any) => (
                    <tr key={c.id} className="hover:bg-muted/50">
                      <td className="py-3 px-2 font-medium">{agentName(c)}</td>
                      <td className="py-3 px-2 text-muted-foreground">
                        {c.close_date ? new Date(c.close_date).toLocaleDateString() : '—'}
                      </td>
                      <td className="py-3 px-2 text-right">{fmt(c.gross_commission ?? 0)}</td>
                      <td className="py-3 px-2 text-right font-semibold text-purple-600">{fmt(c.agent_commission ?? 0)}</td>
                      <td className="py-3 px-2 text-right font-semibold text-green-600">{fmt(c.brokerage_commission ?? 0)}</td>
                      <td className="py-3 px-2 text-center">
                        <Badge variant={c.status === 'paid' ? 'default' : 'secondary'} className="text-xs">
                          {c.status === 'paid'
                            ? <><CheckCircle2 className="w-3 h-3 mr-1 inline" />Paid</>
                            : <><Clock className="w-3 h-3 mr-1 inline" />Pending</>}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <FinancialActionStack actions={payoutActions} />
    </div>
  )
}
