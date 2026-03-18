"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { DollarSign, TrendingUp, TrendingDown } from "lucide-react"

interface Commission {
  amount: number
  status: string
  transactions?: { id?: string; property_address: string; close_date: string | null } | null
}

interface Expense {
  amount: number
  category: string
  description: string
}

interface AgentFinancialIntelligenceProps {
  commissions: Commission[]
  monthlyExpenses: Expense[]
  ytdGCI: number
  activeTransactionCount: number
  loading: boolean
}

export function AgentFinancialIntelligence({
  commissions,
  monthlyExpenses,
  ytdGCI,
  activeTransactionCount,
  loading
}: AgentFinancialIntelligenceProps) {
  // Computed values
  const pendingTotal = commissions
    .filter(c => c.status === 'pending')
    .reduce((sum, c) => sum + c.amount, 0)

  const monthExpenseTotal = monthlyExpenses.reduce((sum, e) => sum + e.amount, 0)
  const netPipelineValue = pendingTotal - monthExpenseTotal

  // Group expenses by category
  const expenseByCategory = monthlyExpenses.reduce((acc, exp) => {
    acc[exp.category] = (acc[exp.category] || 0) + exp.amount
    return acc
  }, {} as Record<string, number>)

  const topCategories = Object.entries(expenseByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)

  // Soonest close
  const pendingDeals = commissions
    .filter(c => c.status === 'pending' && c.transactions?.close_date)
    .sort((a, b) => {
      const dateA = new Date(a.transactions!.close_date!).getTime()
      const dateB = new Date(b.transactions!.close_date!).getTime()
      return dateA - dateB
    })

  const soonestClose = pendingDeals[0]

  // Pipeline health bar
  const pipelineHealth = pendingTotal / Math.max(pendingTotal + monthExpenseTotal, 1) * 100

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value)
  }

  const getDaysUntil = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    return Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            Business Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-12 bg-muted rounded animate-pulse" />
          ))}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-green-600" />
          Business Intelligence
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 2x2 Metrics Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">Pending Commission</p>
            <p className={`text-lg font-bold ${pendingTotal > 0 ? 'text-green-600' : ''}`}>
              {formatCurrency(pendingTotal)}
            </p>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">YTD Gross Income</p>
            <p className="text-lg font-bold">{formatCurrency(ytdGCI)}</p>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">Month Expenses</p>
            <p className={`text-lg font-bold ${monthExpenseTotal > 500 ? 'text-amber-600' : ''}`}>
              {formatCurrency(monthExpenseTotal)}
            </p>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg">
            <p className="text-xs text-muted-foreground">Net Pipeline Value</p>
            <p className={`text-lg font-bold flex items-center gap-1 ${netPipelineValue >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {netPipelineValue >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              {formatCurrency(netPipelineValue)}
            </p>
          </div>
        </div>

        {/* Pipeline Health Bar */}
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-muted-foreground">Pipeline health</span>
            <span className="font-medium">{Math.round(pipelineHealth)}%</span>
          </div>
          <Progress value={pipelineHealth} className="h-2" />
        </div>

        {/* Pending Deals Mini-list */}
        {pendingDeals.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Pending Deals</p>
            {pendingDeals.slice(0, 3).map((deal, idx) => (
              <div key={idx} className="flex items-center justify-between text-sm">
                <div className="truncate max-w-[150px]">
                  {deal.transactions?.property_address || 'Deal'}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {deal.transactions?.close_date
                      ? new Date(deal.transactions.close_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : '—'}
                  </span>
                  <span className="font-medium">{formatCurrency(deal.amount)}</span>
                  <Badge variant="outline" className="text-[10px]">{deal.status}</Badge>
                  {deal.transactions?.id && (
                    <Link href={`/dashboard/transactions/${deal.transactions.id}`} className="text-xs text-primary hover:underline">
                      View
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Expense Categories */}
        {topCategories.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {topCategories.map(([category, amount]) => (
              <Badge key={category} variant="secondary" className="text-xs">
                {category}: {formatCurrency(amount)}
              </Badge>
            ))}
          </div>
        )}

        {/* AI Insight */}
        {soonestClose && soonestClose.transactions?.close_date && (
          <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-lg">
            <p className="text-sm text-blue-800 dark:text-blue-200">
              Soonest closing: {soonestClose.transactions.property_address} ·{' '}
              {getDaysUntil(soonestClose.transactions.close_date)} days ·{' '}
              est. {formatCurrency(soonestClose.amount)}
            </p>
          </div>
        )}

        {/* Footer Buttons */}
        <div className="flex gap-2 pt-2">
          <Link href="/dashboard/financials/agent">
            <Button variant="outline" size="sm">Open Full Financials</Button>
          </Link>
          <Link href="/dashboard/financials/expenses">
            <Button variant="outline" size="sm">Track Expense</Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
