import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function TitleClosingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, property_address, close_date, client_name, status, contract_price:purchase_price')
    .not('close_date', 'is', null)
    .order('close_date', { ascending: true })
    .limit(30)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/title/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Calendar className="w-6 h-6 text-purple-600" />
            Closing Schedule
          </h1>
          <p className="text-gray-500 text-sm">{transactions?.length || 0} scheduled closings</p>
        </div>
      </div>
      {(!transactions || transactions.length === 0) ? (
        <Card><CardContent className="text-center py-12 text-gray-500">No closings scheduled</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {transactions.map((t: any) => {
            const closeDate = new Date(t.close_date)
            const daysUntil = Math.ceil((closeDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
            return (
              <Card key={t.id} className={daysUntil <= 3 && daysUntil >= 0 ? 'border-orange-300 bg-orange-50' : ''}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium">{t.property_address}</p>
                    <p className="text-sm text-gray-500">{t.client_name}</p>
                    <p className="text-xs text-gray-400">{closeDate.toLocaleDateString()}</p>
                  </div>
                  <div className="text-right">
                    <Badge className={daysUntil < 0 ? 'bg-gray-100 text-gray-600' : daysUntil <= 3 ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}>
                      {daysUntil < 0 ? 'Past' : daysUntil === 0 ? 'TODAY' : `${daysUntil}d`}
                    </Badge>
                    {t.contract_price && <p className="text-xs text-green-700 font-semibold mt-1">${t.contract_price.toLocaleString()}</p>}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
