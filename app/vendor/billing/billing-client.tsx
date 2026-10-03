"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, CreditCard } from "lucide-react"
import { VENDOR_TIERS, effectiveCapabilities, type VendorTier } from "@/lib/kernel/vendor-subscription"
import { createVendorSubscriptionCheckout, createVendorBillingPortalSession } from "@/app/actions/vendor-billing"

const ORDER: VendorTier[] = ["basic", "standard", "premium", "preferred_network"]

/** Vendor self-serve billing — subscribe to a platform tier (vendor pays the platform) or manage billing. */
export function VendorBillingClient({ currentTier, status }: { currentTier: VendorTier; status: string }) {
  const [busy, setBusy] = useState<string | null>(null)

  async function subscribe(tier: VendorTier) {
    setBusy(tier)
    try { const { url } = await createVendorSubscriptionCheckout(tier); if (url) window.location.href = url } finally { setBusy(null) }
  }
  async function portal() {
    setBusy("portal")
    try { const { url } = await createVendorBillingPortalSession(); if (url) window.location.href = url } finally { setBusy(null) }
  }

  const statusColor = status === "active" ? "bg-green-100 text-green-800 border-green-200"
    : status === "past_due" ? "bg-amber-100 text-amber-800 border-amber-200"
    : "bg-red-100 text-red-800 border-red-200"

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Current plan:</span>
        <Badge className="capitalize">{currentTier.replace("_", " ")}</Badge>
        <Badge className={`border ${statusColor}`}>{status.replace("_", " ")}</Badge>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={portal}>
          <CreditCard className="h-4 w-4 mr-1" /> Manage billing
        </Button>
      </div>
      {status === "past_due" && (
        <p className="text-sm text-amber-700">Your last payment failed — surfacing, preferred and featured placement are paused until you update billing.</p>
      )}
      <div className="grid gap-3 md:grid-cols-4">
        {ORDER.map((t) => {
          const isCurrent = t === currentTier
          // ── WHAT YOU HAVE vs WHAT YOU'D BUY (wave 26) ────────────────────
          // Every card used to read the raw CATALOG, so a past_due or cancelled
          // vendor saw their current plan's three capabilities still ticked
          // while the sentence above told them surfacing was paused. The card
          // and the prose disagreed, and the card is the one people believe.
          // The CURRENT plan now renders its EFFECTIVE capabilities (a
          // non-current subscription collapses to basic); the other tiers keep
          // showing the catalog, which is what upgrading would actually buy.
          // PRICE ALWAYS FROM THE CATALOG. effectiveCapabilities collapses a
          // delinquent vendor to the BASIC row, whose monthlyPriceUsd is $49 —
          // rendering that as the current plan's price would tell a lapsed
          // premium vendor they are on a $49 plan. Only the three eligibility
          // flags are status-dependent.
          const catalog = VENDOR_TIERS[t]
          const cap = isCurrent ? effectiveCapabilities(t, status) : catalog
          return (
            <Card key={t} className={isCurrent ? "border-primary" : ""}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base capitalize flex items-center justify-between">
                  {t.replace("_", " ")}
                  {isCurrent && <Badge variant="secondary" className="text-[10px]">Current</Badge>}
                </CardTitle>
                <div className="text-2xl font-bold">${catalog.monthlyPriceUsd}<span className="text-sm font-normal text-muted-foreground">/mo</span></div>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <Cap ok={cap.surfacingEligible} label="AI client surfacing" />
                <Cap ok={cap.preferredEligible} label="Brokerage preferred lists" />
                <Cap ok={cap.featuredEligible} label="Featured placement" />
                <div className="text-muted-foreground">{catalog.serviceAreaZones >= 999 ? "Unlimited" : catalog.serviceAreaZones} service areas · {catalog.packageLimit >= 999 ? "Unlimited" : catalog.packageLimit} packages</div>
                <Button size="sm" className="w-full mt-1" disabled={busy !== null || isCurrent} onClick={() => subscribe(t)}>
                  {isCurrent ? "Current plan" : busy === t ? "Redirecting…" : "Choose"}
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function Cap({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-1.5 ${ok ? "" : "text-muted-foreground line-through"}`}>
      <CheckCircle2 className={`h-3.5 w-3.5 ${ok ? "text-green-600" : "text-muted-foreground/40"}`} /> {label}
    </div>
  )
}
