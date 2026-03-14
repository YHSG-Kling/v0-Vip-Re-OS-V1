import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Receipt, ArrowLeft, Plus } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ExpensesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const currentYear = new Date().getFullYear()

  const { data: expenses } = await supabase
    .from('agent_expenses')
    .select('id, category, amount, description, date, receipt_url')
    .eq('user_id', user.id)
    .gte('date', `${currentYear}-01-01`)
    .order('date', { ascending: false })
    .limit(50)

  const expenseData = expenses || []
  const totalExpenses = expenseData.reduce((sum: number, e: any) => sum + (e.amount || 0), 0)

  const byCategory: Record<string, number> = {}
  expenseData.forEach((e: any) => {
    const cat = e.category || 'Other'
    byCategory[cat] = (byCategory[cat] || 0) + (e.amount || 0)
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/financials/agent"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Receipt className="w-6 h-6 text-orange-600" />
              Business Expenses — {currentYear}
            </h1>
            <p className="text-gray-500 text-sm">Track and categorize your business expenses</p>
          </div>
        </div>
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">
          <Plus className="w-4 h-4 mr-2" />
          Add Expense
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-orange-600">${totalExpenses.toLocaleString()}</p><p className="text-xs text-gray-500 mt-1">Total Expenses YTD</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><p className="text-2xl font-bold text-blue-600">{expenseData.length}</p><p className="text-xs text-gray-500 mt-1">Total Records</p></CardContent></Card>
      </div>

      {Object.keys(byCategory).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">By Category</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(byCategory).sort(([, a], [, b]) => b - a).map(([cat, amount]) => (
                <div key={cat} className="flex items-center justify-between p-2 bg-orange-50 rounded-lg">
                  <span className="text-sm">{cat}</span>
                  <span className="text-sm font-semibold">${amount.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Expense Records</CardTitle></CardHeader>
        <CardContent>
          {expenseData.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No expenses recorded for {currentYear}</p>
          ) : (
            <div className="space-y-2">
              {expenseData.map((e: any) => (
                <div key={e.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{e.description || 'Business Expense'}</p>
                    <p className="text-xs text-gray-500">{e.date} · {e.category}</p>
                  </div>
                  <span className="text-sm font-semibold text-orange-600">${(e.amount || 0).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
