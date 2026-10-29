"use client"

import { useState, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
// TOMBSTONE (orphan doctrine §1.3): `Loader2` was imported here and rendered NOWHERE.
// This modal holds no pending state to spin on — the one async step,
// fetchClientSecret() at upgrade-modal.tsx:56, is handed to Stripe's
// <EmbeddedCheckoutProvider>, and the SURVIVOR of the "checkout is loading"
// affordance is <EmbeddedCheckout /> at upgrade-modal.tsx:105, which renders its own
// loading state while that promise is in flight. A second spinner here would be a
// second answer to one question (§6), and it would have to invent the state to know when
// to stop.
import { Check, AlertTriangle } from "lucide-react"
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js"
import { loadStripe } from "@stripe/stripe-js"
import { startSubscriptionCheckout } from "@/app/actions/billing"
import { formatSeatLimit, normalizeCatalogSeatLimit } from "@/lib/kernel/tier-role-matrix"
import { isCustomPricedTier, customPricingDoorPath } from "@/lib/billing/plan-catalog"
import { allowanceLine, type PlanAllowance } from "@/lib/usage/metric-labels"

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

interface UpgradeModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tiers: any[]
  currentTierId?: string
  brokerageId: string
  isAnnual: boolean
}

export function UpgradeModal({
  open,
  onOpenChange,
  tiers,
  currentTierId,
  brokerageId,
  isAnnual,
}: UpgradeModalProps) {
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null)
  const [showCheckout, setShowCheckout] = useState(false)
  // wave 141H — an optional discount code. Validated on Stripe by the server action
  // (code → Stripe validation → eligibility) BEFORE a checkout exists; a refusal is
  // shown here immediately and the checkout is not opened. Blank → Stripe's own page
  // takes a promotion code (allow_promotion_codes).
  const [discountCodeInput, setDiscountCodeInput] = useState("")
  const [discountCodeError, setDiscountCodeError] = useState<string | null>(null)

  const currentTierIndex = tiers.findIndex(t => t.id === currentTierId)

  const handleSelectTier = (tierId: string) => {
    const tierIndex = tiers.findIndex(t => t.id === tierId)
    // A custom-priced tier (multi-location) is quoted by a person — never a
    // self-serve checkout at the catalogue placeholder (wave 87C; the server
    // action refuses it too).
    if (isCustomPricedTier(tiers[tierIndex]?.tier_name)) {
      window.location.assign(customPricingDoorPath(tiers[tierIndex].tier_name))
      return
    }
    // Only allow upgrades (higher index tiers)
    if (tierIndex > currentTierIndex) {
      setSelectedTierId(tierId)
      setShowCheckout(true)
    }
  }

  const fetchClientSecret = useCallback(async () => {
    if (!selectedTierId) throw new Error("No tier selected")
    try {
      const clientSecret = await startSubscriptionCheckout(
        brokerageId,
        selectedTierId,
        isAnnual ? "annual" : "monthly",
        discountCodeInput.trim() || null,
      )
      setDiscountCodeError(null)
      return clientSecret ?? ""
    } catch (err) {
      // The server's sentence (a refused code, an unpriced plan) — said here, specifically.
      setDiscountCodeError((err as Error)?.message ?? "The checkout could not be started")
      setShowCheckout(false)
      throw err
    }
  }, [brokerageId, selectedTierId, isAnnual, discountCodeInput])

  const handleCloseCheckout = () => {
    setShowCheckout(false)
    setSelectedTierId(null)
  }

  const selectedTier = tiers.find(t => t.id === selectedTierId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {showCheckout ? "Complete Your Upgrade" : "Choose Your Plan"}
          </DialogTitle>
          <DialogDescription>
            {showCheckout
              ? `Upgrading to ${selectedTier?.display_name}`
              : "Select a plan that fits your brokerage needs"}
          </DialogDescription>
        </DialogHeader>

        {showCheckout && selectedTierId ? (
          <div className="space-y-4">
            <div className="p-4 bg-muted rounded-lg">
              <p className="text-sm">
                You will be billed{" "}
                <span className="font-semibold">
                  ${((isAnnual 
                    ? selectedTier?.annual_price_cents 
                    : selectedTier?.monthly_price_cents) / 100).toFixed(2)}
                </span>{" "}
                {isAnnual ? "per year" : "per month"} starting today.
              </p>
            </div>
            
            <EmbeddedCheckoutProvider
              stripe={stripePromise}
              options={{ fetchClientSecret }}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>

            <Button variant="outline" onClick={handleCloseCheckout} className="w-full">
              Back to Plans
            </Button>
          </div>
        ) : (
          <>
          {/* Discount code (wave 141H) — checked on Stripe when the checkout starts; a bad code is refused before any charge. */}
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <label htmlFor="upgrade-discount-code" className="text-sm text-muted-foreground">Have a discount code?</label>
            <input
              id="upgrade-discount-code"
              className="h-9 rounded-md border bg-background px-3 text-sm sm:w-56"
              placeholder="e.g. LAUNCH20"
              value={discountCodeInput}
              onChange={(e) => { setDiscountCodeInput(e.target.value.toUpperCase()); setDiscountCodeError(null) }}
              aria-label="Discount code"
            />
            {discountCodeError && <p className="text-xs text-red-600">{discountCodeError}</p>}
            {!discountCodeError && !discountCodeInput.trim() && (
              <p className="text-xs text-muted-foreground">Leave blank to enter a code on the payment form.</p>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {tiers.map((tier, index) => {
              const isCurrent = tier.id === currentTierId
              const isDowngrade = index < currentTierIndex
              const isUpgrade = index > currentTierIndex

              const price = isAnnual 
                ? tier.annual_price_cents 
                : tier.monthly_price_cents

              return (
                <Card
                  key={tier.id}
                  className={`relative ${
                    isCurrent 
                      ? "border-2 border-blue-500 bg-blue-50/50" 
                      : isDowngrade 
                        ? "opacity-60" 
                        : "cursor-pointer hover:border-blue-300 transition-colors"
                  }`}
                  onClick={() => isUpgrade && handleSelectTier(tier.id)}
                >
                  {isCurrent && (
                    <Badge className="absolute -top-2 left-1/2 -translate-x-1/2 bg-blue-500">
                      Current Plan
                    </Badge>
                  )}
                  <CardHeader className="text-center pb-2">
                    <CardTitle className="text-lg">{tier.display_name}</CardTitle>
                    <div className="mt-2">
                      {isCustomPricedTier(tier.tier_name) ? (
                        <span className="text-xl font-bold">Custom pricing</span>
                      ) : (
                        <>
                          <span className="text-3xl font-bold">
                            ${(price / 100).toFixed(0)}
                          </span>
                          <span className="text-muted-foreground">
                            /{isAnnual ? "year" : "mo"}
                          </span>
                        </>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* NULL and -1 both mean unlimited in the catalogue; the live
                        multi_location row uses NULL, so an `=== -1` test alone
                        printed "Up to null agents" on the top plan. One fold,
                        shared with the seat gate (lib/kernel/tier-role-matrix.ts). */}
                    <p className="text-sm text-center text-muted-foreground">
                      {normalizeCatalogSeatLimit(tier.max_agents) === null
                        ? "Unlimited seats"
                        : `Up to ${formatSeatLimit(tier.max_agents)} seat${normalizeCatalogSeatLimit(tier.max_agents) === 1 ? "" : "s"}`}
                    </p>

                    {/* THE PLAN'S REAL ALLOWANCES (wave 143J) — plan_limits rows folded by
                        getSubscriptionTiers to the MEASURED ones (lib/usage/metric-labels.ts).
                        This list used to read features.ai_calls_monthly / storage_gb /
                        video_minutes_monthly, keys the live tier features object does not
                        carry, so it rendered nothing; and it never names an allowance that
                        nothing measures (storage, email, SMS). */}
                    <ul className="space-y-2 text-sm">
                      {(((tier as { allowances?: PlanAllowance[] }).allowances) ?? []).map((a) => (
                        <li key={a.metric} className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-green-600" />
                          {allowanceLine(a)}
                        </li>
                      ))}
                    </ul>

                    {isDowngrade && (
                      <div className="flex items-center gap-1 text-xs text-amber-700 mt-2">
                        <AlertTriangle className="h-3 w-3" />
                        Downgrade not available here
                      </div>
                    )}

                    {isUpgrade && (
                      <Button
                        className="w-full mt-2"
                        size="sm"
                        onClick={(e) => {
                          // The Card also carries this handler; stop the bubble so
                          // the tier is selected exactly once.
                          e.stopPropagation()
                          handleSelectTier(tier.id)
                        }}
                      >
                        Select
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
