import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TrendingUp, ArrowLeft, DollarSign } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function LenderPipelinePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, property_address, status, contract_price:purchase_price, client_name, close_date, transaction_type:deal_type, created_at')
    .order('close_date', { ascending: true })
    .limit(50)

  const statusGroups: Record<string, any[]> = {}
  ;(transactions || []).forEach((t: any) => {
    const key = t.status || 'unknown'
    if (!statusGroups[key]) statusGroups[key] = []
    statusGroups[key].push(t)
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/lender/dashboard">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-blue-600" />
            Loan Pipeline
          </h1>
          <p className="text-gray-500 text-sm">{transactions?.length || 0} active loans</p>
        </div>
      </div>

      {Object.entries(statusGroups).map(([status, items]) => (
        <div key={status}>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
            {status.replace(/_/g, ' ')}
            <Badge variant="outline">{items.length}</Badge>
          </h3>
          <div className="space-y-2">
            {items.map((t: any) => (
              <Card key={t.id}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium">{t.property_address || 'Address TBD'}</p>
                    <p className="text-sm text-gray-500">{t.client_name} · {t.transaction_type}</p>
                    {t.close_date && <p className="text-xs text-gray-400">Close: {new Date(t.close_date).toLocaleDateString()}</p>}
                  </div>
                  <div className="text-right">
                    {t.contract_price && (
                      <p className="font-semibold text-green-700">${t.contract_price.toLocaleString()}</p>
                    )}
                    <Badge variant="outline" className="text-xs">{status}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}

      {(!transactions || transactions.length === 0) && (
        <Card>
          <CardContent className="text-center py-12 text-gray-500">
            No active loans in your pipeline
          </CardContent>
        </Card>
      )}
    </div>
  )
}
