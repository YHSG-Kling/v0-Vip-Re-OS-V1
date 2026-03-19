import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Users, ArrowLeft, DollarSign, TrendingDown, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import {
  PayoutReadinessPanel,
  FinancialActionStack,
  type FinancialAction,
} from '../components/os'

export const dynamic = 'force-dynamic'

export default async function PayoutsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('users').select('brokerage_id, role').eq('id', user.id).single()
  if (!profile?.brokerage_id) redirect('/dashboard')

  const allowedRoles = ['broker', 'admin', 'superadmin', 'team_lead']
  if (!allowedRoles.includes(profile.role)) redirect('/dashboard/financials/agent')

  const currentYear = new Date().getFullYear()

  const { data: agentEarnings } = await supabase
    .from('agent_earnings')
    .select(`
      agent_id,
      gross_commission,
      agent_commission,
      brokerage_split,
      status,
      created_at,
      users!agent_id (
        first_name,
        last_name
      )
    `)
    .eq('brokerage_id', profile.brokerage_id)
    .gte('created_at', `${currentYear}-01-01`)
    .order('agent_commission', { ascending: false })
    .limit(100)

  const earningsData = agentEarnings || []
  const totalPayouts = earningsData.reduce((sum: number, e: any) => sum + (e.agent_commission || 0), 0)
  const totalBrokerageSplit = earningsData.reduce((sum: number, e: any) => sum + (e.brokerage_split || 0), 0)
  const pendingPayouts = earningsData.filter((e: any) => e.status === 'pending')
  const paidPayouts = earningsData.filter((e: any) => e.status === 'paid')

  // Get agent count and identify high-earning agents
  const uniqueAgents = new Set(earningsData.map(e => e.agent_id))
  const agentCount = uniqueAgents.size

  // Build payout action stack
  const payoutActions: FinancialAction[] = []

  if (pendingPayouts.length > 0) {
    const pendingAmount = pendingPayouts.reduce((sum: number, e: any) => sum + (e.agent_commission || 0), 0)
    payoutActions.push({
      id: "process-payouts",
      title: `Process ${pendingPayouts.length} Pending Payout${pendingPayouts.length !== 1 ? 's' : ''}`,
      description: `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(pendingAmount)} ready to pay`,
      priority: pendingPayouts.length > 5 ? "urgent" : "high",
      type: "payout",
      value: pendingAmount,
    })
  }

  payoutActions.push({
    id: "view-agent-earnings",
    title: "View Agent Earnings",
    description: `Detailed breakdown for ${agentCount} agents`,
    priority: "medium",
    type: "review",
    href: "/dashboard/financials/team",
  })

  payoutActions.push({
    id: "configure-caps",
    title: "Configure Cap Structure",
    description: "Manage commission caps and splits",
    priority: "low",
    type: "budget",
    href: "/dashboard/financials/commissions",
  })

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/dashboard/financials/brokerage"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Users className="w-7 h-7 text-purple-600" />
            Agent Payouts — {currentYear}
          </h1>
          <p className="text-muted-foreground">{earningsData.length} payout records • {agentCount} active agents • {pendingPayouts.length} pending</p>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Agent Payouts</p>
            <p className="text-2xl font-bold text-purple-600 mt-1">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalPayouts)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Brokerage Split</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalBrokerageSplit)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Pending Payouts</p>
            <p className="text-2xl font-bold text-yellow-600 mt-1">{pendingPayouts.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Paid Payouts</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{paidPayouts.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Payout Readiness Panel */}
      <PayoutReadinessPanel
        brokerageId={profile.brokerage_id}
        agentCount={agentCount}
      />

      {/* Payout Records Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-purple-600" />
            All Payout Records
          </CardTitle>
          <CardDescription>Sorted by commission amount (highest first)</CardDescription>
        </CardHeader>
        <CardContent>
          {earningsData.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No payout records for {currentYear}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-2 px-2 font-semibold">Agent</th>
                    <th className="text-right py-2 px-2 font-semibold">GCI</th>
                    <th className="text-right py-2 px-2 font-semibold">Agent Commission</th>
                    <th className="text-right py-2 px-2 font-semibold">Brokerage Split</th>
                    <th className="text-center py-2 px-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {earningsData.map((e: any, i: number) => (
                    <tr key={i} className="hover:bg-muted/50">
                      <td className="py-3 px-2 font-medium">
                        {e.users?.first_name && e.users?.last_name 
                          ? `${e.users.first_name} ${e.users.last_name}`
                          : `Agent ${e.agent_id?.slice(0, 8)}`}
                      </td>
                      <td className="py-3 px-2 text-right">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(e.gross_commission || 0)}</td>
                      <td className="py-3 px-2 text-right font-semibold text-purple-600">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(e.agent_commission || 0)}</td>
                      <td className="py-3 px-2 text-right font-semibold text-green-600">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(e.brokerage_split || 0)}</td>
                      <td className="py-3 px-2 text-center">
                        <Badge 
                          variant={e.status === 'paid' ? 'default' : 'secondary'}
                          className="text-xs"
                        >
                          {e.status === 'paid' ? 'Paid' : 'Pending'}
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

      {/* Action Stack */}
      <FinancialActionStack actions={payoutActions} />
    </div>
  )
}
