"use client"

// BuyerOfferToolsCard — the buyer's self-serve "can I afford it / is this a good offer" tools on
// a property they like. The math is exact + client-side (instant); using either tool SIGNALS the
// assigned agent (and "help me make an offer" fires the gated Offer Accelerator). RealScout shows
// listings; ours lets the buyer self-qualify AND auto-convenes the team.

import { useMemo, useState, useTransition } from "react"
import { Calculator, HandCoins, CheckCircle2, AlertTriangle, HelpCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { estimateMonthlyPayment, affordabilityRead, AFFORDABILITY_DEFAULTS } from "@/lib/buyer-offers/affordability"
import { signalAffordabilityChecked, requestOfferHelp } from "@/app/actions/buyer-offer-tools"

const money = (n: number) => `$${Math.round(n).toLocaleString()}`

export function BuyerOfferToolsCard({
  contactId, propertyId, propertyAddress, price, preApprovalAmount,
}: {
  contactId: string
  propertyId: string
  propertyAddress: string
  price: number | null
  preApprovalAmount: number | null
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [offerPending, startOffer] = useTransition()
  const [downPct, setDownPct] = useState<number>(AFFORDABILITY_DEFAULTS.downPaymentPercent)
  const [ratePct, setRatePct] = useState<number>(AFFORDABILITY_DEFAULTS.annualInterestRatePct)
  const [budget, setBudget] = useState<string>("")

  if (!price || price <= 0) return null

  const breakdown = useMemo(
    () => estimateMonthlyPayment({ price, downPaymentPercent: downPct, annualInterestRatePct: ratePct }),
    [price, downPct, ratePct],
  )
  const read = useMemo(
    () => affordabilityRead({
      price, monthlyTotal: breakdown.total, preApprovalAmount,
      maxMonthlyBudget: budget ? Number(budget) : null,
    }),
    [price, breakdown.total, preApprovalAmount, budget],
  )

  const verdictUI = {
    within_budget: { label: "Within reach", cls: "bg-green-100 text-green-800", Icon: CheckCircle2 },
    stretch: { label: "A stretch", cls: "bg-amber-100 text-amber-800", Icon: AlertTriangle },
    over_budget: { label: "Over budget", cls: "bg-red-100 text-red-800", Icon: AlertTriangle },
    unknown: { label: "Add pre-approval to see", cls: "bg-muted text-muted-foreground", Icon: HelpCircle },
  }[read.verdict]

  function letAgentKnow() {
    startTransition(async () => {
      const r = await signalAffordabilityChecked({
        contactId, propertyId, propertyAddress, price: price!, monthlyEstimate: breakdown.total, verdict: read.verdict,
      })
      toast(r.success
        ? { title: "Your agent has been notified", description: "They'll follow up on this home." }
        : { title: "Couldn't notify your agent", description: r.error ?? "Try again", variant: "destructive" })
    })
  }

  function helpMakeOffer() {
    startOffer(async () => {
      const r = await requestOfferHelp({ contactId, propertyId, propertyAddress })
      toast(r.success
        ? { title: "Your agent is preparing your offer plan", description: "They'll reach out with a recommended price and terms." }
        : { title: "Couldn't send the request", description: r.error ?? "Try again", variant: "destructive" })
    })
  }

  const VIcon = verdictUI.Icon
  return (
    <Card className="border-teal-200">
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Calculator className="h-4 w-4 text-teal-600" /> Can I afford this home?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Estimated monthly payment</p>
            <p className="text-2xl font-bold">{money(breakdown.total)}<span className="text-sm font-normal text-muted-foreground">/mo</span></p>
          </div>
          <Badge className={`${verdictUI.cls} flex items-center gap-1`}><VIcon className="h-3 w-3" />{verdictUI.label}</Badge>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Down payment %</Label>
            <Input type="number" inputMode="decimal" value={downPct}
              onChange={(e) => setDownPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
          </div>
          <div>
            <Label className="text-xs">Rate % <span className="text-muted-foreground">(est.)</span></Label>
            <Input type="number" inputMode="decimal" step="0.125" value={ratePct}
              onChange={(e) => setRatePct(Math.max(0, Number(e.target.value) || 0))} />
          </div>
          <div>
            <Label className="text-xs">My max $/mo</Label>
            <Input type="number" inputMode="decimal" placeholder="optional" value={budget}
              onChange={(e) => setBudget(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <span>Principal &amp; interest: {money(breakdown.principalInterest)}</span>
          <span>Taxes: {money(breakdown.propertyTax)}</span>
          <span>Insurance: {money(breakdown.insurance)}</span>
          {breakdown.pmi > 0 && <span>PMI: {money(breakdown.pmi)}</span>}
        </div>
        {read.headroomToPreApproval != null && (
          <p className="text-xs text-muted-foreground">
            {read.headroomToPreApproval >= 0
              ? `${money(read.headroomToPreApproval)} under your pre-approval.`
              : `${money(-read.headroomToPreApproval)} over your pre-approval.`}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">Estimates only — rate, taxes, and insurance vary. Your agent and lender confirm the real numbers.</p>

        <div className="flex flex-col sm:flex-row gap-2">
          <Button variant="outline" className="flex-1" onClick={letAgentKnow} disabled={pending}>
            {pending ? "Notifying…" : "Let my agent know I'm interested"}
          </Button>
          <Button className="flex-1 bg-teal-600 hover:bg-teal-700 text-white" onClick={helpMakeOffer} disabled={offerPending}>
            <HandCoins className="h-4 w-4 mr-1" />{offerPending ? "Sending…" : "Help me make an offer"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
