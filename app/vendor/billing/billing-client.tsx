"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, CreditCard } from "lucide-react"
import { VENDOR_TIERS, effectiveCapabilities, type VendorTier } from "@/lib/kernel/vendor-subscription"
import { createVendorSubscriptionCheckout, createVendorBillingPortalSession } from "@/app/actions/vendor-billing"

const ORDER: VendorTier[] = ["basic", "standard", "premium", "preferred_network"]

/** Vendor self-serve billing — subscribe to a platform tier (vendor pays the platform) or manage billing.
 *  `prices` are the ADMINISTERED monthly prices (null = not yet published — wave 140J: the catalog
 *  carries no price, so an unpriced tier cannot be chosen and never shows an invented figure). */
export function VendorBillingClient({ currentTier, status, prices }: { currentTier: VendorTier; status: string; prices: Record<VendorTier, number | null> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function subscribe(tier: VendorTier) {
    setBusy(tier)
    setNotice(null)
    try {
      const res = await createVendorSubscriptionCheckout(tier)
      // url null = price_not_configured: no checkout was started; show the vendor the sentence.
      if (res.url === null) setNotice(res.error)
      else window.location.href = res.url
    } finally { setBusy(null) }
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
      {notice && <p className="text-sm text-amber-700">{notice}</p>}
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
          // PRICE ALWAYS FOR THE TIER BEING RENDERED (never the collapsed
          // row): effectiveCapabilities collapses a delinquent vendor to the
          // BASIC row — rendering basic's price as the current plan's would tell
          // a lapsed premium vendor they are on the basic plan. Only the three
          // eligibility flags are status-dependent. The price itself is the
          // administered one (wave 140J); null = not yet published.
          const catalog = VENDOR_TIERS[t]
          const cap = isCurrent ? effectiveCapabilities(t, status) : catalog
          const price = prices[t]
          return (
            <Card key={t} className={isCurrent ? "border-primary" : ""}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base capitalize flex items-center justify-between">
                  {t.replace("_", " ")}
                  {isCurrent && <Badge variant="secondary" className="text-[10px]">Current</Badge>}
                </CardTitle>
                {price === null
                  ? <div className="text-sm font-medium text-muted-foreground">Pricing not yet published</div>
                  : <div className="text-2xl font-bold">${price}<span className="text-sm font-normal text-muted-foreground">/mo</span></div>}
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <Cap ok={cap.surfacingEligible} label="AI client surfacing" />
                <Cap ok={cap.preferredEligible} label="Brokerage preferred lists" />
                <Cap ok={cap.featuredEligible} label="Featured placement" />
                <div className="text-muted-foreground">{catalog.serviceAreaZones >= 999 ? "Unlimited" : catalog.serviceAreaZones} service areas · {catalog.packageLimit >= 999 ? "Unlimited" : catalog.packageLimit} packages</div>
                <Button size="sm" className="w-full mt-1" disabled={busy !== null || isCurrent || price === null} onClick={() => subscribe(t)}>
                  {isCurrent ? "Current plan" : price === null ? "Contact us" : busy === t ? "Redirecting…" : "Choose"}
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
