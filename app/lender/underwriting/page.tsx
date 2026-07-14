import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileCheck, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function LenderUnderwritingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, property_address, status, client_name, contract_price:purchase_price')
    .eq('status', 'under_contract')
    .limit(20)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/lender/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileCheck className="w-6 h-6 text-indigo-600" />
            Underwriting Queue
          </h1>
          <p className="text-gray-500 text-sm">{transactions?.length || 0} files in underwriting</p>
        </div>
      </div>
      {(!transactions || transactions.length === 0) ? (
        <Card><CardContent className="text-center py-12 text-gray-500">No files currently in underwriting</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {transactions.map((t: any) => (
            <Card key={t.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium">{t.property_address || 'Address TBD'}</p>
                  <p className="text-sm text-gray-500">{t.client_name}</p>
                </div>
                <div className="flex gap-2">
                  {/* Underwriting status moves on the loan file (authorized lender actions live there) */}
                  <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white" asChild>
                    <Link href={`/portal/lender/${t.id}`}>Open loan file</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
