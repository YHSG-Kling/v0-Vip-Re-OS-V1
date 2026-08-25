import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ensureAgentContextInPlace } from '@/lib/identity/ensure-agent-context'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DollarSign, ArrowLeft, Clock, CheckCircle2, AlertCircle, Landmark } from 'lucide-react'
import Link from 'next/link'
import { PayoutButton } from '@/app/components/features/financial/PayoutButton'
import { ApproveCommissionButton } from '@/app/components/features/financial/ApproveCommissionButton'
import { DepositReceivedButton } from '@/app/components/features/financial/DepositReceivedButton'
import { ExportCSVButton } from '@/app/components/features/financial/ExportCSVButton'
import {
  CommissionIntelligencePanel,
  FinancialActionStack,
  type FinancialAction,
} from '../components/os'

export const dynamic = 'force-dynamic'

export default async function CommissionsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Heal an incomplete account IN PLACE — don't bounce off the Commissions page.
  const context = await ensureAgentContextInPlace()
  if (!context.isAuthenticated) redirect('/login')
  const { agentId, brokerageId, role } = context
  // Heal genuinely couldn't complete (pending invite / non-agent) — honest notice.
  if (!agentId) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Finishing your account setup — refresh in a moment to view your commissions.
      </div>
    )
  }
  const isBrokerAdmin = role === 'broker' || role === 'broker_admin' || role === 'admin' || role === 'superadmin'

  const currentYear = new Date().getFullYear()

  const [commissions, transactions] = await Promise.all([
    supabase
      // KEEP-ONE (m283/m284): agent_commissions is the one commission ledger.
      // net_to_agent is the post-fee take-home when the waterfall engine wrote
      // the row; agent_commission is the generated pre-fee split fallback.
      .from('agent_commissions')
      .select('id, gross_commission, agent_commission, net_to_agent, status, created_at, transaction_id, deposit_received_at')
      .eq('agent_id', agentId)
      .gte('created_at', `${currentYear}-01-01`)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('transactions')
      .select('id, property_address, purchase_price, status, close_date')
      .eq('agent_id', agentId)
      .eq('status', 'closed')
      .gte('close_date', `${currentYear}-01-01`)
      .order('close_date', { ascending: false })
      .limit(50),
  ])

  // Normalize the agent's take-home once: prefer the waterfall's post-fee
  // net_to_agent, fall back to the generated pre-fee split. Every total and row
  // below reads agent_commission, so this is the single place it's resolved.
  const commissionsData = (commissions.data || []).map((c: any) => ({
    ...c,
    agent_commission: c.net_to_agent ?? c.agent_commission ?? 0,
  }))
  const totalGross = commissionsData.reduce((sum: number, c: any) => sum + (c.gross_commission || 0), 0)
  const totalAgent = commissionsData.reduce((sum: number, c: any) => sum + (c.agent_commission || 0), 0)
  const pendingCount = commissionsData.filter((c: any) => c.status === 'pending').length
  const paidCount = commissionsData.filter((c: any) => c.status === 'paid').length
  const totalPending = commissionsData.filter((c: any) => c.status === 'pending').reduce((sum: number, c: any) => sum + (c.agent_commission || 0), 0)

  // Summary + records for the Commission Intelligence panel (it expects a
  // `summary` object and camelCase records — previously omitted, which crashed
  // the page on `summary.pending`).
  const sumBy = (status: string) =>
    commissionsData.filter((c: any) => c.status === status).reduce((s: number, c: any) => s + (c.agent_commission || 0), 0)
  const commissionSummary = {
    pending: pendingCount,
    approved: commissionsData.filter((c: any) => c.status === 'approved').length,
    paid: paidCount,
    held: commissionsData.filter((c: any) => c.status === 'held').length,
    totalPending,
    totalApproved: sumBy('approved'),
    totalPaid: sumBy('paid'),
  }
  const commissionRecords = commissionsData.map((c: any) => ({
    id: c.id,
    transactionId: c.transaction_id ?? '',
    grossCommission: c.gross_commission ?? 0,
    agentNet: c.agent_commission ?? 0,
    status: c.status ?? 'pending',
    createdAt: c.created_at,
  }))

  // Build action stack for commissions view
  const commissionActions: FinancialAction[] = []
  
  if (pendingCount > 0) {
    commissionActions.push({
      id: "pending-commissions",
      title: `${pendingCount} Pending Commission${pendingCount !== 1 ? 's' : ''}`,
      description: `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalPending)} waiting for payment`,
      priority: "high",
      type: "commission",
      value: totalPending,
    })
  }

  commissionActions.push({
    id: "review-earnings",
    title: "View Full Earnings Report",
    description: "Detailed commission and cap tracking",
    priority: "low",
    type: "report",
    href: "/dashboard/financials/agent",
  })

  commissionActions.push({
    id: "view-transactions",
    title: "View Transactions",
    description: `${transactions.data?.length || 0} closed deals this year`,
    priority: "low",
    type: "review",
    href: "/dashboard/transactions",
  })

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/financials/agent"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <DollarSign className="w-7 h-7 text-green-600" />
              Commission Tracker — {currentYear}
            </h1>
            <p className="text-muted-foreground">{commissionsData.length} commission records • {pendingCount} pending • {paidCount} paid</p>
          </div>
        </div>
        <ExportCSVButton agentId={agentId} type="commissions" />
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total GCI</p>
            <p className="text-2xl font-bold text-green-600 mt-1">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalGross)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">My Take-Home</p>
            <p className="text-2xl font-bold text-blue-600 mt-1">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalAgent)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Pending Payment</p>
            <p className="text-2xl font-bold text-yellow-600 mt-1">{pendingCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Split Ratio</p>
            <p className="text-2xl font-bold text-purple-600 mt-1">{totalGross > 0 ? ((totalAgent / totalGross) * 100).toFixed(1) : 0}%</p>
          </CardContent>
        </Card>
      </div>

      {/* Commission Intelligence Panel */}
      <CommissionIntelligencePanel commissions={commissionRecords} summary={commissionSummary} />


      {/* Commission Records Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-green-600" />
            All Commission Records
          </CardTitle>
          <CardDescription>Sorted by date (newest first)</CardDescription>
        </CardHeader>
        <CardContent>
          {commissionsData.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <DollarSign className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No commission records for {currentYear} yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-2 px-2 font-semibold">Date</th>
                    <th className="text-left py-2 px-2 font-semibold">Transaction</th>
                    <th className="text-right py-2 px-2 font-semibold">GCI</th>
                    <th className="text-right py-2 px-2 font-semibold">My Commission</th>
                    <th className="text-center py-2 px-2 font-semibold">Status</th>
                    {isBrokerAdmin && <th className="text-center py-2 px-2 font-semibold">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {commissionsData.map((c: any) => (
                    <tr key={c.id} className="hover:bg-muted/50">
                      <td className="py-3 px-2 text-muted-foreground">{new Date(c.created_at).toLocaleDateString()}</td>
                      <td className="py-3 px-2">Transaction #{c.transaction_id?.slice(0, 8)}</td>
                      <td className="py-3 px-2 text-right font-medium">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(c.gross_commission || 0)}</td>
                      <td className="py-3 px-2 text-right font-semibold text-green-600">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(c.agent_commission || 0)}</td>
                      <td className="py-3 px-2 text-center">
                        <Badge
                          variant={c.status === 'paid' ? 'default' : c.status === 'pending' ? 'secondary' : 'outline'}
                          className="text-xs"
                        >
                          {c.status === 'paid' ? (
                            <>
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              Paid
                            </>
                          ) : c.status === 'approved' ? (
                            <>
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              Approved — ready to pay
                            </>
                          ) : c.status === 'disputed' ? (
                            <>
                              <AlertCircle className="w-3 h-3 mr-1" />
                              Disputed
                            </>
                          ) : c.deposit_received_at ? (
                            <>
                              <Landmark className="w-3 h-3 mr-1" />
                              Deposit received
                            </>
                          ) : (
                            <>
                              <Clock className="w-3 h-3 mr-1" />
                              Awaiting deposit
                            </>
                          )}
                        </Badge>
                      </td>
                      {isBrokerAdmin && (
                        <td className="py-3 px-2 text-center">
                          {/* Close froze the amount → record the deposit → BROKER APPROVES →
                              disburse. The approval step was missing here, and the kernel
                              refuses pending → paid outright, so "Mark as Paid" was rendered
                              on exactly the rows it could never pay. */}
                          {c.status === 'pending' && !c.deposit_received_at && c.transaction_id && (
                            <DepositReceivedButton transactionId={c.transaction_id} />
                          )}
                          {c.status === 'pending' && c.deposit_received_at && (
                            <ApproveCommissionButton
                              commissionId={c.id}
                              brokerageId={brokerageId ?? ''}
                            />
                          )}
                          {c.status === 'approved' && (
                            <PayoutButton
                              commissionId={c.id}
                              brokerageId={brokerageId ?? ''}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Stack */}
      <FinancialActionStack actions={commissionActions} />
    </div>
  )
}
