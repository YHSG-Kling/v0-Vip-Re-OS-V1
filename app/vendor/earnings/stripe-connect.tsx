"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { CheckCircle2, AlertTriangle, Loader2, ExternalLink } from "lucide-react"
import { initiateStripeConnectOnboarding } from "@/app/actions/vendor-payments"

interface Props {
  vendorId: string
  stripeAccountId: string | null
  onboardingComplete: boolean
}

export function VendorStripeConnect({ vendorId, stripeAccountId, onboardingComplete }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConnect() {
    setLoading(true)
    setError(null)
    try {
      const result = await initiateStripeConnectOnboarding(vendorId)
      if (result.success && result.url) {
        window.location.href = result.url
      } else {
        setError(result.error ?? "Failed to start Stripe onboarding")
      }
    } catch {
      setError("Unexpected error — please try again")
    } finally {
      setLoading(false)
    }
  }

  if (onboardingComplete) {
    return (
      <Card className="border-green-200 bg-green-50">
        <CardContent className="p-3 flex items-center gap-2 text-sm text-green-800">
          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
          <span>Stripe payouts connected. Available earnings are sent directly to your bank.</span>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardContent className="p-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-medium">Connect Stripe to receive payouts</p>
            <p className="text-xs mt-0.5">
              Set up your bank account via Stripe Express to receive direct transfers when invoices are paid.
              {!stripeAccountId && " Takes about 5 minutes."}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={handleConnect}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          {stripeAccountId ? "Resume Setup" : "Connect Stripe"}
        </Button>
      </CardContent>
      {error && (
        <p className="px-4 pb-3 text-xs text-red-600">{error}</p>
      )}
    </Card>
  )
}
