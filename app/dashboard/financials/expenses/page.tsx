import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Receipt, ArrowLeft, TrendingDown } from 'lucide-react'
import Link from 'next/link'
import {
  ExpenseIntelligencePanel,
  FinancialActionStack,
  type FinancialAction,
} from '../components/os'
import { AddExpenseDialog } from './components/add-expense-dialog'

export const dynamic = 'force-dynamic'

export default async function ExpensesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const currentYear = new Date().getFullYear()
  const currentMonth = new Date().getMonth() + 1

  // business_expenses uses agent_id and expense_date (not date)
  const { data: expenses } = await supabase
    .from('business_expenses')
    .select('id, category, amount, description, expense_date, receipt_url')
    .eq('agent_id', user.id)
    .gte('expense_date', `${currentYear}-01-01`)
    .order('expense_date', { ascending: false })
    .limit(100)

  const expenseData = expenses || []
  const totalExpenses = expenseData.reduce((sum: number, e: any) => sum + (e.amount || 0), 0)
  const mtdExpenses = expenseData.filter(e => {
    const expenseMonth = new Date(e.expense_date ?? e.date).getMonth() + 1
    return expenseMonth === currentMonth
  }).reduce((sum: number, e: any) => sum + (e.amount || 0), 0)

  const byCategory: Record<string, { total: number; count: number }> = {}
  expenseData.forEach((e: any) => {
    const cat = e.category || 'Other'
    if (!byCategory[cat]) byCategory[cat] = { total: 0, count: 0 }
    byCategory[cat].total += (e.amount || 0)
    byCategory[cat].count += 1
  })

  // Build action stack
  const expenseActions: FinancialAction[] = [
    {
      id: "add-expense",
      title: "Log New Expense",
      description: "Track business expenses for tax deductions",
      priority: "high",
      type: "expense",
    },
    {
      id: "review-deductions",
      title: "Review Tax Deductions",
      description: `${totalExpenses > 0 ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalExpenses) : "$0"} in deductions this year`,
      priority: "medium",
      type: "report",
      value: totalExpenses,
      href: "/dashboard/financials/agent",
    },
  ]

  if (mtdExpenses > 500) {
    expenseActions.unshift({
      id: "high-mtd-expenses",
      title: "MTD Expenses Above Typical",
      description: `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(mtdExpenses)} this month - review spending`,
      priority: "medium",
      type: "budget",
      value: mtdExpenses,
    })
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/financials/agent"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Receipt className="w-7 h-7 text-orange-600" />
              Business Expenses — {currentYear}
            </h1>
            <p className="text-muted-foreground">Track and categorize your business expenses for tax purposes</p>
          </div>
        </div>
        <AddExpenseDialog agentId={user.id} />
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total YTD</p>
            <p className="text-2xl font-bold text-orange-600 mt-1">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalExpenses)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">MTD</p>
            <p className="text-2xl font-bold text-yellow-600 mt-1">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(mtdExpenses)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Records</p>
            <p className="text-2xl font-bold text-blue-600 mt-1">{expenseData.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Categories</p>
            <p className="text-2xl font-bold text-purple-600 mt-1">{Object.keys(byCategory).length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Expense Intelligence Panel */}
      <ExpenseIntelligencePanel expenses={expenseData} userId={user.id} />

      {/* Category Breakdown */}
      {Object.keys(byCategory).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingDown className="w-5 h-5 text-orange-600" />
              Expenses by Category
            </CardTitle>
            <CardDescription>YTD breakdown showing where you're spending</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(byCategory)
                .sort(([, a], [, b]) => b.total - a.total)
                .map(([cat, data]) => (
                  <div key={cat} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{cat}</span>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-orange-600">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(data.total)}</p>
                        <p className="text-xs text-muted-foreground">{data.count} transaction{data.count !== 1 ? 's' : ''}</p>
                      </div>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div
                        className="bg-orange-500 h-2 rounded-full"
                        style={{ width: `${(data.total / totalExpenses) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Expense Records */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="w-5 h-5 text-orange-600" />
            All Expense Records
          </CardTitle>
          <CardDescription>Sorted by date (newest first)</CardDescription>
        </CardHeader>
        <CardContent>
          {expenseData.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Receipt className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No expenses recorded for {currentYear}</p>
              <p className="text-xs mt-2">Start tracking your business expenses to see them here</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-2 px-2 font-semibold">Date</th>
                    <th className="text-left py-2 px-2 font-semibold">Description</th>
                    <th className="text-left py-2 px-2 font-semibold">Category</th>
                    <th className="text-right py-2 px-2 font-semibold">Amount</th>
                    <th className="text-center py-2 px-2 font-semibold">Receipt</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {expenseData.map((e: any) => (
                    <tr key={e.id} className="hover:bg-muted/50">
                      <td className="py-3 px-2 text-muted-foreground">{new Date(e.expense_date ?? e.date).toLocaleDateString()}</td>
                      <td className="py-3 px-2">{e.description || 'Business Expense'}</td>
                      <td className="py-3 px-2">
                        <Badge variant="outline" className="text-xs">{e.category}</Badge>
                      </td>
                      <td className="py-3 px-2 text-right font-semibold text-orange-600">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(e.amount || 0)}</td>
                      <td className="py-3 px-2 text-center">
                        {e.receipt_url ? (
                          <a href={e.receipt_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">View</a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
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
      <FinancialActionStack actions={expenseActions} />
    </div>
  )
}
