import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CheckCircle2, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function LenderApprovalsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, property_address, status, client_name, close_date, contract_price')
    .in('status', ['pending', 'under_contract'])
    .order('close_date', { ascending: true })
    .limit(30)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/lender/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CheckCircle2 className="w-6 h-6 text-green-600" />
            Loan Approvals
          </h1>
          <p className="text-gray-500 text-sm">{transactions?.length || 0} pending approval{(transactions?.length || 0) !== 1 ? 's' : ''}</p>
        </div>
      </div>
      {(!transactions || transactions.length === 0) ? (
        <Card><CardContent className="text-center py-12 text-gray-500">No pending approvals</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {transactions.map((t: any) => (
            <Card key={t.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium">{t.property_address || 'Address TBD'}</p>
                  <p className="text-sm text-gray-500">{t.client_name}</p>
                  {t.close_date && <p className="text-xs text-gray-400">Close: {new Date(t.close_date).toLocaleDateString()}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {t.contract_price && <span className="font-semibold text-green-700 text-sm">${t.contract_price.toLocaleString()}</span>}
                  <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white">Approve</Button>
                  <Button size="sm" variant="outline">Review</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
