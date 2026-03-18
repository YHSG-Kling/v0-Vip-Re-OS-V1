"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity, FileText } from "lucide-react"
import { HealthScoreRing } from "@/app/components/shared/HealthScoreRing"

interface Transaction {
  id: string
  deal_name: string
  property_address: string
  property_state: string | null
  stage: string
  close_date: string | null
  health_score: number | null
  contact: { id: string; first_name: string; last_name: string } | null
}

interface AgentDealIntelligenceProps {
  transactions: Transaction[]
  loading: boolean
}

export function AgentDealIntelligence({ transactions, loading }: AgentDealIntelligenceProps) {
  // Sort by health_score ASC (null treated as 0)
  const sortedTransactions = [...transactions].sort((a, b) => {
    const scoreA = a.health_score ?? 0
    const scoreB = b.health_score ?? 0
    return scoreA - scoreB
  })

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Deal Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded animate-pulse" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (transactions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Deal Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No active transactions</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const formatCloseDate = (dateStr: string | null) => {
    if (!dateStr) return null
    const date = new Date(dateStr)
    const now = new Date()
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return { formatted, isUrgent: diffDays < 30 && diffDays > 0 }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Deal Intelligence
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">
        {sortedTransactions.map((tx, idx) => {
          const closeInfo = formatCloseDate(tx.close_date)
          return (
            <div
              key={tx.id}
              className={`flex items-center justify-between py-3 ${idx < sortedTransactions.length - 1 ? 'border-b' : ''}`}
            >
              {/* LEFT */}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <p className="text-sm font-medium truncate max-w-[200px]">{tx.property_address}</p>
                {tx.property_state && (
                  <Badge variant="outline" className="text-xs shrink-0">{tx.property_state}</Badge>
                )}
                <Badge variant="secondary" className="text-xs shrink-0">{tx.stage}</Badge>
              </div>

              {/* CENTER */}
              <div className="text-center px-4 min-w-[120px]">
                <p className="text-xs text-muted-foreground">
                  {tx.contact ? `${tx.contact.first_name} ${tx.contact.last_name}` : '—'}
                </p>
                {closeInfo && (
                  <p className={`text-xs ${closeInfo.isUrgent ? 'text-amber-600 font-medium' : 'text-muted-foreground'}`}>
                    {closeInfo.isUrgent ? 'Closes ' : ''}{closeInfo.formatted}
                  </p>
                )}
              </div>

              {/* RIGHT */}
              <div className="flex items-center gap-3">
                <HealthScoreRing score={tx.health_score ?? 0} size="sm" showLabel />
                <Link href={`/dashboard/transactions/${tx.id}`} className="text-xs text-primary hover:underline whitespace-nowrap">
                  Open Deal
                </Link>
              </div>
            </div>
          )
        })}

        <div className="pt-3">
          <Link href="/dashboard/transactions" className="text-sm text-primary hover:underline">
            View All Transactions →
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
