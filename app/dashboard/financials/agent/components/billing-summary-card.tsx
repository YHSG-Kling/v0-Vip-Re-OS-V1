"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { CreditCard, Loader2, RefreshCw, ExternalLink } from "lucide-react"
import { calculateAgentBilling } from "@/app/actions/multi-persona"
import { useToast } from "@/hooks/use-toast"
import Link from "next/link"

interface BillingRecord {
  id: string
  billing_period_start: string
  billing_period_end: string
  gross_commission: number
  brokerage_split_amount: number
  transaction_fees: number
  desk_fees: number
  technology_fees: number
  e_and_o_insurance: number
  net_to_agent: number
}

interface BillingSummaryCardProps {
  agentId: string
  brokerageId: string
  initialBilling: BillingRecord | null
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export function BillingSummaryCard({ agentId, brokerageId, initialBilling }: BillingSummaryCardProps) {
  const [billing, setBilling] = useState<BillingRecord | null>(initialBilling)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const now = new Date()
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0]
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0]

  function handleCalculate() {
    startTransition(async () => {
      try {
        const result = await calculateAgentBilling({
          agentId,
          brokerageId,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
        })
        setBilling(result as unknown as BillingRecord)
        toast({ title: "Billing calculated", description: "Current period billing summary updated." })
      } catch {
        toast({ title: "Error", description: "Failed to calculate billing.", variant: "destructive" })
      }
    })
  }

  const periodLabel = now.toLocaleDateString("en-US", { month: "long", year: "numeric" })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-blue-600" />
            <div>
              <CardTitle>Billing Summary</CardTitle>
              <CardDescription>{periodLabel}</CardDescription>
            </div>
          </div>
          {billing && (
            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-xs">
              Current Period
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {billing ? (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Gross Commission</span>
                <span className="font-medium">{fmt(billing.gross_commission)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Brokerage Split</span>
                <span className="text-destructive">− {fmt(billing.brokerage_split_amount)}</span>
              </div>
              <Separator />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Transaction Fees</span>
                <span className="text-destructive">− {fmt(billing.transaction_fees)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Desk Fees</span>
                <span className="text-destructive">− {fmt(billing.desk_fees)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Technology Fees</span>
                <span className="text-destructive">− {fmt(billing.technology_fees)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">E&O Insurance</span>
                <span className="text-destructive">− {fmt(billing.e_and_o_insurance)}</span>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <span className="font-semibold">Net to Agent</span>
                <span className="text-xl font-bold text-green-600">{fmt(billing.net_to_agent)}</span>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={handleCalculate} disabled={isPending} className="gap-1.5">
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Recalculate
              </Button>
              <Button variant="outline" size="sm" asChild className="gap-1.5">
                <Link href="/settings/billing">
                  <ExternalLink className="h-3.5 w-3.5" />
                  View Invoice
                </Link>
              </Button>
            </div>
          </>
        ) : (
          <div className="text-center py-6 space-y-3">
            <CreditCard className="h-10 w-10 mx-auto text-muted-foreground opacity-40" />
            <div>
              <p className="text-sm font-medium">No billing data for {periodLabel}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Calculate your current period plan fees, transaction fees, and net earnings.
              </p>
            </div>
            <Button size="sm" onClick={handleCalculate} disabled={isPending} className="gap-1.5">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
              Calculate Billing
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
