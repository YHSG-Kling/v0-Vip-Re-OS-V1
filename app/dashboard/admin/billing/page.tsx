// app/dashboard/admin/billing/page.tsx
// Billing & Tiering admin workspace

import { redirect } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { createServiceClient } from "@/lib/supabase/service"
import { BillingDashboard } from "@/app/components/features/admin/billing-dashboard"
import {
  SubscriptionTierCard,
  type SubscriptionCardStatus,
} from "@/app/components/features/admin/subscription-tier-card"
import { toPlanTier } from "@/lib/billing/plan-tier"
import { TIER_LABELS } from "@/lib/kernel/tier-role-matrix"
import { OverageCalculator } from "@/app/components/features/admin/overage-calculator"
import { FeatureEntitlementList } from "@/app/components/features/admin/feature-entitlement-list"
import { ManageBillingButton } from "./manage-billing-button"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { SubscriptionAgreementCard } from "./subscription-agreement-card"
import { RevenueSummaryCard } from "./revenue-summary-card"
import { getSubscriptionAgreementAction } from "@/app/actions/admin/subscription-agreement"

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

export const dynamic = "force-dynamic"

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

  // PAYWALL FIX: this page is where a blocked (past-due/expired) tenant is
  // routed at login — it must admit the TENANT'S OWN billing admins, not just
  // superadmin (the old superadmin-only gate bounced blocked tenants straight
  // back to /dashboard, defeating the paywall). Superadmin may inspect any
  // brokerage via ?brokerageId=; a tenant admin is pinned to their own.
  const { data: userProfile } = await supabase
    .from("users")
    .select("user_type, platform_role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const isSuper = userProfile?.user_type === "superadmin" || (userProfile as any)?.platform_role === "superadmin"
  const isTenantBillingAdmin = isBrokerageFinanceAdmin({ user_type: userProfile?.user_type ?? "" })
  if (!userProfile || (!isSuper && !isTenantBillingAdmin)) {
    redirect("/dashboard")
  }

  const params = await searchParams
  const brokerageId = isSuper
    ? (params.brokerageId || (userProfile as any).brokerage_id || user.id)
    : (userProfile as any).brokerage_id

  // LANE 1 (m481): the platform-authored subscription agreement, signed in-app
  // by the tenant's own admins. This page is where a blocked tenant lands at
  // login AND where an activating tenant manages their subscription — the
  // natural seam to surface the contract. Shown only to the tenant's own admins
  // (signing binds THEIR brokerage; a superadmin inspecting another tenant via
  // ?brokerageId= must not be offered someone else's signature line). The
  // agreement is surfaced, not enforced: no blocking gate is added here — see
  // the m481 follow-up note (a hard gate would strand live tenants).
  let agreementView = null
  if (isTenantBillingAdmin && (userProfile as any).brokerage_id) {
    const agreementRes = await getSubscriptionAgreementAction()
    if (agreementRes.ok) agreementView = agreementRes.view
  }

  // ── THE PLAN CARD WAS TELLING EVERY TENANT THE SAME THING, AND IT WAS FALSE ──
  //
  // This card was rendered `tierName="starter" status="active"` — two literals.
  //   · 'starter' is the RETIRED tier vocabulary (scripts/1023-align-plan-tier-
  //     vocabulary.sql mapped starter → solo_agent); brokerages.plan_tier is
  //     CHECK-constrained to solo_agent | team | brokerage | multi_location, so
  //     no tenant has ever been on it.
  //   · 'active' is worse, because THIS PAGE IS THE PAYWALL DESTINATION
  //     (lib/kernel/onboarding.ts routes a blocked tenant here). A past-due or
  //     lapsed tenant was sent to a page that told them their subscription was
  //     ACTIVE — and the card renders its "Cancel Subscription" button on
  //     exactly that value, so it also offered to cancel a subscription that in
  //     the live database does not exist.
  //
  // Both now come from the row. `subscriptions` is read for the real status and
  // `brokerages.plan_tier` names the plan; with no subscription row (the live
  // state for both tenants) the card says so instead of asserting "ACTIVE".
  const [{ data: planRow }, { data: subRow }] = await Promise.all([
    supabase.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle(),
    supabase
      .from("subscriptions")
      .select("status")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  const planTierName = toPlanTier((planRow as { plan_tier?: string | null } | null)?.plan_tier)
  const planDisplayName = TIER_LABELS[planTierName]
  const storedStatus = (subRow as { status?: string | null } | null)?.status ?? null
  const cardStatus: SubscriptionCardStatus =
    storedStatus === "active" || storedStatus === "trialing" || storedStatus === "past_due" ||
    storedStatus === "cancelled" || storedStatus === "paused"
      ? storedStatus
      : "none"

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold mb-2">Billing & Tiering</h1>
            <p className="text-gray-600">
              Manage subscriptions, feature entitlements, and usage for brokerages
            </p>
          </div>
          {/* THE PAYWALL DEAD-ENDED HERE. lib/kernel/onboarding.ts routes a
              blocked tenant to this page, and the only money action on it was
              "Manage billing" — the Stripe billing PORTAL, which
              lib/billing/stripe-portal.ts refuses outright without an existing
              stripe_customer_id ("No billing account yet — subscribe to a plan
              first"). Nothing on this page let anyone subscribe, so a lapsed
              tenant was routed to a page whose single button told them to do
              something the page did not offer. The checkout is not missing —
              it lives on /settings/billing (CurrentPlanCard → UpgradeModal →
              app/actions/billing.ts startSubscriptionCheckout) — so this links
              to it rather than growing a second one (§1). */}
          <div className="flex items-center gap-2">
            {cardStatus !== "active" && (
              <Button asChild size="sm">
                <Link href="/settings/billing">Choose a plan</Link>
              </Button>
            )}
            <ManageBillingButton />
          </div>
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
            {agreementView && <SubscriptionAgreementCard initialView={agreementView} />}
            <BillingDashboard brokerageId={brokerageId} />
            <SubscriptionTierCard
              brokerageId={brokerageId}
              tierName={planDisplayName}
              status={cardStatus}
            />
            <FeatureEntitlementList brokerageId={brokerageId} />
          </div>

          {/* Right Column - Usage & Overage */}
          <div className="space-y-6">
            <OverageCalculator brokerageId={brokerageId} projectionDays={30} />
            {/* PLATFORM-WIDE revenue: superadmin only. A tenant billing admin
                lands on this same page (it is where a blocked tenant is routed
                at login), so the card is not rendered for them at all — and the
                action behind it enforces the same gate server-side. */}
            {isSuper && <RevenueSummaryCard />}
          </div>
        </div>
      </div>
    </div>
  )
}
