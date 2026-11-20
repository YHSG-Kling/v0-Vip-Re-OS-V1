"use client"

// Wave 82 lane A — the listing landing page's payment estimate, computed from THIS property's
// public facts (county tax bill, HOA dues) through app/actions/calculators.ts::
// calculatePropertyPayment. Runs on the visitor's click, never on page render, so a page view
// never spends a metered property-record read.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Calculator, Loader2 } from "lucide-react"
import { calculatePropertyPayment } from "@/app/actions/calculators"

type PaymentResult = Awaited<ReturnType<typeof calculatePropertyPayment>>

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

export function PropertyPaymentCard({ listingSlug }: { listingSlug: string }) {
  const [downPct, setDownPct] = useState("20")
  const [ratePct, setRatePct] = useState("6.5")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<PaymentResult | null>(null)

  async function run() {
    setLoading(true)
    try {
      setResult(await calculatePropertyPayment({
        listingSlug,
        downPaymentPercent: Number(downPct) || undefined,
        annualInterestRatePct: Number(ratePct) || undefined,
      }))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Calculator className="h-5 w-5" /> Estimate your monthly payment</CardTitle>
        <CardDescription>Uses this home&apos;s own property-tax bill and HOA dues from public records when available.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="pp-down">Down payment %</Label>
            <Input id="pp-down" inputMode="decimal" value={downPct} onChange={(e) => setDownPct(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pp-rate">Interest rate %</Label>
            <Input id="pp-rate" inputMode="decimal" value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
          </div>
        </div>
        <Button onClick={run} disabled={loading} className="w-full">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Calculate"}
        </Button>
        {result && !result.success && <p className="text-sm text-destructive">{result.error}</p>}
        {result && result.success && (
          <div className="space-y-2 text-sm">
            <p className="text-2xl font-semibold">{usd(result.payment.total)}<span className="text-sm font-normal text-muted-foreground"> / month</span></p>
            <ul className="space-y-1 text-muted-foreground">
              <li>Principal &amp; interest: {usd(result.payment.principalInterest)}</li>
              <li>Property tax: {usd(result.payment.propertyTax)}</li>
              <li>Insurance: {usd(result.payment.insurance)}</li>
              {result.payment.pmi > 0 && <li>PMI: {usd(result.payment.pmi)}</li>}
              {result.payment.hoa > 0 && <li>HOA: {usd(result.payment.hoa)}</li>}
            </ul>
            <p className="text-xs text-muted-foreground">{result.taxNote}</p>
            <p className="text-xs text-muted-foreground">{result.disclaimer}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
