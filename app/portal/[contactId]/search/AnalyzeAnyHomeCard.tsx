"use client"

// AnalyzeAnyHomeCard — paste ANY address (Zillow link, yard sign, a friend's tip) and our tools
// run on it: estimated value + specs + affordability, in OUR app. No saved listing needed — the
// whole market. CTAs route to the agent (get their take) and the vendor marketplace (get
// pre-approved with the agent's lender). Client-framing doctrine: warm, never a scary verdict.

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { Home, Search, MessageCircle, Landmark } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { estimateMonthlyPayment, affordabilityRead, clientAffordabilityFraming, preApprovalStatus } from "@/lib/buyer-offers/affordability"
import type { AddressAnalysis } from "@/lib/buyer-offers/address-analysis"
import { analyzeAddressForBuyer, signalAffordabilityChecked } from "@/app/actions/buyer-offer-tools"

const money = (n: number) => `$${Math.round(n).toLocaleString()}`

export function AnalyzeAnyHomeCard({
  contactId, preApprovalAmount, preApprovalExpiresAt,
}: {
  contactId: string
  preApprovalAmount: number | null
  preApprovalExpiresAt: string | null
}) {
  const { toast } = useToast()
  const [analyzing, startAnalyze] = useTransition()
  const [sending, startSend] = useTransition()
  const [address, setAddress] = useState("")
  const [analysis, setAnalysis] = useState<AddressAnalysis | null>(null)

  const usablePreApproval = useMemo(() => {
    const s = preApprovalStatus(preApprovalAmount, preApprovalExpiresAt, new Date())
    return s.state === "expired" ? null : s.amount
  }, [preApprovalAmount, preApprovalExpiresAt])

  const payment = useMemo(
    () => (analysis?.estimatedValue ? estimateMonthlyPayment({ price: analysis.estimatedValue }) : null),
    [analysis?.estimatedValue],
  )
  const framing = useMemo(() => {
    if (!analysis?.estimatedValue || !payment) return null
    return clientAffordabilityFraming(
      affordabilityRead({ price: analysis.estimatedValue, monthlyTotal: payment.total, preApprovalAmount: usablePreApproval }).verdict,
    )
  }, [analysis?.estimatedValue, payment, usablePreApproval])

  function analyze() {
    if (address.trim().length < 5) return
    startAnalyze(async () => {
      const r = await analyzeAddressForBuyer({ contactId, address: address.trim() })
      if (r.success && r.analysis) setAnalysis(r.analysis)
      else toast({ title: "Couldn't analyze that address", description: r.error ?? "Try a full address", variant: "destructive" })
    })
  }

  function getAgentTake() {
    if (!analysis) return
    startSend(async () => {
      const r = await signalAffordabilityChecked({
        contactId, propertyId: `addr:${address.trim()}`, propertyAddress: address.trim(),
        price: analysis.estimatedValue ?? 0, monthlyEstimate: payment?.total ?? 0,
        verdict: framing ? framing.label : "researching",
      })
      toast(r.success
        ? { title: "Your agent has been notified", description: "They'll follow up on this home with you." }
        : { title: "Couldn't notify your agent", description: r.error ?? "Try again", variant: "destructive" })
    })
  }

  const toneCls = framing?.tone === "good" ? "bg-green-100 text-green-800" : framing?.tone === "soft" ? "bg-blue-100 text-blue-800" : "bg-muted text-muted-foreground"

  return (
    <Card className="border-teal-200">
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Home className="h-4 w-4 text-teal-600" /> Curious about a home? Check any address
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Paste any address — even one you found elsewhere"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && analyze()}
          />
          <Button onClick={analyze} disabled={analyzing || address.trim().length < 5} className="bg-teal-600 hover:bg-teal-700 text-white shrink-0">
            <Search className="h-4 w-4 mr-1" />{analyzing ? "Checking…" : "Check"}
          </Button>
        </div>

        {analysis && (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Estimated value</p>
                <p className="text-2xl font-bold">{analysis.estimatedValue ? money(analysis.estimatedValue) : "—"}</p>
              </div>
              {framing && <Badge className={`${toneCls}`}>{framing.label}</Badge>}
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {analysis.beds != null && <span>{analysis.beds} bed</span>}
              {analysis.baths != null && <span>{analysis.baths} bath</span>}
              {analysis.sqft != null && <span>{analysis.sqft.toLocaleString()} sq ft</span>}
              {payment && <span className="font-medium text-foreground">~{money(payment.total)}/mo</span>}
            </div>
            {framing && <p className="text-xs text-muted-foreground">{framing.line}</p>}
            <p className="text-[11px] text-muted-foreground">{analysis.estimateNote}</p>

            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={getAgentTake} disabled={sending}>
                <MessageCircle className="h-4 w-4 mr-1" />{sending ? "Sending…" : "Get my agent's take"}
              </Button>
              {/* Vendor marketplace: route a buyer who's getting serious to the agent's preferred lender. */}
              <Link href={`/portal/${contactId}/vendors`} className="flex-1">
                <Button className="w-full bg-teal-600 hover:bg-teal-700 text-white">
                  <Landmark className="h-4 w-4 mr-1" />Get pre-approved
                </Button>
              </Link>
            </div>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">Estimates from public data — your agent confirms the real value, the right offer, and connects you with a trusted lender.</p>
      </CardContent>
    </Card>
  )
}
