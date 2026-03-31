// app/components/features/admin/feature-entitlement-list.tsx
// Feature access matrix with trial override controls

"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { CheckCircle2, AlertTriangle, Clock } from "lucide-react"

interface FeatureEntitlementListProps {
  brokerageId: string
}

interface Feature {
  featureKey: string
  featureName: string
  included: boolean
  reason?: string
  trialEndsAt?: string
}

export function FeatureEntitlementList({ brokerageId }: FeatureEntitlementListProps) {
  const [features, setFeatures] = useState<Feature[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatingFeature, setUpdatingFeature] = useState<string | null>(null)

  useEffect(() => {
    fetchFeatures()
  }, [brokerageId])

  const fetchFeatures = async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/admin/billing/dashboard?brokerageId=${brokerageId}`, {
        headers: { "x-user-type": "superadmin" },
      })

      if (!response.ok) throw new Error("Failed to fetch features")

      const data = await response.json()
      setFeatures(data.features || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  const handleApplyTrial = async (featureKey: string) => {
    setUpdatingFeature(featureKey)

    try {
      const trialEndsAt = new Date()
      trialEndsAt.setDate(trialEndsAt.getDate() + 14) // 14-day trial

      const response = await fetch(
        `/api/admin/billing/entitlements/${brokerageId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-user-type": "superadmin",
          },
          body: JSON.stringify({
            featureKey,
            overrideType: "enable_trial",
            trialEndsAt: trialEndsAt.toISOString(),
          }),
        }
      )

      if (!response.ok) throw new Error("Failed to apply trial")

      await fetchFeatures()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setUpdatingFeature(null)
    }
  }

  if (loading) {
    return <div className="p-6 text-center text-gray-500">Loading features...</div>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Feature Entitlements</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {features.map((feature) => {
            const isTrialExpired = feature.trialEndsAt && new Date(feature.trialEndsAt) < new Date()

            return (
              <div
                key={feature.featureKey}
                className="flex items-center justify-between p-3 bg-gray-50 rounded"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{feature.featureName}</p>
                    {feature.included && !isTrialExpired && (
                      <Badge variant="secondary" className="text-xs">
                        {feature.reason || "Active"}
                      </Badge>
                    )}
                    {feature.trialEndsAt && !isTrialExpired && (
                      <Badge variant="outline" className="text-xs flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Trial until {new Date(feature.trialEndsAt).toLocaleDateString()}
                      </Badge>
                    )}
                    {isTrialExpired && (
                      <Badge variant="destructive" className="text-xs">
                        Trial Expired
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1 font-mono">{feature.featureKey}</p>
                </div>

                <div className="flex items-center gap-3">
                  {feature.included ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-gray-300 flex-shrink-0" />
                  )}

                  {!feature.included && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleApplyTrial(feature.featureKey)}
                      disabled={updatingFeature === feature.featureKey}
                    >
                      {updatingFeature === feature.featureKey
                        ? "Applying..."
                        : "Trial (14d)"}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
