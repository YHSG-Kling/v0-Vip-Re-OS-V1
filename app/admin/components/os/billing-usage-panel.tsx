"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DollarSign, TrendingUp, AlertCircle, ExternalLink } from "lucide-react"

interface BillingIssue {
  id: string
  brokerage_id: string
  brokerage_name: string
  status: string
  amount_cents: number
  due_date: string | null
}

interface UsageSummary {
  totalAiCalls: number
  totalVideoMinutes: number
  totalStorageGb: number
  periodLabel: string
}

interface BillingUsagePanelProps {
  billingIssues: BillingIssue[]
  usageSummary: UsageSummary
  totalMrr: number
}

export function BillingUsagePanel({ billingIssues, usageSummary, totalMrr }: BillingUsagePanelProps) {
  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Billing & Usage
          </CardTitle>
          <Link href="/admin/billing">
            <Button variant="ghost" size="sm" className="gap-1">
              <ExternalLink className="h-3 w-3" />
              View All
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* MRR Summary */}
        <div className="flex items-center justify-between p-3 bg-green-500/10 rounded-lg border border-green-500/20">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-green-600" />
            <span className="text-sm font-medium">Monthly Recurring Revenue</span>
          </div>
          <span className="text-xl font-bold text-green-600">{formatCurrency(totalMrr)}</span>
        </div>

        {/* Usage Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="p-2 bg-muted/50 rounded-lg text-center">
            <p className="text-lg font-bold">{usageSummary.totalAiCalls.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">AI Calls</p>
          </div>
          <div className="p-2 bg-muted/50 rounded-lg text-center">
            <p className="text-lg font-bold">{usageSummary.totalVideoMinutes.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Video Min</p>
          </div>
          <div className="p-2 bg-muted/50 rounded-lg text-center">
            <p className="text-lg font-bold">{usageSummary.totalStorageGb.toFixed(1)}</p>
            <p className="text-xs text-muted-foreground">Storage GB</p>
          </div>
        </div>

        {/* Billing Issues */}
        {billingIssues.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium flex items-center gap-1">
              <AlertCircle className="h-4 w-4 text-red-500" />
              Billing Issues ({billingIssues.length})
            </p>
            {billingIssues.slice(0, 3).map((issue) => (
              <div
                key={issue.id}
                className="flex items-center justify-between p-2 bg-red-500/10 rounded-lg border border-red-500/20"
              >
                <div>
                  <p className="text-sm font-medium">{issue.brokerage_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(issue.amount_cents)} - {issue.status}
                  </p>
                </div>
                <Link href={`/admin/billing/${issue.brokerage_id}`}>
                  <Button variant="outline" size="sm">
                    Review
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
