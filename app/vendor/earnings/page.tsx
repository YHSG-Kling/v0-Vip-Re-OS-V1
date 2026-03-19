import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getVendorCostComparison } from '@/app/actions/vendor-marketplace'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DollarSign, ArrowLeft, TrendingUp } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function VendorEarningsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  let costData: any = null
  try { costData = await getVendorCostComparison() } catch { costData = null }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/vendor/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-green-600" />
            My Earnings
          </h1>
          <p className="text-gray-500 text-sm">Revenue and payment history</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="p-4 text-center"><p className="text-3xl font-bold text-green-600">$0</p><p className="text-xs text-gray-500 mt-1">Total Earned</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-3xl font-bold text-blue-600">$0</p><p className="text-xs text-gray-500 mt-1">Pending Payment</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-3xl font-bold text-purple-600">$0</p><p className="text-xs text-gray-500 mt-1">This Month</p></CardContent></Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Payment History</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500 text-center py-8">Payment history will appear here as jobs are completed and invoiced.</p>
        </CardContent>
      </Card>
    </div>
  )
}
