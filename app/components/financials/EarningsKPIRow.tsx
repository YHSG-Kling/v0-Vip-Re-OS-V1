"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DollarSign, TrendingUp, FileText, BarChart3 } from "lucide-react"

interface EarningsKPIRowProps {
  mtdAgentNet: number
  ytdAgentNet: number
  ytdGrossCommission: number
  ytdTransactionCount: number
}

export function EarningsKPIRow({
  mtdAgentNet,
  ytdAgentNet,
  ytdGrossCommission,
  ytdTransactionCount,
}: EarningsKPIRowProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  const kpis = [
    {
      title: "MTD Agent Net",
      value: formatCurrency(mtdAgentNet),
      icon: DollarSign,
      description: "This month",
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "YTD Agent Net",
      value: formatCurrency(ytdAgentNet),
      icon: TrendingUp,
      description: "Year to date",
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "YTD Gross Commission",
      value: formatCurrency(ytdGrossCommission),
      icon: BarChart3,
      description: "Total GCI",
      color: "text-purple-600",
      bgColor: "bg-purple-50",
    },
    {
      title: "Transactions YTD",
      value: ytdTransactionCount.toString(),
      icon: FileText,
      description: "Closed deals",
      color: "text-orange-600",
      bgColor: "bg-orange-50",
    },
  ]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {kpis.map((kpi) => (
        <Card key={kpi.title}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {kpi.title}
            </CardTitle>
            <div className={`p-2 rounded-lg ${kpi.bgColor}`}>
              <kpi.icon className={`h-4 w-4 ${kpi.color}`} />
            </div>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${kpi.color}`}>{kpi.value}</div>
            <p className="text-xs text-muted-foreground mt-1">{kpi.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
