// app/components/features/admin/subscription-tier-card.tsx
// Subscription tier display card with override controls

"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { AlertCircle } from "lucide-react"

/**
 * STATUS IS THE STORED VOCABULARY, NOT A THIRD SPELLING (§6).
 *
 * This union used to be `"active" | "trial" | "cancelled"`. `subscriptions.status`
 * is CHECK-constrained to active | past_due | cancelled | trialing | paused — so
 * "trial" was a spelling no row can hold, and past_due / paused had nowhere to
 * land at all. `"none"` is added for the real and currently universal case: a
 * brokerage with NO subscription row (live: `subscriptions` holds zero rows).
 */
export type SubscriptionCardStatus =
  | "active" | "trialing" | "past_due" | "cancelled" | "paused" | "none"

interface SubscriptionTierCardProps {
  brokerageId: string
  tierName: string
  status: SubscriptionCardStatus
  onUpdate?: () => void
}

export function SubscriptionTierCard({
  brokerageId,
  tierName,
  status,
  onUpdate,
}: SubscriptionTierCardProps) {
  const [isUpdating, setIsUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleStatusChange = async (newStatus: "active" | "cancelled") => {
    setIsUpdating(true)
    setError(null)

    try {
      const response = await fetch(
        `/api/admin/billing/subscriptions/${brokerageId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            newStatus,
            cancellationReason: newStatus === "cancelled" ? "admin_action" : undefined,
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to update subscription")
      }

      onUpdate?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setIsUpdating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Subscription Tier</CardTitle>
          <Badge
            variant={
              status === "active"
                ? "default"
                : status === "trialing" || status === "none"
                  ? "secondary"
                  : "destructive"
            }
          >
            {status === "none" ? "NO SUBSCRIPTION" : status.replace("_", " ").toUpperCase()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-lg font-semibold">{tierName}</p>
        {status === "none" && (
          <p className="text-sm text-muted-foreground">
            No subscription record exists for this brokerage yet — the plan shown is the
            tenant&apos;s <code>brokerages.plan_tier</code>. Nothing is being billed.
          </p>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        <div className="flex gap-2">
          {status === "active" && (
            <Button
              variant="destructive"
              onClick={() => handleStatusChange("cancelled")}
              disabled={isUpdating}
              size="sm"
            >
              {isUpdating ? "Cancelling..." : "Cancel Subscription"}
            </Button>
          )}
          {status === "cancelled" && (
            <Button
              onClick={() => handleStatusChange("active")}
              disabled={isUpdating}
              size="sm"
            >
              {isUpdating ? "Reactivating..." : "Reactivate"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
