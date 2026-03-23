"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Calculator, Loader2, TrendingUp } from "lucide-react"
import { aiCalculateCommission } from "@/app/actions/ai-financial-management"
import { useToast } from "@/hooks/use-toast"

interface PipelineTransaction {
  id: string
  property_address: string | null
  purchase_price: number | null
  commission_percentage: number | null
  estimated_commission: number | null
  deal_name: string | null
}

interface CommissionBreakdown {
  grossCommission: number
  agentSplit: number
  brokerageShare: number
  agentGross: number
  feesTotal: number
  agentNet: number
  taxEstimate: {
    totalEstimatedTax?: number
    estimatedSelfEmploymentTax?: number
    estimatedFederalTax?: number
    estimatedStateTax?: number
  }
}

interface CommissionCalculatorCardProps {
  agentId: string
  pendingTransactions: PipelineTransaction[]
}

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export function CommissionCalculatorCard({ agentId, pendingTransactions }: CommissionCalculatorCardProps) {
  const [form, setForm] = useState({
    transactionId: "",
    salePrice: "",
    commissionRate: "3",
    agentSplitPct: "70",
    brokerageFee: "0",
  })
  const [breakdown, setBreakdown] = useState<CommissionBreakdown | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const selectedTx = pendingTransactions.find((t) => t.id === form.transactionId)

  // When a transaction is selected, pre-fill salePrice and commissionRate from it
  function handleTransactionSelect(txId: string) {
    const tx = pendingTransactions.find((t) => t.id === txId)
    setForm((prev) => ({
      ...prev,
      transactionId: txId,
      salePrice: tx?.purchase_price ? String(tx.purchase_price) : prev.salePrice,
      commissionRate: tx?.commission_percentage ? String(tx.commission_percentage) : prev.commissionRate,
    }))
    setBreakdown(null)
  }

  function handleCalculate() {
    if (!form.transactionId) {
      toast({ title: "Select a transaction", description: "Choose a pipeline transaction to calculate commission.", variant: "destructive" })
      return
    }
    const salePrice = parseFloat(form.salePrice)
    const commissionRate = parseFloat(form.commissionRate)
    const agentSplitPct = parseFloat(form.agentSplitPct)
    const brokerageFee = parseFloat(form.brokerageFee) || 0

    if (!salePrice || !commissionRate || !agentSplitPct) {
      toast({ title: "Missing fields", description: "Enter a sale price, commission rate, and agent split.", variant: "destructive" })
      return
    }

    const grossCommission = salePrice * (commissionRate / 100)

    startTransition(async () => {
      try {
        const result = await aiCalculateCommission({
          agentId,
          transactionId: form.transactionId,
          grossCommission,
          splitPercentage: agentSplitPct,
          brokerageFee,
        })
        if (result.success && result.commission) {
          setBreakdown(result.commission as CommissionBreakdown)
          toast({ title: "Commission calculated", description: "AI breakdown complete." })
        } else {
          toast({ title: "Calculation failed", description: (result as any).error || "Unknown error", variant: "destructive" })
        }
      } catch (e: any) {
        toast({ title: "Error", description: e.message || "Failed to calculate commission.", variant: "destructive" })
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Calculator className="h-5 w-5 text-green-600" />
          <div>
            <CardTitle>Commission Calculator</CardTitle>
            <CardDescription>AI-powered commission breakdown with tax estimate</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Transaction Picker */}
        <div className="space-y-1.5">
          <Label htmlFor="transaction-select">Pipeline Transaction</Label>
          {pendingTransactions.length > 0 ? (
            <Select value={form.transactionId} onValueChange={handleTransactionSelect}>
              <SelectTrigger id="transaction-select">
                <SelectValue placeholder="Select a pending deal..." />
              </SelectTrigger>
              <SelectContent>
                {pendingTransactions.map((tx) => (
                  <SelectItem key={tx.id} value={tx.id}>
                    {tx.property_address || tx.deal_name || "Unnamed Deal"} —{" "}
                    {tx.purchase_price ? fmt(tx.purchase_price) : "Price TBD"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm text-muted-foreground py-2 px-3 border rounded-md bg-muted/30">
              No active pipeline transactions found. Close a deal in your transactions to calculate commission.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="sale-price">Sale Price ($)</Label>
            <Input
              id="sale-price"
              type="number"
              placeholder="450000"
              value={form.salePrice}
              onChange={(e) => setForm((p) => ({ ...p, salePrice: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="commission-rate">Commission Rate (%)</Label>
            <Input
              id="commission-rate"
              type="number"
              step="0.1"
              placeholder="3"
              value={form.commissionRate}
              onChange={(e) => setForm((p) => ({ ...p, commissionRate: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-split">Agent Split (%)</Label>
            <Input
              id="agent-split"
              type="number"
              placeholder="70"
              value={form.agentSplitPct}
              onChange={(e) => setForm((p) => ({ ...p, agentSplitPct: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="brokerage-fee">Brokerage Fee ($)</Label>
            <Input
              id="brokerage-fee"
              type="number"
              placeholder="0"
              value={form.brokerageFee}
              onChange={(e) => setForm((p) => ({ ...p, brokerageFee: e.target.value }))}
            />
          </div>
        </div>

        <Button
          className="w-full gap-2"
          onClick={handleCalculate}
          disabled={isPending || pendingTransactions.length === 0}
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
          Calculate Commission
        </Button>

        {/* Breakdown Result */}
        {breakdown && (
          <div className="space-y-3 pt-2 border-t">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <TrendingUp className="h-4 w-4" />
              Breakdown
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Gross Commission</span>
                <span className="font-medium">{fmt(breakdown.grossCommission)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Broker Split ({100 - breakdown.agentSplit}%)
                </span>
                <span className="text-destructive">− {fmt(breakdown.brokerageShare)}</span>
              </div>
              {breakdown.feesTotal > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Total Fees</span>
                  <span className="text-destructive">− {fmt(breakdown.feesTotal)}</span>
                </div>
              )}
              <Separator />
              <div className="flex items-center justify-between">
                <span className="font-semibold">Agent Net</span>
                <span className="text-2xl font-bold text-green-600">{fmt(breakdown.agentNet)}</span>
              </div>
              {breakdown.taxEstimate?.totalEstimatedTax ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">After Tax Estimate</span>
                  <div className="text-right">
                    <span className="font-medium text-amber-600">
                      {fmt(breakdown.agentNet - breakdown.taxEstimate.totalEstimatedTax)}
                    </span>
                    <Badge variant="outline" className="ml-2 text-xs bg-amber-50 text-amber-700 border-amber-200">
                      ~{Math.round((breakdown.taxEstimate.totalEstimatedTax / breakdown.agentNet) * 100)}% tax
                    </Badge>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
