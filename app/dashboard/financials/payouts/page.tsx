import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Users, ArrowLeft, DollarSign } from 'lucide-react'
import Link from 'next/link'

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
    .select('agent_id, gross_commission, agent_commission, brokerage_split, status, created_at')
    .eq('brokerage_id', profile.brokerage_id)
    .gte('created_at', `${currentYear}-01-01`)
    .order('agent_commission', { ascending: false })
    .limit(50)

  const earningsData = agentEarnings || []
  const totalPayouts = earningsData.reduce((sum: number, e: any) => sum + (e.agent_commission || 0), 0)
  const pendingPayouts = earningsData.filter((e: any) => e.status === 'pending')

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/financials/brokerage"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6 text-purple-600" />
            Agent Payouts — {currentYear}
          </h1>
          <p className="text-gray-500 text-sm">{earningsData.length} payout records</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-purple-600">${totalPayouts.toLocaleString()}</p><p className="text-xs text-gray-500 mt-1">Total Agent Payouts YTD</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-yellow-600">{pendingPayouts.length}</p><p className="text-xs text-gray-500 mt-1">Pending</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-green-600">{earningsData.length - pendingPayouts.length}</p><p className="text-xs text-gray-500 mt-1">Paid</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Payout Records</CardTitle></CardHeader>
        <CardContent>
          {earningsData.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No payout records for {currentYear}</p>
          ) : (
            <div className="space-y-2">
              {earningsData.map((e: any, i: number) => (
                <div key={i} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">Agent #{e.agent_id?.slice(0, 8)}</p>
                    <p className="text-xs text-gray-500">GCI: ${(e.gross_commission || 0).toLocaleString()} · Split: ${(e.brokerage_split || 0).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-purple-600">${(e.agent_commission || 0).toLocaleString()}</span>
                    <Badge variant={e.status === 'paid' ? 'outline' : 'secondary'} className="text-xs">{e.status || 'pending'}</Badge>
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
