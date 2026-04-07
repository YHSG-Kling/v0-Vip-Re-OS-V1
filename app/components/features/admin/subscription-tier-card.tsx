// app/components/features/admin/subscription-tier-card.tsx
// Subscription tier display card with override controls

"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { AlertCircle } from "lucide-react"

interface SubscriptionTierCardProps {
  brokerageId: string
  tierName: string
  status: "active" | "trial" | "cancelled"
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
          headers: {
            "Content-Type": "application/json",
            "x-user-type": "superadmin",
          },
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
                : status === "trial"
                  ? "secondary"
                  : "destructive"
            }
          >
            {status.toUpperCase()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-lg font-semibold">{tierName}</p>

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
