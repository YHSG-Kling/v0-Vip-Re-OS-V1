// app/dashboard/admin/billing/page.tsx
// Billing & Tiering admin workspace

import { redirect } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { BillingDashboard } from "@/app/components/features/admin/billing-dashboard"
import { SubscriptionTierCard } from "@/app/components/features/admin/subscription-tier-card"
import { OverageCalculator } from "@/app/components/features/admin/overage-calculator"
import { FeatureEntitlementList } from "@/app/components/features/admin/feature-entitlement-list"

/**
 * Billing & Tiering Admin Workspace
 * Accessible only to superadmins
 * 
 * Displays:
 * - Subscription management (tier, status, period)
 * - Feature entitlements & overrides
 * - Usage & overage projections
 * - Cost tracking
 */

export default async function BillingAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ brokerageId?: string }>
}) {
  const supabase = await createServiceClient()

  // Get current user from session
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Check if user is superadmin
  const { data: userProfile, error: userError } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!userProfile || userProfile.user_type !== "superadmin") {
    redirect("/dashboard")
  }

  const params = await searchParams
  const brokerageId = params.brokerageId || user.id

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Billing & Tiering</h1>
          <p className="text-gray-600">
            Manage subscriptions, feature entitlements, and usage for brokerages
          </p>
        </div>

        {/* Brokerage Selector */}
        <div className="mb-6 p-4 bg-gray-50 rounded-lg border">
          <label className="text-sm font-semibold">Current Brokerage ID:</label>
          <input
            type="text"
            value={brokerageId}
            readOnly
            className="mt-2 px-3 py-2 bg-white border rounded w-full font-mono text-sm"
          />
          <p className="mt-2 text-xs text-gray-600">
            Pass ?brokerageId=YOUR_ID to view other brokerages
          </p>
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Subscription & Features */}
          <div className="lg:col-span-2 space-y-6">
            <BillingDashboard brokerageId={brokerageId} />
            <SubscriptionTierCard
              brokerageId={brokerageId}
              tierName="starter"
              status="active"
            />
            <FeatureEntitlementList brokerageId={brokerageId} />
          </div>

          {/* Right Column - Usage & Overage */}
          <div className="space-y-6">
            <OverageCalculator brokerageId={brokerageId} projectionDays={30} />
          </div>
        </div>
      </div>
    </div>
  )
}
