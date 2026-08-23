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
import { Check, AlertTriangle, Loader2 } from "lucide-react"
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js"
import { loadStripe } from "@stripe/stripe-js"
import { startSubscriptionCheckout } from "@/app/actions/billing"
import { formatSeatLimit, normalizeCatalogSeatLimit } from "@/lib/kernel/tier-role-matrix"

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

  const currentTierIndex = tiers.findIndex(t => t.id === currentTierId)

  const handleSelectTier = (tierId: string) => {
    const tierIndex = tiers.findIndex(t => t.id === tierId)
    // Only allow upgrades (higher index tiers)
    if (tierIndex > currentTierIndex) {
      setSelectedTierId(tierId)
      setShowCheckout(true)
    }
  }

  const fetchClientSecret = useCallback(async () => {
    if (!selectedTierId) throw new Error("No tier selected")
    const clientSecret = await startSubscriptionCheckout(
      brokerageId,
      selectedTierId,
      isAnnual ? "annual" : "monthly"
    )
    return clientSecret ?? ""
  }, [brokerageId, selectedTierId, isAnnual])

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
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {tiers.map((tier, index) => {
              const isCurrent = tier.id === currentTierId
              const isDowngrade = index < currentTierIndex
              const isUpgrade = index > currentTierIndex
              const features = tier.features as Record<string, any> | null

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
                      <span className="text-3xl font-bold">
                        ${(price / 100).toFixed(0)}
                      </span>
                      <span className="text-muted-foreground">
                        /{isAnnual ? "year" : "mo"}
                      </span>
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

                    <ul className="space-y-2 text-sm">
                      {features?.ai_calls_monthly && (
                        <li className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-green-500" />
                          {features.ai_calls_monthly.toLocaleString()} AI calls/mo
                        </li>
                      )}
                      {features?.storage_gb && (
                        <li className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-green-500" />
                          {features.storage_gb} GB storage
                        </li>
                      )}
                      {features?.video_minutes_monthly && (
                        <li className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-green-500" />
                          {features.video_minutes_monthly} video min/mo
                        </li>
                      )}
                    </ul>

                    {isDowngrade && (
                      <div className="flex items-center gap-1 text-xs text-amber-600 mt-2">
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
        )}
      </DialogContent>
    </Dialog>
  )
}
