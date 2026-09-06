// app/components/features/admin/billing-dashboard.tsx
// Main billing & tiering workspace for superadmin

"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
// TOMBSTONE (orphan doctrine §1.3): `Button` was imported here and rendered NOWHERE.
// This workspace is READ-ONLY by construction — its whole body is one GET
// (billing-dashboard.tsx:47) rendered into Cards and Badges; it holds no handler and
// mutates nothing, so there is no action for a button to fire. Every billing MUTATION
// a superadmin can make already lives on the SURVIVORS with their own buttons:
// app/actions/superadmin/brokerage-management.ts::changeBrokerageTierAction (tier),
// ::suspendBrokerageAction / ::cancelBrokerageAction (state), surfaced by
// app/dashboard/superadmin/brokerages/[id]/brokerage-actions.tsx:95.
import { AlertCircle, CheckCircle2, AlertTriangle } from "lucide-react"

interface BillingDashboardProps {
  brokerageId: string
}

interface BillingData {
  subscriptions?: Array<{
    brokerageId: string
    tierName: string
    status: "active" | "trial" | "cancelled"
    currentPeriodStart: string
    currentPeriodEnd: string
    cancelledAt?: string
  }>
  features?: Array<{
    featureKey: string
    featureName: string
    included: boolean
    reason?: string
    trialEndsAt?: string
  }>
  costs?: {
    monthlyRecurring: number
    estimatedOverage: number
    totalExposure: number
  }
}

export function BillingDashboard({ brokerageId }: BillingDashboardProps) {
  const [billingData, setBillingData] = useState<BillingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchBillingData = async () => {
      try {
        // ── THE `?brokerageId=` ON THIS READ: RESEARCHED, KEPT, AUTHORIZED SERVER-SIDE ──
        //
        // A query-supplied tenant on a billing read is the IDOR shape, so it was
        // researched before being touched (owner ruling, 2026-08-26). VERDICT: a real
        // capability, not a defect. This workspace is where PLATFORM STAFF inspect any
        // tenant's subscription, and §4 says platform sees all tenants; the page that
        // renders this component resolves the prop server-side and pins a tenant admin
        // to their own brokerage (app/dashboard/admin/billing/page.tsx:73).
        //
        // A browser can of course call the endpoint with any id, so the value is
        // authorized where authority lives, not here: /api/admin/billing/dashboard
        // gates on requireSuperadminAuth (BOTH identity columns), and
        // lib/kernel/billing.ts:loadBillingWorkspace now independently confines a
        // non-platform actor to their own session-resolved brokerage and refuses an
        // actor whose tenant is unknown. Nothing this component sends is trusted.
        //
        // UNRESOLVED, and deliberately not changed by this lane: the page ALSO admits
        // the tenant's own billing admins (the paywall lands them here), and this
        // endpoint is superadmin-only — so for that seat the fetch 403s and the card
        // renders "Error: Failed to load billing data". That is a product decision
        // about what a tenant admin may see, not a tenancy hole, and it is reported
        // rather than silently widened: widening the route would hand a tenant admin a
        // command whose gate is the platform roster.
        const response = await fetch(
          `/api/admin/billing/dashboard?brokerageId=${brokerageId}`,
          { method: "GET" }
        )

        if (!response.ok) {
          throw new Error("Failed to load billing data")
        }

        const data = await response.json()
        setBillingData(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        setLoading(false)
      }
    }

    fetchBillingData()
  }, [brokerageId])

  if (loading) {
    return <div className="p-6 text-center text-gray-500">Loading billing data...</div>
  }

  if (error) {
    return (
      <div className="p-6 bg-red-50 rounded-lg border border-red-200">
        <AlertCircle className="w-5 h-5 text-red-600 mb-2" />
        <p className="text-red-800">Error: {error}</p>
      </div>
    )
  }

  const subscription = billingData?.subscriptions?.[0]
  const costs = billingData?.costs

  return (
    <div className="space-y-6">
      {/* Subscription Status Card */}
      {subscription && (
        <Card className="border-2">
          <CardHeader className="flex flex-row items-center justify-between pb-4">
            <CardTitle>Current Subscription</CardTitle>
            <Badge
              variant={
                subscription.status === "active"
                  ? "default"
                  : subscription.status === "trial"
                    ? "secondary"
                    : "destructive"
              }
            >
              {subscription.status.toUpperCase()}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-600">Tier</p>
                <p className="font-semibold text-lg">{subscription.tierName}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Period</p>
                <p className="font-mono text-sm">
                  {new Date(subscription.currentPeriodStart).toLocaleDateString()} →{" "}
                  {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Costs Card */}
      {costs && (
        <Card>
          <CardHeader>
            <CardTitle>Costs & Usage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center pb-2 border-b">
              <span>Monthly Recurring</span>
              <span className="font-mono font-semibold">${(costs.monthlyRecurring / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center pb-2 border-b">
              <span>Estimated Overage</span>
              <span className="font-mono font-semibold text-orange-600">
                ${(costs.estimatedOverage / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center pt-2 bg-gray-50 px-3 py-2 rounded">
              <span className="font-semibold">Total Exposure</span>
              <span className="font-mono font-bold text-lg">${(costs.totalExposure / 100).toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Features Card */}
      {billingData?.features && billingData.features.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Feature Access</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {billingData.features.map((feature) => (
                <div
                  key={feature.featureKey}
                  className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded"
                >
                  <div>
                    <p className="font-medium">{feature.featureName}</p>
                    {feature.reason && (
                      <p className="text-xs text-gray-600">{feature.reason}</p>
                    )}
                  </div>
                  {feature.included ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-gray-300" />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
