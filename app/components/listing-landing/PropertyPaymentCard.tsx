"use client"

// Wave 82 lane A — the listing landing page's payment estimate, computed from THIS property's
// public facts (county tax bill, HOA dues) through app/actions/calculators.ts::
// calculatePropertyPayment. Runs on the visitor's click, never on page render, so a page view
// never spends a metered property-record read.
// Wave 156 (156H round 2): the visitor's OWN loan figures (no prefilled 20% / 6.5%), the ONE engine's result, its assumptions.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Calculator, Loader2 } from "lucide-react"
import { calculatePropertyPayment } from "@/app/actions/calculators"
import { calculatorNeeds } from "@/lib/calculators/buyer-payment"
import { LoanAssumptionsFields, useLoanAssumptions } from "@/app/components/calculators/LoanAssumptionsFields"

type PaymentResult = Awaited<ReturnType<typeof calculatePropertyPayment>>

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

export function PropertyPaymentCard({ listingSlug }: { listingSlug: string }) {
  const loan = useLoanAssumptions()
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<PaymentResult | null>(null)

  async function run() {
    setLoading(true)
    try {
      setResult(await calculatePropertyPayment({ listingSlug, loan: loan.values }))
    } finally {
      setLoading(false)
    }
  }

  const o = result && result.success ? result.outcome : null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Calculator className="h-5 w-5" /> Estimate your monthly payment</CardTitle>
        <CardDescription>Uses this home&apos;s own property-tax bill and HOA dues from public records when available; the loan figures are yours.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <LoanAssumptionsFields values={loan.values} set={loan.set} idPrefix={`pp-${listingSlug}`} />
        <Button onClick={run} disabled={loading} className="w-full">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Calculate"}
        </Button>
        {result && !result.success && <p className="text-sm text-destructive">{result.error}</p>}
        {o && !o.ok && <ul className="list-disc pl-5 text-sm text-muted-foreground">{calculatorNeeds(o).map((n) => <li key={n}>{n}</li>)}</ul>}
        {o && o.ok && (
          <div className="space-y-2 text-sm">
            <p className="text-2xl font-semibold">{usd(Number(o.outputs.monthlyTotal))}<span className="text-sm font-normal text-muted-foreground"> / month</span></p>
            <ul className="space-y-1 text-muted-foreground">
              {o.lines.filter((l) => l.amount > 0).map((l) => <li key={l.key}>{l.label}: {usd(l.amount)}</li>)}
            </ul>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {o.assumptions.map((a) => <li key={a.key}>{a.label}: {a.display} ({a.basis.replace(/_/g, " ")}{a.source ? ` — ${a.source.citation}` : ""})</li>)}
            </ul>
            {o.notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
            {o.disclaimers.map((d) => <p key={d} className="text-xs text-muted-foreground">{d}</p>)}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
