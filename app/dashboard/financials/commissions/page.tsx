import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DollarSign, ArrowLeft, TrendingUp } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function CommissionsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  let context: any = null
  try { context = await getAgentContext() } catch { redirect('/login') }
  const { agentId, brokerageId } = context

  const currentYear = new Date().getFullYear()

  const [commissions, transactions] = await Promise.all([
    supabase
      .from('commissions')
      .select('id, gross_commission, agent_commission, status, created_at, transaction_id')
      .eq('agent_id', agentId)
      .gte('created_at', `${currentYear}-01-01`)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('transactions')
      .select('id, property_address, contract_price, status, close_date')
      .eq('agent_id', agentId)
      .eq('status', 'closed')
      .gte('close_date', `${currentYear}-01-01`)
      .order('close_date', { ascending: false })
      .limit(20),
  ])

  const commissionsData = commissions.data || []
  const totalGross = commissionsData.reduce((sum: number, c: any) => sum + (c.gross_commission || 0), 0)
  const totalAgent = commissionsData.reduce((sum: number, c: any) => sum + (c.agent_commission || 0), 0)
  const pendingCount = commissionsData.filter((c: any) => c.status === 'pending').length

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/financials/agent"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-green-600" />
            Commission Tracker — {currentYear}
          </h1>
          <p className="text-gray-500 text-sm">{commissionsData.length} commission records this year</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-green-600">${totalGross.toLocaleString()}</p><p className="text-xs text-gray-500 mt-1">Total GCI</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-blue-600">${totalAgent.toLocaleString()}</p><p className="text-xs text-gray-500 mt-1">My Take-Home</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-yellow-600">{pendingCount}</p><p className="text-xs text-gray-500 mt-1">Pending Payment</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Commission Records</CardTitle></CardHeader>
        <CardContent>
          {commissionsData.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No commission records for {currentYear} yet</p>
          ) : (
            <div className="space-y-2">
              {commissionsData.map((c: any) => (
                <div key={c.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">Transaction #{c.transaction_id?.slice(0, 8)}</p>
                    <p className="text-xs text-gray-500">{new Date(c.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-3 text-right">
                    <div>
                      <p className="text-sm font-semibold text-green-600">${(c.agent_commission || 0).toLocaleString()}</p>
                      <p className="text-xs text-gray-400">GCI: ${(c.gross_commission || 0).toLocaleString()}</p>
                    </div>
                    <Badge variant={c.status === 'paid' ? 'outline' : 'secondary'} className="text-xs">{c.status || 'pending'}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
